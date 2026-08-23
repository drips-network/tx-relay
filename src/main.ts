import { Application, Context, Router } from "oak";
import { z } from "zod";
import { isAddress, isHex } from "viem";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  burstsTable,
  callsTable,
  dbValueToSequenceEvent,
  sequenceEventsTable,
  sequenceEventToDbValue,
  sequencesTable,
} from "./db/schema.ts";
import { getChainConfigs, getDbUrl, getPort } from "./config.ts";
import { runWorker } from "./worker.ts";

const db = drizzle({ connection: getDbUrl(), casing: "snake_case" });
await migrate(db, { migrationsFolder: "./drizzle" });

const chainConfigs = getChainConfigs();
for (const chainConfig of Object.values(chainConfigs)) runWorker(chainConfig, db);

const sendSequencesArgSchema = z.object({
  sequences: z.array(z.object({
    chainId: z.number().refine((chainId) => chainConfigs[chainId], "Unsupported chain ID"),
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
): Promise<z.infer<S>> {
  try {
    return schema.parse(await context.request.body.json());
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")
      : String(error);
    context.throw(400, message);
  }
}

const router = new Router();
router
  .post("/send-sequences", async (context) => {
    const arg = await parseJsonArg(context, sendSequencesArgSchema);
    const sequences: { id: string }[] = [];
    await db.transaction(async (dbTx) => {
      for (const { chainId, bursts } of arg.sequences) {
        const [{ sequenceId }] = await dbTx.insert(sequencesTable)
          .values({ chainId })
          .returning({ sequenceId: sequencesTable.id });
        sequences.push({ id: sequenceId });
        for (const [idxInSequence, { calls }] of bursts.entries()) {
          const [{ burstId }] = await dbTx.insert(burstsTable)
            .values({ sequenceId, idxInSequence })
            .returning({ burstId: burstsTable.id });
          await dbTx.insert(callsTable)
            .values(calls.map(({ target, calldata }) => ({
              burstId,
              target: target,
              calldata: calldata,
            })));
        }
        const event = sequenceEventToDbValue(sequenceId, {
          kind: "created",
          details: { burstsCount: bursts.length },
        });
        await dbTx.insert(sequenceEventsTable).values(event);
      }
    });

    context.response.body = { sequences };
  })
  .post("/sequences-states", async (context) => {
    const arg = await parseJsonArg(context, sequencesStatesArgSchema);
    const sequenceIds = arg.sequences.map(({ id }) => id);

    await db.transaction(async (dbTx) => {
      const statesRows = await dbTx.select({
        sequenceId: burstsTable.sequenceId,
        pending: sql<number>`count(*) filter (where ${burstsTable.state} = 'pending')::int`,
        successes: sql<number>`count(*) filter (where ${burstsTable.state} = 'success')::int`,
        failures: sql<number>`count(*) filter (where ${burstsTable.state} = 'failure')::int`,
      })
        .from(burstsTable)
        .where(inArray(burstsTable.sequenceId, sequenceIds))
        .groupBy(burstsTable.sequenceId);
      const statesById = Object.fromEntries(statesRows.map((row) => [row.sequenceId, row]));

      const unknownIds = sequenceIds.filter((id) => !statesById[id]);
      if (unknownIds.length) {
        context.throw(404, "Unknown sequence IDs: " + unknownIds.join(", "));
      }

      const eventRows = await dbTx.select({
        sequenceId: sequenceEventsTable.sequenceId,
        timestamp: sequenceEventsTable.timestamp,
        kind: sequenceEventsTable.kind,
        details: sequenceEventsTable.details,
      }).from(sequenceEventsTable)
        .where(inArray(sequenceEventsTable.sequenceId, sequenceIds))
        .orderBy(sequenceEventsTable.id);
      const eventsById = Object.groupBy(eventRows, (row) => row.sequenceId);

      const sequences = sequenceIds.map((id) => {
        const { pending, successes, failures } = statesById[id];
        const events = (eventsById[id] ?? [])
          .map(({ timestamp, kind, details }) => ({
            timestamp,
            ...dbValueToSequenceEvent(kind, details),
          }));
        return { id, pending, successes, failures, events };
      });
      context.response.body = { sequences };
    });
  });

await new Application()
  .use(router.routes())
  .use(router.allowedMethods())
  .listen({ port: getPort(), hostname: "[::]" });
