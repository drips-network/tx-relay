import { retry } from "async";
import { assert } from "@std/assert";
import { createTestClient, Hex, http } from "viem";
import { foundry } from "viem/chains";

// Anvil's default account #0, pre-funded with test ETH.
export const walletPrivateKey: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const singletonFactory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const singletonFactoryBytecode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

export const port = 8000;

const anvilClient = createTestClient({ mode: "anvil", chain: foundry, transport: http() });

export async function etchSingletonFactory() {
  await anvilClient.setCode({ address: singletonFactory, bytecode: singletonFactoryBytecode });
}

// Anvil only mines a block when a transaction is submitted, so a transaction's confirmations
// never advance on their own. Callers should capture the block number before triggering
// a transaction, wait for it to be published with `waitForNextBlock`, then mine however deep
// confirmations are needed with `mineConfirmations`, instantly.
export async function waitForNextBlock(
  publicClient: { getBlockNumber: () => Promise<bigint> },
  fromBlockNumber: bigint,
  maxAttempts = 100,
) {
  await retry(async () => {
    const blockNumber = await publicClient.getBlockNumber();
    assert(blockNumber > fromBlockNumber, "no transaction published yet");
  }, { minTimeout: 100, maxTimeout: 100, multiplier: 1, maxAttempts });
}

export async function mineConfirmations(confirmations = 5) {
  await anvilClient.mine({ blocks: confirmations });
}

type Config = {
  wallets: { privateKey: Hex; chains: { chainId: number }[] }[];
};

export async function startApp(config: Config): Promise<Deno.ChildProcess> {
  const command = new Deno.Command("deno", {
    args: ["task", "start"],
    cwd: new URL("../..", import.meta.url),
    env: { CONFIG: JSON.stringify(config) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const app = command.spawn();
  try {
    await retry(async () => {
      const response = await fetch(`http://localhost:${port}/health`);
      assert(response.ok, `/health returned ${response.status}`);
      const { workers } = await response.json();
      assert(
        workers.length > 0 &&
          workers.every((w: { runningSince: string | null }) => w.runningSince !== null),
        "worker(s) not running yet",
      );
    }, { minTimeout: 300, maxTimeout: 300, multiplier: 1, maxAttempts: 50 });
  } catch (error) {
    await stopApp(app);
    throw error;
  }
  return app;
}

export async function stopApp(app: Deno.ChildProcess) {
  app.kill("SIGTERM");
  await app.status;
}
