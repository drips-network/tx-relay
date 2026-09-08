import { assert, assertEquals } from "@std/assert";
import { deadline, delay } from "async";
import { createWalletClient, http, parseEther, publicActions, type Transaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertSequenceState,
  confirmations,
  inclusionWaitBlocks,
  minGasIncreasePercent,
  otherWorkerPrivateKey,
  sendSequences,
  startApp,
  stopApp,
  workerPrivateKey,
} from "./app.ts";
import {
  anvilClient,
  baseTxCost,
  dropPendingTxs,
  etchSingletonFactory,
  getTxpoolTxs,
  mineEmptyBlocks,
  resetToGenesis,
  resubmitTx,
  setBlockGasLimit,
  waitForNewTxpoolTx,
  waitForTxpoolCounts,
} from "./anvil.ts";
import { addLog, assertLogs, deployCallsLog, setGasPenalty, setReverts } from "./calls-log.ts";
import { resetDb } from "./db.ts";
import { type SendSequencesArg } from "../../src/app.ts";
import { type SequenceEvent } from "../../src/db/schema.ts";

const chainId = anvilClient.chain.id;

let checkpointId: `0x${string}`;
let app: Deno.ChildProcess;

// Requires automine to be off. Waits for exactly one pending transaction and none queued, then
// mines it plus its confirmation blocks, returning the block it landed in.
// Mining is unaffected by automine being off - it still packs in whatever is pending.
//
// Mined in two steps with a real pause in between, rather than one fixed-size batch: the worker's
// own check for whether something else has taken its nonce (see `watchTxs`) can rarely race its
// receipt check at this mining speed (never at real block times), taking a detour that needs
// `confirmations` more blocks than usual. That detour computes its wait target from the chain
// height at the moment it's taken, so a single, larger mine call can't pre-empt it - the target
// just becomes that much higher, always one `confirmations` step past whatever was last mined.
// Splitting into two calls lets that target, if taken, settle against the first call's height
// before the second one covers it.
async function mineNextTx(): Promise<bigint> {
  await waitForTxpoolCounts(1);
  const [{ hash }] = await getTxpoolTxs();
  await anvilClient.mine({ blocks: 1 + confirmations });
  await delay(20);
  await anvilClient.mine({ blocks: confirmations });
  return (await anvilClient.getTransactionReceipt({ hash })).blockNumber;
}

// Asserts that `secondTx` is a valid repriced replacement of `firstTx` - both EIP-1559, with both
// fee fields increased by at least `minGasIncreasePercent`, but never by more than 1.5x the
// current network fee estimate (see `increasedFees` in worker.ts, which refuses to reprice past
// that cap at all).
//
// The current estimate is fetched via `prepareTransactionRequest`, the same call the worker
// itself uses, rather than the lower-level `estimateFeesPerGas` - the latter's own fee padding
// isn't necessarily what the worker's client actually applies, and comparing against it directly
// proved unreliable.
async function assertRepriced(firstTx: Transaction, secondTx: Transaction) {
  assert(
    firstTx.type === "eip1559" && secondTx.type === "eip1559",
    "Expected both TXs to be EIP-1559",
  );
  const minIncrease = (fee: bigint) => fee * BigInt(100 + minGasIncreasePercent) / 100n;
  const maxCap = (fee: bigint) => fee * 150n / 100n;
  const { maxFeePerGas: currentFee, maxPriorityFeePerGas: currentPriorityFee } = await anvilClient
    .prepareTransactionRequest({ account: anvilClient.account, to: anvilClient.account.address });

  assert(
    secondTx.maxFeePerGas >= minIncrease(firstTx.maxFeePerGas),
    `Expected maxFeePerGas to increase by at least ${minGasIncreasePercent}%, went from ` +
      `${firstTx.maxFeePerGas} to ${secondTx.maxFeePerGas}`,
  );
  assert(
    secondTx.maxFeePerGas <= maxCap(currentFee),
    `Expected maxFeePerGas to not exceed 1.5x the current fee estimate (${currentFee}), got ` +
      `${secondTx.maxFeePerGas}`,
  );
  assert(
    secondTx.maxPriorityFeePerGas >= minIncrease(firstTx.maxPriorityFeePerGas),
    `Expected maxPriorityFeePerGas to increase by at least ${minGasIncreasePercent}%, went from ` +
      `${firstTx.maxPriorityFeePerGas} to ${secondTx.maxPriorityFeePerGas}`,
  );
  assert(
    secondTx.maxPriorityFeePerGas <= maxCap(currentPriorityFee),
    `Expected maxPriorityFeePerGas to not exceed 1.5x the current fee estimate ` +
      `(${currentPriorityFee}), got ${secondTx.maxPriorityFeePerGas}`,
  );
}

Deno.test.beforeAll(async () => {
  // Disabled for the whole suite so every transaction has to be mined explicitly (see
  // `mineNextTx`), rather than relying on Anvil's automine to include it as soon as it's sent.
  await anvilClient.setAutomine(false);
  await resetToGenesis();
  await setBlockGasLimit();
  await etchSingletonFactory();
  await deployCallsLog();
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

    await assertSequenceState(successId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
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

    await assertSequenceState(revertingId, { successes: 0, failures: 1 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "rejected", details: { fromIdxInSequence: 0 } },
    ]);
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
    await assertSequenceState(sequenceId, { successes: 1, failures: 2 }, [
      { kind: "created", details: { burstsCount: 3 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
      { kind: "rejected", details: { fromIdxInSequence: 1 } },
    ]);
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
    await assertSequenceState(revertingId, { successes: 0, failures: 1 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "rejected", details: { fromIdxInSequence: 0 } },
    ]);
    await mineNextTx();

    await assertSequenceState(successId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
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

    await assertSequenceState(setupId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertSequenceState(triggerId, { successes: 0, failures: 1 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "rejected", details: { fromIdxInSequence: 0 } },
    ]);
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

    await assertSequenceState(sequenceId, { successes: 0, failures: 1 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "rejected", details: { fromIdxInSequence: 0 } },
    ]);
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

    await assertSequenceState(sequenceId, { successes: 2, failures: 0 }, [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
      { kind: "submitted", details: { fromIdxInSequence: 1, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 1, successes: 1, failed: false } },
    ]);
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

    await assertSequenceState(sequenceId, { successes: 1, failures: 1 }, [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
      { kind: "rejected", details: { fromIdxInSequence: 1 } },
    ]);
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
    const expectedSingleBurstEvents: SequenceEvent[] = [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ];
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 }, expectedSingleBurstEvents);
    await assertSequenceState(seq2Id, { successes: 1, failures: 0 }, expectedSingleBurstEvents);
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

    await assertSequenceState(seq1Id, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertSequenceState(seq2Id, { successes: 2, failures: 0 }, [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
      { kind: "submitted", details: { fromIdxInSequence: 1, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 1, successes: 1, failed: false } },
    ]);
    await assertLogs(["a", "b", "c"]);
  },
});

Deno.test({
  name: "send-sequences: a call's gas limit is enforced",
  timeout: 30_000,
  async fn() {
    // Both calls burn close to a 200K gas limit, but only the 2nd exceeds it - proving the
    // limit is actually enforced on-chain, not just advisory.
    const arg: SendSequencesArg = {
      sequences: [
        {
          chainId,
          bursts: [{ calls: [setGasPenalty("under", 100_000n), addLog("under", 200_000)] }],
        },
        {
          chainId,
          bursts: [{ calls: [setGasPenalty("over", 201_000n), addLog("over", 200_000)] }],
        },
      ],
    };
    const [underId, overId] = await sendSequences(arg);
    await assertSequenceState(overId, { successes: 0, failures: 1 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "rejected", details: { fromIdxInSequence: 0 } },
    ]);
    await mineNextTx();

    await assertSequenceState(underId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["under"]);
  },
});

Deno.test({
  name: "send-sequences: gasBufferPercent inflates the transaction's gas limit",
  timeout: 30_000,
  async fn() {
    // 50% on top of the ~500K actually needed should give a transaction gas limit of at least
    // 750K, not just however much the burst actually used.
    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [{
          gasBufferPercent: 50,
          calls: [setGasPenalty("buffered", 500_000n), addLog("buffered")],
        }],
      }],
    };
    const [sequenceId] = await sendSequences(arg);
    const blockNumber = await mineNextTx();

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["buffered"]);

    const block = await anvilClient.getBlock({ blockNumber, includeTransactions: true });
    assertEquals(block.transactions.length, 1);
    assert(
      block.transactions[0].gas >= 750_000n,
      `Expected a gas limit of at least 750000, got ${block.transactions[0].gas}`,
    );
  },
});

Deno.test({
  name: "send-sequences: a sequence's transaction is picked up again after the app restarts",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    await stopApp(app);
    app = await startApp();

    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: after a restart with a different wallet, " +
    "a stale TX is skipped and resent from the new wallet",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    await stopApp(app);

    // Dropped instead of just left unmined, since mining always packs in whatever's pending
    // regardless of automine - it would otherwise get mined as soon as the next blocks are.
    await dropPendingTxs();

    app = await startApp(otherWorkerPrivateKey);
    // `startApp` only waits for `/health` to report the worker as running, not for it to have
    // reached the point of recording the block number it'll wait `inclusionWaitBlocks` from -
    // mining immediately risks the worker capturing a later block than intended, undercounting
    // how many blocks are actually left to mine below.
    await delay(100);

    // The old wallet's TX is never mined, so once the new wallet has waited `inclusionWaitBlocks`
    // for it to land, it gives up - the sequence's burst is left pending, to be sent again.
    await anvilClient.mine({ blocks: inclusionWaitBlocks });
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    const blockNumber = await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);

    const block = await anvilClient.getBlock({ blockNumber, includeTransactions: true });
    assertEquals(block.transactions.length, 1);
    assertEquals(
      block.transactions[0].from.toLowerCase(),
      privateKeyToAccount(otherWorkerPrivateKey).address.toLowerCase(),
    );
  },
});

Deno.test({
  name: "send-sequences: a dropped TX is repriced, then the original is restored and mined",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    // Captured in full (including its signature) before being dropped, so it can be resubmitted
    // verbatim later - proving the worker still recognizes success via an earlier attempt, not
    // just its latest one.
    const [{ hash: firstTxHash }] = await getTxpoolTxs();
    const firstTx = await anvilClient.getTransaction({ hash: firstTxHash });
    await dropPendingTxs();

    // The worker gives up waiting on the dropped TX after `inclusionWaitBlocks` and sends a
    // repriced retry at the same nonce.
    await anvilClient.mine({ blocks: inclusionWaitBlocks });
    await waitForTxpoolCounts(1);
    await dropPendingTxs();

    // The original TX is restored - despite the repriced retry being the worker's latest
    // attempt, this earlier one lands and mines instead.
    await resubmitTx(firstTx);
    await mineNextTx();

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: a TX priced out by rising fees is repriced and mined",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    const [{ hash: firstTxHash }] = await getTxpoolTxs();
    const firstTx = await anvilClient.getTransaction({ hash: firstTxHash });

    // The TX is left genuinely pending the whole time, the same as if real fees had simply risen
    // past what it offered - unlike dropping it outright.
    await mineEmptyBlocks(inclusionWaitBlocks);

    // The worker gives up waiting on the original TX after `inclusionWaitBlocks` and sends a
    // repriced retry at the same nonce - Anvil drops the original from the pool on its own once a
    // valid, pricier replacement for the same nonce arrives, so the pool holds only the new one.
    const secondTxHash = await waitForNewTxpoolTx(firstTxHash);
    const secondTx = await anvilClient.getTransaction({ hash: secondTxHash });
    await assertRepriced(firstTx, secondTx);

    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: repriced retries cap out at 1.5x, then the burst is skipped and resent",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    let [{ hash: txHash }] = await getTxpoolTxs();
    let tx = await anvilClient.getTransaction({ hash: txHash });

    // Each repriced retry - whether resending the burst's own TX or, once that's been tried 3
    // times, burning the nonce instead (see `sendTxAttempt`/`burnNonce`) - bumps the fee by at
    // least `minGasIncreasePercent` over the last one actually sent. Compounded, that soon demands
    // more than 1.5x the network's current fee estimate, which the worker refuses to pay - at that
    // point it stops sending anything further, leaving the last attempt sitting pending.
    let repriceCount = 0;
    while (true) {
      await mineEmptyBlocks(inclusionWaitBlocks);
      const newTxHash = await deadline(waitForNewTxpoolTx(txHash), 500)
        .catch((error) => {
          if (error instanceof DOMException && error.name === "TimeoutError") return undefined;
          throw error;
        });
      if (!newTxHash) break;
      const newTx = await anvilClient.getTransaction({ hash: newTxHash });
      await assertRepriced(tx, newTx);
      tx = newTx;
      txHash = newTxHash;
      repriceCount++;
    }
    assert(
      repriceCount >= 2,
      `Expected at least 2 repriced retries before capping, got ${repriceCount}`,
    );

    // The last (capped) attempt still gets mined normally, skipping the burst instead of failing
    // it - then it's resent fresh, with a reset fee estimate, at the next nonce and succeeds.
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: reviving an older reprice makes the next one match it, not the newest",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    const [{ hash: firstTxHash }] = await getTxpoolTxs();
    const firstTx = await anvilClient.getTransaction({ hash: firstTxHash });

    // 1st reprice: the original TX is priced out, so the app sends a repriced replacement -
    // captured in full so it can be restored later, the same as in the single-reprice case.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const secondTxHash = await waitForNewTxpoolTx(firstTxHash);
    const secondTx = await anvilClient.getTransaction({ hash: secondTxHash });
    await assertRepriced(firstTx, secondTx);

    // 2nd reprice: the 1st reprice is ALSO priced out, so the app sends another, pricier one.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const thirdTxHash = await waitForNewTxpoolTx(secondTxHash);
    const thirdTx = await anvilClient.getTransaction({ hash: thirdTxHash });
    await assertRepriced(secondTx, thirdTx);

    // The 2nd reprice is dropped, and the 1st reprice - captured above, before Anvil's own
    // replace-by-fee handling evicted it in favor of the 2nd - is restored in its place.
    await dropPendingTxs();
    await resubmitTx(secondTx);
    await waitForTxpoolCounts(1);

    // The app still believes its latest attempt was the (now-gone) 2nd reprice, but since that's
    // no longer found on-chain, `increasedFees` falls back to the next hash it still recognizes -
    // the 1st reprice, now visibly pending again - and reprices relative to THAT, not the 2nd. By
    // now the burst's own TX has already been retried 3 times (the original plus the 1st and 2nd
    // reprices), so this 3rd reprice is the nonce-burning attempt (see
    // `sendTxAttempt`/`burnNonce`) - which reprices exactly the same way, so the same invariant
    // still applies.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const fourthTxHash = await waitForNewTxpoolTx(secondTxHash);
    const fourthTx = await anvilClient.getTransaction({ hash: fourthTxHash });
    await assertRepriced(secondTx, fourthTx);
    // Asserting fourthTx's exact fee (rather than just that it's NOT a bump over the 2nd) would be
    // fragile - the network's fee estimate can drift block to block, even on Anvil, so the 1st
    // reprice's own bump isn't guaranteed to reproduce bit-for-bit.
    const minIncrease = (fee: bigint) => fee * BigInt(100 + minGasIncreasePercent) / 100n;
    assert(
      fourthTx.maxFeePerGas! < minIncrease(thirdTx.maxFeePerGas!) ||
        fourthTx.maxPriorityFeePerGas! < minIncrease(thirdTx.maxPriorityFeePerGas!),
      "Expected the 3rd reprice to NOT be a bump over the 2nd - got " +
        `${fourthTx.maxFeePerGas}/${fourthTx.maxPriorityFeePerGas}, which is already a ` +
        `${minGasIncreasePercent}% bump over the 2nd's ` +
        `${thirdTx.maxFeePerGas}/${thirdTx.maxPriorityFeePerGas}`,
    );

    // The burn TX still gets mined normally, skipping the burst instead of failing it - then it's
    // resent fresh, with a reset fee estimate, at the next nonce and succeeds.
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: a nonce bumped directly (not via a real TX) also makes the app skip " +
    "and resend",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    const [{ hash: firstTxHash }] = await getTxpoolTxs();
    const { nonce } = await anvilClient.getTransaction({ hash: firstTxHash });
    await dropPendingTxs();

    // Bumps the worker's nonce directly, via Anvil's own test API, rather than through any real
    // TX - the app only ever observes the nonce being ahead of what it expects, regardless of
    // whether that's from a competing TX or anything else.
    const workerAddress = privateKeyToAccount(workerPrivateKey).address;
    await anvilClient.setNonce({ address: workerAddress, nonce: nonce + 1 });

    // Noticing the nonce skip, then sending, mining and confirming the resend all need further
    // confirmations that can't be pinned to an exact block - each is mined with a short pause so
    // the worker (a separate process) gets a chance to react before the next one lands, and the
    // sequence's final state is polled for below rather than any one intermediate step. One more
    // round than the dummy-TX version of this test, which gets the mining its own dummy TX needs
    // as a head start for free - there's no such TX here to mine.
    for (let i = 0; i < 6; i++) {
      await delay(20);
      await anvilClient.mine({ blocks: 1 });
    }

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: an early attempt is restored and mined after nonce burning starts",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    const [{ hash: firstTxHash }] = await getTxpoolTxs();

    // The 2nd attempt (1st reprice) - captured in full so it can be restored later, well after
    // the worker's moved on from it.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const secondTxHash = await waitForNewTxpoolTx(firstTxHash);
    const secondTx = await anvilClient.getTransaction({ hash: secondTxHash });

    // The 3rd attempt (2nd reprice) - the last of the 3 tries before the worker gives up resending
    // the burst's own TX and starts burning the nonce instead (see `sendTxAttempt`/`burnNonce`).
    await mineEmptyBlocks(inclusionWaitBlocks);
    const thirdTxHash = await waitForNewTxpoolTx(secondTxHash);

    // The nonce-burning TX - reaching this confirms the worker's given up on the burst's own TX
    // entirely.
    await mineEmptyBlocks(inclusionWaitBlocks);
    await waitForNewTxpoolTx(thirdTxHash);

    // The 2nd attempt is restored - despite the burn TX being the worker's latest by far, this
    // much earlier one lands and mines instead, still recognized as this sequence's success since
    // `watchTxs` tracks every historical attempt's hash, not just the latest.
    await dropPendingTxs();
    await resubmitTx(secondTx);
    await mineNextTx();

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: a burst reverting on-chain, after the TX was already built, " +
    "cascades to the bursts after it",
  timeout: 30_000,
  async fn() {
    // Cheap enough that all 3 fit in a single batch/TX together.
    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [
          { calls: [addLog("a")] },
          { calls: [addLog("b")] },
          { calls: [addLog("c")] },
        ],
      }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    const [{ hash: txHash }] = await getTxpoolTxs();
    const tx = await anvilClient.getTransaction({ hash: txHash });
    await dropPendingTxs();

    // Set up from the maintenance wallet, not the app's own - using the app's wallet for this
    // would consume a nonce it doesn't know about and desync its tracking. The TX above was
    // already built (and signed) before this, so the app has no way to notice ahead of time.
    const { target, calldata } = setReverts("b");
    const setRevertsHash = await anvilClient.sendTransaction({ to: target, data: calldata });
    await anvilClient.mine({ blocks: 1 });
    await anvilClient.waitForTransactionReceipt({ hash: setRevertsHash });

    // The original TX is restored and lands as originally built, all 3 bursts bundled together.
    await resubmitTx(tx);
    await mineNextTx();

    // The 2nd burst reverts on-chain; the 3rd, which needs the 2nd to have succeeded (see
    // `Executor.sol`'s `needsPrev`), is skipped and fails alongside it - even though its own call
    // would have succeeded in isolation.
    await assertSequenceState(sequenceId, { successes: 1, failures: 2 }, [
      { kind: "created", details: { burstsCount: 3 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 3 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: true } },
    ]);
    await assertLogs(["a"]);
  },
});

Deno.test({
  name: "send-sequences: insufficient funds for a heavy burst burns the nonce, " +
    "then a fresh batch succeeds once funded",
  timeout: 30_000,
  async fn() {
    const workerAddress = privateKeyToAccount(workerPrivateKey).address;
    // Enough for the nonce-burning TX below, but nowhere near enough for the heavy burst's own.
    await anvilClient.setBalance({ address: workerAddress, value: (await baseTxCost()) * 2n });

    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [{ calls: [setGasPenalty("heavy", 500_000n), addLog("heavy")] }],
      }],
    };
    const [sequenceId] = await sendSequences(arg);

    // The burst's own TX can't be afforded, so the worker waits, then burns the nonce instead -
    // affordable on its own - leaving the burst pending rather than failed.
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    // Funded enough for the burst itself, so the fresh batch built for it succeeds normally.
    await anvilClient.setBalance({ address: workerAddress, value: parseEther("1") });
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["heavy"]);
  },
});

Deno.test({
  name: "send-sequences: insufficient funds even to burn the nonce waits, " +
    "then a fresh batch succeeds once funded",
  timeout: 30_000,
  async fn() {
    const workerAddress = privateKeyToAccount(workerPrivateKey).address;
    // Not enough to afford even the nonce-burning TX, let alone the heavy burst.
    await anvilClient.setBalance({ address: workerAddress, value: (await baseTxCost()) / 2n });

    const arg: SendSequencesArg = {
      sequences: [{
        chainId,
        bursts: [{ calls: [setGasPenalty("heavy", 500_000n), addLog("heavy")] }],
      }],
    };
    const [sequenceId] = await sendSequences(arg);

    // Neither the burst's own TX nor the much cheaper nonce-burning one can be afforded, so
    // nothing ever reaches the mempool - the worker just keeps waiting for funds.
    await deadline(waitForTxpoolCounts(1), 300).catch((error) => {
      if (!(error instanceof DOMException && error.name === "TimeoutError")) throw error;
    });
    await waitForTxpoolCounts(0);

    // Funded enough for the burst itself, and so, easily, the nonce-burning TX too.
    await anvilClient.setBalance({ address: workerAddress, value: parseEther("1") });

    // The failed nonce-burning attempt is only retried after `inclusionWaitBlocks` - unlike a
    // dropped TX, nothing was ever actually sent for `waitForTxpoolCounts` to wait out, so those
    // blocks need mining directly to get the retry going at all. A short pause first gives
    // `watchTxs` a chance to grab the block number it'll wait `inclusionWaitBlocks` from, once the
    // balance check above unblocks it - mining immediately risks it capturing a later block than
    // intended, undercounting how many blocks are actually left to mine below.
    await delay(50);
    await anvilClient.mine({ blocks: inclusionWaitBlocks });

    // The nonce-burning TX goes through this time, leaving the burst pending rather than failed.
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    // The fresh batch built for it succeeds normally.
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["heavy"]);
  },
});

Deno.test({
  name: "send-sequences: a dummy TX using up the nonce makes the app skip and resend",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);
    await waitForTxpoolCounts(1);

    const [{ hash: firstTxHash }] = await getTxpoolTxs();
    const { nonce } = await anvilClient.getTransaction({ hash: firstTxHash });
    await dropPendingTxs();

    // Consumes the worker's nonce with an unrelated transaction, simulating something outside
    // the relay's control (not a repriced retry of its own) having used it up.
    const workerAccount = privateKeyToAccount(workerPrivateKey);
    const dummyClient = createWalletClient({
      account: workerAccount,
      chain: anvilClient.chain,
      transport: http(),
    }).extend(publicActions);
    await dummyClient.sendTransaction({ to: workerAccount.address, value: 0n, nonce });
    await mineNextTx();

    // Noticing the nonce skip, then sending, mining and confirming the resend all need further
    // confirmations that can't be pinned to an exact block - each is mined with a short pause so
    // the worker (a separate process) gets a chance to react before the next one lands, and the
    // sequence's final state is polled for below rather than any one intermediate step.
    for (let i = 0; i < 4; i++) {
      await delay(20);
      await anvilClient.mine({ blocks: 1 });
    }

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name:
    "send-sequences: after 3 dropped attempts, the app burns the nonce, then resends and succeeds",
  timeout: 30_000,
  async fn() {
    const arg: SendSequencesArg = {
      sequences: [{ chainId, bursts: [{ calls: [addLog("ok")] }] }],
    };
    const [sequenceId] = await sendSequences(arg);

    // The worker retries the same nonce 3 times before giving up on it - each dropped attempt is
    // resent only once `inclusionWaitBlocks` have passed without a receipt for it.
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitForTxpoolCounts(1);
      await dropPendingTxs();
      await anvilClient.mine({ blocks: inclusionWaitBlocks });
    }

    // After the 3rd dropped attempt, the worker burns the nonce instead of retrying the burst
    // again - the burn TX is let through this time, so the burst itself is left pending rather
    // than failed, ready to be resent under the next nonce.
    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    await mineNextTx();
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: {} },
      { kind: "submitted", details: { fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "executed", details: { fromIdxInSequence: 0, successes: 1, failed: false } },
    ]);
    await assertLogs(["ok"]);
  },
});
