// src/riskManager.ts
// Portfolio-level risk management, distinct from safety.ts (which vets a single
// token before buying). Tracks realized P&L per day, concurrent exposure, the
// skip-buy entry strategy, and the daily BUY-count limit — all persisted in
// SQLite (reusing logger.ts's db connection) so state survives a bot restart.
import { db, logger } from './logger';
import { CONFIG } from './config';
import { todayKey } from './utils';

// ── Migrations (safe / idempotent — SQLite has no "ADD COLUMN IF NOT EXISTS") ─
db.exec(`
  CREATE TABLE IF NOT EXISTS risk_state (
    day TEXT PRIMARY KEY,
    realized_pnl_sol REAL NOT NULL DEFAULT 0,
    trades INTEGER NOT NULL DEFAULT 0
  )
`);

function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Daily successful-BUY counter, tracked separately from `trades` (which counts
// completed round-trips on close, in the pre-existing risk_state schema).
ensureColumn('risk_state', 'buys', 'buys INTEGER NOT NULL DEFAULT 0');

// Small persistent key/value table for state that is NOT date-scoped:
// the skip-buy counter (runs continuously across restarts and across days),
// and the manual-halt flag used when autoResumeNextDay = false.
db.exec(`
  CREATE TABLE IF NOT EXISTS strategy_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS || '3');
const MAX_DAILY_LOSS_SOL = parseFloat(process.env.MAX_DAILY_LOSS_SOL || '1');

function getDayRow(day = todayKey()) {
  let row = db.prepare(`SELECT * FROM risk_state WHERE day = ?`).get(day) as any;
  if (!row) {
    db.prepare(`INSERT INTO risk_state (day, realized_pnl_sol, trades, buys) VALUES (?, 0, 0, 0)`).run(day);
    row = { day, realized_pnl_sol: 0, trades: 0, buys: 0 };
  }
  return row;
}

function getStrategyValue(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM strategy_state WHERE key = ?`).get(key) as any;
  return row?.value;
}

function setStrategyValue(key: string, value: string) {
  db.prepare(
    `INSERT INTO strategy_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// ── Existing: portfolio risk (concurrent positions + daily loss limit) ───────
export function canOpenPosition(openPositionsCount: number): { ok: boolean; reason?: string } {
  if (openPositionsCount >= MAX_CONCURRENT_POSITIONS) {
    return { ok: false, reason: `Max concurrent positions reached (${MAX_CONCURRENT_POSITIONS})` };
  }

  const row = getDayRow();
  if (row.realized_pnl_sol <= -Math.abs(MAX_DAILY_LOSS_SOL)) {
    return { ok: false, reason: `Daily loss limit hit (${row.realized_pnl_sol.toFixed(4)} SOL)` };
  }

  return { ok: true };
}

export function recordClosedTrade(pnlSol: number) {
  const day = todayKey();
  getDayRow(day);
  db.prepare(
    `UPDATE risk_state SET realized_pnl_sol = realized_pnl_sol + ?, trades = trades + 1 WHERE day = ?`
  ).run(pnlSol, day);
}

export function getRiskStatus() {
  const row = getDayRow();
  return {
    date: row.day,
    realizedPnlSol: row.realized_pnl_sol,
    tradesToday: row.trades,
    maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
    maxDailyLossSol: MAX_DAILY_LOSS_SOL,
  };
}

// ── NEW: Skip-buy strategy (Skip 3 -> Buy -> Skip 3 -> Buy ...) ──────────────
// The counter is intentionally NOT day-scoped: it tracks "tokens skipped since
// the last successful buy" and must keep running across midnight and across
// restarts, hence the dedicated strategy_state table.
function getSkipCounter(): number {
  const raw = getStrategyValue('skipCounter');
  return raw ? parseInt(raw, 10) : 0;
}

function setSkipCounter(n: number) {
  setStrategyValue('skipCounter', String(n));
}

export function getSkipStatus() {
  const skipCount = CONFIG.skipCount;
  const skipCounter = getSkipCounter();
  return {
    skipCount,
    skipCounter,
    // How many more tokens will be skipped before the next buy attempt (0 = next token is a buy attempt)
    nextBuyAfter: Math.max(skipCount - skipCounter, 0),
  };
}

/**
 * Call once per detected token, BEFORE running safety checks / buying.
 * Returns { skip: true } and increments+persists the counter if this token
 * should be skipped. Returns { skip: false } once the counter has reached
 * skipCount — meaning this token is a buy attempt. The counter is only
 * reset (via resetSkipCounter) after a *successful* buy, so a failed buy
 * attempt correctly keeps trying on every subsequent token instead of
 * restarting the skip cycle.
 */
export function shouldSkipToken(): { skip: boolean; skipCounter: number; skipCount: number } {
  const skipCount = CONFIG.skipCount;
  const counter = getSkipCounter();

  if (counter < skipCount) {
    const next = counter + 1;
    setSkipCounter(next);
    return { skip: true, skipCounter: next, skipCount };
  }

  return { skip: false, skipCounter: counter, skipCount };
}

/** Call after a CONFIRMED successful buy. */
export function resetSkipCounter() {
  setSkipCounter(0);
}

// ── Daily BUY counter (STATS ONLY — no longer enforced) ──────────────────────
// The 100-trade daily cap has been removed per spec: the bot must run
// continuously until Stop/Emergency Sell/a critical error, never on trade
// count. `todayTrades` is kept purely for the "Trades Today" dashboard stat.
export function getDailyTradeStatus() {
  const row = getDayRow();
  const todayTrades = row.buys ?? 0;
  return {
    todayTrades,
    remainingTrades: null as number | null, // null = unlimited (no cap enforced)
    dailyLimitReached: false,               // never true anymore — kept for API shape compatibility
  };
}

/** Call immediately after a CONFIRMED successful BUY (not on sell/close). Stats only. */
export function recordBuy() {
  const day = todayKey();
  getDayRow(day);
  db.prepare(`UPDATE risk_state SET buys = buys + 1 WHERE day = ?`).run(day);
  return getDailyTradeStatus();
}

/** No-op kept for API/back-compat — the daily trade limit is no longer enforced. */
export function canBuyToday(): { ok: boolean; reason?: string } {
  return { ok: true };
}

/** No-op kept for API/back-compat — there is no manual halt to clear anymore. */
export function clearManualHalt() {
  setStrategyValue('manualHaltActive', '0');
}

// ── Combined status block reused by GET /api/settings and GET /api/bot/status ─
export function getStrategyStatus() {
  const skip = getSkipStatus();
  const daily = getDailyTradeStatus();
  return {
    skipCount: skip.skipCount,
    currentSkipCounter: skip.skipCounter,
    nextBuyAfter: skip.nextBuyAfter,
    buyAmountUSD: CONFIG.buyAmountUSD,
    buyAmountMode: CONFIG.buyAmountMode,
    todayTrades: daily.todayTrades,
    remainingTrades: daily.remainingTrades,   // null = unlimited
    dailyLimitReached: daily.dailyLimitReached, // always false now
  };
}