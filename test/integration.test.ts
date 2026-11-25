import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Devnet integration test — runs the real demo path (`node dist/src/demo.js`),
 * which creates one binary market on Solana devnet and buys YES.
 *
 * Gated: only runs when SENTINEL_INTEGRATION=1. `npm test` skips it.
 * If the faucet rate-limit (1 claim/wallet/hour) blocks funding, the test
 * is SKIPPED explicitly — never faked as a pass. Any other failure fails.
 */
test("demo path creates a market on devnet and buys YES", async (t) => {
  if (process.env.SENTINEL_INTEGRATION !== "1") {
    t.skip("set SENTINEL_INTEGRATION=1 to run the devnet integration test");
    return;
  }
  const repoRoot = path.join(__dirname, "..", ".."); // dist/test -> repo root
  const recordPath = path.join(repoRoot, "data", "demo-market.json");
  const before = fs.existsSync(recordPath)
    ? fs.readFileSync(recordPath, "utf8")
    : null;
  try {
    const { stdout } = await execFileAsync("node", ["dist/src/demo.js"], {
      cwd: repoRoot,
      timeout: 300000,
      env: { ...process.env },
    });
    assert.match(stdout, /market\s+[1-9A-HJ-NP-Za-km-z]{32,44}/);
    assert.match(stdout, /create tx\s+[1-9A-HJ-NP-Za-km-z]{80,90}/);
    assert.match(stdout, /swap tx\s+[1-9A-HJ-NP-Za-km-z]{80,90}/);
    assert.match(stdout, /bought .* YES for 5 mUSDC/);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
    if (/faucet 429/.test(out) || /1 claim per wallet per hour/i.test(out)) {
      t.skip("faucet rate-limited (1 claim/wallet/hour) — re-run after the window");
      return;
    }
    throw e;
  }
  assert.ok(fs.existsSync(recordPath), "data/demo-market.json must exist after the demo");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
    marketPda: string;
    createTx: string;
    swapTx: string;
    marketId: number;
    status: string;
  };
  assert.ok(record.marketPda.length >= 32);
  assert.ok(record.createTx.length >= 80);
  assert.ok(record.swapTx.length >= 80);
  assert.equal(record.status, "LIVE");
  assert.notEqual(
    before === null ? null : JSON.parse(before as string).createTx,
    record.createTx,
    "integration run must create a NEW market, not reuse the old record",
  );
});
