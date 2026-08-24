# Decisions

Living record of what is settled and — just as importantly — what is deliberately
still open. Nothing in the codebase should assume an "Open decision" has an answer.

Last updated: 2026-08-24 (end of Phases 5–7 — credits and Google Cloud TTS)

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
| Refresh cookie `SameSite` | `lax` in development, **`none` + `Secure` in production**, overridable with `COOKIE_SAMESITE` | Supersedes the flat "Lax" in [ARCHITECTURE.md](./ARCHITECTURE.md) §6. Vercel and Render are different sites, and a `Lax` cookie is not sent on a cross-site `fetch` — refresh would fail in production while working perfectly on localhost (`SameSite` ignores the port, so `:5173` and `:4000` are same-site). CSRF resistance comes from the access token being a `Authorization` header, which a forged cross-site request cannot set; the override exists for a future single-domain setup |
| Refresh cookie scope | `Path=/api/auth` | The only routes that read it. Every other request carries the cookie for no reason otherwise |
| Password hashing | `bcryptjs` at cost 12 (`BCRYPT_COST`) | Pure JS, so no `node-gyp` build on Windows or Render's free tier. Passwords are rejected above 72 bytes rather than silently truncated to what bcrypt actually hashes |
| Token storage | One `tokens` collection for refresh / email-verify / password-reset, storing **SHA-256 hashes** with a TTL index | Nothing to guess about 256 random bits, so a slow hash buys nothing; a deterministic hash allows the indexed lookup bcrypt's per-hash salt would prevent. Reads still check `expiresAt` — Mongo's TTL monitor only sweeps about once a minute |
| Account enumeration | Signup, resend-verification and forgot-password return **identical** responses whether or not the address is registered | So signup cannot issue a session either: for a new address that would leak the answer back, and for an existing one it would be account takeover. The real owner is told by the "you already have an account" email instead |
| Unverified sign-in | Allowed | Verification gates the free credit grant, not access. Locking people out of the product to protect a credit grant is the wrong trade |
| Free credits | Granted only *after* email verification | Blocks throwaway-email farming. The grant runs **before** `emailVerifiedAt` is set: `resendVerification` returns early for an already-verified address, so a grant that failed after the flag was set would strand someone verified, ungranted and unable to ask again. The grant is idempotent, so the order costs nothing |
| Credit bucket order | `subscriptionCredits` drained before `purchasedCredits`, in one atomic update | Purchased credits do not expire, so spending them first would burn the ones worth keeping. The split is recorded on `Generation.creditSplit` so a refund returns each credit to the bucket it came from |
| Charged per character, limited per byte | Credits count **characters**; the provider cap counts **UTF-8 bytes** | "café" is 4 characters and 5 bytes. Charging by bytes would bill a Hindi user roughly three times an English user for the same sentence |
| Audio storage | Object storage (S3-compatible) behind a storage adapter; **never MongoDB, never a public bucket** | Phase 6 ships one `local` filesystem adapter, which is what runs today |
| Audio delivery | An **authenticated endpoint** — `GET /api/tts/generations/:id/audio`, ownership checked in the query — not presigned URLs | Supersedes "served via short-lived presigned URLs". A signed URL is a bearer token in a link, with an expiry to tune and a leak path through logs and referrers; this reuses the access token the client already sends. Cost: the browser must fetch audio as a blob, since `<audio src>` cannot set a header. Presigned URLs come back if audio ever needs to bypass the API for bandwidth |
| Local provider implementations | Every integration has one: `EMAIL_PROVIDER=log`, `TTS_PROVIDER=mock`, `STORAGE_PROVIDER=local` | The whole credit path — reserve, charge, refund, download — is testable and demonstrable before any billing account exists. `mock` returns a real playable WAV that is audibly a chime, not speech: a convincing mock is one that ships by accident |
| No Google SDK | A service-account JWT assertion signed with the existing `jsonwebtoken`, exchanged for a cached hour-long access token | Two REST calls against a documented, stable endpoint versus a large transitive dependency tree. Credentials stay server-side; the browser never sees a Google token |
| Ledger | Append-only `CreditTransaction` is the source of truth; the balance on `User` is a cache | `creditsService.reconcile(userId)` proves they agree, and is asserted in the tests |
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

**Status after Phase 7: not yet calibrated.** The seeder writes `costMultiplier: 1` for
every voice via `$setOnInsert`, so 1 credit = 1 character for all tiers and no tier is
cheaper or dearer than another. `Voice.tier` is derived from the voice *name* (a naming
list, not a pricing one) so the tiers are ready to be priced. Nothing in the code reads a
price from anywhere but the database.

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

**Status after Phase 7:** the only seeded plan is `free`, at `credits: 5000` and
`maxCharsPerRequest: 2000`, both marked `PLACEHOLDER` in `server/scripts/seed.js` and both
written with `$setOnInsert` so re-seeding never overwrites a number you changed in the
database. No paid plan is seeded, because seeding one would mean inventing a price.

### 4. GST treatment — NOT decided

Whether displayed prices are GST-inclusive or exclusive affects the amounts stored on
`Plan` and shown at checkout. `Plan.gstIncluded` records the choice; the choice itself
is open.

---

## Deferred (not open questions, just later work)

- **Login and password-reset rate limiting** — deliberately not built in Phase 2. Every
  other brute-force defence is in place (bcrypt cost 12, identical failure messages,
  equal timing for present and absent accounts, single-use tokens), but nothing yet
  caps attempts per IP or per address. It needs a dependency and a store, and it lands
  with the rest of the hardening work in Phase 9.
- **Atlas network allowlist is `0.0.0.0/0`** — Render's free tier has no static
  outbound IP, so there is no address to allowlist. Security rests on a strong unique
  credential plus enforced TLS. This is a genuine widening of the attack surface and
  is on the Phase 12 pre-launch list: either move to a Render tier with static egress,
  or accept it explicitly. See [DEPLOYMENT.md](./DEPLOYMENT.md) §3.
- **Audio does not survive a deploy** — `STORAGE_PROVIDER=local` on a host with an
  ephemeral filesystem (Render's free plan included) loses every generated file on
  restart. The `Generation` records survive, so history stays intact and only playback of
  old audio breaks; the endpoint returns **410** with "generate it again" rather than a
  confusing 404. The fix is an S3 or R2 adapter, which is one new file behind the existing
  interface. Needed before real users, i.e. Phase 9–12.
- **Per-request and per-day generation caps** — today the only limits are the plan's
  `maxCharsPerRequest` and the credit balance itself. That is enough while
  `TTS_PROVIDER=mock` costs nothing, and it is exactly why the provider stays on `mock`
  until Phase 9's rate limiting lands.
- Google OAuth sign-in — after v1
- Long-text chunking and a job queue (Redis/BullMQ) — v2
- SSML / speed / pitch controls — v2
- Developer API keys, voice cloning, team accounts — post-v2
