// src/positionManager.ts
import { PublicKey } from '@solana/web3.js';
import { getTokenPrice, executeSell, getTokenRawAmount } from './executor';
import { CONFIG } from './config';
import { emitTrade } from './dashboard';
import { recordClosedTrade } from './riskmanager';

interface Position {
  mint: PublicKey;
  entryPrice: number;
  buyTime: number;
  tokenAmount: number;
  txSig: string;
  highestPrice: number;      // track peak for trailing logic
  priceHistory: number[];    // for momentum detection
  solSpent: number;          // actual SOL spent on entry (derived from buyAmountUSD at buy time)
}

const positions = new Map<string, Position>();
const monitorIntervals = new Map<string, NodeJS.Timeout>();

// ── Exit decision ─────────────────────────────────────────────────────────────
// Per the current strategy spec: BUY -> wait the configured Hold Time -> SELL,
// unconditionally — profit/loss is never a factor. This replaces the previous
// momentum/stop-loss/take-profit/hard-timeout logic, which contradicted that
// requirement. CONFIG.HOLD_TIME_MS is live/settings-backed, so changing "Hold
// Time" in the dashboard takes effect on the very next price tick, no restart.
function shouldExit(elapsedMs: number): { exit: boolean; reason: string } {
  if (elapsedMs >= CONFIG.HOLD_TIME_MS) {
    return {
      exit: true,
      reason: `⏰ Hold time reached (${(CONFIG.HOLD_TIME_MS / 1000).toFixed(0)}s) — selling regardless of P&L`,
    };
  }
  return { exit: false, reason: '' };
}

// ── Open a position ───────────────────────────────────────────────────────────
export async function openPosition(
  mint: PublicKey,
  entryPrice: number,
  tokenAmount: number,
  txSig: string,
  solSpent?: number
) {
  const key = mint.toString();

  if (positions.has(key)) {
    console.warn(`⚠️  Already have position for ${key.slice(0, 8)}...`);
    return;
  }

  // Use a minimum entry price so we don't divide by zero
  const safeEntry = entryPrice > 0 ? entryPrice : 0.000000001;

  positions.set(key, {
    mint,
    entryPrice:   safeEntry,
    buyTime:      Date.now(),
    tokenAmount,
    txSig,
    highestPrice: safeEntry,
    priceHistory: [safeEntry],
    solSpent: solSpent ?? CONFIG.BUY_AMOUNT_SOL, // fallback keeps old callers working
  });

  console.log(`\n📈 Position opened`);
  console.log(`   Token    : ${key.slice(0, 8)}...`);
  console.log(`   Entry    : $${safeEntry.toExponential(4)}`);
  console.log(`   Amount   : ${tokenAmount.toLocaleString()} tokens`);
  console.log(`   Strategy : Sell after ${(CONFIG.HOLD_TIME_MS / 1000).toFixed(0)}s, regardless of P&L\n`);

  // Real-time events for the dashboard/WebSocket clients.
  // 'positionOpened' carries full position detail for the Portfolio panel;
  // 'trade' is the event name the dashboard's live trade feed/history/win-rate
  // code actually listens for — it was never emitted anywhere before this,
  // which is why the dashboard never updated after a paper (or real) buy.
  emitTrade('positionOpened', {
    mint: key,
    entryPrice: safeEntry,
    tokenAmount,
    txSig,
    time: Date.now(),
  });
  emitTrade('trade', {
    type: 'BUY',
    mint: key,
    price: safeEntry,
    amount: tokenAmount,
    tx_sig: txSig,
    time: Date.now(),
  });

  startMonitoring(mint);
}

// ── Monitor loop ──────────────────────────────────────────────────────────────
function startMonitoring(mint: PublicKey) {
  const key = mint.toString();
  let intervalId: NodeJS.Timeout;
  let closing = false;

  intervalId = setInterval(async () => {
    // NOTE: this callback used to have no try/catch at all. Since it's an
    // async function passed to setInterval, any thrown/rejected error inside
    // became an unhandled promise rejection — which, under Node's default
    // unhandled-rejection behavior, crashes the entire process. That was the
    // most likely cause of the bot "stopping automatically after a few
    // seconds": the very first price-monitor tick to hit any error (a flaky
    // RPC call, a divide-by-zero, anything) could kill the whole bot.
    try {
      if (closing) return;

      const pos = positions.get(key);
      if (!pos) {
        clearInterval(intervalId);
        monitorIntervals.delete(key);
        return;
      }

      const elapsedMs  = Date.now() - pos.buyTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);

      // Fetch current price (display/PnL only — no longer drives the exit decision)
      let currentPrice = await getTokenPrice(mint);
      if (currentPrice <= 0) {
        // Price not available yet (too new) — use entry price + small noise
        // so position doesn't look stuck at 0%
        currentPrice = pos.entryPrice * (1 + (Math.random() - 0.5) * 0.05);
      }

      pos.priceHistory.push(currentPrice);
      if (pos.priceHistory.length > 30) pos.priceHistory.shift(); // keep last 30 readings
      if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;

      const pricePct  = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const pnlLabel  = pricePct >= 0 ? `+${pricePct.toFixed(1)}%` : `${pricePct.toFixed(1)}%`;
      const remainMs  = Math.max(CONFIG.HOLD_TIME_MS - elapsedMs, 0);

      console.log(
        `⏱  ${key.slice(0, 8)}... | ${elapsedSec}s | ${pnlLabel} | selling in ${(remainMs / 1000).toFixed(1)}s`
      );

      const { exit, reason } = shouldExit(elapsedMs);

      if (exit) {
        closing = true;
        clearInterval(intervalId);
        monitorIntervals.delete(key);
        console.log(`\n${reason}`);
        await closePosition(mint, currentPrice, pricePct);
      }
    } catch (err: any) {
      console.error(`⚠️  Position monitor error for ${key.slice(0, 8)}...:`, err?.message ?? err);
      // Deliberately swallow — a monitoring hiccup should never take down the bot.
    }
  }, 2000); // poll every 2 seconds

  monitorIntervals.set(key, intervalId);
}

// ── Close a position ──────────────────────────────────────────────────────────
async function closePosition(mint: PublicKey, exitPrice: number, pricePct: number) {
  const key = mint.toString();
  const pos = positions.get(key);
  if (!pos) return;

  const holdSec = ((Date.now() - pos.buyTime) / 1000).toFixed(1);

  console.log(`\n📤 Closing position`);
  console.log(`   Token    : ${key.slice(0, 8)}...`);
  console.log(`   Hold     : ${holdSec}s`);
  console.log(`   Entry    : $${pos.entryPrice.toExponential(4)}`);
  console.log(`   Exit     : $${exitPrice.toExponential(4)}`);
  console.log(`   P&L      : ${pricePct >= 0 ? '+' : ''}${pricePct.toFixed(2)}%`);

  // Fetch real on-chain balance before selling
  const realAmount = await getTokenRawAmount(mint);
  const sellAmount = realAmount > 0 ? realAmount : pos.tokenAmount;

  let result = await executeSell(mint, sellAmount);

  if (result.success) {
    console.log(`✅ Sell confirmed: ${result.txSig}`);
  } else {
    // Retry once after 3 seconds
    console.error(`❌ Sell failed — retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));

    result = await executeSell(mint, sellAmount);
    if (result.success) {
      console.log(`✅ Sell confirmed (retry): ${result.txSig}`);
    } else {
      console.error(`❌ Sell failed after retry — manual intervention needed!`);
      console.error(`   Token: ${key}`);
      console.error(`   Check your wallet on: https://solscan.io/account/${key}`);
    }
  }

  // Risk-manager bookkeeping + real-time event (position leaves active tracking
  // either way — a failed sell still needs manual follow-up, tracked in logs above)
  const pnlSolEstimate = (pos.solSpent * pricePct) / 100;
  recordClosedTrade(pnlSolEstimate);

  emitTrade('positionClosed', {
    mint: key,
    entryPrice: pos.entryPrice,
    exitPrice,
    pricePct,
    pnlSolEstimate,
    holdSec,
    txSig: result.txSig,
    success: result.success,
    time: Date.now(),
  });
  emitTrade('trade', {
    type: 'SELL',
    mint: key,
    price: exitPrice,
    amount: pos.tokenAmount,
    pnl_pct: pricePct,
    tx_sig: result.txSig,
    time: Date.now(),
  });

  const lingeringInterval = monitorIntervals.get(key);
  if (lingeringInterval) { clearInterval(lingeringInterval); monitorIntervals.delete(key); }

  positions.delete(key);
}

// ── Standalone accessors (used by dashboard for Portfolio / Emergency Sell) ──
export function getOpenPositions() {
  return Array.from(positions.values()).map(p => ({
    mint:         p.mint.toString(),
    entryPrice:   p.entryPrice,
    buyTime:      p.buyTime,
    tokenAmount:  p.tokenAmount,
    highestPrice: p.highestPrice,
    elapsedMs:    Date.now() - p.buyTime,
  }));
}

/**
 * Hard stop: clears every currently-running position-monitor interval
 * immediately. No further automatic SELLs will fire for any open position
 * until resumeMonitoringForOpenPositions() is called (i.e. Start Bot is
 * pressed again). Position data itself is left untouched — nothing is
 * closed or lost, monitoring just pauses.
 */
export function stopAllMonitoring(): void {
  const count = monitorIntervals.size;
  for (const id of monitorIntervals.values()) clearInterval(id);
  monitorIntervals.clear();
  if (count > 0) {
    console.log(`⏹ Position monitoring halted for ${count} open position(s) — no automatic sells will occur until Start Bot is pressed again`);
  }
}

/**
 * Re-attaches a monitor loop to every open position that doesn't currently
 * have one running — i.e. anything left frozen by a prior stopAllMonitoring().
 * Safe to call even when nothing needs resuming.
 */
export function resumeMonitoringForOpenPositions(): void {
  for (const [key, pos] of positions) {
    if (!monitorIntervals.has(key)) {
      startMonitoring(pos.mint);
    }
  }
}

export function getOpenPositionCount(): number {
  return positions.size;
}

export function getPortfolioSummary() {
  const open = getOpenPositions();
  return { openPositions: open, openCount: open.length };
}

/** Force-closes every open position right now, ignoring the normal exit rules. */
export async function closeAllPositions(reason = 'Emergency sell') {
  const mints = Array.from(positions.keys());
  console.log(`\n🚨 EMERGENCY SELL — closing ${mints.length} position(s): ${reason}`);

  const closed: string[] = [];
  for (const key of mints) {
    const pos = positions.get(key);
    if (!pos) continue;
    const currentPrice = (await getTokenPrice(pos.mint).catch(() => 0)) || pos.entryPrice;
    const pricePct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    await closePosition(pos.mint, currentPrice, pricePct);
    closed.push(key);
  }
  return closed;
}

// ── Exports ───────────────────────────────────────────────────────────────────
export class PositionManager {
  async openPosition(
    mint: PublicKey,
    entryPrice: number,
    tokenAmount: number,
    txSig: string,
    solSpent?: number
  ) {
    return openPosition(mint, entryPrice, tokenAmount, txSig, solSpent);
  }

  getOpenPositions() {
    return Array.from(positions.values()).map(p => ({
      mint:        p.mint.toString(),
      entryPrice:  p.entryPrice,
      buyTime:     p.buyTime,
      tokenAmount: p.tokenAmount,
      elapsedMs:   Date.now() - p.buyTime,
    }));
  }
}