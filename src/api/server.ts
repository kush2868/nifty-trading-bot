import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import 'express-async-errors';

import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeModel } from '../db/trade.model';
import { kiteService } from '../services/kite.service';
import { riskManager } from '../risk/riskManager';
import { calendarSpreadStrategy } from '../strategies/calendarSpread.strategy';
import { marketDataService } from '../services/marketData.service';

export function buildServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  app.use(cors());
  app.use(express.json());

  // ── Kite OAuth Flow ────────────────────────────────────────────────────────

  app.get('/kite/login', (_req, res) => {
    const url = kiteService.getLoginUrl();
    res.json({ loginUrl: url });
  });

  app.get('/kite/callback', async (req: Request, res: Response) => {
    const requestToken = req.query['request_token'] as string;
    if (!requestToken) {
      res.status(400).json({ error: 'Missing request_token' });
      return;
    }
    const token = await kiteService.generateSession(requestToken);
    res.json({ message: 'Session created successfully', accessToken: token.slice(0, 6) + '...' });
  });

  app.get('/auth/status', async (_req, res) => {
    res.json({ authenticated: kiteService.isAuthenticated() });
  });

  // ── Trade Endpoints ────────────────────────────────────────────────────────

  app.get('/trades', async (_req, res) => {
    const trades = await TradeModel.find().sort({ entryTime: -1 }).limit(50).lean();
    res.json(trades);
  });

  app.get('/trades/active', async (_req, res) => {
    const trade = await TradeModel.findOne({ status: { $in: ['OPEN', 'ADJUSTING'] } })
      .sort({ entryTime: -1 })
      .lean();
    res.json(trade ?? null);
  });

  app.get('/trades/:tradeId', async (req, res) => {
    const trade = await TradeModel.findOne({ tradeId: req.params.tradeId }).lean();
    if (!trade) { res.status(404).json({ error: 'Trade not found' }); return; }
    res.json(trade);
  });

  // ── Risk / Position Snapshot ───────────────────────────────────────────────

  app.get('/risk/snapshot', async (_req, res) => {
    const snapshot = await riskManager.getSnapshot();
    res.json(snapshot);
  });

  app.get('/market/spot', async (_req, res) => {
    const spot = await marketDataService.getNiftySpot();
    res.json({ nifty: spot });
  });

  // ── Manual Controls ────────────────────────────────────────────────────────

  app.post('/control/close-all', async (_req, res) => {
    await calendarSpreadStrategy.closeAllPositions();
    res.json({ message: 'Close all positions initiated' });
  });

  app.post('/control/halt', async (_req, res) => {
    await riskManager.haltTrading('Manual halt via dashboard');
    res.json({ message: 'Trading halted' });
  });

  app.post('/control/resume', async (_req, res) => {
    await riskManager.resumeTrading();
    res.json({ message: 'Trading resumed' });
  });

  // ── Error Handler ──────────────────────────────────────────────────────────

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'API error');
    res.status(500).json({ error: err.message });
  });

  // ── WebSocket: push live PnL every 5 seconds ──────────────────────────────

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Dashboard connected via WebSocket');

    const interval = setInterval(async () => {
      try {
        const snapshot = await riskManager.getSnapshot();
        const spot = await marketDataService.getNiftySpot().catch(() => 0);
        socket.emit('update', { ...snapshot, niftySpot: spot, timestamp: new Date() });
      } catch {
        // non-fatal
      }
    }, 5000);

    socket.on('disconnect', () => {
      clearInterval(interval);
      logger.info({ socketId: socket.id }, 'Dashboard disconnected');
    });
  });

  return { app, httpServer, io };
}
