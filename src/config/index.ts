import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalEnvNum(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? Number(val) : fallback;
}

export const config = {
  env: optionalEnv('NODE_ENV', 'development'),
  port: optionalEnvNum('PORT', 3000),

  kite: {
    apiKey: requireEnv('KITE_API_KEY'),
    apiSecret: requireEnv('KITE_API_SECRET'),
    redirectUrl: optionalEnv('KITE_REDIRECT_URL', 'http://localhost:3000/kite/callback'),
  },

  mongo: {
    uri: optionalEnv('MONGO_URI', 'mongodb://localhost:27017/nifty_bot'),
  },

  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  },

  strategy: {
    lotSize: optionalEnvNum('LOT_SIZE', 75),
    lotsPerSpread: optionalEnvNum('LOTS_PER_SPREAD', 1),
    maxSpreads: optionalEnvNum('MAX_SPREADS', 3),
    capitalPerSpread: optionalEnvNum('CAPITAL_PER_SPREAD', 40000),
    strikeGap: optionalEnvNum('STRIKE_GAP', 100),       // far-month liquidity exists only at 100-pt strikes
    adjustmentBuffer: optionalEnvNum('ADJUSTMENT_BUFFER', 50),
  },

  risk: {
    profitTargetPct: optionalEnvNum('PROFIT_TARGET_PCT', 2.5),
    maxLossPct: optionalEnvNum('MAX_LOSS_PCT', 4),
    maxHoldDays: optionalEnvNum('MAX_HOLD_DAYS', 30),   // safety backstop; normal exit is via TP/SL/expiry
    expiryExitDays: optionalEnvNum('EXPIRY_EXIT_DAYS', 3),
  },

  trading: {
    mode: optionalEnv('TRADING_MODE', 'paper') as 'paper' | 'live',
  },

  execution: {
    retryAttempts: optionalEnvNum('ORDER_RETRY_ATTEMPTS', 3),
    retryDelayMs: optionalEnvNum('ORDER_RETRY_DELAY_MS', 2000),
    limitOrderOffset: optionalEnvNum('LIMIT_ORDER_OFFSET', 0.5),
  },

  alerts: {
    webhookUrl: optionalEnv('ALERT_WEBHOOK_URL', ''),
  },

  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
  },
} as const;

export type Config = typeof config;
