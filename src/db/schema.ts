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
  varchar,
} from "drizzle-orm/pg-core";
import { bytesToHex, type Hex, hexToBytes } from "viem";

const bytea = customType<{ data: Hex; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: hexToBytes,
  fromDriver: bytesToHex,
});

const uint256 = () => numeric({ precision: 78, scale: 0, mode: "bigint" });

export const sequencesTable = pgTable("sequences", {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  chainId: integer().notNull(),
});

export const burstStateEnum = pgEnum("burst_state", ["pending", "success", "failure"]);

export const burstsTable = pgTable("bursts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  sequenceId: uuid().notNull().references(() => sequencesTable.id),
  state: burstStateEnum().notNull().default("pending"),
});

export const burstEventsTable = pgTable("burst_events", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  burstId: integer().notNull().references(() => burstsTable.id),
  timestamp: timestamp({ withTimezone: true }).notNull().defaultNow(),
  event: jsonb().notNull(),
});

export const callsTable = pgTable("calls", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  burstId: integer().notNull().references(() => burstsTable.id),
  target: bytea().notNull(),
  calldata: bytea().notNull(),
  gas: uint256(),
});

// Added by prepareTx

// initTxSender?            restoreTxs - mark done?
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

export const txsTable = pgTable("txs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txHash: bytea().unique(),
  txSenderId: integer().notNull().references(() => txSendersTable.id),
  txPayloadId: integer().notNull().references(() => txPayloadsTable.id),
  state: txStateEnum().notNull().default("pending"),
});

export const txPayloadsTable = pgTable("tx_payloads", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  target: bytea().notNull(),
  calldata: bytea().notNull().default("0x"),
  value: uint256().notNull().default(sql`0`),
  gas: uint256(),
});

export const txPayloadBurstsTable = pgTable("tx_payload_bursts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  txPayloadId: integer().notNull().references(() => txPayloadsTable.id),
  burstId: integer().notNull().references(() => burstsTable.id),
  inclusionGas: uint256(),
});
