import React, { useState } from 'react';
import { Broker, BROKER_LABELS, createApi } from '../api/tradingApi';

interface Props {
  broker: Broker;
  isHalted: boolean;
  onAction: (msg: string) => void;
}

export function Controls({ broker, isHalted, onAction }: Props) {
  const [busy, setBusy] = useState(false);
  const api = createApi(broker);
  const label = BROKER_LABELS[broker];

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

  async function handleReAuth() {
    if (broker === 'zerodha') {
      // Zerodha: open OAuth URL in new tab
      try {
        const { loginUrl } = await api.getKiteLoginUrl();
        window.open(loginUrl, '_blank');
      } catch {
        onAction('✗ Could not fetch Kite login URL');
      }
    } else {
      // Angel One: direct auto-login (no browser redirect needed)
      await run(api.angelLogin, `Re-authenticate with ${label}`);
    }
  }

  return (
    <div className="card">
      <h2>Manual Controls — {label}</h2>
      <p style={{ fontSize: '0.75rem', color: '#fc8181', marginBottom: '0.75rem' }}>
        ⚠ These actions affect live positions. Use with extreme caution.
      </p>
      <div className="controls">
        <button
          className="btn-danger"
          disabled={busy}
          onClick={() => run(api.closeAll, `Close ALL ${label} positions`)}
        >
          Close All Positions
        </button>

        {isHalted ? (
          <button
            className="btn-success"
            disabled={busy}
            onClick={() => run(api.resume, `Resume ${label} trading`)}
          >
            Resume Trading
          </button>
        ) : (
          <button
            className="btn-warning"
            disabled={busy}
            onClick={() => run(api.halt, `Halt ${label} trading`)}
          >
            Halt Trading
          </button>
        )}

        <button
          className="btn-info"
          disabled={busy}
          onClick={handleReAuth}
        >
          {broker === 'zerodha' ? 'Re-Login to Kite' : 'Re-Login (Angel)'}
        </button>
      </div>
    </div>
  );
}
