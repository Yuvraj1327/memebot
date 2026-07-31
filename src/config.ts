import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
dotenv.config();



export const connection = new Connection(process.env.RPC_URL!, {
  commitment: 'confirmed',
  // wsEndpoint line HATAO — WebSocket use nahi karenge
});



export const wallet = Keypair.fromSecretKey(
  bs58.decode(process.env.PRIVATE_KEY!)
);

export const CONFIG = {
  BUY_AMOUNT_SOL:        parseFloat(process.env.BUY_AMOUNT_SOL        || '0.01'),
  HOLD_TIME_MS:          parseInt(process.env.HOLD_TIME_MS             || '30000'),
  HOLD_TIME_MOMENTUM_MS: parseInt(process.env.HOLD_TIME_MOMENTUM_MS   || '45000'),
  TAKE_PROFIT_MIN:       parseFloat(process.env.TAKE_PROFIT_MIN        || '10'),
  TAKE_PROFIT_MAX:       parseFloat(process.env.TAKE_PROFIT_MAX        || '100'),
  MOMENTUM_THRESHOLD:    parseFloat(process.env.MOMENTUM_THRESHOLD     || '80'),
  SLIPPAGE_BPS:          parseInt(process.env.SLIPPAGE_BPS             || '1000'),
  MIN_LIQUIDITY_SOL:     parseFloat(process.env.MIN_LIQUIDITY_SOL      || '0.001'),
  PRIORITY_FEE_LAMPORTS: parseInt(process.env.PRIORITY_FEE_LAMPORTS   || '1000000'),

  // ── Skip-buy strategy / $ sizing ──────────────────────────────────────────
  // All of these are also stored in the settings DB (settingsStore.ts) and
  // loaded over these env defaults at boot via loadPersistedSettings(), and
  // can be changed live via POST /api/settings without a restart.
  skipCount:          parseInt(process.env.SKIP_COUNT           || '3'),     // skip N tokens, then buy
  dailyTradeLimit:    parseInt(process.env.DAILY_TRADE_LIMIT    || '100'),   // kept for stats display only — NOT enforced (no daily cap)
  buyAmountUSD:        parseFloat(process.env.BUY_AMOUNT_USD     || '1'),     // fixed $ size per buy, used when buyAmountMode === 'USD'
  buyAmountMode:      (process.env.BUY_AMOUNT_MODE || 'USD') as 'USD' | 'SOL', // 'USD' converts via live price; 'SOL' uses BUY_AMOUNT_SOL directly
  autoResumeNextDay:  (process.env.AUTO_RESUME_NEXT_DAY ?? 'true') === 'true',

  // ── Live, mutable trading-mode flag ───────────────────────────────────────
  // Previously this was a `const PAPER_MODE = process.env.PAPER_TRADING === 'true'`
  // captured once at module load in executor.ts — toggling it from the dashboard
  // updated process.env but the already-loaded const never changed, so the bot
  // kept running whichever mode it booted in. Now it's a live CONFIG field.
  paperTrading:       (process.env.PAPER_TRADING ?? 'true') === 'true',

  // ── Market Cap filter ──────────────────────────────────────────────────────
  // Buy only if MinMarketCapUSD <= token's current market cap <= MaxMarketCapUSD.
  // Defaults leave the filter effectively off (0 to a very high ceiling) until
  // configured from Settings. Checked in safety.ts before every buy.
  minMarketCapUSD:    parseFloat(process.env.MIN_MARKET_CAP_USD ?? '0'),
  maxMarketCapUSD:    parseFloat(process.env.MAX_MARKET_CAP_USD ?? '1000000000'),
};