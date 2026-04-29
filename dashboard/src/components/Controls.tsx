import React, { useState } from 'react';
import { api } from '../api/tradingApi';

interface Props {
  isHalted: boolean;
  onAction: (msg: string) => void;
}

export function Controls({ isHalted, onAction }: Props) {
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, msg: string) {
    if (busy) return;
    if (!confirm(`Confirm: ${msg}?`)) return;
    setBusy(true);
    try {
      await fn();
      onAction(`✓ ${msg}`);
    } catch (err) {
      onAction(`✗ Error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Manual Controls</h2>
      <p style={{ fontSize: '0.75rem', color: '#fc8181', marginBottom: '0.75rem' }}>
        ⚠ These actions affect live positions. Use with extreme caution.
      </p>
      <div className="controls">
        <button
          className="btn-danger"
          disabled={busy}
          onClick={() => run(api.closeAll, 'Close ALL open positions immediately')}
        >
          Close All Positions
        </button>

        {isHalted ? (
          <button
            className="btn-success"
            disabled={busy}
            onClick={() => run(api.resume, 'Resume trading')}
          >
            Resume Trading
          </button>
        ) : (
          <button
            className="btn-warning"
            disabled={busy}
            onClick={() => run(api.halt, 'Halt all trading activity')}
          >
            Halt Trading
          </button>
        )}

        <button
          className="btn-info"
          disabled={busy}
          onClick={async () => {
            const { loginUrl } = await api.getLoginUrl();
            window.open(loginUrl, '_blank');
          }}
        >
          Re-Login to Kite
        </button>
      </div>
    </div>
  );
}
