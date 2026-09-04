import { assert, assertEquals } from "@std/assert";
import { type Address, encodeFunctionData } from "viem";
import { foundry } from "viem/chains";
import { abi as counterAbi, bytecode as counterBytecode } from "./counter.generated.ts";
import { anvilClient } from "./anvil.ts";
import { port } from "./app.ts";
import { type SendSequencesArg, sendSequencesSchema } from "../../src/app.ts";

export let counterAddress: Address | undefined;

// Deploys the Counter test fixture from the maintenance wallet and returns its address.
export async function deployCounter(): Promise<Address> {
  const hash = await anvilClient.deployContract({ abi: counterAbi, bytecode: counterBytecode });
  const receipt = await anvilClient.waitForTransactionReceipt({ hash });
  assert(receipt.contractAddress, "Counter deployment failed");
  counterAddress = receipt.contractAddress;
  return counterAddress;
}

export async function assertCounterCount(expected: bigint) {
  assert(counterAddress, "Counter not deployed yet");
  const count = await anvilClient.readContract({
    address: counterAddress,
    abi: counterAbi,
    functionName: "count",
  });
  assertEquals(count, expected);
}

// Submits one sequence per argument, each a burst per number, each burst a single call to the
// Counter fixture's `add(value)`. Returns the created sequence ids, in the same order.
export async function sendCounterSequences(...sequences: number[][]): Promise<string[]> {
  assert(counterAddress, "Counter not deployed yet");
  const target = counterAddress;
  const arg: SendSequencesArg = {
    sequences: sequences.map((bursts) => ({
      chainId: foundry.id,
      bursts: bursts.map((value) => ({
        calls: [{
          target,
          calldata: encodeFunctionData({
            abi: counterAbi,
            functionName: "add",
            args: [BigInt(value)],
          }),
        }],
      })),
    })),
  };
  const response = await fetch(`http://localhost:${port}/send-sequences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(arg),
  });
  assert(response.ok, `/send-sequences returned ${response.status}`);
  const { sequences: created } = sendSequencesSchema.parse(await response.json());
  return created.map(({ id }) => id);
}
