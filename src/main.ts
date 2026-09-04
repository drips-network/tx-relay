import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createApp } from "./app.ts";
import { getConfig } from "./config.ts";
import { runWorker } from "./worker.ts";

const { dbUrl, port, chainConfigs } = getConfig();

const db = drizzle({ connection: dbUrl, casing: "snake_case" });
await migrate(db, { migrationsFolder: "./drizzle" });

const workersHealth = chainConfigs.values()
  .map((chainConfig) => runWorker(chainConfig, db))
  .toArray()
  .sort((workerA, workerB) => workerA.name.localeCompare(workerB.name));

const chainIds = new Set(chainConfigs.values().map(({ client }) => client.chain.id));

await createApp(db, chainIds, workersHealth)
  .listen({ port, hostname: "[::]" });
