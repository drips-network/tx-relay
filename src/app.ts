import { Application, Context, Router } from "oak";
import { z } from "zod";
import { eq, inArray, sql } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  burstsTable,
  callsTable,
  dbValueToSequenceEvent,
  sequenceEventSchema,
  sequenceEventsTable,
  sequenceEventToDbValue,
  sequencesTable,
  zodAddress,
  zodHex,
} from "./db-schema.ts";
import { WorkerHealth } from "./worker.ts";

export const healthSchema = z.object({
  runningSince: z.coerce.date(),
  workers: z.array(z.object({
    name: z.string(),
    runningSince: z.coerce.date().nullable(),
  })),
});
export type Health = z.infer<typeof healthSchema>;

export const sendSequencesArgSchema = z.object({
  sequences: z.array(z.object({
    chainId: z.number().int().positive(),
    bursts: z.array(z.object({
      gasBufferPercent: z.number().int().nonnegative().optional(),
      calls: z.array(z.object({
        target: zodAddress,
        calldata: zodHex,
        gas: z.number().int().positive().optional(),
      })).nonempty(),
    })).nonempty(),
  })).nonempty(),
});
export type SendSequencesArg = z.infer<typeof sendSequencesArgSchema>;

export const sendSequencesSchema = z.object({
  sequences: z.array(z.object({
    id: z.uuid(),
  })).nonempty(),
});
export type SendSequences = z.infer<typeof sendSequencesSchema>;

export const sequencesStatesArgSchema = z.object({
  sequences: z.array(z.object({
    id: z.uuid(),
  })).nonempty().max(1_000),
});
export type SequencesStatesArg = z.infer<typeof sequencesStatesArgSchema>;

export const sequencesStatesSchema = z.object({
  sequences: z.array(z.object({
    id: z.uuid(),
    pending: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    events: z.array(z.intersection(sequenceEventSchema, z.object({ timestamp: z.coerce.date() }))),
  })).nonempty(),
});
export type SequencesStates = z.infer<typeof sequencesStatesSchema>;

export const sequencesConfigsArgSchema = z.object({
  sequences: z.array(z.object({
    id: z.uuid(),
  })).nonempty().max(1_000),
});
export type SequencesConfigsArg = z.infer<typeof sequencesConfigsArgSchema>;

export const sequencesConfigsSchema = sendSequencesArgSchema;
export type SequencesConfigs = z.infer<typeof sequencesConfigsSchema>;

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

export function createApp(
  db: PostgresJsDatabase,
  chainIds: Set<number>,
  workersHealth: WorkerHealth[],
): Application {
  const runningSince = new Date();
  const router = new Router();
  router
    .get("/health", (context) => {
      context.response.body = {
        runningSince,
        workers: workersHealth.map(({ name, runningSince }) => ({ name, runningSince })),
      } satisfies Health;
    })
    .post("/send-sequences", async (context) => {
      const arg = await parseJsonArg(context, sendSequencesArgSchema);

      let callsCount = 0;
      for (const { chainId, bursts } of arg.sequences) {
        if (!chainIds.has(chainId)) context.throw(400, "Unsupported chain ID " + chainId);
        for (const { calls } of bursts) {
          callsCount += calls.length;
        }
      }
      // Each Postgres request can accept up to 65_533 arguments.
      // All calls are inserted in a single request, with each call requiring 4 arguments,
      // so the limit of  16_000 calls caps the largest possible request at 64_000 arguments.
      // All other inserts in this route use fewer arguments per row
      // and their row counts never exceed the number of calls.
      if (callsCount > 16_000) {
        context.throw(400, "More than 16000 calls in a single request, got " + callsCount);
      }

      await db.transaction(async (dbTx) => {
        const sequenceIds = await dbTx.insert(sequencesTable)
          .values(arg.sequences.map(({ chainId }) => ({ chainId })))
          .returning({ sequenceId: sequencesTable.id });

        const burstValues = arg.sequences.flatMap(({ bursts }, sequenceIdx) => {
          const { sequenceId } = sequenceIds[sequenceIdx]!;
          return bursts.map(({ gasBufferPercent }, idxInSequence) => ({
            sequenceId,
            idxInSequence,
            gasBufferPercent,
          }));
        });
        const burstIds = await dbTx.insert(burstsTable)
          .values(burstValues)
          .returning({ burstId: burstsTable.id });

        const callValues = arg.sequences.flatMap(({ bursts }) => bursts)
          .flatMap(({ calls }, burstIdx) => {
            const { burstId } = burstIds[burstIdx];
            return calls.map(({ target, calldata, gas }) => (
              { burstId, target, calldata, gas: gas === undefined ? null : BigInt(gas) }
            ));
          });
        await dbTx.insert(callsTable).values(callValues);

        const eventValues = arg.sequences.map(({ bursts }, sequenceIdx) =>
          sequenceEventToDbValue(sequenceIds[sequenceIdx]!.sequenceId, {
            kind: "created",
            details: { burstsCount: bursts.length },
          })
        );
        await dbTx.insert(sequenceEventsTable).values(eventValues);

        context.response.body = {
          sequences: sequenceIds.map(({ sequenceId }) => ({ id: sequenceId })),
        } satisfies SendSequences;
      });
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
        context.response.body = { sequences } satisfies SequencesStates;
      });
    })
    .post("/sequences-configs", async (context) => {
      const arg = await parseJsonArg(context, sequencesConfigsArgSchema);
      const sequenceIds = arg.sequences.map(({ id }) => id);

      const callRows = await db.select({
        sequenceId: sequencesTable.id,
        chainId: sequencesTable.chainId,
        burstId: burstsTable.id,
        gasBufferPercent: burstsTable.gasBufferPercent,
        target: callsTable.target,
        calldata: callsTable.calldata,
        gas: callsTable.gas,
      })
        .from(callsTable)
        .innerJoin(burstsTable, eq(burstsTable.id, callsTable.burstId))
        .innerJoin(sequencesTable, eq(sequencesTable.id, burstsTable.sequenceId))
        .where(inArray(sequencesTable.id, sequenceIds))
        .orderBy(burstsTable.id, callsTable.id);

      const callsBySequenceId = Object.groupBy(callRows, (row) => row.sequenceId);
      const unknownIds = sequenceIds.filter((id) => !callsBySequenceId[id]);
      if (unknownIds.length) {
        context.throw(404, "Unknown sequence IDs: " + unknownIds.join(", "));
      }

      const sequences = sequenceIds.map((sequenceId) => {
        const calls = callsBySequenceId[sequenceId]!;
        const bursts: SequencesConfigs["sequences"][number]["bursts"] = [];
        let lastBurstId: number | undefined;
        for (const { burstId, gasBufferPercent, target, calldata, gas } of calls) {
          if (burstId !== lastBurstId) {
            bursts.push({ gasBufferPercent: gasBufferPercent ?? undefined, calls: [] });
          }
          const call = { target, calldata, gas: gas === null ? undefined : Number(gas) };
          bursts.at(-1)!.calls.push(call);
          lastBurstId = burstId;
        }
        return { chainId: calls[0].chainId, bursts };
      });
      context.response.body = { sequences } satisfies SequencesConfigs;
    });

  return new Application()
    .use(router.routes())
    .use(router.allowedMethods());
}
