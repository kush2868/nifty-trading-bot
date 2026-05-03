/**
 * Main entry point for the NIFTY Calendar Spread Trading Bot.
 *
 * Startup sequence:
 *   1. Connect MongoDB + Redis
 *   2. Load/validate Kite access token
 *   3. Load NFO instrument dump (cached in Redis)
 *   4. Start market data WebSocket
 *   5. Start Express API + Socket.IO server
 *   6. Begin strategy loop (entry eval + adjustments + PnL updates)
 *   7. Graceful shutdown on SIGINT/SIGTERM
 */

import 'express-async-errors';
import { config } from './config';
import { logger, alert } from './utils/logger';
import { connectMongo, disconnectMongo } from './db/connection';
import { redisService } from './services/redis.service';
import { kiteService } from './services/kite.service';
import { marketDataService } from './services/marketData.service';
import { calendarSpreadStrategy } from './strategies/calendarSpread.strategy';
import { riskManager } from './risk/riskManager';
import { buildServer } from './api/server';
import { isMarketOpen } from './utils/dateUtils';

// ── Intervals ─────────────────────────────────────────────────────────────────

const ENTRY_CHECK_INTERVAL_MS = 60_000;      // Check for entry every 1 minute
const ADJUSTMENT_CHECK_INTERVAL_MS = 30_000; // Check adjustments every 30 seconds
const PNL_UPDATE_INTERVAL_MS = 10_000;       // Update PnL every 10 seconds

let running = false;
const timers: NodeJS.Timeout[] = [];

// ── Boot ───────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  logger.info('Starting NIFTY Trading Bot...');

  // 1. DB connections
  await connectMongo();
  await redisService.connect();
  logger.info('Database connections established');

  // 2. Kite authentication
  const tokenLoaded = await kiteService.loadStoredToken();
  if (!tokenLoaded) {
    const loginUrl = kiteService.getLoginUrl();
    alert.warn('No valid Kite access token found. Manual login required.', { loginUrl });
    logger.info('Navigate to the login URL and complete OAuth, then restart the bot.');
    logger.info(`Login URL: ${loginUrl}`);
    logger.info(`After login, the callback will be received at: ${config.kite.redirectUrl}`);
    // Server still starts so the callback endpoint is available
  }

  // 3. Load instruments
  if (kiteService.isAuthenticated()) {
    try {
      await marketDataService.loadInstruments();
    } catch (err) {
      alert.error('Failed to load instruments', { error: String(err) });
    }
  }

  // 4. Start API server (always — for auth callback and dashboard)
  const { httpServer } = buildServer();
  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, 'API server listening');
    if (!tokenLoaded) {
      logger.info(`GET http://localhost:${config.port}/kite/login  →  Kite login URL`);
    }
  });

  // 5. Start trading loops only if authenticated
  if (kiteService.isAuthenticated()) {
    await startTradingLoops();
  } else {
    logger.warn('Trading loops not started — waiting for authentication');
  }

  running = true;
}

// ── Trading Loops ──────────────────────────────────────────────────────────────

async function startTradingLoops(): Promise<void> {
  // Start WebSocket ticker (subscribes NIFTY spot automatically)
  await marketDataService.startTicker([]);

  // PnL updates (highest frequency)
  timers.push(
    setInterval(async () => {
      try {
        if (!isMarketOpen()) return;
        const halted = await riskManager.isTradingHalted();
        if (halted) return;
        await calendarSpreadStrategy.updateLivePnL();
        await riskManager.computeLivePnL();
      } catch (err) {
        logger.error({ err }, 'PnL update error');
      }
    }, PNL_UPDATE_INTERVAL_MS),
  );

  // Adjustment checks
  timers.push(
    setInterval(async () => {
      try {
        if (!isMarketOpen()) return;
        const halted = await riskManager.isTradingHalted();
        if (halted) {
          logger.debug('Trading halted — skipping adjustment check');
          return;
        }
        await calendarSpreadStrategy.evaluateAdjustments();
      } catch (err) {
        logger.error({ err }, 'Adjustment check error');
      }
    }, ADJUSTMENT_CHECK_INTERVAL_MS),
  );

  // Entry evaluation (least frequent)
  timers.push(
    setInterval(async () => {
      try {
        if (!isMarketOpen()) return;
        const halted = await riskManager.isTradingHalted();
        if (halted) return;
        await calendarSpreadStrategy.evaluateEntry();
      } catch (err) {
        logger.error({ err }, 'Entry evaluation error');
      }
    }, ENTRY_CHECK_INTERVAL_MS),
  );

  logger.info('Trading loops started');
}

// ── Graceful Shutdown ──────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;

  logger.info({ signal }, 'Shutdown signal received — stopping bot gracefully');

  // Stop all timers
  timers.forEach(clearInterval);

  // Stop WebSocket ticker
  marketDataService.stopTicker();

  // DB cleanup
  await disconnectMongo();
  await redisService.disconnect();

  logger.info('Bot stopped cleanly');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  alert.critical('Uncaught exception — bot stopping', { error: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  alert.critical('Unhandled promise rejection', { reason: String(reason) });
  void shutdown('unhandledRejection');
});

// ── Start ──────────────────────────────────────────────────────────────────────

boot().catch((err) => {
  logger.fatal({ err }, 'Fatal boot error');
  process.exit(1);
});
