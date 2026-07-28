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

export function logTrade(trade: {
  mint: string;
  type: 'BUY' | 'SELL';
  price: number;
  amount: number;
  pnlPct?: number;
  txSig: string;
}) {
  const stmt = db.prepare(
    `INSERT INTO trades (mint, type, price, amount, pnl_pct, tx_sig)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run(trade.mint, trade.type, trade.price, trade.amount, trade.pnlPct ?? null, trade.txSig);
}

export function getRecentTrades(limit = 50) {
  return db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
}