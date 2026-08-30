import { getPaddlePriceCatalog } from "~/lib/paddle-prices";

export type PlanInfo = {
  name: string;
  messageLimit: number; // -1 = unlimited
  chatbotLimit: number; // -1 = unlimited
};

export function getPlanForTier(tier: string | null | undefined): PlanInfo {
  const { starterPlanId, growthPlanId, proPlanId } = getPaddlePriceCatalog();

  switch (tier) {
    case growthPlanId:
      return { name: "Growth", messageLimit: 5000, chatbotLimit: 3 };
    case proPlanId:
      return { name: "Scale", messageLimit: 25000, chatbotLimit: -1 };
    case "enterprise_plan":
      return { name: "Enterprise", messageLimit: -1, chatbotLimit: -1 };
    case starterPlanId:
    case "starter_plan":
    case "free":
    case null:
    case undefined:
    default:
      return { name: "Starter", messageLimit: 1000, chatbotLimit: 1 };
  }
}

export function hasRemoveBrandingAccess(
  tier: string | null | undefined,
  addons: { type: string; status: string }[]
): boolean {
  const { growthPlanId, proPlanId } = getPaddlePriceCatalog();

  if (tier === growthPlanId || tier === proPlanId || tier === "enterprise_plan") {
    return true;
  }

  return addons.some((a) => a.type === "remove_branding" && a.status === "active");
}
