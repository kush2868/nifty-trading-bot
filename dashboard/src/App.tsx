import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { format } from 'date-fns';
import {
  Broker,
  BROKER_URLS,
  BROKER_LABELS,
  createApi,
  RiskSnapshot,
  Trade,
} from './api/tradingApi';
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
interface PnLPoint { time: string; pnl: number }

let logCounter = 0;

// ── Per-broker state ─────────────────────────────────────────────────────────

interface BrokerState {
  snapshot: RiskSnapshot | null;
  activeTrade: Trade | null;
  niftySpot: number;
  connected: boolean;
  pnlHistory: PnLPoint[];
}

const defaultState = (): BrokerState => ({
  snapshot: null,
  activeTrade: null,
  niftySpot: 0,
  connected: false,
  pnlHistory: [],
});

export default function App() {
  const [activeBroker, setActiveBroker] = useState<Broker>('zerodha');

  // Per-broker runtime state
  const [zerodhaState, setZerodhaState] = useState<BrokerState>(defaultState);
  const [angelState, setAngelState] = useState<BrokerState>(defaultState);

  // Combined trade history (both brokers)
  const [allTrades, setAllTrades] = useState<Trade[]>([]);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const zerodhaSocket = useRef<Socket | null>(null);
  const angelSocket = useRef<Socket | null>(null);

  const addLog = useCallback((level: LogEntry['level'], msg: string) => {
    setLogs((prev) => [
      { id: logCounter++, time: format(new Date(), 'HH:mm:ss'), level, msg },
      ...prev.slice(0, 199),
    ]);
  }, []);

  function setState(broker: Broker, patch: Partial<BrokerState>) {
    if (broker === 'zerodha') setZerodhaState((p) => ({ ...p, ...patch }));
    else setAngelState((p) => ({ ...p, ...patch }));
  }

  // ── Initial load for a single broker ──────────────────────────────────────
  async function loadBroker(broker: Broker) {
    const api = createApi(broker);
    const label = BROKER_LABELS[broker];
    try {
      const [snap, active] = await Promise.all([
        api.getRiskSnapshot(),
        api.getActiveTrade(),
      ]);
      setState(broker, { snapshot: snap, activeTrade: active });
      addLog('info', `${label}: dashboard loaded`);
    } catch {
      addLog('warn', `${label}: backend unreachable — is the bot running?`);
    }
  }

  // ── Combined trade history ─────────────────────────────────────────────────
  async function loadAllTrades() {
    const results = await Promise.allSettled([
      createApi('zerodha').getTrades(),
      createApi('angel').getTrades(),
    ]);

    const combined: Trade[] = [];
    if (results[0].status === 'fulfilled') {
      results[0].value.forEach((t) => combined.push({ ...t, broker: 'zerodha' }));
    }
    if (results[1].status === 'fulfilled') {
      results[1].value.forEach((t) => combined.push({ ...t, broker: 'angel' }));
    }
    // Sort newest first
    combined.sort(
      (a, b) => new Date(b.entryTime).getTime() - new Date(a.entryTime).getTime(),
    );
    setAllTrades(combined.slice(0, 100));
  }

  useEffect(() => {
    loadBroker('zerodha');
    loadBroker('angel');
    loadAllTrades();
  }, []);

  // ── WebSocket — connect to both backends simultaneously ────────────────────
  useEffect(() => {
    function setupSocket(broker: Broker) {
      const url = BROKER_URLS[broker];
      const label = BROKER_LABELS[broker];
      const socket = io(url, { transports: ['websocket'] });

      socket.on('connect', () => {
        setState(broker, { connected: true });
        addLog('info', `${label}: live feed connected`);
      });
      socket.on('disconnect', () => {
        setState(broker, { connected: false });
        addLog('warn', `${label}: live feed disconnected`);
      });
      socket.on('update', (data: RiskSnapshot & { niftySpot?: number }) => {
        setState(broker, {
          snapshot: data,
          niftySpot: data.niftySpot ?? 0,
        });
        if (broker === activeBroker) {
          // Only append PnL history for the broker currently in view
        }
        const pnlPoint: PnLPoint = {
          time: format(new Date(), 'HH:mm:ss'),
          pnl: data.currentPnL,
        };
        if (broker === 'zerodha') {
          setZerodhaState((p) => ({
            ...p,
            snapshot: data,
            niftySpot: data.niftySpot ?? p.niftySpot,
            pnlHistory: [...p.pnlHistory.slice(-59), pnlPoint],
          }));
        } else {
          setAngelState((p) => ({
            ...p,
            snapshot: data,
            niftySpot: data.niftySpot ?? p.niftySpot,
            pnlHistory: [...p.pnlHistory.slice(-59), pnlPoint],
          }));
        }
      });

      return socket;
    }

    zerodhaSocket.current = setupSocket('zerodha');
    angelSocket.current = setupSocket('angel');

    return () => {
      zerodhaSocket.current?.disconnect();
      angelSocket.current?.disconnect();
    };
  }, []);

  // Refresh trade history periodically
  useEffect(() => {
    const interval = setInterval(loadAllTrades, 30_000);
    return () => clearInterval(interval);
  }, []);

  // ── Derived values for the active broker ─────────────────────────────────
  const currentState = activeBroker === 'zerodha' ? zerodhaState : angelState;

  return (
    <div className="app">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <h1>NIFTY Calendar Spread Bot</h1>
          {/* Broker tabs */}
          <div className="broker-tabs">
            {(['zerodha', 'angel'] as Broker[]).map((b) => {
              const s = b === 'zerodha' ? zerodhaState : angelState;
              const dotColor = s.connected ? '#48bb78' : '#fc8181';
              return (
                <button
                  key={b}
                  className={`broker-tab ${activeBroker === b ? 'active' : ''} broker-${b}`}
                  onClick={() => setActiveBroker(b)}
                >
                  <span
                    className="broker-dot"
                    style={{ background: dotColor }}
                  />
                  {BROKER_LABELS[b]}
                  {s.snapshot?.isHalted && (
                    <span className="tab-halted">HALTED</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {currentState.snapshot?.isHalted && (
            <span className="badge halted">TRADING HALTED</span>
          )}
          <span className="spot">
            NIFTY: {currentState.niftySpot > 0
              ? currentState.niftySpot.toFixed(2)
              : '—'}
          </span>
          <span className="live-dot" style={{ color: currentState.connected ? '#48bb78' : '#fc8181' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: currentState.connected ? '#48bb78' : '#fc8181',
              display: 'inline-block', marginRight: 4,
            }} />
            {currentState.connected ? 'Live' : 'Offline'}
          </span>
        </div>
      </header>

      <main className="main-grid">
        <PnLCard
          snapshot={currentState.snapshot}
          history={currentState.pnlHistory}
        />
        <Controls
          broker={activeBroker}
          isHalted={currentState.snapshot?.isHalted ?? false}
          onAction={(msg) => addLog(msg.startsWith('✓') ? 'info' : 'error', msg)}
        />
        <PositionsTable
          trade={currentState.activeTrade}
          niftySpot={currentState.niftySpot}
        />

        {/* Activity Log */}
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

        {/* Combined trade history spans full width */}
        <TradeHistory trades={allTrades} />
      </main>
    </div>
  );
}
