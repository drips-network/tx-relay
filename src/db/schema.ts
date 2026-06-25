import { sql } from "drizzle-orm";
import { customType, integer, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const sequences = pgTable("sequences", {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  chainId: integer().notNull(),
});

export const callState = pgEnum("call_state", ["pending", "success", "failure"]);

export const calls = pgTable("calls", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  sequenceId: uuid().notNull().references(() => sequences.id),
  state: callState().notNull().default("pending"),
});

export const calldatas = pgTable("calldatas", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  callId: integer().notNull().references(() => calls.id),
  calldata: bytea().notNull(),
});

export const callEvents = pgTable("call_events", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  callId: integer().notNull().references(() => calls.id),
  timestamp: timestamp({ withTimezone: true }).notNull().defaultNow(),
  event: jsonb().notNull(),
});

export const publishedTxs = pgTable("published_txs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  walletAddr: bytea().notNull(),
  walletNonce: integer().notNull(),
  chainId: integer().notNull(),
});

export const publishedTxHashes = pgTable("published_tx_hashes", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  publishedTxId: integer().notNull().references(() => publishedTxs.id),
  txHash: bytea().notNull(),
});

export const publishedCalls = pgTable("published_calls", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txId: integer().notNull().references(() => publishedTxs.id),
  callId: integer().notNull().references(() => calls.id),
});
