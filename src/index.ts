import { TokenDetector } from './detector';
import { PositionManager } from './positionManager';
import { runSafetyChecks } from './safety';
import { executeBuy, getTokenRawAmount } from './executor';
import { PublicKey } from '@solana/web3.js';
import PQueue from 'p-queue';




import './dashboard';



const queue = new PQueue({ concurrency: 1 });
const detector = new TokenDetector();
const positionManager = new PositionManager();

async function main() {
  console.log('🤖 MemeRush Bot Starting...');

  detector.on('newToken', ({ mint, signature }) => {
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

      // Wait a moment for balance to settle on-chain
      await new Promise(r => setTimeout(r, 2000));

      // Fetch real token amount from wallet
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