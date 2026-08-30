/**
 * Resolve Paddle price/plan IDs from env only.
 * No sandbox pri_ hardcodes — Live IDs must be set in Vercel after catalog migration.
 */

function readId(...names: string[]): string {
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return "";
}

export type PaddlePriceCatalog = {
  clientToken: string;
  starterMonthly: string;
  proMonthly: string;
  enterpriseMonthly: string;
  starterYearly: string;
  proYearly: string;
  enterpriseYearly: string;
  /** Plan IDs used by billing upgrade UI / tier mapping (usually monthly price ids). */
  starterPlanId: string;
  growthPlanId: string;
  proPlanId: string;
  removeBrandingAddonId: string;
  missing: string[];
};

export function getPaddlePriceCatalog(): PaddlePriceCatalog {
  const clientToken = readId("VITE_PADDLE_CLIENT_TOKEN");
  const starterMonthly = readId("VITE_PADDLE_STARTER_MONTHLY_PRICE_ID");
  const proMonthly = readId("VITE_PADDLE_PRO_MONTHLY_PRICE_ID");
  const enterpriseMonthly = readId("VITE_PADDLE_ENTERPRISE_MONTHLY_PRICE_ID");
  const starterYearly = readId("VITE_PADDLE_STARTER_YEARLY_PRICE_ID");
  const proYearly = readId("VITE_PADDLE_PRO_YEARLY_PRICE_ID");
  const enterpriseYearly = readId("VITE_PADDLE_ENTERPRISE_YEARLY_PRICE_ID");
  const starterPlanId = readId("VITE_PADDLE_STARTER_PLAN_ID", "VITE_PADDLE_STARTER_MONTHLY_PRICE_ID");
  const growthPlanId = readId(
    "VITE_PADDLE_GROWTH_PLAN_ID",
    "VITE_PADDLE_BASIC_PLAN_ID",
    "VITE_PADDLE_PRO_MONTHLY_PRICE_ID"
  );
  // Historical naming: BASIC ≈ Growth, PRO ≈ Scale on the billing page.
  const proPlanId = readId(
    "VITE_PADDLE_SCALE_PLAN_ID",
    "VITE_PADDLE_PRO_PLAN_ID",
    "VITE_PADDLE_ENTERPRISE_MONTHLY_PRICE_ID"
  );
  const removeBrandingAddonId = readId("VITE_PADDLE_REMOVE_BRANDING_ADDON_ID");

  const required: Array<[string, string]> = [
    ["VITE_PADDLE_CLIENT_TOKEN", clientToken],
    ["VITE_PADDLE_STARTER_MONTHLY_PRICE_ID", starterMonthly],
    ["VITE_PADDLE_PRO_MONTHLY_PRICE_ID", proMonthly],
    ["VITE_PADDLE_ENTERPRISE_MONTHLY_PRICE_ID", enterpriseMonthly],
    ["VITE_PADDLE_STARTER_YEARLY_PRICE_ID", starterYearly],
    ["VITE_PADDLE_PRO_YEARLY_PRICE_ID", proYearly],
    ["VITE_PADDLE_ENTERPRISE_YEARLY_PRICE_ID", enterpriseYearly],
  ];

  const missing = required.filter(([, v]) => !v).map(([k]) => k);

  return {
    clientToken,
    starterMonthly,
    proMonthly,
    enterpriseMonthly,
    starterYearly,
    proYearly,
    enterpriseYearly,
    starterPlanId: starterPlanId || starterMonthly,
    growthPlanId: growthPlanId || proMonthly,
    proPlanId: proPlanId || enterpriseMonthly,
    removeBrandingAddonId,
    missing,
  };
}
