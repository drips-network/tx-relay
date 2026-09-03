import { delay } from "async";
import { assertEquals } from "@std/assert";
import { type Address } from "viem";
import { foundry } from "viem/chains";
import { abi as counterAbi } from "./counter.generated.ts";
import { confirmations, sendSequence, startApp, stopApp, waitForSequenceState } from "./app.ts";
import {
  addCalldata,
  anvilClient,
  deployCounter,
  etchSingletonFactory,
  resetToGenesis,
} from "./anvil.ts";
import { resetDb } from "./db.ts";

let counterAddress: Address;
let checkpointId: `0x${string}`;
let app: Deno.ChildProcess;

async function mineConfirmations() {
  await anvilClient.mine({ blocks: confirmations });
}

// Polls the mempool until it holds exactly `pending` pending and `queued` queued transactions.
// Throws immediately if either count overshoots its target, since that means something
// unexpected is happening rather than the target state simply not being reached yet.
async function waitForTxpoolCounts(pending: number, queued = 0) {
  while (true) {
    const status = await anvilClient.getTxpoolStatus();
    if (status.pending === pending && status.queued === queued) return;
    if (status.pending > pending || status.queued > queued) {
      throw new Error(
        `Expected ${pending} pending and ${queued} queued transactions, got ` +
          `${status.pending} pending and ${status.queued} queued`,
      );
    }
    await delay(10);
  }
}

// Requires automine to be off. Waits for exactly one pending transaction and none queued, then
// mines it plus the confirmation blocks it needs.
// Mining is unaffected by automine being off - it still packs in whatever is pending.
async function mineNextTx() {
  await waitForTxpoolCounts(1);
  await anvilClient.mine({ blocks: 1 });
  await mineConfirmations();
}

Deno.test.beforeAll(async () => {
  await resetToGenesis();
  await etchSingletonFactory();

  counterAddress = await deployCounter();

  // Disabled for the whole suite so every transaction has to be mined explicitly (see
  // `mineNextTx`), rather than relying on Anvil's automine to include it as soon as it's sent.
  await anvilClient.setAutomine(false);
});

Deno.test.beforeEach(async () => {
  await resetDb();
  if (checkpointId) await anvilClient.revert({ id: checkpointId });
  checkpointId = await anvilClient.snapshot();

  // The app also carries its own in-memory state (e.g. transactions it believes are still
  // in-flight), which no individual test can be trusted to leave clean, so it's restarted
  // fresh here rather than relying on each test to manage its own lifecycle correctly.
  app = await startApp();
  // Every test starts from the checkpoint taken right after the Counter was deployed, so the
  // Executor is never deployed yet and this app instance always has to (re)deploy it here,
  // which needs confirming before the relay can make any further progress.
  await mineNextTx();
});

Deno.test.afterEach(async () => {
  await stopApp(app);
});

Deno.test.afterAll(async () => {
  // Automine is a node-level setting, not chain state, so `evm_revert`/`anvil_reset` never
  // restore it - it must always be re-enabled explicitly, or it leaks into whatever runs next
  // against this Anvil instance.
  await anvilClient.setAutomine(true);
  await resetToGenesis();
});

Deno.test({
  name: "smoke: app starts up and its worker connects to the chain",
  timeout: 30_000,
  // `beforeEach` already asserts this by successfully starting the app - nothing further to do.
  fn() {},
});

Deno.test({
  name: "send-sequences: executes a successful call and rejects a reverting one",
  timeout: 30_000,
  async fn() {
    // A sequence whose only burst reverts is rejected outright, without ever being submitted
    // on-chain, so it must be awaited in isolation before any other sequence is sent - once
    // something else is accepted into the same batch, a later revert is just left pending for
    // a retry instead of being rejected.
    const revertingId = await sendSequence(foundry.id, counterAddress, addCalldata(0));
    const revertingState = await waitForSequenceState(revertingId);
    assertEquals(revertingState.successes, 0);
    assertEquals(revertingState.failures, 1);

    const successId = await sendSequence(foundry.id, counterAddress, addCalldata(5));
    await mineNextTx();
    const successState = await waitForSequenceState(successId);
    assertEquals(successState.successes, 1);
    assertEquals(successState.failures, 0);

    const count = await anvilClient.readContract({
      address: counterAddress,
      abi: counterAbi,
      functionName: "count",
    });
    assertEquals(count, 5n);
  },
});
