import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { format } from 'date-fns';
import { api, RiskSnapshot, Trade } from './api/tradingApi';
import { PnLCard } from './components/PnLCard';
import { PositionsTable } from './components/PositionsTable';
import { Controls } from './components/Controls';
import { TradeHistory } from './components/TradeHistory';

interface LogEntry {
  id: number;
  time: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface PnLPoint { time: string; pnl: number; }

let logCounter = 0;

function useLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const addLog = useCallback((level: LogEntry['level'], msg: string) => {
    setLogs((prev) => [
      { id: logCounter++, time: format(new Date(), 'HH:mm:ss'), level, msg },
      ...prev.slice(0, 199),
    ]);
  }, []);
  return { logs, addLog };
}

export default function App() {
  const [snapshot, setSnapshot] = useState<RiskSnapshot | null>(null);
  const [activeTrade, setActiveTrade] = useState<Trade | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [pnlHistory, setPnlHistory] = useState<PnLPoint[]>([]);
  const [niftySpot, setNiftySpot] = useState(0);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const { logs, addLog } = useLog();

  // ── Initial data load ──────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const [snap, active, allTrades] = await Promise.all([
          api.getRiskSnapshot(),
          api.getActiveTrade(),
          api.getTrades(),
        ]);
        setSnapshot(snap);
        setActiveTrade(active);
        setTrades(allTrades);
        addLog('info', 'Dashboard loaded successfully');
      } catch (err) {
        addLog('error', `Failed to load data: ${String(err)}`);
      }
    }
    load();
  }, []);

  // ── WebSocket connection ───────────────────────────────────────────────────
  useEffect(() => {
    const socket = io('/', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      addLog('info', 'WebSocket connected — receiving live updates');
    });

    socket.on('disconnect', () => {
      setConnected(false);
      addLog('warn', 'WebSocket disconnected');
    });

    socket.on('update', (data: RiskSnapshot) => {
      setSnapshot(data);
      if (data.niftySpot) setNiftySpot(data.niftySpot);

      setPnlHistory((prev) => [
        ...prev.slice(-59),
        { time: format(new Date(), 'HH:mm:ss'), pnl: data.currentPnL },
      ]);
    });

    return () => { socket.disconnect(); };
  }, []);

  // ── Poll active trade ──────────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [active, allTrades] = await Promise.all([api.getActiveTrade(), api.getTrades()]);
        setActiveTrade(active);
        setTrades(allTrades);
      } catch { /* silent */ }
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  const statusColor = connected ? '#48bb78' : '#fc8181';

  return (
    <div className="app">
      <header className="header">
        <h1>NIFTY Calendar Spread Bot</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {snapshot?.isHalted && (
            <span className="badge halted">TRADING HALTED</span>
          )}
          <span className="spot">
            NIFTY: {niftySpot > 0 ? niftySpot.toFixed(2) : '—'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: statusColor }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>
      </header>

      <main className="main-grid">
        <PnLCard snapshot={snapshot} history={pnlHistory} />
        <Controls
          isHalted={snapshot?.isHalted ?? false}
          onAction={(msg) => addLog(msg.startsWith('✓') ? 'info' : 'error', msg)}
        />
        <PositionsTable trade={activeTrade} niftySpot={niftySpot} />

        {/* Log viewer */}
        <div className="card">
          <h2>Activity Log</h2>
          <div className="log-box">
            {logs.length === 0 ? (
              <div className="log-entry info">
                <span className="ts">—</span>
                <span className="msg">Waiting for activity...</span>
              </div>
            ) : (
              logs.map((l) => (
                <div key={l.id} className={`log-entry ${l.level}`}>
                  <span className="ts">{l.time}</span>
                  <span className="msg">{l.msg}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <TradeHistory trades={trades} />
      </main>
    </div>
  );
}
