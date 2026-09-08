import { delay, retry } from "async";
import { assert, assertEquals } from "@std/assert";
import { Hex } from "viem";
import { foundry } from "viem/chains";
import {
  healthSchema,
  type SendSequencesArg,
  sendSequencesSchema,
  type SequencesStatesArg,
  sequencesStatesSchema,
} from "../../src/app.ts";
import { type SequenceEvent } from "../../src/db/schema.ts";

// Anvil's default account #0, pre-funded with test ETH. This is the wallet the app's own
// worker uses to send transactions - tests must never use it for their own on-chain setup
// (e.g. deploying fixtures), since that would consume nonces the worker doesn't know about
// and desync its nonce tracking. Use `anvil.ts`'s `maintenanceClient` for that instead.
export const workerPrivateKey: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Anvil's default account #2, pre-funded with test ETH. Used in place of `workerPrivateKey` by
// tests simulating the app restarting with a different wallet for the same chain.
export const otherWorkerPrivateKey: Hex =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

export const port = 8000;

// Passed explicitly into the worker's chain config below, rather than relying on the app's own
// default, so callers needing to mine confirming blocks (e.g. `relay.test.ts`) have one shared,
// explicit source of truth for how many are required instead of an assumed/hardcoded number.
export const confirmations = 1;

// Same as `confirmations` above, but for how many blocks the worker waits for a transaction to
// even land in the mempool before giving up on it as stale.
export const inclusionWaitBlocks = 2;

// Same as `confirmations` above, but for how much a repriced retry's fee must exceed the previous
// attempt's.
export const minGasIncreasePercent = 10;

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

export async function startApp(privateKey: Hex = workerPrivateKey): Promise<Deno.ChildProcess> {
  const config = {
    wallets: [{
      privateKey,
      chains: [{ chainId: foundry.id, confirmations, inclusionWaitBlocks, minGasIncreasePercent }],
    }],
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
//
// If `events` is given, it's checked once that final state is reached: their timestamps must be
// non-decreasing (ties are allowed - events inserted together in the same DB transaction all
// share Postgres' `now()` for that transaction), and their kinds and details must exactly match
// `events`, in order.
export async function assertSequenceState(
  id: string,
  expectedState: { successes: number; failures: number; pending?: number },
  events?: SequenceEvent[],
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
      if (events) assertEvents(state.events, events);
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

function assertEvents(
  events: (SequenceEvent & { timestamp: Date })[],
  expected: SequenceEvent[],
) {
  for (let i = 1; i < events.length; i++) {
    assert(
      events[i].timestamp.getTime() >= events[i - 1].timestamp.getTime(),
      `Expected event timestamps to be non-decreasing, but event ${i} (${events[i].kind}) at ` +
        `${events[i].timestamp.toISOString()} precedes event ${i - 1} (${events[i - 1].kind}) at ` +
        `${events[i - 1].timestamp.toISOString()}`,
    );
  }
  assertEquals(events.map(({ timestamp: _timestamp, ...event }) => event), expected);
}
