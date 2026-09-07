import { assert, assertEquals } from "@std/assert";
import { type Address, encodeFunctionData } from "viem";
import { abi as callsLogAbi, bytecode as callsLogBytecode } from "./calls-log.generated.ts";
import { anvilClient } from "./anvil.ts";
import { type SendSequencesArg } from "../../src/app.ts";

let callsLogAddress: Address | undefined;

function getCallsLogAddress(): Address {
  assert(callsLogAddress, "CallsLog not deployed yet");
  return callsLogAddress;
}

// Deploys the CallsLog test fixture from the maintenance wallet and returns its address.
export async function deployCallsLog(): Promise<Address> {
  const hash = await anvilClient.deployContract({ abi: callsLogAbi, bytecode: callsLogBytecode });
  await anvilClient.mine({ blocks: 1 });
  const receipt = await anvilClient.waitForTransactionReceipt({ hash });
  assert(receipt.contractAddress, "CallsLog deployment failed");
  callsLogAddress = receipt.contractAddress;
  return callsLogAddress;
}

export async function assertLogs(expectedLogs: string[]) {
  const logs = await anvilClient.readContract({
    address: getCallsLogAddress(),
    abi: callsLogAbi,
    functionName: "getLogs",
  });
  assertEquals(logs, expectedLogs);
}

type Call = SendSequencesArg["sequences"][number]["bursts"][number]["calls"][number];

// A call to the CallsLog fixture's `addLog(value)`, for use in a `SendSequencesArg` burst.
export function addLog(log: string, gas?: number): Call {
  return {
    target: getCallsLogAddress(),
    calldata: encodeFunctionData({ abi: callsLogAbi, functionName: "addLog", args: [log] }),
    gas,
  };
}

// A call to the CallsLog fixture's `setReverts(value)`, for use in a `SendSequencesArg` burst.
// Put it in the same burst as the `addLog(value)` call it's meant to affect, so the two are
// guaranteed to execute in order within a single atomic transaction.
export function setReverts(log: string): Call {
  return {
    target: getCallsLogAddress(),
    calldata: encodeFunctionData({ abi: callsLogAbi, functionName: "setReverts", args: [log] }),
  };
}

// A call to the CallsLog fixture's `setGasPenalty(value, gas)`, for use in a `SendSequencesArg`
// burst. Put it in the same burst as the `addLog(value)` call it's meant to affect, so the two
// are guaranteed to execute in order within a single atomic transaction.
export function setGasPenalty(log: string, gas: bigint): Call {
  return {
    target: getCallsLogAddress(),
    calldata: encodeFunctionData({
      abi: callsLogAbi,
      functionName: "setGasPenalty",
      args: [log, gas],
    }),
  };
}
