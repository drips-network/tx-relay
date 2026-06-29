import { sql } from "drizzle-orm";
import {
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const sequencesTable = pgTable("sequences", {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  chainId: integer().notNull(),
});

export const batchStateEnum = pgEnum("batch_state", ["pending", "success", "failure"]);

export const batchesTable = pgTable("batches", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  sequenceId: uuid().notNull().references(() => sequencesTable.id),
  state: batchStateEnum().notNull().default("pending"),
});

export const batchEventsTable = pgTable("batch_events", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  batchId: integer().notNull().references(() => batchesTable.id),
  timestamp: timestamp({ withTimezone: true }).notNull().defaultNow(),
  event: jsonb().notNull(),
});

export const callsTable = pgTable("calls", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  batchId: integer().notNull().references(() => batchesTable.id),
  target: bytea().notNull(),
  calldata: bytea().notNull(),
});

export const publishedTxsTable = pgTable("published_txs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  walletAddr: bytea().notNull(),
  walletNonce: integer().notNull(),
  chainId: integer().notNull(),
});

export const publishedTxHashesTable = pgTable("published_tx_hashes", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  publishedTxId: integer().notNull().references(() => publishedTxsTable.id),
  txHash: bytea().notNull(),
});

export const publishedCallsTable = pgTable("published_calls", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txId: integer().notNull().references(() => publishedTxsTable.id),
  callId: integer().notNull().references(() => callsTable.id),
});
