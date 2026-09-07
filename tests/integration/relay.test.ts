import { assert, assertEquals } from "@std/assert";
import { delay } from "async";
import { createWalletClient, http, publicActions, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertSequenceState,
  confirmations,
  inclusionWaitBlocks,
  otherWorkerPrivateKey,
  sendSequences,
  startApp,
  stopApp,
  workerPrivateKey,
} from "./app.ts";
import {
  anvilClient,
  dropPendingTxs,
  etchSingletonFactory,
  getTxpoolTxs,
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

Deno.test.beforeAll(async () => {
  // Disabled for the whole suite so every transaction has to be mined explicitly (see
  // `mineNextTx`), rather than relying on Anvil's automine to include it as soon as it's sent.
  await anvilClient.setAutomine(false);
  await resetToGenesis();
  await setBlockGasLimit(1_000_000n);
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
    await assertSequenceState(overId, { successes: 0, failures: 1 });
    await mineNextTx();

    await assertSequenceState(underId, { successes: 1, failures: 0 });
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

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
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
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
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
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
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
    assert(
      firstTx.type === "eip1559" && firstTx.yParity !== undefined,
      "Expected an EIP-1559 transaction",
    );
    await dropPendingTxs();

    // The worker gives up waiting on the dropped TX after `inclusionWaitBlocks` and sends a
    // repriced retry at the same nonce.
    await anvilClient.mine({ blocks: inclusionWaitBlocks });
    await waitForTxpoolCounts(1);
    await dropPendingTxs();

    // The original TX is restored - despite the repriced retry being the worker's latest
    // attempt, this earlier one lands and mines instead.
    // `serializeTransaction` expects `data`, but viem's parsed `Transaction` names the same
    // field `input` - passing `firstTx` directly would silently serialize it as empty calldata.
    await anvilClient.sendRawTransaction({
      serializedTransaction: serializeTransaction({
        type: "eip1559",
        chainId,
        nonce: firstTx.nonce,
        to: firstTx.to,
        value: firstTx.value,
        data: firstTx.input,
        gas: firstTx.gas,
        maxFeePerGas: firstTx.maxFeePerGas,
        maxPriorityFeePerGas: firstTx.maxPriorityFeePerGas,
        accessList: firstTx.accessList,
      }, { r: firstTx.r, s: firstTx.s, yParity: firstTx.yParity }),
    });
    await mineNextTx();

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
    await assertLogs(["ok"]);
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

    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
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
    await assertSequenceState(sequenceId, { successes: 1, failures: 0 });
    await assertLogs(["ok"]);
  },
});
