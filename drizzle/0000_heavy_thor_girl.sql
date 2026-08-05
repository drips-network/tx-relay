CREATE TYPE "public"."burst_state" AS ENUM('pending', 'success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."tx_state" AS ENUM('pending', 'success', 'reverted', 'skipped');--> statement-breakpoint
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
	"calldata" "bytea" NOT NULL,
	"gas" numeric(78, 0)
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"chain_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tx_payload_bursts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tx_payload_bursts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tx_payload_id" integer NOT NULL,
	"burst_id" integer NOT NULL,
	"inclusion_gas" numeric(78, 0)
);
--> statement-breakpoint
CREATE TABLE "tx_payloads" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tx_payloads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"target" "bytea" NOT NULL,
	"calldata" "bytea" DEFAULT '0x' NOT NULL,
	"value" numeric(78, 0) DEFAULT 0 NOT NULL,
	"gas" numeric(78, 0)
);
--> statement-breakpoint
CREATE TABLE "tx_senders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tx_senders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"address" "bytea" NOT NULL,
	"nonce" integer NOT NULL,
	"chain_id" integer NOT NULL,
	CONSTRAINT "tx_senders_address_nonce_chainId_unique" UNIQUE("address","nonce","chain_id")
);
--> statement-breakpoint
CREATE TABLE "txs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "txs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tx_hash" "bytea",
	"tx_sender_id" integer NOT NULL,
	"tx_payload_id" integer NOT NULL,
	"state" "tx_state" DEFAULT 'pending' NOT NULL,
	CONSTRAINT "txs_txHash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "burst_events" ADD CONSTRAINT "burst_events_burst_id_bursts_id_fk" FOREIGN KEY ("burst_id") REFERENCES "public"."bursts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bursts" ADD CONSTRAINT "bursts_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_burst_id_bursts_id_fk" FOREIGN KEY ("burst_id") REFERENCES "public"."bursts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tx_payload_bursts" ADD CONSTRAINT "tx_payload_bursts_tx_payload_id_tx_payloads_id_fk" FOREIGN KEY ("tx_payload_id") REFERENCES "public"."tx_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tx_payload_bursts" ADD CONSTRAINT "tx_payload_bursts_burst_id_bursts_id_fk" FOREIGN KEY ("burst_id") REFERENCES "public"."bursts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_tx_sender_id_tx_senders_id_fk" FOREIGN KEY ("tx_sender_id") REFERENCES "public"."tx_senders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_tx_payload_id_tx_payloads_id_fk" FOREIGN KEY ("tx_payload_id") REFERENCES "public"."tx_payloads"("id") ON DELETE no action ON UPDATE no action;