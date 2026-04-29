import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger, alert } from '../utils/logger';
import { TradeModel, ITrade, ISpread } from '../db/trade.model';
import { marketDataService } from '../services/marketData.service';
import { kiteService } from '../services/kite.service';
import { orderManager } from '../execution/orderManager';
import { riskManager } from '../risk/riskManager';
import {
  isEntryDay,
  daysSince,
  daysUntilExpiry,
  upcomingExpiries,
} from '../utils/dateUtils';
import {
  atmStrike,
  calcBreakEvens,
  totalQty,
  spreadCapitalRequired,
} from '../utils/instrumentUtils';
import {
  StrategyState,
  AdjustmentCheck,
  ExitReason,
  SpreadEntryParams,
} from './types';

class CalendarSpreadStrategy {
  private isRunning = false;

  // ── Public API ─────────────────────────────────────────────────────────────

  async getState(): Promise<StrategyState> {
    const activeTrade = await TradeModel.findOne({ status: { $in: ['OPEN', 'ADJUSTING'] } })
      .sort({ entryTime: -1 })
      .lean()
      .exec() as ITrade | null;

    if (!activeTrade) {
      return { activeTrade: null, currentSpot: 0, spreadCount: 0, currentPnLPct: 0, holdingDays: 0 };
    }

    const currentSpot = await marketDataService.getNiftySpot();
    const holdingDays = daysSince(activeTrade.entryTime);
    const currentPnLPct =
      activeTrade.capitalDeployed > 0
        ? (activeTrade.currentPnL / activeTrade.capitalDeployed) * 100
        : 0;

    return {
      activeTrade,
      currentSpot,
      spreadCount: activeTrade.spreadCount,
      currentPnLPct,
      holdingDays,
    };
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  /**
   * Evaluate whether entry conditions are met and open the initial calendar spread.
   *
   * Entry rules:
   *   1. No active trade open
   *   2. Today is the first Monday after monthly expiry
   *   3. Current time >= 15:20 IST
   *   4. Sufficient margin available
   */
  async evaluateEntry(): Promise<void> {
    if (this.isRunning) return;

    const state = await this.getState();
    if (state.activeTrade) {
      logger.debug('Entry skipped — active trade already open');
      return;
    }

    if (!isEntryDay()) {
      logger.debug('Entry skipped — not the designated entry day/time');
      return;
    }

    this.isRunning = true;
    try {
      await this.openInitialSpread();
    } finally {
      this.isRunning = false;
    }
  }

  private async openInitialSpread(): Promise<void> {
    const spot = await marketDataService.getNiftySpot();
    const strike = atmStrike(spot);
    logger.info({ spot, strike }, 'Opening initial CALL calendar spread at ATM');

    // Verify margin
    const estimatedCapital = config.strategy.capitalPerSpread;
    const hasFunds = await kiteService.hasSufficientMargin(estimatedCapital);
    if (!hasFunds) {
      alert.critical('Insufficient margin for initial spread — aborting entry');
      return;
    }

    const expiries = upcomingExpiries(2);
    const params: SpreadEntryParams = {
      strike,
      spreadType: 'CALL',
      optionType: 'CE',
      nearExpiry: expiries[0],
      farExpiry: expiries[1],
    };

    const tradeId = uuidv4();
    const trade = await TradeModel.create({
      tradeId,
      entryTime: new Date(),
      baseStrike: strike,
      niftySpotAtEntry: spot,
      spreads: [],
      spreadCount: 0,
      currentPnL: 0,
      realizedPnL: 0,
      capitalDeployed: 0,
      status: 'OPEN',
    });

    const spread = await this.executeSpread(params, trade, 0);
    if (!spread) {
      await TradeModel.deleteOne({ tradeId });
      alert.critical('Failed to execute initial spread — trade aborted');
      return;
    }

    alert.info('Calendar spread position opened', {
      tradeId,
      strike,
      spreadType: 'CALL',
      nearExpiry: params.nearExpiry,
      farExpiry: params.farExpiry,
    });
  }

  // ── Adjustment Logic ───────────────────────────────────────────────────────

  /**
   * Check whether adjustments are needed and act on them.
   *
   * Adjustment rules:
   *   - If spot >= upperBE - buffer → add CALL spread at a higher strike
   *   - If spot <= lowerBE + buffer → add PUT spread at a lower strike
   *   - Max 3 spreads total
   */
  async evaluateAdjustments(): Promise<void> {
    const state = await this.getState();
    if (!state.activeTrade) return;

    const check = this.checkAdjustmentConditions(state);

    if (check.shouldExit) {
      await this.executeExit(state.activeTrade, check.exitReason as ExitReason);
      return;
    }

    if (!check.shouldAddCallSpread && !check.shouldAddPutSpread) return;
    if (state.spreadCount >= config.strategy.maxSpreads) {
      alert.warn('Max spreads reached — no further adjustments', { spreadCount: state.spreadCount });
      return;
    }

    const trade = state.activeTrade;
    const spot = state.currentSpot;

    if (check.shouldAddCallSpread) {
      const newStrike = atmStrike(spot) + config.strategy.strikeGap;
      await this.addAdjustmentSpread(trade, newStrike, 'CALL', 'CE');
    } else if (check.shouldAddPutSpread) {
      const newStrike = atmStrike(spot) - config.strategy.strikeGap;
      await this.addAdjustmentSpread(trade, newStrike, 'PUT', 'PE');
    }
  }

  private checkAdjustmentConditions(state: StrategyState): AdjustmentCheck {
    const { activeTrade, currentSpot, currentPnLPct, holdingDays } = state;
    if (!activeTrade) return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: false };

    const { profitTargetPct, maxLossPct, maxHoldDays, expiryExitDays } = config.risk;

    // ── Exit conditions ──────────────────────────────────────────────────────
    if (currentPnLPct >= profitTargetPct) {
      return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: true, exitReason: 'PROFIT_TARGET' };
    }
    if (currentPnLPct <= -maxLossPct) {
      return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: true, exitReason: 'MAX_LOSS' };
    }
    if (holdingDays >= maxHoldDays) {
      return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: true, exitReason: 'HOLD_DAYS_EXCEEDED' };
    }

    // Check near expiry of the short leg
    const firstSpread = activeTrade.spreads[0];
    if (firstSpread) {
      const daysLeft = daysUntilExpiry(firstSpread.shortLeg.expiry);
      if (daysLeft <= expiryExitDays) {
        return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: true, exitReason: 'NEAR_EXPIRY' };
      }
    }

    // ── Adjustment conditions ────────────────────────────────────────────────
    // Aggregate break-evens: use tightest range across all spreads
    let minUpper = Infinity;
    let maxLower = -Infinity;

    for (const spread of activeTrade.spreads) {
      if (spread.breakEvenUpper < minUpper) minUpper = spread.breakEvenUpper;
      if (spread.breakEvenLower > maxLower) maxLower = spread.breakEvenLower;
    }

    const buf = config.strategy.adjustmentBuffer;
    const shouldAddCallSpread = currentSpot >= minUpper - buf;
    const shouldAddPutSpread = currentSpot <= maxLower + buf;

    return { shouldAddCallSpread, shouldAddPutSpread, shouldExit: false };
  }

  private async addAdjustmentSpread(
    trade: ITrade,
    strike: number,
    spreadType: 'CALL' | 'PUT',
    optionType: 'CE' | 'PE',
  ): Promise<void> {
    const currentDoc = await TradeModel.findOne({ tradeId: trade.tradeId });
    if (!currentDoc) return;

    // Idempotency guard — don't double-add same strike/type
    const alreadyAdded = currentDoc.spreads.some(
      (s) => s.strike === strike && s.spreadType === spreadType,
    );
    if (alreadyAdded) {
      logger.warn({ strike, spreadType }, 'Adjustment spread already added — skipping');
      return;
    }

    const expiries = upcomingExpiries(2);
    const params: SpreadEntryParams = {
      strike,
      spreadType,
      optionType,
      nearExpiry: expiries[0],
      farExpiry: expiries[1],
    };

    const hasFunds = await kiteService.hasSufficientMargin(config.strategy.capitalPerSpread);
    if (!hasFunds) {
      alert.error('Insufficient margin for adjustment spread', { strike, spreadType });
      return;
    }

    await TradeModel.updateOne({ tradeId: trade.tradeId }, { status: 'ADJUSTING' });

    const spread = await this.executeSpread(params, currentDoc, currentDoc.spreadCount);
    if (!spread) {
      await TradeModel.updateOne({ tradeId: trade.tradeId }, { status: 'OPEN' });
      alert.error('Adjustment spread execution failed', { strike, spreadType });
      return;
    }

    alert.info(`Adjustment spread added (${spreadType})`, {
      tradeId: trade.tradeId,
      strike,
      totalSpreads: currentDoc.spreadCount,
    });
  }

  // ── Spread Execution ───────────────────────────────────────────────────────

  /**
   * Execute a single calendar spread: buy far leg first, then sell near leg.
   * Returns the completed ISpread or null on failure.
   */
  private async executeSpread(
    params: SpreadEntryParams,
    trade: ITrade,
    spreadIndex: number,
  ): Promise<ISpread | null> {
    const { strike, spreadType, optionType, nearExpiry, farExpiry } = params;

    const nearContract = await marketDataService.resolveOptionContract(nearExpiry, strike, optionType);
    const farContract = await marketDataService.resolveOptionContract(farExpiry, strike, optionType);

    if (!nearContract || !farContract) {
      logger.error({ strike, optionType }, 'Failed to resolve option contracts');
      return null;
    }

    const qty = totalQty(config.strategy.lotsPerSpread, config.strategy.lotSize);

    // Get current premiums
    const premiums = await marketDataService.getOptionPremiums([nearContract.symbol, farContract.symbol]);
    const nearPremium = premiums.get(nearContract.symbol) ?? 0;
    const farPremium = premiums.get(farContract.symbol) ?? 0;

    if (nearPremium === 0 || farPremium === 0) {
      logger.error({ nearContract, farContract }, 'Zero premium received — aborting spread');
      return null;
    }

    // BUY far leg FIRST (reduces directional risk during placement)
    const longLeg = await orderManager.placeLeg({
      symbol: farContract.symbol,
      exchange: 'NFO',
      transactionType: 'BUY',
      optionType,
      strike,
      expiry: farExpiry,
      quantity: qty,
      premium: farPremium,
    });
    if (!longLeg) return null;

    // SELL near leg
    const shortLeg = await orderManager.placeLeg({
      symbol: nearContract.symbol,
      exchange: 'NFO',
      transactionType: 'SELL',
      optionType,
      strike,
      expiry: nearExpiry,
      quantity: qty,
      premium: nearPremium,
    });
    if (!shortLeg) {
      // Attempt to unwind the long leg
      await orderManager.closeLeg(longLeg, farPremium);
      return null;
    }

    const netPremium = shortLeg.avgFillPrice - longLeg.avgFillPrice;
    const be = calcBreakEvens(strike, shortLeg.avgFillPrice);
    const capital = spreadCapitalRequired(shortLeg.avgFillPrice, longLeg.avgFillPrice, config.strategy.lotsPerSpread);

    const spread: ISpread = {
      spreadIndex,
      spreadType,
      strike,
      shortLeg,
      longLeg,
      netPremium,
      breakEvenUpper: be.upper,
      breakEvenLower: be.lower,
      addedAt: new Date(),
    };

    // Subscribe WebSocket for live PnL
    await marketDataService.subscribe([nearContract.token, farContract.token]);

    await TradeModel.updateOne(
      { tradeId: trade.tradeId },
      {
        $push: { spreads: spread },
        $inc: { spreadCount: 1, capitalDeployed: capital },
        status: 'OPEN',
      },
    );

    return spread;
  }

  // ── Exit ───────────────────────────────────────────────────────────────────

  async executeExit(trade: ITrade, reason: ExitReason): Promise<void> {
    if (trade.status === 'CLOSED' || trade.status === 'CLOSING') return;

    await TradeModel.updateOne({ tradeId: trade.tradeId }, { status: 'CLOSING' });
    alert.info(`Closing trade — reason: ${reason}`, { tradeId: trade.tradeId, reason });

    let realizedPnL = 0;
    const currentDoc = await TradeModel.findOne({ tradeId: trade.tradeId });
    if (!currentDoc) return;

    for (const spread of currentDoc.spreads) {
      // Close short leg (BUY to close)
      const shortPremiums = await marketDataService.getOptionPremiums([spread.shortLeg.symbol]);
      const shortClose = shortPremiums.get(spread.shortLeg.symbol) ?? spread.shortLeg.avgFillPrice;
      await orderManager.closeLeg(spread.shortLeg, shortClose);

      // Close long leg (SELL to close)
      const longPremiums = await marketDataService.getOptionPremiums([spread.longLeg.symbol]);
      const longClose = longPremiums.get(spread.longLeg.symbol) ?? spread.longLeg.avgFillPrice;
      await orderManager.closeLeg(spread.longLeg, longClose);

      // PnL for this spread
      const shortPnL = (spread.shortLeg.avgFillPrice - shortClose) * spread.shortLeg.quantity;
      const longPnL = (longClose - spread.longLeg.avgFillPrice) * spread.longLeg.quantity;
      realizedPnL += shortPnL + longPnL;
    }

    await TradeModel.updateOne(
      { tradeId: trade.tradeId },
      {
        status: 'CLOSED',
        exitTime: new Date(),
        exitReason: reason,
        realizedPnL,
        currentPnL: realizedPnL,
      },
    );

    alert.info('Trade closed', { tradeId: trade.tradeId, realizedPnL, reason });
  }

  // ── Manual Override ────────────────────────────────────────────────────────

  async closeAllPositions(): Promise<void> {
    const openTrades = await TradeModel.find({ status: { $in: ['OPEN', 'ADJUSTING'] } });
    for (const trade of openTrades) {
      await this.executeExit(trade, 'MANUAL');
    }
    logger.info({ count: openTrades.length }, 'All positions closed via manual override');
  }

  // ── PnL Update ─────────────────────────────────────────────────────────────

  async updateLivePnL(): Promise<void> {
    const openTrades = await TradeModel.find({ status: { $in: ['OPEN', 'ADJUSTING'] } }).lean();

    for (const trade of openTrades) {
      let unrealizedPnL = 0;

      for (const spread of trade.spreads) {
        const shortLivePrice = marketDataService.getLivePrice(
          marketDataService.getToken(spread.shortLeg.symbol) ?? 0,
        ) ?? spread.shortLeg.avgFillPrice;

        const longLivePrice = marketDataService.getLivePrice(
          marketDataService.getToken(spread.longLeg.symbol) ?? 0,
        ) ?? spread.longLeg.avgFillPrice;

        const shortPnL = (spread.shortLeg.avgFillPrice - shortLivePrice) * spread.shortLeg.quantity;
        const longPnL = (longLivePrice - spread.longLeg.avgFillPrice) * spread.longLeg.quantity;
        unrealizedPnL += shortPnL + longPnL;
      }

      await TradeModel.updateOne({ tradeId: trade.tradeId }, { currentPnL: unrealizedPnL });
    }
  }
}

export const calendarSpreadStrategy = new CalendarSpreadStrategy();
