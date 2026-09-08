const check = Deno.args.includes("--check");

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

// Solc appends a CBOR-encoded metadata blob (compiler version, a hash covering source paths,
// etc.), prefixed by its own 2-byte length, to the end of the bytecode. It has no effect on the
// deployed contract, but differs across machines/Foundry versions even when the contract itself
// is unchanged - so it's trimmed off before ever comparing bytecode for staleness.
function trimMetadata(bytecode: string): string {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const metadataLength = parseInt(hex.slice(-4), 16) * 2;
  return hex.slice(0, hex.length - 4 - metadataLength);
}

async function generateArtifact(contractName: string, outputPath: string) {
  const artifactJson = runCommand("forge", {
    args: ["inspect", "--force", contractName, "artifact"],
    cwd: "contracts",
  });
  const bytecode: string = JSON.parse(artifactJson).bytecode.object;

  if (check) {
    const existing = await import(`file://${Deno.cwd()}/${outputPath}`);
    if (trimMetadata(bytecode) !== trimMetadata(existing.bytecode)) {
      throw new Error(`${outputPath} is out of date with the ${contractName} contract`);
    }
    return;
  }

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

await generateArtifact("Executor", "src/executor.generated.ts");
await generateArtifact("CallsLog", "tests/integration/calls-log.generated.ts");
