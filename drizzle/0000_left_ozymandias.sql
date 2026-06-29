CREATE TYPE "public"."batch_state" AS ENUM('pending', 'success', 'failure');--> statement-breakpoint
CREATE TABLE "batch_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batch_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"batch_id" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sequence_id" uuid NOT NULL,
	"state" "batch_state" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"batch_id" integer NOT NULL,
	"target" "bytea" NOT NULL,
	"calldata" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "published_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tx_id" integer NOT NULL,
	"call_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_tx_hashes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "published_tx_hashes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"published_tx_id" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_txs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "published_txs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"wallet_addr" "bytea" NOT NULL,
	"wallet_nonce" integer NOT NULL,
	"chain_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"chain_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_events" ADD CONSTRAINT "batch_events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_calls" ADD CONSTRAINT "published_calls_tx_id_published_txs_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."published_txs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_calls" ADD CONSTRAINT "published_calls_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_tx_hashes" ADD CONSTRAINT "published_tx_hashes_published_tx_id_published_txs_id_fk" FOREIGN KEY ("published_tx_id") REFERENCES "public"."published_txs"("id") ON DELETE no action ON UPDATE no action;