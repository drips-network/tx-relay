import {
  assertSequenceState,
  confirmations,
  sendSequences,
  startApp,
  stopApp,
} from "./app.ts";
import {
  anvilClient,
  etchSingletonFactory,
  resetToGenesis,
  setBlockGasLimit,
  waitForTxpoolCounts,
} from "./anvil.ts";
import { addLog, assertLogs, deployCallsLog, setReverts } from "./calls-log.ts";
import { resetDb } from "./db.ts";
import { type SendSequencesArg } from "../../src/app.ts";

const chainId = anvilClient.chain.id;

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
  await setBlockGasLimit(1_000_000n);
  await etchSingletonFactory();

  await deployCallsLog();

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
  // Every test starts from the checkpoint taken right after CallsLog was deployed, so the
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
  name: "send-sequences: executes a successful call",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [successId] = await sendSequences(arg);
    await mineNextTx();

    await assertSequenceState(successId, { successes: 1, failures: 0 });
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: rejects a reverting call",
  timeout: 30_000,
  async fn() {
    // `setReverts` and `addLog` are in the same burst, so they execute together in a single
    // atomic transaction - there's no window where `addLog` could run against stale state.
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [setReverts("bad"), addLog("bad")] }] }],
    };
    const [revertingId] = await sendSequences(arg);

    await assertSequenceState(revertingId, { successes: 0, failures: 1 });
    await assertLogs([]);
  },
});

Deno.test({
  name: "send-sequences: a failing burst skips the rest until it's reached, then fails them too",
  timeout: 30_000,
  async fn() {
    // The 2nd burst fails alongside the 1st being accepted into the same batch, so it's left
    // pending (skipped) rather than rejected outright - the 3rd is never even considered, since
    // a sequence's bursts only run in order.
    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [
          { calls: [addLog("a")] },
          { calls: [setReverts("bad"), addLog("bad")] },
          { calls: [addLog("c")] },
        ],
      }],
    };
    const [sequenceId] = await sendSequences(arg);
    await mineNextTx();

    // Once the 1st burst is mined, the 2nd is retried as the sole item in a fresh batch, so this
    // time it's rejected outright - which fails the rest of the sequence (the 3rd) without ever
    // attempting it.
    await assertSequenceState(sequenceId, { successes: 1, failures: 2 });
    await assertLogs(["a"]);
  },
});

Deno.test({
  name: "send-sequences: a failing 1st burst fails only its own sequence, immediately and fully",
  timeout: 30_000,
  async fn() {
    // Unlike a later burst in an already-running sequence, a 1st burst always rejects outright
    // on failure, regardless of what else is in the same batch - so the 2nd sequence here fails
    // immediately, without affecting the 1st.
    const arg: SendSequencesArg = {
      sequences: [
        { chainId, bursts: [{ calls: [addLog("ok")] }] },
        { chainId, bursts: [{ calls: [setReverts("bad"), addLog("bad")] }] },
      ],
    };
    const [successId, revertingId] = await sendSequences(arg);
    await assertSequenceState(revertingId, { successes: 0, failures: 1 });
    await mineNextTx();

    await assertSequenceState(successId, { successes: 1, failures: 0 });
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: a 2nd sequence triggering a revert set up by the 1st is skipped, " +
    "then fails once the 1st is mined",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [
        { chainId, bursts: [{ calls: [setReverts("bad")] }] },
        { chainId, bursts: [{ calls: [addLog("bad")] }] },
      ],
    };
    const [setupId, triggerId] = await sendSequences(arg);
    await mineNextTx();

    await assertSequenceState(setupId, { successes: 1, failures: 0 });
    await assertSequenceState(triggerId, { successes: 0, failures: 1 });
    await assertLogs([]);
  },
});
