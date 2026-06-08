import { z } from "zod";
import {
  createWalletClient,
  getContract,
  GetContractReturnType,
  Hex,
  http,
  parseAbi,
  WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

// DB URL configuration

export function getDbUrl(): string {
  return dbUrl ??= z.url().default("postgres://user:password@localhost:5432/relay_db")
    .parse(Deno.env.get("DB_URL"));
}

let dbUrl: string | undefined;

// Port number configuration

export function getPort(): number {
  return port ??= z.coerce.number().default(8000).parse(Deno.env.get("PORT"));
}

let port: number | undefined;

// App configuration in raw form as provided by the user

type Config = z.infer<typeof configSchema>;

function getConfig(): Config {
  return config ??= configSchema.parse(JSON.parse(Deno.env.get("CONFIG") ?? "{}"));
}

let config: Config | undefined;

const configSchema = z.object({
  rpcs: z.array(z.object({
    chainId: z.number(),
    url: z.url(),
  })).default([]),
  wallets: z.array(z.object({
    chainIds: z.array(z.number()),
    privateKey: z.string(),
  })).default([]),
});

// All supported chains

type Chains = Record<number, (typeof viemChains)[keyof typeof viemChains]>;

function getChains(): Chains {
  // Resolve duplicate chains by keeping the version from the lexically first key e.g. suffix-free.
  return chains ??= Object.keys(viemChains)
    .sort()
    .map((key) => viemChains[key as keyof typeof viemChains])
    .reduce((chains, chain) => ({ [chain.id]: chain, ...chains }), {});
}

let chains: Chains | undefined;

// RPC URL overrides configuration

type RpcUrls = Record<number, string>;

function getRpcUrls(): RpcUrls {
  return rpcUrls ??= getRpcUrlsValue();
}

let rpcUrls: RpcUrls | undefined;

function getRpcUrlsValue(): RpcUrls {
  // Resolve duplicate chains by keeping the version under the lexically first key, e.g. suffix-free.
  const chains = getChains();
  const rpcUrls: RpcUrls = {};
  for (const { chainId, url } of getConfig().rpcs) {
    if (!chains[chainId]) throw new Error("Unknown RPC chain ID " + chainId);
    if (rpcUrls[chainId]) throw new Error("Duplicate RPCs for chain ID " + chainId);
    rpcUrls[chainId] = url;
  }
  return rpcUrls;
}

// Mutlicall3 wallets configuration

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export type Multicall3 = GetContractReturnType<typeof multicall3Abi, WalletClient>;
export type Multicall3s = Record<number, Multicall3>;

export function getMulticall3s(): Multicall3s {
  return multicall3s ??= getMulticall3sValue();
}

let multicall3s: Multicall3s | undefined;

function getMulticall3sValue(): Multicall3s {
  const chains = getChains();
  const rpcUrls = getRpcUrls();
  const multicall3s: Multicall3s = {};
  for (const wallet of getConfig().wallets) {
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
  return multicall3s;
}
