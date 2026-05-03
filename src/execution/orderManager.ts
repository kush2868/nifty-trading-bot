import { config } from '../config';
import { logger, alert } from '../utils/logger';
import { kiteService } from '../services/kite.service';
import { withRetry, sleep } from '../utils/retry';
import { ILeg, LegStatus } from '../db/trade.model';
import { OptionType } from '../utils/instrumentUtils';

const FILL_POLL_INTERVAL_MS = 500;
const FILL_TIMEOUT_MS = 30_000; // 30 seconds to wait for fill

export interface LegPlacementParams {
  symbol: string;
  exchange: string;
  transactionType: 'BUY' | 'SELL';
  optionType: OptionType;
  strike: number;
  expiry: Date;
  quantity: number;
  premium: number; // LTP used to compute limit price
}

class OrderManager {
  // Track placed order IDs to prevent duplicate submissions
  private placedOrderIds = new Set<string>();

  // ── Leg Placement ──────────────────────────────────────────────────────────

  /**
   * Place a single leg (LIMIT order) and wait for fill confirmation.
   * Always uses LIMIT order with a slight offset from LTP.
   * Returns the populated ILeg or null if all retries failed.
   */
  async placeLeg(params: LegPlacementParams): Promise<ILeg | null> {
    if (config.trading.mode === 'paper') return this.simulateLeg(params);

    const { symbol, exchange, transactionType, expiry, quantity, premium } = params;

    const limitPrice = this.computeLimitPrice(transactionType, premium);
    logger.info({ symbol, transactionType, quantity, limitPrice }, 'Placing leg order');

    let orderId: string | null = null;

    try {
      orderId = await withRetry(
        () =>
          kiteService.placeOrder({
            exchange,
            tradingsymbol: symbol,
            transaction_type: transactionType,
            quantity,
            product: 'NRML',
            order_type: 'LIMIT',
            price: limitPrice,
            validity: 'DAY',
            tag: `NIFTY_BOT_${Date.now()}`,
          }),
        {
          attempts: config.execution.retryAttempts,
          delayMs: config.execution.retryDelayMs,
          onRetry: (err, attempt) =>
            alert.warn(`Leg order retry ${attempt}`, { symbol, error: err.message }),
        },
      );
    } catch (err) {
      alert.error('All retries exhausted for leg placement', { symbol, transactionType, error: String(err) });
      return null;
    }

    this.placedOrderIds.add(orderId);

    // Wait for the order to fill (polling with timeout)
    const filled = await this.waitForFill(orderId, symbol, limitPrice, expiry);
    return filled;
  }

  /**
   * Close an existing leg by placing the opposite order.
   */
  async closeLeg(leg: ILeg, currentPremium: number): Promise<ILeg | null> {
    if (config.trading.mode === 'paper') {
      const closeType: 'BUY' | 'SELL' = leg.transactionType === 'SELL' ? 'BUY' : 'SELL';
      return this.simulateLeg({
        symbol: leg.symbol,
        exchange: leg.exchange,
        transactionType: closeType,
        optionType: leg.optionType,
        strike: leg.strike,
        expiry: leg.expiry,
        quantity: leg.quantity,
        premium: currentPremium,
      });
    }

    const closeTransactionType: 'BUY' | 'SELL' = leg.transactionType === 'SELL' ? 'BUY' : 'SELL';
    const limitPrice = this.computeLimitPrice(closeTransactionType, currentPremium);

    logger.info({ symbol: leg.symbol, closeTransactionType, limitPrice }, 'Closing leg');

    let orderId: string | null = null;
    try {
      orderId = await withRetry(
        () =>
          kiteService.placeOrder({
            exchange: leg.exchange,
            tradingsymbol: leg.symbol,
            transaction_type: closeTransactionType,
            quantity: leg.quantity,
            product: 'NRML',
            order_type: 'LIMIT',
            price: limitPrice,
            validity: 'DAY',
            tag: `NIFTY_BOT_CLOSE_${Date.now()}`,
          }),
        { attempts: config.execution.retryAttempts, delayMs: config.execution.retryDelayMs },
      );
    } catch (err) {
      alert.error('Failed to close leg — manual intervention required', {
        symbol: leg.symbol,
        error: String(err),
      });
      return null;
    }

    return this.waitForFill(orderId, leg.symbol, limitPrice, leg.expiry);
  }

  // ── Order Fill Monitoring ──────────────────────────────────────────────────

  /**
   * Poll the order status until COMPLETE or timeout.
   * On partial fill or rejection, escalates based on severity.
   */
  private async waitForFill(
    orderId: string,
    symbol: string,
    limitPrice: number,
    expiry: Date,
  ): Promise<ILeg | null> {
    const deadline = Date.now() + FILL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(FILL_POLL_INTERVAL_MS);

      let order;
      try {
        order = await kiteService.getOrder(orderId);
      } catch (err) {
        logger.warn({ orderId, error: String(err) }, 'Error fetching order status');
        continue;
      }

      if (!order) continue;

      logger.debug({ orderId, status: order.status, filled: order.filled_quantity }, 'Order status');

      if (order.status === 'COMPLETE') {
        logger.info({ orderId, avgPrice: order.average_price }, 'Order filled completely');
        return this.buildLeg(order, symbol, limitPrice, expiry);
      }

      if (order.status === 'REJECTED') {
        alert.error('Order rejected by exchange', { orderId, symbol });
        return null;
      }

      if (order.status === 'CANCELLED') {
        alert.warn('Order cancelled', { orderId, symbol });
        return null;
      }

      // Partial fill — log but continue waiting
      if (order.filled_quantity > 0 && order.pending_quantity > 0) {
        logger.info(
          { orderId, filled: order.filled_quantity, pending: order.pending_quantity },
          'Partial fill — waiting',
        );
      }
    }

    // Timeout — cancel the pending order to avoid dangling exposure
    alert.error('Order fill timeout — cancelling order', { orderId, symbol });
    try {
      await kiteService.cancelOrder(orderId);
    } catch {
      alert.critical('Could not cancel timed-out order — MANUAL ACTION REQUIRED', { orderId, symbol });
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Compute limit price with an offset to improve fill probability.
   * BUY: pay slightly more than LTP (aggressive)
   * SELL: accept slightly less than LTP (aggressive)
   */
  private computeLimitPrice(transactionType: 'BUY' | 'SELL', ltp: number): number {
    const offset = config.execution.limitOrderOffset;
    const raw = transactionType === 'BUY' ? ltp + offset : ltp - offset;
    // Round to nearest 0.05 (Kite tick size for options)
    return Math.round(raw / 0.05) * 0.05;
  }

  private buildLeg(order: {
    order_id: string;
    tradingsymbol: string;
    exchange?: string;
    transaction_type: string;
    quantity: number;
    average_price: number;
    placed_at: string;
  }, symbol: string, limitPrice: number, expiry: Date): ILeg {
    return {
      kiteOrderId: order.order_id,
      symbol,
      exchange: (order.exchange as string) ?? 'NFO',
      transactionType: order.transaction_type as 'BUY' | 'SELL',
      optionType: symbol.endsWith('CE') ? 'CE' : 'PE',
      strike: this.extractStrike(symbol),
      expiry,
      quantity: order.quantity,
      limitPrice,
      avgFillPrice: order.average_price,
      status: 'FILLED' as LegStatus,
      placedAt: new Date(order.placed_at),
      filledAt: new Date(),
    };
  }

  private simulateLeg(params: LegPlacementParams): ILeg {
    const limitPrice = this.computeLimitPrice(params.transactionType, params.premium);
    logger.info(
      { symbol: params.symbol, transactionType: params.transactionType, quantity: params.quantity, limitPrice },
      'Paper mode — simulated fill',
    );
    return {
      kiteOrderId: `PAPER_${Date.now()}`,
      symbol: params.symbol,
      exchange: params.exchange,
      transactionType: params.transactionType,
      optionType: params.optionType,
      strike: params.strike,
      expiry: params.expiry,
      quantity: params.quantity,
      limitPrice,
      avgFillPrice: limitPrice,
      status: 'FILLED' as LegStatus,
      placedAt: new Date(),
      filledAt: new Date(),
    };
  }

  private extractStrike(symbol: string): number {
    const match = symbol.match(/(\d+)(CE|PE)$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  hasDuplicate(orderId: string): boolean {
    return this.placedOrderIds.has(orderId);
  }
}

export const orderManager = new OrderManager();
