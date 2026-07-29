// src/index.ts
import https from 'https';
import PQueue from 'p-queue';
import { PublicKey } from '@solana/web3.js';
import { TokenDetector } from './detector';
import {
  PositionManager,
  getOpenPositions,
  closeAllPositions,
  getPortfolioSummary,
} from './positionManager';
import { runSafetyChecks } from './safety';
import { executeBuy, getTokenRawAmount } from './executor';
import { emitNewToken, isBotActive, setBotControls, emitTrade, tryAutoResumeFromDailyLimit, markDailyLimitReached } from './dashboard';
import { loadPersistedSettings } from './settingstore';
import {
  canOpenPosition,
  shouldSkipToken,
  resetSkipCounter,
  canBuyToday,
  recordBuy,
  getStrategyStatus,
} from './riskmanager';
import { logger } from './logger';

const queue = new PQueue({ concurrency: 1 });
const detector = new TokenDetector();
const positionManager = new PositionManager();

// Hand bot lifecycle + portfolio access to the dashboard so its API routes
// (start/stop/emergency-sell/portfolio) can actually control the running bot.
setBotControls({
  start: () => detector.start(),
  stop: () => detector.stop(),
  emergencySell: () => closeAllPositions('Manual emergency sell via API'),
  getPortfolio: () => getPortfolioSummary(),
});

async function main() {
  console.log('🤖 MemeRush Bot Starting...');

  // Restore any settings saved via the dashboard on a previous run
  loadPersistedSettings();

  detector.on('newToken', ({ mint, source, signature }) => {

    // Dashboard pe naya token dikhao
    emitNewToken(mint.toString(), source ?? 'unknown');

    // If the bot auto-halted on the daily limit, check whether it can resume
    // (new day rolled over, or the limit was raised) before the active check.
    tryAutoResumeFromDailyLimit();

    // Bot paused hai toh skip
    if (!isBotActive()) {
      console.log('⏸ Bot paused — skipping', mint.toString().slice(0, 8));
      return;
    }

    // Daily/per-run trade cap (was defined on the detector but never checked)
    if (!detector.canTrade()) {
      console.log('🛑 Max trades reached — skipping', mint.toString().slice(0, 8));
      return;
    }

    // ── Daily BUY limit (100/day by default) ──────────────────────────────
    const dailyGate = canBuyToday();
    if (!dailyGate.ok) {
      logger.info(`Daily Limit Reached — skipping ${mint.toString().slice(0, 8)} (${dailyGate.reason})`);
      markDailyLimitReached();
      emitTrade('strategyStatus', getStrategyStatus());
      return;
    }

    // ── Skip-buy strategy (Skip N -> Buy -> Skip N -> Buy ...) ────────────
    const skipDecision = shouldSkipToken();
    if (skipDecision.skip) {
      logger.info(
        `Token Skipped — mint=${mint.toString().slice(0, 8)} reason="skip-buy strategy" ` +
        `skipCounter=${skipDecision.skipCounter}/${skipDecision.skipCount}`
      );
      emitTrade('strategyStatus', getStrategyStatus());
      return;
    }

    // Portfolio-level risk management: concurrent exposure + daily loss limit
    const risk = canOpenPosition(getOpenPositions().length);
    if (!risk.ok) {
      console.log(`🚫 Risk check blocked trade: ${risk.reason}`);
      return;
    }

    queue.add(async () => {
      console.log(`\n🔔 New token: ${mint.toString()} (buy attempt, skipCounter=${skipDecision.skipCounter}/${skipDecision.skipCount})`);

      // Safety check
      const safety = await runSafetyChecks(mint, mint);
      if (!safety.passed) {
        console.log(`❌ Safety failed: ${safety.reason}`);
        // Buy attempt failed before even reaching the exchange — skip counter
        // stays where it is, so the *next* token is also treated as a buy attempt.
        return;
      }

      // Execute buy
      const buyResult = await executeBuy(mint, mint);
      if (!buyResult.success || !buyResult.entryPrice) {
        console.log('❌ Buy failed or no entry price — will retry on next detected token');
        // Skip counter intentionally left unchanged (only resets on success).
        return;
      }

      detector.incrementTrade();

      // Confirmed successful BUY: reset skip counter, count it toward the daily limit
      resetSkipCounter();
      const dailyStatus = recordBuy();
      logger.info(
        `Trade Executed — mint=${mint.toString().slice(0, 8)} txSig=${buyResult.txSig} ` +
        `solSpent=${buyResult.solSpent?.toFixed(6)} todayTrades=${dailyStatus.todayTrades}/${dailyStatus.todayTrades + dailyStatus.remainingTrades}`
      );
      emitTrade('strategyStatus', getStrategyStatus());

      // Balance settle hone do
      await new Promise(r => setTimeout(r, 2000));

      // Real token amount fetch karo
      const tokenAmount = await getTokenRawAmount(mint);
      if (tokenAmount <= 0) {
        console.warn('⚠️  Could not read token balance after buy');
        return;
      }

      console.log(`📦 Got ${tokenAmount} raw tokens`);

      await positionManager.openPosition(
        mint,
        buyResult.entryPrice,
        tokenAmount,
        buyResult.txSig!
      );
    });
  });

  await detector.start();
  console.log('✅ Bot is live and listening...');
}

main().catch(console.error);

// Render free tier ko jaagta rakho
setInterval(() => {
  https.get('https://memebot-4.onrender.com/health', () => {})
    .on('error', () => {});
}, 10 * 60 * 1000);

