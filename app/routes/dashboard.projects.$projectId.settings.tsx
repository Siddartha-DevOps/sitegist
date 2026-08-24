import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form, useNavigation, useActionData, Link, useFetcher, useRevalidator } from "@remix-run/react";
import { prisma } from "~/database/db.server";
import { hasRemoveBrandingAccess } from "~/lib/plans";
import { recordAudit } from "~/lib/audit.server";
import { requireProjectAccess } from "~/lib/project-access.server";
import { mergeProjectSettings } from "~/lib/settings-merge";
import {
  normalizeCustomDomainInput,
  verifyCustomDomainDns,
  getCustomDomainCnameTarget,
  findProjectByVerifiedCustomDomain,
} from "~/lib/custom-domain.server";
import { Save, Settings, Loader2, ChevronLeft, Palette, MessageSquare, Bot, Zap, Users, Check, Trash2, Lock, Globe, AlertCircle, RefreshCw, Megaphone, Clock } from "lucide-react";
import { useEffect, useState } from "react";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
] as const;

const WEEKDAY_LABELS: { value: number; label: string }[] = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

const PERSONAS = [
  {
    id: "friendly-support",
    label: "Friendly Support Agent",
    description: "Warm, helpful, solution-focused",
    prompt: "You are a friendly and empathetic customer support agent. You speak in a warm, conversational tone and always aim to solve the user's problem. Use simple language, be patient, and reassure the user when they're frustrated. End every response with an offer to help further.",
  },
  {
    id: "formal-enterprise",
    label: "Formal Enterprise Assistant",
    description: "Professional, precise, corporate tone",
    prompt: "You are a professional enterprise assistant. Maintain a formal, business-appropriate tone at all times. Provide precise, well-structured answers. Avoid casual language or contractions. Prioritise accuracy and completeness in every response.",
  },
  {
    id: "casual-startup",
    label: "Casual Startup Helper",
    description: "Relaxed, direct, uses everyday language",
    prompt: "You are a casual, helpful assistant for a fast-moving startup. Keep things short and direct. Use everyday language, feel free to use contractions, and don't over-explain. If something's unclear, just ask.",
  },
  {
    id: "sales-focused",
    label: "Sales-Focused Agent",
    description: "Highlights value, encourages next step",
    prompt: "You are a knowledgeable sales assistant. Help visitors understand the product's benefits and guide them toward a decision. Highlight value over features. When appropriate, suggest a demo, free trial, or speaking with the sales team. Be enthusiastic but never pushy.",
  },
  {
    id: "technical-docs",
    label: "Technical Documentation Bot",
    description: "Precise, detailed, developer-friendly",
    prompt: "You are a technical assistant for developers. Provide precise, detailed answers. Use correct terminology. Include code examples when relevant. Be direct and skip pleasantries — developers want answers, not small talk.",
  },
] as const;

// Industry lead-capture templates. Each prefills the project's custom lead
// fields with sensible questions for that vertical; the visitor-facing widget
// already renders whatever custom fields are configured, so these need no
// widget changes. `id` is assigned at apply-time to keep field ids unique.
const LEAD_TEMPLATES: { id: string; label: string; description: string; fields: Omit<LeadField, "id">[] }[] = [
  {
    id: "real-estate",
    label: "Real Estate",
    description: "Budget, property type, buying timeline",
    fields: [
      { label: "Budget", type: "dropdown", required: true, options: ["Under $250k", "$250k–$500k", "$500k–$1M", "$1M+"] },
      { label: "Property Type", type: "dropdown", required: false, options: ["Single-family home", "Condo / Apartment", "Townhouse", "Land", "Commercial"] },
      { label: "Buying Timeline", type: "dropdown", required: false, options: ["Immediately", "1–3 months", "3–6 months", "Just browsing"] },
      { label: "Preferred Location", type: "text", required: false },
      { label: "Pre-approved for financing", type: "checkbox", required: false },
    ],
  },
  {
    id: "legal",
    label: "Legal Services",
    description: "Case type, urgency, best contact time",
    fields: [
      { label: "Type of Legal Matter", type: "dropdown", required: true, options: ["Personal Injury", "Family Law", "Criminal Defense", "Business / Corporate", "Estate Planning", "Other"] },
      { label: "Urgency", type: "dropdown", required: false, options: ["Emergency", "Within a week", "Within a month", "Just exploring"] },
      { label: "Best Time to Contact", type: "dropdown", required: false, options: ["Morning", "Afternoon", "Evening"] },
      { label: "Brief Description", type: "text", required: false },
    ],
  },
  {
    id: "saas",
    label: "SaaS / B2B",
    description: "Company size, role, use case",
    fields: [
      { label: "Company Size", type: "dropdown", required: false, options: ["1–10", "11–50", "51–200", "201–1000", "1000+"] },
      { label: "Your Role", type: "text", required: false },
      { label: "Primary Use Case", type: "text", required: false },
      { label: "Requesting a demo", type: "checkbox", required: false },
    ],
  },
];

export async function loader({ params, request }: LoaderFunctionArgs) {
  const access = await requireProjectAccess(request, params.projectId);
  const [user, addons] = await Promise.all([
    prisma.user.findUnique({ where: { id: access.userId }, select: { subscriptionTier: true } }),
    prisma.userAddon.findMany({ where: { userId: access.userId, status: "active" }, select: { type: true, status: true } }),
  ]);
  const canRemoveBranding = hasRemoveBrandingAccess(user?.subscriptionTier, addons);
  const cnameTarget = getCustomDomainCnameTarget();
  return json({ project: access.project, canRemoveBranding, cnameTarget });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  if (actionType === "delete_project") {
    const access = await requireProjectAccess(request, params.projectId, { minRole: "OWNER" });
    try {
      // Clear all child associations to prevent constraint issues on both real and fallback DBs
      await prisma.unansweredQuestion.deleteMany({ where: { projectId: params.projectId } });
      await prisma.knowledgeSource.deleteMany({ where: { projectId: params.projectId } });
      await prisma.knowledgeQA.deleteMany({ where: { projectId: params.projectId } });
      await prisma.integration.deleteMany({ where: { projectId: params.projectId } });
      await prisma.lead.deleteMany({ where: { projectId: params.projectId } });
      
      // Delete messages before sessions to clear dependencies
      const sessions = await prisma.chatSession.findMany({ where: { projectId: params.projectId } });
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) {
        await prisma.message.deleteMany({ where: { sessionId: { in: sessionIds } } });
      }
      await prisma.chatSession.deleteMany({ where: { projectId: params.projectId } });
      
      // Finally, delete the project
      await prisma.project.delete({ where: { id: params.projectId } });
    } catch (err) {
      console.error("[Settings Delete Project] Safely cascading relations: ", err);
      try {
        await prisma.project.delete({ where: { id: params.projectId } });
      } catch (innerErr) {
        console.error("[Settings Delete Project] Force fallback delete failed:", innerErr);
      }
    }
    recordAudit({ userId: access.userId, action: "project.delete", projectId: params.projectId, request });
    return redirect("/dashboard");
  }

  if (actionType === "verify_custom_domain") {
    const access = await requireProjectAccess(request, params.projectId, { minRole: "ADMIN" });
    const userId = access.userId;
    const existingSettings = (access.project.settings as Record<string, any>) || {};
    const branding = (existingSettings.branding as Record<string, any>) || {};
    const host =
      normalizeCustomDomainInput((formData.get("customDomain") as string) || branding.customDomain || "");

    if (!host) {
      return json({
        success: false,
        verify: true,
        error: "Enter a hostname first (e.g. chat.example.com), then save or verify.",
      }, { status: 400 });
    }

    const taken = await findProjectByVerifiedCustomDomain(host);
    if (taken && taken.id !== access.project.id) {
      const settings = mergeProjectSettings(existingSettings, {
        branding: {
          customDomain: host,
          customDomainStatus: "failed",
          customDomainError: "This domain is already verified on another project.",
          customDomainVerifiedAt: null,
        },
      });
      await prisma.project.update({
        where: { id: access.project.id },
        data: { settings: settings as any },
      });
      return json({
        success: false,
        verify: true,
        error: "This domain is already verified on another project.",
        customDomainStatus: "failed",
      }, { status: 409 });
    }

    const result = await verifyCustomDomainDns(host);
    const settings = mergeProjectSettings(existingSettings, {
      branding: {
        customDomain: host,
        customDomainStatus: result.ok ? "verified" : "failed",
        customDomainError: result.ok ? null : result.error,
        customDomainVerifiedAt: result.ok ? new Date().toISOString() : null,
      },
    });
    await prisma.project.update({
      where: { id: access.project.id },
      data: { settings: settings as any },
    });
    recordAudit({
      userId,
      action: result.ok ? "project.custom_domain.verify" : "project.custom_domain.verify_failed",
      projectId: params.projectId,
      request,
      metadata: { host, ok: result.ok },
    });
    return json({
      success: result.ok,
      verify: true,
      message: result.ok
        ? `${host} is verified. Visitors to that hostname will open this chatbot.`
        : undefined,
      error: result.ok ? undefined : result.error,
      customDomainStatus: result.ok ? "verified" : "failed",
      cnameTarget: getCustomDomainCnameTarget(),
    });
  }

  const access = await requireProjectAccess(request, params.projectId, { minRole: "ADMIN" });
  const userId = access.userId;

  const name = formData.get("name") as string;
  const systemPrompt = formData.get("systemPrompt") as string;
  const model = formData.get("model") as string;
  const primaryColor = formData.get("primaryColor") as string;
  const assistantName = formData.get("assistantName") as string;
  const assistantLogo = formData.get("assistantLogo") as string;
  const greetingMessage = formData.get("greetingMessage") as string;
  const proactiveEnabled = formData.get("proactive_enabled") === "on";
  const proactiveDelaySecRaw = parseFloat((formData.get("proactive_delaySec") as string) || "5");
  const proactiveDelaySec = Number.isFinite(proactiveDelaySecRaw) && proactiveDelaySecRaw >= 0
    ? proactiveDelaySecRaw
    : 5;
  const proactiveMessage = ((formData.get("proactive_message") as string) || "").trim() || "Need help?";
  const proactive = {
    enabled: proactiveEnabled,
    delayMs: Math.round(proactiveDelaySec * 1000),
    message: proactiveMessage,
  };
  const suggestionsString = formData.get("suggestions") as string;
  const webhookUrl = formData.get("webhookUrl") as string;
  const customDomainRaw = (formData.get("customDomain") as string) || "";
  const customDomain = normalizeCustomDomainInput(customDomainRaw);
  const allowedDomainsString = formData.get("allowedDomains") as string;
  let removeBranding = formData.get("removeBranding") === "true";
  if (removeBranding) {
    const [user, addons] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { subscriptionTier: true } }),
      prisma.userAddon.findMany({ where: { userId, status: "active" }, select: { type: true, status: true } }),
    ]);
    if (!hasRemoveBrandingAccess(user?.subscriptionTier, addons)) {
      removeBranding = false;
    }
  }
  
  const leadPolicy = formData.get("leadPolicy") as string; // 'none', 'pre-chat', 'keywords'
  
  const bubbleShape = formData.get("bubbleShape") as string;
  const position = formData.get("position") as string;
  const font = formData.get("font") as string;
  
  const chatMode = formData.get("chatMode") as string || "ai-only";
  
  const rateLimitPerUser = parseInt(formData.get("rateLimitPerUser") as string || "0", 10);
  const rateLimitWindow = formData.get("rateLimitWindow") as string || "day";

  const leadFieldsRaw = formData.get("leadFields") as string;
  let leadFields: any[] = [];
  try {
    leadFields = JSON.parse(leadFieldsRaw || "[]");
  } catch {
    leadFields = [];
  }
  
  const slackWebhookUrl = formData.get("slackWebhookUrl") as string || "";

  // Response language: "auto" (mirror the visitor's detected language) or a forced
  // language name consumed by languageDirective() in the RAG prompt.
  const language = (formData.get("language") as string || "auto").trim();
  
  const suggestions = suggestionsString ? suggestionsString.split("\n").filter(s => s.trim() !== "") : [];
  const allowedDomains = allowedDomainsString ? allowedDomainsString.split(",").map(d => d.trim()).filter(d => d !== "") : [];

  // Webhook event subscriptions (which events fire to webhookUrl). Checkboxes only
  // submit when checked, so an absent value = unchecked/disabled.
  const webhookEvents = {
    "message.received": formData.get("webhook_event_message") === "on",
    "conversation.escalated": formData.get("webhook_event_escalated") === "on",
    "conversation.resolved": formData.get("webhook_event_resolved") === "on",
    "lead.captured": formData.get("webhook_event_lead") === "on",
  };

  // Human handoff: configurable escalation keywords + agent routing mode.
  const escalationKeywords = ((formData.get("escalation_keywords") as string) || "")
    .split(/[\n,]/).map(k => k.trim()).filter(Boolean);
  const routingModeRaw = (formData.get("escalation_routing") as string) || "off";
  const escalation = {
    keywords: escalationKeywords,
    routing: { mode: ["off", "round_robin", "first_admin"].includes(routingModeRaw) ? routingModeRaw : "off" },
  };

  // Business hours — when enabled, embed shows Offline outside the configured window.
  const bhEnabled = formData.get("bh_enabled") === "on";
  const bhTimezone = ((formData.get("bh_timezone") as string) || "UTC").trim() || "UTC";
  const bhDays = WEEKDAY_LABELS
    .map((d) => d.value)
    .filter((d) => formData.get(`bh_day_${d}`) === "on");
  const bhStartRaw = ((formData.get("bh_startTime") as string) || "09:00").trim();
  const bhEndRaw = ((formData.get("bh_endTime") as string) || "17:00").trim();
  const hhmm = /^\d{2}:\d{2}$/;
  const bhStartTime = hhmm.test(bhStartRaw) ? bhStartRaw : "09:00";
  const bhEndTime = hhmm.test(bhEndRaw) ? bhEndRaw : "17:00";
  const bhOfflineMessage = ((formData.get("bh_offlineMessage") as string) || "").trim();
  const businessHours = {
    enabled: bhEnabled,
    timezone: bhTimezone,
    days: bhDays.length > 0 ? bhDays : [1, 2, 3, 4, 5],
    startTime: bhStartTime,
    endTime: bhEndTime,
    offlineMessage: bhOfflineMessage || undefined,
  };

  // Merge over existing settings so keys this form doesn't manage (e.g.
  // notifications, and anything other flows store under settings) survive the
  // save — otherwise saving Bot Settings wipes them. See mergeProjectSettings.
  const existingSettings = (access.project.settings as Record<string, any>) || {};
  const prevDomain = normalizeCustomDomainInput(
    ((existingSettings.branding as Record<string, any>) || {}).customDomain || ""
  );
  const domainChanged = prevDomain !== customDomain;
  // Changing the hostname invalidates prior DNS verification.
  const brandingDomainPatch = domainChanged
    ? {
        customDomain,
        customDomainStatus: customDomain ? "unverified" : null,
        customDomainError: null,
        customDomainVerifiedAt: null,
      }
    : { customDomain };

  const settings = mergeProjectSettings(existingSettings, {
    systemPrompt,
    model,
    language,
    allowedDomains,
    chatMode,
    rateLimitPerUser,
    rateLimitWindow,
    leadFields,
    slackWebhookUrl,
    webhookEvents,
    escalation,
    businessHours,
    branding: {
      primaryColor,
      assistantName,
      assistantLogo,
      greetingMessage,
      suggestions,
      bubbleShape,
      position,
      font,
      removeBranding,
      ...brandingDomainPatch,
      leadPolicy,
      proactive,
    },
  });

  await prisma.project.update({
    where: { id: params.projectId },
    data: { 
      name,
      webhookUrl,
      settings: settings as any,
    },
  });

  recordAudit({ userId, action: "project.settings.update", projectId: params.projectId, request });
  return json({ success: true, message: "Bot settings updated successfully" });
}

interface LeadField {
  id: string;
  label: string;
  type: 'text' | 'dropdown' | 'checkbox';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export default function ProjectSettings() {
  const { project, canRemoveBranding, cnameTarget } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";
  const verifyFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  
  const currentSettings = (project.settings as any) || {};
  const [leadFields, setLeadFields] = useState<LeadField[]>(
    currentSettings.leadFields || []
  );
  const [selectedModel, setSelectedModel] = useState<string>(currentSettings.model || "auto");
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string>('');
  const [slackTestStatus, setSlackTestStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [slackTestError, setSlackTestError] = useState<string>('');
  const branding = currentSettings.branding || {};
  const removeBranding = branding.removeBranding || false;
  const [customDomainInput, setCustomDomainInput] = useState<string>(branding.customDomain || "");
  const customDomainStatus =
    (verifyFetcher.data as any)?.customDomainStatus ||
    branding.customDomainStatus ||
    (branding.customDomain ? "unverified" : null);
  const customDomainError =
    (verifyFetcher.data as any)?.error ||
    branding.customDomainError ||
    null;
  const isVerifying = verifyFetcher.state !== "idle";

  useEffect(() => {
    if (verifyFetcher.state === "idle" && verifyFetcher.data) {
      revalidator.revalidate();
    }
  }, [verifyFetcher.state, verifyFetcher.data, revalidator]);

  const [systemPrompt, setSystemPrompt] = useState<string>(
    currentSettings.systemPrompt || "You are a helpful customer support assistant for a website. Use the provided context to answer questions accurately and concisely."
  );
  const [selectedPersona, setSelectedPersona] = useState<string>(() => {
    const match = PERSONAS.find(p => p.prompt === (currentSettings.systemPrompt || ""));
    return match?.id ?? "custom";
  });

  return (
    <div className="max-w-4xl">
      <Link to={`/dashboard/projects/${project.id}`} className="inline-flex items-center gap-2 text-sm font-bold text-text-muted hover:text-brand-gray transition-colors mb-6">
        <ChevronLeft className="w-4 h-4" /> Back to project
      </Link>
      
      <div className="mb-12">
        <h1 className="text-4xl font-black mb-2">Bot Settings</h1>
        <p className="text-text-muted">Customize how your AI assistant behaves and looks.</p>
        <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary/5 border border-primary/10 rounded-full">
          <span className="text-lg">🌍</span>
          <span className="text-xs font-black text-primary uppercase tracking-wider">Responds in 95+ languages automatically</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-12">
        <div className="lg:col-span-3">
          <Form method="post" className="space-y-8">
            {/* General Settings */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Settings className="text-primary w-5 h-5" /> General Configuration
              </h2>
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-bold mb-2">Project Name</label>
                  <input 
                    type="text" 
                    name="name" 
                    defaultValue={project.name}
                    required
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold mb-2 flex items-center justify-between">
                    System Instructions (Prompt)
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Core Personality</span>
                  </label>

                  {/* Persona Selector */}
                  <div className="flex flex-wrap gap-2 mb-3 font-sans">
                    {PERSONAS.map((persona) => (
                      <button
                        key={persona.id}
                        type="button" // IMPORTANT: prevents form submission
                        onClick={() => {
                          setSystemPrompt(persona.prompt);
                          setSelectedPersona(persona.id);
                        }}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                          selectedPersona === persona.id
                            ? "bg-primary text-white border-primary"
                            : "bg-zinc-50 text-zinc-600 border-zinc-200 hover:border-zinc-400"
                        }`}
                      >
                        {persona.label}
                      </button>
                    ))}
                    {selectedPersona !== "custom" && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPersona("custom");
                        }}
                        className="px-3 py-1.5 rounded-full text-xs text-zinc-400 border border-zinc-100 hover:border-zinc-300 transition-all font-medium cursor-pointer"
                      >
                        Custom ✕
                      </button>
                    )}
                  </div>

                  {selectedPersona !== "custom" && (
                    <p className="text-xs text-primary font-medium mb-3 font-sans">
                      {PERSONAS.find(p => p.id === selectedPersona)?.description}
                    </p>
                  )}

                  <textarea 
                    name="systemPrompt" 
                    rows={6}
                    value={systemPrompt}
                    onChange={(e) => {
                      setSystemPrompt(e.target.value);
                      setSelectedPersona("custom"); // selecting a persona then editing = custom
                    }}
                    placeholder="E.g. You are a friendly sales rep..."
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-sans"
                  />
                  <p className="mt-2 text-xs text-zinc-400">This defines how the bot responds and its general persona.</p>
                </div>
                <div>
                  <label className="block text-sm font-bold mb-2">AI Model</label>
                  <input type="hidden" name="model" value={selectedModel} />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                    {[
                      {
                        value: "auto",
                        label: "Auto",
                        icon: "✦",
                        badge: "Recommended",
                        badgeColor: "bg-primary/10 text-primary",
                        description: "Picks the best available model automatically — prefers GPT-4.1-mini for speed.",
                      },
                      {
                        value: "gpt-4.1-mini",
                        label: "GPT-4.1-mini (Fastest)",
                        icon: "⚡",
                        badge: "Newest · Fast",
                        badgeColor: "bg-green-50 text-green-600",
                        description: "GPT-4.1 Mini — newest fast model, great for high-volume FAQs and quick answers.",
                      },
                      {
                        value: "gpt-4.1",
                        label: "GPT-4.1 (Most Accurate)",
                        icon: "🧠",
                        badge: "Newest · Best",
                        badgeColor: "bg-brand-orange/10 text-brand-orange",
                        description: "GPT-4.1 — newest flagship, most accurate for complex or nuanced questions.",
                      },
                      {
                        value: "gpt-4o-mini",
                        label: "GPT-4o-mini",
                        icon: "⚡",
                        badge: "Low cost",
                        badgeColor: "bg-green-50 text-green-600",
                        description: "GPT-4o Mini — ideal for high-volume FAQs and quick answers.",
                      },
                      {
                        value: "gpt-4o",
                        label: "GPT-4o",
                        icon: "🎯",
                        badge: "Best quality",
                        badgeColor: "bg-brand-orange/10 text-brand-orange",
                        description: "GPT-4o — deeper reasoning for complex or nuanced questions.",
                      },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setSelectedModel(opt.value)}
                        className={`text-left p-4 rounded-2xl border-2 transition-all ${
                          selectedModel === opt.value
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-zinc-100 bg-zinc-50 hover:border-zinc-200"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-lg">{opt.icon}</span>
                          <span className={`text-[9px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full ${opt.badgeColor}`}>{opt.badge}</span>
                        </div>
                        <p className="text-sm font-black mb-1">{opt.label}</p>
                        <p className="text-[11px] text-zinc-400 leading-snug">{opt.description}</p>
                      </button>
                    ))}
                  </div>
                  <details className="group">
                    <summary className="text-xs font-black text-zinc-400 cursor-pointer hover:text-zinc-600 uppercase tracking-wider select-none list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 inline-block transition-transform">›</span> Gemini alternatives
                    </summary>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                      {[
                        { value: "gemini-2.0-flash", label: "Gemini Flash", icon: "⚡", description: "Google's fast model — great latency, multimodal." },
                        { value: "gemini-1.5-pro", label: "Gemini Pro", icon: "🎯", description: "Google's advanced reasoning model." },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setSelectedModel(opt.value)}
                          className={`text-left p-4 rounded-2xl border-2 transition-all ${
                            selectedModel === opt.value
                              ? "border-primary bg-primary/5 shadow-sm"
                              : "border-zinc-100 bg-zinc-50 hover:border-zinc-200"
                          }`}
                        >
                          <span className="text-base">{opt.icon}</span>
                          <p className="text-sm font-black mt-1 mb-0.5">{opt.label}</p>
                          <p className="text-[11px] text-zinc-400 leading-snug">{opt.description}</p>
                        </button>
                      ))}
                    </div>
                  </details>
                  {selectedModel !== "auto" && (
                    <p className="mt-3 text-[11px] text-zinc-400 font-medium">
                      Selected: <span className="font-black text-zinc-600">{selectedModel}</span>
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="chatMode" className="block text-sm font-bold mb-2">
                    Chat Mode
                  </label>
                  <select
                    id="chatMode"
                    name="chatMode"
                    defaultValue={currentSettings.chatMode || "ai-only"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-sans"
                  >
                    <option value="ai-only">AI Only — AI answers everything automatically</option>
                    <option value="hybrid">Hybrid — AI answers, human can step in anytime</option>
                    <option value="agent-only">Agent Only — All chats go to human agents</option>
                  </select>
                  <p className="mt-2 text-xs text-zinc-400">
                    Controls how incoming conversations are handled.
                  </p>
                </div>
                <div>
                  <label htmlFor="language" className="block text-sm font-bold mb-2">
                    Response Language
                  </label>
                  <select
                    id="language"
                    name="language"
                    defaultValue={currentSettings.language || "auto"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-sans"
                  >
                    <option value="auto">Auto-detect — reply in the visitor's language (95+)</option>
                    <option value="English">English</option>
                    <option value="Spanish">Spanish — Español</option>
                    <option value="French">French — Français</option>
                    <option value="German">German — Deutsch</option>
                    <option value="Portuguese">Portuguese — Português</option>
                    <option value="Italian">Italian — Italiano</option>
                    <option value="Dutch">Dutch — Nederlands</option>
                    <option value="Russian">Russian — Русский</option>
                    <option value="Japanese">Japanese — 日本語</option>
                    <option value="Korean">Korean — 한국어</option>
                    <option value="Chinese">Chinese — 中文</option>
                    <option value="Arabic">Arabic — العربية</option>
                    <option value="Hebrew">Hebrew — עברית</option>
                    <option value="Hindi">Hindi — हिन्दी</option>
                    <option value="Bengali">Bengali — বাংলা</option>
                    <option value="Tamil">Tamil — தமிழ்</option>
                    <option value="Telugu">Telugu — తెలుగు</option>
                    <option value="Thai">Thai — ไทย</option>
                    <option value="Greek">Greek — Ελληνικά</option>
                    <option value="Turkish">Turkish — Türkçe</option>
                    <option value="Polish">Polish — Polski</option>
                    <option value="Vietnamese">Vietnamese — Tiếng Việt</option>
                    <option value="Indonesian">Indonesian — Bahasa Indonesia</option>
                    <option value="Ukrainian">Ukrainian — Українська</option>
                    <option value="Swedish">Swedish — Svenska</option>
                    <option value="Filipino">Filipino — Tagalog</option>
                    <option value="Urdu">Urdu — اردو</option>
                  </select>
                  <p className="mt-2 text-xs text-zinc-400">
                    Auto-detect mirrors each visitor's language. Or force every reply into one language regardless of how visitors write.
                  </p>
                </div>
              </div>
            </section>

            {/* Appearance & Branding */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Palette className="text-primary w-5 h-5" /> Branding & Theme Builder
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-bold mb-2">Assistant Name</label>
                  <input 
                    type="text" 
                    name="assistantName" 
                    id="assistantName"
                    defaultValue={branding.assistantName || "Support AI"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  />
                </div>
                <div>
                   <label className="block text-sm font-bold mb-2">Assistant Logo (URL)</label>
                   <input 
                     type="url" 
                     name="assistantLogo" 
                     placeholder="https://..."
                     defaultValue={branding.assistantLogo || ""}
                     className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                   />
                </div>
                <div>
                  <label className="block text-sm font-bold mb-2">Theme Color (Hex)</label>
                  <div className="flex gap-2">
                    <input 
                      type="color" 
                      name="primaryColor" 
                      id="primaryColor"
                      defaultValue={branding.primaryColor || "#155DEE"}
                      className="h-14 w-20 bg-zinc-50 border border-zinc-100 rounded-2xl p-1 cursor-pointer"
                    />
                    <input 
                      type="text" 
                      value={branding.primaryColor || "#155DEE"}
                      readOnly
                      className="flex-1 px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl text-zinc-400 font-mono text-sm"
                    />
                  </div>
                </div>

                <div className="md:col-span-1">
                  <label className="block text-sm font-bold mb-2">Font Family</label>
                  <select 
                    name="font" 
                    defaultValue={branding.font || "sans"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  >
                    <option value="sans">Modern Sans (Inter)</option>
                    <option value="serif">Classic Serif</option>
                    <option value="mono">Technical Mono</option>
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-bold mb-2">Greeting Message</label>
                  <input 
                    type="text" 
                    name="greetingMessage" 
                    id="greetingMessage"
                    defaultValue={branding.greetingMessage || "Hi there! How can I help you today?"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  />
                </div>

                <div className="md:col-span-1">
                  <label className="block text-sm font-bold mb-2">Bubble Shape</label>
                  <select 
                    name="bubbleShape" 
                    defaultValue={branding.bubbleShape || "rounded-2xl"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  >
                    <option value="rounded-none">Square</option>
                    <option value="rounded-2xl">Modern (Default)</option>
                    <option value="rounded-full">Pill</option>
                  </select>
                </div>

                <div className="md:col-span-1">
                  <label className="block text-sm font-bold mb-2">Widget Position</label>
                  <select 
                    name="position" 
                    defaultValue={branding.position || "bottom-right"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  >
                    <option value="bottom-right">Bottom Right</option>
                    <option value="bottom-left">Bottom Left</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Proactive Message */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Megaphone className="text-primary w-5 h-5" /> Proactive Message
              </h2>
              <div className="space-y-6">
                {(() => {
                  const proactive = branding.proactive || {};
                  const delaySec =
                    typeof proactive.delayMs === "number" && Number.isFinite(proactive.delayMs)
                      ? Math.max(0, proactive.delayMs / 1000)
                      : 5;
                  return (
                    <>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          name="proactive_enabled"
                          defaultChecked={!!proactive.enabled}
                          className="w-5 h-5 rounded border-zinc-300 text-primary focus:ring-primary"
                        />
                        <div>
                          <span className="block text-sm font-bold">Show a delayed teaser on the widget</span>
                          <span className="block text-xs text-zinc-400 group-hover:text-zinc-500">
                            After the delay, visitors see a small message bubble they can click to open chat. Dismissed once per browser.
                          </span>
                        </div>
                      </label>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label htmlFor="proactive_delaySec" className="block text-sm font-bold mb-2">Delay (seconds)</label>
                          <input
                            id="proactive_delaySec"
                            type="number"
                            name="proactive_delaySec"
                            min={0}
                            step={0.5}
                            defaultValue={delaySec}
                            className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                          />
                        </div>
                        <div>
                          <label htmlFor="proactive_message" className="block text-sm font-bold mb-2">Teaser message</label>
                          <input
                            id="proactive_message"
                            type="text"
                            name="proactive_message"
                            defaultValue={proactive.message || "Need help?"}
                            placeholder="Need help?"
                            maxLength={120}
                            className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                          />
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </section>

            {/* Whitelabeling */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-3">
                  <Zap className="text-brand-orange w-5 h-5" /> Whitelabeling
                </h2>
                {canRemoveBranding ? (
                  <div className="bg-green-50 text-green-600 text-[10px] font-black uppercase px-2 py-1 rounded border border-green-100">Unlocked</div>
                ) : (
                  <div className="bg-brand-orange/10 text-brand-orange text-[10px] font-black uppercase px-2 py-1 rounded">Add-on</div>
                )}
              </div>
              <div className="space-y-6">
                <div>
                  {canRemoveBranding ? (
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        name="removeBranding"
                        value="true"
                        defaultChecked={removeBranding}
                        className="w-5 h-5 rounded border-zinc-300 text-primary focus:ring-primary"
                      />
                      <div>
                        <span className="block text-sm font-bold">Remove "Powered by SiteGist"{/* pragma: allowlist secret */}</span>
                        <span className="block text-xs text-zinc-400 group-hover:text-zinc-500">Hide the SiteGist logo and link from your widget.{/* pragma: allowlist secret */}</span>
                      </div>
                    </label>
                  ) : (
                    <div className="flex items-start gap-4 p-5 bg-zinc-50 rounded-2xl border border-zinc-100">
                      <div className="w-5 h-5 rounded border-2 border-zinc-300 bg-zinc-100 shrink-0 mt-0.5 flex items-center justify-center">
                        <Lock className="w-3 h-3 text-zinc-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-zinc-500">Remove "Powered by SiteGist"{/* pragma: allowlist secret */}</span>
                          <span className="text-[9px] font-black bg-brand-orange/10 text-brand-orange px-2 py-0.5 rounded uppercase tracking-wide">$39/mo Add-on</span>
                        </div>
                        <span className="block text-xs text-zinc-400 mt-0.5">Hide the SiteGist logo and link from your widget.{/* pragma: allowlist secret */}</span>
                        <Link
                          to="/dashboard/billing#addons"
                          className="mt-2 inline-flex items-center gap-1 text-xs font-black text-primary hover:underline"
                        >
                          Unlock this feature →
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-bold mb-2 text-brand-dark flex items-center gap-2">
                    <Globe className="w-4 h-4 text-primary" /> Custom Domain
                  </label>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="text"
                      name="customDomain"
                      placeholder="chat.yourdomain.com"
                      value={customDomainInput}
                      onChange={(e) => setCustomDomainInput(e.target.value)}
                      className="flex-1 px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-mono text-sm"
                    />
                    <button
                      type="button"
                      disabled={isVerifying || !customDomainInput.trim()}
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("_action", "verify_custom_domain");
                        fd.set("customDomain", customDomainInput);
                        verifyFetcher.submit(fd, { method: "post" });
                      }}
                      className="inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-zinc-900 text-white text-sm font-bold hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    >
                      {isVerifying ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      Verify DNS
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {customDomainStatus === "verified" && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-green-50 text-green-700">
                        <Check className="w-3 h-3" /> Verified
                      </span>
                    )}
                    {customDomainStatus === "unverified" && customDomainInput.trim() && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">
                        Unverified
                      </span>
                    )}
                    {customDomainStatus === "failed" && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-red-50 text-red-700">
                        <AlertCircle className="w-3 h-3" /> Failed
                      </span>
                    )}
                  </div>
                  {customDomainError && customDomainStatus === "failed" && (
                    <p className="mt-2 text-xs text-red-600 font-medium leading-relaxed">{customDomainError}</p>
                  )}
                  {(verifyFetcher.data as any)?.success && (verifyFetcher.data as any)?.verify && (
                    <p className="mt-2 text-xs text-green-700 font-medium leading-relaxed">
                      {(verifyFetcher.data as any).message}
                    </p>
                  )}
                  <div className="mt-3 p-4 bg-zinc-50 rounded-2xl border border-zinc-100 space-y-2">
                    <p className="text-xs text-zinc-600 font-medium leading-relaxed">
                      1. Create a <strong>CNAME</strong> record for your hostname pointing to{" "}
                      <code className="bg-white px-1.5 py-0.5 rounded border border-zinc-200 font-mono text-[11px]">
                        {cnameTarget}
                      </code>
                    </p>
                    <p className="text-xs text-zinc-600 font-medium leading-relaxed">
                      2. Click <strong>Verify DNS</strong> (propagation can take a few minutes). Save settings after changing the hostname.
                    </p>
                    <p className="text-xs text-zinc-400 font-medium leading-relaxed">
                      Once verified, visitors to that hostname are sent to this chatbot&apos;s embed page. TLS for arbitrary customer domains may require platform-side domain attachment — contact support if verify succeeds but HTTPS fails.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Behavior */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Zap className="text-primary w-5 h-5" /> Advanced Features
              </h2>
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="webhookUrl" className="block text-sm font-bold">
                      Zapier / Webhook URL
                    </label>
                    <button
                      type="button"
                      disabled={testStatus === 'loading'}
                      onClick={async () => {
                        setTestStatus('loading');
                        setTestError('');
                        try {
                          const res = await fetch('/api/webhook-test', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: project.id }),
                          });
                          const data = await res.json();
                          if (res.ok && data.ok) {
                            setTestStatus('success');
                            setTimeout(() => setTestStatus('idle'), 4000);
                          } else {
                            setTestStatus('error');
                            setTestError(data.error || 'Failed to send test event.');
                            setTimeout(() => {
                              setTestStatus('idle');
                              setTestError('');
                            }, 5000);
                          }
                        } catch (err) {
                          setTestStatus('error');
                          setTestError('Network error. Failed to trigger test.');
                          setTimeout(() => {
                            setTestStatus('idle');
                            setTestError('');
                          }, 5000);
                        }
                      }}
                      className="text-xs font-extrabold text-primary hover:underline flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {testStatus === 'loading' && 'Sending...'}
                      {testStatus === 'success' && '✅ Sent Test Event!'}
                      {testStatus === 'error' && '❌ Failed'}
                      {testStatus === 'idle' && 'Send Test Event'}
                    </button>
                  </div>
                  <input 
                    id="webhookUrl"
                    type="url" 
                    name="webhookUrl" 
                    defaultValue={project.webhookUrl || ""}
                    placeholder="https://hooks.zapier.com/hooks/catch/..."
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-mono text-sm"
                  />
                  {testError && (
                    <p className="mt-1.5 text-xs text-red-500 font-semibold">{testError}</p>
                  )}
                  <div className="mt-3 text-xs text-zinc-400 space-y-1.5 font-medium leading-relaxed">
                    <p>
                      Paste a <strong>Zapier webhook URL</strong> to connect SiteGist{/* pragma: allowlist secret */} to 5,000+ apps.
                      In Zapier, create a new Zap → trigger: <em>Webhooks by Zapier → Catch Hook</em> → paste the URL here.
                    </p>
                    <p>
                      Choose which events fire below. Each POST is signed with{' '}
                      <code className="bg-zinc-100 text-zinc-600 px-1.5 py-0.5 rounded font-mono text-[10px]">X-SiteGist-Signature{/* pragma: allowlist secret */}</code> (HMAC-SHA256).
                    </p>
                  </div>

                  {/* Webhook event subscriptions */}
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {([
                      { name: "webhook_event_lead", event: "lead.captured", label: "Lead captured", def: true },
                      { name: "webhook_event_escalated", event: "conversation.escalated", label: "Conversation escalated", def: true },
                      { name: "webhook_event_resolved", event: "conversation.resolved", label: "Conversation resolved", def: true },
                      { name: "webhook_event_message", event: "message.received", label: "Message received (high volume)", def: false },
                    ] as const).map((ev) => {
                      const configured = currentSettings.webhookEvents?.[ev.event];
                      const checked = typeof configured === "boolean" ? configured : ev.def;
                      return (
                        <label key={ev.name} className="flex items-center gap-2.5 p-3 bg-zinc-50 border border-zinc-100 rounded-xl cursor-pointer text-sm">
                          <input type="checkbox" name={ev.name} defaultChecked={checked} className="w-4 h-4 rounded border-zinc-300 text-primary focus:ring-primary/10 cursor-pointer" />
                          <span className="flex-1">
                            <span className="font-semibold text-zinc-700">{ev.label}</span>
                            <code className="ml-2 bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded font-mono text-[10px]">{ev.event}</code>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Human handoff — escalation triggers + agent routing */}
                <div className="border-t border-zinc-100 pt-6">
                  <label className="block text-sm font-bold mb-2">Human handoff</label>
                  <p className="text-xs text-zinc-400 mb-3 font-medium">Escalate to a human when a visitor's message matches any of these keywords (one per line or comma-separated). Leave empty to use sensible defaults.</p>
                  <textarea
                    name="escalation_keywords"
                    rows={3}
                    defaultValue={(currentSettings.escalation?.keywords || []).join("\n")}
                    placeholder={"human\nagent\ntalk to someone"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all text-sm font-mono"
                  />
                  <label className="block text-sm font-bold mt-4 mb-1.5">Agent routing</label>
                  <select
                    name="escalation_routing"
                    defaultValue={currentSettings.escalation?.routing?.mode || "off"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all text-sm"
                  >
                    <option value="off">Off — leave escalated chats unassigned</option>
                    <option value="round_robin">Round-robin — least-busy admin</option>
                    <option value="first_admin">First admin — always the earliest admin</option>
                  </select>
                  <p className="text-[11px] text-zinc-400 mt-1.5">Assigns escalated conversations to a project <strong>Admin</strong> member (managed on the Members page).</p>
                </div>

                <div className="border-t border-zinc-100 pt-6">
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="slackWebhookUrl" className="block text-sm font-bold flex items-center gap-2">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523 2.528 2.528 0 0 1-2.522-2.523 2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zm1.261 0a2.528 2.528 0 0 1 2.52-2.52h5.043a2.528 2.528 0 0 1 2.522 2.52v5.042a2.528 2.528 0 0 1-2.522 2.52H8.824a2.528 2.528 0 0 1-2.521-2.52v-5.042zM8.824 5.043a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.824 0a2.528 2.528 0 0 1 2.521 2.523v2.52h-2.521zm0 1.261a2.528 2.528 0 0 1 2.521 2.52v5.043a2.528 2.528 0 0 1-2.521 2.522H3.78a2.528 2.528 0 0 1-2.522-2.522V8.824A2.528 2.528 0 0 1 3.78 6.304h5.043zm10.134 3.78a2.528 2.528 0 0 1 2.522-2.521 2.528 2.528 0 0 1 2.52 2.521 2.528 2.528 0 0 1-2.52 2.52h-2.522v-2.52zm-1.262 0a2.528 2.528 0 0 1-2.52 2.52h-5.043a2.528 2.528 0 0 1-2.522-2.52V5.043a2.528 2.528 0 0 1 2.522-2.52h5.043a2.528 2.528 0 0 1 2.52 2.52v5.042zm-3.78 10.134a2.528 2.528 0 0 1 2.522 2.521 2.528 2.528 0 0 1-2.522 2.52 2.528 2.528 0 0 1-2.52-2.52v-2.521h2.52zm0-1.262a2.528 2.528 0 0 1-2.52-2.52v-5.043c0-1.393 1.13-2.522 2.52-2.522h5.043a2.528 2.528 0 0 1 2.522 2.522v5.043a2.528 2.528 0 0 1-2.522 2.522h-5.043z"/>
                      </svg>
                      Slack Incoming Webhook URL
                    </label>
                    <button
                      type="button"
                      disabled={slackTestStatus === 'loading'}
                      onClick={async () => {
                        setSlackTestStatus('loading');
                        setSlackTestError('');
                        try {
                          const res = await fetch('/api/slack-test', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: project.id }),
                          });
                          const data = await res.json();
                          if (res.ok && data.ok) {
                            setSlackTestStatus('success');
                            setTimeout(() => setSlackTestStatus('idle'), 4000);
                          } else {
                            setSlackTestStatus('error');
                            setSlackTestError(data.error || 'Failed to send test message.');
                            setTimeout(() => {
                              setSlackTestStatus('idle');
                              setSlackTestError('');
                            }, 5000);
                          }
                        } catch (err) {
                          setSlackTestStatus('error');
                          setSlackTestError('Network error. Failed to trigger Slack test.');
                          setTimeout(() => {
                            setSlackTestStatus('idle');
                            setSlackTestError('');
                          }, 5000);
                        }
                      }}
                      className="text-xs font-extrabold text-primary hover:underline flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {slackTestStatus === 'loading' && 'Sending...'}
                      {slackTestStatus === 'success' && '✅ Sent Slack Test!'}
                      {slackTestStatus === 'error' && '❌ Failed'}
                      {slackTestStatus === 'idle' && 'Send Test Message'}
                    </button>
                  </div>
                  <input 
                    id="slackWebhookUrl"
                    type="url" 
                    name="slackWebhookUrl" 
                    defaultValue={currentSettings.slackWebhookUrl || ""}
                    placeholder="https://hooks.slack.com/services/..."
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-mono text-sm"
                  />
                  {slackTestError && (
                    <p className="mt-1.5 text-xs text-red-500 font-semibold">{slackTestError}</p>
                  )}
                  <div className="mt-3 text-xs text-zinc-400 space-y-1.5 font-medium leading-relaxed">
                    <p>
                      Sends interactive notifications directly to a Slack channel when a lead is captured or human assistance is requested.
                    </p>
                    <p>
                      To generate an incoming webhook:{' '}
                      <a
                        href="https://api.slack.com/messaging/webhooks"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-primary transition-colors font-bold"
                      >
                        Create a Slack app → Enable Incoming Webhooks → Copy URL
                      </a>
                    </p>
                  </div>
                </div>

                <div className="border-t border-zinc-100 pt-6">
                  <label htmlFor="allowedDomains" className="block text-sm font-bold mb-2 text-brand-dark">
                    Allowed Domains (Whitelist)
                  </label>
                  <input 
                    id="allowedDomains"
                    type="text" 
                    name="allowedDomains" 
                    defaultValue={currentSettings.allowedDomains?.join(", ") || ""}
                    placeholder="example.com, app.example.com"
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-mono text-sm"
                  />
                  <p className="mt-3 text-xs text-zinc-400 font-medium leading-relaxed">
                    Comma-separated list of domains allowed to embed this chatbot. Example: mysite.com, app.mysite.com — leave blank to allow all domains.
                  </p>
                </div>
              </div>
            </section>


            {/* Business Hours */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Clock className="text-primary w-5 h-5" /> Business Hours
              </h2>
              <div className="space-y-6">
                {(() => {
                  const bh = currentSettings.businessHours || {};
                  const enabledDays: number[] = Array.isArray(bh.days) ? bh.days : [1, 2, 3, 4, 5];
                  return (
                    <>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          name="bh_enabled"
                          defaultChecked={!!bh.enabled}
                          className="w-5 h-5 rounded border-zinc-300 text-primary focus:ring-primary"
                        />
                        <div>
                          <span className="block text-sm font-bold">Enable business hours</span>
                          <span className="block text-xs text-zinc-400 group-hover:text-zinc-500">
                            When enabled, the widget shows Offline and disables chat outside the schedule below.
                          </span>
                        </div>
                      </label>

                      <div>
                        <label htmlFor="bh_timezone" className="block text-sm font-bold mb-2">Timezone</label>
                        <select
                          id="bh_timezone"
                          name="bh_timezone"
                          defaultValue={bh.timezone || "America/New_York"}
                          className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-sans"
                        >
                          {bh.timezone && !(COMMON_TIMEZONES as readonly string[]).includes(bh.timezone) && (
                            <option value={bh.timezone}>{String(bh.timezone).replace(/_/g, " ")}</option>
                          )}
                          {COMMON_TIMEZONES.map((tz) => (
                            <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-bold mb-2">Active days</label>
                        <div className="flex flex-wrap gap-2">
                          {WEEKDAY_LABELS.map((d) => (
                            <label
                              key={d.value}
                              className="inline-flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-100 rounded-xl text-sm font-semibold cursor-pointer select-none"
                            >
                              <input
                                type="checkbox"
                                name={`bh_day_${d.value}`}
                                defaultChecked={enabledDays.includes(d.value)}
                                className="w-4 h-4 rounded border-zinc-300 text-primary focus:ring-primary/10 cursor-pointer"
                              />
                              {d.label}
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label htmlFor="bh_startTime" className="block text-sm font-bold mb-2">Start time</label>
                          <input
                            id="bh_startTime"
                            type="time"
                            name="bh_startTime"
                            defaultValue={bh.startTime || "09:00"}
                            className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                          />
                        </div>
                        <div>
                          <label htmlFor="bh_endTime" className="block text-sm font-bold mb-2">End time</label>
                          <input
                            id="bh_endTime"
                            type="time"
                            name="bh_endTime"
                            defaultValue={bh.endTime || "17:00"}
                            className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                          />
                        </div>
                      </div>

                      <div>
                        <label htmlFor="bh_offlineMessage" className="block text-sm font-bold mb-2">Offline message</label>
                        <input
                          id="bh_offlineMessage"
                          type="text"
                          name="bh_offlineMessage"
                          defaultValue={bh.offlineMessage || ""}
                          placeholder="We're currently outside business hours. Please check back soon."
                          className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                        />
                        <p className="mt-2 text-xs text-zinc-400">Shown in the widget when visitors open chat outside your hours.</p>
                      </div>
                    </>
                  );
                })()}
              </div>
            </section>

            {/* Rate Limiting */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Bot className="text-primary w-5 h-5" /> Rate Limiting
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="rateLimitPerUser" className="block text-sm font-bold mb-2">
                    Max messages per visitor
                  </label>
                  <input
                    id="rateLimitPerUser"
                    name="rateLimitPerUser"
                    type="number"
                    min="0"
                    defaultValue={currentSettings.rateLimitPerUser || 0}
                    placeholder="0 = unlimited"
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                  />
                  <p className="mt-2 text-xs text-zinc-400">Set to 0 to disable rate limiting.</p>
                </div>
                <div>
                  <label htmlFor="rateLimitWindow" className="block text-sm font-bold mb-2">
                    Per Time Window
                  </label>
                  <select
                    id="rateLimitWindow"
                    name="rateLimitWindow"
                    defaultValue={currentSettings.rateLimitWindow || "day"}
                    className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-sans"
                  >
                    <option value="hour">Hour</option>
                    <option value="day">Day</option>
                  </select>
                  <p className="mt-2 text-xs text-zinc-400 font-medium">Reset interval for visitor rate limit count.</p>
                </div>
              </div>
            </section>

            {/* Lead Generation */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <Users className="text-primary w-5 h-5" /> Lead Generation
              </h2>
              <div className="space-y-6">
                <div>
                   <label className="block text-sm font-bold mb-2">Collection Strategy</label>
                   <select 
                     name="leadPolicy" 
                     defaultValue={branding.leadPolicy || "keywords"}
                     className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                   >
                     <option value="none">Disabled (No Form)</option>
                     <option value="pre-chat">Pre-Chat (Ask immediately)</option>
                     <option value="keywords">Intelligence (Ask when intent matches)</option>
                     <option value="handoff">Handoff (Ask when human requested)</option>
                   </select>
                   <p className="mt-2 text-xs text-zinc-400 font-medium leading-relaxed">
                     Choose when to show the lead collection form to your visitors.
                   </p>
                </div>
                <div>
                   <label className="block text-sm font-bold mb-2 text-brand-dark">Captured Fields</label>
                   <div className="flex flex-wrap gap-2">
                     {['Name', 'Email', 'Phone', 'Company'].map(field => (
                       <div key={field} className="px-4 py-2 bg-zinc-50 border border-zinc-100 rounded-xl text-xs font-bold flex items-center gap-2 border shadow-sm">
                         <Check className="w-3 h-3 text-green-500" /> {field}
                       </div>
                     ))}
                   </div>
                   <p className="mt-2 text-xs text-zinc-400 font-medium">Capture these details automatically when users request human help or special access.</p>
                </div>

                <div className="border-t border-zinc-100 pt-6 space-y-4">
                  <input type="hidden" name="leadFields" value={JSON.stringify(leadFields)} />
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-bold text-brand-dark">Custom Lead Fields</label>
                    <button
                      type="button"
                      onClick={() => setLeadFields(prev => [...prev, {
                        id: Math.random().toString(36).substring(2, 9),
                        label: '',
                        type: 'text',
                        required: false,
                        options: [],
                      }])}
                      className="text-xs font-bold text-primary hover:underline hover:brightness-110 flex items-center gap-1 cursor-pointer"
                    >
                      + Add Custom Field
                    </button>
                  </div>
                  <p className="text-xs text-zinc-400 font-medium">Configure extra answers you'd like to collect, such as Company size, Role, or Budget.</p>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 mr-1">Start from a template:</span>
                    {LEAD_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        title={tpl.description}
                        onClick={() => {
                          if (leadFields.length > 0 && !confirm(`Replace your current custom fields with the ${tpl.label} template?`)) return;
                          setLeadFields(tpl.fields.map((f) => ({ ...f, id: Math.random().toString(36).substring(2, 9) })));
                        }}
                        className="px-3 py-1.5 rounded-full text-xs font-semibold border border-zinc-200 bg-zinc-50 text-zinc-600 hover:border-primary hover:text-primary transition-all cursor-pointer"
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-4">
                    {leadFields.map((field, i) => (
                      <div key={field.id} className="border border-zinc-150 rounded-2xl p-4 space-y-3 bg-zinc-50/50">
                        <div className="flex gap-2 items-center">
                          <input
                            type="text"
                            placeholder="Field label (e.g. Budget size)"
                            value={field.label}
                            onChange={e => setLeadFields(prev =>
                              prev.map((f, idx) => idx === i ? { ...f, label: e.target.value } : f)
                            )}
                            required
                            className="flex-1 px-3 py-2 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-primary/10 outline-none text-sm font-medium transition-all"
                          />
                          <select
                            value={field.type}
                            onChange={e => setLeadFields(prev =>
                              prev.map((f, idx) => idx === i ? { ...f, type: e.target.value as LeadField['type'] } : f)
                            )}
                            className="px-3 py-2 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-primary/10 outline-none text-sm font-medium transition-all"
                          >
                            <option value="text">Text Input</option>
                            <option value="dropdown">Dropdown (Select)</option>
                            <option value="checkbox">Checkbox (Yes/No)</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => setLeadFields(prev => prev.filter((_, idx) => idx !== i))}
                            className="text-zinc-400 hover:text-red-500 font-bold text-sm p-1 transition-colors cursor-pointer"
                            title="Remove Field"
                          >
                            ✕
                          </button>
                        </div>

                        {field.type === 'dropdown' && (
                          <div>
                            <label className="block text-xs font-semibold text-zinc-500 mb-1">Dropdown Options (one per line)</label>
                            <textarea
                              placeholder={"Small (1–10)\nMedium (11–50)\nLarge (50+)"}
                              value={(field.options || []).join('\n')}
                              onChange={e => setLeadFields(prev =>
                                prev.map((f, idx) => idx === i
                                  ? { ...f, options: e.target.value.split('\n').filter(line => line.trim() !== "") }
                                  : f)
                              )}
                              rows={3}
                              required
                              className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-primary/10 outline-none text-sm font-medium transition-all"
                            />
                          </div>
                        )}

                        <label className="flex items-center gap-2 text-xs font-bold text-zinc-500 select-none cursor-pointer w-fit">
                          <input
                            type="checkbox"
                            checked={field.required}
                            onChange={e => setLeadFields(prev =>
                              prev.map((f, idx) => idx === i ? { ...f, required: e.target.checked } : f)
                            )}
                            className="w-4 h-4 rounded border-zinc-300 text-primary focus:ring-primary/10 cursor-pointer"
                          />
                          This field is required
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Behavior */}
            <section className="bg-white p-8 rounded-[32px] border border-zinc-100 shadow-sm">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <MessageSquare className="text-primary w-5 h-5" /> Conversation Starters
              </h2>
              <div>
                <label className="block text-sm font-bold mb-2 uppercase tracking-widest text-zinc-400 text-[10px]">Suggestions (One per line)</label>
                <textarea 
                  name="suggestions" 
                  rows={4}
                  defaultValue={(branding.suggestions || []).join("\n")}
                  placeholder="What are your hours?&#10;How does pricing work?&#10;Talk to a human"
                  className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/10 outline-none transition-all font-sans"
                />
                <p className="mt-2 text-xs text-zinc-400">These chips appear when the chat first opens to help users start a conversation.</p>
              </div>
            </section>

            <div className="flex items-center justify-between gap-4 pt-4">
              {actionData && "success" in actionData && actionData.success && "message" in actionData && actionData.message && (
                <p className="text-green-500 font-bold">{actionData.message}</p>
              )}
              <div className="flex-1" />
              <button 
                type="submit" 
                disabled={isSaving}
                className="px-10 py-5 bg-primary text-white rounded-2xl font-black flex items-center justify-center gap-2 hover:brightness-110 active:scale-95 transition-all shadow-xl shadow-primary/20"
              >
                {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                Save Bot Settings
              </button>
            </div>
          </Form>

          {/* Danger Zone */}
          <section className="bg-red-50/20 p-8 rounded-[32px] border border-red-100/60 mt-12">
            <h2 className="text-xl font-bold mb-2 flex items-center gap-3 text-red-700">
              <Trash2 className="w-5 h-5 text-red-500" /> Danger Zone
            </h2>
            <p className="text-xs text-red-600/85 mb-6 font-medium leading-relaxed">
              Permanently delete this chatbot, along with all of its custom trained knowledge files, crawled URLs, manual Q&As, feedback stats, capture leads, and live inbox history. This process is irreversible.
            </p>
            <Form method="post" onSubmit={(e) => {
              if (!confirm("Are you absolutely sure you want to delete this chatbot? This will permanently wipe all training data and live history. This action cannot be undone.")) {
                e.preventDefault();
              }
            }}>
              <input type="hidden" name="_action" value="delete_project" />
              <button
                type="submit"
                className="px-6 py-4 bg-red-600 hover:bg-red-700 active:scale-95 text-white text-xs font-black rounded-2xl flex items-center gap-2 transition-all shadow-md shadow-red-200 uppercase tracking-widest"
              >
                <Trash2 className="w-4 h-4" /> Delete Chatbot Permanently
              </button>
            </Form>
          </section>
        </div>

        {/* Live Preview Column */}
        <div className="lg:col-span-2 space-y-8">
          <div className="sticky top-8">
            <div className="mb-6 flex items-center justify-between">
              <h3 className="font-black uppercase tracking-[0.2em] text-brand-gray text-[11px]">Studio Preview</h3>
              <div className="flex items-center gap-2 text-[10px] font-bold text-brand-online">
                <div className="w-1.5 h-1.5 bg-brand-online rounded-full animate-pulse" />
                Live Sync
              </div>
            </div>

            <div className="bg-[#F8F9FA] rounded-[48px] p-8 border border-brand-border aspect-[4/5] flex flex-col items-center justify-center relative overflow-hidden shadow-inner">
              <div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:24px_24px] opacity-50" />
              
              {/* Mock Widget UI */}
              <div className="relative z-10 w-full max-w-xs bg-white rounded-[32px] shadow-2xl border border-zinc-100 overflow-hidden flex flex-col h-full translate-y-4">
                <div className="p-4 flex items-center justify-between border-b border-zinc-50" style={{ backgroundColor: branding.primaryColor || '#155DEE' }}>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
                      <Bot className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-white">{branding.assistantName || "Support AI"}</h4>
                      <p className="text-[10px] text-white/70 font-bold">Online</p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 p-4 space-y-4 overflow-y-auto bg-zinc-50/50">
                  <div className="flex gap-2">
                    <div className="w-8 h-8 bg-zinc-100 rounded-full flex-shrink-0 flex items-center justify-center">
                      <Bot className="w-4 h-4 text-zinc-400" />
                    </div>
                    <div className="bg-white p-3 rounded-2xl rounded-tl-none shadow-sm border border-zinc-100 text-xs font-medium text-brand-dark">
                      {branding.greetingMessage || "Hi there! How can I help you today?"}
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-white border-t border-zinc-50">
                  <div className="p-3 bg-zinc-50 rounded-xl text-xs text-text-muted flex items-center justify-between">
                    Type a message...
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: branding.primaryColor || '#155DEE' }}>
                      <Bot className="w-3.5 h-3.5 text-white" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Floating Trigger Button */}
              <div className="absolute bottom-12 right-12 w-16 h-16 rounded-full shadow-2xl flex items-center justify-center transform hover:scale-110 transition-transform cursor-pointer" style={{ backgroundColor: branding.primaryColor || '#155DEE' }}>
                <MessageSquare className="text-white w-8 h-8" />
              </div>
            </div>

            <div className="mt-8 p-6 bg-primary/5 border border-primary/10 rounded-3xl">
              <p className="text-xs text-primary font-medium leading-relaxed">
                <span className="font-black uppercase tracking-widest text-[9px] block mb-1">Pro Tip</span>
                Changes are reflected in the live preview instantly. Tap "Save Bot Settings" to apply them to your live website widget.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-20 p-10 bg-zinc-900 rounded-[40px] text-white overflow-hidden relative group">
        <Bot className="absolute -right-10 -bottom-10 w-64 h-64 opacity-5 group-hover:scale-110 transition-transform duration-700" />
        <div className="relative z-10">
          <h3 className="text-2xl font-bold mb-4">Preview your Bot</h3>
          <p className="text-zinc-400 mb-8 max-w-md">Remember to test your changes in the playground to ensure the instructions are working as expected.</p>
          <Link to={`/dashboard/playground?projectId=${project.id}`} className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/10 rounded-xl font-bold transition-all">
            Open Playground <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

const ArrowRight = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);
