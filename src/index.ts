// src/index.ts
import https from 'https';
import PQueue from 'p-queue';
import { PublicKey } from '@solana/web3.js';
import { TokenDetector } from './detector';
import { PositionManager } from './positionManager';
import { runSafetyChecks } from './safety';
import { executeBuy, getTokenRawAmount } from './executor';
import { emitNewToken, isBotActive } from './dashboard';

const queue = new PQueue({ concurrency: 1 });
const detector = new TokenDetector();
const positionManager = new PositionManager();

async function main() {
  console.log('🤖 MemeRush Bot Starting...');

  detector.on('newToken', ({ mint, source, signature }) => {

    // Dashboard pe naya token dikhao
    emitNewToken(mint.toString(), source ?? 'unknown');

    // Bot paused hai toh skip
    if (!isBotActive()) {
      console.log('⏸ Bot paused — skipping', mint.toString().slice(0, 8));
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