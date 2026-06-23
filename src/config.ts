import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
dotenv.config();

export const connection = new Connection(process.env.RPC_URL!, {
  commitment: 'confirmed',
  wsEndpoint: process.env.WSS_URL!,
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
};