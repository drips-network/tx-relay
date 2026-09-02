function runCommand(command: string, options: Deno.CommandOptions = {}): string {
  const optionsFull = { stdout: "piped", stderr: "piped", ...options } as const;
  const { code, stdout, stderr } = new Deno.Command(command, optionsFull).outputSync();
  if (code) {
    const cause = new TextDecoder().decode(stderr).trim();
    throw new Error(command + " exited with error code " + code, { cause });
  }
  return new TextDecoder().decode(stdout).trim();
}

function runDeno(...args: string[]) {
  runCommand(Deno.execPath(), { args });
}

function generateArtifact(contractName: string, outputPath: string) {
  const artifactJson = runCommand("forge", {
    args: ["inspect", "--force", contractName, "artifact"],
    cwd: "contracts",
  });
  Deno.writeTextFileSync(
    outputPath,
    `
      // DO NOT EDIT, code generated with task \`generate-contracts\`
      import type { Abi, Hex } from "viem";

      const artifact = ${artifactJson} as const;
      export const abi = artifact.abi satisfies Abi;
      export const bytecode = artifact.bytecode.object satisfies Hex;
    `,
  );
  runDeno("fmt", outputPath);
  runDeno("check", outputPath);
}

generateArtifact("Executor", "src/executor.generated.ts");
generateArtifact("Counter", "tests/integration/counter.generated.ts");
