import { ISpread, ITrade } from '../db/trade.model';
import { OptionType } from '../utils/instrumentUtils';

export interface StrategySignal {
  action: 'ENTER' | 'ADJUST_CALL' | 'ADJUST_PUT' | 'EXIT';
  reason: string;
}

export interface SpreadEntryParams {
  strike: number;
  spreadType: 'CALL' | 'PUT';
  optionType: OptionType;
  nearExpiry: Date;
  farExpiry: Date;
}

export interface StrategyState {
  activeTrade: ITrade | null;
  currentSpot: number;
  spreadCount: number;
  currentPnLPct: number;
  holdingDays: number;
}

export interface AdjustmentCheck {
  shouldAddCallSpread: boolean;
  shouldAddPutSpread: boolean;
  shouldExit: boolean;
  exitReason?: string;
}

export type ExitReason =
  | 'PROFIT_TARGET'
  | 'MAX_LOSS'
  | 'HOLD_DAYS_EXCEEDED'
  | 'NEAR_EXPIRY'
  | 'MANUAL';
