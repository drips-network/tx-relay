import { Application, Router } from "oak";
import { z } from "zod";
import { concat, getContractAddress, Hex, isHex, pad } from "viem";

//------------------------------------------------
//
import { drizzle } from "drizzle-orm/postgres-js";
import { usersTable } from "./db/schema.ts";
import { getDbUrl, getMulticall3s, getPort, getWallets } from "./config.ts";

// const db = drizzle({connection: getDbUrl(), casing: "snake_case"});
// const user: typeof usersTable.$inferInsert = {
//   name: "Bobby",
//   age: 120,
//   email: "bobby@bob.coM",
// };
// await db.insert(usersTable).values(user);

// const users = await db.select().from(usersTable);
// console.log("USERS", users);

// db.query.

import batcherOutputJson from "./Batcher.generated.json" with { type: "json" };
const { abi: batcherAbi, bytecode: { object: batcherBytecode } } = batcherOutputJson;

const wallets = getWallets();

const create2Factory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const batcherSalt = pad("0x00");
const batcherAddr = getContractAddress({
  from: create2Factory,
  opcode: "CREATE2",
  bytecode: batcherBytecode,
  salt: batcherSalt,
});

for (const wallet of Object.values(wallets)) {
  if(await wallet.getCode({ address: batcherAddr })) continue;
  console.log("Deploying Batcher for chain", wallet.chain.name);
  const txHash = await wallet.sendTransaction({
    to: create2Factory,
    data: concat([batcherSalt, batcherBytecode]),
  });
  console.log("TX hash", txHash);
}

// RPC fail - retry
// submitted / confirming (both success/revert) - wait
// submitted, never mined - send same again, same nonce?
// dropped, RPC doesn't know WDYM - send same again, same nonce? (what if 2 RPCs get the same thing? Same nonce too, pleasant race condition)
// after X retries - consider failure, THEN WHAT? burn the nonce?
//
// put a TX hash in the DB BEFORE sending it
// on startup, check TXs in db that are in-flight, restore observation
//
// loop(3 times?){
//    estimate
//    if(not enough funds): break;
//    sign & submit
//    burn_nonce = true
//    if(mined): wait for confirmations
//    if(mined, revert): wait for confirmations, failed
//    if(unmined): continue loop
//
//    wait for mined one way or another
//
// }
// if(burn_nonce) send_tx(nonce_burner)
//
//
// in all RPC calls, do the retrials

const multicall3s = getMulticall3s();

const sendSchema = z.object({
  calls: z.array(z.object({
    target: z.string().refine(isHex),
    calldata: z.string().refine(isHex),
  })).nonempty(),
});

const router = new Router();
router
  .post("/:chainId/send", async (context) => {
    const multicall3 = multicall3s[Number(context.params.chainId)];
    if (!multicall3) {
      context.response.status = 404;
      context.response.body = "Unsupported chain ID";
      return;
    }

    let sendArg: z.infer<typeof sendSchema>;
    try {
      sendArg = sendSchema.parse(await context.request.body.json());
    } catch (error) {
      context.response.status = 400;
      context.response.body = String(error);
      return;
    }

    const calls = sendArg.calls.map(({ target, calldata }) => ({
      target: target as Hex,
      callData: calldata as Hex,
      allowFailure: false,
    }));

    let txHash: Hex;
    try {
      txHash = await multicall3.write.aggregate3([calls]);
    } catch (error) {
      context.response.status = 500;
      context.response.body = String(error);
      return;
    }

    context.response.body = { txHash };
  });

await new Application()
  .use(router.routes())
  .use(router.allowedMethods())
  .listen({ port: getPort(), hostname: "[::]" });
