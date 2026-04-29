import { config } from '../config';
import { logger, alert } from '../utils/logger';
import { TradeModel, ITrade } from '../db/trade.model';
import { redisService } from '../services/redis.service';
import { marketDataService } from '../services/marketData.service';

const TRADING_HALTED_KEY = 'risk:trading:halted';
const DAILY_PNL_KEY = 'risk:daily:pnl';

export interface RiskSnapshot {
  isHalted: boolean;
  currentPnL: number;
  capitalDeployed: number;
  pnlPct: number;
  spreadCount: number;
  availableMargin: number;
}

class RiskManager {
  // ── Trading Halt ───────────────────────────────────────────────────────────

  async haltTrading(reason: string): Promise<void> {
    await redisService.set(TRADING_HALTED_KEY, '1');
    alert.critical(`TRADING HALTED: ${reason}`);
  }

  async resumeTrading(): Promise<void> {
    await redisService.del(TRADING_HALTED_KEY);
    logger.info('Trading resumed');
  }

  async isTradingHalted(): Promise<boolean> {
    return redisService.exists(TRADING_HALTED_KEY);
  }

  // ── Pre-Order Checks ───────────────────────────────────────────────────────

  /**
   * Run all risk checks before placing a new spread.
   * Returns true if safe to proceed.
   */
  async canPlaceNewSpread(): Promise<boolean> {
    if (await this.isTradingHalted()) {
      alert.warn('Cannot place spread — trading is halted');
      return false;
    }

    const activeTrade = await TradeModel.findOne({ status: { $in: ['OPEN', 'ADJUSTING'] } });
    if (!activeTrade) return true;

    if (activeTrade.spreadCount >= config.strategy.maxSpreads) {
      logger.warn({ spreadCount: activeTrade.spreadCount }, 'Max spreads reached');
      return false;
    }

    return true;
  }

  /**
   * Validate that sufficient margin exists before entering any leg.
   */
  async validateMargin(requiredCapital: number): Promise<boolean> {
    const { kiteService } = await import('../services/kite.service');
    const available = await kiteService.getAvailableCash();

    if (available < requiredCapital) {
      alert.warn('Margin check failed', { required: requiredCapital, available });
      return false;
    }
    return true;
  }

  // ── Real-Time PnL Monitoring ───────────────────────────────────────────────

  /**
   * Recompute live PnL for all open trades using WebSocket prices.
   * Returns the aggregate PnL across all open positions.
   */
  async computeLivePnL(): Promise<number> {
    const openTrades = await TradeModel.find({ status: { $in: ['OPEN', 'ADJUSTING'] } }).lean();
    let totalPnL = 0;

    for (const trade of openTrades) {
      let tradePnL = 0;

      for (const spread of trade.spreads) {
        const shortToken = marketDataService.getToken(spread.shortLeg.symbol);
        const longToken = marketDataService.getToken(spread.longLeg.symbol);

        const shortLive = shortToken ? (marketDataService.getLivePrice(shortToken) ?? spread.shortLeg.avgFillPrice) : spread.shortLeg.avgFillPrice;
        const longLive = longToken ? (marketDataService.getLivePrice(longToken) ?? spread.longLeg.avgFillPrice) : spread.longLeg.avgFillPrice;

        const shortPnL = (spread.shortLeg.avgFillPrice - shortLive) * spread.shortLeg.quantity;
        const longPnL = (longLive - spread.longLeg.avgFillPrice) * spread.longLeg.quantity;
        tradePnL += shortPnL + longPnL;
      }

      totalPnL += tradePnL;

      // Update DB
      await TradeModel.updateOne({ tradeId: trade.tradeId }, { currentPnL: tradePnL });

      // Check individual trade stop-loss
      if (trade.capitalDeployed > 0) {
        const pnlPct = (tradePnL / trade.capitalDeployed) * 100;
        if (pnlPct <= -config.risk.maxLossPct) {
          alert.critical('Trade stop-loss triggered', {
            tradeId: trade.tradeId,
            pnlPct: pnlPct.toFixed(2),
          });
          // Delegate exit to strategy module (avoid circular dep via event)
          await this.haltTrading(`Stop-loss hit on trade ${trade.tradeId}`);
        }
      }
    }

    // Track daily PnL in Redis
    await redisService.set(DAILY_PNL_KEY, String(totalPnL));

    return totalPnL;
  }

  /**
   * Get a full risk snapshot for the dashboard.
   */
  async getSnapshot(): Promise<RiskSnapshot> {
    const isHalted = await this.isTradingHalted();
    const activeTrade = await TradeModel.findOne({ status: { $in: ['OPEN', 'ADJUSTING'] } }).lean();

    let currentPnL = 0;
    let capitalDeployed = 0;
    let spreadCount = 0;

    if (activeTrade) {
      currentPnL = activeTrade.currentPnL ?? 0;
      capitalDeployed = activeTrade.capitalDeployed ?? 0;
      spreadCount = activeTrade.spreadCount ?? 0;
    }

    const pnlPct = capitalDeployed > 0 ? (currentPnL / capitalDeployed) * 100 : 0;

    const { kiteService } = await import('../services/kite.service');
    let availableMargin = 0;
    try {
      availableMargin = await kiteService.getAvailableCash();
    } catch {
      availableMargin = -1;
    }

    return { isHalted, currentPnL, capitalDeployed, pnlPct, spreadCount, availableMargin };
  }

  // ── Duplicate Order Guard ──────────────────────────────────────────────────

  async markOrderPlaced(idempotencyKey: string): Promise<boolean> {
    const exists = await redisService.exists(`order:placed:${idempotencyKey}`);
    if (exists) return false;
    await redisService.set(`order:placed:${idempotencyKey}`, '1', 3600);
    return true;
  }
}

export const riskManager = new RiskManager();
