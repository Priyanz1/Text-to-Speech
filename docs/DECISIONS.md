# Decisions

Living record of what is settled and — just as importantly — what is deliberately
still open. Nothing in the codebase should assume an "Open decision" has an answer.

Last updated: 2026-08-24 (end of Phase 1)

---

## Locked decisions

| Area | Decision | Notes |
|---|---|---|
| Stack | React (Vite) + Node + Express + MongoDB/Mongoose, JavaScript only | No TypeScript |
| Module system | ESM (`"type": "module"`) on both sides | |
| TTS provider | **Google Cloud Text-to-Speech** | Reached only through the `ttsProvider` adapter, never imported directly |
| Payments | **Razorpay** | Business entity is India-registered; UPI Autopay / e-mandate support was decisive |
| v1 monetization | **Both** one-time credit packs **and** recurring subscriptions | Packs are built first so the order → webhook → ledger path is proven before subscriptions reuse it |
| Credit unit | 1 credit = 1 character of input text | Provider bills per character, so this keeps unit economics computable |
| Money storage | Integer minor units (paise), never floats | |
| Auth | Short-lived JWT access token (memory) + rotating opaque refresh token in an httpOnly cookie | Reuse detection revokes the token family |
| Free credits | Granted only *after* email verification | Blocks throwaway-email farming |
| Audio storage | S3-compatible object storage, served via short-lived presigned URLs | Never store audio in MongoDB, never use a public bucket |
| Ledger | Append-only `CreditTransaction` is the source of truth; the balance on `User` is a cache | |
| Webhooks | The webhook is the only thing that may grant credits. Never the browser redirect. | |
| Webhook idempotency | Every Razorpay event is processed **exactly once**, enforced by a unique index on the provider event id | Requirement is locked; implementation is Phase 10, not Phase 0 |
| API hosting | **Render**, free tier for now, Singapore region | Runs a long-lived process and sends a real SIGTERM, which graceful shutdown depends on. Config lives in `render.yaml` so it is reviewable, not dashboard-only |
| Client hosting | **Vercel**, root directory `client` | Static build on a CDN, plus a preview URL per branch |
| Database hosting | **MongoDB Atlas** M0, Singapore region | Colocated with the API: every query pays that round trip, so it matters more than user-to-API distance |
| Health probes | **Liveness `/api/health`** (always 200 while the process runs) and **readiness `/api/ready`** (503 when MongoDB is disconnected or during shutdown) | Different questions with different platform responses: restart vs drain. Render's health check points at liveness so a database outage cannot cause a restart loop |
| CORS allowlist | `CLIENT_URL` (single canonical origin) plus optional `CORS_EXTRA_ORIGINS` | `CLIENT_URL` stays single-valued because Phase 3 needs one URL for email links. The extra list exists for Vercel preview hostnames, which change per branch |
| No dev proxy | Client and API are cross-origin locally too | Keeps development honest: a CORS mistake fails on localhost rather than waiting for production |
| Test runner | Node's built-in `node:test` | No new dependency. Run with `npm test` in `server/` |

---

## Open decisions — do not hard-code these

### 1. Provider pricing is never business logic

Google Cloud TTS pricing, voice tiers, and the relative cost between tiers **change**,
and any number quoted in a design conversation is a snapshot, not a contract.

Rules:

- **No provider price is hard-coded anywhere in the codebase.** Not in constants, not
  in seed data defaults, not in comments presented as authoritative.
- Voice cost and tier data is **configuration, not code**: `Voice.tier` and
  `Voice.costMultiplier` live in MongoDB and are editable from the admin panel, so a
  provider price change is a data update, not a deployment.
- Any approximate pricing that appears in notes or discussion is **reference only**,
  for sizing and intuition. It must never become a persisted default or a
  calculation input.
- The pricing phase includes an explicit calibration step: read Google's
  *currently published* rates, then set multipliers and plan prices from that reading
  and record the date it was taken.

### 2. Subscription credit renewal behaviour — NOT decided

Whether subscription credits **reset**, **roll over**, or **partially roll over** at the
end of a billing cycle is deferred to the credit/pricing phase.

Candidates still on the table:

| Model | Behaviour |
|---|---|
| Reset | Unused credits are forfeited at cycle end |
| Full rollover | Unused credits carry forward indefinitely |
| Partial rollover | A capped amount carries forward (e.g. up to one cycle's worth), the rest expires |

Consequences for the design, to respect from now on:

- The renewal rule is a **field on `Plan`** (e.g. `creditRenewalPolicy` plus any cap),
  not a hard-coded branch in the credit service.
- The credit service exposes a single `applyRenewal(...)` entry point that reads that
  policy. No caller assumes "set" or "increment".
- The `CreditTransaction` type enum keeps `expiry` available but nothing writes it
  until the policy is chosen.

### 3. Pricing numbers — NOT decided

Credit-to-rupee rate, credit pack sizes, subscription tier prices, and free-tier grant
size are all open. Placeholder values used while building must be obviously fake and
must live in seed data, never in application logic.

### 4. GST treatment — NOT decided

Whether displayed prices are GST-inclusive or exclusive affects the amounts stored on
`Plan` and shown at checkout. `Plan.gstIncluded` records the choice; the choice itself
is open.

---

## Deferred (not open questions, just later work)

- **Atlas network allowlist is `0.0.0.0/0`** — Render's free tier has no static
  outbound IP, so there is no address to allowlist. Security rests on a strong unique
  credential plus enforced TLS. This is a genuine widening of the attack surface and
  is on the Phase 12 pre-launch list: either move to a Render tier with static egress,
  or accept it explicitly. See [DEPLOYMENT.md](./DEPLOYMENT.md) §3.
- Google OAuth sign-in — after v1
- Long-text chunking and a job queue (Redis/BullMQ) — v2
- SSML / speed / pitch controls — v2
- Developer API keys, voice cloning, team accounts — post-v2
