import { PublicKey } from "@solana/web3.js";

/**
 * Sentinel constants — devnet only. Never point these at mainnet.
 * Sources: RESEARCH.md §1 (verified live 2026-11-13).
 */
export const PROGRAM_ID = new PublicKey(
  "GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y",
);
/** Devnet mock USDC (mUSDC), 6 decimals. */
export const USDC_MINT = new PublicKey(
  "3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ",
);
export const RPC_URL =
  process.env.RPC_URL || "https://api.devnet.solana.com";
export const FAUCET_URL =
  "https://pm-amm-devnet.vercel.app/api/faucet";
export const REFERENCE_APP = "https://pm-amm-devnet.vercel.app";

/** pm-AMM swap fee: 2% on the USDC leg, 50% protocol / 50% creator. */
export const SWAP_FEE_BPS = 200;
/** 1 winning token settles for 1 mUSDC. */
export const SETTLEMENT_USDC_PER_WINNING_TOKEN = 1;

/** Minimum market duration enforced on-chain (seconds). */
export const MIN_MARKET_DURATION_SECS = 300;
/** Faucet grant per claim: 1,000 mUSDC + 0.2 devnet SOL, 1 claim/wallet/hour. */
export const FAUCET_MUSDC = 1000;
export const FAUCET_SOL = 0.2;

export const solscanTxUrl = (sig: string): string =>
  `https://solscan.io/tx/${sig}?cluster=devnet`;
export const solscanAccountUrl = (addr: string): string =>
  `https://solscan.io/account/${addr}?cluster=devnet`;
export const marketAppUrl = (marketId: number): string =>
  `${REFERENCE_APP}/market/${marketId}`;
