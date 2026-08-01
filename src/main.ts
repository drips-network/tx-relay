import { Application, Context, Router } from "oak";
import { delay } from "async";
import { z } from "zod";
import {
  Abi,
  Address,
  BaseError,
  concat,
  decodeEventLog,
  ExecutionRevertedError,
  FeeCapTooLowError,
  FeeValues,
  getAddress,
  getContractAddress,
  Hex,
  InsufficientFundsError,
  isAddress,
  isHex,
  keccak256,
  NonceTooLowError,
  pad,
  stringToHex,
  toHex,
  TransactionReceipt,
} from "viem";

//------------------------------------------------
//
import { and, eq, inArray, min, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { AsyncLocalStorage } from "node:async_hooks";
// import { usersTable } from "./db/schema.ts";
import {
  batchBurstsTable,
  batchesTable,
  burstsTable,
  callsTable,
  sequencesTable,
  txPayloadsTable,
  txSendersTable,
  txsTable,
  txStateEnum,
} from "./db/schema.ts";
import { getDbUrl, getPort, getWallets, Wallet } from "./config.ts";

const db = drizzle({ connection: getDbUrl(), casing: "snake_case" });
await migrate(db, { migrationsFolder: "./drizzle" });
// const user: typeof usersTable.$inferInsert = {
//   name: "Bobby",
//   age: 120,
//   email: "bobby@bob.coM",
// };
// await db.insert(usersTable).values(user);

// const users = await db.select().from(usersTable);
// console.log("USERS", users);

// db.query.

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

type PendingTxs = {
  txSenderId: number;
  nonce: number;
  txHashes: Hex[];
  lastFees?: FeeValues;
  nextPayload: {
    txPayloadId: number;
    target: Address;
    calldata: Hex;
    value: bigint;
  };
};

// type NextPayload = {
//   lastFees?: FeeValues,
//   txPayloadId: number;
//   target: Address;
//   calldata: Hex;
//   value: bigint;
// };
//

type WorkerContext = { wallet: Wallet; pendingTxs?: PendingTxs };

const workerContext = new AsyncLocalStorage<WorkerContext>();

function getWorkerContext(): WorkerContext {
  const contextStore = workerContext.getStore();
  if(!contextStore) throw Error("No context set");
  return contextStore;
}

function getWallet(): Wallet {
  return getWorkerContext().wallet;
}

function getPendingTxs(): PendingTxs{
  const pendingTxs = getWorkerContext().pendingTxs;
  if(!pendingTxs) throw Error("No pending TXs set");
  return pendingTxs;
}

function setPendingTxs(pendingTxs?: PendingTxs) {
  const contextStore = getWorkerContext();
  if(contextStore.pendingTxs) throw Error("Pending TXs already set");
  contextStore.pendingTxs = pendingTxs;
}

function log(...message: unknown[]) {
  const worker = workerContext.getStore()?.wallet.chain.name ?? "main";
  console.log(`${new Date().toISOString()} [${worker}]:`, ...message);
}

type Task = () => Promise<Tasks>;
type Tasks = Task[] | Task | undefined;

function runWalletWorker(wallet: Wallet) {
  workerContext.run({ wallet }, async () => {
    log("Worker started");
    const tasks: Task[] = [initRelay];
    while (tasks.length) {
      const newTasks = await tasks.pop()!();
      tasks.push(...[newTasks ?? []].flat().reverse());
    }
    log("Worker stopped");
  }).catch((error) => log("Worker crashed with error:", error));
}

async function initRelay(): Promise<Tasks> {
  const isExecutorDeployed = () => getWallet().getCode({ address: executorAddr });
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
  const wallet = getWallet();
  const senderIdQuery = db.select({ id: min(txSendersTable.id) })
    .from(txSendersTable)
    .innerJoin(txsTable, eq(txsTable.txSenderId, txSendersTable.id))
    .where(and(
      eq(txSendersTable.chainId, wallet.chain.id),
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
  if (!txSender.length) return runRelay;
  const [{ txSenderId, senderAddr, nonce }] = txSender;

  const txs = await db.select({ txHash: txsTable.txHash })
    .from(txsTable)
    .where(eq(txsTable.txSenderId, txSenderId))
    .orderBy(txsTable.id);

  setPendingTxs({
    txSenderId,
    nonce,
    txHashes: txs.map(({ txHash }) => txHash!),
    nextPayload: burnPayload
  });

  // Any transactions still pending are probably outdated. Burn the nonce to prevent mining them.
  // If the nonce can't be burned, assume that the transactions are forgotten and won't be mined.
  const onPending = senderAddr === wallet.account.address ? burnNonce : skipTx;
  return [() => watchTxs({ onPending }), cleanUpPendingTxs];
}

async function runRelay(): Promise<Tasks> {
  while (true) {
    log("Relay running...");
    await delay(2_000);
  }
}

// - OSS AI orchestration - is experimenting with it
//   - there's Open Hands - not so good
//   - more fast, crappy code
//   - Currently in JS, should be RUST?

// v log in terminal
// v run it once
// v restore in-flight TXs
// v handle out-of-funds
// v make the current batch a global context state
// v unify burn and sendTxAttempt?
// x fetch calls from DB and publish them all
// - build batches
// - log for bursts in DB
// - add tests?
// - handle the client errors
// - more errors handling

async function sendTx(
  { target, calldata = toHex(""), value = 0n }: {
    target: Address;
    calldata?: Hex;
    value?: bigint;
  },
): Promise<Tasks> {
  log("Sending a transaction to", target);
  const wallet = getWallet();
  const senderAddr = wallet.account.address;
  const nonce = await wallet.getTransactionCount({ address: senderAddr });
  const chainId = wallet.chain.id;

  await db.insert(txSendersTable).values({ address: senderAddr, nonce, chainId })
    .onConflictDoNothing();
  const [{ txSenderId }] = await db.select({ txSenderId: txSendersTable.id }).from(txSendersTable)
    .where(
      and(
        and(eq(txSendersTable.address, senderAddr), eq(txSendersTable.nonce, nonce)),
        eq(txSendersTable.chainId, chainId),
      ),
    );
  const [{ txPayloadId }] = await db.insert(txPayloadsTable)
    .values({ target, calldata, value }).returning({ txPayloadId: txPayloadsTable.id });

  setPendingTxs({ txSenderId, nonce, txHashes: [], nextPayload: {txPayloadId, target, calldata, value }});

  return sendTxAttempt();
}

function sendTxAttempt(): Promise<Tasks> {
  console.log("")
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
  const increasePercent = 10n; // TODO take increase from wallet
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

const burnPayload = await (async () => {
  const target = getAddress(stringToHex("Nonce burning target"));
  const calldata = toHex("");
  const value = 0n;
  const insertedTxPayloads = await db.insert(txPayloadsTable)
    .values({ target, calldata, value }).returning({ txPayloadId: txPayloadsTable.id });
  const txPayloadId = insertedTxPayloads[0].txPayloadId;
  return { txPayloadId, target, calldata, value };
})();

async function burnNonce(delayMs?: number): Promise<Tasks> {
  getPendingTxs().nextPayload = burnPayload;

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
  const wallet = getWallet();
  const { txHashes, txSenderId, nonce, nextPayload: { txPayloadId, target, calldata, value } } = getPendingTxs();
  log("Attempting to send a transaction to", target);
  const request = await wallet.prepareTransactionRequest(
    { nonce, to: target, data: calldata, value },
  );

  const fees = increasedFees(request);
  Object.assign(request, fees);
  getPendingTxs().lastFees = fees;

  const signedTx = await wallet.signTransaction(request);
  txHashes.push(keccak256(signedTx));
  await db.insert(txsTable).values({ txHash: keccak256(signedTx), txSenderId, txPayloadId });

  try {
    await wallet.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (error) {
    if (!(error instanceof BaseError)) throw error;
    if (error.walk((e) => e instanceof ExecutionRevertedError)) return burnNonce;
    else if (error.walk((e) => e instanceof FeeCapTooLowError)) return retryTask;
    else if (error.walk((e) => e instanceof NonceTooLowError)) { /* Continue normally */ }
    else if (error.walk((e) => e instanceof InsufficientFundsError)) {
      return () => waitForBalance(txCost(request));
    } else {
      throw error;
    }
  }
  return () => watchTxs({ onPending: retryTask });
}

async function waitForBalance(minBalance: bigint): Promise<Tasks> {
  if(getPendingTxs()?.nextPayload !== burnPayload)
    return [burnNonce, () => waitForBalance(minBalance)];
  const wallet = getWallet();
  while (await wallet.getBalance({ address: wallet.account.address }) < minBalance) {
    log("Waiting for the balance to be at least", minBalance, "for wallet", wallet.account.address);
    await delay(10_000);
  }
  if (getPendingTxs()) return watchTxs({ onPending: burnNonce });
}

async function watchTxs(
  { onPending }: {
    onPending: Task;
  },
): Promise<Tasks> {
  const { txHashes, nonce } = getPendingTxs();
  const wallet = getWallet();
  let skipOnBlock;
  for (let attempt = 0; true; attempt++) {
    log("Watching transactions for nonce", nonce, "attempt", attempt);
    let receipt;
    for (const hash of txHashes.toReversed()) {
      try {
        receipt = await wallet.getTransactionReceipt({ hash });
      } catch (error) {
        continue;
      }
      if (await wallet.getBlockNumber() >= receipt.blockNumber + wallet.confirmations) {
        await finalizeTxs(receipt);
        return;
      }
      break;
    }

    if (!receipt && await wallet.getTransactionCount({ address: wallet.account.address }) > nonce) {
      const blockNumber = await wallet.getBlockNumber();
      skipOnBlock ??= blockNumber + wallet.confirmations;
      if (blockNumber >= skipOnBlock) {
        await skipTx();
        return;
      }
    } else {
      skipOnBlock = undefined;
    }

    if (!receipt && !skipOnBlock && attempt >= 10) return onPending; // TODO config

    await delay(10_000); // TODO 1 block
  }
}

async function finalizeTxs(receipt: TransactionReceipt) {
  log("Finalizing transaction", receipt.transactionHash, "with status", receipt.status);
  const { txSenderId } = getPendingTxs();
  setPendingTxs(undefined);

  await db.transaction(async (dbTx) => {
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
      .innerJoin(batchesTable, eq(batchesTable.txPayloadId, txsTable.txPayloadId))
      .innerJoin(batchBurstsTable, eq(batchBurstsTable.batchId, batchesTable.id))
      .innerJoin(burstsTable, eq(burstsTable.id, batchBurstsTable.burstId))
      .where(eq(txsTable.txHash, receipt.transactionHash))
      .orderBy(batchBurstsTable.id);
    if (!executedBursts.length) return;

    const { topics, data } = receipt.logs.at(-1)!;
    const logs = decodeEventLog({ abi: executorAbi, eventName: "Receipts", topics, data })
      .args as unknown as { receipts: { successes: bigint; gasUsed: bigint }[] };
    const successes = logs.receipts.map(({ successes }) => Number(successes));

    const sequences: { sequenceId: string; burstIds: number[]; successes: number }[] = [];
    for (const { sequenceId, burstId } of executedBursts) {
      if (sequences.at(-1)?.sequenceId !== sequenceId) {
        sequences.push({ sequenceId, burstIds: [], successes: successes.shift()! });
      }
      sequences.at(-1)!.burstIds.push(burstId);
    }

    const successBurstIds = [];
    const failedSequenceIds = [];
    for (const { sequenceId, burstIds, successes } of sequences) {
      successBurstIds.push(...burstIds.slice(0, successes));
      if (burstIds.length < successes) failedSequenceIds.push(sequenceId);
    }
    if (successBurstIds.length) {
      await dbTx.update(burstsTable).set({ state: "success" })
        .where(inArray(burstsTable.id, successBurstIds));
    }
    if (failedSequenceIds.length) {
      await dbTx.update(burstsTable).set({ state: "failure" })
        .where(and(inArray(burstsTable.sequenceId, failedSequenceIds), eq(burstsTable, "pending")));
    }
  });
}

async function skipTx(): Promise<undefined> {
  log("Skipping transaction");
  const { txSenderId } = getPendingTxs();
  setPendingTxs(undefined);
  await db.update(txsTable).set({ state: "skipped" }).where(eq(txsTable.txSenderId, txSenderId));
}

const wallets = getWallets();
Object.values(wallets).forEach(runWalletWorker);

const sendSchema = z.object({
  calls: z.array(z.object({
    target: z.string().refine(isAddress),
    calldata: z.string().refine(isHex),
  })).nonempty(),
});

const sendSequencesArgSchema = z.object({
  sequences: z.array(z.object({
    chainId: z.number().refine((chainId) => wallets[chainId], "Unsupported chain ID"),
    bursts: z.array(z.object({
      calls: z.array(z.object({
        target: z.string().refine(isAddress, "Not an address"),
        calldata: z.string().refine(isHex, "Not a valid hex value"),
      })).nonempty(),
    })).nonempty(),
  })).nonempty(),
});

const sequencesStatesArgSchema = z.object({
  sequences: z.array(z.object({
    id: z.uuid(),
  })).nonempty(),
});

async function parseJsonArg<S extends z.ZodTypeAny>(
  context: Context,
  schema: S,
): Promise<z.infer<S> | undefined> {
  try {
    return schema.parse(await context.request.body.json());
  } catch (error) {
    context.response.status = 400;
    context.response.body = error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")
      : String(error);
  }
}

const router = new Router();
router
  .post("/send-sequences", async (context) => {
    let arg = await parseJsonArg(context, sendSequencesArgSchema);
    if (arg === undefined) return;

    const sequences: { id: string }[] = [];
    await db.transaction(async (tx) => {
      for (const { chainId, bursts } of arg.sequences) {
        const [{ sequenceId }] = await tx.insert(sequencesTable)
          .values({ chainId })
          .returning({ sequenceId: sequencesTable.id });
        sequences.push({ id: sequenceId });
        for (const { calls } of bursts) {
          const [{ burstId }] = await tx.insert(burstsTable)
            .values({ sequenceId })
            .returning({ burstId: burstsTable.id });
          await tx.insert(callsTable)
            .values(calls.map(({ target, calldata }) => ({
              burstId,
              target: target,
              calldata: calldata,
            })));
        }
      }
    });

    context.response.body = { sequences };
  })
  .post("/sequences-states", async (context) => {
    let arg = await parseJsonArg(context, sequencesStatesArgSchema);
    if (arg === undefined) return;
    const sequenceIds = arg.sequences.map(({ id }) => id);

    const states = await db.select({
      sequenceId: burstsTable.sequenceId,
      pending: sql<number>`count(*) filter (where ${burstsTable.state} = 'pending')::int`,
      successes: sql<number>`count(*) filter (where ${burstsTable.state} = 'success')::int`,
      failures: sql<number>`count(*) filter (where ${burstsTable.state} = 'failure')::int`,
    })
      .from(burstsTable)
      .where(inArray(burstsTable.sequenceId, sequenceIds))
      .groupBy(burstsTable.sequenceId);
    const statesById = Object.fromEntries(states.map((state) => [state.sequenceId, state]));
    const sequences = sequenceIds.map((id) => {
      const state = statesById[id];
      return {
        id,
        total: state.pending + state.successes + state.failures,
        successes: state.successes,
        isFailed: state.failures > 0,
      };
    });

    context.response.body = { sequences };
  });

await new Application()
  .use(router.routes())
  .use(router.allowedMethods())
  .listen({ port: getPort(), hostname: "[::]" });
