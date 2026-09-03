import { assertEquals } from "@std/assert";
import { type Address } from "viem";
import { foundry } from "viem/chains";
import { abi as counterAbi } from "./counter.generated.ts";
import { confirmations, sendSequence, startApp, stopApp, waitForSequenceState } from "./app.ts";
import {
  addCalldata,
  anvilClient,
  deployCounter,
  etchSingletonFactory,
  resetToGenesis,
  waitForBlockNumber,
} from "./anvil.ts";
import { resetDb } from "./db.ts";

let counterAddress: Address;
let checkpointId: `0x${string}`;
let app: Deno.ChildProcess;

async function mineConfirmations() {
  await anvilClient.mine({ blocks: confirmations });
}

Deno.test.beforeAll(async () => {
  await resetToGenesis();
  await etchSingletonFactory();

  counterAddress = await deployCounter();
});

Deno.test.beforeEach(async () => {
  await resetDb();
  if (checkpointId) await anvilClient.revert({ id: checkpointId });
  checkpointId = await anvilClient.snapshot();

  // The app also carries its own in-memory state (e.g. transactions it believes are still
  // in-flight), which no individual test can be trusted to leave clean, so it's restarted
  // fresh here rather than relying on each test to manage its own lifecycle correctly.
  const blockNumberBeforeApp = await anvilClient.getBlockNumber();
  app = await startApp();
  // Every test starts from the checkpoint taken right after the Counter was deployed, so the
  // Executor is never deployed yet and this app instance always has to (re)deploy it here,
  // which needs confirming before the relay can make any further progress.
  await waitForBlockNumber(blockNumberBeforeApp + 1n);
  await mineConfirmations();
});

Deno.test.afterEach(async () => {
  await stopApp(app);
});

Deno.test.afterAll(async () => {
  await resetToGenesis();
});

Deno.test({
  name: "smoke: app starts up and its worker connects to the chain",
  timeout: 30_000,
  // `beforeEach` already asserts this by successfully starting the app - nothing further to do.
  fn() {},
});

Deno.test({
  name: "send-sequences: executes a successful call and rejects a reverting one",
  timeout: 30_000,
  async fn() {
    // A sequence whose only burst reverts is rejected outright, without ever being submitted
    // on-chain, so it must be awaited in isolation before any other sequence is sent - once
    // something else is accepted into the same batch, a later revert is just left pending for
    // a retry instead of being rejected.
    const revertingId = await sendSequence(foundry.id, counterAddress, addCalldata(0));
    const revertingState = await waitForSequenceState(revertingId);
    assertEquals(revertingState.successes, 0);
    assertEquals(revertingState.failures, 1);

    const blockNumberBeforeSuccess = await anvilClient.getBlockNumber();
    const successId = await sendSequence(foundry.id, counterAddress, addCalldata(5));
    await waitForBlockNumber(blockNumberBeforeSuccess + 1n);
    await mineConfirmations();
    const successState = await waitForSequenceState(successId);
    assertEquals(successState.successes, 1);
    assertEquals(successState.failures, 0);

    const count = await anvilClient.readContract({
      address: counterAddress,
      abi: counterAbi,
      functionName: "count",
    });
    assertEquals(count, 5n);
  },
});
