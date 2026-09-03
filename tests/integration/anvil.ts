import { delay } from "async";
import { assert } from "@std/assert";
import {
  type Address,
  createTestClient,
  encodeFunctionData,
  http,
  publicActions,
  walletActions,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { abi as counterAbi, bytecode as counterBytecode } from "./counter.generated.ts";

const singletonFactory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const singletonFactoryBytecode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

// Bound to Anvil's account #1, pre-funded with test ETH, so this doubles as the maintenance
// wallet for test-side on-chain setup (e.g. deploying a fixture contract) that isn't part of
// the app's own behavior - it must never be the app worker wallet's (account #0, see `app.ts`),
// or maintenance transactions would consume nonces the worker doesn't know about.
export const anvilClient = createTestClient({
  mode: "anvil",
  chain: foundry,
  transport: http(),
  account: privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ),
  cacheTime: 0,
})
  .extend(publicActions)
  .extend(walletActions);

export async function resetToGenesis() {
  // viem's `reset` action always sends a `forking` param, which Anvil rejects when it wasn't
  // started with `--fork-url`, so the plain `anvil_reset` (no params) is called directly.
  await anvilClient.request({ method: "anvil_reset", params: [] });
}

export async function etchSingletonFactory() {
  await anvilClient.setCode({ address: singletonFactory, bytecode: singletonFactoryBytecode });
}

// Anvil only mines a block when a transaction is submitted, so a transaction's confirmations
// never advance on their own. Callers should trigger a transaction, wait for the chain to reach
// the block it should be published in with `waitForBlockNumber`, then mine a confirming block
// with `anvilClient.mine({ blocks: 1 })` (the app defaults to requiring 1 confirmation - see
// `confirmations` in `src/config.ts`). Polls unboundedly - relies on the test's own timeout to
// fail if the chain never reaches it.
export async function waitForBlockNumber(blockNumber: bigint) {
  while (await anvilClient.getBlockNumber() < blockNumber) {
    await delay(10);
  }
}

// Deploys the Counter test fixture from the maintenance wallet and returns its address.
// TODO: move into a dedicated file once there's more than one Counter-specific util.
export async function deployCounter(): Promise<Address> {
  const hash = await anvilClient.deployContract({ abi: counterAbi, bytecode: counterBytecode });
  const receipt = await anvilClient.waitForTransactionReceipt({ hash });
  assert(receipt.contractAddress, "Counter deployment failed");
  return receipt.contractAddress;
}

// TODO: move into a dedicated file once there's more than one Counter-specific util.
export const addCalldata = (value: number) =>
  encodeFunctionData({ abi: counterAbi, functionName: "add", args: [BigInt(value)] });
