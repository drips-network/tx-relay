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
const executorSalt = pad("0x00");
const executorAddr = getContractAddress({
  from: singletonFactory,
  opcode: "CREATE2",
  bytecode: executorBytecode,
  salt: executorSalt,
});

// async function sendSingleTxOld(wallet, target, calldata) {
//   const nonce = await wallet.getTransactionCount({ address: wallet.account.address });

//   const request = await wallet.prepareTransactionRequest({ to: target, data: calldata, nonce });
//   const signedTx = await wallet.signTransaction(request);
//   const {txSenderId, txPayloadId} = await db.transaction(async (dbTx) => {
//     const [{txSenderId}] = await dbTx.insert(txSendersTable) .values({ address: wallet.account.address , nonce, chainId: wallet.chain.id})
//       .returning({txSenderId: txSendersTable.id});
//     const [{txPayloadId}] = await dbTx.insert(txPayloadsTable)
//       .values({target, calldata}).returning({txPayloadId: txPayloadsTable.id});
//     await dbTx.insert(txsTable).values({ txHash: keccak256(signedTx), txSenderId, txPayloadId });
//     return {txSenderId, txPayloadId};
//   });
//   const txs = {    nonce, hashes: [keccak256(signedTx)]}; // lastGasPrice?
//   await wallet.sendRawTransaction({ serializedTransaction: signedTx }); // TODO errors
//   // queue branch

//   const {status, receipt} = await watchTxs(wallet, txs);
//   if(status === "submitted") { // && txs.hashes < attempts
//     // Retry
//     // await db.insert(txsTable).values({ txHash: keccak256(signedTx), txSenderId, txPayloadId });
//     // const txs = {    nonce, hashes: [keccak256(signedTx)]};
//     // await wallet.sendRawTransaction({ serializedTransaction: signedTx })
//   }
//   await db.transaction(async (dbTx) => {
//     await dbTx.update(txsTable).set({state: 'skipped'}).where(eq(txsTable.txSenderId, txSenderId));
//     if(status == "mined") {
//         const statusToState: Record<TransactionReceipt["status"], (typeof txStateEnum.enumValues)[number]>
//           = { success: "success", reverted: "reverted" };
//         await db.update(txsTable)
//           .set({state: statusToState[receipt.status]})
//           .where(eq(txsTable.txHash, hexToBytes(receipt.transactionHash)));
//       }
//   });
// }

// A sender is "parked":
// - not enough funds for a TX retrial
// - When sending a TX fails weirdly - bump price by 10% - when still fails, park
// - total RPC failure
// after "unparked" - total restart (burn nonce in a loop IF there's a sender in DB)
//
// - when after TX estimation not enough funds - burn nonce, get in loop of checking own balance increase
// - when after burn TX estimation not enough funds - get in loop of checking own balance increase, burn nonce
//
// - send TX to all RPCs?
//
// MAIN LOOP
// - check pending nonce -> burn nonce (if mined -> clean up calls) (if not enough funds -> error, main loop)
// - check not enough funds -> wait for funds
// - db get calls (if nothing, sleep, repeat)
// - build batch
// - send batch (if not enough funds on 1st attempt -> wait for funds) (if not enough funds  on 2nd attempt -> burn())
//    burn() ->
//      - send burn TX (forever loop)
//      - if not enough funds - wait for funds
//      - if success - clear DB
//
// QUEUE:
// - wait for balance (minBalance)
// ? sleep for (blocks | seconds | until)
// - burn nonce (nonce)
// - send TX
// - send a new batch
// - check TXs state (wallet, nonce?)

// for (let attempt = 0; true; attempt++) {

//     const request = await wallet.prepareTransactionRequest({ to: target, data: calldata, nonce });
//     const signedTx = await db.transaction(async (dbTransaction) => {

//       signRawTx(dbTransaction, wallet, request));
//     }
//     result = sendRawTx(wallet, txs, signedTx);
//     if(result == "mined") return result
// }
// return burnNonce(confirmations, txs)

// async function signRawTx(dbTransaction, wallet, request, txsSenderId, txPayloadId) {
//   const signedTx = await wallet.signTransaction(request);
//   await dbTransaction.insert(txSendersTable)
//     .values({ address: request.from , nonce: request.nonce, chainId: request.chainId})
//     .onConflictDoNothing();
//   const txSenderId = dbTransaction.select({ id: txSendersTable.id }).from(txSendersTable)
//     .where(and(eq(txSendersTable.address, request.from),
//       eq(txSendersTable.nonce, request.nonce), eq(txSendersTable.chainId, request.chainId)));
//   await dbTransaction.insert(txsTable).values({ txSenderId, txHash: keccak256(signedTx) });
//   return {signedTx, txsSenderId, txPayloadId};
// }

// async function sendRawTx(wallet, txs, signedTx) {
//   txs.hashes.push(keccak256(signedTx));
//   await wallet.sendRawTransaction({ serializedTransaction: signedTx }); // TODO errors
//   return watchTxs(wallet, txs);
// }

// async function watchTxsOld(wallet, txs) {
//   let skipOnBlock;
//   for(let attempt = 0; true; attempt++) {
//     let receipt;
//     for (const hash of txs.hashes.toReversed()) {
//         try {
//           receipt = await wallet.getTransactionReceipt({ hash });
//         } catch(error) {continue;}
//         if (receipt.blockNumber + wallet.confirmations >= await wallet.getBlockNumber())
//           return {status: "mined", receipt};
//         break;
//     }

//     if(!receipt && await wallet.getTransactionCount({ address: wallet.account.address }) > txs.nonce) {
//       const blockNumber = await wallet.getBlockNumber();
//       skipOnBlock ??= blockNumber + wallet.confirmations;
//       if(blockNumber >= skipOnBlock) return {status: "skipped"}
//     }
//     else
//       skipOnBlock = undefined;

//     if(!receipt && !skipOnBlock && attempt >= 10) return {status: "pending"}; // TODO config

//     await delay(10_000); // TODO per-chain config
//   }
// }

// make sure that the price bump is 10% or more
// make sure that the wallet has enough funds

//  sendRawTx(confirmations, txs, tx) -> "mined"(receipt) | "unknown" | "skipped" | "notEnoughFunds"
//      newTxs = txs + tx
//      send_raw_tx(tx)
//      result = mineTxs(newTxs, confirmations)
//      if(result != "unknown") db.tx.state = success
//       return (newTxs, result)

const workerContext = new AsyncLocalStorage<{wallet: Wallet}>();

const getWallet = () => workerContext.getStore()!.wallet;

function log(...message: unknown[]) {
  const timestamp = new Date().toISOString();
  const chain = workerContext.getStore()!.wallet.chain.name;
  console.log(`${timestamp} [${chain}]:`, ...message);
}

type Tasks = Task[] | Task | undefined;
type Task = () => Promise<Tasks>;

async function runWalletWorker(wallet: Wallet) {
  workerContext.run({wallet}, async () =>{
    log("Worker started");
    const tasks: Task[] = [() => initRelay()];
    while (tasks.length) {
      const newTasks = await tasks.pop()!();
      tasks.push(...[newTasks ?? []].flat().reverse());
    }
    log("Stopping worker for chain", wallet.chain.name);
  });
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
    log("Executor still running");
    await delay(2_000);
  }
}

// - log in terminal
// - run it once
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
    let receipt;
    for (const hash of pendingTxs.toReversed()) {
      try {
        receipt = await wallet.getTransactionReceipt({ hash });
      } catch (error) {
        continue;
      }
      if (receipt.blockNumber + wallet.confirmations >= await wallet.getBlockNumber()) {
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
