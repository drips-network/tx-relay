import { delay } from "async";
import {
  Address,
  BaseError,
  concat,
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeFunctionData,
  ExecutionRevertedError,
  FeeCapTooLowError,
  FeeValues,
  getAddress,
  getContractAddress,
  Hex,
  InsufficientFundsError,
  keccak256,
  NonceTooLowError,
  pad,
  stringToHex,
  TransactionReceipt,
  TransactionReceiptNotFoundError,
} from "viem";
import { getNodeError } from "viem/utils";
import { and, eq, inArray, min } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  burstsTable,
  callsTable,
  sequenceEventsTable,
  sequenceEventToDbValue,
  sequencesTable,
  txPayloadBurstsTable,
  txPayloadsTable,
  txSendersTable,
  txsTable,
} from "./db-schema.ts";
import { ChainConfig, Client } from "./config.ts";
import { abi as executorAbi, bytecode as executorBytecode } from "./executor.generated.ts";

function matchViemError(
  error: unknown,
  // deno-lint-ignore no-explicit-any
  ...types: (abstract new (...args: any[]) => Error)[]
): Error | null {
  if (!(error instanceof BaseError)) return null;
  return error.walk((e) => types.some((Type) => e instanceof Type));
}

const singletonFactory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const executorSalt = pad("0x");
const executorAddr = getContractAddress({
  from: singletonFactory,
  opcode: "CREATE2",
  bytecode: executorBytecode,
  salt: executorSalt,
});
const burnAddr = getAddress(stringToHex("Nonce burning target"));

const filecoinChainId = 314;
// Filecoin RPC ignores `gas` field in `eth_call` and always sets the gas limit to this value.
// This affects visible `gasLeft` inside contract executed with Viem `simulateContract`,
// and any gas cost measurement made this way must be corrected.
const filecoinSimulateContractGas = 10_000_000_000n;

type Payload = {
  purpose: PayloadPurpose;
  txPayloadId: number;
  target: Address;
  calldata: Hex;
  gas: bigint;
};

type PayloadPurpose =
  | { kind: "call" }
  | { kind: "batch"; sequences: BatchSequence[] }
  | { kind: "burnNonce" };

type BatchSequence = {
  id: string;
  fromIdxInSequence: number;
  bursts: { id: number; inclusionGas: bigint }[]; // TODO what if 'id' is dropped?
};

type SenderJob = {
  senderId: number;
  senderAddr: Address;
  senderNonce: number;
  pendingTxs: { hash: Hex; payload: Payload }[];
  nextPayload?: Payload;
};

type WorkerContext = {
  chainConfig: ChainConfig;
  db: PostgresJsDatabase;
  senderJob?: SenderJob;
  execBaseInclusionGas?: bigint;
  burnNonceGas?: bigint;
};

const workerContext = new AsyncLocalStorage<WorkerContext>();

function getWorkerContext(): WorkerContext {
  const contextStore = workerContext.getStore();
  if (!contextStore) throw Error("No context set");
  return contextStore;
}

function getClient(): Client {
  return getChainConfig().client;
}

function getChainConfig(): ChainConfig {
  return getWorkerContext().chainConfig;
}

function getDb(): PostgresJsDatabase {
  return getWorkerContext().db;
}

function getSenderNonce(): Promise<number> {
  const client = getClient();
  return client.getTransactionCount({ address: client.account.address });
}

function getSenderJob(): SenderJob {
  const { senderJob } = getWorkerContext();
  if (!senderJob) throw Error("No sender job set in the context");
  return senderJob;
}

function setSenderJob(senderJob?: SenderJob) {
  const contextStore = getWorkerContext();
  if (contextStore.senderJob && senderJob) throw Error("Sender job already set in the context");
  contextStore.senderJob = senderJob;
}

async function getExecBaseInclusionGas(): Promise<bigint> {
  const workerContext = getWorkerContext();
  workerContext.execBaseInclusionGas ??= await calcExecBaseInclusionGas();
  return workerContext.execBaseInclusionGas;
}

async function calcExecBaseInclusionGas(): Promise<bigint> {
  const client = getClient();
  const blockNumber = await client.getBlockNumber();
  const emptyExecGas = await client.estimateGas({
    account: client.account,
    data: encodeFunctionData({
      abi: executorAbi,
      functionName: "exec",
      args: [[]],
    }),
    to: executorAddr,
    blockNumber,
  });
  let { result: [emptyExecStartGas] } = await client.simulateContract({
    account: client.account,
    abi: executorAbi,
    functionName: "exec",
    args: [[]],
    address: executorAddr,
    blockNumber,
    gas: emptyExecGas,
  });
  if (client.chain.id === filecoinChainId) {
    emptyExecStartGas -= filecoinSimulateContractGas - emptyExecGas;
    if (emptyExecStartGas <= 0) throw Error("Filecoin base gas report correction failed");
  }
  return emptyExecGas - emptyExecStartGas;
}

async function getNonceBurnGas(): Promise<bigint> {
  return getWorkerContext().burnNonceGas ??= await calcNonceBurnGas();
}

async function calcNonceBurnGas(): Promise<bigint> {
  const client = getClient();
  return await client.estimateGas({ account: client.account, to: burnAddr });
}

function workerName(chainConfig?: ChainConfig): string {
  return chainConfig?.client.chain.name ?? "main";
}

function log(...message: unknown[]) {
  const name = workerName(workerContext.getStore()?.chainConfig);
  console.log(`${new Date().toISOString()} [${name}]:`, ...message);
}

type Task = () => Promise<Tasks>;
type Tasks = Task[] | Task | undefined;

export type WorkerHealth = {
  name: string;
  runningSince: Date | null;
};

export function runWorker(chainConfig: ChainConfig, db: PostgresJsDatabase): WorkerHealth {
  const workerHealth: WorkerHealth = { name: workerName(chainConfig), runningSince: null };
  (async () => {
    while (true) {
      await workerContext.run({ chainConfig, db }, async () => {
        try {
          workerHealth.runningSince = new Date();
          log("Worker started with a fresh state");
          const tasks: Task[] = [initRelay];
          while (true) {
            const task = tasks.pop();
            if (!task) throw Error("Task queue empty");
            const newTasks = await task();
            tasks.push(...[newTasks ?? []].flat().reverse());
          }
        } catch (error) {
          workerHealth.runningSince = null;
          log("Worker crashed with error:", error);
        }
        const { workerRestartDelayMs } = getChainConfig();
        log("Worker will restart in", workerRestartDelayMs / 1000, "seconds");
        await delay(workerRestartDelayMs);
      });
    }
  })();
  return workerHealth;
}

async function initRelay(): Promise<Tasks> {
  const isDeployed = (address: Address) => getClient().getCode({ address });
  if (!await isDeployed(singletonFactory)) {
    throw new Error("Singleton factory not deployed at " + singletonFactory);
  }
  if (await isDeployed(executorAddr)) return resumeSenderJob;
  return [
    // Deploy Executor
    () =>
      sendCallTx({ target: singletonFactory, calldata: concat([executorSalt, executorBytecode]) }),
    // Re-check if Executor is deployed
    async () => {
      if (!await isDeployed(executorAddr)) throw new Error("Failed to deploy Executor");
      return resumeSenderJob;
    },
  ];
}

async function resumeSenderJob(): Promise<Tasks> {
  const client = getClient();
  const db = getDb();

  const allTxRows = db.$with("all_tx_rows").as(
    db.select({
      senderId: txSendersTable.id.getSQL().mapWith(txSendersTable.id).as("sender_id"),
      senderAddr: txSendersTable.address,
      senderNonce: txSendersTable.nonce,
      txHash: txsTable.txHash,
      txPayloadId: txPayloadsTable.id.getSQL().mapWith(txPayloadsTable.id).as("tx_payloads_id"),
      txTarget: txPayloadsTable.target,
      txCalldata: txPayloadsTable.calldata,
      txGas: txPayloadsTable.gas,
      txPayloadBurstId: txPayloadBurstsTable.id.getSQL().mapWith(txPayloadBurstsTable.id)
        .as("tx_payload_bursts_id"),
      sequenceId: burstsTable.sequenceId,
      burstId: burstsTable.id.getSQL().mapWith(burstsTable.id).as("bursts_id"),
      burstIdxInSequence: burstsTable.idxInSequence,
      burstInclusionGas: txPayloadBurstsTable.inclusionGas,
    })
      .from(txsTable)
      .innerJoin(txPayloadsTable, eq(txsTable.txPayloadId, txPayloadsTable.id))
      .innerJoin(txSendersTable, eq(txSendersTable.id, txPayloadsTable.txSenderId))
      .leftJoin(txPayloadBurstsTable, eq(txPayloadBurstsTable.txPayloadId, txPayloadsTable.id))
      .leftJoin(burstsTable, eq(burstsTable.id, txPayloadBurstsTable.burstId))
      .where(and(
        eq(txsTable.state, "pending"),
        eq(txSendersTable.chainId, client.chain.id),
      )),
  );
  const txRows = await db.with(allTxRows).select()
    .from(allTxRows)
    .where(eq(allTxRows.senderId, db.select({ value: min(allTxRows.senderId) }).from(allTxRows)))
    .orderBy(allTxRows.txHash, allTxRows.txPayloadBurstId);

  // No more pending transactions, run the relay
  if (!txRows.length) return sendNextBatch;
  const { senderId, senderAddr, senderNonce } = txRows[0];

  const pendingTxs: { hash: Hex; payload: Payload }[] = [];
  for (const txRow of txRows) {
    if (pendingTxs.at(-1)?.hash !== txRow.txHash) {
      pendingTxs.push({
        hash: txRow.txHash,
        payload: {
          purpose: txRow.txPayloadBurstId === null
            ? { kind: "call" }
            : { kind: "batch", sequences: [] },
          txPayloadId: txRow.txPayloadId,
          target: txRow.txTarget,
          calldata: txRow.txCalldata,
          gas: txRow.txGas ?? undefined,
        },
      });
    }
    const purpose = pendingTxs.at(-1)!.payload.purpose;
    if (purpose.kind === "batch") {
      if (purpose.sequences.at(-1)?.id !== txRow.sequenceId) {
        purpose.sequences.push({
          id: txRow.sequenceId!,
          fromIdxInSequence: txRow.burstIdxInSequence!,
          bursts: [],
        });
      }
      purpose.sequences.at(-1)!.bursts.push({
        id: txRow.burstId!,
        inclusionGas: txRow.burstInclusionGas!,
      });
    }
  }

  setSenderJob({
    senderId,
    senderAddr,
    senderNonce,
    pendingTxs,
  });

  // Any transactions still pending are probably outdated. Burn the nonce to prevent mining them.
  // If the nonce can't be burned, assume that the transactions are forgotten and won't be mined.
  const onPending = senderAddr === client.account.address ? burnNonce : finalizeSenderJob;
  return [() => watchTxs({ onPending }), resumeSenderJob];
}

type DbSequence = { id: string; bursts: DbBurst[] };
type DbBurst = {
  id: number;
  idxInSequence: number;
  gasBufferPercent: number | null;
  calls: DbCall[];
};
type DbCall = { target: Address; calldata: Hex; gas: bigint | null };

async function sendNextBatch(lastCheckTime: number = 0): Promise<Tasks> {
  await delay(lastCheckTime + getChainConfig().sendNextBatchMinRetryDelayMs - Date.now());
  log("Checking if a new batch needs to be sent");
  const sendNextBatchTask = () => sendNextBatch(Date.now());

  const db = getDb();
  const dbCalls = await db.select({
    sequenceId: sequencesTable.id,
    burstId: burstsTable.id,
    burstIdxInSequence: burstsTable.idxInSequence,
    gasBufferPercent: burstsTable.gasBufferPercent,
    target: callsTable.target,
    calldata: callsTable.calldata,
    gas: callsTable.gas,
  })
    .from(sequencesTable)
    .innerJoin(burstsTable, eq(sequencesTable.id, burstsTable.sequenceId))
    .innerJoin(callsTable, eq(burstsTable.id, callsTable.burstId))
    .where(and(
      eq(sequencesTable.chainId, getClient().chain.id),
      eq(burstsTable.state, "pending"),
    ))
    .orderBy(sequencesTable.id, burstsTable.id, callsTable.id);
  if (dbCalls.length == 0) return sendNextBatchTask;

  const dbSequences: DbSequence[] = [];
  let prevDbCall;
  for (const dbCall of dbCalls) {
    if (dbCall.sequenceId !== prevDbCall?.sequenceId) {
      dbSequences.push({ id: dbCall.sequenceId, bursts: [] });
    }
    if (dbCall.burstId !== prevDbCall?.burstId) {
      dbSequences.at(-1)!.bursts.push({
        id: dbCall.burstId,
        idxInSequence: dbCall.burstIdxInSequence,
        gasBufferPercent: dbCall.gasBufferPercent,
        calls: [],
      });
    }
    dbSequences.at(-1)!.bursts.at(-1)!.calls
      .push({ target: dbCall.target, calldata: dbCall.calldata, gas: dbCall.gas });
    prevDbCall = dbCall;
  }

  const { abiBursts, gas, batchSequences, rejectedSequences } = await buildNextBatch(dbSequences);
  if (rejectedSequences.length) {
    await db.transaction(async (dbTx) => {
      const failedBurstIds = rejectedSequences.flatMap(({ burstIds }) => burstIds);
      await dbTx.update(burstsTable).set({ state: "failure" })
        .where(inArray(burstsTable.id, failedBurstIds));

      const events = rejectedSequences.map(({ id, fromIdxInSequence }) =>
        sequenceEventToDbValue(id, { kind: "rejected", details: { fromIdxInSequence } })
      );
      await dbTx.insert(sequenceEventsTable).values(events);
    });
  }
  if (!batchSequences.length) return sendNextBatchTask;

  const senderNonce = await getSenderNonce();
  const calldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "exec",
    args: [abiBursts],
  });
  await db.transaction(async (dbTx) => {
    const { txPayloadId } = await startSenderJob(dbTx, senderNonce, {
      purpose: { kind: "batch", sequences: batchSequences },
      target: executorAddr,
      calldata,
      gas,
    });
    const txPayloadBursts = batchSequences.flatMap(({ bursts }) => bursts)
      .map(({ id, inclusionGas }) => ({ txPayloadId, burstId: id, inclusionGas }));
    await dbTx.insert(txPayloadBurstsTable).values(txPayloadBursts);
  });

  return [sendTxAttempt, sendNextBatchTask];
}

type AbiCall = { target: Address; data: Hex; gas: bigint };
type AbiBurst = { needsPrev: boolean; gas: bigint; calls: AbiCall[] };
type RejectedSequence = { id: string; fromIdxInSequence: number; burstIds: number[] };

async function buildNextBatch(dbSequences: DbSequence[]): Promise<
  {
    abiBursts: AbiBurst[];
    gas: bigint;
    batchSequences: BatchSequence[];
    rejectedSequences: RejectedSequence[];
  }
> {
  log("Building the batch");
  let abiBursts: AbiBurst[] = [];
  let execGas = 0n;
  const batchSequences: BatchSequence[] = [];
  const rejectedSequences: RejectedSequence[] = [];

  const client = getClient();
  const blockNumber = await client.getBlockNumber();
  let lastBurstInclusionGas = await getExecBaseInclusionGas();

  let outOfGasBursts = 0;
  for (const dbSequence of dbSequences) {
    if (outOfGasBursts >= 5) break;
    log("Attempting adding sequence", dbSequence.id, "to the batch");
    let sequenceBurstsGas = 0n;
    for (const [burstIdx, dbBurst] of dbSequence.bursts.entries()) {
      let onRevert: "reject" | "outOfGas" | "skip" = "skip";
      try {
        const nextAbiCalls: AbiCall[] = dbBurst.calls.map(
          ({ target, calldata, gas }) => ({ target, data: calldata, gas: BigInt(gas ?? 0) }),
        );
        const abiSequenceBursts = abiBursts.slice(abiBursts.length - burstIdx);

        // If the next burst runs out of available gas when executed in the sequence,
        // it's treated as a revert, and isn't counted as out of gas.
        onRevert = burstIdx == 0 ? "reject" : "skip";
        const execNextGas = await client.estimateGas({
          account: client.account,
          data: encodeFunctionData({
            abi: executorAbi,
            functionName: "execNext",
            args: [abiSequenceBursts, sequenceBurstsGas, nextAbiCalls],
          }),
          to: executorAddr,
          blockNumber,
          gasPrice: 0n,
          prepare: false,
        });

        let { result: nextBurstGas } = await client.simulateContract({
          account: client.account,
          abi: executorAbi,
          functionName: "execNext",
          args: [abiSequenceBursts, sequenceBurstsGas, nextAbiCalls],
          address: executorAddr,
          blockNumber,
          gas: execNextGas,
        });
        if (client.chain.id === filecoinChainId) {
          // The gas measurement is lowered with `* 63 / 64` in the contract,
          // so the correction must be proportionally lowered too.
          nextBurstGas -= (filecoinSimulateContractGas - execNextGas) * 63n / 64n;
          if (nextBurstGas <= 0) throw Error("Filecoin gas reading correction failed");
        }
        const nextAbiBurst = {
          needsPrev: burstIdx > 0,
          gas: nextBurstGas * (100n + BigInt(dbBurst.gasBufferPercent ?? 0)) / 100n,
          calls: nextAbiCalls,
        };

        const nextAbiBursts = [...abiBursts, nextAbiBurst];
        onRevert = batchSequences.length == 0 ? "reject" : "outOfGas";
        const nextExecGas = await client.estimateGas({
          account: getAddress(stringToHex("Executor - drain gas")),
          data: encodeFunctionData({
            abi: executorAbi,
            functionName: "exec",
            args: [nextAbiBursts],
          }),
          to: executorAddr,
          blockNumber,
          gasPrice: 0n,
          prepare: false,
        });

        if (onRevert === "outOfGas") onRevert = "skip";
        let { result: gasReport } = await client.simulateContract({
          account: client.account,
          abi: executorAbi,
          functionName: "exec",
          args: [nextAbiBursts],
          address: executorAddr,
          blockNumber,
          gas: nextExecGas,
        });
        if (!gasReport.every((gas) => gas > 0n)) throw new ExecutionRevertedError();
        if (client.chain.id === filecoinChainId) {
          gasReport = gasReport.map((gas) => {
            gas -= filecoinSimulateContractGas - nextExecGas;
            if (gas <= 0) throw Error("Filecoin gas report correction failed");
            return gas;
          });
        }

        // Gas left when the sequence was starting execution, without any calldata overhead.
        // It may be much more than is actually needed, but it's guaranteed
        // to be enough for the sequence's execution including any leftover gas.
        // 'gasReport' at -1 is gas left after the last burst and at -2 is before the last burst.
        sequenceBurstsGas = gasReport.at(-2 - burstIdx)!;
        const burstInclusionGas = nextExecGas - gasReport[0] - lastBurstInclusionGas;
        if (burstInclusionGas <= 0) throw Error("Inclusion gas not positive: " + burstInclusionGas);
        lastBurstInclusionGas += burstInclusionGas;
        if (burstIdx == 0) {
          batchSequences.push({
            id: dbSequence.id,
            fromIdxInSequence: dbBurst.idxInSequence,
            bursts: [],
          });
        }
        batchSequences.at(-1)!.bursts.push({
          id: dbBurst.id,
          inclusionGas: burstInclusionGas,
        });
        abiBursts = nextAbiBursts;
        execGas = nextExecGas;
        log("Burst", dbBurst.id, "accepted into the batch");
      } catch (error) {
        // This catches execution errors in `simulateContract` and `estimateGas`
        // covering reverting, out-of-gas or inability to estimate a valid gas limit.
        if (!matchViemError(error, ExecutionRevertedError, ContractFunctionRevertedError)) {
          throw error;
        }
        switch (onRevert) {
          case "reject":
            log("Burst", dbBurst.id, "rejected completely as failing");
            rejectedSequences.push({
              id: dbSequence.id,
              fromIdxInSequence: dbBurst.idxInSequence,
              // This branch may only be executed for the first burst in a sequence,
              // so always all the bursts in that sequence are rejected.
              burstIds: dbSequence.bursts.map(({ id }) => id),
            });
            break;
          case "outOfGas":
            log("Burst", dbBurst.id, "doesn't fit in the batch gas limit, skipping");
            outOfGasBursts++;
            break;
          case "skip":
            log("Burst", dbBurst.id, "can't be executed in the batch, skipping");
        }
        break;
      }
    }
  }
  return { abiBursts, gas: execGas, batchSequences, rejectedSequences };
}

async function sendCallTx(
  { target, calldata, gas }: { target: Address; calldata: Hex; gas?: bigint },
): Promise<Tasks> {
  log("Sending a transaction to", target);
  const senderNonce = await getSenderNonce();
  gas ??= await getClient().estimateGas({
    account: getClient().account,
    to: target,
    data: calldata,
    gasPrice: 0n,
  });
  const payload = { purpose: { kind: "call" as const }, target, calldata, gas };
  await getDb().transaction((dbTx) => startSenderJob(dbTx, senderNonce, payload));
  return sendTxAttempt();
}

// Must be called when there's no pending TX set.
async function startSenderJob(
  dbTx: PostgresJsDatabase,
  senderNonce: number,
  { purpose, target, calldata, gas }: {
    purpose: PayloadPurpose;
    target: Address;
    calldata: Hex;
    gas: bigint;
  },
): Promise<{ txPayloadId: number }> {
  const client = getClient();
  const address = client.account.address;
  const chainId = client.chain.id;

  await dbTx.insert(txSendersTable)
    .values({ address, nonce: senderNonce, chainId })
    .onConflictDoNothing();
  const [{ txSenderId }] = await dbTx.select({ txSenderId: txSendersTable.id }).from(txSendersTable)
    .where(and(
      eq(txSendersTable.address, address),
      eq(txSendersTable.nonce, senderNonce),
      eq(txSendersTable.chainId, chainId),
    ));
  const [{ txPayloadId }] = await dbTx.insert(txPayloadsTable)
    .values({ txSenderId, target, calldata, gas }).returning({ txPayloadId: txPayloadsTable.id });
  setSenderJob({
    senderId: txSenderId,
    senderAddr: address,
    senderNonce,
    pendingTxs: [],
    nextPayload: { txPayloadId, purpose, target, calldata, gas },
  });
  return { txPayloadId };
}

// Must be called after 'startSenderJob', when there's a pending TX set.
async function makeSenderJobBurnNonce() {
  const senderJob = getSenderJob();
  const target = burnAddr;
  const calldata = "0x";
  const gas = await getNonceBurnGas();
  const [{ txPayloadId }] = await getDb().insert(txPayloadsTable)
    .values({ txSenderId: senderJob.senderId, target, calldata, gas })
    .returning({ txPayloadId: txPayloadsTable.id });
  senderJob.nextPayload = { txPayloadId, purpose: { kind: "burnNonce" }, target, calldata, gas };
}

function sendTxAttempt(): Promise<Tasks> {
  log("Sending TX attempt");
  // Try to send 3 times, then burn nonce
  const retryTask = getSenderJob().pendingTxs.length < 2 ? sendTxAttempt : burnNonce;
  return sendTxRaw(retryTask);
}

async function increasedFees(fees: FeeValues): Promise<FeeValues | null> {
  const client = getClient();
  let lastTx;
  for (const { hash } of getSenderJob().pendingTxs.toReversed()) {
    lastTx = await client.getTransaction({ hash }).catch(() => undefined);
    if (lastTx) break;
  }
  if (!lastTx) return fees;

  const increasePercent = BigInt(getChainConfig().minGasIncreasePercent);
  const increaseFee = (fee?: bigint, lastFee?: bigint): bigint | undefined | null => {
    if (fee === undefined || lastFee === undefined) return fee;
    const minFee = lastFee * (100n + increasePercent) / 100n + 1n;
    if (minFee > fee * 150n / 100n) return null;
    else if (minFee > fee) return minFee;
    else return fee;
  };
  const newFees = {
    gasPrice: increaseFee(fees.gasPrice, lastTx.gasPrice),
    maxFeePerBlobGas: increaseFee(fees.maxFeePerBlobGas, lastTx.maxFeePerBlobGas),
    maxFeePerGas: increaseFee(fees.maxFeePerGas, lastTx.maxFeePerGas),
    maxPriorityFeePerGas: increaseFee(fees.maxPriorityFeePerGas, lastTx.maxPriorityFeePerGas),
  };
  if (Object.values(newFees).includes(null)) return null;
  return newFees as FeeValues;
}

async function burnNonce(delayMs?: number): Promise<Tasks> {
  const senderJob = getSenderJob();
  if (senderJob.nextPayload?.purpose.kind !== "burnNonce") await makeSenderJobBurnNonce();

  log("Burning nonce", senderJob.senderNonce);
  const config = getChainConfig();
  if (delayMs === undefined) delayMs = config.burnNonceDelayInitialMs;
  else {
    await delay(delayMs);
    delayMs = Math.min(delayMs * config.burnNonceDelayMultiplier, config.burnNonceDelayMaxMs);
  }
  return sendTxRaw(() => burnNonce(delayMs));
}

async function sendTxRaw(retryTask: Task): Promise<Tasks> {
  const client = getClient();
  const { pendingTxs, senderNonce: nonce, nextPayload } = getSenderJob();
  if (!nextPayload) throw Error("No payload set to send");
  const { purpose, txPayloadId, target, calldata, gas } = nextPayload;

  log("Attempting to send a transaction to", target);
  const request = await client.prepareTransactionRequest(
    { nonce, to: target, data: calldata, gas },
  );

  const fees = await increasedFees(request);
  if (!fees) return watchTxs({ onPending: retryTask });
  Object.assign(request, fees);

  const signedTx = await client.signTransaction(request);
  const txHash = keccak256(signedTx);
  pendingTxs.push({ hash: txHash, payload: nextPayload });
  await getDb().transaction(async (dbTx) => {
    await dbTx.insert(txsTable).values({ txHash, txPayloadId });

    if (purpose.kind === "batch") {
      const events = purpose.sequences.map(({ id, fromIdxInSequence, bursts }) =>
        sequenceEventToDbValue(id, {
          kind: "submitted",
          details: { txHash, fromIdxInSequence, burstsCount: bursts.length },
        })
      );
      await dbTx.insert(sequenceEventsTable).values(events);
    }
  });

  try {
    await client.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (rawError) {
    const error = rawError instanceof BaseError ? getNodeError(rawError, request) : rawError;
    if (matchViemError(error, ExecutionRevertedError)) return burnNonce;
    else if (matchViemError(error, FeeCapTooLowError)) return retryTask;
    else if (matchViemError(error, NonceTooLowError)) { /* Continue normally */ }
    else if (matchViemError(error, InsufficientFundsError)) {
      return () => waitForBalance(request.gas * (request.maxFeePerGas ?? request.gasPrice));
    } else if (
      error instanceof BaseError &&
      error.walk((e) =>
        e instanceof BaseError && /replacement transaction underpriced/i.test(e.details ?? "")
      )
    ) {
      log("Replacement transaction", txHash, "underpriced"); // Continue normally
    } else throw rawError;
  }
  return () => watchTxs({ onPending: retryTask });
}

async function waitForBalance(minBalance: bigint): Promise<Tasks> {
  const { senderJob } = getWorkerContext();
  if (senderJob && senderJob.nextPayload?.purpose.kind !== "burnNonce") {
    return [burnNonce, () => waitForBalance(minBalance)];
  }
  const { client, waitForBalanceRetryDelayMs } = getChainConfig();
  while (await client.getBalance({ address: client.account.address }) < minBalance) {
    log("Waiting for the balance to be at least", minBalance, "for wallet", client.account.address);
    await delay(waitForBalanceRetryDelayMs);
  }
  if (senderJob) return watchTxs({ onPending: burnNonce });
}

async function watchTxs(
  { onPending }: {
    onPending: Task;
  },
): Promise<Tasks> {
  const senderJob = getSenderJob();
  const config = getChainConfig();
  const client = config.client;
  const txHashes = senderJob.pendingTxs.map(({ hash }) => hash).toReversed();
  const confirmations = BigInt(config.confirmations);
  let nonceSkipConfirmed = false;
  const onPendingFromBlock = await client.getBlockNumber() + BigInt(config.inclusionWaitBlocks);
  retry: while (true) {
    log("Watching transactions for nonce", senderJob.senderNonce);
    for (const [hashIdx, hash] of txHashes.entries()) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (matchViemError(error, TransactionReceiptNotFoundError)) continue;
        else throw error;
      }
      const confirmedFromBlock = receipt.blockNumber + confirmations;
      if (await client.getBlockNumber() >= confirmedFromBlock) {
        return () => finalizeSenderJob(receipt);
      }
      await delayUntilBlockNumber(confirmedFromBlock);
      txHashes.splice(hashIdx, 1);
      txHashes.unshift(hash);
      nonceSkipConfirmed = false;
      continue retry;
    }

    if (
      client.account.address === senderJob.senderAddr &&
      await getSenderNonce() > senderJob.senderNonce
    ) {
      if (nonceSkipConfirmed) return finalizeSenderJob;
      await delayUntilBlockNumber(await client.getBlockNumber() + confirmations);
      nonceSkipConfirmed = true;
      continue;
    }
    nonceSkipConfirmed = false;

    const blockNumber = await client.getBlockNumber();
    if (blockNumber >= onPendingFromBlock) return onPending;
    await delayUntilBlockNumber(blockNumber + 1n);
  }
}

function delayUntilBlockNumber(targetBlockNumber: bigint): Promise<bigint> {
  const { promise, resolve, reject } = Promise.withResolvers<bigint>();
  const unwatch = getClient().watchBlockNumber({
    pollingInterval: getChainConfig().delayUntilBlockNumberPollingIntervalMs,
    onBlockNumber(blockNumber) {
      if (blockNumber >= targetBlockNumber) resolve(blockNumber);
    },
    onError: reject,
  });
  return promise.finally(unwatch);
}

async function finalizeSenderJob(receipt?: TransactionReceipt): Promise<undefined> {
  log("Finalizing transaction", receipt?.transactionHash ?? "skipping");
  if (receipt?.status === "reverted") log("Transaction", receipt.transactionHash, "has reverted");
  const { pendingTxs } = getSenderJob();
  setSenderJob();

  await getDb().transaction(async (dbTx) => {
    const skippedTxHashes = pendingTxs.map(({ hash }) => hash)
      .filter((hash) => hash !== receipt?.transactionHash);
    if (skippedTxHashes.length) {
      await dbTx.update(txsTable)
        .set({ state: "skipped" })
        .where(inArray(txsTable.txHash, skippedTxHashes));
    }
    if (receipt && skippedTxHashes.length < pendingTxs.length) {
      await dbTx.update(txsTable)
        .set({ state: receipt.status })
        .where(eq(txsTable.txHash, receipt.transactionHash));
    }

    const batches = pendingTxs.flatMap(({ hash, payload }) =>
      payload.purpose.kind === "batch" ? { hash, sequences: payload.purpose.sequences } : []
    );
    const executedBatch = receipt?.status === "success"
      ? batches.find((tx) => tx.hash === receipt.transactionHash)
      : undefined;
    const skippedEvents = [];
    for (const { hash: txHash, sequences } of batches) {
      if (txHash === executedBatch?.hash) continue;
      for (const { id: sequenceId } of sequences) {
        const event = sequenceEventToDbValue(sequenceId, { kind: "skipped", details: { txHash } });
        skippedEvents.push(event);
      }
    }
    if (skippedEvents.length) await dbTx.insert(sequenceEventsTable).values(skippedEvents);

    if (receipt && executedBatch) await finalizeBatch(dbTx, receipt, executedBatch.sequences);
  });
}

async function finalizeBatch(
  dbTx: PostgresJsDatabase,
  receipt: TransactionReceipt,
  sequences: BatchSequence[],
) {
  const txHash = receipt.transactionHash;
  const executedBursts = sequences.flatMap(({ bursts }) => bursts);
  const abs = (num: bigint) => num < 0 ? -num : num;

  const lastLog = receipt.logs.at(-1)!;
  const { args: { gasReport } } = decodeEventLog({
    abi: executorAbi,
    eventName: "Receipt",
    topics: lastLog.topics,
    data: lastLog.data,
  });
  if (gasReport.length !== executedBursts.length + 1) {
    throw Error("Gas report has invalid length in transaction " + txHash);
  }
  // Check that gas readings are monotonic and non-zero
  gasReport.reduceRight((nextGas, gas) => {
    if (abs(gas) <= abs(nextGas)) throw Error("Gas report inconsistent in transaction " + txHash);
    return gas;
  }, 0n);

  const successBursts: number[] = [];
  const failureSequences: string[] = [];
  const events = [];
  const unusedGasReport = gasReport.slice(1);
  for (const { id: sequenceId, fromIdxInSequence, bursts } of sequences) {
    const sequenceGasReport = unusedGasReport.splice(0, bursts.length);
    const successes = sequenceGasReport.filter((gas) => gas > 0).length;
    if (sequenceGasReport.slice(successes).some((gas) => gas > 0)) {
      throw Error("Sequence " + sequenceId + " didn't stop after failing in transaction " + txHash);
    }
    bursts.slice(0, successes).forEach(({ id }) => successBursts.push(id));
    const failed = successes < bursts.length;
    if (failed) failureSequences.push(sequenceId);
    events.push(sequenceEventToDbValue(sequenceId, {
      kind: "executed",
      details: { txHash, fromIdxInSequence, successes, failed },
    }));
  }
  if (successBursts.length) {
    await dbTx.update(burstsTable).set({ state: "success" })
      .where(inArray(burstsTable.id, successBursts));
  }
  if (failureSequences.length) {
    await dbTx.update(burstsTable).set({ state: "failure" })
      .where(and(
        eq(burstsTable.state, "pending"),
        inArray(burstsTable.sequenceId, failureSequences),
      ));
  }
  await dbTx.insert(sequenceEventsTable).values(events);

  log("Finalized", executedBursts.length, "bursts in transaction", txHash);

  // Bursts cost calculation stub.
  const burstCostShares: { burstId: number; cumulativeCostShare: bigint }[] = [];
  let totalCostShares = 0n;
  for (const [burstIdx, { id: burstId, inclusionGas }] of executedBursts.entries()) {
    totalCostShares += inclusionGas + abs(gasReport[burstIdx]) - abs(gasReport[burstIdx + 1]);
    burstCostShares.push({ burstId, cumulativeCostShare: totalCostShares });
  }
  const totalCost = receipt.gasUsed * receipt.effectiveGasPrice;
  let assignedCost = 0n;
  for (const { burstId, cumulativeCostShare } of burstCostShares) {
    const burstCost = cumulativeCostShare * totalCost / totalCostShares - assignedCost;
    assignedCost += burstCost;
    log("Burst", burstId, "costed", burstCost);
  }
}
