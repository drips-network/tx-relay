import { assert } from "@std/assert";
import { delay } from "async";
import {
  createTestClient,
  type Hex,
  http,
  numberToHex,
  publicActions,
  serializeTransaction,
  type Transaction,
  walletActions,
} from "viem";
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

// The cost of the cheapest possible TX at the current fee estimate - e.g. to fund a wallet with
// just enough for a plain nonce-burning transfer, but not for whatever heavier TX it's replacing.
export async function baseTxCost(): Promise<bigint> {
  const { gas, maxFeePerGas } = await anvilClient.prepareTransactionRequest({
    account: anvilClient.account,
    to: anvilClient.account.address,
  });
  return gas * maxFeePerGas;
}

// Chain state, like any other set via a transaction, so - unlike automine - it's restored by
// `evm_revert`/`anvil_snapshot` but wiped by `resetToGenesis`, which needs to reapply it.
// Defaults to the value the test suite runs with, so callers that shrunk it can restore it with a
// bare call.
export async function setBlockGasLimit(gas: bigint = 1_000_000n) {
  await anvilClient.request({
    method: "evm_setBlockGasLimit",
    params: [numberToHex(gas)],
  });
}

// Mines `blocks` blocks with the gas limit shrunk to 1 - too small for anything pending to fit -
// so the chain advances without any of it being touched, unlike dropping it outright. Restores
// the default gas limit afterward.
export async function mineEmptyBlocks(blocks: number) {
  await setBlockGasLimit(1n);
  await anvilClient.mine({ blocks });
  await setBlockGasLimit();
}

export async function getTxpoolTxs() {
  const content = await anvilClient.getTxpoolContent();
  return [...Object.values(content.pending), ...Object.values(content.queued)]
    .flatMap((byNonce) => Object.values(byNonce));
}

export async function dropPendingTxs() {
  const txs = await getTxpoolTxs();
  for (const { hash } of txs) {
    await anvilClient.request({ method: "anvil_dropTransaction", params: [hash] });
  }
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

// Requires automine off. Waits for exactly one pending TX and none queued, then mines it plus
// `confirmations` confirmation blocks, returning its hash and landing block.
//
// Mined one block at a time, with a real pause after each, rather than in one batched
// `anvil_mine({blocks: N})` call: that commits all N blocks essentially atomically, with no gap
// for the worker's own polling (see `watchTxs` in worker.ts) to observe a TX's receipt before
// re-checking whether `inclusionWaitBlocks` have passed with none seen - which can spuriously
// cross that resend threshold in the same instant the TX is actually included, triggering an
// unwanted reprice/resend. The per-block pause keeps that gap real, so the receipt is always seen
// first.
export async function mineNextTx(
  confirmations: number,
): Promise<{ txHash: Hex; blockNumber: bigint }> {
  await waitForTxpoolCounts(1);
  const [{ hash: txHash }] = await getTxpoolTxs();
  for (let i = 0; i < 1 + 2 * confirmations; i++) {
    await anvilClient.mine({ blocks: 1 });
    await delay(20);
  }
  const { blockNumber } = await anvilClient.getTransactionReceipt({ hash: txHash });
  return { txHash, blockNumber };
}

export async function waitForNewTxpoolTx(previousHash: Hex): Promise<Hex> {
  while (true) {
    const [tx] = await getTxpoolTxs();
    if (tx && tx.hash !== previousHash) return tx.hash;
    await delay(10);
  }
}

// Resubmits `tx` (as returned by `getTransaction`) verbatim, signature included - e.g. to restore
// an earlier attempt after a repriced retry replaced it, proving the worker still recognizes
// success via any of its historical attempts, not just the latest one.
export async function resubmitTx(tx: Transaction) {
  assert(tx.type === "eip1559" && tx.yParity !== undefined, "Expected an EIP-1559 transaction");
  // `serializeTransaction` expects `data`, but the parsed `Transaction` names the same field
  // `input` - passing `tx` directly would silently serialize it as empty calldata.
  await anvilClient.sendRawTransaction({
    serializedTransaction: serializeTransaction({
      type: "eip1559",
      chainId: anvilClient.chain.id,
      nonce: tx.nonce,
      to: tx.to,
      value: tx.value,
      data: tx.input,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      accessList: tx.accessList,
    }, { r: tx.r, s: tx.s, yParity: tx.yParity }),
  });
}
