import React from 'react';
import { LineChart, Line, Tooltip, ResponsiveContainer, YAxis, XAxis } from 'recharts';
import { RiskSnapshot } from '../api/tradingApi';

interface Props {
  snapshot: RiskSnapshot | null;
  history: { time: string; pnl: number }[];
}

export function PnLCard({ snapshot, history }: Props) {
  if (!snapshot) return <div className="card"><h2>PnL</h2><p style={{ color: '#718096' }}>Loading...</p></div>;

  const pnlColor = snapshot.currentPnL >= 0 ? 'green' : 'red';
  const pnlPctColor = snapshot.pnlPct >= 0 ? 'green' : 'red';

  return (
    <div className="card">
      <h2>Live PnL</h2>
      <div className="stat-row">
        <div className="stat">
          <span className="label">Unrealized PnL</span>
          <span className={`value ${pnlColor}`}>
            ₹{snapshot.currentPnL.toFixed(2)}
          </span>
        </div>
        <div className="stat">
          <span className="label">PnL %</span>
          <span className={`value ${pnlPctColor}`}>
            {snapshot.pnlPct.toFixed(2)}%
          </span>
        </div>
        <div className="stat">
          <span className="label">Capital Deployed</span>
          <span className="value neutral">₹{snapshot.capitalDeployed.toLocaleString()}</span>
        </div>
        <div className="stat">
          <span className="label">Margin Available</span>
          <span className="value neutral">
            {snapshot.availableMargin >= 0 ? `₹${snapshot.availableMargin.toLocaleString()}` : 'N/A'}
          </span>
        </div>
      </div>

      {history.length > 1 && (
        <div className="chart-wrap" style={{ marginTop: '0.75rem' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history}>
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#718096' }} />
              <YAxis tick={{ fontSize: 10, fill: '#718096' }} width={60} />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3748', fontSize: 12 }}
                formatter={(v: number) => [`₹${v.toFixed(2)}`, 'PnL']}
              />
              <Line
                type="monotone"
                dataKey="pnl"
                stroke={snapshot.currentPnL >= 0 ? '#48bb78' : '#fc8181'}
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
