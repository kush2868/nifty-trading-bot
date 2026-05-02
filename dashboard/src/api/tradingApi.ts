import axios from 'axios';

export type Broker = 'zerodha' | 'angel';

export const BROKER_URLS: Record<Broker, string> = {
  zerodha: 'http://localhost:3000',
  angel: 'http://localhost:3001',
};

export const BROKER_LABELS: Record<Broker, string> = {
  zerodha: 'Zerodha',
  angel: 'Angel One',
};

export interface RiskSnapshot {
  isHalted: boolean;
  currentPnL: number;
  capitalDeployed: number;
  pnlPct: number;
  spreadCount: number;
  availableMargin: number;
  niftySpot?: number;
  timestamp?: string;
}

export interface Trade {
  tradeId: string;
  entryTime: string;
  baseStrike: number;
  niftySpotAtEntry: number;
  spreadCount: number;
  currentPnL: number;
  realizedPnL: number;
  capitalDeployed: number;
  status: string;
  exitTime?: string;
  exitReason?: string;
  spreads: Spread[];
  broker?: Broker; // injected client-side when combining histories
}

export interface Spread {
  spreadIndex: number;
  spreadType: string;
  strike: number;
  netPremium: number;
  breakEvenUpper: number;
  breakEvenLower: number;
  addedAt: string;
  shortLeg: Leg;
  longLeg: Leg;
}

export interface Leg {
  symbol: string;
  transactionType: string;
  quantity: number;
  avgFillPrice: number;
  status: string;
}

/** Factory: returns an API client scoped to one broker's backend. */
export function createApi(broker: Broker) {
  const base = BROKER_URLS[broker];
  return {
    getActiveTrade: () =>
      axios.get<Trade | null>(`${base}/trades/active`).then((r) => r.data),
    getTrades: () =>
      axios.get<Trade[]>(`${base}/trades`).then((r) => r.data),
    getRiskSnapshot: () =>
      axios.get<RiskSnapshot>(`${base}/risk/snapshot`).then((r) => r.data),
    getSpot: () =>
      axios.get<{ nifty: number }>(`${base}/market/spot`).then((r) => r.data),
    closeAll: () =>
      axios.post(`${base}/control/close-all`).then((r) => r.data),
    halt: () =>
      axios.post(`${base}/control/halt`).then((r) => r.data),
    resume: () =>
      axios.post(`${base}/control/resume`).then((r) => r.data),
    // Zerodha only — get OAuth login URL
    getKiteLoginUrl: () =>
      axios.get<{ loginUrl: string }>(`${base}/kite/login`).then((r) => r.data),
    // Angel One only — trigger direct login
    angelLogin: () =>
      axios.post(`${base}/auth/login`).then((r) => r.data),
    getAuthStatus: () =>
      axios.get<{ authenticated: boolean }>(`${base}/auth/status`).then((r) => r.data),
  };
}

// Convenience singletons used by components that already know the broker
export const zerodhaApi = createApi('zerodha');
export const angelApi = createApi('angel');
