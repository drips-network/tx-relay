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

const configSchema = z.object({
  wallets: z.array(z.object({
    privateKey: z.custom<Hex>((s) => isHex(s) && s.length === 66, "Not a 32-byte hex value"),
    chains: z.array(z.object({
      chainId: z.number().int().positive(),
      rpcUrls: z.array(z.url()).default([]),
      confirmations: z.number().int().positive().optional(),
      minGasIncreasePercent: z.number().int().nonnegative().optional(),
      inclusionWaitBlocks: z.number().int().positive().optional(),
    })).nonempty(),
  })).nonempty(),
});

const testConfigSchema = z.object({
  workerRestartDelayMs: z.number().nonnegative().optional(),
  sendNextBatchMinRetryDelayMs: z.number().nonnegative().optional(),
  delayUntilBlockNumberPollingIntervalMs: z.number().nonnegative().optional(),
  waitForBalanceRetryDelayMs: z.number().nonnegative().optional(),
  burnNonceDelayInitialMs: z.number().nonnegative().optional(),
  burnNonceDelayMultiplier: z.number().nonnegative().optional(),
  burnNonceDelayMaxMs: z.number().nonnegative().optional(),
});

export type Config = {
  dbUrl: string;
  port: number;
  chainConfigs: ChainConfig[];
};

export type ChainConfig = {
  client: Client;
  confirmations: number;
  minGasIncreasePercent: number;
  inclusionWaitBlocks: number;
  workerRestartDelayMs: number;
  sendNextBatchMinRetryDelayMs: number;
  delayUntilBlockNumberPollingIntervalMs: number;
  waitForBalanceRetryDelayMs: number;
  burnNonceDelayInitialMs: number;
  burnNonceDelayMultiplier: number;
  burnNonceDelayMaxMs: number;
};

export type Client =
  & WalletClient<Transport, Chain, PrivateKeyAccount>
  & PublicClient<Transport, Chain, PrivateKeyAccount>;

export function getConfig(): Config {
  const dbUrl = getDbUrl();
  const port = z.coerce.number().int().positive().default(8000).parse(Deno.env.get("PORT"));
  const config = configSchema.parse(JSON.parse(Deno.env.get("CONFIG") ?? "{}"));
  const testConfig = testConfigSchema.parse(JSON.parse(Deno.env.get("TEST_CONFIG") ?? "{}"));

  const chains = Object.entries(viemChains)
    // Sort by chain names used in Viem as keys, lexically descending
    .sort(([chainA], [chainB]) => -chainA.localeCompare(chainB))
    // Resolve duplicate chain IDs by keeping the one from the lexically first key e.g. suffix-free.
    .reduce((map, [, chain]) => map.set(chain.id, chain), new Map<number, Chain>());

  const chainIds = new Set<number>();
  const chainConfigs: ChainConfig[] = [];
  for (const wallet of config.wallets) {
    const account = privateKeyToAccount(wallet.privateKey);
    for (const { chainId, rpcUrls, ...config } of wallet.chains) {
      if (chainIds.has(chainId)) throw new Error("Duplicate wallets for chain ID " + chainId);
      chainIds.add(chainId);

      const chain = chains.get(chainId);
      if (!chain) throw new Error("Unknown wallet chain ID " + chainId);
      const transport = fallback(rpcUrls.length ? rpcUrls.map((url) => http(url)) : [http()]);
      const client = createWalletClient({ account, chain, transport, cacheTime: 0 })
        .extend(publicActions);

      chainConfigs.push({
        client,
        confirmations: config.confirmations ?? 1,
        minGasIncreasePercent: config.minGasIncreasePercent ?? 10,
        inclusionWaitBlocks: config.inclusionWaitBlocks ?? 5,
        workerRestartDelayMs: testConfig.workerRestartDelayMs ?? 30_000,
        sendNextBatchMinRetryDelayMs: testConfig.sendNextBatchMinRetryDelayMs ?? 1_000,
        delayUntilBlockNumberPollingIntervalMs: testConfig.delayUntilBlockNumberPollingIntervalMs ??
          2_000,
        waitForBalanceRetryDelayMs: testConfig.waitForBalanceRetryDelayMs ?? 10_000,
        burnNonceDelayInitialMs: testConfig.burnNonceDelayInitialMs ?? 1_000,
        burnNonceDelayMultiplier: testConfig.burnNonceDelayMultiplier ?? 10,
        burnNonceDelayMaxMs: testConfig.burnNonceDelayMaxMs ?? 60_000,
      });
    }
  }
  return { dbUrl, port, chainConfigs };
}

export function getDbUrl(): string {
  return z.url().default("postgres://user:password@localhost:5432/tx_relay")
    .parse(Deno.env.get("DB_URL"));
}
