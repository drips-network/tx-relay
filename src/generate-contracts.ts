function runCommand(command: string, options: Deno.CommandOptions = {}): string {
  const optionsFull = { stdout: "piped", stderr: "piped", ...options } as const;
  const { code, stdout, stderr } = new Deno.Command(command, optionsFull).outputSync();
  if (code) {
    const cause = new TextDecoder().decode(stderr).trim();
    throw new Error(command + " exited with error code " + code, { cause });
  }
  return new TextDecoder().decode(stdout).trim();
}

const executorArtifactJson = runCommand("forge", {
  args: ["inspect", "Executor", "artifact"],
  cwd: "contracts",
});
const generatedPath = "src/contracts.generated.ts";
Deno.writeTextFileSync(
  generatedPath,
  `
    // DO NOT EDIT, code generated with task \`generate-contracts\`
    import type { Abi, Hex } from "viem";

    const executorArtifact = ${executorArtifactJson} as const;
    export const executorAbi = executorArtifact.abi satisfies Abi;
    export const executorBytecode = executorArtifact.bytecode.object satisfies Hex;
  `,
);
runCommand(Deno.execPath(), { args: ["fmt", generatedPath] });
