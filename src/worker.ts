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

type TxPayload = {
  txPayloadId: number;
  target: Address;
  calldata: Hex;
  value?: bigint;
  gas?: bigint;
};

type PendingTxs = {
  txSenderId: number;
  nonce: number;
  txHashes: Hex[];
  lastFees?: FeeValues;
  nextPayload: TxPayload;
};

type WorkerContext = {
  chainConfig: ChainConfig;
  db: PostgresJsDatabase;
  pendingTxs?: PendingTxs;
  execBaseInclusionGas?: bigint;
  burnPayload?: TxPayload;
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

async function getBurnPayload(): Promise<TxPayload> {
  const workerContext = getWorkerContext();
  workerContext.burnPayload ??= await createBurnPayload();
  return workerContext.burnPayload;
}

async function createBurnPayload(): Promise<TxPayload> {
  const target = getAddress(stringToHex("Nonce burning target"));
  const calldata = toHex("");
  const insertedTxPayloads = await getDb().insert(txPayloadsTable)
    .values({ target, calldata }).returning({ txPayloadId: txPayloadsTable.id });
  const txPayloadId = insertedTxPayloads[0].txPayloadId;
  const client = getClient();
  const gas = await client.estimateGas({ account: client.account, to: target, data: calldata });
  return { txPayloadId, target, calldata, gas };
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
    .innerJoin(txsTable, eq(txsTable.txSenderId, txSendersTable.id))
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
    .where(eq(txsTable.txSenderId, txSenderId))
    .orderBy(txsTable.id);

  setPendingTxs({
    txSenderId,
    nonce,
    txHashes: txs.map(({ txHash }) => txHash!),
    nextPayload: await getBurnPayload(),
  });

  // Any transactions still pending are probably outdated. Burn the nonce to prevent mining them.
  // If the nonce can't be burned, assume that the transactions are forgotten and won't be mined.
  const onPending = senderAddr === client.account.address ? burnNonce : skipTx;
  return [() => watchTxs({ onPending }), cleanUpPendingTxs];
}

type DbSequence = { id: string; bursts: DbBurst[] };
type DbBurst = { id: number; calls: DbCall[] };
type DbCall = { target: Address; calldata: Hex; gas: bigint | null };

async function sendNextBatch(lastCheckTime: number = 0): Promise<Tasks> {
  await delay(lastCheckTime + 1_000 - Date.now());
  log("Checking if a new batch needs to be sent");
  const sendNextBatchTask = () => sendNextBatch(Date.now());

  const db = getDb();
  const dbCalls = await db.select({
    sequenceId: sequencesTable.id,
    burstId: burstsTable.id,
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
      dbSequences.at(-1)!.bursts.push({ id: dbCall.burstId, calls: [] });
    }
    dbSequences.at(-1)!.bursts.at(-1)!.calls
      .push({ target: dbCall.target, calldata: dbCall.calldata, gas: dbCall.gas });
    prevDbCall = dbCall;
  }

  const { payloadBursts, execGas, failedSequences } = await buildPayload(dbSequences);
  // if (failedBurstIds.length) {
  //   await db.update(burstsTable).set({ state: "failure" })
  //     .where(inArray(burstsTable.id, failedBurstIds));
  // }
  if (failedSequences.length) {
    await db.transaction(async (dbTx) => {
      const failedBurstIds = failedSequences.map(({ burstIds }) => burstIds).flat();
      await db.update(burstsTable).set({ state: "failure" })
        .where(inArray(burstsTable.id, failedBurstIds));

      const events = failedSequences.map(({ sequenceId, burstIds }) => ({
        sequenceId,
        ...sequenceEventToDbValue({ kind: "rejected", details: { burstIds } }),
      }));
      await dbTx.insert(sequenceEventsTable).values(events);
    });
  }
  if (!payloadBursts.length) return sendNextBatchTask;

  const nonce = await getNonce();
  const calldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "exec",
    args: [payloadBursts.map(({ abiBurst }) => abiBurst)],
  });
  await db.transaction(async (dbTx) => {
    const { nextPayload: { txPayloadId } } = await registerPendingTx(dbTx, nonce, {
      target: executorAddr,
      calldata,
      gas: execGas,
    });
    await dbTx.insert(txPayloadBurstsTable).values(payloadBursts.map(
      ({ id, inclusionGas }) => ({ txPayloadId, burstId: id, inclusionGas }),
    ));
  });

  return [sendTxAttempt, sendNextBatchTask];
}

type AbiCall = { target: Address; data: Hex; gas: bigint };
type AbiBurst = { needsPrev: boolean; gas: bigint; calls: AbiCall[] };
type PayloadBurst = { id: number; abiBurst: AbiBurst; inclusionGas: bigint };

async function buildPayload(
  dbSequences: DbSequence[],
): Promise<
  {
    payloadBursts: PayloadBurst[];
    execGas: bigint;
    failedBurstIds: number[];
    failedSequences: { sequenceId: string; burstIds: number[] }[];
  }
> {
  log("Building payload");
  const payloadBursts: PayloadBurst[] = [];
  let execGas = 0n;
  const failedBurstIds: number[] = [];
  const failedSequences: { sequenceId: string; burstIds: number[] }[] = [];

  const client = getClient();
  const blockNumber = await client.getBlockNumber();
  let lastBurstInclusionGas = await getExecBaseInclusionGas();

  let outOfGasBursts = 0;
  for (const dbSequence of dbSequences) {
    log("Sequence", dbSequence.id);
    if (outOfGasBursts >= 5) break;
    let sequenceBurstsGas = 0n;
    for (const [burstIdx, dbBurst] of dbSequence.bursts.entries()) {
      log("Burst", dbBurst.id);
      let inExecStage = false;
      try {
        const nextAbiCalls: AbiCall[] = dbBurst.calls.map(
          ({ target, calldata, gas }) => ({ target, data: calldata, gas: BigInt(gas ?? 0) }),
        );
        const abiBursts = payloadBursts.map(({ abiBurst }) => abiBurst);
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
        const burstInclusionGas = execGas - gasReport[0] - lastBurstInclusionGas;
        lastBurstInclusionGas += burstInclusionGas;
        payloadBursts.push({
          id: dbBurst.id,
          abiBurst: nextAbiBurst,
          inclusionGas: burstInclusionGas,
        });
        execGas = nextExecGas;
        log("Accepted");
      } catch (error) {
        if (!matchViemError(error, ContractFunctionRevertedError, ExecutionRevertedError)) {
          throw error;
        }
        // The burst reverted or ran out of gas when executed alone,
        // with no other bursts affecting the state or using up gas.
        if ((!inExecStage && burstIdx == 0) || (inExecStage && payloadBursts.length == 0)) {
          log("Failed");
          failedSequences.push({
            sequenceId: dbSequence.id,
            burstIds: dbSequence.bursts.slice(burstIdx).map(({ id }) => id),
          });
          // dbSequence.bursts.slice(burstIdx).forEach(({ id }) => failedBurstIds.push(id));
          // rejectedBursts[dbSequence.id] = dbSequence.bursts.slice(burstIdx).map(({id}) => id);
        } else if (error instanceof EstimateGasExecutionError) {
          log("Out of gas");
          outOfGasBursts++;
        } else log("Rejected");
        break;
      }
    }
  }
  return { payloadBursts, execGas, failedBurstIds, failedSequences };
}

async function sendTx(
  payload: { target: Address; calldata?: Hex; value?: bigint; gas?: bigint },
): Promise<Tasks> {
  log("Sending a transaction to", payload.target);
  const nonce = await getNonce();
  await getDb().transaction((dbTx) => registerPendingTx(dbTx, nonce, payload));
  return sendTxAttempt();
}

async function registerPendingTx(
  dbTx: PostgresJsDatabase,
  nonce: number,
  { target, calldata, value, gas }: {
    target: Address;
    calldata?: Hex;
    value?: bigint;
    gas?: bigint;
  },
): Promise<PendingTxs> {
  const client = getClient();
  const payload = { target, calldata: calldata ?? toHex(""), value, gas };
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
    .values(payload).returning({ txPayloadId: txPayloadsTable.id });
  const pendingTxs = { txSenderId, nonce, txHashes: [], nextPayload: { txPayloadId, ...payload } };
  setPendingTxs(pendingTxs);
  return pendingTxs;
}

function sendTxAttempt(): Promise<Tasks> {
  console.log("Sending TX attempt");
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
  getPendingTxs().nextPayload = await getBurnPayload();

  log("Burning nonce", getPendingTxs().nonce);
  if (!delayMs) delayMs = 1_000;
  else {
    await delay(delayMs);
    delayMs *= 10;
    const maxDelayMs = 60_000;
    if (delayMs > maxDelayMs) {
      delayMs = maxDelayMs;
      // Break the perpetual fees incrase
      delete getPendingTxs().lastFees;
    }
  }
  return sendTxRaw(burnNonce);
}

async function sendTxRaw(retryTask: Task): Promise<Tasks> {
  const client = getClient();
  const {
    txHashes,
    txSenderId,
    nonce,
    nextPayload: { txPayloadId, target, calldata, value, gas },
  } = getPendingTxs();
  log("Attempting to send a transaction to", target);
  const request = await client.prepareTransactionRequest(
    { nonce, to: target, data: calldata, value, gas },
  );

  const fees = increasedFees(request);
  Object.assign(request, fees);
  getPendingTxs().lastFees = fees;

  const signedTx = await client.signTransaction(request);
  txHashes.push(keccak256(signedTx));
  await getDb().insert(txsTable).values({ txHash: keccak256(signedTx), txSenderId, txPayloadId });

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
  if (pendingTxs && pendingTxs.nextPayload !== await getBurnPayload()) {
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
        await finalizeTxs(receipt);
        return;
      }
      break;
    }

    if (!receipt && await getNonce() > nonce) {
      const blockNumber = await client.getBlockNumber();
      skipOnBlock ??= blockNumber + confirmations;
      if (blockNumber >= skipOnBlock) {
        await skipTx();
        return;
      }
    } else {
      skipOnBlock = undefined;
    }

    if (!receipt && !skipOnBlock && attempt >= miningTimeBlocks) return onPending;

    await delay(blockTimeMs);
  }
}

async function finalizeTxs(receipt: TransactionReceipt) {
  log("Finalizing transaction", receipt.transactionHash, "with status", receipt.status);
  const { txSenderId } = getPendingTxs();
  setPendingTxs(undefined);

  await getDb().transaction(async (dbTx) => {
    await dbTx.update(txsTable).set({ state: "skipped" }).where(
      eq(txsTable.txSenderId, txSenderId),
    );
    const statusToState: Record<
      TransactionReceipt["status"],
      (typeof txStateEnum.enumValues)[number]
    > = { success: "success", reverted: "reverted" };
    await dbTx.update(txsTable)
      .set({ state: statusToState[receipt.status] })
      .where(eq(txsTable.txHash, receipt.transactionHash));

    const executedBursts: {
      sequenceId: string;
      burstId: number;
    }[] = await dbTx.select({
      sequenceId: burstsTable.sequenceId,
      burstId: burstsTable.id,
    })
      .from(txsTable)
      .innerJoin(txPayloadBurstsTable, eq(txPayloadBurstsTable.txPayloadId, txsTable.txPayloadId))
      .innerJoin(burstsTable, eq(burstsTable.id, txPayloadBurstsTable.burstId))
      .where(eq(txsTable.txHash, receipt.transactionHash))
      .orderBy(txPayloadBurstsTable.id);
    log("Got", executedBursts.length, "bursts finalized");
    if (!executedBursts.length) return;

    const { topics, data } = receipt.logs.at(-1)!;
    const { gasReport } = decodeEventLog({ abi: executorAbi, eventName: "Receipt", topics, data })
      .args as unknown as { gasReport: bigint[] };
    if (gasReport.length !== executedBursts.length + 1) throw Error("Invalid gas report");

    const successBursts: number[] = [];
    const failureBursts: number[] = [];
    for (const [burstIdx, { burstId }] of executedBursts.entries()) {
      (gasReport[burstIdx + 1] > 0 ? successBursts : failureBursts).push(burstId);
    }
    if (successBursts.length) {
      await dbTx.update(burstsTable).set({ state: "success" })
        .where(inArray(burstsTable.id, successBursts));
    }
    if (failureBursts.length) {
      await dbTx.update(burstsTable).set({ state: "failure" })
        .where(inArray(burstsTable.id, failureBursts));
    }
  });
}

async function skipTx(): Promise<undefined> {
  log("Skipping transaction");
  const { txSenderId } = getPendingTxs();
  setPendingTxs(undefined);
  await getDb().update(txsTable).set({ state: "skipped" })
    .where(eq(txsTable.txSenderId, txSenderId));
}
