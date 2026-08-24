# Deployment

How this application is deployed, and why each piece is the way it is.

Two deployables, because they are different kinds of thing:

| Part | Platform | Why |
|---|---|---|
| `client/` | **Vercel** | It builds to static files. Vercel serves them from a global CDN and gives a preview URL per branch |
| `server/` | **Render** | It is a long-running Node process that holds a database connection pool. Render runs containers and speaks SIGTERM properly, which our graceful shutdown depends on |
| Database | **MongoDB Atlas** | Managed backups, monitoring and failover. Running our own MongoDB would be the single least valuable thing to operate ourselves |

---

## 1. Local development vs production

The important thing is that **nothing about the code changes** between the two.
Only configuration does.

| | Local | Production |
|---|---|---|
| Client origin | `http://localhost:5173` (Vite dev server) | `https://<project>.vercel.app` |
| API origin | `http://localhost:4000` | `https://<service>.onrender.com` |
| Database | MongoDB on `127.0.0.1:27017` | MongoDB Atlas over TLS |
| `NODE_ENV` | `development` | `production` |
| Log format | Human-readable lines | One JSON object per line, for log search |
| Error responses | Include a stack trace | Stack traces stripped |
| Where config lives | `server/.env`, `client/.env` (git-ignored) | Render dashboard, Vercel project settings |
| Client is served by | Vite dev server, compiled in memory | Static files on a CDN |

**The client and API are on different origins in both cases.** That is deliberate.
We did not add a Vite dev proxy, precisely so that a CORS mistake fails locally
instead of waiting to fail in production.

---

## 2. Secrets

Two rules, both non-negotiable:

1. **No secret is ever committed.** `.env` files are git-ignored; only
   `.env.example` (keys, no values) is tracked. In `render.yaml`, secret keys are
   declared with `sync: false`, which means "the name lives in git, the value is
   entered in the dashboard".
2. **No server secret ever goes in a `VITE_` variable.** Vite inlines every
   `VITE_`-prefixed value into the JavaScript bundle at build time, so it is
   readable by anyone who opens devtools. `client/.env` may contain the API URL
   and nothing else.

If a secret is ever committed by mistake, rotating it is the only fix. Removing it
from the working tree does not remove it from git history.

---

## 3. MongoDB Atlas

1. Create a free **M0** cluster.
2. **Region: Singapore (`ap-southeast-1`)** — match the Render region. Every query
   pays the API-to-database round trip, so that distance matters more than the
   user-to-API distance. Render's free tier has no Mumbai region, so Singapore is
   the closest option to India for both.
3. **Database Access** → create a user with the **Read and write to any database**
   role. Generate a long random password. If it contains `@ : / ? # [ ] %`,
   URL-encode it in the connection string (`@` becomes `%40`).
4. **Network Access** → see the note below.
5. Copy the connection string and append the database name:
   `mongodb+srv://USER:PASS@cluster.mongodb.net/tts-saas?retryWrites=true&w=majority`

### On the IP allowlist

Render's free and starter tiers do **not** provide static outbound IPs, so there is
no address to allowlist. The practical options are:

- **Allow `0.0.0.0/0`** and rely on the database credentials plus TLS. This is what
  most small deployments do, and it is what Atlas itself suggests for platforms
  without static egress.
- Upgrade to a Render paid tier with static outbound IPs and allowlist those.

Option one is acceptable *because* the credential is strong and unique, TLS is
enforced, and the user has only the permissions it needs. It is worth being honest
that it is a real widening of the attack surface: the database is reachable from
anywhere that has the password. Revisit this before launch (Phase 12).

---

## 4. API on Render

The configuration lives in [`render.yaml`](../render.yaml) at the repository root,
so it is reviewable in a pull request rather than buried in a dashboard.

**Deploy:** Render dashboard → **New** → **Blueprint** → select this repository.
Render reads `render.yaml` and creates the service.

**Then set the dashboard values** (declared `sync: false`, so Render prompts
for them):

| Variable | Value |
|---|---|
| `MONGODB_URI` | The Atlas connection string from step 3 |
| `CLIENT_URL` | The Vercel production URL, no trailing slash |
| `CORS_EXTRA_ORIGINS` | Leave empty for now |
| `EMAIL_FROM` | Leave empty until a sending domain is verified — see §Email below |
| `RESEND_API_KEY` | Leave empty until then too |

`JWT_SECRET` is **not** in that list: `render.yaml` declares it `generateValue: true`,
so Render mints a random value on first deploy and keeps it. Nothing to set, and it
never exists in git.

`CLIENT_URL` is a chicken-and-egg problem on the first deploy: you do not know the
Vercel URL until the client is deployed, and the client needs the Render URL. Deploy
the API first, take its URL to Vercel, then come back and set `CLIENT_URL`.

`CLIENT_URL` also has a second job from Phase 3 on: every verification and password
reset link is built from it. If it is wrong, the emails still send and the links still
look fine — they just point at nothing.

### Email

`EMAIL_PROVIDER` ships as `log`, which prints emails to the Render log instead of
sending them. That is a deliberate default, not an oversight: it lets the API deploy and
authenticate before a sending domain exists.

To send real email:

1. Create a [Resend](https://resend.com) account and add your domain.
2. Add the SPF and DKIM records Resend gives you to the domain's DNS, and wait for
   verification. Without them mail lands in spam or is rejected outright.
3. On Render set `RESEND_API_KEY`, set `EMAIL_FROM` to an address on that domain, and
   change `EMAIL_PROVIDER` to `resend`.

Order matters: with `EMAIL_PROVIDER=resend` and no API key the process **refuses to
boot**, which is intended — silently not sending verification email is worse than a
failed deploy. So set the key before flipping the provider.

### The refresh cookie is cross-site in production

Vercel and Render are different sites, so the refresh cookie is set with
`SameSite=None; Secure`. Two consequences:

- **It only works over HTTPS.** Both platforms give you that by default.
- **A custom domain does not change it** unless the client and API share one. If you
  ever put them behind the same domain, set `COOKIE_SAMESITE=strict` on Render and the
  cookie stops being cross-site at all.

If sign-in works but the session vanishes on reload, this is the first thing to check —
look for the `Set-Cookie` header on the login response and whether the browser kept it.

**Things worth knowing about the free tier:**

- Instances **sleep after ~15 minutes** of no traffic and take 30–60 seconds to
  wake. The first request after idle will look broken but is not.
- Sleeping also means the health check is not keeping it warm.
- Upgrade before real users exist.

### Why `healthCheckPath` is `/api/health` and not `/api/ready`

Render **restarts** an instance whose health check fails. Restarting the API cannot
fix a MongoDB outage — it just adds a restart loop on top of one. So Render's check
points at liveness, which answers only "is this process alive".

Readiness (`/api/ready`) is the endpoint that reports a dependency failure, for a
load balancer that should **drain** traffic rather than restart the box. Same
distinction, different platform action:

| Endpoint | Question | Fails when | Correct platform response |
|---|---|---|---|
| `GET /api/health` | Is the process alive? | The process is wedged or gone | Restart it |
| `GET /api/ready` | Should traffic come here? | MongoDB is disconnected, or we are shutting down | Stop routing to it, leave it running |

Graceful shutdown ties into this: on SIGTERM the process marks itself
not-ready *before* it starts closing connections, so in-flight requests finish while
new ones stop arriving.

---

## 5. Client on Vercel

1. Vercel dashboard → **Add New** → **Project** → import this repository.
2. **Root Directory: `client`** — this must be set in the dashboard; there is no
   `vercel.json` key for it. Without it Vercel builds the repository root and finds
   no app.
3. Framework preset: **Vite** (auto-detected). Build `npm run build`, output `dist`.
4. **Environment Variables** → add `VITE_API_BASE_URL` = the Render URL
   (`https://<service>.onrender.com`, no trailing slash). Add it for **Production**
   and **Preview**.
5. Deploy, then go set `CLIENT_URL` on Render to the URL Vercel gives you.

**`VITE_API_BASE_URL` is read at build time, not at runtime.** Changing it in Vercel
does nothing until you redeploy. This surprises people once.

### What `client/vercel.json` does

It rewrites every unmatched path to `/index.html`. Vercel checks the filesystem
first, so real files like `/assets/index-a1b2c3.js` are still served normally.

This is needed because Phase 4 adds React Router. Without the rewrite, visiting
`/login` directly — or refreshing on it — asks Vercel for a file at that path,
which does not exist, and returns 404. With it, `index.html` loads and the router
resolves the path in the browser. The bug does not show up until someone refreshes
a non-root page, which is exactly the kind of thing that gets found in production.

---

## 6. CORS across real domains

Locally there is one allowed origin. In production there are potentially several,
and one of them changes constantly.

- `CLIENT_URL` — the canonical frontend origin. Single-valued on purpose: Phase 3
  needs exactly one URL to build email links from.
- `CORS_EXTRA_ORIGINS` — optional, comma-separated. This exists because **Vercel
  gives every branch and every commit its own hostname**
  (`tts-saas-git-my-branch-you.vercel.app`), and those cannot be known in advance.

The allowlist is `CLIENT_URL` plus `CORS_EXTRA_ORIGINS`. Implementation is in
[`server/src/config/cors.js`](../server/src/config/cors.js).

Three details that cause real outages:

1. **A trailing slash breaks it silently.** A browser's `Origin` header is
   `https://example.com` — never with a slash. `https://example.com/` would never
   match. `config/env.js` strips trailing slashes so this cannot happen.
2. **`http` vs `https` are different origins**, and so are `example.com` and
   `www.example.com`. If you add a custom domain, decide which one is canonical and
   redirect the other.
3. **A blocked origin is not a server error.** Our CORS layer refuses by *omitting*
   the `Access-Control-Allow-Origin` header, not by throwing. The request still
   returns 200; the browser is what refuses to hand the response to the page. So
   "CORS error" in a browser console with a 200 in the server log is the expected
   shape of this failure, not a contradiction.

Worth being clear about: **CORS is not access control.** It is a browser
restriction, and `curl` ignores it entirely. It stops a random website from making
authenticated calls with a user's cookies; it does nothing to stop a direct request.
Real authorisation is Phase 2.

If preview deployments should reach the API, add their origin to
`CORS_EXTRA_ORIGINS` — but consider whether preview builds should point at the
production database at all. Once there is real user data, they should not.

---

## 7. Deploy order

First time, the circular dependency between the two URLs forces this order:

1. Atlas cluster → get `MONGODB_URI`
2. Render Blueprint → set `MONGODB_URI`, leave `CLIENT_URL` at a placeholder → get the API URL
3. Vercel → set `VITE_API_BASE_URL` to the API URL → get the client URL
4. Render → set `CLIENT_URL` to the client URL → it redeploys automatically
5. Verify (below)

After that, both platforms deploy on push to `master`.

---

## 8. Verifying a deploy

```bash
curl -i https://<service>.onrender.com/api/health
```

Expect **200** and `"status":"alive"`.

```bash
curl -i https://<service>.onrender.com/api/ready
```

Expect **200** and `"database":"connected"`. A **503** with
`"database":"disconnected"` means the API is running but cannot reach Atlas — check
`MONGODB_URI` and the Atlas network allowlist.

```bash
curl -i -H "Origin: https://<project>.vercel.app" https://<service>.onrender.com/api/health
```

Expect `access-control-allow-origin` echoing that origin. If the header is missing,
`CLIENT_URL` on Render does not match — check for a trailing slash or `http` vs
`https`.

Then open the Vercel URL. The page should show liveness `alive`, readiness `ready`,
and database `connected`.

---

## 9. Rolling back

- **Render**: the service's *Deploys* tab → pick the previous successful deploy →
  **Redeploy**. Environment variable changes are not part of a deploy, so if a bad
  value caused the problem, fix the value instead.
- **Vercel**: *Deployments* → the previous deployment → **Promote to Production**.
  Instant, because the old build is still there.

Both are faster than reverting a commit and waiting for a build, so reach for them
first and fix forward afterwards.
