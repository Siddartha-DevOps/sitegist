import type { MetaFunction as MetaFn } from "@remix-run/node";
import { pageMeta as makeMeta } from "~/lib/seo";
export const meta: MetaFn = () =>
  makeMeta({
    title: "Pricing",
    description:
      "Simple plans for every stage — a free starter tier, Pro for growing teams, and Enterprise. 7-day free trial, cancel anytime.",
  });
import { useState, useEffect } from "react";
import { Header } from "~/frontend/components/Header";
import { Footer } from "~/frontend/components/Footer";
import { 
  Check, 
  Sparkles, 
  Zap, 
  Info, 
  Shield, 
  HelpCircle, 
  Sun, 
  Moon, 
  CheckCircle2, 
  AlertOctagon, 
  Loader2, 
  X,
  Plus,
  ArrowRight,
  TrendingUp,
  Package,
  Box,
  ChevronDown,
  ChevronUp,
  Quote
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ChatWidget } from "~/frontend/components/ChatWidget";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getUser } from "~/backend/auth.server";
import { openCheckout, resetCheckoutState } from "~/lib/paddle-checkout";
import { PricingCard } from "~/frontend/components/billing/PricingCard";
import { getPaddlePriceCatalog } from "~/lib/paddle-prices";
import { prisma } from "~/database/db.server";

type BillingCycle = "monthly" | "yearly";

interface Toast {
  id: string;
  type: "success" | "error" | "info" | "loading";
  message: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getUser(request);
  const catalog = getPaddlePriceCatalog();

  // Paddle customer id (ctm_…) for Retain — never an internal user id.
  let paddleCustomerId: string | null = null;
  if (user?.id) {
    const sub = await prisma.billingSubscription.findFirst({
      where: { userId: user.id, externalCustomerId: { not: "" } },
      orderBy: { updatedAt: "desc" },
      select: { externalCustomerId: true },
    });
    paddleCustomerId = sub?.externalCustomerId || null;
  }

  return json({
    user,
    paddleCustomerId,
    catalogMissing: catalog.missing,
    PADDLE_CLIENT_TOKEN: catalog.clientToken,
    STARTER_MONTHLY: catalog.starterMonthly,
    PRO_MONTHLY: catalog.proMonthly,
    ENTERPRISE_MONTHLY: catalog.enterpriseMonthly,
    STARTER_YEARLY: catalog.starterYearly,
    PRO_YEARLY: catalog.proYearly,
    ENTERPRISE_YEARLY: catalog.enterpriseYearly,
  });
}

export default function Pricing() {
  const data = useLoaderData<typeof loader>();
  const user = data?.user || null;

  // Pricing State
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("yearly"); // Billed yearly by default for better discount visibility
  const [activeCheckoutId, setActiveCheckoutId] = useState<string | null>(null);
  const [isInsideIframe, setIsInsideIframe] = useState(false);
  
  // Toast Notification Engine Status
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Local helper to queue standard toaster messages
  const triggerToast = (message: string, type: Toast["type"] = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, message }]);
    
    // Auto purge toasts (except loaders)
    if (type !== "loading") {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    }
    return id;
  };

  const removeToast = (id: string) => {
    setToasts((prev) => {
      const toastToRemove = prev.find((t) => t.id === id);
      if (toastToRemove && toastToRemove.type === "loading") {
        setActiveCheckoutId(null);
      }
      return prev.filter((t) => t.id !== id);
    });
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsInsideIframe(window.self !== window.top);
    }
  }, []);

  // Gracefully clean up any hanging checkout loaders when returning to this page/tab
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWindowFocus = () => {
      // Release any static block locks from the utility module
      resetCheckoutState();
      setTimeout(() => {
        setToasts((prev) => {
          const hasLoader = prev.some((t) => t.type === "loading");
          if (hasLoader) {
            setActiveCheckoutId(null);
            return prev.filter((t) => t.type !== "loading");
          }
          return prev;
        });
      }, 1200);
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleWindowFocus);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleWindowFocus);
    };
  }, []);

  // Live is default — no Environment.set("sandbox"). Pass pwCustomer for Retain when known.
  useEffect(() => {
    void import("~/lib/paddle-browser").then(({ initializePaddleBrowser }) => {
      initializePaddleBrowser({
        token: data?.PADDLE_CLIENT_TOKEN || undefined,
        pwCustomer: data?.paddleCustomerId
          ? { id: data.paddleCustomerId }
          : user?.email
            ? { email: user.email }
            : null,
      });
    });
  }, [data?.PADDLE_CLIENT_TOKEN, data?.paddleCustomerId, user?.email]);

  // Launches Paddle Checkout via dynamic setup integration
  const handleLaunchCheckout = async (tierName: string, priceId: string) => {
    if (isInsideIframe) {
      triggerToast(
        "Payment security note: Checkout cannot trigger inside nested preview frame files. Touch 'Open in New Tab' above to escape safe-sandbox blocks safely.",
        "error"
      );
      return;
    }

    if (!priceId) {
      triggerToast("Failed to initialize plan identifier. No Price ID found.", "error");
      return;
    }

    // Set loading indicator
    setActiveCheckoutId(priceId);
    const loadToastId = triggerToast(`Connecting to Paddle checkout for ${tierName} Plan...`, "loading");

    // Safety timeout: if loading takes longer than 5 seconds, clear the loading state
    let hasResolved = false;
    const safetyTimeoutId = setTimeout(() => {
      if (!hasResolved) {
        resetCheckoutState();
        removeToast(loadToastId);
        setActiveCheckoutId((prev) => (prev === priceId ? null : prev));
        triggerToast("Checkout load tip: If checkout opened in a separate tab or window, please complete it there.", "info");
      }
    }, 5000);

    const markResolved = () => {
      hasResolved = true;
      clearTimeout(safetyTimeoutId);
    };

    try {
      await openCheckout({
        priceId,
        customerEmail: user?.email || "",
        theme: "light",
        customData: {
          userId: user?.id || "",
          tier: tierName,
          billingCycle
        },
        onLoaded: () => {
          markResolved();
          removeToast(loadToastId);
          setActiveCheckoutId(null);
          triggerToast(`Secure Paddle Checkout for ${tierName} loaded.`, "success");
        },
        onClosed: () => {
          markResolved();
          removeToast(loadToastId);
          setActiveCheckoutId(null);
          triggerToast("Checkout overlay was closed without transaction details.", "info");
        },
        onCompleted: (payload) => {
          markResolved();
          removeToast(loadToastId);
          setActiveCheckoutId(null);
          triggerToast(`Success! Your subscription checkout for ${tierName} is complete.`, "success");
          console.log("[Checkout Completed Signal]", payload);
        },
        onSuccess: (p) => {
          markResolved();
          removeToast(loadToastId);
          setActiveCheckoutId(null);
          triggerToast("Transaction complete! Your account details have been updated.", "success");
        },
        onFailure: (err) => {
          markResolved();
          resetCheckoutState();
          removeToast(loadToastId);
          setActiveCheckoutId(null);
          triggerToast(`Checkout failed: ${err?.message || "Internal error"}`, "error");
        }
      });
    } catch (e: any) {
      markResolved();
      resetCheckoutState();
      removeToast(loadToastId);
      setActiveCheckoutId(null);
      triggerToast(e?.message || "Failed to trigger Paddle.js overlay checkout.", "error");
    }
  };

  // Plan tiers matched to high fidelity design
  const planTiers = [
    {
      name: "Starter",
      monthlyPrice: 64,
      yearlyPrice: 39,
      yearlyTotal: 468,
      description: "For solo founders and small sites getting started.",
      features: [
        "1 chatbot",
        "Up to 4k messages per month",
        "Up to 1,000 pages",
        "Manual Refresh",
        "1 member"
      ],
      ctaText: "Start a free trial",
      monthlyPriceId: data?.STARTER_MONTHLY,
      yearlyPriceId: data?.STARTER_YEARLY,
      popular: false
    },
    {
      name: "Growth",
      monthlyPrice: 129,
      yearlyPrice: 79,
      yearlyTotal: 948,
      description: "For growing businesses that need automation and collaboration.",
      features: [
        "Up to 2 chatbots",
        "Up to 10k messages per month",
        "Up to 10,000 pages",
        "Manual Refresh",
        "Up to 4 team members",
        "Integrations with multiple platforms",
        "API Access",
        "Rate Limiting",
        "Auto Refresh (Monthly)"
      ],
      ctaText: "Start a free trial",
      monthlyPriceId: data?.PRO_MONTHLY,
      yearlyPriceId: data?.PRO_YEARLY,
      popular: true
    },
    {
      name: "Scale",
      monthlyPrice: 425,
      yearlyPrice: 259,
      yearlyTotal: 3108,
      description: "For teams that need more chatbots, members, and automation.",
      features: [
        "Up to 3 chatbots",
        "Up to 40k messages per month",
        "Up to 50,000 pages",
        "Manual Refresh",
        "Up to 10 team members",
        "Integrations with multiple platforms",
        "API Access",
        "Rate Limiting",
        "Auto Refresh (Weekly)",
        "Auto Scan (Daily)",
        "Webhook Support"
      ],
      ctaText: "Start a free trial",
      monthlyPriceId: data?.ENTERPRISE_MONTHLY,
      yearlyPriceId: data?.ENTERPRISE_YEARLY,
      popular: false
    },
    {
      name: "Enterprise",
      monthlyPrice: "Custom",
      yearlyPrice: "Custom",
      yearlyTotal: null,
      description: "Custom volume, limits, and compliance. Priced based on your needs.",
      features: [
        "Up to 10,000 chatbots",
        "Customizable message volume",
        "Up to 500,000 pages",
        "Manual Refresh",
        "Up to 10,000 team members",
        "Integrations with multiple platforms",
        "API Access",
        "Rate Limiting",
        "Auto Refresh (Daily)",
        "Webhook Support",
        "Priority Support",
        "Custom Integrations",
        "Security review on request",
        "Signed DPA on request",
        "BAA discussion for Enterprise deals"
      ],
      ctaText: "Contact us",
      monthlyPriceId: "",
      yearlyPriceId: "",
      popular: false
    }
  ];

  // Pricing calculator values and state
  const [calcPlan, setCalcPlan] = useState<"Starter" | "Growth" | "Scale" | "Enterprise">("Growth");
  const [calcCycle, setCalcCycle] = useState<"Monthly" | "Yearly">("Yearly");
  const [sliderSplit, setSliderSplit] = useState<number>(50); // percentage for GPT-4.1. Remainder is for mini.

  const planCalculatorData = {
    Starter: {
      tagline: "For solo founders and small sites getting started.",
      monthlyBasePrice: 64,
      yearlyBasePrice: 39,
      yearlyAnnualTotal: 468,
      maxGpt4Pool: 400,
      maxGpt4MiniPool: 4000,
      chatbots: 1,
      pages: 1000,
      members: 1,
      whatIsIncluded: [
        "Up to 1 chatbot",
        "Up to 1,000 pages",
        "Manual Refresh",
        "1 team member",
        "Standard Chat Widget widget"
      ]
    },
    Growth: {
      tagline: "For growing businesses that need automation and collaboration.",
      monthlyBasePrice: 129,
      yearlyBasePrice: 79,
      yearlyAnnualTotal: 948,
      maxGpt4Pool: 1000,
      maxGpt4MiniPool: 10000,
      chatbots: 2,
      pages: 10000,
      members: 4,
      whatIsIncluded: [
        "Up to 2 chatbots",
        "Up to 10,000 pages",
        "Manual Refresh",
        "Up to 4 team members",
        "Integrations with multiple platforms",
        "API Access",
        "Rate Limiting",
        "Auto Refresh (Monthly)"
      ]
    },
    Scale: {
      tagline: "For teams that need more chatbots, members, and automation.",
      monthlyBasePrice: 425,
      yearlyBasePrice: 259,
      yearlyAnnualTotal: 3108,
      maxGpt4Pool: 4000,
      maxGpt4MiniPool: 40000,
      chatbots: 3,
      pages: 50000,
      members: 10,
      whatIsIncluded: [
        "Up to 3 chatbots",
        "Up to 50,000 pages",
        "Manual Refresh",
        "Up to 10 team members",
        "Integrations with multiple platforms",
        "API Access",
        "Rate Limiting",
        "Auto Refresh (Weekly)",
        "Webhook Support"
      ]
    },
    Enterprise: {
      tagline: "Custom volume, limits, and compliance. Priced based on your needs.",
      monthlyBasePrice: "Custom",
      yearlyBasePrice: "Custom",
      yearlyAnnualTotal: null,
      maxGpt4Pool: "Custom",
      maxGpt4MiniPool: "Custom",
      chatbots: "10,000",
      pages: 500000,
      members: "10,000",
      whatIsIncluded: [
        "Up to 10,000 chatbots",
        "Up to 500,000 pages",
        "Manual Refresh",
        "Up to 10,000 team members",
        "Integrations with multiple platforms",
        "API Access",
        "Rate Limiting",
        "Auto Refresh (Daily)"
      ]
    }
  };

  // Dynamically calculate messages based on slider split
  const isEnterprise = calcPlan === "Enterprise";
  const planSet = planCalculatorData[calcPlan];
  
  const gpt4Percent = sliderSplit;
  const gpt4MiniPercent = 100 - sliderSplit;

  const gpt4Messages = isEnterprise 
    ? "Custom" 
    : Math.round(((planSet.maxGpt4Pool as number) * gpt4Percent) / 100);

  const gpt4MiniMessages = isEnterprise 
    ? "Custom" 
    : Math.round(((planSet.maxGpt4MiniPool as number) * gpt4MiniPercent) / 100);

  const totalMessages = isEnterprise 
    ? "Custom" 
    : (gpt4Messages as number) + (gpt4MiniMessages as number);

  // FAQ Tab and accordion state
  const [activeFaqTab, setActiveFaqTab] = useState<string>("Chatbot Training and Support");
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

  const faqCategories = [
    "Chatbot Training and Support",
    "Pricing",
    "Technology and Integrations",
    "Security and Compliance"
  ];

  const faqDataMap: Record<string, Array<{ q: string; a: React.ReactNode }>> = {
    "Chatbot Training and Support": [
      {
        q: "How do I train my chatbot?",
        a: "You can train the chatbot by adding a website link, a sitemap link, YouTube videos/playlists/channels, a Zendesk Help Center Link, a Gitbook link. You can just enter a URL and the chatbot will be trained on all the content present on that URL. You can also upload CSV/TXT/PDF/DOCX/PPTX/MD or any other text based files to train the chatbots."
      },
      {
        q: "What type of content can I use to train the chatbot?",
        a: "You can use any type of content to train the chatbot. The more content you provide, the better the chatbot will be able to answer the questions."
      },
      {
        q: "Can I enter raw text content as training data?",
        a: "Yes, you're able to enter raw text content as training data."
      },
      {
        q: "Can I upload documents (PDF, CSV, etc.) to train the chatbot?",
        a: "Yes. You can upload CSV/TXT/PDF/DOCX/PPTX/MD or any other text based files to train the chatbot. Each file is converted to pages based on its content (2,500 cleaned characters = 1 page). The page limits vary based on your plan."
      },
      {
        q: "What if my document format is not supported?",
        a: (
          <span>
            Please contact us on{" "}
            <a 
              href="mailto:support@sitegist.co" 
              className="text-blue-600 font-extrabold hover:underline drop-shadow-[0_0_10px_rgba(37,99,235,0.25)] transition-all cursor-pointer"
            >
              support@sitegist.co
            </a>
            . We can figure out a way for you to upload those files.
          </span>
        )
      },
      {
        q: "How long does it take to train the chatbot?",
        a: "It depends on the amount of content you are training. But usually, it should be done within a few minutes."
      }
    ],
    "Pricing": [
      {
        q: "Can I try a demo before signing up?",
        a: "Yes — open the live demo on the homepage (sitegist.co/#demo) and chat with the SiteGist assistant. For a full RAG experience trained on your own content, start a 7-day free trial and create a chatbot from your URL."
      },
      {
        q: "Are there customized enterprise tiers available?",
        a: (
          <span>
            Yes, please contact us by sending us an email at{" "}
            <a 
              href="mailto:support@sitegist.co" 
              className="text-blue-600 font-extrabold hover:underline drop-shadow-[0_0_10px_rgba(37,99,235,0.25)] transition-all cursor-pointer"
            >
              support@sitegist.co
            </a>{" "}
            for more information.
          </span>
        )
      }
    ],
    "Technology and Integrations": [
      {
        q: "Does the chatbot update automatically when my website changes?",
        a: "Yes! SiteGist now supports automatic syncing of your content. Depending on your plan, you can set up automatic syncing on a monthly, weekly, or daily basis to keep your chatbot's knowledge up to date. You can also manually retrain/resync your chatbot anytime from the dashboard."
      },
      {
        q: "How do I embed the chatbot on my website?",
        a: "Each chatbot gets its own unique url, you can embed the chatbot on your own site via the embed code we provide. You can even directly link to the chatbot from your site."
      }
    ],
    "Security and Compliance": [
      {
        q: "Is my data secure with SiteGIST?",
        a: (
          <span>
            Yes. We encrypt data in transit and at rest and isolate customer knowledge bases. SOC 2 Type II is in progress. If you need a security questionnaire, DPA, or to discuss HIPAA/BAA for an Enterprise deal, please reach out via{" "}
            <a 
              href="mailto:support@sitegist.co" 
              className="text-blue-600 font-extrabold hover:underline drop-shadow-[0_0_10px_rgba(37,99,235,0.25)] transition-all cursor-pointer"
            >
              support@sitegist.co
            </a>{" "}
            to arrange setups.
          </span>
        )
      }
    ]
  };

  const currentFaqList = faqDataMap[activeFaqTab] || [];

  return (
    <div className="min-h-screen bg-slate-50 text-neutral-900 selection:bg-blue-100 selection:text-blue-900">

      <main className="relative pt-28 pb-24 px-4 sm:px-6 max-w-7xl mx-auto overflow-hidden">
        
        {/* Iframe warning block */}
        {isInsideIframe && (
          <motion.div
            layout
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 inline-flex flex-col sm:flex-row items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 max-w-3xl mx-auto text-left"
          >
            <Info className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="text-xs font-semibold text-amber-800">
              <strong>Attention:</strong> Nesting inside AI Studio iframe prevents secure Paddle checkout popups. Please click 
              <a
                href="/pricing"
                target="_blank"
                rel="noreferrer"
                className="mx-1 px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] uppercase tracking-wide inline-block"
              >
                Open in New Tab
              </a>
              to test dynamic payments safely in full-window overlay.
            </div>
          </motion.div>
        )}

        {/* Hero Section */}
        <section className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold tracking-wider bg-blue-50 text-blue-600 border border-blue-100 uppercase mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            Pricing plans
          </div>
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight mb-4 text-neutral-950">
            Pays for itself in saved support time
          </h1>
          <p className="text-neutral-500 font-medium text-sm sm:text-base max-w-2xl mx-auto">
            Whether you're just getting started or are a large enterprise, we have a plan for you.
          </p>

          {/* Trusted by these leading companies Logos Row */}
          <div className="mt-8 pt-6 border-t border-blue-100/60 max-w-2xl mx-auto">
            <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest text-center mb-5">
              Trusted by these leading companies
            </p>
            <div className="flex flex-wrap justify-center items-center gap-x-8 gap-y-4 opacity-75">
              <div className="flex items-center gap-1 font-extrabold text-neutral-800 text-sm tracking-tight">
                <span className="w-2 h-2 bg-blue-600 rounded-full shrink-0" />
                Growth<span className="text-blue-600">X</span>
              </div>
              <div className="flex items-center gap-1 text-neutral-800 font-extrabold text-xs tracking-widest uppercase">
                ✦ Scope
              </div>
              <div className="flex items-center gap-1 font-black text-neutral-800 text-xs uppercase italic tracking-wider">
                Valant
              </div>
              <div className="flex items-center gap-1 text-neutral-800 text-xs font-bold font-sans">
                🟢 Savory Institute
              </div>
              <div className="flex items-center gap-1 text-neutral-800 font-extrabold text-xs tracking-tight">
                ⚡︎ Sagacity
              </div>
            </div>
          </div>

          {/* Premium Switch Toggle */}
          <div className="flex items-center justify-center gap-3 sm:gap-4 py-10">
            <span className={`text-xs sm:text-sm font-black uppercase tracking-wider transition-colors duration-200 ${billingCycle === "monthly" ? "text-neutral-900" : "text-neutral-400"}`}>
              Pay Monthly
            </span>
            <button
              id="cycle-toggle-switch"
              type="button"
              onClick={() => setBillingCycle(billingCycle === "monthly" ? "yearly" : "monthly")}
              className={`w-11 h-6 flex items-center rounded-full p-1 cursor-pointer transition-colors duration-200 ${billingCycle === "yearly" ? "bg-emerald-500" : "bg-neutral-300"}`}
              aria-label="Toggle Billing Cycle"
            >
              <div
                className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${billingCycle === "yearly" ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
            <div className="flex items-center gap-1.5 sm:gap-2 relative">
              <span className={`text-xs sm:text-sm font-black uppercase tracking-wider transition-colors duration-200 ${billingCycle === "yearly" ? "text-neutral-900" : "text-neutral-400"}`}>
                Pay Yearly
              </span>
              
              {/* Hand drawn blue arrow curved wrapper */}
              <div className="absolute left-full ml-1 sm:ml-2.5 top-[-10px] flex items-center gap-1 shrink-0 whitespace-nowrap pointer-events-none">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600" viewBox="0 0 50 30" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 25 C 10 15, 25 5, 42 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                  <path d="M34 14 L 42 12 L 39 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                </svg>
                <span className="text-blue-600 font-extrabold italic text-xs leading-none">Save 40%</span>
              </div>
            </div>
          </div>
        </section>

        {/* Dynamic Horizontal Plan Cards List */}
        <section className="flex flex-col gap-6 mt-2 max-w-5xl mx-auto w-full relative z-10">
          {planTiers.map((tier) => {
            const currentPrice = billingCycle === "monthly" ? tier.monthlyPrice : tier.yearlyPrice;
            const targetPriceId = billingCycle === "monthly" ? tier.monthlyPriceId : tier.yearlyPriceId;
            const isLoadingThis = activeCheckoutId === targetPriceId;
            const isAnyLoading = activeCheckoutId !== null;

            return (
              <PricingCard
                key={tier.name}
                name={tier.name}
                price={currentPrice}
                yearlyTotal={tier.yearlyTotal}
                billingCycle={billingCycle}
                description={tier.description}
                features={tier.features}
                ctaText={tier.ctaText}
                popular={tier.popular}
                isLoading={isLoadingThis}
                isDisabled={isAnyLoading && !isLoadingThis}
                onSelect={() => handleLaunchCheckout(tier.name, targetPriceId || "")}
              />
            );
          })}
        </section>

        {/* Taxes Disclaimer Under Horizontal Cards */}
        <div className="text-center text-xs text-neutral-500 mt-6 font-medium">
          Pricing is exclusive of taxes and additional local tax may be collected depending on your region.
        </div>

        {/* Add-ons Section */}
        <section className="mt-20 max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-black text-neutral-900 tracking-tight">Add-ons</h2>
            <p className="text-xs text-neutral-500 font-medium mt-1">Enhance your chatbot experience with targeted upgrades</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Addon 1 */}
            <div className="bg-white border-2 border-blue-400/50 rounded-2xl p-5 shadow-[0_0_20px_rgba(37,99,235,0.08)] hover:border-blue-500 hover:shadow-[0_0_30px_rgba(37,99,235,0.18)] transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[9px] font-bold uppercase tracking-wider mb-2">Upgrade Option</span>
                <h4 className="font-extrabold text-neutral-900 text-base">Remove SiteGist Branding (Addon)</h4>
                <p className="text-xs text-neutral-500 mt-1 leading-relaxed">Remove the white label watermarks and SiteGist logos from your chatbot widgets.</p>
                <div className="text-[10px] text-neutral-400 font-bold mt-2.5">billed $468 yearly</div>
              </div>
              <div className="text-right shrink-0 flex flex-row sm:flex-col items-baseline justify-between sm:justify-center border-t sm:border-t-0 border-neutral-100 pt-3 sm:pt-0">
                <span className="text-3xl font-black text-neutral-950">+$39</span>
                <span className="text-neutral-500 text-xs font-semibold sm:mt-1">/mo</span>
              </div>
            </div>

            {/* Addon 2 */}
            <div className="bg-white border-2 border-blue-400/50 rounded-2xl p-5 shadow-[0_0_20px_rgba(37,99,235,0.08)] hover:border-blue-500 hover:shadow-[0_0_30px_rgba(37,99,235,0.18)] transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[9px] font-bold uppercase tracking-wider mb-2">Upgrade Option</span>
                <h4 className="font-extrabold text-neutral-900 text-base">Extra 5k Messages (Addon)</h4>
                <p className="text-xs text-neutral-500 mt-1 leading-relaxed">Get 5,000 extra priority response message credits assigned per billing period.</p>
                <div className="text-[10px] text-neutral-400 font-bold mt-2.5">billed $468 yearly</div>
              </div>
              <div className="text-right shrink-0 flex flex-row sm:flex-col items-baseline justify-between sm:justify-center border-t sm:border-t-0 border-neutral-100 pt-3 sm:pt-0">
                <span className="text-3xl font-black text-neutral-950">+$39</span>
                <span className="text-neutral-500 text-xs font-semibold sm:mt-1">/mo</span>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing Calculator Section */}
        <section className="mt-24 max-w-5xl mx-auto border border-blue-100 rounded-3xl p-6 sm:p-10 bg-slate-50/45 shadow-[0_0_20px_rgba(37,99,235,0.02)]">
          <div className="mb-10 text-center md:text-left">
            <h2 className="text-3xl font-black tracking-tight text-neutral-950">Pricing Calculator</h2>
            <h3 className="text-lg font-extrabold text-neutral-800 mt-1">How many messages do you actually get?</h3>
            <p className="text-xs sm:text-sm text-neutral-500 mt-2.5 max-w-3xl leading-relaxed">
              It depends on which model you pick. GPT-4.1-mini is 10× cheaper than GPT-4.1, so your real message count can vary by 10× on the same plan. Pick yours below.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* Left Side: Interactivity Inputs (Col-7) */}
            <div className="lg:col-span-7 space-y-8">
              
              {/* Option 1: Pick a plan */}
              <div>
                <h4 className="text-xs font-black tracking-widest uppercase text-neutral-400 mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold">1</span>
                  Pick a plan
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {(["Starter", "Growth", "Scale", "Enterprise"] as const).map((plan) => {
                    const priceLabel = plan === "Enterprise" 
                      ? "Custom" 
                      : `$${calcCycle === "Monthly" ? planCalculatorData[plan].monthlyBasePrice : planCalculatorData[plan].yearlyBasePrice}/mo`;
                    return (
                      <button
                        key={plan}
                        type="button"
                        onClick={() => setCalcPlan(plan)}
                        className={`text-left p-4 rounded-xl border transition-all duration-200 bg-white cursor-pointer ${
                          calcPlan === plan 
                            ? "border-blue-500 ring-2 ring-blue-500/10 shadow-xs" 
                            : "border-neutral-200 hover:border-neutral-300 shadow-[0_1px_3px_rgba(0,0,0,0.02)]"
                        }`}
                      >
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-extrabold text-sm text-neutral-950">{plan}</span>
                          <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md">{priceLabel}</span>
                        </div>
                        <p className="text-[11px] text-neutral-400 font-medium leading-normal line-clamp-2">
                          {planCalculatorData[plan].tagline}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Option 2: Choose billing cycle */}
              <div>
                <h4 className="text-xs font-black tracking-widest uppercase text-neutral-400 mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold">2</span>
                  Choose billing cycle
                </h4>
                <div className="flex bg-white p-1 rounded-xl border border-neutral-200/80 max-w-sm">
                  <button
                    type="button"
                    onClick={() => setCalcCycle("Monthly")}
                    className={`flex-1 py-2 text-center text-xs font-extrabold rounded-lg tracking-wide transition-all cursor-pointer ${
                      calcCycle === "Monthly" 
                        ? "bg-neutral-950 text-white shadow-xs" 
                        : "text-neutral-500 hover:text-neutral-900"
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalcCycle("Yearly")}
                    className={`flex-1 py-2 text-center text-xs font-extrabold rounded-lg tracking-wide transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                      calcCycle === "Yearly" 
                        ? "bg-neutral-950 text-white shadow-xs" 
                        : "text-neutral-500 hover:text-neutral-900"
                    }`}
                  >
                    <span>Yearly</span>
                    <span className="bg-emerald-50 text-emerald-700 hover:text-emerald-800 border border-emerald-100 text-[9px] font-bold px-1.5 py-0.5 rounded">
                      Save 39% yearly
                    </span>
                  </button>
                </div>
              </div>

              {/* Option 3: Split your quota */}
              <div>
                <h4 className="text-xs font-black tracking-widest uppercase text-neutral-400 mb-2 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold">3</span>
                  Split your quota between models
                </h4>
                <p className="text-[11px] text-neutral-500 leading-relaxed mb-5">
                  GPT-4.1-mini is ~10× cheaper per message, so the same plan gets you many more messages when you lean on mini. Drag the slider to allocate your quota.
                </p>

                {/* Slider and markers */}
                <div className="bg-white p-5 rounded-xl border-2 border-blue-400/55 space-y-5 shadow-[0_0_25px_rgba(37,99,235,0.08)]">
                  <div className="flex justify-between items-center text-xs font-bold text-neutral-700">
                    <span>GPT-4.1</span>
                    <span>GPT-4.1-mini</span>
                  </div>

                  <div className="relative">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      disabled={isEnterprise}
                      value={isEnterprise ? 50 : sliderSplit}
                      onChange={(e) => setSliderSplit(Number(e.target.value))}
                      className="w-full h-2.5 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-blue-600 border border-neutral-200"
                    />
                  </div>

                  <div className="flex justify-between text-xs font-black text-blue-600 uppercase tracking-wide">
                    <span>{isEnterprise ? "Custom" : `${gpt4Percent}% GPT-4.1`}</span>
                    <span>{isEnterprise ? "Custom" : `${gpt4MiniPercent}% GPT-4.1-mini`}</span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center pt-2 border-t border-neutral-100">
                    <div>
                      <div className="text-lg sm:text-xl font-black text-neutral-950">
                        {isEnterprise ? "Custom" : (gpt4Messages as number).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider">GPT-4.1 messages</div>
                    </div>
                    <div>
                      <div className="text-lg sm:text-xl font-black text-neutral-950">
                        {isEnterprise ? "Custom" : (gpt4MiniMessages as number).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider">GPT-4.1-mini messages</div>
                    </div>
                    <div>
                      <div className="text-lg sm:text-xl font-black text-neutral-950 border-l border-neutral-100 pl-2">
                        {isEnterprise ? "Custom" : (totalMessages as number).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider pl-2">Total / month</div>
                    </div>
                  </div>
                </div>

                <p className="text-[10px] text-neutral-400 mt-2.5 italic">
                  Don't worry about getting this exactly right — you can change the split anytime from your billing settings.
                </p>
                <p className="text-[10px] text-neutral-400 mt-1 italic">
                  Each “message” counts both the user's question and the AI's reply.
                </p>
              </div>

            </div>

            {/* Right Side: Plan Summary Card (Col-5) */}
            <div className="lg:col-span-5">
              <div className="bg-white border-2 border-blue-600 rounded-2xl p-6 sm:p-7 shadow-[0_0_40px_rgba(37,99,235,0.22)] ring-4 ring-blue-500/10 space-y-6 relative overflow-hidden">
                
                {/* Plan header */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-3xl font-black text-neutral-950 tracking-tight">{calcPlan}</span>
                    <span className="px-2.5 py-0.5 bg-blue-600 text-white rounded-md text-[10px] font-black uppercase tracking-wider shadow-sm">
                      {calcCycle}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-500 font-bold leading-relaxed">
                    {planSet.tagline}
                  </p>
                </div>

                {/* Big Price tag */}
                <div className="py-4 border-y border-neutral-100">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-5xl font-black text-neutral-950 tracking-tight">
                      {isEnterprise ? "Custom" : (calcCycle === "Yearly" ? `$${planSet.yearlyAnnualTotal}` : `$${(typeof planSet.monthlyBasePrice === 'number' ? planSet.monthlyBasePrice : 0) * 12}`)}
                    </span>
                    <span className="text-neutral-500 font-bold text-sm">
                      {isEnterprise ? "" : (calcCycle === "Yearly" ? "/yr" : "/mo")}
                    </span>
                  </div>
                  {!isEnterprise && (
                    <p className="text-xs text-neutral-500 mt-1.5 font-semibold">
                      Equivalent to <span className="font-extrabold">${calcCycle === "Yearly" ? planSet.yearlyBasePrice : planSet.monthlyBasePrice}/mo</span> billed {calcCycle.toLowerCase()} — save 39%
                    </p>
                  )}
                </div>

                {/* Message split quota list */}
                <div>
                  <h5 className="text-xs font-black uppercase tracking-wider text-neutral-400 mb-2.5">Message Quota</h5>
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-neutral-500 font-medium">GPT-4.1 messages</span>
                      <span className="font-extrabold text-neutral-900">
                        {isEnterprise ? "Custom" : (gpt4Messages as number).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-neutral-500 font-medium">GPT-4.1-mini messages</span>
                      <span className="font-extrabold text-neutral-900">
                        {isEnterprise ? "Custom" : (gpt4MiniMessages as number).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-sm pt-2 border-t border-dashed border-neutral-100">
                      <span className="text-neutral-950 font-bold">Total per month</span>
                      <span className="font-black text-blue-600 text-base">
                        {isEnterprise ? "Custom" : (totalMessages as number).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Plan limits */}
                <div>
                  <h5 className="text-xs font-black uppercase tracking-wider text-neutral-400 mb-2.5">Plan Limits</h5>
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-neutral-500 font-medium">Chatbots</span>
                      <span className="font-extrabold text-neutral-950">{planSet.chatbots}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-neutral-500 font-medium">Pages</span>
                      <span className="font-extrabold text-neutral-950">{isEnterprise ? "Custom" : (planSet.pages as number).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-neutral-500 font-medium">Team members</span>
                      <span className="font-extrabold text-neutral-950">{planSet.members}</span>
                    </div>
                  </div>
                </div>

                {/* What's included checklist */}
                <div className="pt-2 border-t border-neutral-100">
                  <h5 className="text-xs font-black uppercase tracking-wider text-neutral-400 mb-2.5">What's included</h5>
                  <div className="space-y-2.5">
                    {planSet.whatIsIncluded.map((bullet, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-sm">
                        <Check className="w-4 h-4 text-blue-600 stroke-[3.5] shrink-0" />
                        <span className="text-neutral-800 font-semibold leading-normal">{bullet}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* CTA Action button linked to Paddle */}
                <div className="pt-4 border-t border-neutral-100">
                  <div className="flex justify-between text-sm font-bold text-neutral-400 mb-2">
                    <span>Trial price:</span>
                    <span className="text-neutral-950 font-black">
                      {isEnterprise ? "Custom" : (calcCycle === "Yearly" ? `$${planSet.yearlyAnnualTotal}/yr` : `$${planSet.monthlyBasePrice}/mo`)}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (isEnterprise) {
                        window.location.href = "mailto:support@sitegist.co";
                      } else {
                        const targetId = calcCycle === "Yearly" 
                          ? planTiers.find((t) => t.name === calcPlan)?.yearlyPriceId 
                          : planTiers.find((t) => t.name === calcPlan)?.monthlyPriceId;
                        handleLaunchCheckout(calcPlan, targetId || "");
                      }
                    }}
                    className="w-full py-3 px-4 rounded-xl font-black text-sm text-center transition-all bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-600/10 active:scale-[0.98]"
                  >
                    {isEnterprise ? "Contact us" : `Start free trial on ${calcPlan}`}
                  </button>

                  <p className="text-[10px] text-neutral-400 text-center mt-3 leading-normal">
                    Need more messages, webhook support, or to remove the watermark? Add any of those from your billing page once your trial starts.
                  </p>
                </div>

              </div>
            </div>

          </div>
        </section>

        {/* Customer Testimonials Section */}
        <section className="mt-24 max-w-4xl mx-auto text-center">
          <span className="text-xs font-black uppercase text-neutral-400 tracking-wider">Customer Testimonials</span>
          <h2 className="text-3xl font-black tracking-tight text-neutral-950 mt-2">Wait and see what customers will say</h2>
          
          <div className="mt-8 p-8 border border-neutral-200 bg-slate-50/50 rounded-2xl relative">
            <Quote className="w-8 h-8 text-blue-600/20 absolute top-5 left-5" />
            <p className="text-base sm:text-lg font-medium italic text-neutral-800 leading-relaxed max-w-3xl mx-auto">
              “We've got the bot dialled in - we're using GPT-4, have an avenue for escalations to Zendesk, and so far I have no complaints.”
            </p>
            <div className="mt-5">
              <h4 className="font-extrabold text-neutral-950 text-base"> founder name</h4>
              <p className="text-xs text-neutral-500 font-semibold mt-0.5">Vice President – Role name at company name</p>
            </div>
          </div>
        </section>

        {/* FAQ Section with Tabs & Accordion layout */}
        <section className="mt-24 max-w-4xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-black tracking-tight text-neutral-950">FAQs</h2>
            <p className="text-xs sm:text-sm text-neutral-500 font-medium mt-2 max-w-2xl mx-auto leading-relaxed">
              Have a different question and can't find the answer you're looking for? Reach out to our support team by sending us an email at{" "}
              <a 
                href="mailto:support@sitegist.co" 
                className="text-blue-600 font-extrabold hover:underline drop-shadow-[0_0_12px_rgba(21,93,238,0.4)] animate-pulse inline-block cursor-pointer"
              >
                support@sitegist.co
              </a>{" "}
              and we'll get back to you as soon as we can.
            </p>
          </div>

          {/* Horizontal category tabs */}
          <div className="flex flex-wrap justify-center gap-2 mb-8 pb-3 border-b border-neutral-100">
            {faqCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setActiveFaqTab(cat);
                  setOpenFaqIndex(null);
                }}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  activeFaqTab === cat 
                    ? "bg-slate-900 text-white shadow-xs" 
                    : "text-neutral-500 hover:text-neutral-800 hover:bg-neutral-50"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Interactive accordion for selected Category */}
          <div className="space-y-4">
            {currentFaqList.map((faq, idx) => {
              const isOpen = openFaqIndex === idx;
              return (
                <div 
                  key={idx} 
                  className="border border-neutral-200 rounded-xl overflow-hidden bg-white hover:border-neutral-300 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                    className="w-full p-4 text-left flex justify-between items-center gap-4 cursor-pointer font-bold select-none"
                  >
                    <span className="text-xs sm:text-sm text-neutral-900 font-extrabold">{faq.q}</span>
                    {isOpen ? (
                      <ChevronUp className="w-4 h-4 text-neutral-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-neutral-500 shrink-0" />
                    )}
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: "auto" }}
                        exit={{ height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="p-4 pt-0 text-xs sm:text-sm text-neutral-600 leading-relaxed font-semibold border-t border-neutral-50">
                          {faq.a}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </section>

      </main>

      <Footer />
      <ChatWidget />

      {/* Local interactive toast center */}
      <div
        id="toasts-portal"
        className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none"
      >
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 30, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              className="pointer-events-auto flex items-start gap-3 p-4 bg-white border border-neutral-200 rounded-2xl shadow-xl border-l-[4px] border-l-blue-600 w-full"
            >
              {toast.type === "success" && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
              )}
              {toast.type === "error" && (
                <AlertOctagon className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              )}
              {toast.type === "loading" && (
                <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0 mt-0.5" />
              )}
              {toast.type === "info" && (
                <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              )}

              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold tracking-tight text-neutral-400 uppercase mb-0.5">
                  Notification
                </p>
                <p className="text-xs font-semibold leading-relaxed text-neutral-700">
                  {toast.message}
                </p>
              </div>

              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="text-neutral-400 hover:text-neutral-600 transition-colors shrink-0 mt-0.5 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
