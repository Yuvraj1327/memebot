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
import { emitNewToken, isBotActive, setBotControls } from './dashboard';
import { loadPersistedSettings } from './settingstore';
import { canOpenPosition } from './riskmanager';

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

    // Portfolio-level risk management: concurrent exposure + daily loss limit
    const risk = canOpenPosition(getOpenPositions().length);
    if (!risk.ok) {
      console.log(`🚫 Risk check blocked trade: ${risk.reason}`);
      return;
    }

    queue.add(async () => {
      console.log(`\n🔔 New token: ${mint.toString()}`);

      // Safety check
      const safety = await runSafetyChecks(mint, mint);
      if (!safety.passed) {
        console.log(`❌ Safety failed: ${safety.reason}`);
        return;
      }

      // Execute buy
      const buyResult = await executeBuy(mint, mint);
      if (!buyResult.success || !buyResult.entryPrice) {
        console.log('❌ Buy failed or no entry price');
        return;
      }

      detector.incrementTrade();

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