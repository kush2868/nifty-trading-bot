import React from 'react';
import { Trade } from '../api/tradingApi';

interface Props {
  trade: Trade | null;
  niftySpot: number;
}

export function PositionsTable({ trade, niftySpot }: Props) {
  return (
    <div className="card">
      <h2>Active Position</h2>
      {!trade ? (
        <p style={{ color: '#718096', fontSize: '0.85rem' }}>No active position</p>
      ) : (
        <>
          <div className="stat-row" style={{ marginBottom: '0.75rem' }}>
            <div className="stat">
              <span className="label">Trade ID</span>
              <span style={{ fontSize: '0.75rem', color: '#a0aec0', fontFamily: 'monospace' }}>
                {trade.tradeId.slice(0, 8)}…
              </span>
            </div>
            <div className="stat">
              <span className="label">Base Strike</span>
              <span className="value neutral">{trade.baseStrike}</span>
            </div>
            <div className="stat">
              <span className="label">NIFTY @ Entry</span>
              <span className="value neutral">{trade.niftySpotAtEntry}</span>
            </div>
            <div className="stat">
              <span className="label">NIFTY Now</span>
              <span className="value neutral">{niftySpot > 0 ? niftySpot.toFixed(2) : '—'}</span>
            </div>
            <div className="stat">
              <span className="label">Status</span>
              <span className={`badge ${trade.status.toLowerCase()}`}>{trade.status}</span>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Strike</th>
                <th>Short Premium</th>
                <th>Long Premium</th>
                <th>Net</th>
                <th>Upper BE</th>
                <th>Lower BE</th>
              </tr>
            </thead>
            <tbody>
              {trade.spreads.map((s, i) => (
                <tr key={i}>
                  <td>{s.spreadIndex + 1}</td>
                  <td>
                    <span className={`badge ${s.spreadType === 'CALL' ? 'open' : 'adjusting'}`}>
                      {s.spreadType}
                    </span>
                  </td>
                  <td>{s.strike}</td>
                  <td>₹{s.shortLeg.avgFillPrice.toFixed(2)}</td>
                  <td>₹{s.longLeg.avgFillPrice.toFixed(2)}</td>
                  <td style={{ color: s.netPremium >= 0 ? '#48bb78' : '#fc8181' }}>
                    ₹{s.netPremium.toFixed(2)}
                  </td>
                  <td>{s.breakEvenUpper.toFixed(0)}</td>
                  <td>{s.breakEvenLower.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
