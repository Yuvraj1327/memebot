// src/types.ts
// Shared types used across modules. Kept intentionally light — most modules
// still define their own local interfaces (Position, PaperPosition, SafetyResult)
// and that's left as-is; these are only the new cross-module contracts.

export type BotState =
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'emergency_stop'
  | 'daily_limit_reached';

export interface BotControls {
  start: () => Promise<void> | void;
  stop: () => void;
  emergencySell: () => Promise<string[]>;
  getPortfolio: () => PortfolioSummary;
}

export interface OpenPositionView {
  mint: string;
  entryPrice: number;
  buyTime: number;
  tokenAmount: number;
  highestPrice?: number;
  elapsedMs: number;
}

export interface PortfolioSummary {
  openPositions: OpenPositionView[];
  openCount: number;
}

export interface RiskStatus {
  date: string;
  realizedPnlSol: number;
  tradesToday: number;
  maxConcurrentPositions: number;
  maxDailyLossSol: number;
}

export interface WalletSession {
  address: string;
  token: string;
  expiresAt: string;
}