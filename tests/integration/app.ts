import { delay, retry } from "async";
import { assert } from "@std/assert";
import { Hex } from "viem";
import { foundry } from "viem/chains";
import {
  healthSchema,
  type SendSequencesArg,
  sendSequencesSchema,
  type SequencesStatesArg,
  sequencesStatesSchema,
} from "../../src/app.ts";

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
      const { workers } = healthSchema.parse(await response.json());
      assert(
        workers.length > 0 && workers.every((w) => w.runningSince !== null),
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

export async function sendSequences(arg: SendSequencesArg): Promise<string[]> {
  const response = await fetch(`http://localhost:${port}/send-sequences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(arg),
  });
  assert(response.ok, `/send-sequences returned ${response.status}`);
  const { sequences } = sendSequencesSchema.parse(await response.json());
  return sequences.map(({ id }) => id);
}

// Polls a sequence's state until it holds exactly the expected successes, failures and pending
// counts. Throws immediately if successes or failures overshoot, or pending undershoots, since
// that means the sequence resolved differently than expected rather than just not being there
// yet.
export async function assertSequenceState(
  id: string,
  expectedState: { successes: number; failures: number; pending?: number },
) {
  const { successes, failures, pending = 0 } = expectedState;
  while (true) {
    const arg: SequencesStatesArg = { sequences: [{ id }] };
    const response = await fetch(`http://localhost:${port}/sequences-states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(arg),
    });
    assert(response.ok, `/sequences-states returned ${response.status}`);
    const { sequences: [state] } = sequencesStatesSchema.parse(await response.json());
    if (state.successes === successes && state.failures === failures && state.pending === pending) {
      return;
    }
    if (state.successes > successes || state.failures > failures || state.pending < pending) {
      throw new Error(
        `Expected ${successes} successes, ${failures} failures and ${pending} pending, got ` +
          `${state.successes} successes, ${state.failures} failures and ${state.pending} pending`,
      );
    }
    await delay(50);
  }
}
