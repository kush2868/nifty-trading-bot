import React from 'react';
import { Trade, Broker, BROKER_LABELS } from '../api/tradingApi';
import { format } from 'date-fns';

interface Props {
  trades: Trade[];
}

const BROKER_COLORS: Record<Broker, { bg: string; color: string }> = {
  zerodha: { bg: '#2b6cb0', color: '#bee3f8' },
  angel: { bg: '#285e61', color: '#b2f5ea' },
};

export function TradeHistory({ trades }: Props) {
  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <h2>
        Combined Trade History
        <span style={{ fontWeight: 400, marginLeft: '0.5rem', color: '#718096' }}>
          — both brokers, newest first
        </span>
      </h2>
      {trades.length === 0 ? (
        <p style={{ color: '#718096', fontSize: '0.85rem' }}>No trades recorded yet</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Broker</th>
              <th>Trade ID</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Strike</th>
              <th>Spreads</th>
              <th>PnL</th>
              <th>PnL %</th>
              <th>Capital</th>
              <th>Exit Reason</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const pnl = t.status === 'CLOSED' ? t.realizedPnL : t.currentPnL;
              const pct = t.capitalDeployed > 0 ? (pnl / t.capitalDeployed) * 100 : 0;
              const brokerStyle = t.broker ? BROKER_COLORS[t.broker] : BROKER_COLORS.zerodha;
              return (
                <tr key={`${t.broker ?? 'z'}-${t.tradeId}`}>
                  <td>
                    {t.broker && (
                      <span
                        className="badge"
                        style={{ background: brokerStyle.bg, color: brokerStyle.color }}
                      >
                        {BROKER_LABELS[t.broker]}
                      </span>
                    )}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                    {t.tradeId.slice(0, 8)}…
                  </td>
                  <td>{format(new Date(t.entryTime), 'dd-MMM HH:mm')}</td>
                  <td>{t.exitTime ? format(new Date(t.exitTime), 'dd-MMM HH:mm') : '—'}</td>
                  <td>{t.baseStrike}</td>
                  <td>{t.spreadCount}</td>
                  <td style={{ color: pnl >= 0 ? '#48bb78' : '#fc8181' }}>
                    ₹{pnl.toFixed(0)}
                  </td>
                  <td style={{ color: pct >= 0 ? '#48bb78' : '#fc8181' }}>
                    {pct.toFixed(1)}%
                  </td>
                  <td>₹{t.capitalDeployed.toLocaleString()}</td>
                  <td style={{ fontSize: '0.7rem', color: '#a0aec0' }}>
                    {t.exitReason ?? '—'}
                  </td>
                  <td>
                    <span className={`badge ${t.status.toLowerCase()}`}>{t.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
