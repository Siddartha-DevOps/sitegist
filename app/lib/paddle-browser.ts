/**
 * Shared Paddle.js (browser) helpers for Live Billing.
 *
 * Live is the default environment — do NOT call Paddle.Environment.set("sandbox").
 * Client token + price IDs must come from env (never hard-code sandbox test_/pri_ values).
 */

export type PaddlePwCustomer = { id: string } | { email: string };

export function getBrowserPaddleClientToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const fromEnv = (window as any).ENV?.VITE_PADDLE_CLIENT_TOKEN as string | undefined;
  const token = fromEnv?.trim();
  if (!token) return undefined;
  if (token.startsWith("test_")) {
    console.error(
      "[Paddle] VITE_PADDLE_CLIENT_TOKEN is a sandbox (test_) token. " +
        "Live checkout requires a live_ client-side token from Paddle → Developer tools → Authentication."
    );
  }
  return token;
}

/**
 * Initialize Paddle.js for Live. Optionally pass pwCustomer (Paddle customer id ctm_…)
 * so Retain can identify the signed-in buyer. Never pass an internal user id.
 */
export function initializePaddleBrowser(opts?: {
  token?: string;
  pwCustomer?: PaddlePwCustomer | null;
}): boolean {
  if (typeof window === "undefined") return false;
  const Paddle = (window as any).Paddle;
  if (!Paddle) {
    console.warn("[Paddle] Paddle.js not loaded yet.");
    return false;
  }

  const token = opts?.token?.trim() || getBrowserPaddleClientToken();
  if (!token) {
    console.error(
      "[Paddle] Missing VITE_PADDLE_CLIENT_TOKEN — set a live_ token in Vercel Production and redeploy."
    );
    return false;
  }

  // Live is default. Do not call Environment.set("sandbox").
  // If a test_ token is still present (misconfig), refuse to silently open sandbox checkout in prod-looking UI.
  if (token.startsWith("test_") && (window as any).ENV?.NODE_ENV === "production") {
    console.error("[Paddle] Refusing to initialize sandbox token in production.");
    return false;
  }

  try {
    const init: Record<string, unknown> = { token };
    if (opts?.pwCustomer) {
      init.pwCustomer = opts.pwCustomer;
    }
    Paddle.Initialize(init);
    return true;
  } catch (err) {
    console.warn("[Paddle] Initialize failed:", err);
    return false;
  }
}
