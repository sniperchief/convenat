CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rules_hash" text NOT NULL,
	"challenger" text NOT NULL,
	"reason_hash" text NOT NULL,
	"reason" text NOT NULL,
	"bond" numeric(78, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"round" integer NOT NULL,
	"challenged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "validation_plan" jsonb;--> statement-breakpoint
ALTER TABLE "resolutions" ADD COLUMN "record" jsonb;--> statement-breakpoint
ALTER TABLE "resolutions" ADD COLUMN "proposal_tx_hash" text;--> statement-breakpoint
ALTER TABLE "resolutions" ADD COLUMN "proposal_block" bigint;--> statement-breakpoint
ALTER TABLE "resolutions" ADD COLUMN "submission_state" text DEFAULT 'NOT_SUBMITTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_rules_hash_markets_rules_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."markets"("rules_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_market_round_idx" ON "challenges" USING btree ("rules_hash","round");--> statement-breakpoint
CREATE INDEX "challenges_challenger_idx" ON "challenges" USING btree ("challenger");--> statement-breakpoint
CREATE INDEX "resolutions_created_idx" ON "resolutions" USING btree ("rules_hash","created_at");