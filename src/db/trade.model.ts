import mongoose, { Document, Schema, Model } from 'mongoose';
import { OptionType } from '../utils/instrumentUtils';

// ── Leg (individual order within a spread) ────────────────────────────────────

export type TransactionType = 'BUY' | 'SELL';
export type LegStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'REJECTED' | 'CANCELLED';

export interface ILeg {
  kiteOrderId: string;
  symbol: string;
  exchange: string;
  transactionType: TransactionType;
  optionType: OptionType;
  strike: number;
  expiry: Date;
  quantity: number;
  limitPrice: number;
  avgFillPrice: number;
  status: LegStatus;
  placedAt: Date;
  filledAt?: Date;
}

const LegSchema = new Schema<ILeg>(
  {
    kiteOrderId: { type: String, required: true },
    symbol: { type: String, required: true },
    exchange: { type: String, required: true },
    transactionType: { type: String, enum: ['BUY', 'SELL'], required: true },
    optionType: { type: String, enum: ['CE', 'PE'], required: true },
    strike: { type: Number, required: true },
    expiry: { type: Date, required: true },
    quantity: { type: Number, required: true },
    limitPrice: { type: Number, required: true },
    avgFillPrice: { type: Number, default: 0 },
    status: { type: String, enum: ['PENDING', 'OPEN', 'FILLED', 'REJECTED', 'CANCELLED'], default: 'PENDING' },
    placedAt: { type: Date, default: Date.now },
    filledAt: { type: Date },
  },
  { _id: false },
);

// ── Spread (one calendar spread consisting of 2 legs) ────────────────────────

export type SpreadType = 'CALL' | 'PUT';

export interface ISpread {
  spreadIndex: number;
  spreadType: SpreadType;
  strike: number;
  shortLeg: ILeg;
  longLeg: ILeg;
  netPremium: number;       // shortLeg.avgFillPrice - longLeg.avgFillPrice
  breakEvenUpper: number;
  breakEvenLower: number;
  addedAt: Date;
}

const SpreadSchema = new Schema<ISpread>(
  {
    spreadIndex: { type: Number, required: true },
    spreadType: { type: String, enum: ['CALL', 'PUT'], required: true },
    strike: { type: Number, required: true },
    shortLeg: { type: LegSchema, required: true },
    longLeg: { type: LegSchema, required: true },
    netPremium: { type: Number, default: 0 },
    breakEvenUpper: { type: Number, required: true },
    breakEvenLower: { type: Number, required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// ── Trade (the full position for one strategy cycle) ─────────────────────────

export type TradeStatus = 'OPEN' | 'CLOSED' | 'ADJUSTING' | 'CLOSING';

export interface ITrade extends Document {
  tradeId: string;
  entryTime: Date;
  baseStrike: number;
  niftySpotAtEntry: number;
  spreads: ISpread[];
  spreadCount: number;
  currentPnL: number;
  realizedPnL: number;
  capitalDeployed: number;
  totalTransactionCosts: number;
  status: TradeStatus;
  exitTime?: Date;
  exitReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TradeSchema = new Schema<ITrade>(
  {
    tradeId: { type: String, required: true, unique: true, index: true },
    entryTime: { type: Date, required: true },
    baseStrike: { type: Number, required: true },
    niftySpotAtEntry: { type: Number, required: true },
    spreads: { type: [SpreadSchema], default: [] },
    spreadCount: { type: Number, default: 0 },
    currentPnL: { type: Number, default: 0 },
    realizedPnL: { type: Number, default: 0 },
    capitalDeployed: { type: Number, default: 0 },
    totalTransactionCosts: { type: Number, default: 0 },
    status: { type: String, enum: ['OPEN', 'CLOSED', 'ADJUSTING', 'CLOSING'], default: 'OPEN' },
    exitTime: { type: Date },
    exitReason: { type: String },
  },
  {
    timestamps: true,
    collection: 'trades',
  },
);

TradeSchema.index({ status: 1, entryTime: -1 });

export const TradeModel: Model<ITrade> = mongoose.model<ITrade>('Trade', TradeSchema);

// ── Access Token Storage ──────────────────────────────────────────────────────

export interface IAccessToken extends Document {
  apiKey: string;
  accessToken: string;
  generatedAt: Date;
}

const AccessTokenSchema = new Schema<IAccessToken>(
  {
    apiKey: { type: String, required: true, unique: true },
    accessToken: { type: String, required: true },
    generatedAt: { type: Date, required: true },
  },
  { collection: 'access_tokens' },
);

export const AccessTokenModel: Model<IAccessToken> = mongoose.model<IAccessToken>(
  'AccessToken',
  AccessTokenSchema,
);
