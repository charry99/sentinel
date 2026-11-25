/**
 * pm-AMM client wrapper — the only module that talks to the chain.
 *
 * Gotchas honoured here (RESEARCH.md §8):
 * - CommonJS (compiled from TS with module: commonjs) — raw Node ESM
 *   fails on BN from @anchor-lang/core.
 * - send.swap / send.redeemPair take RAW 6-dp units; every other send.*
 *   takes human units.
 * - Never hand-roll quotes: use quoteSwap/minOutput from pmAmmHelpers.ts.
 * - Public devnet RPC 429s: reads are batched where possible and retried
 *   with >=15s gaps.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { PmAmmClient } from "@pm-amm/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  FAUCET_URL,
  PROGRAM_ID,
  RPC_URL,
  USDC_MINT,
} from "./constants";

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Retry a read against the public devnet RPC; 429s get >=15s gaps. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [retry] ${label} attempt ${i + 1} failed: ${msg.split("\n")[0]}`);
      if (i < attempts - 1) await sleep(15000);
    }
  }
  throw last;
}

export function defaultKeypairPath(): string {
  return path.join(os.homedir(), ".config", "sentinel", "devnet-wallet.json");
}

/**
 * Load the agent keypair, or generate a FRESH devnet-only one if none exists.
 * Resolution order: SENTINEL_KEYPAIR_PATH > ./devnet-wallet.json >
 * ~/.config/sentinel/devnet-wallet.json > generate ./devnet-wallet.json.
 * Never pass a mainnet wallet path here. The file is written 0600.
 */
export function loadOrCreateKeypair(): { keypair: Keypair; path: string; created: boolean } {
  const candidates = [
    process.env.SENTINEL_KEYPAIR_PATH,
    path.join(process.cwd(), "devnet-wallet.json"),
    defaultKeypairPath(),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const kp = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]),
      );
      return { keypair: kp, path: p, created: false };
    }
  }
  const kp = Keypair.generate();
  const out = path.join(process.cwd(), "devnet-wallet.json");
  fs.writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`created fresh devnet-only keypair at ${out} (never reuse on mainnet)`);
  return { keypair: kp, path: out, created: true };
}

export function createConnection(): Connection {
  const conn = new Connection(process.env.RPC_URL || RPC_URL, "confirmed");
  patchConfirmTransaction(conn);
  return conn;
}

/**
 * HTTP-polling replacement for `Connection.confirmTransaction`.
 *
 * WHY: web3.js confirmation subscribes over websocket (`onSignature`), and
 * this VM's egress proxy breaks wss to api.devnet.solana.com (TLS EPROTO
 * "wrong version number") — every confirm hangs 30s and then throws
 * TransactionExpiredTimeoutError even when the tx landed. The pm-AMM SDK's
 * `send.*` path goes through Anchor's `sendAndConfirm`, which calls this
 * same method, so patching it here fixes the SDK path too. HTTP RPC
 * (`getSignatureStatus`) works fine in this environment.
 */
export function patchConfirmTransaction(conn: Connection): void {
  const patched = async (
    strategy: string | { signature: string },
    commitment?: string | { commitment?: string },
  ): Promise<{ context: { slot: number }; value: unknown }> => {
    const signature =
      typeof strategy === "string" ? strategy : strategy.signature;
    const want =
      (typeof commitment === "string"
        ? commitment
        : commitment?.commitment) ?? "confirmed";
    const deadline = Date.now() + 90000;
    for (;;) {
      const st = await conn.getSignatureStatus(signature);
      const v = st?.value as {
        err?: unknown;
        confirmationStatus?: string;
      } | null;
      if (v?.err) {
        throw new Error(
          `tx ${signature} failed on-chain: ${JSON.stringify(v.err)}`,
        );
      }
      if (v?.confirmationStatus) {
        const cs = v.confirmationStatus;
        const ok =
          want === "processed"
            ? true
            : want === "finalized"
              ? cs === "finalized"
              : cs === "confirmed" || cs === "finalized";
        if (ok) {
          return {
            context: { slot: st!.context.slot },
            value: { ...v, err: null },
          };
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `tx ${signature} was not confirmed in 90s (HTTP polling); ` +
            `check https://solscan.io/tx/${signature}?cluster=devnet`,
        );
      }
      await sleep(5000);
    }
  };
  (conn as unknown as Record<string, unknown>).confirmTransaction = patched;
}

export function createClient(conn: Connection, kp: Keypair): PmAmmClient {
  const provider = new AnchorProvider(conn, new Wallet(kp), {
    commitment: "confirmed",
  });
  return PmAmmClient.fromProvider(provider, PROGRAM_ID, USDC_MINT);
}

export async function solBalance(conn: Connection, owner: PublicKey): Promise<number> {
  return (await withRetry("getBalance", () => conn.getBalance(owner))) / LAMPORTS_PER_SOL;
}

export async function usdcBalance(conn: Connection, owner: PublicKey): Promise<number> {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return Number(bal.value.uiAmount ?? 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // No token account yet = 0. Return immediately instead of retrying:
    // "could not find account" is not transient.
    if (/could not find account/i.test(msg)) return 0;
    const bal = await withRetry("getTokenAccountBalance", () =>
      conn.getTokenAccountBalance(ata),
    );
    return Number(bal.value.uiAmount ?? 0);
  }
}

export interface FaucetResult {
  ok: boolean;
  signature: string;
  amount: number;
  sol: number;
}

/**
 * Claim the pm-AMM faucet: 1,000 mUSDC + 0.2 devnet SOL.
 * Limit 1 claim/wallet/hour — a 429 tells you how long to wait.
 */
export async function claimFaucet(pubkey: PublicKey): Promise<FaucetResult> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: pubkey.toBase58() }),
  });
  const body = (await res.json()) as FaucetResult & { error?: string };
  if (!res.ok) {
    throw new Error(`faucet ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Ensure the wallet can afford a market: >=50 mUSDC and >=0.05 SOL.
 * Claims the faucet when mUSDC is low, then polls balances at 15s
 * intervals (public RPC 429 etiquette). Falls back to a public SOL
 * airdrop if SOL is still short; throws with instructions if that fails.
 */
export async function ensureFunded(
  conn: Connection,
  kp: Keypair,
): Promise<{ sol: number; usdc: number }> {
  let usdc = await usdcBalance(conn, kp.publicKey);
  if (usdc < 50) {
    console.log("claiming 1,000 mUSDC from the pm-AMM faucet…");
    const f = await claimFaucet(kp.publicKey);
    console.log(`faucet ok: ${f.amount} mUSDC + ${f.sol} SOL, tx ${f.signature}`);
    await withRetry("confirm faucet tx", () =>
      conn.confirmTransaction(f.signature, "confirmed"),
    );
  }
  let sol = await solBalance(conn, kp.publicKey);
  if (sol < 0.05) {
    console.log("requesting a devnet SOL airdrop…");
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `devnet SOL airdrop refused (${msg.split("\n")[0]}). ` +
          `Public airdrops are rate-limited per IP. Get devnet SOL another way, then re-run: ` +
          `https://faucet.solana.com (paste ${kp.publicKey.toBase58()})`,
      );
    }
    sol = await solBalance(conn, kp.publicKey);
  }
  // Poll until the faucet funds land (up to ~90s, 15s gaps).
  for (let i = 0; i < 6 && usdc < 50; i++) {
    await sleep(15000);
    usdc = await usdcBalance(conn, kp.publicKey);
  }
  if (usdc < 50) throw new Error(`faucet funds did not land: mUSDC balance still ${usdc}`);
  return { sol, usdc };
}
