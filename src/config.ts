import { z } from "zod";
import {
  Chain,
  createWalletClient,
  fallback,
  Hex,
  http,
  PrivateKeyAccount,
  publicActions,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

// DB URL configuration

export function getDbUrl(): string {
  return dbUrl ??= z.url().default("postgres://user:password@localhost:5432/tx_relay")
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
  // rpcs: z.array(z.object({
  //   chainId: z.number(),
  //   url: z.url(),
  // })).default([]),
  wallets: z.array(z.object({
    privateKey: z.string(),
    chains: z.array(z.object({
      chainId: z.number(),
      rpcUrls: z.array(z.url()).default([]),
      confirmations: z.number().default(1),
      minGasIncreasePercent: z.number().default(10),
      blockTimeMs: z.number().default(10_000),
      miningTimeBlocks: z.number().default(5),
    })),
  })).default([]),
});

// All supported chains

// type Chains = Record<number, (typeof viemChains)[keyof typeof viemChains]>;
type Chains = Record<number, Chain>;

function getChains(): Chains {
  // Resolve duplicate chains by keeping the version from the lexically first key e.g. suffix-free.
  return chains ??= Object.keys(viemChains)
    .sort()
    .map((key) => viemChains[key as keyof typeof viemChains])
    .reduce((chains, chain) => ({ [chain.id]: chain, ...chains }), {});
}

let chains: Chains | undefined;

// Chains configuration

export type Client =
  & WalletClient<Transport, Chain, PrivateKeyAccount>
  & PublicClient<Transport, Chain, PrivateKeyAccount>;

export type ChainConfig = {
  client: Client;
  confirmations: number;
  minGasIncreasePercent: number;
  blockTimeMs: number;
  miningTimeBlocks: number;
};

export type ChainConfigs = Record<number, ChainConfig>;

export function getChainConfigs(): ChainConfigs {
  return chainConfigs ??= getChainConfigsValue();
}

let chainConfigs: ChainConfigs | undefined;

function getChainConfigsValue(): ChainConfigs {
  const chains = getChains();
  const chainConfigs: ChainConfigs = {};
  for (const wallet of getConfig().wallets) {
    const account = privateKeyToAccount(wallet.privateKey as Hex);
    for (const { chainId, rpcUrls, ...config } of wallet.chains) {
      const chain = chains[chainId];
      if (!chain) throw new Error("Unknown wallet chain ID " + chainId);
      if (chainConfigs[chainId]) throw new Error("Duplicate wallets for chain ID " + chainId);
      const transport = fallback(rpcUrls.length ? rpcUrls.map((url) => http(url)) : [http()]);
      const client = createWalletClient({ account, chain, transport }).extend(publicActions);
      chainConfigs[chainId] = { client, ...config };
    }
  }
  return chainConfigs;
}
