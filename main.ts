import { Application, Router } from "oak";
import { z } from "zod";
import { createWalletClient, getContract, Hex, http, isHex, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

// Resolve duplicate chains by keeping the version under the lexically first key, e.g. suffix-free.
const chains = Object.keys(viemChains).sort()
    .map((key) => viemChains[key as keyof typeof viemChains])
    .reduce((chains, chain) => ({[chain.id]: chain, ...chains}), {});

const configSchema = z.object({
  port: z.number().default(8000),
  rpcs: z.array(z.object({
    chainId: z.number(),
    url: z.url(),
  })).default([]),
  wallets: z.array(z.object({
    chainIds: z.array(z.number()),
    privateKey: z.string(),
  })).default([]),
});
const config = configSchema.parse(JSON.parse(Deno.env.get("CONFIG") ?? "{}"));

const rpcUrls: Record<number, string> = {};
for (const { chainId, url } of config.rpcs) {
  if (!chains[chainId]) throw new Error("Unknown RPC chain ID " + chainId);
  if (rpcUrls[chainId]) throw new Error("Duplicate RPCs for chain ID " + chainId);
  rpcUrls[chainId] = url;
}

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
type Multicall3 = ReturnType<
  typeof getContract<typeof multicall3Abi, ReturnType<typeof createWalletClient>>
>;

const multicall3s: Record<number, Multicall3> = {};
for (const wallet of config.wallets) {
  const account = privateKeyToAccount(wallet.privateKey as Hex);
  for (const chainId of wallet.chainIds) {
    const chain = chains[chainId];
    if (!chain) throw new Error("Unknown wallet chain ID " + chainId);

    const address = chain.contracts?.multicall3?.address;
    if (!address) throw new Error("No multicall3 for chain ID " + chainId);

    const client = createWalletClient({ account, chain, transport: http(rpcUrls[chainId]) });

    if (multicall3s[chainId]) throw new Error("Duplicate wallets for chain ID " + chainId);
    multicall3s[chainId] = getContract({ address, client, abi: multicall3Abi });
  }
}

const sendSchema = z.object({
  calls: z.array(z.object({
    target: z.string().refine(isHex),
    calldata: z.string().refine(isHex),
  })).nonempty(),
});

const router = new Router();
router
  .post("/:chainId/send", async (context) => {
    const multicall3 = multicall3s[Number(context.params.chainId)];
    if (!multicall3) {
      context.response.status = 404;
      context.response.body = "Unsupported chain ID";
      return;
    }

    let sendArg: z.infer<typeof sendSchema>;
    try {
      sendArg = sendSchema.parse(await context.request.body.json());
    } catch (error) {
      context.response.status = 400;
      context.response.body = String(error);
      return;
    }

    const calls = sendArg.calls.map(({ target, calldata }) => ({
      target: target as Hex,
      callData: calldata as Hex,
      allowFailure: false,
    }));

    let txHash: Hex;
    try {
      txHash = await multicall3.write.aggregate3([calls]);
    } catch (error) {
      context.response.status = 500;
      context.response.body = String(error);
      return;
    }

    context.response.body = { txHash };
  });

await new Application()
  .use(router.routes())
  .use(router.allowedMethods())
  .listen({ port: config.port });
