# Production Env & Deploy Checklist

The single reference for getting SiteGist correctly configured in production.
Most outages this project has seen were **config/ops**, not code: prod not
promoted, env set in the wrong Vercel scope, an invalid `PORTKEY_MODEL`, or a
DB missing a column. This checklist prevents all of those.

> Verify everything at a glance: **`GET /api/health`** (503 if a critical
> dependency is down). Pass `?token=$HEALTHCHECK_TOKEN` for detail,
> `&deep=1` for a real LLM ping.

## Deploy discipline (do this first)

- [ ] **Vercel → Settings → Git → Production Branch = `main`.** If it's anything
      else, merges to `main` never reach `www.sitegist.co`.
- [ ] Confirm `main` **auto-deploys to Production** (or promote manually:
      Deployments → latest `main` → ⋯ → Promote to Production).
- [ ] **Set env vars in the `Production` scope**, not just Preview/Development.
      Vercel scopes env per environment — a value in Preview does nothing for prod.
- [ ] **Redeploy after any env change** — existing deployments don't pick up new
      env values.
- [ ] After deploy, confirm the live build: `www.sitegist.co` console prints
      `[SiteGist] widget build: <sha>` — must match the latest `main` commit.

## Required — the app won't work without these (boot-validated)

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres (Prisma Accelerate `prisma://` for the app). |
| `SESSION_SECRET` | Session signing — must be a strong random value. |
| `WIDGET_SESSION_SECRET` | Signs public widget session proofs. Use a separate strong random value. |
| `PARTYKIT_AUTH_SECRET` | Signs realtime room access. Configure the identical value in the web app and PartyKit. |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Default LLM/embeddings key. |
| `PINECONE_API_KEY`, `PINECONE_INDEX` | Vector store. |

## Generation (chatbot answers) — required in practice

| Var | Notes |
|-----|-------|
| `OPENAI_API_KEY` | The effective generator (Gemini free tier 429s). Full `sk-…`, **not** a masked copy, not `VITE_`-prefixed. |
| `PORTKEY_MODEL` | Set to `gpt-4o-mini`. A provider-namespaced model (`@org/model`) with no Portkey routing **fails boot** (the Jul-9 outage). |
| `PORTKEY_API_KEY` | Optional — enables Portkey routing (then namespaced models are valid). |

## Abuse protection / rate limiting — set it or bots run up your bill

| Var | Notes |
|-----|-------|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **Without these, global per-IP abuse protection is OFF.** `/api/health` reports `redis: not_configured`. |
| `GLOBAL_RATE_LIMIT_PER_MIN` | Default `30`; `0` disables. |

## Login email (magic link) — no email = users can't log in

| Var | Notes |
|-----|-------|
| `RESEND_API_KEY` | Required to send login links. `/api/health` reports `email: not_configured` if missing. |
| `SENDER_EMAIL`, `SENDER_NAME` | From-address (defaults `support@sitegist.co` / `SiteGist`). Verify the domain in Resend for deliverability. |

**Verify deliverability end-to-end:** trigger a login on prod → the magic-link
email must arrive (check spam). Config presence alone isn't proof of delivery —
verify your Resend sending domain (SPF/DKIM).

## Answer quality (recommended for production)

| Var | Notes |
|-----|-------|
| `RERANK_ENABLED` | **Set `true` on production** to enable Cohere/Portkey reranking (needs Portkey/Cohere keys or `RERANK_URL`). Confirm via `/api/health` → `rerank: ok`. |
| `PORTKEY_COHERE_VIRTUAL_KEY`, `COHERE_RERANK_MODEL` | Cohere rerank via Portkey. |
| `RERANK_URL` | Self-hosted reranker endpoint (local-LLM path). |

## Other services

| Var | Purpose |
|-----|---------|
| `PARTYKIT_HOST` | Realtime server (live agent handoff). |
| `FIRECRAWL_API_KEY` | Website crawling for training. |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENVIRONMENT`, `VITE_PADDLE_CLIENT_TOKEN` + plan IDs | Billing. |
| `SENTRY_DSN` | Error reporting. |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | Analytics (public). |
| `VITE_CLOUDFLARE_TURNSTILE_SITE_KEY` / `CLOUDFLARE_TURNSTILE_SECRET_KEY` | Bot protection on auth forms. |
| `HEALTHCHECK_TOKEN` | Unlocks verbose/deep `/api/health` output. |

## Database migrations (separate from the web build)

- Keep **`AUTO_SCHEMA_SYNC=0`** in production. The web runtime must not have DDL
  privileges; schema changes belong in the migration workflow below.

- Prod was provisioned with `prisma db push` — schema changes are applied by the
  **`Database schema sync`** GitHub Action (`prisma db push`), not the Vercel build.
- One-time: add repo secret **`MIGRATE_DATABASE_URL`** = the **direct** Postgres
  URL (not the `prisma://` Accelerate URL).
- Run it: **Actions → Database schema sync → Run workflow** (or it runs on
  `schema.prisma` changes to `main`).
- If a page shows "column … does not exist", the DB is behind the schema — run
  that workflow (or `prisma db push` locally against the direct URL).

## Future: local-LLM stack

`AI_PROVIDER=local`, `LOCAL_LLM_URL`, `LOCAL_EMBED_URL`, `EMBEDDING_DIMENSION`
(e.g. `1024` for bge-m3), `EMBEDDING_PROVIDER`. See `app/ai-layer/provider.server.ts`.
