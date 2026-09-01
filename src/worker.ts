import { delay } from "async";
import {
  Abi,
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
} from "./db/schema.ts";
import { ChainConfig, Client } from "./config.ts";
import { executorAbi, executorBytecode } from "./contracts.generated.ts";

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

type PendingTxs = {
  txSenderId: number;
  nonce: number;
  txHashes: Hex[];
  nextPayload?: {
    txPayloadId: number;
    target: Address;
    calldata?: Hex;
    gas?: bigint;
    isBurn?: true;
  };
};

type WorkerContext = {
  chainConfig: ChainConfig;
  db: PostgresJsDatabase;
  pendingTxs?: PendingTxs;
  execBaseInclusionGas?: bigint;
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
    await workerContext.run({ chainConfig, db }, async () => {
      try {
        log("Worker started with a fresh state");
        const tasks: Task[] = [initRelay];
        while (true) {
          const task = tasks.pop();
          if (!task) throw Error("Task queue empty");
          const newTasks = await task();
          tasks.push(...[newTasks ?? []].flat().reverse());
        }
      } catch (error) {
        log("Worker crashed with error:", error);
      }
      const { workerRestartDelayMs } = getChainConfig();
      log("Worker will restart in", workerRestartDelayMs / 1000, "seconds");
      await delay(workerRestartDelayMs);
    });
  }
}

async function initRelay(): Promise<Tasks> {
  const isDeployed = (address: Address) => getClient().getCode({ address });
  if (!await isDeployed(singletonFactory)) {
    throw new Error("Singleton factory not deployed at " + singletonFactory);
  }
  if (await isDeployed(executorAddr)) return cleanUpPendingTxs;
  return [
    // Deploy Executor
    () => sendTx({ target: singletonFactory, calldata: concat([executorSalt, executorBytecode]) }),
    // Re-check if Executor is deployed
    async () => {
      if (!await isDeployed(executorAddr)) throw new Error("Failed to deploy Executor");
      return cleanUpPendingTxs;
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
    txHashes: txs.map(({ txHash }) => txHash),
  });

  // Any transactions still pending are probably outdated. Burn the nonce to prevent mining them.
  // If the nonce can't be burned, assume that the transactions are forgotten and won't be mined.
  const onPending = senderAddr === client.account.address ? burnNonce : finalizeTx;
  return [() => watchTxs({ onPending }), cleanUpPendingTxs];
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

  const { submittedSequences, execGas, rejectedSequences } = await buildNextBatch(dbSequences);
  if (rejectedSequences.length) {
    await db.transaction(async (dbTx) => {
      const failedBurstIds = rejectedSequences.map(({ burstIds }) => burstIds).flat();
      await dbTx.update(burstsTable).set({ state: "failure" })
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
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  let lastBurstInclusionGas = await getExecBaseInclusionGas();

  let outOfGasBursts = 0;
  for (const dbSequence of dbSequences) {
    if (outOfGasBursts >= 5) break;
    log("Attempting adding sequence", dbSequence.id, "to the batch");
    let sequenceBurstsGas = 0n;
    for (const [burstIdx, dbBurst] of dbSequence.bursts.entries()) {
      let onRevert: "reject" | "outOfGas" | "skip" = burstIdx == 0 ? "reject" : "skip";
      try {
        const nextAbiCalls: AbiCall[] = dbBurst.calls.map(
          ({ target, calldata, gas }) => ({ target, data: calldata, gas: BigInt(gas ?? 0) }),
        );
        const abiBursts = submittedSequences.flatMap((sequence) => sequence.bursts)
          .map((burst) => burst.abiBurst);
        const abiSequenceBursts = abiBursts.slice(abiBursts.length - burstIdx);

        // If the next burst runs out of available gas when executed in the sequence,
        // it's treated as a revert, and isn't counted as out of gas.
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
        onRevert = submittedSequences.length == 0 ? "reject" : "outOfGas";
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
  return { submittedSequences, execGas, rejectedSequences };
}

async function sendTx(payload: { target: Address; calldata?: Hex; gas?: bigint }): Promise<Tasks> {
  log("Sending a transaction to", payload.target);
  const nonce = await getNonce();
  await getDb().transaction((dbTx) => registerPendingTx(dbTx, nonce, payload));
  return sendTxAttempt();
}

// Must be called when there's no pending TX set.
async function registerPendingTx(
  dbTx: PostgresJsDatabase,
  nonce: number,
  { target, calldata, gas }: { target: Address; calldata?: Hex; gas?: bigint },
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
    .values({ txSenderId, target, calldata, gas }).returning({ txPayloadId: txPayloadsTable.id });
  setPendingTxs({
    txSenderId,
    nonce,
    txHashes: [],
    nextPayload: { txPayloadId, target, calldata, gas },
  });
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

async function increasedFees(fees: FeeValues): Promise<FeeValues | null> {
  const client = getClient();
  let lastTx;
  for (const hash of getPendingTxs().txHashes.toReversed()) {
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
  const pendingTxs = getPendingTxs();
  if (!pendingTxs.nextPayload?.isBurn) await registerPendingBurnTx();

  log("Burning nonce", pendingTxs.nonce);
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
  const {
    txHashes,
    nonce,
    nextPayload,
  } = getPendingTxs();
  if (!nextPayload) throw Error("No payload set to send");
  const { txPayloadId, target, calldata, gas } = nextPayload;

  log("Attempting to send a transaction to", target);
  const request = await client.prepareTransactionRequest(
    { nonce, to: target, data: calldata, gas },
  );

  const fees = await increasedFees(request);
  if (!fees) return watchTxs({ onPending: retryTask });
  Object.assign(request, fees);

  const signedTx = await client.signTransaction(request);
  const txHash = keccak256(signedTx);
  txHashes.push(txHash);
  await getDb().insert(txsTable).values({ txHash, txPayloadId });

  try {
    await client.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (error) {
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
    } else throw error;
  }
  return () => watchTxs({ onPending: retryTask });
}

async function waitForBalance(minBalance: bigint): Promise<Tasks> {
  const pendingTxs = getWorkerContext().pendingTxs;
  if (pendingTxs && !pendingTxs.nextPayload?.isBurn) {
    return [burnNonce, () => waitForBalance(minBalance)];
  }
  const { client, waitForBalanceRetryDelayMs } = getChainConfig();
  while (await client.getBalance({ address: client.account.address }) < minBalance) {
    log("Waiting for the balance to be at least", minBalance, "for wallet", client.account.address);
    await delay(waitForBalanceRetryDelayMs);
  }
  if (pendingTxs) return watchTxs({ onPending: burnNonce });
}

async function watchTxs(
  { onPending }: {
    onPending: Task;
  },
): Promise<Tasks> {
  const pendingTxs = getPendingTxs();
  const config = getChainConfig();
  const client = config.client;
  const txHashes = pendingTxs.txHashes.toReversed();
  const confirmations = BigInt(config.confirmations);
  let nonceSkipConfirmed = false;
  const onPendingFromBlock = await client.getBlockNumber() + BigInt(config.inclusionWaitBlocks);
  retry: while (true) {
    log("Watching transactions for nonce", pendingTxs.nonce);
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
        return () => finalizeTx(receipt);
      }
      await delayUntilBlockNumber(confirmedFromBlock);
      txHashes.splice(hashIdx, 1);
      txHashes.unshift(hash);
      nonceSkipConfirmed = false;
      continue retry;
    }

    if (await getNonce() > pendingTxs.nonce) {
      if (nonceSkipConfirmed) return finalizeTx;
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
    poll: true,
    pollingInterval: getChainConfig().delayUntilBlockNumberPollingIntervalMs,
    onBlockNumber: (blockNumber: bigint) => {
      if (blockNumber >= targetBlockNumber) resolve(blockNumber);
    },
    onError: (error) => reject(error),
  });
  return promise.finally(() => unwatch());
}

async function finalizeTx(receipt?: TransactionReceipt): Promise<undefined> {
  log("Finalizing transaction", receipt?.transactionHash ?? "skipping");
  if (receipt?.status === "reverted") log("Transaction", receipt.transactionHash, "has reverted");
  const { txSenderId, txHashes } = getPendingTxs();
  setPendingTxs(undefined);

  await getDb().transaction(async (dbTx) => {
    const skippedTxs = txHashes.filter((hash) => hash !== receipt?.transactionHash);
    if (skippedTxs.length) {
      await dbTx.update(txsTable).set({ state: "skipped" })
        .where(inArray(txsTable.txHash, skippedTxs));
    }

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

    if (receipt?.status !== "success" || !executedBursts.length) {
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

    const lastLog = receipt.logs.at(-1)!;
    const { gasReport } = decodeEventLog({
      abi: executorAbi,
      eventName: "Receipt",
      topics: lastLog.topics,
      data: lastLog.data,
    })
      .args as unknown as { gasReport: bigint[] };
    if (gasReport.length !== executedBursts.length + 1) throw Error("Invalid gas report");

    const successBursts: number[] = [];
    const failureSequences: string[] = [];
    const executedEvents: {
      sequenceId: string;
      details: { fromIdxInSequence: number; successes: number; failed: boolean };
    }[] = [];
    for (const [burstIdx, { burstId, sequenceId, idxInSequence }] of executedBursts.entries()) {
      if (executedEvents.at(-1)?.sequenceId !== sequenceId) {
        const details = { fromIdxInSequence: idxInSequence, successes: 0, failed: false };
        executedEvents.push({ sequenceId, details });
      }
      const executedEvent = executedEvents.at(-1)!;
      if (gasReport[burstIdx + 1] > 0) {
        successBursts.push(burstId);
        executedEvent.details.successes++;
      } else {
        if (failureSequences.at(-1) !== sequenceId) failureSequences.push(sequenceId);
        executedEvent.details.failed = true;
      }
    }
    if (successBursts.length) {
      await dbTx.update(burstsTable).set({ state: "success" })
        .where(inArray(burstsTable.id, successBursts));
    }
    if (failureSequences.length) {
      await dbTx.update(burstsTable).set({ state: "failure" }).where(and(
        inArray(burstsTable.sequenceId, failureSequences),
        eq(burstsTable.state, "pending"),
      ));
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
