import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form, useNavigation, useActionData } from "@remix-run/react";
import { requireUserId, getUser } from "~/backend/auth.server";
import { prisma } from "~/database/db.server";
import { getPlanForTier, hasRemoveBrandingAccess } from "~/lib/plans";
import { getPaddlePriceCatalog } from "~/lib/paddle-prices";
import { Check, CreditCard, Loader2, ChevronDown, Zap, MessageSquare, Globe, Plus, Info, AlertTriangle, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const user = await getUser(request);

  // Active subscription check
  const activeSub = await prisma.billingSubscription.findFirst({
    where: { userId, status: "active" },
    orderBy: { createdAt: "desc" }
  });

  let daysLeft = 24;
  if (activeSub) {
    const created = new Date(activeSub.createdAt);
    const now = new Date();
    const nextBillDate = new Date(created);
    while (nextBillDate <= now) {
      nextBillDate.setMonth(nextBillDate.getMonth() + 1);
    }
    const diffTime = nextBillDate.getTime() - now.getTime();
    daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  // Retrieve actual user usage stats
  const messagesCount = await prisma.message.count({
    where: { session: { project: { userId } } }
  });
  
  const chatbotsCount = await prisma.project.count({
    where: { userId }
  });

  const knowledgeCount = await prisma.knowledgeSource.count({
    where: { project: { userId } }
  });

  const leadsCount = await prisma.lead.count({
    where: { project: { userId } }
  });

  const catalog = getPaddlePriceCatalog();
  const PADDLE_STARTER_PLAN_ID = catalog.starterPlanId;
  const PADDLE_BASIC_PLAN_ID = catalog.growthPlanId;
  const PADDLE_PRO_PLAN_ID = catalog.proPlanId;

  // Determine the current plan name + monthly message limit (-1 = unlimited)
  const planInfo = getPlanForTier(user?.subscriptionTier);
  const planName = planInfo.name;
  const messageLimit = planInfo.messageLimit;

  // Count messages used in the current calendar month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  let messagesUsed = 0;
  try {
    const usage = await prisma.usageRecord.aggregate({
      where: { userId, type: "chat_message", createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
    });
    messagesUsed = usage._sum.amount || 0;
  } catch (e) {
    console.error("[Billing] Usage query failed:", e);
  }

  // Query the user's active subscription for next billing date
  let nextBilledAt: string | null = null;
  let daysRemaining: number | null = null;
  try {
    const subscription = await prisma.billingSubscription.findFirst({
      where: { userId, status: { in: ["active", "trialing"] } },
      orderBy: { updatedAt: "desc" },
      select: { nextBilledAt: true },
    });
    if (subscription?.nextBilledAt) {
      nextBilledAt = subscription.nextBilledAt.toISOString();
      const diff = subscription.nextBilledAt.getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }
  } catch (e) {
    console.error("[Billing] Subscription query failed:", e);
  }

  // Billing history (most recent first)
  let payments: {
    id: string;
    transactionId: string;
    amount: number;
    currency: string;
    status: string;
    invoiceUrl: string | null;
    paidAt: string;
  }[] = [];
  try {
    const rows = await prisma.billingPayment.findMany({
      where: { userId },
      orderBy: { paidAt: "desc" },
      take: 24,
    });
    payments = rows.map((p) => ({
      id: p.id,
      transactionId: p.transactionId,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      invoiceUrl: p.invoiceUrl,
      paidAt: p.paidAt.toISOString(),
    }));
  } catch (e) {
    console.error("[Billing] Payment history query failed:", e);
  }

  // Chatbot usage
  let chatbotCount = 0;
  try {
    chatbotCount = await prisma.project.count({ where: { userId } });
  } catch (e) {
    console.error("[Billing] Chatbot count failed:", e);
  }

  // Chatbot limit based on current plan (-1 = unlimited)
  const chatbotLimit = planInfo.chatbotLimit;

  // Add-ons
  let userAddons: { type: string; status: string }[] = [];
  try {
    userAddons = await prisma.userAddon.findMany({
      where: { userId, status: "active" },
      select: { type: true, status: true },
    });
  } catch (e) {
    console.error("[Billing] Addons query failed:", e);
  }

  const removeBrandingAddonId = catalog.removeBrandingAddonId;
  const removeBrandingEnabled = hasRemoveBrandingAccess(user?.subscriptionTier, userAddons);

  // Paddle customer id for Retain (ctm_…), never internal userId.
  let paddleCustomerId: string | null = null;
  try {
    const sub = await prisma.billingSubscription.findFirst({
      where: { userId, externalCustomerId: { not: "" } },
      orderBy: { updatedAt: "desc" },
      select: { externalCustomerId: true },
    });
    paddleCustomerId = sub?.externalCustomerId || null;
  } catch (e) {
    console.error("[Billing] paddleCustomerId lookup failed:", e);
  }

  return json({
    user,
    paddleCustomerId,
    catalogMissing: catalog.missing,
    daysLeft,
    usage: {
      messages: messagesCount,
      chatbots: chatbotsCount,
      knowledge: knowledgeCount,
      leads: leadsCount
    },
    PADDLE_STARTER_PLAN_ID,
    PADDLE_BASIC_PLAN_ID,
    PADDLE_PRO_PLAN_ID,
    PADDLE_REMOVE_BRANDING_ADDON_ID: removeBrandingAddonId,
    planName,
    messageLimit,
    messagesUsed,
    nextBilledAt,
    daysRemaining,
    payments,
    chatbotCount,
    chatbotLimit,
    removeBrandingEnabled,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const user = await getUser(request);
  const formData = await request.formData();
  const planId = formData.get("plan") as string;

  if (!planId) {
    return json({ error: "Invalid plan" }, { status: 400 });
  }

  // Return Paddle signal to the client
  return json({ 
    checkoutPlanId: planId, 
    userEmail: user?.email,
    userId: user?.id
  });
}

export default function Billing() {
  const { user, paddleCustomerId, daysLeft, usage, PADDLE_STARTER_PLAN_ID, PADDLE_BASIC_PLAN_ID, PADDLE_PRO_PLAN_ID, PADDLE_REMOVE_BRANDING_ADDON_ID, planName, messageLimit, messagesUsed, nextBilledAt, daysRemaining, payments, chatbotCount, chatbotLimit, removeBrandingEnabled } = useLoaderData<typeof loader>();
  
  const isUnlimited = messageLimit === -1;
  const usagePercent = isUnlimited ? 0 : Math.min(100, Math.round((messagesUsed / messageLimit) * 100));
  const isNearLimit = !isUnlimited && usagePercent >= 80;

  const isChatbotUnlimited = chatbotLimit === -1;
  const chatbotPercent = isChatbotUnlimited
    ? 0
    : Math.min(100, Math.round((chatbotCount / chatbotLimit) * 100));
  const isChatbotNearLimit = !isChatbotUnlimited && chatbotPercent >= 80;
  
  // Determine current subscription tier limits
  const tier = (user?.subscriptionTier || "free").toLowerCase();
  
  let limits = {
    messages: 100,
    chatbots: 1,
    knowledge: 10,
    leads: 50,
    name: "Free Plan"
  };

  if (tier === "pro" || tier === "pro_plan" || tier.includes("pro") || tier.includes("scale") || tier.includes("growth") || tier === "starter_plan" || tier.includes("starter") || tier.includes("starter_plan")) {
    limits = {
      messages: 5000,
      chatbots: 5,
      knowledge: 100,
      leads: 1000,
      name: "Pro Plan"
    };
  } else if (tier === "scale" || tier === "scale_plan" || tier.includes("enterprise")) {
    limits = {
      messages: 50000,
      chatbots: 25,
      knowledge: 1000,
      leads: 10000,
      name: "Scale Plan"
    };
  }

  const getProgressBarColor = (percentage: number) => {
    if (percentage < 70) return "bg-emerald-500";
    if (percentage <= 90) return "bg-amber-500";
    return "bg-red-500";
  };

  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("yearly");
  const [activeFaq, setActiveFaq] = useState<number | null>(null);
  const [calcMessages, setCalcMessages] = useState(5000);
  const [demoPlanMessage, setDemoPlanMessage] = useState<string | null>(null);
  const [isInsideIframe, setIsInsideIframe] = useState(false);
  
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsInsideIframe(window.self !== window.top);
    }
  }, []);
  
  const isSubmitting = navigation.state === "submitting";
  const submittingPlanId = navigation.formData?.get("plan");

  // Live is default — no Environment.set("sandbox"). pwCustomer enables Retain.
  useEffect(() => {
    void import("~/lib/paddle-browser").then(({ initializePaddleBrowser }) => {
      initializePaddleBrowser({
        pwCustomer: paddleCustomerId
          ? { id: paddleCustomerId }
          : user?.email
            ? { email: user.email }
            : null,
      });
    });
  }, [paddleCustomerId, user?.email]);

  useEffect(() => {
    if (actionData && 'checkoutPlanId' in actionData) {
      if (isInsideIframe) {
        setDemoPlanMessage("Checkout Blocked: Secure payment checkout sessions cannot be initialized within nested iframes. Please click 'Open in New Tab' inside the yellow header banner above to complete your subscription trial in a secure window.");
        return;
      }
      // @ts-ignore
      if (typeof Paddle !== 'undefined') {
        try {
          // @ts-ignore
          Paddle.Checkout.open({ 
            items: [
              {
                priceId: actionData.checkoutPlanId,
                quantity: 1
              }
            ],
            customer: {
              email: actionData.userEmail || ""
            },
            customData: {
              userId: actionData.userId || ""
            }
          });
        } catch (checkoutErr) {
          console.error("Paddle Checkout open failed:", checkoutErr);
          setDemoPlanMessage("Secure checkout session could not be established. Please try again or contact support.");
        }
      } else {
        setDemoPlanMessage(`Demo Mode: Securing checkout session for dynamic billing setup. Target plan: ${actionData.checkoutPlanId}. User logged in: ${actionData.userEmail || "anonymous"}`);
      }
    }
  }, [actionData, isInsideIframe]);

  const plans = [
    {
      id: PADDLE_STARTER_PLAN_ID,
      name: "Starter",
      monthlyPrice: 39,
      yearlyPrice: 19,
      description: "Perfect for personal projects",
      features: ["1 Chatbot", "1,000 Messages/mo", "50 Pages Crawled", "Basic AI Model", "95+ Languages"],
      current: user?.subscriptionTier === PADDLE_STARTER_PLAN_ID || user?.subscriptionTier === "starter_plan" || !user?.subscriptionTier || user?.subscriptionTier === "free",
    },
    {
      id: PADDLE_BASIC_PLAN_ID,
      name: "Growth",
      monthlyPrice: 99,
      yearlyPrice: 59,
      popular: true,
      description: "For growing businesses",
      features: ["3 Chatbots", "5,000 Messages/mo", "500 Pages Crawled", "GPT-4o Access", "No Branding", "95+ Languages"],
      current: user?.subscriptionTier === PADDLE_BASIC_PLAN_ID,
    },
    {
      id: PADDLE_PRO_PLAN_ID,
      name: "Scale",
      monthlyPrice: 299,
      yearlyPrice: 199,
      description: "For high-traffic sites",
      features: ["Unlimited Chatbots", "25,000 Messages/mo", "Unlimited Crawls", "Premium Support", "API Access", "95+ Languages"],
      current: user?.subscriptionTier === PADDLE_PRO_PLAN_ID,
    },
    {
      id: "enterprise_plan",
      name: "Enterprise",
      price: "Custom",
      description: "Tailored solutions",
      features: ["White Label", "Dedicated Account Manager", "Custom LLM Training", "On-premise Deployment", "95+ Languages"],
      current: user?.subscriptionTier === "enterprise_plan",
    },
  ];

  const faqs = [
    { q: "Can I cancel anytime?", a: "Yes, you can cancel your subscription at any time from your dashboard settings. No questions asked." },
    { q: "What happens if I exceed my message limit?", a: "The bot will continue to work, but we'll notify you to upgrade or purchase an add-on pack for extra messages." },
    { q: "Do you offer a free trial?", a: "We have a generous free tier to get you started. Pricing plans are for when you need more capacity and features." },
    { q: "Can I use my own OpenAI API key?", a: "Our Pro and Enterprise plans allow you to use your own API keys for full control over model usage and costs." },
    { q: "What languages does SiteGist support?", a: "All 95+ languages supported by the underlying AI models — including English, Spanish, French, German, Portuguese, Arabic, Hindi, Japanese, Chinese, and many more. Your bot automatically detects and responds in the visitor's language. No configuration required." },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      {/* Header */}
      <div className="text-center mb-16">
        <h1 className="text-4xl md:text-6xl font-black mb-6 font-display tracking-tight text-zinc-900">
          The right plan for <br /> <span className="text-primary italic">every</span> stage.
        </h1>
        
        {/* Toggle */}
        <div className="flex items-center justify-center gap-4">
          <span className={`text-sm font-bold ${billingCycle === 'monthly' ? 'text-zinc-900' : 'text-zinc-400'}`}>Monthly</span>
          <button 
            type="button"
            onClick={() => setBillingCycle(prev => prev === 'monthly' ? 'yearly' : 'monthly')}
            className="w-14 h-8 bg-zinc-100 rounded-full p-1 transition-colors relative"
          >
            <motion.div 
              animate={{ x: billingCycle === 'yearly' ? 24 : 0 }}
              className="w-6 h-6 bg-primary rounded-full shadow-lg shadow-primary/20"
            />
          </button>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold ${billingCycle === 'yearly' ? 'text-zinc-900' : 'text-zinc-400'}`}>Yearly</span>
            <span className="px-2 py-1 bg-green-100 text-green-600 text-[10px] font-black rounded-lg uppercase tracking-tighter shadow-sm border border-green-200">
              Save 40%
            </span>
          </div>
        </div>
      </div>

      {/* Next Billing Date */}
      {nextBilledAt && daysRemaining !== null && (
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-3 bg-white border border-zinc-100 rounded-full px-6 py-3 shadow-sm">
            <CreditCard className="w-4 h-4 text-primary shrink-0" />
            <span className="text-sm font-bold text-zinc-600">
              Next billing:{" "}
              <span className="text-zinc-900 font-black">
                {new Date(nextBilledAt).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </span>
            <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-primary/5 text-primary border border-primary/10">
              {daysRemaining === 0 ? "Today" : `${daysRemaining} days`}
            </span>
          </div>
        </div>
      )}

      {/* Current Usage Quota */}
      <div className="max-w-4xl mx-auto mb-16 bg-white p-8 rounded-[40px] border border-zinc-100 shadow-sm">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/5 text-primary rounded-2xl flex items-center justify-center">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-lg leading-tight">Message Usage</h3>
              <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{planName} Plan · This Month</p>
            </div>
          </div>
          <div className="text-right">
            <span className="text-2xl font-black text-zinc-900">{messagesUsed.toLocaleString()}</span>
            <span className="text-sm font-bold text-zinc-400">
              {isUnlimited ? " / Unlimited" : ` / ${messageLimit.toLocaleString()}`}
            </span>
          </div>
        </div>

        <div className="w-full bg-zinc-100 h-3 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${isNearLimit ? "bg-brand-orange" : "bg-primary"}`}
            style={{ width: isUnlimited ? "100%" : `${usagePercent}%` }}
          />
        </div>

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs font-bold text-zinc-400">
            {isUnlimited ? "Unlimited messages on your plan" : `${usagePercent}% of monthly quota used`}
          </span>
          {isNearLimit && (
            <span className="text-xs font-black text-brand-orange uppercase tracking-wide">
              Approaching limit — consider upgrading
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-zinc-100 my-6" />

        {/* Chatbot Limit */}
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/5 text-primary rounded-2xl flex items-center justify-center">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-lg leading-tight">Chatbots</h3>
              <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest">Active projects</p>
            </div>
          </div>
          <div className="text-right">
            <span className="text-2xl font-black text-zinc-900">{chatbotCount}</span>
            <span className="text-sm font-bold text-zinc-400">
              {isChatbotUnlimited ? " / Unlimited" : ` / ${chatbotLimit}`}
            </span>
          </div>
        </div>

        <div className="w-full bg-zinc-100 h-3 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${isChatbotNearLimit ? "bg-brand-orange" : "bg-primary"}`}
            style={{ width: isChatbotUnlimited ? "100%" : `${chatbotPercent}%` }}
          />
        </div>

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs font-bold text-zinc-400">
            {isChatbotUnlimited
              ? "Unlimited chatbots on your plan"
              : `${chatbotPercent}% of chatbot limit used`}
          </span>
          {isChatbotNearLimit && (
            <span className="text-xs font-black text-brand-orange uppercase tracking-wide">
              At limit — upgrade to add more
            </span>
          )}
        </div>
      </div>

      {/* Message Banner */}
      <AnimatePresence>
        {demoPlanMessage && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-zinc-50 border border-zinc-200 text-zinc-800 p-5 rounded-[24px] mb-8 max-w-4xl mx-auto flex items-start sm:items-center justify-between gap-4 shadow-sm"
          >
            <div className="flex items-start sm:items-center gap-3">
              <Info className="w-5 h-5 text-primary shrink-0 mt-0.5 sm:mt-0" />
              <p className="text-xs sm:text-sm font-semibold leading-relaxed">{demoPlanMessage}</p>
            </div>
            <button 
              type="button" 
              onClick={() => setDemoPlanMessage(null)}
              className="text-zinc-400 hover:text-zinc-600 font-extrabold text-xs uppercase tracking-wider px-2 py-1 bg-white hover:bg-zinc-100 rounded-lg border border-zinc-100 transition-colors shrink-0"
            >
              Okay
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sandbox/iframe Environment Warnings for Payments */}
      {isInsideIframe && (
        <div className="bg-amber-50 border border-amber-200 text-amber-950 p-6 rounded-[24px] mb-8 max-w-4xl mx-auto shadow-sm">
          <div className="flex gap-4">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <h4 className="text-sm font-black tracking-tight text-amber-950 uppercase">Payment &amp; Sandbox Sandbox Detection</h4>
              <p className="text-xs font-semibold leading-relaxed text-amber-800">
                You are currently viewing this application inside the sandboxed <strong>AI Studio Iframe Preview</strong>. 
                Most web browsers block third-party cookies, secure sessions, and payment modals (from providers like Paddle or Stripe) within nested preview panels.
              </p>
              <p className="text-xs font-semibold leading-relaxed text-amber-800">
                To complete or test payment transactions successfully, please click the <strong>"Open in New Tab"</strong> button in your top-right toolbar or click below to launch the page in a secure native browser window where cookies and checkouts are allowed:
              </p>
              <div className="pt-2">
                <a 
                  href={typeof window !== "undefined" ? window.location.href : "/dashboard/billing"} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-[11px] uppercase tracking-wider px-4 py-2 rounded-xl border border-amber-700/20 transition-all shadow-sm"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Usage Quota Section */}
      <div id="usage-quota-section" className="mb-12 bg-white border border-zinc-100 rounded-[32px] p-8 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-black font-display text-zinc-900">Your Usage This Month</h2>
            <p className="text-sm font-bold text-zinc-400 mt-1">
              Active plan: <span className="text-primary uppercase tracking-wide font-black">{limits.name}</span>
            </p>
          </div>
          <div className="px-5 py-2.5 bg-zinc-50 rounded-2xl border border-zinc-100 text-right shrink-0">
            <span className="text-xl font-black text-zinc-900 font-display block leading-none mb-1">{daysLeft}</span>
            <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest leading-none">Days left in cycle</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { label: "Messages Used", current: usage.messages, limit: limits.messages },
            { label: "Chatbots Created", current: usage.chatbots, limit: limits.chatbots },
            { label: "Pages / Knowledge Sources", current: usage.knowledge, limit: limits.knowledge },
            { label: "Leads Captured", current: usage.leads, limit: limits.leads },
          ].map((item) => {
            const percentage = item.limit > 0 ? Math.round((item.current / item.limit) * 100) : 0;
            const clampPercent = Math.min(100, percentage);
            const barColor = getProgressBarColor(clampPercent);

            return (
              <div key={item.label} className="p-5 bg-zinc-50/50 rounded-2xl border border-zinc-100 flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider">{item.label}</span>
                    <span className="text-xs font-black text-zinc-900 bg-white px-2 py-0.5 rounded border border-zinc-100">
                      {percentage}%
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1 mb-4">
                    <span className="text-2xl font-extrabold text-zinc-900">{item.current.toLocaleString()}</span>
                    <span className="text-xs font-bold text-zinc-400">/ {item.limit.toLocaleString()}</span>
                  </div>
                </div>
                <div className="w-full bg-zinc-200/60 h-2.5 rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all duration-500 ${barColor}`} 
                    style={{ width: `${clampPercent}%` }} 
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-24">
        {plans.map((plan) => (
          <div 
            key={plan.id}
            className={`relative p-8 bg-white border rounded-[40px] flex flex-col transition-all duration-500 hover:shadow-2xl hover:shadow-primary/5 group ${
              plan.popular ? "border-primary ring-4 ring-primary/5 shadow-xl shadow-primary/10 -translate-y-2" : "border-zinc-100"
            }`}
          >
            {plan.popular && (
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary text-white text-[11px] font-black rounded-full uppercase tracking-widest shadow-xl">
                Most Popular
              </div>
            )}
            
            <div className="mb-8">
              <h3 className="text-xl font-black mb-1 font-display">{plan.name}</h3>
              <p className="text-zinc-400 text-xs font-bold mb-6">{plan.description}</p>
              <div className="flex items-baseline gap-1">
                {plan.price ? (
                  <span className="text-4xl font-black font-display">{plan.price}</span>
                ) : (
                  <>
                    <span className="text-4xl font-black font-display">
                      ${billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice}
                    </span>
                    <span className="text-zinc-400 text-sm font-bold">/mo</span>
                  </>
                )}
              </div>
            </div>
            
            <ul className="space-y-4 mb-10 flex-1">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-3 text-sm font-bold text-zinc-600">
                  <div className="w-5 h-5 bg-zinc-50 rounded-full flex items-center justify-center shrink-0 mt-0.5 group-hover:bg-primary-muted transition-colors">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  {feature}
                </li>
              ))}
            </ul>
            
            {plan.current ? (
              <div className="w-full py-4 bg-zinc-50 text-zinc-400 rounded-3xl font-black text-center text-sm border border-zinc-100">
                Current Plan
              </div>
            ) : (
              <Form method="post">
                <input type="hidden" name="plan" value={plan.id} />
                <button 
                  type="submit" 
                  disabled={isSubmitting && submittingPlanId === plan.id}
                  className={`w-full py-4 rounded-3xl font-black transition-all flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-[0.98] ${
                    plan.popular ? "bg-primary text-white shadow-xl shadow-primary/20" : "bg-white border-2 border-zinc-100 text-zinc-900 hover:border-primary"
                  }`}
                >
                  {isSubmitting && submittingPlanId === plan.id ? <Loader2 className="w-5 h-5 animate-spin" /> : (plan.id === 'enterprise_plan' ? 'Contact Sales' : 'Start Trial')}
                </button>
              </Form>
            )}
          </div>
        ))}
      </div>

      {/* Billing History */}
      {payments && payments.length > 0 && (
        <div className="max-w-4xl mx-auto mb-24">
          <h3 className="text-2xl font-black mb-6 font-display text-zinc-900">Billing History</h3>
          <div className="bg-white border border-zinc-100 rounded-[40px] overflow-hidden shadow-sm">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50/50">
                  <th className="px-8 py-5 text-[10px] font-black uppercase tracking-widest text-zinc-400">Date</th>
                  <th className="px-8 py-5 text-[10px] font-black uppercase tracking-widest text-zinc-400">Amount</th>
                  <th className="px-8 py-5 text-[10px] font-black uppercase tracking-widest text-zinc-400">Status</th>
                  <th className="px-8 py-5 text-[10px] font-black uppercase tracking-widest text-zinc-400 text-right">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50/40 transition-colors">
                    <td className="px-8 py-5 text-sm font-bold text-zinc-700">
                      {new Date(p.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </td>
                    <td className="px-8 py-5 text-sm font-black text-zinc-900">
                      {p.amount.toLocaleString("en-US", { style: "currency", currency: p.currency || "USD" })}
                    </td>
                    <td className="px-8 py-5">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide ${
                        p.status === "completed" || p.status === "paid"
                          ? "bg-green-50 text-green-600 border border-green-100"
                          : "bg-zinc-100 text-zinc-500 border border-zinc-200"
                      }`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-8 py-5 text-right">
                      {p.invoiceUrl ? (
                        <a
                          href={p.invoiceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-black text-primary hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" /> Download
                        </a>
                      ) : (
                        <span className="text-xs font-bold text-zinc-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pricing Calculator */}
      <div className="mb-24 bg-zinc-50 rounded-[60px] p-12 border border-zinc-100">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row gap-16 items-center">
          <div className="flex-1">
            <div className="flex items-center gap-2 text-primary font-black text-xs uppercase tracking-widest mb-4">
              <Zap className="w-4 h-4" /> Usage calculator
            </div>
            <h3 className="text-3xl font-black mb-6 font-display text-zinc-900">Configure your volume</h3>
            <p className="text-zinc-500 font-bold mb-10">Select your monthly message volume to see how it scales across models.</p>
            
            <div className="space-y-6">
              <input 
                type="range" 
                min="1000" 
                max="50000" 
                step="1000"
                value={calcMessages}
                onChange={(e) => setCalcMessages(parseInt(e.target.value))}
                className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-xs font-black text-zinc-400 uppercase tracking-tighter">
                <span>1,000 messages</span>
                <span>50,000 messages</span>
              </div>
            </div>
          </div>
          
          <div className="w-full md:w-80 bg-white p-8 rounded-[40px] shadow-sm border border-zinc-100">
            <div className="space-y-6">
              <div className="pb-6 border-b border-zinc-50">
                <span className="text-zinc-400 text-xs font-black uppercase tracking-widest block mb-2">Total Monthly Access</span>
                <span className="text-4xl font-black font-display text-primary">{calcMessages.toLocaleString()}</span>
              </div>
              <div className="space-y-4">
                <div className="flex justify-between items-center text-sm">
                  <span className="font-bold text-zinc-600">GPT-4o Mini</span>
                  <span className="font-black text-zinc-900">Included</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="font-bold text-zinc-600">GPT-4o Pro</span>
                  <span className="font-black text-zinc-900">1 free / 10msg</span>
                </div>
              </div>
              <button className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-black text-sm hover:bg-black transition-all">
                Try Capacity
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add-ons */}
      <div id="addons" className="mb-24 px-12">
        <h3 className="text-3xl font-black mb-4 font-display text-center">Power-ups & Add-ons</h3>
        <p className="text-center text-sm font-bold text-zinc-400 mb-12">Add individual features to any plan without upgrading.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Remove Branding Add-on */}
          <div className={`flex items-center gap-6 p-8 bg-white border rounded-[40px] transition-all group ${removeBrandingEnabled ? "border-green-200 bg-green-50/30" : "border-zinc-100 hover:border-primary"}`}>
            <div className={`w-16 h-16 rounded-[20px] flex items-center justify-center shrink-0 transition-colors ${removeBrandingEnabled ? "bg-green-100" : "bg-zinc-50 group-hover:bg-primary-muted"}`}>
              <Zap className={`w-8 h-8 ${removeBrandingEnabled ? "text-green-600" : "text-primary"}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="text-xl font-black font-display">Remove Branding</h4>
                {removeBrandingEnabled && (
                  <span className="text-[10px] font-black bg-green-100 text-green-600 px-2 py-0.5 rounded-full uppercase tracking-wide border border-green-200">Active</span>
                )}
              </div>
              <p className="text-sm font-bold text-zinc-400 mb-2">
                Hide the "Powered by SiteGist" badge from all your widgets.
              </p>
              {removeBrandingEnabled ? (
                <span className="text-green-600 font-black text-sm">Included in your plan</span>
              ) : (
                <span className="text-primary font-black">+ $39/mo</span>
              )}
            </div>
            {removeBrandingEnabled ? (
              <Check className="w-6 h-6 text-green-500 ml-auto shrink-0" />
            ) : (
              <Form method="post">
                <input type="hidden" name="plan" value={PADDLE_REMOVE_BRANDING_ADDON_ID} />
                <button
                  type="submit"
                  disabled={isSubmitting || !PADDLE_REMOVE_BRANDING_ADDON_ID}
                  className="flex items-center gap-2 px-5 py-3 bg-primary text-white rounded-2xl font-black text-sm hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {isSubmitting && submittingPlanId === PADDLE_REMOVE_BRANDING_ADDON_ID ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Add
                </button>
              </Form>
            )}
          </div>

          <div className="flex items-center gap-6 p-8 bg-white border border-zinc-100 rounded-[40px] hover:border-primary transition-all group">
            <div className="w-16 h-16 bg-zinc-50 rounded-[20px] flex items-center justify-center shrink-0 group-hover:bg-primary-muted transition-colors">
              <MessageSquare className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h4 className="text-xl font-black mb-1 font-display">Extra Messages</h4>
              <p className="text-sm font-bold text-zinc-400 mb-2">Add 10,000 extra messages to your quota.</p>
              <span className="text-primary font-black">+ $19/mo</span>
            </div>
            <Plus className="w-6 h-6 text-zinc-200 ml-auto" />
          </div>

          <div className="flex items-center gap-6 p-8 bg-white border border-zinc-100 rounded-[40px] opacity-80">
            <div className="w-16 h-16 bg-zinc-50 rounded-[20px] flex items-center justify-center shrink-0">
              <Globe className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h4 className="text-xl font-black mb-1 font-display">Custom Domains</h4>
              <p className="text-sm font-bold text-zinc-400 mb-2">
                DNS verify + host routing is available in Bot Settings (free while in beta). Paid add-on checkout coming later.
              </p>
              <span className="text-zinc-500 font-black text-sm">Included in beta</span>
            </div>
          </div>
        </div>
      </div>

      {/* FAQs */}
      <div className="max-w-3xl mx-auto mb-24">
        <h2 className="text-4xl font-black mb-12 text-center font-display text-zinc-900 border-b-4 border-primary/20 pb-4 inline-block mx-auto w-full">Common Questions</h2>
        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <div key={i} className="border-b border-zinc-100">
              <button 
                onClick={() => setActiveFaq(activeFaq === i ? null : i)}
                className="w-full py-6 flex items-center justify-between group"
              >
                <span className="text-lg font-black text-left font-display group-hover:text-primary transition-colors text-zinc-900">{faq.q}</span>
                <ChevronDown className={`w-5 h-5 text-zinc-300 transition-transform duration-300 ${activeFaq === i ? 'rotate-180 text-primary' : ''}`} />
              </button>
              <AnimatePresence>
                {activeFaq === i && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <p className="pb-6 text-zinc-500 font-bold leading-relaxed">{faq.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>

      {/* Final CTA */}
      <div className="text-center p-20 bg-primary rounded-[60px] text-white shadow-2xl shadow-primary/20 relative overflow-hidden group">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.1)_0%,transparent_70%)] animate-pulse" />
        <div className="relative z-10">
          <h2 className="text-5xl font-black mb-6 font-display">Still have questions?</h2>
          <p className="text-xl opacity-80 mb-10 font-bold max-w-lg mx-auto">Our team is ready to help you find the perfect setup for your business needs.</p>
          <button className="px-10 py-5 bg-white text-primary rounded-3xl font-black text-lg hover:scale-105 active:scale-95 transition-all shadow-xl">
            Chat with an Expert
          </button>
        </div>
      </div>
    </div>
  );
}
