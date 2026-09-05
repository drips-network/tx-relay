import { delay } from "async";
import { createTestClient, http, numberToHex, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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

// Chain state, like any other set via a transaction, so - unlike automine - it's restored by
// `evm_revert`/`anvil_snapshot` but wiped by `resetToGenesis`, which needs to reapply it.
export async function setBlockGasLimit(gas: bigint) {
  await anvilClient.request({
    method: "evm_setBlockGasLimit",
    params: [numberToHex(gas)],
  });
}

// Polls the mempool until it holds exactly `pending` pending and `queued` queued transactions.
// Throws immediately if either count overshoots its target, since that means something
// unexpected is happening rather than the target state simply not being reached yet.
export async function waitForTxpoolCounts(pending: number, queued = 0) {
  while (true) {
    const status = await anvilClient.getTxpoolStatus();
    if (status.pending === pending && status.queued === queued) return;
    if (status.pending > pending || status.queued > queued) {
      throw new Error(
        `Expected ${pending} pending and ${queued} queued transactions, got ` +
          `${status.pending} pending and ${status.queued} queued`,
      );
    }
    await delay(10);
  }
}
