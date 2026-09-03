import { assertSequenceState, confirmations, startApp, stopApp } from "./app.ts";
import { anvilClient, etchSingletonFactory, resetToGenesis, waitForTxpoolCounts } from "./anvil.ts";
import { assertCounterCount, deployCounter, sendCounterSequences } from "./counter.ts";
import { resetDb } from "./db.ts";

let checkpointId: `0x${string}`;
let app: Deno.ChildProcess;

async function mineConfirmations() {
  await anvilClient.mine({ blocks: confirmations });
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

  await deployCounter();

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
    const [revertingId] = await sendCounterSequences([0]);
    await assertSequenceState(revertingId, 0, 1);

    const [successId] = await sendCounterSequences([5]);
    await mineNextTx();
    await assertSequenceState(successId, 1, 0);

    await assertCounterCount(5n);
  },
});
