import { afterAll, beforeAll, beforeEach, it } from "@std/testing/bdd";
import { retry } from "async";
import { assert, assertEquals } from "@std/assert";
import { type Address, createWalletClient, encodeFunctionData, http, publicActions } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { abi as counterAbi, bytecode as counterBytecode } from "./counter.generated.ts";
import { port, startApp, stopApp, walletPrivateKey } from "./app.ts";
import {
  anvilClient,
  etchSingletonFactory,
  mineConfirmations,
  resetToGenesis,
  waitForNextBlock,
} from "./anvil.ts";
import { resetDb } from "./db.ts";

const client = createWalletClient({
  account: privateKeyToAccount(walletPrivateKey),
  chain: foundry,
  transport: http(),
}).extend(publicActions);

let counterAddress: Address;
let checkpointId: `0x${string}`;

beforeAll(async () => {
  await resetToGenesis();
  await etchSingletonFactory();

  const deployHash = await client.deployContract({ abi: counterAbi, bytecode: counterBytecode });
  const receipt = await client.waitForTransactionReceipt({ hash: deployHash });
  assert(receipt.contractAddress, "Counter was not deployed");
  counterAddress = receipt.contractAddress;

  checkpointId = await anvilClient.snapshot();
});

beforeEach(async () => {
  await resetDb();
  // viem's `revert` action discards `evm_revert`'s boolean result, so it's called directly.
  const reverted = await anvilClient.request({ method: "evm_revert", params: [checkpointId] });
  assert(reverted, "checkpoint revert failed");
  // Reverting consumes the snapshot, so re-snapshot immediately to reuse it for the next test.
  checkpointId = await anvilClient.snapshot();
});

afterAll(async () => {
  await resetToGenesis();
});

it("smoke: app starts up and its worker connects to the chain", async () => {
  const app = await startApp({
    wallets: [{ privateKey: walletPrivateKey, chains: [{ chainId: foundry.id }] }],
  });
  await stopApp(app);
});

async function sendSequence(target: Address, value: number): Promise<string> {
  const calldata = encodeFunctionData({
    abi: counterAbi,
    functionName: "add",
    args: [BigInt(value)],
  });
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
  }, { minTimeout: 50, maxTimeout: 50, multiplier: 1, maxAttempts: 300 });
}

it("send-sequences: executes a successful call and rejects a reverting one", async () => {
  const blockNumberBeforeApp = await client.getBlockNumber({ cacheTime: 0 });
  const app = await startApp({
    wallets: [{ privateKey: walletPrivateKey, chains: [{ chainId: foundry.id }] }],
  });

  try {
    // Every test starts from the checkpoint taken right after the Counter was deployed, so the
    // Executor is never deployed yet and this app instance always has to (re)deploy it here,
    // which needs confirming before the relay can make any further progress.
    await waitForNextBlock(blockNumberBeforeApp, 200);
    await mineConfirmations();

    // A sequence whose only burst reverts is rejected outright, without ever being submitted
    // on-chain, so it must be awaited in isolation before any other sequence is sent -
    // once something else is accepted into the same batch, a later revert is just left
    // pending for a retry instead of being rejected.
    const revertingId = await sendSequence(counterAddress, 0);
    const revertingState = await waitForSequenceState(revertingId);
    assertEquals(revertingState.successes, 0);
    assertEquals(revertingState.failures, 1);

    const blockNumberBeforeSuccess = await client.getBlockNumber({ cacheTime: 0 });
    const successId = await sendSequence(counterAddress, 5);
    await waitForNextBlock(blockNumberBeforeSuccess);
    await mineConfirmations();
    const successState = await waitForSequenceState(successId);
    assertEquals(successState.successes, 1);
    assertEquals(successState.failures, 0);

    const count = await client.readContract({
      address: counterAddress,
      abi: counterAbi,
      functionName: "count",
    });
    assertEquals(count, 5n);
  } finally {
    await stopApp(app);
  }
});
