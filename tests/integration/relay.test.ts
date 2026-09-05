import {
  assertSequenceFinalState,
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

    await assertSequenceFinalState(successId, { successes: 1, failures: 0 });
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

    await assertSequenceFinalState(revertingId, { successes: 0, failures: 1 });
    await assertLogs([]);
  },
});
