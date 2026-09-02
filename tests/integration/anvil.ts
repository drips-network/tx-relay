import { retry } from "async";
import { assert } from "@std/assert";
import { createTestClient, http, publicActions } from "viem";
import { foundry } from "viem/chains";

const singletonFactory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const singletonFactoryBytecode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

export const anvilClient = createTestClient({ mode: "anvil", chain: foundry, transport: http() })
  .extend(publicActions);

export async function resetToGenesis() {
  // viem's `reset` action always sends a `forking` param, which Anvil rejects when it wasn't
  // started with `--fork-url`, so the plain `anvil_reset` (no params) is called directly.
  await anvilClient.request({ method: "anvil_reset", params: [] });
}

export async function etchSingletonFactory() {
  await anvilClient.setCode({ address: singletonFactory, bytecode: singletonFactoryBytecode });
}

// Anvil only mines a block when a transaction is submitted, so a transaction's confirmations
// never advance on their own. Callers should capture the block number before triggering
// a transaction, wait for it to be published with `waitForNextBlock`, then mine however deep
// confirmations are needed with `mineConfirmations`, instantly.
export async function waitForNextBlock(fromBlockNumber: bigint, maxAttempts = 1000) {
  await retry(async () => {
    const blockNumber = await anvilClient.getBlockNumber({ cacheTime: 0 });
    assert(blockNumber > fromBlockNumber, "no transaction published yet");
  }, { minTimeout: 10, maxTimeout: 10, multiplier: 1, maxAttempts });
}

export async function mineConfirmations(confirmations = 5) {
  await anvilClient.mine({ blocks: confirmations });
}
