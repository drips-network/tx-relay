import { Application, Context, Router } from "oak";
import { delay } from "async";
import { z } from "zod";
import {
  Abi,
  Address,
  BaseError,
  concat,
  decodeEventLog,
  type DecodeEventLogReturnType,
  ExecutionRevertedError,
  FeeCapTooLowError,
  FeeValues,
  getAddress,
  getContractAddress,
  Hex,
  hexToBytes, InsufficientFundsError,
  isAddress,
  isHex,
  keccak256,
  NonceTooHighError,
  NonceTooLowError,
  pad,
  stringToHex,
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
import { it } from "zod/v4/locales";
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

const workerContext = new AsyncLocalStorage<{ wallet: Wallet }>();

const getWallet = () => workerContext.getStore()!.wallet;

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
  const pendingTxs = txs.map(({ txHash }) => txHash!);

  const onPending = senderAddr === wallet.account.address
    // Any transactions still pending are probably outdated. Burn the nonce to prevent mining them.
    ? () => burnNonce({ pendingTxs, txSenderId, nonce })
    // The nonce can't be burned. Assume that the transactions are forgotten and won't be mined.
    : () => skipTx(txSenderId);
  return [
    () => watchTxs({pendingTxs, txSenderId, nonce, onPending}),
    cleanUpPendingTxs
  ];

  // { pendingTxs, txSenderId, nonce, onPending }: {
  //   pendingTxs: Hex[];
  //   txSenderId: number;
  //   nonce: number;
  //   onPending: Task;
  // }

  // txHashes = txs.map(({txHash}) => txHash)
  //   return [
  //     () =>
  //     restoreTxs
  //   ]
  // }

  // db.select()
  // - fetch all from txsTable for sender ID
  //     where senderId is min senderID on the current chain
  //        where exists TX with state is pending and the
  //    sorted by tx ID
  // - watch TXs
  //      if the wallet is the same, onPending = burn
  //      else onPending = skipTx(txSenderId)
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
// - handle out-of-funds
// - make the current batch a global context state
// ? unify burn and sendTxAttempt?
// - fetch calls from DB and publish them all
// - log for bursts in DB
// - add tests?
// - handle the client errors
// - more errors handling
// - build batches

async function sendTx(
  { target, calldata, value }: {
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
    .values({ target, calldata }).returning({ txPayloadId: txPayloadsTable.id });

  return () =>
    sendTxAttempt({
      retries: 2,
      pendingTxs: [],
      txSenderId,
      nonce,
      txPayloadId,
      target,
      calldata,
      value,
    });
}

function txCost({ value, gas, gasPrice, maxFeePerGas }: {
  value?: bigint;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
}): bigint {
  return (value ?? 0n) + (gas ?? 0n) * (maxFeePerGas ?? gasPrice ?? 0n);
}

function increasedFees(fees: FeeValues, lastFees?: FeeValues): FeeValues {
  const increasePercent = 10n; // TODO take increase from wallet
  const increaseFee = (fee?: bigint, lastFee?: bigint): bigint | undefined => {
    if(fee === undefined || lastFee === undefined) return fee;
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

async function sendTxAttempt(
  { retries, pendingTxs, txSenderId, nonce, lastFees, txPayloadId, target, calldata, value }: {
    retries: number;
    pendingTxs: Hex[];
    txSenderId: number;
    nonce: number;
    lastFees?: FeeValues,
    txPayloadId: number;
    target: Address;
    calldata?: Hex;
    value?: bigint;
  },
): Promise<Tasks> {
  log("Attempting to send a transaction to", target, "with", retries, "retries left");

  // TODO deduplicate probably vvvvvvv
  const wallet = getWallet();
  const request = await wallet.prepareTransactionRequest({
    to: target,
    data: calldata,
    value,
    nonce,
  });
  const fees = increasedFees(request, lastFees);
  Object.assign(request, fees);

  // TODO when not enough funds: if pendingTxs - burn nonce, if !pendingTxs || burning - wait for funds
  const signedTx = await wallet.signTransaction(request);
  pendingTxs.push(keccak256(signedTx));

  await db.insert(txsTable).values({ txHash: keccak256(signedTx), txSenderId, txPayloadId });

  const burnNonceTask = () => burnNonce({ pendingTxs, txSenderId, nonce, lastFees: fees });
  const sendAgainTask =
    retries
      ? () => sendTxAttempt({
        retries: retries - 1,
        pendingTxs,
        txSenderId,
        nonce,
        lastFees: fees,
        txPayloadId,
        target,
        calldata,
        value,
      })
      : burnNonceTask;
  const waitForBalanceTask = () => waitForBalance({ minBalance: txCost(request), pendingTxs, txSenderId, nonce });

  try {
    await wallet.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (error) {
    if (!(error instanceof BaseError)) throw error;
    if (error.walk(e => e instanceof ExecutionRevertedError)) return burnNonceTask;
    else if (error.walk(e => e instanceof FeeCapTooLowError)) return sendAgainTask;
    else if (error.walk(e => e instanceof NonceTooLowError)) {}
    else if (error.walk(e => e instanceof InsufficientFundsError)) return [ burnNonceTask, waitForBalanceTask ];
    else {
      throw error;
    }
  }

  return () => watchTxs({ pendingTxs, nonce, txSenderId, onPending: sendAgainTask });
  // TODO deduplicate probably ^^^^^^^
}

const burnTarget: Address = getAddress(stringToHex("Nonce burning target"));
const burnTxPayloadId: number = (await db.insert(txPayloadsTable)
  .values({ target: burnTarget }).returning({ burnTxPayloadId: txPayloadsTable.id }))[0]
  .burnTxPayloadId;

async function burnNonce(
  { pendingTxs, txSenderId, lastFees, nonce, delayMs }: {
    pendingTxs: Hex[];
    txSenderId: number;
    lastFees?: FeeValues,
    nonce: number;
    delayMs?: number;
  },
): Promise<Tasks> {
  log("Burning nonce", nonce);
  if (!delayMs) delayMs = 1_000;
  else {
    await delay(delayMs);
    delayMs = Math.min(delayMs * 10, 60_000);
    // TODO if max delay reached, stop requiring +10% gas price
  }

  // TODO deduplicate probably vvvvvvv
  const wallet = getWallet();
  const request = await wallet.prepareTransactionRequest({ to: burnTarget, nonce });
  const fees = increasedFees(request, lastFees);
  Object.assign(request, fees);

  const signedTx = await wallet.signTransaction(request);
  pendingTxs.push(keccak256(signedTx));

  const txPayloadId = burnTxPayloadId;
  await db.insert(txsTable).values({  txHash: keccak256(signedTx),  txSenderId,  txPayloadId });

  const burnNonceTask = () => burnNonce({ pendingTxs, txSenderId, nonce, lastFees: fees });
  const sendAgainTask = burnNonceTask;

  // TODO errors (not enough funds)
  // TODO when not enough funds: if pendingTxs - burn nonce, if !pendingTxs || burning - wait for funds
  try {
    await wallet.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (error) {
    if (!(error instanceof BaseError)) throw error;
    if (error.walk(e => e instanceof ExecutionRevertedError)) return burnNonceTask;
    else if (error.walk(e => e instanceof FeeCapTooLowError)) return sendAgainTask;
    else if (error.walk(e => e instanceof NonceTooLowError)) {}
    else if (error.walk(e => e instanceof InsufficientFundsError))
      return () => waitForBalance({ minBalance: txCost(request), pendingTxs, txSenderId, nonce });
    else throw error;
  }

  return () => watchTxs({ pendingTxs, txSenderId, nonce, onPending: sendAgainTask });
  // TODO deduplicate probably ^^^^^^^
}

async function waitForBalance({ minBalance, pendingTxs, txSenderId, nonce }: {
  minBalance: bigint;
  pendingTxs: Hex[];
  txSenderId: number;
  nonce: number;
}): Promise<Tasks> {
  const wallet = getWallet();
  while(await wallet.getBalance({ address: wallet.account.address }) < minBalance) {
    log("Waiting for balance to be over", minBalance, "for address", wallet.account.address);
    await delay(10_000);
  }
  if(pendingTxs.length) return watchTxs({
    pendingTxs, txSenderId, nonce,
    onPending: () => burnNonce({ pendingTxs, txSenderId, nonce })
  })


  // if sendTxAttempt -> burn (may cause waitFOrFunds), if success: wait, don't burn
  // if burnNonce     -> wait, burn

  // sendTx(F) - [watch(burn): burn(F) -> wait(burnTxFee) - watch(burn), wait(lastTxFee) - watch(burn)]
  // sendTx(F) - [watch(burn): burn(K), wait(lastTxFee)]

  // sendTx(F) - [watch(burn): burn(F) -> wait(burnTxFee) {if pendingTxs: watch(burn)}, wait(sendTxFee){if pendingTxs: watch(burn)}]
  // sendTx(F) - [watch(burn): burn(K), wait(lastTxFee)]

  // sendTx(F)-> [watch(burn), wait(sendTxFee){if pendingTxs: watch(burn)}]
  // THEN
  // burn(F)-> [watch(burn), wait(sendTxFee){if pendingTxs: watch(burn)}]
  // watch(burn)(F)-> [watch(burn), wait(sendTxFee){if pendingTxs: watch(burn)}]
  // OR



}

async function watchTxs(
  { pendingTxs, txSenderId, nonce, onPending }: {
    pendingTxs: Hex[];
    txSenderId: number;
    nonce: number;
    onPending: Task;
  },
): Promise<Tasks> {
  const wallet = getWallet();
  let skipOnBlock;
  for (let attempt = 0; true; attempt++) {
    log("Watching transactions for nonce", nonce, "attempt", attempt);
    let receipt;
    for (const hash of pendingTxs.toReversed()) {
      try {
        receipt = await wallet.getTransactionReceipt({ hash });
      } catch (error) {
        continue;
      }
      if (await wallet.getBlockNumber() >= receipt.blockNumber + wallet.confirmations) {
        pendingTxs.splice(0);
        await finalizeTxs(txSenderId, receipt);
        return;
      }
      break;
    }

    if (!receipt && await wallet.getTransactionCount({ address: wallet.account.address }) > nonce) {
      const blockNumber = await wallet.getBlockNumber();
      skipOnBlock ??= blockNumber + wallet.confirmations;
      if (blockNumber >= skipOnBlock) {
        pendingTxs.splice(0);
        await skipTx(txSenderId);
        return;
      }
    } else {
      skipOnBlock = undefined;
    }

    if (!receipt && !skipOnBlock && attempt >= 10) return onPending; // TODO config

    await delay(10_000); // TODO 1 block
  }
}

async function finalizeTxs(txSenderId: number, receipt: TransactionReceipt) {
  log("Finalizing transaction", receipt.transactionHash, "with status", receipt.status);
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

async function skipTx(txSenderId: number): Promise<undefined> {
  log("Skipping transaction");
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
