import { delay } from "async";
import { z } from "zod";
import {
  Abi,
  Address,
  BaseError,
  concat,
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeFunctionData,
  EstimateGasExecutionError,
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
  toHex,
  TransactionReceipt,
  TransactionReceiptNotFoundError,
} from "viem";
import { and, eq, inArray, min } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  burstsTable,
  callsTable,
  SequenceEvent,
  sequenceEventsTable,
  sequenceEventToDbValue,
  sequencesTable,
  txPayloadBurstsTable,
  txPayloadsTable,
  txSendersTable,
  txsTable,
  txStateEnum,
} from "./db/schema.ts";
import { ChainConfig, Client } from "./config.ts";

function matchViemError(
  error: unknown,
  // deno-lint-ignore no-explicit-any
  ...types: (abstract new (...args: any[]) => Error)[]
): Error | null {
  if (!(error instanceof BaseError)) return null;
  return error.walk((e) => types.some((Type) => e instanceof Type));
}

import executorOutputJson from "./Executor.generated.json" with { type: "json" };
const executorAbi: Abi = executorOutputJson.abi as Abi;
const executorBytecode: Hex = executorOutputJson.bytecode.object as Hex;

const singletonFactory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const executorSalt = pad("0x03");
const executorAddr = getContractAddress({
  from: singletonFactory,
  opcode: "CREATE2",
  bytecode: executorBytecode,
  salt: executorSalt,
});
const burnAddr = getAddress(stringToHex("Nonce burning target"));

type TxPayload = {
  txPayloadId: number;
  target: Address;
  calldata?: Hex;
  value?: bigint;
  gas?: bigint;
  isBurn?: true;
};

type PendingTxs = {
  txSenderId: number;
  nonce: number;
  txHashes: Hex[];
  lastFees?: FeeValues;
  nextPayload?: TxPayload;
};

type PendingTxsWithPayload = PendingTxs & Required<Pick<PendingTxs, "nextPayload">>;

type WorkerContext = {
  chainConfig: ChainConfig;
  db: PostgresJsDatabase;
  pendingTxs?: PendingTxs;
  execBaseInclusionGas?: bigint;
  burnPayload?: TxPayload;
  burnGas?: bigint;
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

function getNonce(): Promise<number> {
  const client = getClient();
  return client.getTransactionCount({ address: client.account.address });
}

function getPendingTxs(): PendingTxs {
  const pendingTxs = getWorkerContext().pendingTxs;
  if (!pendingTxs) throw Error("No pending TXs set in the context");
  return pendingTxs;
}

function setPendingTxs(pendingTxs?: PendingTxs) {
  const contextStore = getWorkerContext();
  if (contextStore.pendingTxs && pendingTxs) throw Error("Pending TXs already set in the context");
  contextStore.pendingTxs = pendingTxs;
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
  const { result: emptyExecGasReport }: { result: bigint[] } = await client.simulateContract({
    account: client.account,
    abi: executorAbi,
    functionName: "exec",
    args: [[]],
    address: executorAddr,
    blockNumber,
    gas: emptyExecGas,
  });
  return emptyExecGas - emptyExecGasReport[0]!;
}

async function getBurnGas(): Promise<bigint> {
  const workerContext = getWorkerContext();
  workerContext.burnGas ??= await calcBurnGas();
  return workerContext.burnGas;
}

async function calcBurnGas(): Promise<bigint> {
  const client = getClient();
  return await client.estimateGas({ account: client.account, to: burnAddr });
}

function log(...message: unknown[]) {
  const worker = workerContext.getStore()?.chainConfig.client.chain.name ?? "main";
  console.log(`${new Date().toISOString()} [${worker}]:`, ...message);
}

type Task = () => Promise<Tasks>;
type Tasks = Task[] | Task | undefined;

export async function runWorker(chainConfig: ChainConfig, db: PostgresJsDatabase) {
  while (true) {
    try {
      await workerContext.run({ chainConfig, db }, async () => {
        log("Worker started with a fresh state");
        const tasks: Task[] = [initRelay];
        while (true) {
          const task = tasks.pop();
          if (!task) throw Error("Task queue empty");
          const newTasks = await task();
          tasks.push(...[newTasks ?? []].flat().reverse());
        }
      });
    } catch (error) {
      log("Worker crashed with error:", error);
    }
  }
}

async function initRelay(): Promise<Tasks> {
  const isExecutorDeployed = () => getClient().getCode({ address: executorAddr });
  if (await isExecutorDeployed()) return cleanUpPendingTxs;
  return [
    // Deploy the executor
    () => sendTx({ target: singletonFactory, calldata: concat([executorSalt, executorBytecode]) }),
    // Re-check if the executor is deployed, and starve the worker if not
    async () => {
      if (await isExecutorDeployed()) return cleanUpPendingTxs;
      else log("Failed to deploy the executor");
    },
  ];
}

async function cleanUpPendingTxs(): Promise<Tasks> {
  const client = getClient();
  const db = getDb();
  const senderIdQuery = db.select({ id: min(txSendersTable.id) })
    .from(txSendersTable)
    .innerJoin(txPayloadsTable, eq(txPayloadsTable.txSenderId, txSendersTable.id))
    .innerJoin(txsTable, eq(txsTable.txPayloadId, txPayloadsTable.id))
    .where(and(
      eq(txSendersTable.chainId, client.chain.id),
      eq(txsTable.state, "pending"),
    ));
  const txSender = await db.select({
    txSenderId: txSendersTable.id,
    senderAddr: txSendersTable.address,
    nonce: txSendersTable.nonce,
  })
    .from(txSendersTable)
    .where(eq(txSendersTable.id, senderIdQuery));
  // No more pending transactions, run the relay
  if (!txSender.length) return sendNextBatch;
  const [{ txSenderId, senderAddr, nonce }] = txSender;

  const txs = await db.select({ txHash: txsTable.txHash })
    .from(txsTable)
    .innerJoin(txPayloadsTable, eq(txPayloadsTable.id, txsTable.txPayloadId))
    .where(eq(txPayloadsTable.txSenderId, txSenderId))
    .orderBy(txsTable.id);

  setPendingTxs({
    txSenderId,
    nonce,
    txHashes: txs.map(({ txHash }) => txHash!),
  });

  // Any transactions still pending are probably outdated. Burn the nonce to prevent mining them.
  // If the nonce can't be burned, assume that the transactions are forgotten and won't be mined.
  const onPending = senderAddr === client.account.address ? burnNonce : finalizeTx;
  return [() => watchTxs({ onPending }), cleanUpPendingTxs];
}

type DbSequence = { id: string; bursts: DbBurst[] };
type DbBurst = { id: number; idxInSequence: number; calls: DbCall[] };
type DbCall = { target: Address; calldata: Hex; gas: bigint | null };

async function sendNextBatch(lastCheckTime: number = 0): Promise<Tasks> {
  await delay(lastCheckTime + 1_000 - Date.now());
  log("Checking if a new batch needs to be sent");
  const sendNextBatchTask = () => sendNextBatch(Date.now());

  const db = getDb();
  const dbCalls = await db.select({
    sequenceId: sequencesTable.id,
    burstId: burstsTable.id,
    burstIdxInSequence: burstsTable.idxInSequence,
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
        calls: [],
      });
    }
    dbSequences.at(-1)!.bursts.at(-1)!.calls
      .push({ target: dbCall.target, calldata: dbCall.calldata, gas: dbCall.gas });
    prevDbCall = dbCall;
  }

  const { submittedSequences, execGas, rejectedSequences } = await buildNextBatch(dbSequences);
  if (rejectedSequences.length) {
    await db.transaction(async (dbTx) => {
      const failedBurstIds = rejectedSequences.map(({ burstIds }) => burstIds).flat();
      await db.update(burstsTable).set({ state: "failure" })
        .where(inArray(burstsTable.id, failedBurstIds));

      const events = rejectedSequences.map(({ id, fromIdxInSequence }) =>
        sequenceEventToDbValue(id, { kind: "rejected", details: { fromIdxInSequence } })
      );
      await dbTx.insert(sequenceEventsTable).values(events);
    });
  }
  if (!submittedSequences.length) return sendNextBatchTask;

  const submittedBursts = submittedSequences.map((sequence) => sequence.bursts).flat();
  const nonce = await getNonce();
  const calldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "exec",
    args: [submittedBursts.map((burst) => burst.abiBurst)],
  });
  await db.transaction(async (dbTx) => {
    const { txPayloadId } = await registerPendingTx(dbTx, nonce, {
      target: executorAddr,
      calldata,
      gas: execGas,
    });
    await dbTx.insert(txPayloadBurstsTable).values(submittedBursts.map(
      ({ id, inclusionGas }) => ({ txPayloadId, burstId: id, inclusionGas }),
    ));

    const events = submittedSequences.map(({ id, fromIdxInSequence, bursts }) =>
      sequenceEventToDbValue(id, {
        kind: "submitted",
        details: { fromIdxInSequence, burstsCount: bursts.length },
      })
    );
    await dbTx.insert(sequenceEventsTable).values(events);
  });

  return [sendTxAttempt, sendNextBatchTask];
}

type AbiCall = { target: Address; data: Hex; gas: bigint };
type AbiBurst = { needsPrev: boolean; gas: bigint; calls: AbiCall[] };
type SubmittedSequence = {
  id: string;
  fromIdxInSequence: number;
  bursts: { id: number; abiBurst: AbiBurst; inclusionGas: bigint }[];
};
type RejectedSequence = { id: string; fromIdxInSequence: number; burstIds: number[] };

async function buildNextBatch(dbSequences: DbSequence[]): Promise<
  {
    submittedSequences: SubmittedSequence[];
    execGas: bigint;
    rejectedSequences: RejectedSequence[];
  }
> {
  log("Building the batch");
  const submittedSequences: SubmittedSequence[] = [];
  let execGas = 0n;
  const rejectedSequences: RejectedSequence[] = [];

  const client = getClient();
  const blockNumber = await client.getBlockNumber();
  let lastBurstInclusionGas = await getExecBaseInclusionGas();

  let outOfGasBursts = 0;
  for (const dbSequence of dbSequences) {
    log("Adding sequence", dbSequence.id, "to the batch");
    if (outOfGasBursts >= 5) break;
    let sequenceBurstsGas = 0n;
    for (const [burstIdx, dbBurst] of dbSequence.bursts.entries()) {
      let inExecStage = false;
      try {
        const nextAbiCalls: AbiCall[] = dbBurst.calls.map(
          ({ target, calldata, gas }) => ({ target, data: calldata, gas: BigInt(gas ?? 0) }),
        );
        const abiBursts = submittedSequences.map((sequence) => sequence.bursts)
          .flat().map((burst) => burst.abiBurst);
        const abiSequenceBursts = abiBursts.slice(abiBursts.length - burstIdx);

        const execNextGas = await client.estimateGas({
          account: client.account,
          data: encodeFunctionData({
            abi: executorAbi,
            functionName: "execNext",
            args: [abiSequenceBursts, sequenceBurstsGas, nextAbiCalls],
          }),
          to: executorAddr,
          blockNumber,
        });

        const { result: nextBurstGas } = await client.simulateContract({
          account: client.account,
          abi: executorAbi,
          functionName: "execNext",
          args: [abiSequenceBursts, sequenceBurstsGas, nextAbiCalls],
          address: executorAddr,
          blockNumber,
          gas: execNextGas,
        });
        const nextAbiBurst = { needsPrev: burstIdx > 0, gas: nextBurstGas, calls: nextAbiCalls };

        inExecStage = true;
        const nextAbiBursts = [...abiBursts, nextAbiBurst];
        const nextExecGas = await client.estimateGas({
          account: getAddress(stringToHex("Executor - drain gas")),
          data: encodeFunctionData({
            abi: executorAbi,
            functionName: "exec",
            args: [nextAbiBursts],
          }),
          to: executorAddr,
          blockNumber,
        });

        const { result: gasReport }: { result: bigint[] } = await client.simulateContract({
          account: client.account,
          abi: executorAbi,
          functionName: "exec",
          args: [nextAbiBursts],
          address: executorAddr,
          blockNumber,
          gas: nextExecGas,
        });
        if (!gasReport.every((gas) => gas > 0n)) throw new ExecutionRevertedError();

        // Gas left when the sequence was starting execution, without any calldata overhead.
        // It may be much more than is actually needed, but it's guaranteed
        // to be enough for the sequence's execution including any leftover gas.
        // 'gasReport' at -1 is gas left after the last burst and at -2 is before the last burst.
        sequenceBurstsGas = gasReport.at(-2 - burstIdx)!;
        const burstInclusionGas = nextExecGas - gasReport[0] - lastBurstInclusionGas;
        lastBurstInclusionGas += burstInclusionGas;
        if (burstIdx == 0) {
          submittedSequences.push({
            id: dbSequence.id,
            fromIdxInSequence: dbBurst.idxInSequence,
            bursts: [],
          });
        }
        submittedSequences.at(-1)!.bursts.push({
          id: dbBurst.id,
          abiBurst: nextAbiBurst,
          inclusionGas: burstInclusionGas,
        });
        execGas = nextExecGas;
        log("Burst", dbBurst.id, "accepted into the batch");
      } catch (error) {
        if (!matchViemError(error, ContractFunctionRevertedError, ExecutionRevertedError)) {
          throw error;
        }
        // The burst reverted or ran out of gas when executed alone,
        // with no other bursts affecting the state or using up gas.
        if ((!inExecStage && burstIdx == 0) || (inExecStage && submittedSequences.length == 0)) {
          log("Burst", dbBurst.id, "rejected completely as failing");
          rejectedSequences.push({
            id: dbSequence.id,
            fromIdxInSequence: dbBurst.idxInSequence,
            // This branch may only be executed for the first burst in a sequence,
            // so always all the bursts in that sequence are failing.
            burstIds: dbSequence.bursts.map(({ id }) => id),
          });
        } else if (error instanceof EstimateGasExecutionError) {
          log("Burst", dbBurst.id, "runs out of gas when in batch, skipping");
          outOfGasBursts++;
        } else log("Burst", dbBurst.id, "reverts when in batch, skipping");
        break;
      }
    }
  }
  return { submittedSequences, execGas, rejectedSequences };
}

async function sendTx(
  payload: { target: Address; calldata?: Hex; value?: bigint; gas?: bigint },
): Promise<Tasks> {
  log("Sending a transaction to", payload.target);
  const nonce = await getNonce();
  await getDb().transaction((dbTx) => registerPendingTx(dbTx, nonce, payload));
  return sendTxAttempt();
}

// Must be called when there's no pending TX set.
async function registerPendingTx(
  dbTx: PostgresJsDatabase,
  nonce: number,
  payload: {
    target: Address;
    calldata?: Hex;
    value?: bigint;
    gas?: bigint;
  },
): Promise<{ txPayloadId: number }> {
  const client = getClient();
  const address = client.account.address;
  const chainId = client.chain.id;
  await dbTx.insert(txSendersTable).values({ address, nonce, chainId }).onConflictDoNothing();
  const [{ txSenderId }] = await dbTx.select({ txSenderId: txSendersTable.id }).from(txSendersTable)
    .where(and(
      eq(txSendersTable.address, address),
      eq(txSendersTable.nonce, nonce),
      eq(txSendersTable.chainId, chainId),
    ));
  const [{ txPayloadId }] = await dbTx.insert(txPayloadsTable)
    .values({ txSenderId, ...payload }).returning({ txPayloadId: txPayloadsTable.id });
  const pendingTxs = { txSenderId, nonce, txHashes: [], nextPayload: { txPayloadId, ...payload } };
  setPendingTxs(pendingTxs);
  return { txPayloadId };
}

// Must be called after 'registerPendingTx', when there's a pending TX set.
async function registerPendingBurnTx() {
  const pendingTxs = getPendingTxs();
  // TODO estimate, insert and cache gas
  const gas = await getBurnGas();
  const [{ txPayloadId }] = await getDb().insert(txPayloadsTable)
    .values({ txSenderId: pendingTxs.txSenderId, target: burnAddr, gas })
    .returning({ txPayloadId: txPayloadsTable.id });
  pendingTxs.nextPayload = { txPayloadId, target: burnAddr, gas, isBurn: true };
}

function sendTxAttempt(): Promise<Tasks> {
  log("Sending TX attempt");
  // Try to send 3 times, then burn nonce
  const retryTask = getPendingTxs().txHashes.length < 2 ? sendTxAttempt : burnNonce;
  return sendTxRaw(retryTask);
}

function txCost(
  { value, gas, gasPrice, maxFeePerGas }: {
    value?: bigint;
    gas?: bigint;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
  },
): bigint {
  return (value ?? 0n) + (gas ?? 0n) * (maxFeePerGas ?? gasPrice ?? 0n);
}

function increasedFees(fees: FeeValues): FeeValues {
  const { lastFees } = getPendingTxs();
  const increasePercent = BigInt(getChainConfig().minGasIncreasePercent);
  const increaseFee = (fee?: bigint, lastFee?: bigint): bigint | undefined => {
    if (fee === undefined || lastFee === undefined) return fee;
    const minFee = lastFee * (100n + increasePercent) / 100n + 1n;
    return fee > minFee ? fee : minFee;
  };
  return {
    gasPrice: increaseFee(fees.gasPrice, lastFees?.gasPrice),
    maxFeePerBlobGas: increaseFee(fees.maxFeePerBlobGas, lastFees?.maxFeePerBlobGas),
    maxFeePerGas: increaseFee(fees.maxFeePerGas, lastFees?.maxFeePerGas),
    maxPriorityFeePerGas: increaseFee(fees.maxPriorityFeePerGas, lastFees?.maxPriorityFeePerGas),
  } as FeeValues;
}

async function burnNonce(delayMs?: number): Promise<Tasks> {
  const pendingTxs = getPendingTxs();
  if (!pendingTxs.nextPayload?.isBurn) await registerPendingBurnTx();

  log("Burning nonce", pendingTxs.nonce);
  if (!delayMs) delayMs = 1_000;
  else {
    await delay(delayMs);
    delayMs *= 10;
    const maxDelayMs = 60_000;
    if (delayMs > maxDelayMs) {
      delayMs = maxDelayMs;
      // Break the perpetual fees incrase
      delete pendingTxs.lastFees;
    }
  }
  return sendTxRaw(() => burnNonce(delayMs));
}

async function sendTxRaw(retryTask: Task): Promise<Tasks> {
  const client = getClient();
  const {
    txHashes,
    nonce,
    nextPayload,
  } = getPendingTxs();
  if (!nextPayload) throw Error("No payload set to send");
  const { txPayloadId, target, calldata, value, gas } = nextPayload;

  log("Attempting to send a transaction to", target);
  const request = await client.prepareTransactionRequest(
    { nonce, to: target, data: calldata, value, gas },
  );

  const fees = increasedFees(request);
  Object.assign(request, fees);
  getPendingTxs().lastFees = fees;

  const signedTx = await client.signTransaction(request);
  txHashes.push(keccak256(signedTx));
  await getDb().insert(txsTable).values({ txHash: keccak256(signedTx), txPayloadId });

  try {
    await client.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (error) {
    if (matchViemError(error, ExecutionRevertedError)) return burnNonce;
    else if (matchViemError(error, FeeCapTooLowError)) return retryTask;
    else if (matchViemError(error, NonceTooLowError)) { /* Continue normally */ }
    else if (matchViemError(error, InsufficientFundsError)) {
      return () => waitForBalance(txCost(request));
    } else throw error;
  }
  return () => watchTxs({ onPending: retryTask });
}

async function waitForBalance(minBalance: bigint): Promise<Tasks> {
  const pendingTxs = getWorkerContext().pendingTxs;
  if (pendingTxs && !pendingTxs.nextPayload?.isBurn) {
    return [burnNonce, () => waitForBalance(minBalance)];
  }
  const client = getClient();
  while (await client.getBalance({ address: client.account.address }) < minBalance) {
    log("Waiting for the balance to be at least", minBalance, "for wallet", client.account.address);
    await delay(10_000);
  }
  if (pendingTxs) return watchTxs({ onPending: burnNonce });
}

async function watchTxs(
  { onPending }: {
    onPending: Task;
  },
): Promise<Tasks> {
  const { txHashes, nonce } = getPendingTxs();
  const { client, blockTimeMs, miningTimeBlocks } = getChainConfig();
  const confirmations = BigInt(getChainConfig().confirmations);
  let skipOnBlock;
  for (let attempt = 0; true; attempt++) {
    log("Watching transactions for nonce", nonce, "attempt", attempt);
    let receipt;
    for (const hash of txHashes.toReversed()) {
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (matchViemError(error, TransactionReceiptNotFoundError)) continue;
        else throw error;
      }
      if (await client.getBlockNumber() >= receipt.blockNumber + confirmations) {
        await finalizeTx(receipt);
        return;
      }
      break;
    }

    if (!receipt && await getNonce() > nonce) {
      const blockNumber = await client.getBlockNumber();
      skipOnBlock ??= blockNumber + confirmations;
      if (blockNumber >= skipOnBlock) {
        await finalizeTx();
        return;
      }
    } else {
      skipOnBlock = undefined;
    }

    if (!receipt && !skipOnBlock && attempt >= miningTimeBlocks) return onPending;

    await delay(blockTimeMs);
  }
}

async function finalizeTx(receipt?: TransactionReceipt): Promise<undefined> {
  log(
    "Finalizing transaction",
    receipt ? receipt.transactionHash + " with status " + receipt.status : "skipping",
  );
  const { txSenderId, txHashes } = getPendingTxs();
  setPendingTxs(undefined);

  await getDb().transaction(async (dbTx) => {
    await dbTx.update(txsTable)
      .set({ state: "skipped" })
      .where(
        inArray(txsTable.txHash, txHashes.filter((hash) => hash !== receipt?.transactionHash)),
      );

    let executedBursts: {
      sequenceId: string;
      burstId: number;
      idxInSequence: number;
      inclusionGas: bigint;
    }[] = [];
    if (receipt) {
      await dbTx.update(txsTable)
        .set({ state: receipt.status })
        .where(eq(txsTable.txHash, receipt.transactionHash));

      executedBursts = await dbTx.select({
        sequenceId: burstsTable.sequenceId,
        burstId: burstsTable.id,
        idxInSequence: burstsTable.idxInSequence,
        inclusionGas: txPayloadBurstsTable.inclusionGas,
      })
        .from(burstsTable)
        .innerJoin(txPayloadBurstsTable, eq(txPayloadBurstsTable.burstId, burstsTable.id))
        .innerJoin(txsTable, eq(txsTable.txPayloadId, txPayloadBurstsTable.txPayloadId))
        .where(eq(txsTable.txHash, receipt.transactionHash))
        .orderBy(txPayloadBurstsTable.id);
    }

    if (!receipt || !executedBursts.length) {
      const skippedSequenceIds = await dbTx.selectDistinct({ sequenceId: burstsTable.sequenceId })
        .from(burstsTable)
        .innerJoin(txPayloadBurstsTable, eq(txPayloadBurstsTable.burstId, burstsTable.id))
        .innerJoin(txPayloadsTable, eq(txPayloadsTable.id, txPayloadBurstsTable.txPayloadId))
        .where(eq(txPayloadsTable.txSenderId, txSenderId));
      const skippedEvents = skippedSequenceIds.map(({ sequenceId }) =>
        sequenceEventToDbValue(sequenceId, { kind: "skipped", details: {} })
      );
      if (skippedEvents.length) await dbTx.insert(sequenceEventsTable).values(skippedEvents);
      return;
    }
    log("Got", executedBursts.length, "bursts finalized");

    const { topics, data } = receipt.logs.at(-1)!;
    const { gasReport } = decodeEventLog({ abi: executorAbi, eventName: "Receipt", topics, data })
      .args as unknown as { gasReport: bigint[] };
    if (gasReport.length !== executedBursts.length + 1) throw Error("Invalid gas report");

    const successBursts: number[] = [];
    const failureBursts: number[] = [];
    const executedEvents: {
      sequenceId: string;
      details: {
        fromIdxInSequence: number;
        successes: number;
        failed: boolean;
      };
    }[] = [];
    for (const [burstIdx, { burstId, sequenceId, idxInSequence }] of executedBursts.entries()) {
      let executedEvent = executedEvents.at(-1);
      if (executedEvent?.sequenceId !== sequenceId) {
        executedEvent = {
          sequenceId,
          details: { fromIdxInSequence: idxInSequence, successes: 0, failed: false },
        };
        executedEvents.push(executedEvent);
      }
      if (gasReport[burstIdx + 1] > 0) {
        successBursts.push(burstId);
        executedEvent.details.successes++;
      } else {
        failureBursts.push(burstId);
        executedEvent.details.failed = true;
      }
    }
    if (successBursts.length) {
      await dbTx.update(burstsTable).set({ state: "success" })
        .where(inArray(burstsTable.id, successBursts));
    }
    if (failureBursts.length) {
      await dbTx.update(burstsTable).set({ state: "failure" })
        .where(inArray(burstsTable.id, failureBursts));
    }
    const events = executedEvents.map(({ sequenceId, details }) =>
      sequenceEventToDbValue(sequenceId, { kind: "executed", details })
    );
    await dbTx.insert(sequenceEventsTable).values(events);

    // Bursts cost calculation stub.
    const burstCostShares: { burstId: number; cumulativeCostShare: bigint }[] = [];
    let totalCostShares = 0n;
    const abs = (num: bigint) => num < 0n ? -num : num;
    for (const [burstIdx, { burstId, inclusionGas }] of executedBursts.entries()) {
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
  });
}

// metered gas + inclusion gas + remainings(negative?) / bursts

// tx.gasLimit - report[0] - sum(inclusionGas) = equal base
//
// EIP-7623: Increase calldata cost - calldata may use more gas
// storage gas refunds - TX may use less gas
//
// the rest - split according to gas usage
