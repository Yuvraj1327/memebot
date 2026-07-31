import winston from 'winston';
import Database from 'better-sqlite3';
import path from 'path';

// Winston console + file logger
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/bot.log' }),
  ],
});

// SQLite trade history — exported so other modules (settingsStore, riskManager,
// walletAuth) can share this same connection/file instead of opening their own.
export const db = new Database(path.join('data', 'trades.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    type TEXT NOT NULL,
    price REAL,
    amount REAL,
    pnl_pct REAL,
    tx_sig TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration: the trades table originally had no way to distinguish a paper
// trade from a live one, so Paper and Live stats/history/PnL/win-rate were
// always mixed together regardless of which mode was active. Existing rows
// (recorded before this column existed) default to 'paper', since that's
// what the bot always ran in before Live mode was added.
const tradeCols = db.prepare(`PRAGMA table_info(trades)`).all() as any[];
if (!tradeCols.some(c => c.name === 'mode')) {
  db.exec(`ALTER TABLE trades ADD COLUMN mode TEXT NOT NULL DEFAULT 'paper'`);
}

export function logTrade(trade: {
  mint: string;
  type: 'BUY' | 'SELL';
  price: number;
  amount: number;
  pnlPct?: number;
  txSig: string;
  mode: 'paper' | 'live';
}) {
  const stmt = db.prepare(
    `INSERT INTO trades (mint, type, price, amount, pnl_pct, tx_sig, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(trade.mint, trade.type, trade.price, trade.amount, trade.pnlPct ?? null, trade.txSig, trade.mode);
}

export function getRecentTrades(limit = 50, mode?: 'paper' | 'live') {
  if (mode) {
    return db.prepare('SELECT * FROM trades WHERE mode = ? ORDER BY timestamp DESC LIMIT ?').all(mode, limit);
  }
  return db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
}