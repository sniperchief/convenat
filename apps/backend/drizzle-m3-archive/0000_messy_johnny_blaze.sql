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
CREATE TABLE "indexer_state" (
	"chain_id" integer NOT NULL,
	"contract_address" text NOT NULL,
	"last_processed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "indexer_state_chain_id_contract_address_pk" PRIMARY KEY("chain_id","contract_address")
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
CREATE INDEX "compiler_sessions_creator_idx" ON "compiler_sessions" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "compiler_turns_session_idx" ON "compiler_turns" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_market_idx" ON "evidence" USING btree ("rules_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_chain_market_idx" ON "markets" USING btree ("chain_id","chain_market_id");--> statement-breakpoint
CREATE INDEX "markets_creator_idx" ON "markets" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "markets_status_idx" ON "markets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "resolutions_market_idx" ON "resolutions" USING btree ("rules_hash","round");