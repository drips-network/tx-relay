import { retry } from "async";
import { assert } from "@std/assert";
import { createTestClient, http } from "viem";
import { foundry } from "viem/chains";

// Anvil's default account #0, pre-funded with test ETH.
const walletPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const singletonFactory = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const singletonFactoryBytecode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const port = 8000;

Deno.test("smoke: app starts up and its worker connects to the chain", async () => {
  const anvil = createTestClient({ mode: "anvil", chain: foundry, transport: http() });
  await anvil.setCode({ address: singletonFactory, bytecode: singletonFactoryBytecode });

  const config = {
    wallets: [{ privateKey: walletPrivateKey, chains: [{ chainId: foundry.id }] }],
  };

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
        workers.length > 0 && workers.every((w: { runningSince: string | null }) =>
          w.runningSince !== null
        ),
        "worker(s) not running yet",
      );
    }, { minTimeout: 300, maxTimeout: 300, multiplier: 1, maxAttempts: 50 });
  } finally {
    app.kill("SIGTERM");
    await app.status;
  }
});
