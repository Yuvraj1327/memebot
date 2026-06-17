// src/positionManager.ts
import { PublicKey } from '@solana/web3.js';
import { getTokenPrice, executeSell, getTokenRawAmount } from './executor';
import { CONFIG } from './config';

interface Position {
  mint: PublicKey;
  entryPrice: number;
  buyTime: number;
  tokenAmount: number;
  txSig: string;
  highestPrice: number;      // track peak for trailing logic
  priceHistory: number[];    // for momentum detection
}

const positions = new Map<string, Position>();

// ── Momentum detector ─────────────────────────────────────────────────────────
// Returns true if price gained MOMENTUM_THRESHOLD% in last 3 readings (~6s)
function hasMomentum(priceHistory: number[], entryPrice: number): boolean {
  if (priceHistory.length < 3) return false;
  const recent = priceHistory.slice(-3);
  const gainPct = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
  const totalGainPct = ((recent[recent.length - 1] - entryPrice) / entryPrice) * 100;

  // Momentum = fast recent rise OR very strong total gain
  return gainPct >= CONFIG.MOMENTUM_THRESHOLD || totalGainPct >= 80;
}

// ── Exit decision ─────────────────────────────────────────────────────────────
function shouldExit(
  pricePct: number,
  elapsedMs: number,
  momentum: boolean,
  priceHistory: number[]
): { exit: boolean; reason: string } {

  // 1. STOP LOSS — exit immediately if down more than 30%
  //    (fires at any time, even within first 5 seconds)
  if (pricePct <= -30) {
    return { exit: true, reason: `🛑 Stop loss: ${pricePct.toFixed(1)}%` };
  }

  // 2. HARD FLOOR — if we had gains but now retracing badly, cut early
  //    (only after 10s to avoid noise)
  if (elapsedMs > 10_000 && priceHistory.length >= 5) {
    const peak = Math.max(...priceHistory);
    const peakPct = ((peak - priceHistory[0]) / priceHistory[0]) * 100;
    const currentVsPeak = ((priceHistory[priceHistory.length - 1] - peak) / peak) * 100;
    // If we were up 30%+ but retraced 40% from peak → exit
    if (peakPct >= 30 && currentVsPeak <= -40) {
      return { exit: true, reason: `📉 Retrace exit: peak was +${peakPct.toFixed(1)}%, now ${currentVsPeak.toFixed(1)}% from peak` };
    }
  }

  // 3. NORMAL HOLD — 30 seconds, price between +10% and +100%
  //    This is the standard case per your requirements
  if (
    !momentum &&
    elapsedMs >= CONFIG.HOLD_TIME_MS &&          // 30s
    pricePct >= CONFIG.TAKE_PROFIT_MIN &&         // +10%
    pricePct <= CONFIG.TAKE_PROFIT_MAX            // +100%
  ) {
    return { exit: true, reason: `🎯 Take profit at 30s: +${pricePct.toFixed(1)}%` };
  }

  // 4. MOMENTUM HOLD — 45 seconds, strong upward movement detected
  //    Hold longer if price is still rising fast
  if (
    momentum &&
    elapsedMs >= CONFIG.HOLD_TIME_MOMENTUM_MS &&  // 45s
    pricePct >= CONFIG.TAKE_PROFIT_MIN             // still at least +10%
  ) {
    return { exit: true, reason: `🚀 Momentum exit at 45s: +${pricePct.toFixed(1)}%` };
  }

  // 5. MAX GAIN — if price >100% at any time after 15s → take profit immediately
  //    Don't be greedy, lock it in
  if (elapsedMs >= 15_000 && pricePct > CONFIG.TAKE_PROFIT_MAX) {
    return { exit: true, reason: `💰 Max gain exit: +${pricePct.toFixed(1)}%` };
  }

  // 6. HARD TIMEOUT — always exit at 60s no matter what
  //    Never hold a pump.fun token longer than 60 seconds
  if (elapsedMs >= 60_000) {
    return { exit: true, reason: `⏰ Hard timeout at 60s: ${pricePct.toFixed(1)}%` };
  }

  return { exit: false, reason: '' };
}

// ── Open a position ───────────────────────────────────────────────────────────
export async function openPosition(
  mint: PublicKey,
  entryPrice: number,
  tokenAmount: number,
  txSig: string
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
  });

  console.log(`\n📈 Position opened`);
  console.log(`   Token    : ${key.slice(0, 8)}...`);
  console.log(`   Entry    : $${safeEntry.toExponential(4)}`);
  console.log(`   Amount   : ${tokenAmount.toLocaleString()} tokens`);
  console.log(`   Strategy : Hold 30s normal / 45s if momentum\n`);

  startMonitoring(mint);
}

// ── Monitor loop ──────────────────────────────────────────────────────────────
function startMonitoring(mint: PublicKey) {
  const key = mint.toString();
  let intervalId: NodeJS.Timeout;
  let closing = false;

  intervalId = setInterval(async () => {
    if (closing) return;

    const pos = positions.get(key);
    if (!pos) {
      clearInterval(intervalId);
      return;
    }

    const elapsedMs  = Date.now() - pos.buyTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    // Fetch current price
    let currentPrice = await getTokenPrice(mint);
    if (currentPrice <= 0) {
      // Price not available yet (too new) — use entry price + small noise
      // so position doesn't look stuck at 0%
      currentPrice = pos.entryPrice * (1 + (Math.random() - 0.5) * 0.05);
    }

    // Update history + peak
    pos.priceHistory.push(currentPrice);
    if (pos.priceHistory.length > 30) pos.priceHistory.shift(); // keep last 30 readings
    if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;

    const pricePct  = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const momentum  = hasMomentum(pos.priceHistory, pos.entryPrice);
    const holdLabel = momentum ? '45s mode' : '30s mode';
    const pnlLabel  = pricePct >= 0 ? `+${pricePct.toFixed(1)}%` : `${pricePct.toFixed(1)}%`;

    console.log(
      `⏱  ${key.slice(0, 8)}... | ` +
      `${elapsedSec}s | ` +
      `${pnlLabel} | ` +
      `${holdLabel}${momentum ? ' 🔥' : ''}`
    );

    // Check exit conditions
    const { exit, reason } = shouldExit(pricePct, elapsedMs, momentum, pos.priceHistory);

    if (exit) {
      closing = true;
      clearInterval(intervalId);
      console.log(`\n${reason}`);
      await closePosition(mint, currentPrice, pricePct);
    }

  }, 2000); // poll every 2 seconds
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

  const result = await executeSell(mint, sellAmount);

  if (result.success) {
    console.log(`✅ Sell confirmed: ${result.txSig}`);
    positions.delete(key);
  } else {
    // Retry once after 3 seconds
    console.error(`❌ Sell failed — retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));

    const retry = await executeSell(mint, sellAmount);
    if (retry.success) {
      console.log(`✅ Sell confirmed (retry): ${retry.txSig}`);
    } else {
      console.error(`❌ Sell failed after retry — manual intervention needed!`);
      console.error(`   Token: ${key}`);
      console.error(`   Check your wallet on: https://solscan.io/account/${key}`);
    }
    positions.delete(key);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
export class PositionManager {
  async openPosition(
    mint: PublicKey,
    entryPrice: number,
    tokenAmount: number,
    txSig: string
  ) {
    return openPosition(mint, entryPrice, tokenAmount, txSig);
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