import { Application, Context, Router } from "oak";
import { delay } from "async";
import { z } from "zod";
import {
  Abi,
  Address,
  concat,
  decodeEventLog,
  type DecodeEventLogReturnType,
  getAddress,
  getContractAddress,
  Hex,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  pad,
  stringToHex,
  TransactionReceipt,
} from "viem";

//------------------------------------------------
//
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { AsyncLocalStorage } from 'node:async_hooks';
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

const workerContext = new AsyncLocalStorage<{wallet: Wallet}>();

const getWallet = () => workerContext.getStore()!.wallet;

function log(...message: unknown[]) {
  const worker = workerContext.getStore()?.wallet.chain.name ?? "main";
  console.log(`${new Date().toISOString()} [${worker}]:`, ...message);
}

type Tasks = Task[] | Task | undefined;
type Task = () => Promise<Tasks>;

function runWalletWorker(wallet: Wallet) {
  workerContext.run({wallet}, async () =>{
    log("Worker started");
    const tasks: Task[] = [initRelay];
    while (tasks.length) {
      const newTasks = await tasks.pop()!();
      tasks.push(...[newTasks ?? []].flat().reverse());
    }
    log("Worker stopped");
  }).catch(error => log("Worker crashed with error:", error));
}

async function initRelay(): Promise<Tasks> {
  const isExecutorDeployed = () => getWallet().getCode({ address: executorAddr });
  if (await isExecutorDeployed()) return runRelay;
  return [
    // Deploy the executor
    () => sendTx({ target: singletonFactory, calldata: concat([executorSalt, executorBytecode]) }),
    // Re-check if the executor is deployed, and starve the worker if not
    async () => {
      if (await isExecutorDeployed()) return runRelay;
      else log("Failed to deploy the executor");
    },
  ];
}

async function runRelay(): Promise<Tasks> {
  while (true) {
    log("Relay running...");
    await delay(2_000);
  }
}

// v log in terminal
// v run it once
// - restore in-flight TXs
// - log for bursts in DB
// - fetch calls from DB and publish them all
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

async function sendTxAttempt(
  { retries, pendingTxs, txSenderId, nonce, txPayloadId, target, calldata, value }: {
    retries: number;
    pendingTxs: Hex[];
    txSenderId: number;
    nonce: number;
    txPayloadId: number;
    target: Address;
    calldata?: Hex;
    value?: bigint;
  },
): Promise<Tasks> {
  log("Attempting to send a transaction to", target, "with", retries, "retries left");
  const onPending = () =>
    retries
      ? sendTxAttempt({
        retries: retries - 1,
        pendingTxs,
        txSenderId,
        nonce,
        txPayloadId,
        target,
        calldata,
        value,
      })
      : burnNonce({ pendingTxs, txSenderId, nonce });

  // TODO deduplicate probably vvvvvvv
  const wallet = getWallet();
  if (nonce !== await wallet.getTransactionCount({ address: wallet.account.address })) {
    return () => watchTxs({ pendingTxs, txSenderId, nonce, onPending });
  }
  const request = await wallet.prepareTransactionRequest({
    to: target,
    data: calldata,
    value,
    nonce,
  });
  // TODO when not enough funds: if pendingTxs - burn nonce, if !pendingTxs || burning - wait for funds
  const signedTx = await wallet.signTransaction(request);

  await db.insert(txsTable).values({ txHash: keccak256(signedTx), txSenderId, txPayloadId });

  pendingTxs.push(keccak256(signedTx));
  await wallet.sendRawTransaction({ serializedTransaction: signedTx }); // TODO errors

  return () => watchTxs({ pendingTxs, nonce, txSenderId, onPending });
  // TODO deduplicate probably ^^^^^^^
}

const burnTarget: Address = getAddress(stringToHex("Nonce burning target"));
const burnTxPayloadId: number = (await db.insert(txPayloadsTable)
  .values({ target: burnTarget }).returning({ burnTxPayloadId: txPayloadsTable.id }))[0]
  .burnTxPayloadId;

async function burnNonce(
  { pendingTxs, txSenderId, nonce, delayMs }: {
    pendingTxs: Hex[];
    txSenderId: number;
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
  const onPending = () => burnNonce({ pendingTxs, txSenderId, nonce, delayMs });

  // TODO deduplicate probably vvvvvvv
  const wallet = getWallet();
  const request = await wallet.prepareTransactionRequest({ to: burnTarget, nonce });
  const signedTx = await wallet.signTransaction(request);

  await db.insert(txsTable).values({
    txHash: keccak256(signedTx),
    txSenderId,
    txPayloadId: burnTxPayloadId,
  });

  pendingTxs.push(keccak256(signedTx));
   // TODO errors (not enough funds / used up nonce)
  // TODO when not enough funds: if pendingTxs - burn nonce, if !pendingTxs || burning - wait for funds
  await wallet.sendRawTransaction({ serializedTransaction: signedTx });

  return () => watchTxs({ pendingTxs, txSenderId, nonce, onPending });
  // TODO deduplicate probably ^^^^^^^
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
        await finalizeTxs(txSenderId, receipt);
        return;
      }
      break;
    }

    if (!receipt && await wallet.getTransactionCount({ address: wallet.account.address }) > nonce) {
      const blockNumber = await wallet.getBlockNumber();
      skipOnBlock ??= blockNumber + wallet.confirmations;
      if (blockNumber >= skipOnBlock) {
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

async function skipTx(txSenderId: number) {
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
