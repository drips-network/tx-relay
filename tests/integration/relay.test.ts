import { assert, assertEquals } from "@std/assert";
import { deadline, delay } from "async";
import {
  createWalletClient,
  type Hex,
  http,
  parseEther,
  publicActions,
  type Transaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertSequenceState,
  confirmations,
  getSequenceEvents,
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
  mineNextTx,
  resetToGenesis,
  resubmitTx,
  setBlockGasLimit,
  waitForNewTxpoolTx,
  waitForTxpoolCounts,
} from "./anvil.ts";
import {
  addLog,
  assertLogs,
  deployCallsLog,
  setGasPenalty,
  setGasPenaltyDirectly,
  setReverts,
} from "./calls-log.ts";
import { resetDb } from "./db.ts";
import { type SendSequencesArg } from "../../src/app.ts";
import { type SequenceEvent } from "../../src/db-schema.ts";

const chainId = anvilClient.chain.id;

let checkpointId: `0x${string}`;
let app: Deno.ChildProcess;

// Polls until a `skipped` event appears - unlike `successes`/`failures` reaching some later
// milestone, there's no other synchronization point to wait on for the event itself.
async function waitForSkippedEvent(
  sequenceId: string,
): Promise<SequenceEvent & { kind: "skipped" }> {
  while (true) {
    const skippedEvent = (await getSequenceEvents(sequenceId)).find((event) =>
      event.kind === "skipped"
    );
    if (skippedEvent?.kind === "skipped") return skippedEvent;
    await delay(20);
  }
}

// Finds a `submitted` event's TX hash other than the given ones - e.g. for a resend whose hash
// wasn't captured directly. No polling needed: it's only called once the sequence has reached its
// final state, and a `submitted` event always commits before the `executed` event that depends on
// it, so by then it's guaranteed to already be there.
async function findSubmittedTxHash(sequenceId: string, excludeTxHashes: Hex[]): Promise<Hex> {
  const event = (await getSequenceEvents(sequenceId)).find((event) =>
    event.kind === "submitted" && !excludeTxHashes.includes(event.details.txHash)
  );
  assert(event?.kind === "submitted", "Expected a submitted event with a new TX hash");
  return event.details.txHash;
}

// Asserts `tx2` is a valid repriced replacement of `tx1`: both EIP-1559, fees increased by at
// least `minGasIncreasePercent` but capped at 1.5x the current estimate (see `increasedFees` in
// worker.ts). Fetches the estimate via `prepareTransactionRequest`, same as the worker itself -
// the lower-level `estimateFeesPerGas` applies different padding and proved unreliable here.
async function assertRepriced(tx1: Transaction, tx2: Transaction) {
  assert(
    tx1.type === "eip1559" && tx2.type === "eip1559",
    "Expected both TXs to be EIP-1559",
  );
  const minIncrease = (fee: bigint) => fee * BigInt(100 + minGasIncreasePercent) / 100n;
  const maxCap = (fee: bigint) => fee * 150n / 100n;
  const { maxFeePerGas: currentFee, maxPriorityFeePerGas: currentPriorityFee } = await anvilClient
    .prepareTransactionRequest({ account: anvilClient.account, to: anvilClient.account.address });

  assert(
    tx2.maxFeePerGas >= minIncrease(tx1.maxFeePerGas),
    `Expected maxFeePerGas to increase by at least ${minGasIncreasePercent}%, went from ` +
      `${tx1.maxFeePerGas} to ${tx2.maxFeePerGas}`,
  );
  assert(
    tx2.maxFeePerGas <= maxCap(currentFee),
    `Expected maxFeePerGas to not exceed 1.5x the current fee estimate (${currentFee}), got ` +
      `${tx2.maxFeePerGas}`,
  );
  assert(
    tx2.maxPriorityFeePerGas >= minIncrease(tx1.maxPriorityFeePerGas),
    `Expected maxPriorityFeePerGas to increase by at least ${minGasIncreasePercent}%, went from ` +
      `${tx1.maxPriorityFeePerGas} to ${tx2.maxPriorityFeePerGas}`,
  );
  assert(
    tx2.maxPriorityFeePerGas <= maxCap(currentPriorityFee),
    `Expected maxPriorityFeePerGas to not exceed 1.5x the current fee estimate ` +
      `(${currentPriorityFee}), got ${tx2.maxPriorityFeePerGas}`,
  );
}

Deno.test.beforeAll(async () => {
  // Disabled for the whole suite so every TX must be mined explicitly via `mineNextTx`, instead
  // of Anvil's automine including it as soon as it's sent.
  await anvilClient.setAutomine(false);
  await resetToGenesis();
  await setBlockGasLimit();
  await etchSingletonFactory();
  await deployCallsLog();
});

Deno.test.beforeEach(async () => {
  await resetDb();
  // `evm_revert` restores chain state but not the mempool - a TX left unmined by a previous test
  // would otherwise survive with a now-stale nonce, showing up as bogus "queued".
  await dropPendingTxs();
  if (checkpointId) await anvilClient.revert({ id: checkpointId });
  checkpointId = await anvilClient.snapshot();

  app = await startApp();
  // The checkpoint predates the Executor's deployment, so this app instance has to (re)deploy it
  // now, before the relay can make any further progress.
  await mineNextTx(confirmations);
});

Deno.test.afterEach(async () => {
  await stopApp(app);
});

Deno.test.afterAll(async () => {
  await resetDb();
  // Automine is node-level, not chain state, so it's never restored by reset/revert - it must be
  // re-enabled explicitly, or it leaks into whatever runs next against this Anvil instance.
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
    const { txHash } = await mineNextTx(confirmations);

    await assertSequenceState(successId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
    ]);
    await assertLogs(["ok"]);
  },
});

Deno.test({
  name: "send-sequences: rejects a reverting call",
  timeout: 30_000,
  async fn() {
    // Same burst as `addLog`, so both execute atomically - no window for `addLog` to run against
    // stale state.
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
    // The 2nd burst fails alongside the 1st being accepted in the same batch, so it's skipped
    // rather than rejected outright; the 3rd is never even considered since bursts run in order.
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
    await waitForTxpoolCounts(1);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 3 });
    const { txHash } = await mineNextTx(confirmations);

    // Once the 1st burst is mined, the 2nd is retried alone and rejected outright, failing the
    // 3rd along with it without ever attempting it.
    await assertSequenceState(sequenceId, { successes: 1, failures: 2 }, [
      { kind: "created", details: { burstsCount: 3 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
      { kind: "rejected", details: { fromIdxInSequence: 1 } },
    ]);
    await assertLogs(["a"]);
  },
});

Deno.test({
  name: "send-sequences: a failing 1st burst fails only its own sequence, immediately and fully",
  timeout: 30_000,
  async fn() {
    // Unlike a later burst, a 1st burst always rejects outright on failure regardless of what
    // else is batched with it - so the 2nd sequence fails immediately without affecting the 1st.
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
    const { txHash } = await mineNextTx(confirmations);

    await assertSequenceState(successId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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
    await waitForTxpoolCounts(1);
    await assertSequenceState(setupId, { successes: 0, failures: 0, pending: 1 });
    await assertSequenceState(triggerId, { successes: 0, failures: 0, pending: 1 });
    const { txHash } = await mineNextTx(confirmations);

    await assertSequenceState(setupId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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
    // Each burst fits alone but not together, so the 2nd doesn't fit in the same batch as the
    // 1st - it's left pending, succeeding only once retried after the 1st is mined.
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
    const { txHash: txHash1 } = await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0, pending: 1 });
    const { txHash: txHash2 } = await mineNextTx(confirmations);

    await assertSequenceState(sequenceId, { successes: 2, failures: 0 }, [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash1, fromIdxInSequence: 0, successes: 1, failed: false },
      },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 1, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash2, fromIdxInSequence: 1, successes: 1, failed: false },
      },
    ]);
    await assertLogs(["a", "b"]);
  },
});

Deno.test({
  name: "send-sequences: burst 1 burns 0 gas, burst 2 1.1M gas",
  timeout: 30_000,
  async fn() {
    // Burst 1 is initially left pending too, like the 600K/500K case. But once mined, burst 2
    // becomes the earliest pending burst and - exceeding the 1M gas limit alone - is rejected
    // outright rather than skipped again.
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
    await waitForTxpoolCounts(1);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 2 });
    const { txHash } = await mineNextTx(confirmations);

    await assertSequenceState(sequenceId, { successes: 1, failures: 1 }, [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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
    const { txHash: txHash1 } = await mineNextTx(confirmations);
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 });
    await assertSequenceState(seq2Id, { successes: 0, failures: 0, pending: 1 });
    const { txHash: txHash2 } = await mineNextTx(confirmations);
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash1, fromIdxInSequence: 0, successes: 1, failed: false },
      },
    ]);
    await assertSequenceState(seq2Id, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash2, fromIdxInSequence: 0, successes: 1, failed: false },
      },
    ]);
    await assertLogs(["a", "b"]);
  },
});

Deno.test({
  name: "send-sequences: sequence 1 burns 600K gas, sequence 2 0 gas then 500K gas",
  timeout: 30_000,
  async fn() {
    // Sequence 2's 1st burst (0 gas) fits alongside sequence 1's and mines with it, but its 2nd
    // burst (500K) doesn't - it's left pending until sequence 1's is mined and out of the way.
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
    const { txHash: txHash1 } = await mineNextTx(confirmations);
    await assertSequenceState(seq1Id, { successes: 1, failures: 0 });
    await assertSequenceState(seq2Id, { successes: 1, failures: 0, pending: 1 });
    const { txHash: txHash2 } = await mineNextTx(confirmations);

    await assertSequenceState(seq1Id, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash1, fromIdxInSequence: 0, successes: 1, failed: false },
      },
    ]);
    await assertSequenceState(seq2Id, { successes: 2, failures: 0 }, [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash1, fromIdxInSequence: 0, successes: 1, failed: false },
      },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 1, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash2, fromIdxInSequence: 1, successes: 1, failed: false },
      },
    ]);
    await assertLogs(["a", "b", "c"]);
  },
});

Deno.test({
  name: "send-sequences: 2 sequences with 2 same-cost bursts each interleave batches by gas budget",
  timeout: 30_000,
  async fn() {
    // Pre-sets all 4 penalties directly (pure test setup, bypassing the app) so every burst below
    // is a single `addLog` call at a predictable, equal ~500K/~300K cost, without also carrying a
    // `setGasPenalty` call's own one-off overhead.
    await setGasPenaltyDirectly("A1", 500_000n);
    await setGasPenaltyDirectly("A2", 500_000n);
    await setGasPenaltyDirectly("B1", 300_000n);
    await setGasPenaltyDirectly("B2", 300_000n);

    // 2-and-anything doesn't fit in the 1M block gas limit, but 1-and-1 does - so the app
    // batches the two sequences' 1st bursts together, then their 2nd bursts, rather than draining
    // one sequence before starting the other.
    const arg: SendSequencesArg = {
      sequences: [
        { chainId, bursts: [{ calls: [addLog("A1")] }, { calls: [addLog("A2")] }] },
        { chainId, bursts: [{ calls: [addLog("B1")] }, { calls: [addLog("B2")] }] },
      ],
    };
    const [seq1Id, seq2Id] = await sendSequences(arg);
    const { txHash: txHash1 } = await mineNextTx(confirmations);
    await assertSequenceState(seq1Id, { successes: 1, failures: 0, pending: 1 });
    await assertSequenceState(seq2Id, { successes: 1, failures: 0, pending: 1 });
    const { txHash: txHash2 } = await mineNextTx(confirmations);

    const expectedEvents: SequenceEvent[] = [
      { kind: "created", details: { burstsCount: 2 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash1, fromIdxInSequence: 0, successes: 1, failed: false },
      },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 1, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash2, fromIdxInSequence: 1, successes: 1, failed: false },
      },
    ];
    await assertSequenceState(seq1Id, { successes: 2, failures: 0 }, expectedEvents);
    await assertSequenceState(seq2Id, { successes: 2, failures: 0 }, expectedEvents);
    await assertLogs(["A1", "B1", "A2", "B2"]);
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
    const { txHash } = await mineNextTx(confirmations);

    await assertSequenceState(underId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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
    const { txHash, blockNumber } = await mineNextTx(confirmations);

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const { txHash } = await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: staleTxHash }] = await getTxpoolTxs();
    await stopApp(app);

    // Dropped rather than left unmined - mining always packs in whatever's pending regardless of
    // automine, so it would get mined as soon as the next blocks are.
    await dropPendingTxs();

    app = await startApp(otherWorkerPrivateKey);
    // `startApp` only waits for `/health`, not for the worker to have recorded the block number
    // it'll wait `inclusionWaitBlocks` from - mining immediately risks it capturing a later block,
    // undercounting how many are actually left to mine below.
    await delay(100);

    await anvilClient.mine({ blocks: inclusionWaitBlocks });
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    const { txHash: freshTxHash, blockNumber } = await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: staleTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: staleTxHash } },
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    // Captured in full before being dropped, so it can be resubmitted verbatim later - proving
    // the worker recognizes success via an earlier attempt, not just its latest one.
    const [{ hash: txHash1 }] = await getTxpoolTxs();
    const tx1 = await anvilClient.getTransaction({ hash: txHash1 });
    await dropPendingTxs();

    // The worker gives up waiting on the dropped TX after `inclusionWaitBlocks` and sends a
    // repriced retry at the same nonce.
    await anvilClient.mine({ blocks: inclusionWaitBlocks });
    await waitForTxpoolCounts(1);
    const [{ hash: txHash2 }] = await getTxpoolTxs();
    await dropPendingTxs();

    // The original TX is restored and mines instead, despite the repriced retry being the
    // worker's latest attempt - which still shows up as its own `skipped` event even though it
    // wasn't the last attempt made.
    await resubmitTx(tx1);
    await mineNextTx(confirmations);

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: txHash2 } },
      {
        kind: "executed",
        details: { txHash: txHash1, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: txHash1 }] = await getTxpoolTxs();
    const tx1 = await anvilClient.getTransaction({ hash: txHash1 });

    // The TX is left genuinely pending the whole time, the same as if real fees had simply risen
    // past what it offered - unlike dropping it outright.
    await mineEmptyBlocks(inclusionWaitBlocks);

    // The worker gives up after `inclusionWaitBlocks` and sends a repriced retry at the same
    // nonce - Anvil drops the original from the pool once a pricier replacement arrives, so the
    // pool holds only the new one.
    const txHash2 = await waitForNewTxpoolTx(txHash1);
    const tx2 = await anvilClient.getTransaction({ hash: txHash2 });
    await assertRepriced(tx1, tx2);

    await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: txHash1 } },
      {
        kind: "executed",
        details: { txHash: txHash2, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: txHash1 }] = await getTxpoolTxs();
    // Every resend attempt before the worker gives up and burns the nonce instead (see
    // `sendTxAttempt`/`burnNonce`) shows up as its own `skipped` event, so all are tracked here,
    // not just the latest. `assertRepriced` only checks fees, not `to`/`data`, so it can't tell a
    // reprice apart from a burn attempt (which also replaces the same nonce) - checked here instead.
    const txHashes = [txHash1];
    let tx = await anvilClient.getTransaction({ hash: txHash1 });

    // Each retry - resending the burst's TX or, after 3 tries, burning the nonce instead - bumps
    // the fee by at least `minGasIncreasePercent`. Compounded, that soon exceeds 1.5x the current
    // fee estimate, which the worker refuses to pay, so it stops and leaves the last attempt
    // pending.
    while (true) {
      await mineEmptyBlocks(inclusionWaitBlocks);
      const newTxHash = await deadline(waitForNewTxpoolTx(txHashes.at(-1)!), 500)
        .catch((error) => {
          if (error instanceof DOMException && error.name === "TimeoutError") return undefined;
          throw error;
        });
      if (!newTxHash) break;
      const newTx = await anvilClient.getTransaction({ hash: newTxHash });
      if (newTx.to !== tx.to) break;
      await assertRepriced(tx, newTx);
      tx = newTx;
      txHashes.push(newTxHash);
    }
    assert(
      txHashes.length - 1 >= 2,
      `Expected at least 2 repriced retries before capping, got ${txHashes.length - 1}`,
    );

    // The burn TX mines normally, leaving the burst pending rather than failed - every batch
    // attempt above is superseded by it and shows up as `skipped`, then the burst is resent fresh
    // at the next nonce and succeeds.
    await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });
    const { txHash: freshTxHash } = await mineNextTx(confirmations);
    const submittedEvents: SequenceEvent[] = txHashes.map((txHash) => (
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } }
    ));
    const skippedEvents: SequenceEvent[] = txHashes.map((txHash) => (
      { kind: "skipped", details: { txHash } }
    ));
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      ...submittedEvents,
      ...skippedEvents,
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: txHash1 }] = await getTxpoolTxs();
    const tx1 = await anvilClient.getTransaction({ hash: txHash1 });

    // 1st reprice: the original TX is priced out, so the app sends a replacement - captured in
    // full so it can be restored later.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const txHash2 = await waitForNewTxpoolTx(txHash1);
    const tx2 = await anvilClient.getTransaction({ hash: txHash2 });
    await assertRepriced(tx1, tx2);

    // 2nd reprice: the 1st reprice is ALSO priced out, so the app sends another, pricier one.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const txHash3 = await waitForNewTxpoolTx(txHash2);
    const tx3 = await anvilClient.getTransaction({ hash: txHash3 });
    await assertRepriced(tx2, tx3);

    // The 2nd reprice is dropped, and the 1st - captured above before Anvil's replace-by-fee
    // handling evicted it - is restored in its place.
    await dropPendingTxs();
    await resubmitTx(tx2);
    await waitForTxpoolCounts(1);

    // The app still believes its latest attempt was the 2nd reprice, but since that's no longer
    // on-chain, `increasedFees` falls back to the next hash it recognizes - the 1st reprice, now
    // pending again - and reprices relative to THAT, not the 2nd. The burst's own TX has already
    // been retried 3 times, so this 3rd reprice is actually the nonce-burning attempt (see
    // `sendTxAttempt`/`burnNonce`), which reprices the same way, so the same invariant applies.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const txHash4 = await waitForNewTxpoolTx(txHash2);
    const tx4 = await anvilClient.getTransaction({ hash: txHash4 });
    await assertRepriced(tx2, tx4);
    // Asserting tx4's exact fee would be fragile - the fee estimate can drift block to block, so
    // the 1st reprice's own bump isn't guaranteed to reproduce bit-for-bit. Only checked NOT to be
    // a bump over the 2nd.
    const minIncrease = (fee: bigint) => fee * BigInt(100 + minGasIncreasePercent) / 100n;
    assert(
      tx4.maxFeePerGas! < minIncrease(tx3.maxFeePerGas!) ||
        tx4.maxPriorityFeePerGas! < minIncrease(tx3.maxPriorityFeePerGas!),
      "Expected the 3rd reprice to NOT be a bump over the 2nd - got " +
        `${tx4.maxFeePerGas}/${tx4.maxPriorityFeePerGas}, which is already a ` +
        `${minGasIncreasePercent}% bump over the 2nd's ` +
        `${tx3.maxFeePerGas}/${tx3.maxPriorityFeePerGas}`,
    );

    // The burn TX mines normally, leaving the burst pending rather than failed - each of the 3
    // attempts above, superseded by it, shows up as its own `skipped` event, then the burst is
    // resent fresh at the next nonce and succeeds.
    await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });
    const { txHash: freshTxHash } = await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash3, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: txHash1 } },
      { kind: "skipped", details: { txHash: txHash2 } },
      { kind: "skipped", details: { txHash: txHash3 } },
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: txHash1 }] = await getTxpoolTxs();
    const { nonce } = await anvilClient.getTransaction({ hash: txHash1 });
    await dropPendingTxs();

    // Bumps the nonce directly via Anvil's test API rather than a real TX - the app only ever
    // observes the nonce being ahead of what it expects, regardless of the cause.
    const workerAddress = privateKeyToAccount(workerPrivateKey).address;
    await anvilClient.setNonce({ address: workerAddress, nonce: nonce + 1 });

    // Noticing the nonce skip, then sending, mining and confirming the resend take several more
    // confirmations that can't be pinned to an exact block - each is mined with a short pause so
    // the worker (a separate process) can react before the next one lands. One more round than the
    // dummy-TX version below, which gets its dummy TX's own mining as a head start for free.
    for (let i = 0; i < 6; i++) {
      await delay(20);
      await anvilClient.mine({ blocks: 1 });
    }

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
    const freshTxHash = await findSubmittedTxHash(sequenceId, [txHash1]);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: txHash1 } },
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: txHash1 }] = await getTxpoolTxs();

    // The 2nd attempt (1st reprice) - captured in full so it can be restored later.
    await mineEmptyBlocks(inclusionWaitBlocks);
    const txHash2 = await waitForNewTxpoolTx(txHash1);
    const tx2 = await anvilClient.getTransaction({ hash: txHash2 });

    // The 3rd attempt (2nd reprice) - the last try before the worker gives up and starts burning
    // the nonce instead (see `sendTxAttempt`/`burnNonce`).
    await mineEmptyBlocks(inclusionWaitBlocks);
    const txHash3 = await waitForNewTxpoolTx(txHash2);

    // The nonce-burning TX - reaching this confirms the worker's given up on the burst's own TX
    // entirely.
    await mineEmptyBlocks(inclusionWaitBlocks);
    await waitForNewTxpoolTx(txHash3);

    // The 2nd attempt is restored and mines instead, despite the burn TX being the worker's
    // latest - still recognized as success since `watchTxs` tracks every historical attempt, not
    // just the latest. The 1st and 3rd attempts still show up as their own `skipped` events (the
    // burn TX isn't a "batch" attempt, so it doesn't get one).
    await dropPendingTxs();
    await resubmitTx(tx2);
    await mineNextTx(confirmations);

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash2, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash3, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: txHash1 } },
      { kind: "skipped", details: { txHash: txHash3 } },
      {
        kind: "executed",
        details: { txHash: txHash2, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    // Set up from the maintenance wallet, not the app's - using the app's would consume a nonce
    // it doesn't know about. The TX above was already built and signed, so the app has no way to
    // notice ahead of time.
    const { target, calldata } = setReverts("b");
    const setRevertsHash = await anvilClient.sendTransaction({ to: target, data: calldata });
    await anvilClient.mine({ blocks: 1 });
    await anvilClient.getTransactionReceipt({ hash: setRevertsHash });

    await resubmitTx(tx);
    await mineNextTx(confirmations);

    // The 2nd burst reverts on-chain; the 3rd, which needs the 2nd to have succeeded (see
    // `Executor.sol`'s `needsPrev`), is skipped and fails alongside it - even though its own call
    // would have succeeded in isolation.
    await assertSequenceState(sequenceId, { successes: 1, failures: 2 }, [
      { kind: "created", details: { burstsCount: 3 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 3 } },
      {
        kind: "executed",
        details: { txHash: txHash, fromIdxInSequence: 0, successes: 1, failed: true },
      },
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

    // The burst's own TX can't be afforded, so the worker burns the nonce instead - affordable
    // on its own - leaving the burst pending rather than failed.
    await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    // Rejected by Anvil for insufficient funds before reaching the mempool (see `sendTxRaw`'s
    // `InsufficientFundsError` handling), so unlike other tests its hash can't be read from the
    // txpool - read back from the sequence's own event log instead.
    const { txHash } = (await waitForSkippedEvent(sequenceId)).details;

    await anvilClient.setBalance({ address: workerAddress, value: parseEther("1") });
    const { txHash: freshTxHash } = await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash } },
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    // Unlike a dropped TX, nothing was ever sent for `waitForTxpoolCounts` to wait out, so those
    // blocks need mining directly. A short pause first gives `watchTxs` a chance to grab the block
    // number it'll wait `inclusionWaitBlocks` from - mining immediately risks it capturing a later
    // block, undercounting how many are actually left to mine below.
    await delay(50);
    await anvilClient.mine({ blocks: inclusionWaitBlocks });

    await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    // Rejected by Anvil for insufficient funds before reaching the mempool (see `sendTxRaw`'s
    // `InsufficientFundsError` handling), so unlike other tests its hash can't be read from the
    // txpool - read back from the sequence's own event log instead.
    const { txHash } = (await waitForSkippedEvent(sequenceId)).details;

    const { txHash: freshTxHash } = await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash } },
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    const [{ hash: txHash1 }] = await getTxpoolTxs();
    const { nonce } = await anvilClient.getTransaction({ hash: txHash1 });
    await dropPendingTxs();

    // Consumes the worker's nonce with an unrelated TX, simulating something outside the relay's
    // control having used it up.
    const workerAccount = privateKeyToAccount(workerPrivateKey);
    const dummyClient = createWalletClient({
      account: workerAccount,
      chain: anvilClient.chain,
      transport: http(),
    }).extend(publicActions);
    await dummyClient.sendTransaction({ to: workerAccount.address, value: 0n, nonce });
    await mineNextTx(confirmations);

    // Noticing the nonce skip, then sending, mining and confirming the resend take several more
    // confirmations that can't be pinned to an exact block - each is mined with a short pause so
    // the worker (a separate process) can react before the next one lands.
    for (let i = 0; i < 4; i++) {
      await delay(20);
      await anvilClient.mine({ blocks: 1 });
    }

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
    const freshTxHash = await findSubmittedTxHash(sequenceId, [txHash1]);
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      { kind: "submitted", details: { txHash: txHash1, fromIdxInSequence: 0, burstsCount: 1 } },
      { kind: "skipped", details: { txHash: txHash1 } },
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
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

    // The worker retries the same nonce 3 times before giving up - each dropped attempt is
    // resent only after `inclusionWaitBlocks` pass without a receipt, and shows up as its own
    // `skipped` event once the burn TX supersedes all 3.
    const droppedTxHashes: Hex[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitForTxpoolCounts(1);
      const [{ hash }] = await getTxpoolTxs();
      droppedTxHashes.push(hash);
      await dropPendingTxs();
      await anvilClient.mine({ blocks: inclusionWaitBlocks });
    }

    // After the 3rd dropped attempt, the worker burns the nonce instead - let through this time,
    // leaving the burst pending rather than failed, ready to be resent under the next nonce.
    await mineNextTx(confirmations);
    await assertSequenceState(sequenceId, { successes: 0, failures: 0, pending: 1 });

    const { txHash: freshTxHash } = await mineNextTx(confirmations);
    const submittedEvents: SequenceEvent[] = droppedTxHashes.map((txHash) => (
      { kind: "submitted", details: { txHash, fromIdxInSequence: 0, burstsCount: 1 } }
    ));
    const skippedEvents: SequenceEvent[] = droppedTxHashes.map((txHash) => (
      { kind: "skipped", details: { txHash } }
    ));
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 }, [
      { kind: "created", details: { burstsCount: 1 } },
      ...submittedEvents,
      ...skippedEvents,
      { kind: "submitted", details: { txHash: freshTxHash, fromIdxInSequence: 0, burstsCount: 1 } },
      {
        kind: "executed",
        details: { txHash: freshTxHash, fromIdxInSequence: 0, successes: 1, failed: false },
      },
    ]);
    await assertLogs(["ok"]);
  },
});
