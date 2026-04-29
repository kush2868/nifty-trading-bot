import axios from 'axios';

const BASE = '';

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

export const api = {
  getActiveTrade: () => axios.get<Trade | null>(`${BASE}/trades/active`).then(r => r.data),
  getTrades: () => axios.get<Trade[]>(`${BASE}/trades`).then(r => r.data),
  getRiskSnapshot: () => axios.get<RiskSnapshot>(`${BASE}/risk/snapshot`).then(r => r.data),
  getSpot: () => axios.get<{ nifty: number }>(`${BASE}/market/spot`).then(r => r.data),
  closeAll: () => axios.post(`${BASE}/control/close-all`).then(r => r.data),
  halt: () => axios.post(`${BASE}/control/halt`).then(r => r.data),
  resume: () => axios.post(`${BASE}/control/resume`).then(r => r.data),
  getLoginUrl: () => axios.get<{ loginUrl: string }>(`${BASE}/kite/login`).then(r => r.data),
};
