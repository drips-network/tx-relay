import { sql } from "drizzle-orm";
import {
  customType,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { z } from "zod";

const bytea = customType<{ data: Hex; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: hexToBytes,
  fromDriver: bytesToHex,
});

const uint256 = () => numeric({ precision: 78, scale: 0, mode: "bigint" });

// Inserted when a sequence is queued for execution.
export const sequencesTable = pgTable("sequences", {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  chainId: integer().notNull(),
});

export const burstStateEnum = pgEnum("burst_state", ["pending", "success", "failure"]);

// Inserted when a sequence is queued for execution. 1 row per burst in a sequence.
export const burstsTable = pgTable("bursts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  sequenceId: uuid().notNull().references(() => sequencesTable.id),
  idxInSequence: integer().notNull(),
  state: burstStateEnum().notNull().default("pending"),
});

// Inserted when a sequence is queued for execution. 1 row per call in a burst.
export const callsTable = pgTable("calls", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  burstId: integer().notNull().references(() => burstsTable.id),
  target: bytea().notNull(),
  calldata: bytea().notNull(),
  gas: uint256(),
});

export const sequenceEventKindEnum = pgEnum("event_kind", [
  "created",
  "rejected",
  "submitted",
  "executed",
  "skipped",
]);

// Inserted when a sequence event occurs.
export const sequenceEventsTable = pgTable("sequence_events", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  sequenceId: uuid().notNull().references(() => sequencesTable.id),
  timestamp: timestamp({ withTimezone: true }).notNull().defaultNow(),
  kind: sequenceEventKindEnum().notNull(),
  details: jsonb().notNull(),
});

const sequenceEventCreatedSchema = z.object({
  kind: z.literal("created"),
  details: z.object({ burstsCount: z.number() }),
});

const sequenceEventRejectedSchema = z.object({
  kind: z.literal("rejected"),
  details: z.object({ fromIdxInSequence: z.number() }),
});

const sequenceEventSubmittedSchema = z.object({
  kind: z.literal("submitted"),
  details: z.object({ fromIdxInSequence: z.number(), burstsCount: z.number() }),
});

const sequenceEventExecutedSchema = z.object({
  kind: z.literal("executed"),
  details: z.object({ fromIdxInSequence: z.number(), successes: z.number(), failed: z.boolean() }),
});

const sequenceEventSkippedSchema = z.object({
  kind: z.literal("skipped"),
  details: z.object({}),
});

const sequenceEventSchema = z.discriminatedUnion("kind", [
  sequenceEventCreatedSchema,
  sequenceEventRejectedSchema,
  sequenceEventSubmittedSchema,
  sequenceEventExecutedSchema,
  sequenceEventSkippedSchema,
]);

export type SequenceEvent = z.infer<typeof sequenceEventSchema>;
export type SequenceEventKindEnum = (typeof sequenceEventKindEnum.enumValues)[number];

export function sequenceEventToDbValue(
  sequenceId: string,
  { kind, details }: SequenceEvent,
): { sequenceId: string; kind: SequenceEventKindEnum; details: unknown } {
  return { sequenceId, kind, details };
}

export function dbValueToSequenceEvent(
  kind: SequenceEventKindEnum,
  details: unknown,
): SequenceEvent {
  return sequenceEventSchema.parse({ kind, details });
}

// Inserted when a new transaction sender is prepared to send its first transaction.
// The sender is considered new when it uses a previously unused nonce on the given chain.
export const txSendersTable = pgTable(
  "tx_senders",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    address: bytea().notNull(),
    nonce: integer().notNull(),
    chainId: integer().notNull(),
  },
  (table) => [unique().on(table.address, table.nonce, table.chainId)],
);

export const txStateEnum = pgEnum("tx_state", ["pending", "success", "reverted", "skipped"]);

// Inserted when a signed transaction is published.
export const txsTable = pgTable("txs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txHash: bytea().unique(),
  txPayloadId: integer().notNull().references(() => txPayloadsTable.id),
  state: txStateEnum().notNull().default("pending"),
});

// Inserted when a new payload for transactions is created.
export const txPayloadsTable = pgTable("tx_payloads", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txSenderId: integer().notNull().references(() => txSendersTable.id),
  target: bytea().notNull(),
  calldata: bytea().notNull().default("0x"),
  value: uint256().notNull().default(sql`0`),
  gas: uint256(),
});

// Inserted when a batch is created, 1 row per burst in a batch.
export const txPayloadBurstsTable = pgTable("tx_payload_bursts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txPayloadId: integer().notNull().references(() => txPayloadsTable.id),
  burstId: integer().notNull().references(() => burstsTable.id),
  inclusionGas: uint256().notNull(),
});
