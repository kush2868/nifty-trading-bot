import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger, alert } from '../utils/logger';
import { TradeModel, ITrade, ISpread } from '../db/trade.model';
import { marketDataService } from '../services/marketData.service';
import { kiteService } from '../services/kite.service';
import { orderManager } from '../execution/orderManager';
import {
  isEntryDay,
  daysSince,
  daysUntilExpiry,
  upcomingExpiries,
} from '../utils/dateUtils';
import {
  atmStrike,
  totalQty,
  spreadCapitalRequired,
} from '../utils/instrumentUtils';
import { calcCalendarBreakevens } from '../utils/optionsPricing';
import { spreadTransactionCost } from '../utils/transactionCost';
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

  async evaluateEntry(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const state = await this.getState();
      if (state.activeTrade) {
        logger.debug('Entry skipped — active trade already open');
        return;
      }

      if (!isEntryDay()) {
        logger.debug('Entry skipped — not the designated entry day/time');
        return;
      }

      // Week-1 re-entry gate: if last profit exit was after 7 hold days, skip until next month
      if (await this.wasLastProfitExitAfterWeekOne()) {
        logger.info('Entry skipped — last profit exit was after week 1; waiting for next month');
        return;
      }

      await this.openInitialSpread();
    } finally {
      this.isRunning = false;
    }
  }

  private async openInitialSpread(): Promise<void> {
    const spot = await marketDataService.getNiftySpot();
    const strike = atmStrike(spot);
    logger.info({ spot, strike }, 'Opening initial CALL calendar spread at ATM');

    const hasFunds = await kiteService.hasSufficientMargin(config.strategy.capitalPerSpread);
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
      totalTransactionCosts: 0,
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

  async evaluateAdjustments(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const state = await this.getState();
      if (!state.activeTrade) return;

      const completedThisMonth = await this.completedTradesThisMonth();
      const check = this.checkAdjustmentConditions(state, completedThisMonth);

      if (check.shouldExit) {
        await this.executeExit(state.activeTrade, check.exitReason as ExitReason);
        return;
      }

      if (!check.shouldAddCallSpread && !check.shouldAddPutSpread) return;

      const trade = state.activeTrade;
      const spot = state.currentSpot;

      if (state.spreadCount >= config.strategy.maxSpreads) {
        // Rule 11: at max spreads, BE still breached → close best spread, open at current ATM
        if (check.shouldAddCallSpread) {
          await this.closeAndReplaceSpread(trade, spot, 'CALL', 'CE');
        } else if (check.shouldAddPutSpread) {
          await this.closeAndReplaceSpread(trade, spot, 'PUT', 'PE');
        }
        return;
      }

      if (check.shouldAddCallSpread) {
        await this.addAdjustmentSpread(trade, atmStrike(spot), 'CALL', 'CE');
      } else if (check.shouldAddPutSpread) {
        await this.addAdjustmentSpread(trade, atmStrike(spot), 'PUT', 'PE');
      }
    } finally {
      this.isRunning = false;
    }
  }

  private checkAdjustmentConditions(state: StrategyState, completedThisMonth: number): AdjustmentCheck {
    const { activeTrade, currentSpot, currentPnLPct, holdingDays } = state;
    if (!activeTrade) return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: false };

    const { maxHoldDays, expiryExitDays } = config.risk;

    // 3rd+ trade this month: tighter TP 1.5% / SL 2%
    const isThirdPlusTrade = completedThisMonth >= 2;
    const profitTargetPct = isThirdPlusTrade ? 1.5 : config.risk.profitTargetPct;
    const maxLossPct = isThirdPlusTrade ? 2.0 : config.risk.maxLossPct;

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

    const firstSpread = activeTrade.spreads[0];
    if (firstSpread) {
      const daysLeft = daysUntilExpiry(firstSpread.shortLeg.expiry);
      if (daysLeft <= expiryExitDays) {
        return { shouldAddCallSpread: false, shouldAddPutSpread: false, shouldExit: true, exitReason: 'NEAR_EXPIRY' };
      }
    }

    // ── Adjustment conditions ────────────────────────────────────────────────
    // Use tightest break-even range across all spreads
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

  // Rule 11: close the spread with best PnL, open replacement at current ATM
  private async closeAndReplaceSpread(
    trade: ITrade,
    spot: number,
    spreadType: 'CALL' | 'PUT',
    optionType: 'CE' | 'PE',
  ): Promise<void> {
    const currentDoc = await TradeModel.findOne({ tradeId: trade.tradeId });
    if (!currentDoc) return;

    // Find spread with highest current PnL (min loss / max profit)
    let bestIdx = 0;
    let bestPnL = -Infinity;

    for (let i = 0; i < currentDoc.spreads.length; i++) {
      const s = currentDoc.spreads[i];
      const shortLive = marketDataService.getLivePrice(
        marketDataService.getToken(s.shortLeg.symbol) ?? 0,
      ) ?? s.shortLeg.avgFillPrice;
      const longLive = marketDataService.getLivePrice(
        marketDataService.getToken(s.longLeg.symbol) ?? 0,
      ) ?? s.longLeg.avgFillPrice;
      const pnl =
        (s.shortLeg.avgFillPrice - shortLive) * s.shortLeg.quantity +
        (longLive - s.longLeg.avgFillPrice) * s.longLeg.quantity;
      if (pnl > bestPnL) { bestPnL = pnl; bestIdx = i; }
    }

    const toClose = currentDoc.spreads[bestIdx];
    alert.info('Rule 11 — closing best spread to open at current ATM', {
      tradeId: trade.tradeId,
      closingStrike: toClose.strike,
      estimatedPnL: bestPnL,
    });

    const shortLive = marketDataService.getLivePrice(
      marketDataService.getToken(toClose.shortLeg.symbol) ?? 0,
    ) ?? toClose.shortLeg.avgFillPrice;
    const longLive = marketDataService.getLivePrice(
      marketDataService.getToken(toClose.longLeg.symbol) ?? 0,
    ) ?? toClose.longLeg.avgFillPrice;

    await orderManager.closeLeg(toClose.shortLeg, shortLive);
    await orderManager.closeLeg(toClose.longLeg, longLive);

    const closingCost = spreadTransactionCost(shortLive, longLive, toClose.shortLeg.quantity);

    await TradeModel.updateOne(
      { tradeId: trade.tradeId },
      {
        $pull: { spreads: { spreadIndex: toClose.spreadIndex } },
        $inc: {
          spreadCount: -1,
          realizedPnL: bestPnL,
          totalTransactionCosts: closingCost,
        },
      },
    );

    // Open replacement at current ATM (spreadCount is now one less)
    const refreshed = await TradeModel.findOne({ tradeId: trade.tradeId });
    if (refreshed) {
      await this.addAdjustmentSpread(refreshed, atmStrike(spot), spreadType, optionType);
    }
  }

  // ── Spread Execution ───────────────────────────────────────────────────────

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

    const premiums = await marketDataService.getOptionPremiums([nearContract.symbol, farContract.symbol]);
    const nearPremium = premiums.get(nearContract.symbol) ?? 0;
    const farPremium = premiums.get(farContract.symbol) ?? 0;

    if (nearPremium === 0 || farPremium === 0) {
      logger.error({ nearContract, farContract }, 'Zero premium received — aborting spread');
      return null;
    }

    // BUY far leg first (reduces directional risk during placement)
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
      await orderManager.closeLeg(longLeg, farPremium);
      return null;
    }

    const nearDTE = Math.max(1, daysUntilExpiry(nearExpiry));
    const farDTE = Math.max(nearDTE + 1, daysUntilExpiry(farExpiry));
    const spot = await marketDataService.getNiftySpot();

    const be = calcCalendarBreakevens({
      spot,
      strike,
      shortPremium: shortLeg.avgFillPrice,
      longPremium: longLeg.avgFillPrice,
      nearDTE,
      farDTE,
      optionType,
    });

    const netPremium = shortLeg.avgFillPrice - longLeg.avgFillPrice;
    const capital = spreadCapitalRequired(shortLeg.avgFillPrice, longLeg.avgFillPrice, config.strategy.lotsPerSpread);
    const entryCost = spreadTransactionCost(shortLeg.avgFillPrice, longLeg.avgFillPrice, qty);

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

    await marketDataService.subscribe([nearContract.token, farContract.token]);

    await TradeModel.updateOne(
      { tradeId: trade.tradeId },
      {
        $push: { spreads: spread },
        $inc: { spreadCount: 1, capitalDeployed: capital, totalTransactionCosts: entryCost },
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

    let grossPnL = 0;
    let exitCosts = 0;

    const currentDoc = await TradeModel.findOne({ tradeId: trade.tradeId });
    if (!currentDoc) return;

    for (const spread of currentDoc.spreads) {
      const shortPremiums = await marketDataService.getOptionPremiums([spread.shortLeg.symbol]);
      const shortClose = shortPremiums.get(spread.shortLeg.symbol) ?? spread.shortLeg.avgFillPrice;
      await orderManager.closeLeg(spread.shortLeg, shortClose);

      const longPremiums = await marketDataService.getOptionPremiums([spread.longLeg.symbol]);
      const longClose = longPremiums.get(spread.longLeg.symbol) ?? spread.longLeg.avgFillPrice;
      await orderManager.closeLeg(spread.longLeg, longClose);

      grossPnL +=
        (spread.shortLeg.avgFillPrice - shortClose) * spread.shortLeg.quantity +
        (longClose - spread.longLeg.avgFillPrice) * spread.longLeg.quantity;
      exitCosts += spreadTransactionCost(shortClose, longClose, spread.shortLeg.quantity);
    }

    // Deduct all costs (entry costs already in totalTransactionCosts + exit costs)
    const netRealizedPnL = grossPnL - exitCosts - (currentDoc.totalTransactionCosts ?? 0);

    await TradeModel.updateOne(
      { tradeId: trade.tradeId },
      {
        $set: {
          status: 'CLOSED',
          exitTime: new Date(),
          exitReason: reason,
          realizedPnL: netRealizedPnL,
          currentPnL: netRealizedPnL,
        },
        $inc: { totalTransactionCosts: exitCosts },
      },
    );

    alert.info('Trade closed', { tradeId: trade.tradeId, realizedPnL: netRealizedPnL, reason });
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

        unrealizedPnL +=
          (spread.shortLeg.avgFillPrice - shortLivePrice) * spread.shortLeg.quantity +
          (longLivePrice - spread.longLeg.avgFillPrice) * spread.longLeg.quantity;
      }

      await TradeModel.updateOne({ tradeId: trade.tradeId }, { currentPnL: unrealizedPnL });
    }
  }

  // ── Helper Queries ─────────────────────────────────────────────────────────

  private async wasLastProfitExitAfterWeekOne(): Promise<boolean> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastProfitExit = await TradeModel.findOne(
      { status: 'CLOSED', exitReason: 'PROFIT_TARGET', exitTime: { $gte: monthStart } },
      null,
      { sort: { exitTime: -1 } },
    ).lean() as ITrade | null;
    if (!lastProfitExit) return false;
    const holdDays = Math.round(
      (new Date(lastProfitExit.exitTime!).getTime() - new Date(lastProfitExit.entryTime).getTime()) / 86400000,
    );
    return holdDays > 7;
  }

  private async completedTradesThisMonth(): Promise<number> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return TradeModel.countDocuments({ status: 'CLOSED', exitTime: { $gte: monthStart } });
  }
}

export const calendarSpreadStrategy = new CalendarSpreadStrategy();
