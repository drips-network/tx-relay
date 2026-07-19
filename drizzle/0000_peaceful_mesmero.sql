CREATE TYPE "public"."burst_state" AS ENUM('pending', 'success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."tx_state" AS ENUM('pending', 'success', 'reverted', 'skipped');--> statement-breakpoint
CREATE TABLE "batch_calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batch_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"batch_id" integer NOT NULL,
	"call_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_txs" (
	"batch_id" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "burst_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "burst_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"burst_id" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bursts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bursts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sequence_id" uuid NOT NULL,
	"state" "burst_state" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"burst_id" integer NOT NULL,
	"target" "bytea" NOT NULL,
	"calldata" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"chain_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tx_senders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tx_senders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"address" "bytea" NOT NULL,
	"nonce" integer NOT NULL,
	"chain_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "txs" (
	"tx_hash" "bytea" PRIMARY KEY NOT NULL,
	"txs_sender_id" integer NOT NULL,
	"state" "burst_state" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_calls" ADD CONSTRAINT "batch_calls_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_calls" ADD CONSTRAINT "batch_calls_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_txs" ADD CONSTRAINT "batch_txs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_txs" ADD CONSTRAINT "batch_txs_tx_hash_txs_tx_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "public"."txs"("tx_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burst_events" ADD CONSTRAINT "burst_events_burst_id_bursts_id_fk" FOREIGN KEY ("burst_id") REFERENCES "public"."bursts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bursts" ADD CONSTRAINT "bursts_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_burst_id_bursts_id_fk" FOREIGN KEY ("burst_id") REFERENCES "public"."bursts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_txs_sender_id_tx_senders_id_fk" FOREIGN KEY ("txs_sender_id") REFERENCES "public"."tx_senders"("id") ON DELETE no action ON UPDATE no action;