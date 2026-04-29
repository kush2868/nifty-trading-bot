import KiteConnect from 'kiteconnect';
import { config } from '../config';
import { logger, alert } from '../utils/logger';
import { redisService } from './redis.service';
import { AccessTokenModel } from '../db/trade.model';
import { withRetry } from '../utils/retry';

const REDIS_TOKEN_KEY = `kite:access_token:${config.kite.apiKey}`;
const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export interface KiteOrderParams {
  exchange: string;
  tradingsymbol: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  product: 'MIS' | 'NRML' | 'CNC';
  order_type: 'LIMIT' | 'MARKET' | 'SL' | 'SL-M';
  price?: number;
  trigger_price?: number;
  validity?: 'DAY' | 'IOC';
  tag?: string;
}

export interface KiteOrder {
  order_id: string;
  exchange_order_id: string;
  status: string;
  tradingsymbol: string;
  transaction_type: string;
  quantity: number;
  filled_quantity: number;
  pending_quantity: number;
  average_price: number;
  price: number;
  order_type: string;
  product: string;
  placed_at: string;
}

export interface KitePosition {
  tradingsymbol: string;
  exchange: string;
  product: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
}

export interface KiteQuote {
  instrument_token: number;
  last_price: number;
  ohlc: { open: number; high: number; low: number; close: number };
  volume: number;
}

export interface KiteInstrument {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  expiry: string;
  strike: number;
  lot_size: number;
}

export interface KiteMargins {
  equity: {
    net: number;
    available: { cash: number; collateral: number };
    utilised: { exposure: number; span: number };
  };
}

class KiteService {
  private kite: KiteConnect;
  private accessToken: string | null = null;

  constructor() {
    this.kite = new KiteConnect({ api_key: config.kite.apiKey });
  }

  // ── Session Management ─────────────────────────────────────────────────────

  getLoginUrl(): string {
    return this.kite.getLoginURL();
  }

  async generateSession(requestToken: string): Promise<string> {
    const session = await this.kite.generateSession(requestToken, config.kite.apiSecret);
    await this.storeToken(session.access_token);
    return session.access_token;
  }

  private async storeToken(token: string): Promise<void> {
    this.accessToken = token;
    this.kite.setAccessToken(token);

    // Cache in Redis
    await redisService.set(REDIS_TOKEN_KEY, token, TOKEN_TTL_SECONDS);

    // Persist in MongoDB for restart recovery
    await AccessTokenModel.findOneAndUpdate(
      { apiKey: config.kite.apiKey },
      { accessToken: token, generatedAt: new Date() },
      { upsert: true, new: true },
    );

    logger.info('Access token stored in Redis and MongoDB');
  }

  async loadStoredToken(): Promise<boolean> {
    // Try Redis first (faster)
    const redisToken = await redisService.get(REDIS_TOKEN_KEY);
    if (redisToken) {
      this.accessToken = redisToken;
      this.kite.setAccessToken(redisToken);
      logger.info('Access token loaded from Redis');
      return true;
    }

    // Fall back to MongoDB
    const record = await AccessTokenModel.findOne({ apiKey: config.kite.apiKey });
    if (record) {
      const ageHours = (Date.now() - record.generatedAt.getTime()) / (1000 * 3600);
      if (ageHours < 8) {
        await this.storeToken(record.accessToken);
        logger.info({ ageHours: ageHours.toFixed(1) }, 'Access token loaded from MongoDB');
        return true;
      }
      logger.warn('Stored token is too old — need re-login');
    }

    return false;
  }

  isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  private assertAuthenticated(): void {
    if (!this.accessToken) throw new Error('Kite not authenticated — generate a session first');
  }

  // ── Market Data ────────────────────────────────────────────────────────────

  async getQuote(symbols: string[]): Promise<Record<string, KiteQuote>> {
    this.assertAuthenticated();
    return withRetry(
      () => this.kite.getQuote(symbols) as Promise<Record<string, KiteQuote>>,
      { attempts: 3, delayMs: 1000 },
    );
  }

  async getInstruments(exchange = 'NFO'): Promise<KiteInstrument[]> {
    this.assertAuthenticated();
    return withRetry(
      () => this.kite.getInstruments([exchange]) as Promise<KiteInstrument[]>,
      { attempts: 3, delayMs: 2000 },
    );
  }

  async getInstrumentToken(tradingsymbol: string, exchange = 'NFO'): Promise<number | null> {
    const instruments = await this.getInstruments(exchange);
    const match = instruments.find(
      (i) => i.tradingsymbol === tradingsymbol && i.exchange === exchange,
    );
    return match ? match.instrument_token : null;
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async placeOrder(params: KiteOrderParams): Promise<string> {
    this.assertAuthenticated();
    logger.info({ params }, 'Placing order');

    const result = await withRetry(
      () =>
        this.kite.placeOrder('regular', {
          exchange: params.exchange,
          tradingsymbol: params.tradingsymbol,
          transaction_type: params.transaction_type,
          quantity: params.quantity,
          product: params.product,
          order_type: params.order_type,
          price: params.price,
          trigger_price: params.trigger_price,
          validity: params.validity ?? 'DAY',
          tag: params.tag,
        }) as Promise<{ order_id: string }>,
      {
        attempts: config.execution.retryAttempts,
        delayMs: config.execution.retryDelayMs,
        onRetry: (err, attempt) =>
          alert.warn(`Order retry ${attempt}/${config.execution.retryAttempts}`, {
            error: err.message,
            symbol: params.tradingsymbol,
          }),
      },
    );

    logger.info({ orderId: result.order_id, symbol: params.tradingsymbol }, 'Order placed');
    return result.order_id;
  }

  async modifyOrder(orderId: string, price: number): Promise<void> {
    this.assertAuthenticated();
    await this.kite.modifyOrder('regular', orderId, { price });
    logger.info({ orderId, price }, 'Order modified');
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.assertAuthenticated();
    await this.kite.cancelOrder('regular', orderId);
    logger.info({ orderId }, 'Order cancelled');
  }

  async getOrder(orderId: string): Promise<KiteOrder | null> {
    this.assertAuthenticated();
    const orders = (await this.kite.getOrders()) as KiteOrder[];
    return orders.find((o) => o.order_id === orderId) ?? null;
  }

  async getOrders(): Promise<KiteOrder[]> {
    this.assertAuthenticated();
    return withRetry(
      () => this.kite.getOrders() as Promise<KiteOrder[]>,
      { attempts: 3, delayMs: 1000 },
    );
  }

  async getPositions(): Promise<{ net: KitePosition[]; day: KitePosition[] }> {
    this.assertAuthenticated();
    return withRetry(
      () => this.kite.getPositions() as Promise<{ net: KitePosition[]; day: KitePosition[] }>,
      { attempts: 3, delayMs: 1000 },
    );
  }

  // ── Margins ────────────────────────────────────────────────────────────────

  async getMargins(): Promise<KiteMargins> {
    this.assertAuthenticated();
    return withRetry(
      () => this.kite.getMargins() as Promise<KiteMargins>,
      { attempts: 3, delayMs: 1000 },
    );
  }

  async getAvailableCash(): Promise<number> {
    const margins = await this.getMargins();
    return margins.equity.available.cash;
  }

  async hasSufficientMargin(required: number): Promise<boolean> {
    const available = await this.getAvailableCash();
    const sufficient = available >= required;
    if (!sufficient) {
      alert.warn('Insufficient margin', { required, available });
    }
    return sufficient;
  }

  // ── Raw Kite instance (for WebSocket ticker) ───────────────────────────────
  getKiteInstance(): KiteConnect {
    return this.kite;
  }
}

export const kiteService = new KiteService();
