CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"domain" text NOT NULL,
	"uri" text NOT NULL,
	"statement" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compilations" (
	"rules_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"creator" text NOT NULL,
	"chain_id" integer NOT NULL,
	"specification" jsonb NOT NULL,
	"canonical" text NOT NULL,
	"compiler_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compiler_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator" text NOT NULL,
	"chain_id" integer NOT NULL,
	"compiler_version" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compiler_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rules_hash" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"package" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_blocks" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "indexer_blocks_chain_id_block_number_pk" PRIMARY KEY("chain_id","block_number")
);
--> statement-breakpoint
CREATE TABLE "indexer_checkpoints" (
	"chain_id" integer NOT NULL,
	"stream" text NOT NULL,
	"start_block" bigint NOT NULL,
	"last_processed_block" bigint NOT NULL,
	"last_processed_block_hash" text,
	"rewind_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "indexer_checkpoints_chain_id_stream_pk" PRIMARY KEY("chain_id","stream")
);
--> statement-breakpoint
CREATE TABLE "market_chain_state" (
	"chain_id" integer NOT NULL,
	"contract_address" text NOT NULL,
	"chain_market_id" bigint NOT NULL,
	"rules_hash" text NOT NULL,
	"creator" text NOT NULL,
	"token" text NOT NULL,
	"state" text NOT NULL,
	"total_yes" numeric(78, 0) NOT NULL,
	"total_no" numeric(78, 0) NOT NULL,
	"pool" numeric(78, 0) NOT NULL,
	"challenge_bond" numeric(78, 0) NOT NULL,
	"proposed_outcome" text NOT NULL,
	"final_outcome" text NOT NULL,
	"cancellation_reason" text NOT NULL,
	"proposal_round" integer NOT NULL,
	"refund_mode" boolean NOT NULL,
	"trading_ends_at" bigint NOT NULL,
	"condition_deadline" bigint NOT NULL,
	"proposed_at" bigint NOT NULL,
	"challenged_at" bigint NOT NULL,
	"finalized_at" bigint NOT NULL,
	"challenge_ends_at" bigint NOT NULL,
	"evidence_hash" text NOT NULL,
	"challenger" text NOT NULL,
	"bond_outstanding" boolean NOT NULL,
	"last_event_block" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_chain_state_chain_id_contract_address_pk" PRIMARY KEY("chain_id","contract_address")
);
--> statement-breakpoint
CREATE TABLE "market_events" (
	"chain_id" integer NOT NULL,
	"transaction_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"contract_address" text NOT NULL,
	"event_name" text NOT NULL,
	"chain_market_id" bigint,
	"rules_hash" text,
	"args" jsonb NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_events_chain_id_transaction_hash_log_index_pk" PRIMARY KEY("chain_id","transaction_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"rules_hash" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"chain_market_id" bigint,
	"contract_address" text,
	"creator" text NOT NULL,
	"question" text NOT NULL,
	"specification" jsonb NOT NULL,
	"canonical" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"trading_ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rules_hash" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"confidence_bps" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"evidence_hash" text,
	"resolver_version" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"proposed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compilations" ADD CONSTRAINT "compilations_session_id_compiler_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."compiler_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compiler_turns" ADD CONSTRAINT "compiler_turns_session_id_compiler_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."compiler_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_rules_hash_markets_rules_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."markets"("rules_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_rules_hash_markets_rules_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."markets"("rules_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_nonces_address_idx" ON "auth_nonces" USING btree ("address","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_idx" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_address_idx" ON "auth_sessions" USING btree ("address","expires_at");--> statement-breakpoint
CREATE INDEX "compiler_sessions_creator_idx" ON "compiler_sessions" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "compiler_turns_session_idx" ON "compiler_turns" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_market_idx" ON "evidence" USING btree ("rules_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "market_chain_state_rules_hash_idx" ON "market_chain_state" USING btree ("chain_id","rules_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "market_chain_state_market_id_idx" ON "market_chain_state" USING btree ("chain_id","chain_market_id");--> statement-breakpoint
CREATE INDEX "market_events_market_idx" ON "market_events" USING btree ("chain_id","chain_market_id","block_number");--> statement-breakpoint
CREATE INDEX "market_events_rules_hash_idx" ON "market_events" USING btree ("rules_hash");--> statement-breakpoint
CREATE INDEX "market_events_block_idx" ON "market_events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_chain_market_idx" ON "markets" USING btree ("chain_id","chain_market_id");--> statement-breakpoint
CREATE INDEX "markets_creator_idx" ON "markets" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "markets_status_idx" ON "markets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "resolutions_market_idx" ON "resolutions" USING btree ("rules_hash","round");