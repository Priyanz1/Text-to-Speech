# Roadmap

Each phase ends deployable and manually testable. Status is updated as phases complete.

**Two ordering rules that carry the most weight:**

1. **Credit engine before TTS** (Phase 5 before Phase 7). Retrofitting atomic deduction
   and idempotency into a working generate endpoint is painful and error-prone.
2. **Hardening before payments** (Phase 9 before Phase 10). Every TTS call spends real
   provider money, so the endpoint must be capped and rate-limited before it is exposed.

---

| Phase | Scope | Status |
|---|---|---|
| **0** | Repo, `/client` + `/server`, Zod-validated env, Mongo connection, logger, CORS, JSON parsing, centralized error handler, 404 handler, `GET /api/health`, graceful shutdown | **Done** — 2026-08-23 |
| **1** | Deploy the empty shells: API to Render, client to Vercel, MongoDB Atlas, CORS working across real domains. Liveness (`/api/health`) split from readiness (`/api/ready`) | **Code done** — 2026-08-24. Hosting accounts pending |
| **2** | `User` model, signup, login, logout, refresh-token rotation, `requireAuth`. Tested with a REST client only, no UI | **Done** — 2026-08-24 |
| **3** | Email provider + domain DNS (SPF/DKIM/DMARC), email verification, forgot/reset password | **Code done** — 2026-08-24. Runs on `EMAIL_PROVIDER=log` locally; Resend account + domain DNS pending |
| **4** | React app shell: router, `AuthProvider`, api client with 401 → refresh → retry, all auth screens, profile page | **Done** — 2026-08-24, except the profile page (the dashboard shows the account read-only; editing it is not needed until there is something to edit) |
| **5** | **Credit engine, standalone**: ledger, two buckets, atomic reserve/commit/refund, idempotency, signup bonus on verification, balance + ledger UI, reconciliation script | **Done** — 2026-08-24. `GET /api/credits/ledger` exists but has no screen yet; reconciliation is a tested `reconcile()` function, not a CLI script |
| **6** | `ttsProvider` + storage adapters, voice catalog seeded from Google, presigned URLs, one hardcoded synthesis proven end to end | **Done** — 2026-08-24, except presigned URLs: audio is served from an authenticated endpoint instead. See [DECISIONS.md](./DECISIONS.md) |
| **7** | Wire together: `POST /api/tts` = validate → reserve → synthesize → upload → commit (refund on failure). Studio UI with char/byte counter and cost estimate | **Done** — 2026-08-24. Runs on `TTS_PROVIDER=mock` locally; a Google Cloud project + billing account is pending |
| **8** | Generation history: list, pagination, filters, replay, re-download, delete, indexes | Not started |
| **9** | **Harden**: rate limits, per-request and per-day caps, helmet, Turnstile on signup, Sentry, audio retention cleanup job | Not started |
| **10a** | Credit packs: `Plan` catalog, pricing page, Razorpay Orders, Checkout, webhook with signature verification and `WebhookEvent` idempotency, credits granted via the ledger | Not started |
| **10b** | Subscriptions: Razorpay Plans, mandate authorization, `subscription.charged` → renewal via the plan's `creditRenewalPolicy`, `past_due`/`halted` handling | Not started |
| **10c** | Self-built billing management UI: current plan, next charge, cancel/resume, upgrade/downgrade, invoices. Nightly subscription reconciliation | Not started |
| **11** | Minimal admin: role guard, user list/detail, credit adjustment, suspend, `AuditLog` | Not started |
| **12** | **v1 launch**: legal pages, GST invoicing, real voice catalog, ledger reconciliation cron, backups, smoke checklist | Not started |
| **13** | v2: full admin analytics with `UsageDaily` rollups, margin tracking | Not started |
| **14** | v2: generation controls (speed/pitch/SSML), long-text chunking with a job queue | Not started |

---

## Pricing calibration — still open

Phases 5–7 shipped without it, deliberately. Every voice is seeded with
`costMultiplier: 1` and the only plan is free, so nothing in the code depends on a
provider price. Before any rate or plan price is set, and **not** from numbers written
down earlier in design:

1. Read Google Cloud TTS's currently published per-character rates for each voice tier.
2. Record the reading and the date it was taken.
3. Derive `Voice.costMultiplier` per tier and store it in MongoDB as data.
4. Set plan prices and the credit-to-rupee rate from that reading.
5. Decide the subscription credit renewal policy (reset / rollover / partial) and record
   it on `Plan`.

See [DECISIONS.md](./DECISIONS.md) §1 and §2 — none of these values may be hard-coded.

---

## What Phase 0 deliberately does not contain

No authentication, no `User` model, no TTS, no Google Cloud SDK, no Razorpay, no payment
or subscription models, no credit logic, no Docker, no Redis, no TypeScript.

---

## What Phase 1 deliberately does not contain

No helmet or rate limiting (Phase 9 — deploying does not require them, and adding
them here would mean shipping security middleware that nothing yet protects), no
Docker (Render builds from the repository directly; a Dockerfile would be a second
build definition to keep in sync for no gain at this size), no CI pipeline, no
staging environment, and no new runtime dependencies. The tests use Node's built-in
`node:test` runner.

---

## What Phases 2–4 deliberately do not contain

Built in one pass, because the three phases only become testable together: an auth API
with no UI has to be exercised by hand, and a login screen with nothing behind it proves
nothing.

Left out on purpose:

- **Rate limiting on login and password reset** — Phase 9, with the rest of the
  hardening. See [DECISIONS.md](./DECISIONS.md) "Deferred".
- **TanStack Query** — the only fetches so far are the two health probes and the session
  bootstrap. A cache layer arrives with Phase 5's balance and ledger, which actually need
  invalidation.
- **Google OAuth, 2FA, "remember me", account deletion, email change** — after v1.
- **A profile page** — the dashboard already shows the account; there is nothing editable
  until later phases add settings.
- **HTML email** — plain text renders everywhere and has nothing to break. The templates
  file is the one place to add HTML later.

---

## What Phases 5–7 deliberately do not contain

Built in one pass for the same reason as 2–4: a credit engine with nothing to spend on
cannot be judged, and a generate endpoint that cannot charge is not the endpoint.

Left out on purpose:

- **Any provider price** — every voice ships at `costMultiplier: 1`, so 1 credit = 1
  character everywhere. See "Pricing calibration" above.
- **Presigned URLs** — audio is served by `GET /api/tts/generations/:id/audio`, which
  checks ownership in the query. A signed URL is a bearer token in a link; this needs no
  new secret and no expiry to tune. It also means the client fetches audio as a blob,
  because an `<audio src>` cannot send an `Authorization` header.
- **Object storage** — one local-filesystem adapter, behind the same interface an S3 or
  R2 adapter would implement. On an ephemeral host the files are a cache; the
  `Generation` records are the durable part.
- **Rate limits and per-day caps** — Phase 9. The per-request character cap on `Plan` and
  the credit balance are the only limits so far, which is why `TTS_PROVIDER` stays `mock`
  until then.
- **Generation history UI** — Phase 8. The records and indexes exist; nothing lists them.
- **A ledger screen** — `GET /api/credits/ledger` is live and tested, but the dashboard
  shows only the balance.
- **SSML, speed, pitch, long-text chunking** — Phase 14.

