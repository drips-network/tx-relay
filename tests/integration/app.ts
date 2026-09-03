import { retry } from "async";
import { assert, assertEquals } from "@std/assert";
import { Hex } from "viem";
import { foundry } from "viem/chains";

// Anvil's default account #0, pre-funded with test ETH. This is the wallet the app's own
// worker uses to send transactions - tests must never use it for their own on-chain setup
// (e.g. deploying fixtures), since that would consume nonces the worker doesn't know about
// and desync its nonce tracking. Use `anvil.ts`'s `maintenanceClient` for that instead.
export const workerPrivateKey: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const port = 8000;

// Passed explicitly into the worker's chain config below, rather than relying on the app's own
// default, so callers needing to mine confirming blocks (e.g. `relay.test.ts`) have one shared,
// explicit source of truth for how many are required instead of an assumed/hardcoded number.
export const confirmations = 1;

// Minimizes every worker delay/poll cadence, trading CPU usage for latency, so tests aren't
// stuck waiting out multi-second production defaults (e.g. the 1s batch-retry or 2s block-poll
// interval). These fields only exist for this purpose and are never meant to be set in prod.
const testConfig = {
  workerRestartDelayMs: 1,
  sendNextBatchMinRetryDelayMs: 1,
  delayUntilBlockNumberPollingIntervalMs: 1,
  waitForBalanceRetryDelayMs: 1,
  burnNonceDelayInitialMs: 1,
  burnNonceDelayMultiplier: 1,
  burnNonceDelayMaxMs: 1,
};

export async function startApp(): Promise<Deno.ChildProcess> {
  const config = {
    wallets: [{ privateKey: workerPrivateKey, chains: [{ chainId: foundry.id, confirmations }] }],
  };
  const command = new Deno.Command("deno", {
    args: ["task", "start"],
    cwd: new URL("../..", import.meta.url),
    env: { CONFIG: JSON.stringify(config), TEST_CONFIG: JSON.stringify(testConfig) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const app = command.spawn();
  try {
    await retry(async () => {
      const response = await fetch(`http://localhost:${port}/health`);
      assert(response.ok, `/health returned ${response.status}`);
      const { workers } = await response.json();
      assert(
        workers.length > 0 &&
          workers.every((w: { runningSince: string | null }) => w.runningSince !== null),
        "worker(s) not running yet",
      );
    }, { minTimeout: 10, maxTimeout: 10, multiplier: 1, maxAttempts: 1500 });
  } catch (error) {
    await stopApp(app);
    throw error;
  }
  return app;
}

export async function stopApp(app: Deno.ChildProcess) {
  app.kill("SIGTERM");
  await app.status;
}

// deno-lint-ignore no-explicit-any
export async function waitForSequenceState(id: string): Promise<any> {
  return await retry(async () => {
    const response = await fetch(`http://localhost:${port}/sequences-states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequences: [{ id }] }),
    });
    assert(response.ok, `/sequences-states returned ${response.status}`);
    const { sequences: [state] } = await response.json();
    assert(state.pending === 0, "sequence still has pending bursts");
    return state;
  }, { minTimeout: 50, maxTimeout: 50, multiplier: 1, maxAttempts: 300 });
}

export async function assertSequenceState(id: string, successes: number, failures: number) {
  const state = await waitForSequenceState(id);
  assertEquals(state.successes, successes);
  assertEquals(state.failures, failures);
}
