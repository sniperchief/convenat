-- ===========================================================================
-- Covenant — schema for M4.
--
-- Paste this whole file into the Neon SQL editor (or any psql session) and run
-- it. It is the same schema drizzle-kit generates in 0000_unusual_goliath.sql,
-- rewritten to be safe to run more than once: every object uses IF NOT EXISTS,
-- and the foreign keys are guarded, so re-running it changes nothing.
--
-- Run it against the database in DATABASE_URL. Nothing here is destructive —
-- there is no DROP anywhere in this file.
--
-- Three groups of tables:
--   application state  wallets, compiler_sessions, compiler_turns,
--                      compilations, markets, resolutions, evidence
--   chain index        market_events, market_chain_state,
--                      indexer_checkpoints, indexer_blocks
--   authentication     auth_nonces, auth_sessions
--
-- No table stores a private key, an API key, or any credential. `auth_sessions`
-- stores a SHA-256 of a session token, never the token itself.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Application state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "wallets" (
  "address"       text PRIMARY KEY NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "compiler_sessions" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "creator"          text NOT NULL,
  "chain_id"         integer NOT NULL,
  "compiler_version" text NOT NULL,
  "status"           text DEFAULT 'OPEN' NOT NULL,  -- OPEN | COMPILED
  "created_at"       timestamp with time zone NOT NULL,
  "updated_at"       timestamp with time zone NOT NULL
);

-- The compiler transcript, so a compilation can be explained after the fact.
CREATE TABLE IF NOT EXISTS "compiler_turns" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "role"       text NOT NULL,                       -- user | assistant
  "content"    text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);

-- A compiled specification, keyed by its rules hash. Most never become markets.
CREATE TABLE IF NOT EXISTS "compilations" (
  "rules_hash"       text PRIMARY KEY NOT NULL,
  "session_id"       uuid,
  "creator"          text NOT NULL,
  "chain_id"         integer NOT NULL,
  "specification"    jsonb NOT NULL,
  "canonical"        text NOT NULL,
  "compiler_version" text NOT NULL,
  "created_at"       timestamp with time zone NOT NULL
);

-- A market, from approval onward. chain_market_id and contract_address stay
-- NULL until the creator's wallet opens the market and the indexer sees it.
CREATE TABLE IF NOT EXISTS "markets" (
  "rules_hash"       text PRIMARY KEY NOT NULL,
  "chain_id"         integer NOT NULL,
  "chain_market_id"  bigint,
  "contract_address" text,
  "creator"          text NOT NULL,
  "question"         text NOT NULL,
  "specification"    jsonb NOT NULL,
  "canonical"        text NOT NULL,
  "deadline"         timestamp with time zone NOT NULL,
  "trading_ends_at"  timestamp with time zone NOT NULL,
  "status"           text NOT NULL,
  "created_at"       timestamp with time zone NOT NULL,
  "updated_at"       timestamp with time zone NOT NULL
);

-- Written by the resolution engine in M5; read-only before then.
CREATE TABLE IF NOT EXISTS "resolutions" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rules_hash"       text NOT NULL,
  "status"           text NOT NULL,                 -- PROPOSED | NEEDS_REVIEW | RESOLUTION_FAILED
  "outcome"          text,                          -- YES | NO | INVALID, or NULL
  "confidence_bps"   integer DEFAULT 0 NOT NULL,
  "reason"           text NOT NULL,
  "evidence_hash"    text,
  "resolver_version" text NOT NULL,
  "round"            integer DEFAULT 1 NOT NULL,
  "proposed_at"      timestamp with time zone,
  "finalized_at"     timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL
);

-- Stored whole, so anyone can re-derive evidence_hash and compare it to the
-- value committed on-chain.
CREATE TABLE IF NOT EXISTS "evidence" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rules_hash"    text NOT NULL,
  "evidence_hash" text NOT NULL,
  "package"       jsonb NOT NULL,
  "created_at"    timestamp with time zone NOT NULL
);

-- ---------------------------------------------------------------------------
-- Chain index — a cache of the chain. The contract stays authoritative.
-- ---------------------------------------------------------------------------

-- The primary key IS the event's own identity: (chain, tx, log index). That is
-- what makes the indexer safe to restart — replaying a block re-inserts the
-- same rows and the conflict is ignored.
CREATE TABLE IF NOT EXISTS "market_events" (
  "chain_id"         integer NOT NULL,
  "transaction_hash" text NOT NULL,
  "log_index"        integer NOT NULL,
  "block_number"     bigint NOT NULL,
  "block_hash"       text NOT NULL,
  "contract_address" text NOT NULL,
  "event_name"       text NOT NULL,
  "chain_market_id"  bigint,
  "rules_hash"       text,
  "args"             jsonb NOT NULL,
  "indexed_at"       timestamp with time zone NOT NULL,
  CONSTRAINT "market_events_chain_id_transaction_hash_log_index_pk"
    PRIMARY KEY ("chain_id", "transaction_hash", "log_index")
);

-- Cached market state. numeric(78,0) holds a uint256 exactly; bigint would
-- silently wrap and a float would lose precision. No value here decides a payout.
CREATE TABLE IF NOT EXISTS "market_chain_state" (
  "chain_id"            integer NOT NULL,
  "contract_address"    text NOT NULL,
  "chain_market_id"     bigint NOT NULL,
  "rules_hash"          text NOT NULL,
  "creator"             text NOT NULL,
  "token"               text NOT NULL,
  "state"               text NOT NULL,
  "total_yes"           numeric(78, 0) NOT NULL,
  "total_no"            numeric(78, 0) NOT NULL,
  "pool"                numeric(78, 0) NOT NULL,
  "challenge_bond"      numeric(78, 0) NOT NULL,
  "proposed_outcome"    text NOT NULL,
  "final_outcome"       text NOT NULL,
  "cancellation_reason" text NOT NULL,
  "proposal_round"      integer NOT NULL,
  "refund_mode"         boolean NOT NULL,
  "trading_ends_at"     bigint NOT NULL,
  "condition_deadline"  bigint NOT NULL,
  "proposed_at"         bigint NOT NULL,
  "challenged_at"       bigint NOT NULL,
  "finalized_at"        bigint NOT NULL,
  "challenge_ends_at"   bigint NOT NULL,
  "evidence_hash"       text NOT NULL,
  "challenger"          text NOT NULL,
  "bond_outstanding"    boolean NOT NULL,
  "last_event_block"    bigint NOT NULL,
  "updated_at"          timestamp with time zone NOT NULL,
  CONSTRAINT "market_chain_state_chain_id_contract_address_pk"
    PRIMARY KEY ("chain_id", "contract_address")
);

-- Where the indexer resumes from. last_processed_block_hash is what makes
-- restart-time reorg detection possible.
CREATE TABLE IF NOT EXISTS "indexer_checkpoints" (
  "chain_id"                  integer NOT NULL,
  "stream"                    text NOT NULL,
  "start_block"               bigint NOT NULL,
  "last_processed_block"      bigint NOT NULL,
  "last_processed_block_hash" text,
  "rewind_count"              integer DEFAULT 0 NOT NULL,
  "updated_at"                timestamp with time zone NOT NULL,
  CONSTRAINT "indexer_checkpoints_chain_id_stream_pk"
    PRIMARY KEY ("chain_id", "stream")
);

-- Recent block hashes, kept only as far back as the reorg window. A mismatch
-- against the chain is how a reorg is detected.
CREATE TABLE IF NOT EXISTS "indexer_blocks" (
  "chain_id"     integer NOT NULL,
  "block_number" bigint NOT NULL,
  "block_hash"   text NOT NULL,
  "observed_at"  timestamp with time zone NOT NULL,
  CONSTRAINT "indexer_blocks_chain_id_block_number_pk"
    PRIMARY KEY ("chain_id", "block_number")
);

-- ---------------------------------------------------------------------------
-- Authentication (SIWE / EIP-4361)
-- ---------------------------------------------------------------------------

-- The full message fields are stored, not just the nonce: verification rebuilds
-- the signed message from THESE values, so a client cannot vary any of them.
-- consumed_at is what closes the replay window.
CREATE TABLE IF NOT EXISTS "auth_nonces" (
  "nonce"       text PRIMARY KEY NOT NULL,
  "address"     text NOT NULL,
  "chain_id"    integer NOT NULL,
  "domain"      text NOT NULL,
  "uri"         text NOT NULL,
  "statement"   text NOT NULL,
  "issued_at"   timestamp with time zone NOT NULL,
  "expires_at"  timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);

-- token_hash, never the token. A dump of this table cannot impersonate anyone.
CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "address"    text NOT NULL,
  "chain_id"   integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);

-- ---------------------------------------------------------------------------
-- Foreign keys — guarded, so re-running this file is a no-op.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TABLE "compilations"
    ADD CONSTRAINT "compilations_session_id_compiler_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."compiler_sessions"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "compiler_turns"
    ADD CONSTRAINT "compiler_turns_session_id_compiler_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."compiler_sessions"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "evidence"
    ADD CONSTRAINT "evidence_rules_hash_markets_rules_hash_fk"
    FOREIGN KEY ("rules_hash") REFERENCES "public"."markets"("rules_hash")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "resolutions"
    ADD CONSTRAINT "resolutions_rules_hash_markets_rules_hash_fk"
    FOREIGN KEY ("rules_hash") REFERENCES "public"."markets"("rules_hash")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "compiler_sessions_creator_idx"
  ON "compiler_sessions" USING btree ("creator");
CREATE INDEX IF NOT EXISTS "compiler_turns_session_idx"
  ON "compiler_turns" USING btree ("session_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "markets_chain_market_idx"
  ON "markets" USING btree ("chain_id", "chain_market_id");
CREATE INDEX IF NOT EXISTS "markets_creator_idx"
  ON "markets" USING btree ("creator");
CREATE INDEX IF NOT EXISTS "markets_status_idx"
  ON "markets" USING btree ("status", "created_at");

CREATE INDEX IF NOT EXISTS "resolutions_market_idx"
  ON "resolutions" USING btree ("rules_hash", "round");
CREATE INDEX IF NOT EXISTS "evidence_market_idx"
  ON "evidence" USING btree ("rules_hash");

CREATE INDEX IF NOT EXISTS "market_events_market_idx"
  ON "market_events" USING btree ("chain_id", "chain_market_id", "block_number");
CREATE INDEX IF NOT EXISTS "market_events_rules_hash_idx"
  ON "market_events" USING btree ("rules_hash");
-- A reorg rewind deletes by height, so that lookup gets its own index.
CREATE INDEX IF NOT EXISTS "market_events_block_idx"
  ON "market_events" USING btree ("chain_id", "block_number");

CREATE UNIQUE INDEX IF NOT EXISTS "market_chain_state_rules_hash_idx"
  ON "market_chain_state" USING btree ("chain_id", "rules_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "market_chain_state_market_id_idx"
  ON "market_chain_state" USING btree ("chain_id", "chain_market_id");

CREATE INDEX IF NOT EXISTS "auth_nonces_address_idx"
  ON "auth_nonces" USING btree ("address", "expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_token_idx"
  ON "auth_sessions" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "auth_sessions_address_idx"
  ON "auth_sessions" USING btree ("address", "expires_at");

-- ===========================================================================
-- Check it worked. Expect 13 rows.
-- ===========================================================================
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;
