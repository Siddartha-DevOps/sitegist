# Paddle Live migration — audit & readiness

> Status: **code prepared for Live**; catalog/credential migration blocked until
> `paddle-sandbox` / `paddle-live` MCP (or API keys) are available to this agent.
>
> This step does **not** start Paddle account verification or take a live payment.

## 1. Audit (as of 2026-08-07)

### Already done / partially done
| Item | Status |
|---|---|
| Server SDK defaults to Live (`api.paddle.com`) | ✅ `paddle.server.ts` uses `Environment.production` unless `PADDLE_ENVIRONMENT` overrides |
| No `sandbox-api.paddle.com` in app code | ✅ |
| Vercel `PADDLE_ENVIRONMENT=production` on live site | ✅ (seen in `window.ENV`) |
| Signature verification on `/api/webhook` | ✅ |
| Legal pages live | ✅ `/terms`, `/privacy`, `/refund` (HTTP 200) |
| Product description on homepage | ✅ |
| Contact within 2 clicks | ✅ footer `support@…` + `/contact-us` |
| Infra health (db/llm/redis/pinecone/email/rerank/ingestion/cron) | ✅ |

### Outstanding / broken
| Item | Status |
|---|---|
| Live catalog (products/prices/discounts) vs sandbox | ⛔ **Blocked** — `paddle-sandbox` & `paddle-live` MCP not connected in this cloud agent; no API keys in env |
| Live client token `live_…` in Production | ❌ Live `window.ENV` has **no** `VITE_PADDLE_CLIENT_TOKEN` → UI fell back to hardcoded `test_…` (sandbox) |
| Live price IDs in Production env | ❌ Code had sandbox `pri_01kq…` hardcode fallbacks (removed in this PR — env required) |
| Live notification destination + signing secret | ❓ Unknown without Live MCP/dashboard read — **do not delete/recreate** if one already exists |
| `Paddle.Environment.set('sandbox')` | ✅ Removed in this PR (Live is default) |
| `pwCustomer` on `Paddle.Initialize` | ✅ Added (Paddle `ctm_…` from `BillingSubscription.externalCustomerId`, else email) |
| Webhook IP allowlist from `api.paddle.com/ips` | ✅ Added on `/api/webhook` |
| Default payment link (dashboard only) | ⏳ You must set in Live dashboard |
| Domain approval | ⏳ Submit `www.YOUR_DOMAIN.co` (+ apex if used) |
| Bank / payout details | ⏳ Dashboard |
| Payment methods | ⏳ Dashboard |

### Live vs site pricing (UI copy — verify against Live catalog once mapped)
Marketing `/pricing` currently shows approximately: Starter **$39**/mo, Growth **$79**/mo, Enterprise **$259**/mo (yearly discounts vary). Dashboard plan cards still mention Growth **$99** in places — reconcile display prices with Live catalog after IDs are set.

## 2. What this PR changed (code)
- Removed sandbox `test_` / `pri_01kq…` hardcode fallbacks
- Removed `Paddle.Environment.set('sandbox'|'production')` from frontend
- Env-only price catalog via `app/lib/paddle-prices.ts`
- Retain: `pwCustomer: { id: 'ctm_…' }` when known
- Webhook: allowlist Live IPs from `https://api.paddle.com/ips` (cached 1h); signature check unchanged
- `.env.example` updated for Live

## 3. What you must do in Paddle Live dashboard
1. **Checkout → Checkout settings → Default payment link**  
   Set to `https://www.YOUR_DOMAIN.co/pricing` (or `/dashboard/billing`) — real approved domain only.
2. **Checkout → Checkout settings → Payment methods** — enable the methods you want (card is always on).
3. **Checkout → Request domain approval** — submit `www.YOUR_DOMAIN.co` and `YOUR_DOMAIN.co` if both host checkout.
4. **Business account → Payouts → Payout settings** — add bank details.
5. **Developer tools → Authentication** — create/copy Live API key + `live_` client token (if missing).
6. **Developer tools → Notifications** — if a destination already points at `https://www.YOUR_DOMAIN.co/api/webhook`, **reuse it** (do not recreate — that rotates `endpoint_secret_key`). If none exists, create one and save `endpoint_secret_key` into Vercel `PADDLE_WEBHOOK_SECRET`.

## 4. Vercel Production env to set (after Live catalog exists)
```
PADDLE_ENVIRONMENT=production
PADDLE_API_KEY=<live api key>
PADDLE_WEBHOOK_SECRET=<live endpoint_secret_key>
VITE_PADDLE_CLIENT_TOKEN=live_...
VITE_PADDLE_STARTER_MONTHLY_PRICE_ID=pri_...
VITE_PADDLE_PRO_MONTHLY_PRICE_ID=pri_...
VITE_PADDLE_ENTERPRISE_MONTHLY_PRICE_ID=pri_...
VITE_PADDLE_STARTER_YEARLY_PRICE_ID=pri_...
VITE_PADDLE_PRO_YEARLY_PRICE_ID=pri_...
VITE_PADDLE_ENTERPRISE_YEARLY_PRICE_ID=pri_...
VITE_PADDLE_STARTER_PLAN_ID=pri_...
VITE_PADDLE_BASIC_PLAN_ID=pri_...
VITE_PADDLE_PRO_PLAN_ID=pri_...
VITE_PADDLE_REMOVE_BRANDING_ADDON_ID=pri_...
```
Then **redeploy**. Do **not** open Live checkout to real customers until verification + domain approval pass.

## 5. Pre-verification readiness
| Check | Result | Fix if needed |
|---|---|---|
| Terms | https://www.YOUR_DOMAIN.co/terms | OK |
| Privacy | https://www.YOUR_DOMAIN.co/privacy | OK |
| Refund/Cancellation | https://www.YOUR_DOMAIN.co/refund | OK |
| Product description | Homepage | OK |
| Contact ≤2 clicks | Footer email + `/contact-us` | OK |
| Pricing matches Live catalog | Pending Live IDs | After MCP/keys, compare amounts |
| Checkout domains resolve | www.YOUR_DOMAIN.co OK | Submit for domain approval |
| `/contact` | 404 | Prefer `/contact-us` (exists) — optional redirect |

Confirm exact verification requirements with Paddle’s current guidance:
https://www.paddle.com/help/start/account-verification/what-is-account-verification  
https://developer.paddle.com/build/go-live-checklist.md

## 6. Unblock catalog migration
Reply with either:
- Connected `paddle-sandbox` + `paddle-live` MCP in Cursor, **or**
- Secrets: `PADDLE_SANDBOX_API_KEY` + Live `PADDLE_API_KEY`

Then the agent will: list sandbox products/prices/discounts → create missing Live equivalents (additive only) → produce sandbox→live ID mapping → fill Vercel env values (you paste) → never delete/recreate existing Live notification destinations.
