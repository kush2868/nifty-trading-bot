import KiteTicker from 'kiteconnect';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger, alert } from '../utils/logger';
import { kiteService, KiteInstrument } from './kite.service';
import { redisService } from './redis.service';
import { upcomingExpiries, formatKiteExpiry } from '../utils/dateUtils';
import { buildOptionSymbol, OptionType } from '../utils/instrumentUtils';

const INSTRUMENTS_CACHE_KEY = 'kite:instruments:NFO';
const INSTRUMENTS_TTL = 8 * 60 * 60; // refresh daily
const NIFTY_SPOT_KEY = 'market:nifty:spot';

export interface Tick {
  instrument_token: number;
  tradingsymbol?: string;
  last_price: number;
  volume?: number;
  timestamp?: Date;
}

export interface OptionContract {
  token: number;
  symbol: string;
  expiry: Date;
  strike: number;
  type: OptionType;
  lotSize: number;
}

class MarketDataService extends EventEmitter {
  private ticker: KiteTicker | null = null;
  private subscriptions = new Set<number>();
  private priceCache = new Map<number, number>(); // token → last_price
  private tokenToSymbol = new Map<number, string>();
  private symbolToToken = new Map<string, number>();
  private niftyToken = 256265; // NIFTY 50 NSE instrument token (standard)
  private connected = false;

  // ── Instrument Cache ───────────────────────────────────────────────────────

  async loadInstruments(): Promise<KiteInstrument[]> {
    const cached = await redisService.getJson<KiteInstrument[]>(INSTRUMENTS_CACHE_KEY);
    if (cached && cached.length > 0) {
      logger.info({ count: cached.length }, 'Instruments loaded from Redis cache');
      this.indexInstruments(cached);
      return cached;
    }

    logger.info('Fetching fresh NFO instrument dump from Kite...');
    const instruments = await kiteService.getInstruments('NFO');
    await redisService.setJson(INSTRUMENTS_CACHE_KEY, instruments, INSTRUMENTS_TTL);
    this.indexInstruments(instruments);
    logger.info({ count: instruments.length }, 'NFO instruments cached');
    return instruments;
  }

  private indexInstruments(instruments: KiteInstrument[]): void {
    for (const inst of instruments) {
      this.tokenToSymbol.set(inst.instrument_token, inst.tradingsymbol);
      this.symbolToToken.set(inst.tradingsymbol, inst.instrument_token);
    }
  }

  getToken(symbol: string): number | undefined {
    return this.symbolToToken.get(symbol);
  }

  getSymbol(token: number): string | undefined {
    return this.tokenToSymbol.get(token);
  }

  // ── Option Contract Resolution ─────────────────────────────────────────────

  async resolveOptionContract(
    expiryDate: Date,
    strike: number,
    type: OptionType,
  ): Promise<OptionContract | null> {
    const expiryStr = formatKiteExpiry(expiryDate);
    const symbol = buildOptionSymbol(expiryStr, strike, type);
    const token = this.symbolToToken.get(symbol);

    if (!token) {
      logger.warn({ symbol }, 'Option symbol not found in instrument cache');
      return null;
    }

    return { token, symbol, expiry: expiryDate, strike, type, lotSize: config.strategy.lotSize };
  }

  /**
   * Returns the two upcoming monthly expiry dates and their option contracts
   * for a given strike and option type.
   */
  async getCalendarLegs(
    strike: number,
    type: OptionType,
  ): Promise<{ near: OptionContract; far: OptionContract } | null> {
    const expiries = upcomingExpiries(3);

    for (let i = 0; i < expiries.length - 1; i++) {
      const near = await this.resolveOptionContract(expiries[i], strike, type);
      const far = await this.resolveOptionContract(expiries[i + 1], strike, type);

      if (near && far) return { near, far };
    }

    logger.error({ strike, type }, 'Could not resolve calendar spread legs from instrument cache');
    return null;
  }

  // ── Live Price Feed (WebSocket) ────────────────────────────────────────────

  async startTicker(tokens: number[]): Promise<void> {
    if (this.connected) {
      this.subscribe(tokens);
      return;
    }

    const kite = kiteService.getKiteInstance();
    // KiteTicker accepts the same api_key and access_token
    this.ticker = new (KiteTicker as unknown as { new(opts: object): KiteTicker })({
      api_key: config.kite.apiKey,
      access_token: (kite as unknown as { access_token: string }).access_token,
    });

    this.ticker.connect();

    this.ticker.on('connect', () => {
      this.connected = true;
      logger.info('WebSocket ticker connected');
      this.ticker!.subscribe([this.niftyToken, ...tokens]);
      this.ticker!.setMode(this.ticker!.modeFull, [this.niftyToken, ...tokens]);
    });

    this.ticker.on('ticks', (ticks: Tick[]) => {
      for (const tick of ticks) {
        this.priceCache.set(tick.instrument_token, tick.last_price);
        if (tick.instrument_token === this.niftyToken) {
          redisService.set(NIFTY_SPOT_KEY, String(tick.last_price));
        }
      }
      this.emit('ticks', ticks);
    });

    this.ticker.on('disconnect', (err: Error) => {
      this.connected = false;
      alert.warn('WebSocket disconnected', { error: err?.message });
      // KiteTicker has built-in auto-reconnect
    });

    this.ticker.on('error', (err: Error) => {
      alert.error('WebSocket error', { error: err?.message });
    });

    this.ticker.on('close', () => {
      this.connected = false;
      logger.warn('WebSocket closed');
    });

    tokens.forEach((t) => this.subscriptions.add(t));
  }

  subscribe(tokens: number[]): void {
    if (!this.ticker || !this.connected) return;
    const newTokens = tokens.filter((t) => !this.subscriptions.has(t));
    if (newTokens.length === 0) return;
    this.ticker.subscribe(newTokens);
    this.ticker.setMode(this.ticker.modeFull, newTokens);
    newTokens.forEach((t) => this.subscriptions.add(t));
    logger.info({ newTokens }, 'Subscribed to tokens');
  }

  stopTicker(): void {
    if (this.ticker) {
      this.ticker.disconnect();
      this.connected = false;
      logger.info('WebSocket ticker disconnected');
    }
  }

  // ── Price Accessors ────────────────────────────────────────────────────────

  getLivePrice(token: number): number | null {
    return this.priceCache.get(token) ?? null;
  }

  async getNiftySpot(): Promise<number> {
    // Try in-memory cache first
    const cached = this.priceCache.get(this.niftyToken);
    if (cached) return cached;

    // Try Redis
    const redisVal = await redisService.get(NIFTY_SPOT_KEY);
    if (redisVal) return parseFloat(redisVal);

    // Fall back to REST quote
    const quote = await kiteService.getQuote(['NSE:NIFTY 50']);
    const price = quote['NSE:NIFTY 50']?.last_price;
    if (!price) throw new Error('Unable to fetch NIFTY spot price');
    return price;
  }

  /** Fetch snapshot LTP for multiple symbols via REST (for option premiums at entry). */
  async getOptionPremiums(symbols: string[]): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    const nfoSymbols = symbols.map((s) => `NFO:${s}`);
    const quotes = await kiteService.getQuote(nfoSymbols);

    for (const sym of symbols) {
      const q = quotes[`NFO:${sym}`];
      if (q) priceMap.set(sym, q.last_price);
    }
    return priceMap;
  }
}

export const marketDataService = new MarketDataService();
