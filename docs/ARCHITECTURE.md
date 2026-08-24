# Architecture

Design reference for the AI Text-to-Speech SaaS. Read [DECISIONS.md](./DECISIONS.md)
alongside this — it records what is settled and what must stay configurable.

---

## 1. Shape of the system

```
Browser (React/Vite)
      |  HTTPS, JSON, Authorization: Bearer <access token>
      v
Express API  ──> MongoDB (Atlas)          state, ledger, history
      ├───────> Google Cloud TTS          synthesis (via ttsProvider adapter)
      ├───────> Object storage (S3 API)   generated audio files
      ├───────> Email provider            verification, reset, receipts
      └<──────  Razorpay webhooks         the only thing that grants paid credits
```

Two deployables: a static client and a stateless API. The API holds no session state
in memory, so it can be scaled to multiple instances without change.

**Where each part runs** (details in [DEPLOYMENT.md](./DEPLOYMENT.md)):

```
Vercel (CDN)          static React build, one preview URL per branch
Render (Singapore)    the Express process, restarted on liveness failure
Atlas M0 (Singapore)  MongoDB, colocated with the API to keep query latency low
```

The client and the API are on **different origins in development too** — there is no
Vite dev proxy — so a CORS mistake surfaces on localhost instead of in production.

### Health probes

Two endpoints, because "is it alive" and "should it get traffic" call for different
responses from the platform:

| Endpoint | Answers | Returns 503 when | Platform should |
|---|---|---|---|
| `GET /api/health` | Is the process alive? | Never (only failing to respond at all) | Restart the instance |
| `GET /api/ready` | Can it serve traffic? | MongoDB is disconnected, or shutdown has begun | Drain traffic, leave it running |

Liveness must not depend on MongoDB. Restarting the API cannot fix a database
outage, so a database-dependent liveness check converts an outage into a restart
loop. Graceful shutdown marks readiness as unavailable *before* closing
connections, so traffic drains while in-flight requests finish.

---

## 2. Release scope

**v1** — signup, login/logout, email verification, forgot/reset password, profile,
free credits, TTS generation with voice + language selection, audio preview, download,
generation history, credit deduction, credit packs, subscriptions, minimal admin.

**v2** — full admin analytics, generation controls (speed/pitch/SSML), long-text
chunking with a job queue, coupons and referrals, notification emails, batch generation,
data export/erase.

**Future** — developer API with keys, voice cloning (needs a consent flow), team
accounts, subtitle/timestamp export, multi-provider routing, white-label.

---

## 3. Backend structure

Layered and deliberately boring: `route → controller → service → model`.
Controllers parse input and shape responses. **All business logic lives in services**,
which is what makes the credit and billing rules testable in isolation.

```
server/src/
  config/        env (Zod-validated), db, logger, cors, cookies
  middleware/    requestLogger, notFound, errorHandler, requireAuth, validate
                 + later: requireRole, rateLimit
  routes/        mounts every module under /api
  modules/       feature folders, each: <name>.routes.js / .controller.js
                 / .service.js / .model.js / .validation.js
    health/      (Phase 0-1) liveness + readiness
    auth/        (Phase 2-3) signup, login, refresh, logout, verify, reset
    users/       (Phase 2) user.model.js — the model only, so far
    plans/       (Phase 5) plan catalog; the only seeded plan is free
    credits/     (Phase 5) ledger, atomic reserve/refund, balance, reconcile
    voices/      (Phase 6) catalog, languages, plan-filtered listing
    generations/ (Phase 7) generation.model.js — the model only, so far
    tts/         (Phase 7) generate, audio, config
                 + later: billing/ webhooks/ admin/
  integrations/  email/ (Phase 3), ttsProvider/ + storage/ (Phase 6)
                 + later: payments/
  jobs/          credit renewal, expired-audio cleanup, webhook reconciliation
  utils/         ApiError, lifecycle, token hashing, cost calculation
```

**The one abstraction that earns its keep is `integrations/ttsProvider`** — an interface
of `listVoices()` and `synthesize({ text, voiceId, settings })`. Providers get swapped
for cost, quality, outages, or premium tiers. Nothing outside `integrations/` may import
a vendor SDK. The same pattern applies to storage, email, and payments.

Google is reached without its SDK: a service-account JWT assertion signed with the
`jsonwebtoken` dependency auth already needs, exchanged for an hour-long access token at
`oauth2.googleapis.com/token` and cached. Two REST calls, zero new dependencies.

Each provider also has a **local** implementation — `EMAIL_PROVIDER=log`,
`TTS_PROVIDER=mock` — so the whole path is testable with no vendor account. The mock
returns a real, playable WAV that is audibly a chime and not speech, because a convincing
mock is one that ships by accident.

---

## 4. Frontend structure

Vite + React Router + TanStack Query + Tailwind + react-hook-form + Zod.
No Redux: TanStack Query owns server state, one context owns auth.

Phases 2–4 ship the router, the auth context and the api client. Phase 7 adds the studio
panel. TanStack Query, Tailwind and react-hook-form are still not in — plain CSS and
controlled inputs cover the forms, and the studio's three fetches (config, languages,
voices) do not yet need a cache with invalidation.

Generated audio reaches the player through `api.getBlob()` and `URL.createObjectURL`,
not through `<audio src="…/audio">`: the tag cannot send an `Authorization` header, and
the alternative to a header is a signed or public URL for private audio.

```
client/src/
  app/           router, layouts, route guards, theme, error boundary
  config/        env.js  (validates VITE_ variables)
  lib/           apiClient.js  (base URL, credentials, 401 → refresh → retry)
                 formError.js  (API error → one line for a form)
  features/
    auth/        signup, login, verify-email, forgot, reset, AuthProvider
    dashboard/   (Phase 4) account summary; the studio replaces it in Phase 7
    health/      (Phase 1) the deployment status panel
    studio/      editor + char/byte counter, language + voice picker, cost estimate, player
    history/     list, filters, pagination, replay, download, delete
    credits/     balance widget, ledger, low-balance banner
    billing/     pricing, checkout, payment history, manage subscription
    profile/     name, avatar, password change, preferences, delete account
    admin/       users, credit adjustment, generations, plans, metrics
  components/ui/ Button, Input, Modal, Toast, Table, Skeleton, AudioPlayer
```

Two product rules: **always show the credit cost before the action**, and **never let
the balance widget go stale** after a generation.

---

## 5. Data models

| Model | Purpose | Points that matter |
|---|---|---|
| `User` | account, role, verification state, credit balances | Balances are plain numbers so they support atomic `$inc`. Two buckets: `subscriptionCredits`, `purchasedCredits` |
| `Token` | email verification, password reset, refresh tokens | One collection, `type` discriminator. Store **hashes only**. TTL index on `expiresAt` |
| `Voice` | curated catalog | `tier` and `costMultiplier` are **configuration** (see DECISIONS.md §1) so provider price changes need no deploy |
| `Generation` | one synthesis request | `charCount` for billing, `byteLength` for the provider limit, `audio.storageKey`, `idempotencyKey` (unique sparse) |
| `CreditTransaction` | append-only ledger | Never updated or deleted. Signed `amount`, `balanceAfter`, unique `idempotencyKey`. Reconciles to the `User` balance |
| `Plan` | subscription tiers and credit packs | `kind: 'subscription' \| 'credit_pack'`, prices in paise, `providerPlanId`, `creditRenewalPolicy` (see DECISIONS.md §2), `gstIncluded` |
| `Subscription` | mirror of Razorpay state | `providerSubscriptionId`, `status`, period bounds, `lastSyncedAt` |
| `Payment` | one settled payment | Unique `providerPaymentId` and `providerOrderId` |
| `WebhookEvent` | idempotency guard | **Unique index on the provider event id** is the guarantee |
| `AuditLog` | admin actions | Every credit adjustment and suspension |
| `UsageDaily` (v2) | pre-aggregated rollups | So admin charts never scan `Generation` |

Indexes to create with the models: `User.email` unique · `Generation { userId, createdAt: -1 }`
· `CreditTransaction { userId, createdAt: -1 }` + unique `idempotencyKey`
· `Token.tokenHash` unique + TTL on `expiresAt` · `WebhookEvent.eventId` unique.

---

## 6. Authentication

- Passwords: bcryptjs (cost 12, `BCRYPT_COST`). Rejected above 72 bytes rather than
  truncated, because that is all bcrypt hashes.
- **Access token**: JWT, ~15 min, returned in the response body, held in React memory.
  Sent as `Authorization: Bearer`. Never in `localStorage`.
- **Refresh token**: opaque random bytes in an `httpOnly` cookie scoped to `/api/auth`.
  Only its SHA-256 hash is stored. `SameSite` is `lax` in development and **`none` +
  `Secure` in production**, because Vercel and Render are different sites and a `Lax`
  cookie is not sent on a cross-site request — see [DECISIONS.md](./DECISIONS.md).
- **Rotation with reuse detection**: each refresh issues a new token and retires the old
  one. Replaying a retired token revokes the whole family and forces re-login.
- Access token in a header + path-scoped refresh cookie gives CSRF resistance without a
  separate CSRF token layer.
- Email verification and password reset use the same pattern: random token, hashed at
  rest, single use, short TTL. A completed reset revokes all refresh tokens.
- Signup, resend-verification and forgot-password return identical responses whether or
  not the account exists, to prevent enumeration. That is also why signup returns no
  session — see [DECISIONS.md](./DECISIONS.md).
- Login timing is equalised: a missing account is compared against a dummy hash generated
  at the real cost factor, so present and absent addresses take the same time.
- `role: 'user' | 'admin'`. Admin is set directly in the database. There is no endpoint
  that can ever grant it.

---

## 7. Credit system

**Two buckets, drained in order:** `subscriptionCredits` first, then `purchasedCredits`.
Purchased credits do not expire. What happens to unused subscription credits at cycle
end is **an open decision** (DECISIONS.md §2) and is read from `Plan`, never hard-coded.

**Validate → record → reserve → synthesize → store**, in this order:

1. Validate — non-empty, within the plan's per-request limit, voice permitted for plan.
   The provider limit is measured in **UTF-8 bytes**, not characters; the plan's limit is
   in characters, because that is what credits are charged in.
2. Compute cost = `charCount × voice.costMultiplier` (multiplier read from the DB).
3. Write `Generation` (`status: 'pending'`) with a snapshot of the voice, including the
   multiplier the charge is about to be made at.
4. **Reserve atomically**: one `findOneAndUpdate` with the balance condition *in the
   filter* — `$expr: { $gte: [{ $add: ['$subscriptionCredits', '$purchasedCredits'] }, cost] }`
   — and an aggregation-pipeline `$set` that drains subscription credits first. A null
   result means insufficient credits. Single-document atomicity means no transaction and
   no lock is needed, and two concurrent requests can never both spend the last credits.
   The negative `CreditTransaction` rows (one per bucket touched) are written from the
   pre-update document the same call returns.
5. Call the provider, store the audio.
6. Success → `completed`. Failure → **refund** via a compensating positive
   `CreditTransaction` per bucket and `status: 'failed'`.

**Step 3 before step 4 is deliberate** and differs from an earlier draft of this section.
`Generation.idempotencyKey` is uniquely indexed, so creating the row first means a retried
request collides on that index *before* any credits move. Reserving first would put the
money outside the guard.

**Idempotency**: the client sends a request-scoped key; unique indexes on
`Generation.idempotencyKey` and `CreditTransaction.idempotencyKey` make a double-click
or a network retry a no-op instead of a double charge.

**Refunds are claimed before they are paid**: a compare-and-set on
`Generation.creditsRefunded` (0 → cost) decides who owns the refund, and the claim is
released if the balance update then throws — so a failed refund stays retryable instead
of being silently marked done.

**Reconciliation**: `SUM(CreditTransaction.amount)` must always equal the user's stored
balances. `creditsService.reconcile(userId)` exists from the moment the ledger does, and
is asserted in the test suite.

---

## 8. Payments

Hosted checkout only — no card fields in our code, so we stay out of PCI scope.

- **Packs**: server creates an Order (amount in paise, `userId` in `notes`) → Razorpay
  Checkout → server verifies the returned signature → **credits granted only by the
  webhook**.
- **Subscriptions**: Razorpay Plans created once and their ids stored on `Plan` →
  Subscription created → Checkout collects the mandate → `subscription.activated` and
  `subscription.charged` follow.
- `subscription.charged` is the renewal trigger, because it fires only when money
  actually arrived. A nightly reconciliation job exists purely as a safety net for
  missed webhooks.
- Razorpay has **no equivalent of Stripe's Customer Portal**, so cancel / resume /
  change-plan / invoice-list is our own UI.
- Recurring INR debits fall under the RBI e-mandate framework (mandate caps, pre-debit
  notification). Razorpay handles the mechanics; the rules constrain our price points,
  so confirm current thresholds before finalising plan prices.

**Webhook rules, all mandatory:**

1. Verify the HMAC-SHA256 signature against the **raw, unparsed** body. The raw-body
   parser is mounted on the webhook route only, *before* the global JSON parser.
2. Insert into `WebhookEvent` (unique event id) **before** processing. A duplicate
   delivery hits the duplicate-key error and is skipped. Assume every event arrives
   more than once.
3. Grant credits through the same ledger service everything else uses — never a direct
   `$inc`.
4. Return 200 quickly; return 5xx on failure so Razorpay retries.

---

## 9. Security concerns

Specific to this product:

1. **Cost-amplification abuse** — every generation spends real provider money. Per-request
   caps, per-day caps, rate limits, and a spend-anomaly alert.
2. **Credit race conditions** — solved only by the conditional atomic update in §7, never
   by read-then-write.
3. **Double charging on retry** — solved by idempotency keys with unique indexes.
4. **Free-credit farming** — verification-gated credits, disposable-domain blocklist,
   Turnstile on signup, velocity heuristics.
5. **Webhook forgery** — an unverified webhook route is an unlimited-credits API.

Standard, but easy to get wrong here:

6. **IDOR** — every history, generation, and download query is filtered by `userId`
   server-side. Never trust a route parameter alone.
7. **Public buckets** — audio is served only via short-lived presigned URLs.
8. **NoSQL injection** — `{"email": {"$gt": ""}}` subverts a naive query. Validate every
   input with Zod and reject non-primitives where a string is expected.
9. **Secrets in the client bundle** — every `VITE_` value ships to the browser.
10. **XSS → token theft** — why the access token stays in memory and the refresh token is
    httpOnly.
11. **Reset tokens** — hashed at rest, single use, short TTL, revoke sessions on use.
12. **Brute force** — rate-limit login, verify-resend, and forgot-password.
13. **Privilege escalation** — strip `role` from every user-supplied update payload.
14. **Admin routes** — enforced server-side with `requireRole('admin')`; hiding UI is not
    security. Log every admin action.
15. **Content-Disposition injection** — sanitise user-derived download filenames.
16. **Content abuse** — impersonation and scam audio. Needs ToS, retention for takedowns,
    and a suspend mechanism. Voice cloning would require documented consent.
17. **Privacy** — submitted text is user content. Publish a retention window, implement
    real deletion, and never log full text bodies to a third-party log service.
