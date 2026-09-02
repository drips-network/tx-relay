import { retry } from "async";
import { assert } from "@std/assert";
import { Hex } from "viem";

// Anvil's default account #0, pre-funded with test ETH.
export const walletPrivateKey: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const port = 8000;

type Config = {
  wallets: { privateKey: Hex; chains: { chainId: number }[] }[];
};

// Minimizes every worker delay/poll cadence, trading CPU usage for latency, so tests aren't
// stuck waiting out multi-second production defaults (e.g. the 1s batch-retry or 2s block-poll
// interval). These fields only exist for this purpose and are never meant to be set in prod.
const testConfig = {
  workerRestartDelayMs: 1,
  sendNextBatchMinRetryDelayMs: 1,
  delayUntilBlockNumberPollingIntervalMs: 1,
  waitForBalanceRetryDelayMs: 1,
  burnNonceDelayInitialMs: 1,
  burnNonceDelayMultiplier: 1,
  burnNonceDelayMaxMs: 1,
};

export async function startApp(config: Config): Promise<Deno.ChildProcess> {
  const command = new Deno.Command("deno", {
    args: ["task", "start"],
    cwd: new URL("../..", import.meta.url),
    env: { CONFIG: JSON.stringify(config), TEST_CONFIG: JSON.stringify(testConfig) },
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
    }, { minTimeout: 10, maxTimeout: 10, multiplier: 1, maxAttempts: 1500 });
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
