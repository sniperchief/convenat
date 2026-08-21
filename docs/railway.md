# Deploying the backend to Railway

Two services from one repository, because they are two different shapes of
process:

| Service | What it is | Start command |
| --- | --- | --- |
| `covenant-api` | Answers HTTP. Railway assigns it a public domain | `node apps/backend/dist/index.js` |
| `covenant-indexer` | Runs forever following the chain. Serves no HTTP | `node apps/backend/dist/indexer/main.js` |

`railway.json` at the repository root configures the **API**. The indexer is a
second service whose start command is overridden in the dashboard — it holds a
cursor and must not be health-checked on a port it does not listen on.

---

## 1. Create the project

```
railway login
railway init            # or: New Project → Deploy from GitHub repo
```

Point it at `sniperchief/convenat`, branch `main`. Railway reads `railway.json`
and builds the whole workspace — the backend imports `@covenant/shared`, and a
workspace build is what links them.

## 2. Environment variables — the API service

Set these in **Variables**. Nothing here is in the repository.

```
NODE_ENV=production

# Required. A process bound to loopback is unreachable on a managed host, and
# the failure looks like a health-check timeout with no explanation.
API_HOST=0.0.0.0

# Do NOT set API_PORT or PORT. Railway injects PORT and the config honours it.

NETWORK=xlayer-testnet
CHAIN_ID=1952

# Relative to the repository root, which is the working directory. Contract
# addresses come from this manifest and from nowhere else.
X_LAYER_DEPLOYMENT_MANIFEST=packages/contracts/deployments/xlayer-testnet.json

SETTLEMENT_TOKEN_ADDRESS=0x6d7227b319972af3006337fc5cda17737571c2e2
SETTLEMENT_TOKEN_SYMBOL=TUSD
SETTLEMENT_TOKEN_DECIMALS=6

XLAYER_RPC_URL=https://testrpc.xlayer.tech/terigon
INDEXER_LOG_RANGE=100          # X Layer testnet's measured cap
INDEXER_CONFIRMATIONS=5

LLM_MODEL=claude-haiku-4-5
RESOLUTION_CONFIDENCE_FLOOR_BPS=7000

# --- secrets ---------------------------------------------------------------
DATABASE_URL=<your postgres url>
ANTHROPIC_API_KEY=<your key>

# Without this the API still runs and still resolves — it produces and stores
# proposals but submits none. That is a usable posture, not a broken one.
RESOLVER_PRIVATE_KEY=<0x… 32 bytes>

# --- must match the frontend exactly ---------------------------------------
# Never "*": this API carries bearer tokens, and a wildcard would let any page
# a user visits spend their session.
CORS_ORIGINS=https://<your-app>.vercel.app
AUTH_DOMAIN=<your-app>.vercel.app
AUTH_URI=https://<your-app>.vercel.app
```

Then **Settings → Networking → Generate Domain**. That URL is what the frontend
talks to.

## 3. Environment variables — the indexer service

**New service → same repo.** Then **Settings → Deploy → Custom Start Command**:

```
node apps/backend/dist/indexer/main.js
```

Leave the health check empty — it listens on no port.

Same variables as above **except**: no `CORS_ORIGINS`, no `AUTH_*`, no
`RESOLVER_PRIVATE_KEY`, no `API_HOST`. Plus:

```
# Bootstrapping from the factory's deployment block costs thousands of requests
# on a chain capped at 100 blocks per call. Set this near the first market you
# care about.
#
# Setting it FORWARD of a real market is a way to lose data. It is an
# operational escape hatch, not a tuning knob.
INDEXER_START_BLOCK=38873600
```

`ANTHROPIC_API_KEY` must still be set, and this is a wart worth naming rather
than hiding: `loadConfig` is shared by three entry points and asks each of them
for everything any of them needs. The indexer never constructs a model provider
and never calls one. What is genuinely absent is `RESOLVER_PRIVATE_KEY` — the
indexer reads the chain and writes a cache, and a key it never holds is a key
that cannot leak from it.

## 4. Database

Railway can host Postgres itself (**New → Database → PostgreSQL**), which
removes the cross-provider network hop that caused repeated connection timeouts
during development. Copy its `DATABASE_URL` into both services.

Then create the schema — once, from your laptop, pointed at the new database:

```
cd apps/backend
npx drizzle-kit push
```

`push` creates every table from `src/db/schema.ts` directly. It needs no
migration history, which is what makes it the right command for a fresh
database.

## 5. Verify

```
curl https://<your-service>.up.railway.app/health
```

Expect `chainConfigured: true`, `resolutionConfigured: true`, and
`resolverConfigured: true` if you set the key. `resolverAddress` is a public
fact — anyone can read `isProposer` from the factory — so it is safe to see
there, and it makes the resolver's on-chain behaviour auditable.

---

## What this deployment weakens

**The resolver key is held by the platform.** Railway can read it, and it should
be a KMS-held key before mainnet. On testnet the trade is acceptable and bounded
by what the key can do: the resolver address holds `PROPOSER_ROLE` and nothing
else, that role reaches exactly one function, and
`packages/contracts/test/security.test.ts` enumerates the whole ABI and asserts
no fund-moving function is reachable by it. The backend's own ABI declares two
non-view functions — `proposeResolution` and `finalize` — and
`abi-parity.test.ts` asserts that list is exactly those two, so a fund-moving
call cannot be encoded even by a compromised process.

This is recorded here and in [security.md](security.md) rather than left for
someone to discover.
