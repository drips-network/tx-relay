import { assertSequenceState, confirmations, sendSequences, startApp, stopApp } from "./app.ts";
import {
  anvilClient,
  etchSingletonFactory,
  resetToGenesis,
  setBlockGasLimit,
  waitForTxpoolCounts,
} from "./anvil.ts";
import { addLog, assertLogs, deployCallsLog, setGasPenalty, setReverts } from "./calls-log.ts";
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
    // Only the 1st burst's transaction is pending - the 2nd (and, behind it, the 3rd) was
    // skipped, not rejected outright, so all 3 bursts are still pending at this point.
    await waitForTxpoolCounts(1);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 3 });
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
    // Only the setup sequence's transaction is pending - the trigger sequence was skipped, not
    // rejected outright, so it's still pending too at this point.
    await waitForTxpoolCounts(1);
    await assertSequenceState(setupId, { successes: 0, failures: 0, pending: 1 });
    await assertSequenceState(triggerId, { successes: 0, failures: 0, pending: 1 });
    await mineNextTx();

    await assertSequenceState(setupId, { successes: 1, failures: 0 });
    await assertSequenceState(triggerId, { successes: 0, failures: 1 });
    await assertLogs([]);
  },
});

Deno.test({
  name: "send-sequences: a burst burns 1.1M gas",
  timeout: 30_000,
  async fn() {
    // The block gas limit is 1M (see `setBlockGasLimit` in `beforeAll`), so this can never fit
    // in any block - it should be rejected outright, without ever being submitted on-chain.
    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [{ calls: [setGasPenalty("heavy", 1_100_000n), addLog("heavy")] }],
      }],
    };
    const [sequenceId] = await sendSequences(arg);

    await assertSequenceState(sequenceId, { successes: 0, failures: 1 });
    await assertLogs([]);
  },
});

Deno.test({
  name: "send-sequences: burst 1 burns 600K gas, burst 2 500K gas",
  timeout: 30_000,
  async fn() {
    // Each burst fits in a block alone, but not together, so the 2nd doesn't fit in the same
    // batch as the 1st - it's left pending (not failed) and only succeeds once retried once the
    // 1st is mined and out of the way.
    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [
          { calls: [setGasPenalty("a", 600_000n), addLog("a")] },
          { calls: [setGasPenalty("b", 500_000n), addLog("b")] },
        ],
      }],
    };
    const [sequenceId] = await sendSequences(arg);
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0, pending: 1 });
    await mineNextTx();

    await assertSequenceState(sequenceId, { successes: 2, failures: 0 });
    await assertLogs(["a", "b"]);
  },
});

Deno.test({
  name: "send-sequences: burst 1 burns 0 gas, burst 2 1.1M gas",
  timeout: 30_000,
  async fn() {
    // Burst 1 doesn't fit alongside burst 2 either, so it's initially left pending too, just
    // like the 600K/500K case. But once burst 1 is mined, burst 2 becomes the earliest pending
    // burst of its own sequence, and - since it alone already exceeds the 1M block gas limit -
    // it's rejected outright rather than merely skipped again.
    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [
          { calls: [addLog("a")] },
          { calls: [setGasPenalty("heavy", 1_100_000n), addLog("heavy")] },
        ],
      }],
    };
    const [sequenceId] = await sendSequences(arg);
    // Only burst 1's transaction is pending - burst 2 was skipped, not rejected outright, so the
    // sequence still has both bursts pending at this point.
    await waitForTxpoolCounts(1);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 2 });
    await mineNextTx();

    await assertSequenceState(sequenceId, { successes: 1, failures: 1 });
    await assertLogs(["a"]);
  },
});

Deno.test({
  name: "send-sequences: sequence 1 burns 600K gas, sequence 2 500K gas",
  timeout: 30_000,
  async fn() {
    // Same as bursts within one sequence not fitting together, but across two independent
    // sequences instead - the 2nd is left pending until the 1st is mined and out of the way.
    const arg: SendSequencesArg = {
      sequences: [
        { chainId, bursts: [{ calls: [setGasPenalty("a", 600_000n), addLog("a")] }] },
        { chainId, bursts: [{ calls: [setGasPenalty("b", 500_000n), addLog("b")] }] },
      ],
    };
    const [seq1Id, seq2Id] = await sendSequences(arg);
    await mineNextTx();
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 });
    await assertSequenceState(seq2Id, { successes: 0, failures: 0, pending: 1 });
    await mineNextTx();
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 });
    await assertSequenceState(seq2Id, { successes: 1, failures: 0 });
    await assertLogs(["a", "b"]);
  },
});

Deno.test({
  name: "send-sequences: sequence 1 burns 600K gas, sequence 2 0 gas then 500K gas",
  timeout: 30_000,
  async fn() {
    // Sequence 2's 1st burst (0 gas) is cheap enough to fit alongside sequence 1's in the same
    // batch and mines together with it, but its 2nd burst (500K) doesn't fit alongside sequence
    // 1's - it's left pending until sequence 1's burst is mined and out of the way.
    const arg: SendSequencesArg = {
      sequences: [
        { chainId, bursts: [{ calls: [setGasPenalty("a", 600_000n), addLog("a")] }] },
        {
          chainId,
          bursts: [
            { calls: [addLog("b")] },
            { calls: [setGasPenalty("c", 500_000n), addLog("c")] },
          ],
        },
      ],
    };
    const [seq1Id, seq2Id] = await sendSequences(arg);
    await mineNextTx();
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 });
    await assertSequenceState(seq2Id, { successes: 1, failures: 0, pending: 1 });
    await mineNextTx();

    await assertSequenceState(seq1Id, { successes: 1, failures: 0 });
    await assertSequenceState(seq2Id, { successes: 2, failures: 0 });
    await assertLogs(["a", "b", "c"]);
  },
});
