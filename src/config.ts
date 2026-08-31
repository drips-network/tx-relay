import { z } from "zod";
import {
  Chain,
  createWalletClient,
  fallback,
  Hex,
  http,
  isHex,
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
  return port ??= z.coerce.number().int().positive().default(8000).parse(Deno.env.get("PORT"));
}

let port: number | undefined;

// App configuration in raw form as provided by the user

type Config = z.infer<typeof configSchema>;

function getConfig(): Config {
  return config ??= configSchema.parse(JSON.parse(Deno.env.get("CONFIG") ?? "{}"));
}

let config: Config | undefined;

const configSchema = z.object({
  wallets: z.array(z.object({
    privateKey: z.custom<Hex>((s) => isHex(s) && s.length === 66, "Not a 32-byte hex value"),
    chains: z.array(z.object({
      chainId: z.number().int().positive(),
      rpcUrls: z.array(z.url()).default([]),
      confirmations: z.number().int().positive().optional(),
      minGasIncreasePercent: z.number().int().nonnegative().optional(),
      inclusionWaitBlocks: z.number().int().nonnegative().optional(),
    })).nonempty(),
  })).nonempty(),
});

// All supported chains
//
type Chains = Map<number, Chain>;

function getChains(): Chains {
  return chains ??= Object.entries(viemChains)
    // Sort by chain names used in Viem as keys, lexically descending
    .sort(([chainA], [chainB]) => -chainA.localeCompare(chainB))
    // Resolve duplicate chain IDs by keeping the one from the lexically first key e.g. suffix-free.
    .reduce<Chains>((map, [, chain]) => map.set(chain.id, chain), new Map());
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
  inclusionWaitBlocks: number;
  workerRestartDelayMs: number;
  sendNextBatchMinRetryDelayMs: number;
  delayUntilBlockNumberPollingIntervalMs: number;
  waitForBalanceRetryDelayMs: number;
  burnNonceDelayInitialMs: number,
  burnNonceDelayMultiplier: number,
  burnNonceDelayMaxMs: number,
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
    const account = privateKeyToAccount(wallet.privateKey);
    for (const { chainId, rpcUrls, ...config } of wallet.chains) {
      const chain = chains.get(chainId);
      if (!chain) throw new Error("Unknown wallet chain ID " + chainId);
      if (chainConfigs[chainId]) throw new Error("Duplicate wallets for chain ID " + chainId);
      const transport = fallback(rpcUrls.length ? rpcUrls.map((url) => http(url)) : [http()]);
      chainConfigs[chainId] = {
        client: createWalletClient({ account, chain, transport }).extend(publicActions),
        confirmations: config.confirmations ?? 1,
        minGasIncreasePercent: config.minGasIncreasePercent ?? 10,
        inclusionWaitBlocks: config.inclusionWaitBlocks ?? 5,
        workerRestartDelayMs: 60_000,
        sendNextBatchMinRetryDelayMs: 1_000,
        delayUntilBlockNumberPollingIntervalMs: 2_000,
        waitForBalanceRetryDelayMs: 10_000,
        burnNonceDelayInitialMs: 1_000,
        burnNonceDelayMultiplier: 10,
        burnNonceDelayMaxMs: 60_000,
      };
    }
  }
  return chainConfigs;
}
