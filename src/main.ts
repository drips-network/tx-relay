import { Application, Context, Router } from "oak";
import { z } from "zod";
import { isAddress, isHex } from "viem";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { burstsTable, callsTable, sequencesTable } from "./db/schema.ts";
import { getDbUrl, getPort, getWallets } from "./config.ts";
import { runWalletWorker } from "./worker.ts";

const db = drizzle({ connection: getDbUrl(), casing: "snake_case" });
await migrate(db, { migrationsFolder: "./drizzle" });

const wallets = getWallets();
for (const wallet of Object.values(wallets)) runWalletWorker(wallet, db);

const sendSequencesArgSchema = z.object({
  sequences: z.array(z.object({
    chainId: z.number().refine((chainId) => wallets[chainId], "Unsupported chain ID"),
    bursts: z.array(z.object({
      calls: z.array(z.object({
        target: z.string().refine(isAddress, "Not an address"),
        calldata: z.string().refine(isHex, "Not a valid hex value"),
      })).nonempty(),
    })).nonempty(),
  })).nonempty(),
});

const sequencesStatesArgSchema = z.object({
  sequences: z.array(z.object({
    id: z.uuid(),
  })).nonempty(),
});

async function parseJsonArg<S extends z.ZodTypeAny>(
  context: Context,
  schema: S,
): Promise<z.infer<S> | undefined> {
  try {
    return schema.parse(await context.request.body.json());
  } catch (error) {
    context.response.status = 400;
    context.response.body = error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")
      : String(error);
  }
}

const router = new Router();
router
  .post("/send-sequences", async (context) => {
    let arg = await parseJsonArg(context, sendSequencesArgSchema);
    if (arg === undefined) return;

    const sequences: { id: string }[] = [];
    await db.transaction(async (tx) => {
      for (const { chainId, bursts } of arg.sequences) {
        const [{ sequenceId }] = await tx.insert(sequencesTable)
          .values({ chainId })
          .returning({ sequenceId: sequencesTable.id });
        sequences.push({ id: sequenceId });
        for (const { calls } of bursts) {
          const [{ burstId }] = await tx.insert(burstsTable)
            .values({ sequenceId })
            .returning({ burstId: burstsTable.id });
          await tx.insert(callsTable)
            .values(calls.map(({ target, calldata }) => ({
              burstId,
              target: target,
              calldata: calldata,
            })));
        }
      }
    });

    context.response.body = { sequences };
  })
  .post("/sequences-states", async (context) => {
    let arg = await parseJsonArg(context, sequencesStatesArgSchema);
    if (arg === undefined) return;
    const sequenceIds = arg.sequences.map(({ id }) => id);

    const states = await db.select({
      sequenceId: burstsTable.sequenceId,
      pending: sql<number>`count(*) filter (where ${burstsTable.state} = 'pending')::int`,
      successes: sql<number>`count(*) filter (where ${burstsTable.state} = 'success')::int`,
      failures: sql<number>`count(*) filter (where ${burstsTable.state} = 'failure')::int`,
    })
      .from(burstsTable)
      .where(inArray(burstsTable.sequenceId, sequenceIds))
      .groupBy(burstsTable.sequenceId);
    const statesById = Object.fromEntries(states.map((state) => [state.sequenceId, state]));
    const sequences = sequenceIds.map((id) => {
      const state = statesById[id];
      return {
        id,
        pending: state.pending,
        successes: state.successes,
        failures: state.failures,
      };
    });

    context.response.body = { sequences };
  });

await new Application()
  .use(router.routes())
  .use(router.allowedMethods())
  .listen({ port: getPort(), hostname: "[::]" });
