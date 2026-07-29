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
  getOpenPositionCount,
} from './positionManager';
import { runSafetyChecks } from './safety';
import { executeBuy, getTokenRawAmount } from './executor';
import { emitNewToken, isBotActive, setBotControls, emitTrade } from './dashboard';
import { loadPersistedSettings } from './settingstore';
import {
  canOpenPosition,
  shouldSkipToken,
  resetSkipCounter,
  recordBuy,
  getStrategyStatus,
} from './riskmanager';
import { logger } from './logger';

// ── Global crash guards ───────────────────────────────────────────────────────
// This is the fix for "bot stops automatically after a few seconds": an
// unhandled promise rejection anywhere (the price-monitor's setInterval
// callback, the buy queue's task, a stray RPC error) was previously fatal —
// Node's default behavior is to crash the whole process on an unhandled
// rejection. Both call sites now also have their own try/catch (see
// positionManager.ts and the queue.add(...).catch(...) below), but this is
// the last line of defense: no single error, anywhere, should ever be able
// to take the bot down. It only ever logs and continues.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection (ignored, bot keeps running): ${reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception (ignored, bot keeps running): ${err?.message ?? err}`);
});

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
  getOpenPositionCount: () => getOpenPositionCount(),
});

async function main() {
  console.log('🤖 MemeRush Bot Starting...');

  // Restore any settings saved via the dashboard on a previous run
  loadPersistedSettings();

  detector.on('newToken', ({ mint, source, signature }) => {

    // Dashboard pe naya token dikhao
    emitNewToken(mint.toString(), source ?? 'unknown');

    // Bot paused hai toh skip
    if (!isBotActive()) {
      console.log('⏸ Bot paused — skipping', mint.toString().slice(0, 8));
      return;
    }

    // NOTE: the old per-run MAX_TRADES cap (detector.canTrade()) and the daily
    // 100-trade limit (riskManager.canBuyToday()) have both been removed here.
    // Per spec, the bot must run continuously — scanning and trading — until
    // Stop Bot, Emergency Sell, or a critical backend error. It must never
    // stop itself just because it hit a trade count. The skip-buy strategy
    // and the concurrent-position/daily-loss risk gate below are unaffected;
    // neither of those is a trade-count cap.

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

      // Confirmed successful BUY: reset skip counter, count it toward stats
      // (no cap is enforced on this count anymore — see riskManager.recordBuy)
      resetSkipCounter();
      const dailyStatus = recordBuy();
      logger.info(
        `Trade Executed — mint=${mint.toString().slice(0, 8)} txSig=${buyResult.txSig} ` +
        `solSpent=${buyResult.solSpent?.toFixed(6)} todayTrades=${dailyStatus.todayTrades}`
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
        buyResult.txSig!,
        buyResult.solSpent
      );
    }).catch((err) => {
      // This .catch() is the other half of the crash-bug fix: previously the
      // promise returned by queue.add(...) was never awaited or caught, so
      // any error thrown inside the task above became an unhandled rejection.
      logger.error(`Buy task failed for ${mint.toString().slice(0, 8)}...: ${err?.message ?? err}`);
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










// // src/index.ts
// import https from 'https';
// import PQueue from 'p-queue';
// import { PublicKey } from '@solana/web3.js';
// import { TokenDetector } from './detector';
// import { PositionManager } from './positionManager';
// import { runSafetyChecks } from './safety';
// import { executeBuy, getTokenRawAmount } from './executor';
// import { emitNewToken, isBotActive } from './dashboard';

// const queue          = new PQueue({ concurrency: 1 });
// const detector       = new TokenDetector();
// const positionManager = new PositionManager();

// // ── Trade counter ─────────────────────────────────────────────────────────────
// let tradeCount  = 0;
// const MAX_TRADES = 20;  // ← yahan se change karo jitna chahiye

// function canTrade(): boolean {
//   if (tradeCount >= MAX_TRADES) {
//     console.log('🛑 Max ' + MAX_TRADES + ' trades reached — bot stopped buying');
//     return false;
//   }
//   return true;
// }

// async function main() {
//   console.log('🤖 MemeRush Bot Starting...');
//   console.log('📊 Max trades today: ' + MAX_TRADES);

//   detector.on('newToken', ({ mint, source }) => {
//     emitNewToken(mint.toString(), source ?? 'unknown');

//     if (!isBotActive()) return;
//     if (!canTrade()) return; // ← trade limit check

//     queue.add(async () => {
//       console.log('\n🔔 New token: ' + mint.toString());
//       console.log('📊 Trade ' + (tradeCount + 1) + '/' + MAX_TRADES);

//       // Safety check
//       const safety = await runSafetyChecks(mint, mint);
//       if (!safety.passed) {
//         console.log('❌ Safety failed: ' + safety.reason);
//         return;
//       }

//       // Buy karo
//       const buyResult = await executeBuy(mint, mint);
//       if (!buyResult.success || !buyResult.entryPrice) {
//         console.log('❌ Buy failed');
//         return;
//       }

//       // Trade count badhao — sirf successful buy pe
//       tradeCount++;
//       console.log('✅ Trade ' + tradeCount + '/' + MAX_TRADES + ' executed');

//       await new Promise(r => setTimeout(r, 2000));

//       const tokenAmount = await getTokenRawAmount(mint);
//       if (tokenAmount <= 0) {
//         console.warn('⚠️  No token balance found');
//         return;
//       }

//       await positionManager.openPosition(
//         mint,
//         buyResult.entryPrice,
//         tokenAmount,
//         buyResult.txSig!
//       );
//     });
//   });

//   await detector.start();
//   console.log('✅ Bot is live and listening...');
// }

// main().catch(console.error);

// // Render jaagta rahe
// setInterval(() => {
//   https.get('https://memebot-4.onrender.com/health', () => {})
//     .on('error', () => {});
// }, 10 * 60 * 1000);