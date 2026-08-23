# AI Text-to-Speech SaaS

Turn text into natural speech in many voices and languages. Users get free credits on
signup, then buy credit packs or subscribe.

**Current status: Phase 0 complete — project foundation only.**
There is no authentication, no speech generation, and no billing yet. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the phase plan.

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System shape, modules, data models, auth / credit / payment strategy, security concerns |
| [docs/DECISIONS.md](docs/DECISIONS.md) | What is locked, and what must stay configurable — read before hard-coding anything |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase-by-phase build order and status |

## Tech stack

React 19 (Vite) · Node 22 · Express 5 · MongoDB with Mongoose · JavaScript (ESM)

## Layout

```
Text-to-Speech/
├── docs/       architecture, decisions, roadmap
├── client/     React frontend (Vite)
└── server/     Express API
```

## Prerequisites

- **Node.js 20.6+** (developed on 22.20.0)
- **MongoDB** — either a local install running on `127.0.0.1:27017`, or a free
  MongoDB Atlas cluster

## Setup

```bash
cd server && npm install && cp .env.example .env
```

```bash
cd client && npm install && cp .env.example .env
```

Then edit `server/.env` and set `MONGODB_URI` if you are not using a local MongoDB.

## Environment variables

### `server/.env`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `4000` | Port the API listens on |
| `MONGODB_URI` | **yes** | — | Connection string. No default on purpose: a wrong database is worse than a missing one |
| `CLIENT_URL` | no | `http://localhost:5173` | The one browser origin CORS allows. No trailing slash |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug` |

The server validates these on boot and **exits with a readable list of problems** if
anything is missing or malformed.

### `client/.env`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `VITE_API_BASE_URL` | **yes** | — | Base URL of the API, no trailing slash. Must match the server's `PORT` |

Vite inlines every `VITE_` variable into the public JavaScript bundle, so treat all of
them as visible to anyone. Secrets belong in `server/.env` only.

## Running it

Two terminals.

```bash
cd server && npm run dev
```

```bash
cd client && npm run dev
```

Then open <http://localhost:5173>. The page calls `GET /api/health` and shows whether
the API and database are reachable.

| Location | Script | What it does |
|---|---|---|
| `server` | `npm run dev` | Starts the API with `node --watch` (auto-restart on save) |
| `server` | `npm start` | Starts the API without watching — production entry point |
| `client` | `npm run dev` | Vite dev server on port 5173 |
| `client` | `npm run build` | Production build into `client/dist` |
| `client` | `npm run preview` | Serves the built bundle locally |
| `client` | `npm run lint` | Runs oxlint |

## Health check

```bash
curl http://localhost:4000/api/health
```

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "environment": "development",
    "database": "connected",
    "uptimeSeconds": 12,
    "timestamp": "2026-08-23T00:00:00.000Z"
  }
}
```

Returns **200** when MongoDB is connected and **503** with `"database": "disconnected"`
when it is not. The 503 is deliberate — a hosting platform's readiness probe should pull
an unhealthy instance out of rotation instead of sending it requests that will fail.

The server starts listening *before* connecting to MongoDB, so a database problem shows
up as a truthful health response rather than a process that refuses to boot.

## Conventions

- **Business logic lives in services**, not controllers. Controllers parse input and
  shape responses.
- **One error shape.** `middleware/errorHandler.js` is the only place an error becomes an
  HTTP response. Throw an `ApiError(status, message)` for expected failures; anything
  else becomes a generic 500 so internals never leak.
- Express 5 forwards rejected promises from async handlers to the error handler
  automatically, so route code needs no `try/catch` wrapper.
- **All external providers sit behind an adapter** in `server/src/integrations/`. No
  vendor SDK is imported anywhere else.
- **Never commit `.env`.** `.env.example` files are tracked so the required keys stay
  documented.
