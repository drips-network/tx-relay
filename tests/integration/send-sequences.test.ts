import { retry } from "async";
import { assert, assertEquals } from "@std/assert";
import { createWalletClient, encodeFunctionData, http, publicActions } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { abi as counterAbi, bytecode as counterBytecode } from "./counter.generated.ts";
import {
  etchSingletonFactory,
  mineConfirmations,
  port,
  startApp,
  stopApp,
  waitForNextBlock,
  walletPrivateKey,
} from "./app.ts";

async function sendSequence(target: string, value: number): Promise<string> {
  const calldata = encodeFunctionData({ abi: counterAbi, functionName: "add", args: [BigInt(value)] });
  const response = await fetch(`http://localhost:${port}/send-sequences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sequences: [{ chainId: foundry.id, bursts: [{ calls: [{ target, calldata }] }] }],
    }),
  });
  assert(response.ok, `/send-sequences returned ${response.status}`);
  const { sequences: [{ id }] } = await response.json();
  return id;
}

// deno-lint-ignore no-explicit-any
async function waitForSequenceState(id: string): Promise<any> {
  return await retry(async () => {
    const response = await fetch(`http://localhost:${port}/sequences-states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequences: [{ id }] }),
    });
    assert(response.ok, `/sequences-states returned ${response.status}`);
    const { sequences: [state] } = await response.json();
    assert(state.pending === 0, "sequence still has pending bursts");
    return state;
  }, { minTimeout: 300, maxTimeout: 300, multiplier: 1, maxAttempts: 50 });
}

Deno.test("send-sequences: executes a successful call and rejects a reverting one", async () => {
  await etchSingletonFactory();

  const client = createWalletClient({
    account: privateKeyToAccount(walletPrivateKey),
    chain: foundry,
    transport: http(),
  }).extend(publicActions);

  const deployHash = await client.deployContract({ abi: counterAbi, bytecode: counterBytecode });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash: deployHash });
  assert(contractAddress, "Counter was not deployed");

  const blockNumberBeforeApp = await client.getBlockNumber();
  const app = await startApp({
    wallets: [{ privateKey: walletPrivateKey, chains: [{ chainId: foundry.id }] }],
  });

  try {
    // The app deploys the Executor on first use on a chain, which needs confirming before
    // the relay can make any further progress. If it was already deployed by an earlier
    // test run, no transaction is sent and there's nothing to wait for.
    await waitForNextBlock(client, blockNumberBeforeApp, 20).catch(() => {});
    await mineConfirmations();

    // A sequence whose only burst reverts is rejected outright, without ever being submitted
    // on-chain, so it must be awaited in isolation before any other sequence is sent -
    // once something else is accepted into the same batch, a later revert is just left
    // pending for a retry instead of being rejected.
    const revertingId = await sendSequence(contractAddress, 0);
    const revertingState = await waitForSequenceState(revertingId);
    assertEquals(revertingState.successes, 0);
    assertEquals(revertingState.failures, 1);

    const blockNumberBeforeSuccess = await client.getBlockNumber();
    const successId = await sendSequence(contractAddress, 5);
    await waitForNextBlock(client, blockNumberBeforeSuccess);
    await mineConfirmations();
    const successState = await waitForSequenceState(successId);
    assertEquals(successState.successes, 1);
    assertEquals(successState.failures, 0);

    const count = await client.readContract({
      address: contractAddress,
      abi: counterAbi,
      functionName: "count",
    });
    assertEquals(count, 5n);
  } finally {
    await stopApp(app);
  }
});
