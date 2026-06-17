// src/positionManager.ts
import { PublicKey } from '@solana/web3.js';
import { CONFIG, wallet } from './config';
import { getTokenPrice, executeSell } from './executor';

interface Position {
  mint: PublicKey;
  entryPrice: number;
  buyTime: number;
  tokenAmount: number;
  txSig: string;
}

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private priceHistory: Map<string, number[]> = new Map();

  async openPosition(
    mint: PublicKey,
    entryPrice: number,
    tokenAmount: number,
    txSig: string
  ) {
    const key = mint.toString();
    this.positions.set(key, {
      mint, entryPrice, buyTime: Date.now(), tokenAmount, txSig,
    });
    this.priceHistory.set(key, [entryPrice]);

    console.log(`📈 Position opened: ${key} @ ${entryPrice}`);
    this.startMonitoring(mint);
  }

  private async startMonitoring(mint: PublicKey) {
    const key = mint.toString();
    const position = this.positions.get(key)!;

    const interval = setInterval(async () => {
      const currentPrice = await getTokenPrice(mint);
      const history = this.priceHistory.get(key) || [];
      history.push(currentPrice);
      this.priceHistory.set(key, history);

      const pricePct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const elapsed = Date.now() - position.buyTime;
      const hasMomentum = this.detectMomentum(history);

      console.log(
        `⏱ ${key.slice(0, 8)}... | ` +
        `Elapsed: ${(elapsed / 1000).toFixed(0)}s | ` +
        `Price: ${pricePct.toFixed(1)}% | ` +
        `Momentum: ${hasMomentum}`
      );

      const shouldSell = this.evaluateExitCondition(
        pricePct, elapsed, hasMomentum
      );

      if (shouldSell) {
        clearInterval(interval);
        await this.closePosition(mint, currentPrice, pricePct);
      }
    }, 2000); // check every 2 seconds
  }

  private evaluateExitCondition(
    pricePct: number,
    elapsedMs: number,
    hasMomentum: boolean
  ): boolean {
    const holdTime = hasMomentum
      ? CONFIG.HOLD_TIME_MOMENTUM_MS
      : CONFIG.HOLD_TIME_MS;

    // Stop loss: price dropped more than 30%
    if (pricePct < -30) {
      console.log('🛑 Stop loss triggered');
      return true;
    }

    // Take profit if price is between 10%-100% after hold time
    if (
      elapsedMs >= holdTime &&
      pricePct >= CONFIG.TAKE_PROFIT_MIN &&
      pricePct <= CONFIG.TAKE_PROFIT_MAX
    ) {
      console.log('🎯 Take profit triggered');
      return true;
    }

    // Force sell if > 100% gain (avoid retracement)
    if (pricePct > CONFIG.TAKE_PROFIT_MAX) {
      console.log('🚀 Max profit exit triggered');
      return true;
    }

    // Hard timeout: always sell after 60 seconds
    if (elapsedMs > 60000) {
      console.log('⏰ Hard timeout exit');
      return true;
    }

    return false;
  }

  private detectMomentum(priceHistory: number[]): boolean {
    if (priceHistory.length < 3) return false;

    // Check if price increased by MOMENTUM_THRESHOLD% in last 3 readings
    const recent = priceHistory.slice(-3);
    const gain = ((recent[2] - recent[0]) / recent[0]) * 100;
    return gain >= CONFIG.MOMENTUM_THRESHOLD;
  }

  private async closePosition(
    mint: PublicKey,
    exitPrice: number,
    pricePct: number
  ) {
    const key = mint.toString();
    const position = this.positions.get(key)!;

    console.log(`📤 Closing position: ${key.slice(0, 8)}... | P&L: ${pricePct.toFixed(1)}%`);
    const result = await executeSell(mint, position.tokenAmount);

    if (result.success) {
      console.log(`✅ Sold: ${result.txSig}`);
      this.positions.delete(key);
      this.priceHistory.delete(key);
    } else {
      console.error('❌ Sell failed — retrying in 3s');
      setTimeout(() => this.closePosition(mint, exitPrice, pricePct), 3000);
    }
  }
}


