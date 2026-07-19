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

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

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

// sendRawTx
export const txsTable = pgTable("txs", {
  txHash: bytea().primaryKey(),
  txSenderId: integer().notNull().references(() => txSendersTable.id),
  txPayloadId: integer().notNull().references(() => txPayloadsTable.id),
  state: burstStateEnum().notNull().default("pending"),
  // receipt: logs? gas price? gas used? cost?
});

export const txPayloadsTable = pgTable("tx_payloads", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  target: bytea().notNull(),
  calldata: bytea().notNull().default(new Uint8Array()),
  value: numeric({precision: 78, scale: 0, mode: "bigint"}).notNull().default(BigInt(0)),
});


// Added by sendbatch

export const batchesTable = pgTable("batches", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  callId: integer().notNull().references(() => callsTable.id),
  txPayloadId: integer().notNull().references(() => txPayloadsTable.id),
});


export const batchBurstsTable = pgTable("batch_bursts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  batchId: integer().notNull().references(() => batchesTable.id),
  burstId: integer().notNull().references(() => burstsTable.id),
});






// call[] -> burst
// burst -> tx[]
// tx[] -> sender

// call[] -> burst => sendburst
// tx -> sender => sendburst => prepareTx
// burst -> tx => sendburst


// tx -> sender =>
