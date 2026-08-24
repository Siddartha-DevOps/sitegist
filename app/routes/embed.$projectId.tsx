import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { prisma } from "~/database/db.server";
import { hasRemoveBrandingAccess } from "~/lib/plans";
import { toPublicWidgetSettings } from "~/lib/public-widget-settings";
import { useState, useEffect, useRef } from "react";
import { Send, X, Bot, User, Loader2, ThumbsUp, ThumbsDown, Check, ExternalLink } from "lucide-react";
import Markdown from "react-markdown";

function computeIsOffline(bh: any): boolean {
  if (!bh?.enabled) return false;
  const tz = bh.timezone || "UTC";
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value?.toLowerCase() ?? "";
  const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const current = hour * 60 + minute;
  const dayMap: Record<string, number> = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const dayIdx = dayMap[weekday] ?? -1;
  const enabledDays: number[] = bh.days ?? [1,2,3,4,5];
  if (!enabledDays.includes(dayIdx)) return true;
  const [sh, sm] = (bh.startTime || "09:00").split(":").map(Number);
  const [eh, em] = (bh.endTime || "17:00").split(":").map(Number);
  return current < sh * 60 + sm || current >= eh * 60 + em;
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { name: true, settings: true, id: true, status: true, userId: true }
  });
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const pageUrl = url.searchParams.get("pageUrl") || null;
  const pageTitle = url.searchParams.get("pageTitle") || null;

  if (project.status !== "ACTIVE") {
    return json({
      project: { id: project.id, name: project.name, status: project.status, settings: toPublicWidgetSettings(project.settings) },
      notReady: true,
      isOffline: false,
      offlineMessage: null,
      pageUrl,
      pageTitle,
    });
  }

  // Enforce remove-branding gate at render time
  const settings = project.settings as any;
  const isOffline = computeIsOffline(settings?.businessHours);
  const offlineMessage =
    (typeof settings?.businessHours?.offlineMessage === "string" && settings.businessHours.offlineMessage.trim())
      ? settings.businessHours.offlineMessage.trim()
      : "We're currently outside business hours. Please check back soon.";

  if (settings?.branding?.removeBranding) {
    const [user, addons] = await Promise.all([
      prisma.user.findUnique({ where: { id: project.userId }, select: { subscriptionTier: true } }),
      prisma.userAddon.findMany({ where: { userId: project.userId, status: "active" }, select: { type: true, status: true } }),
    ]);
    if (!hasRemoveBrandingAccess(user?.subscriptionTier, addons)) {
      const enforced = { ...settings, branding: { ...settings.branding, removeBranding: false } };
      return json({
        project: { id: project.id, name: project.name, status: project.status, settings: toPublicWidgetSettings(enforced) },
        notReady: false,
        isOffline,
        offlineMessage,
        pageUrl,
        pageTitle,
      });
    }
  }

  return json({
    project: { id: project.id, name: project.name, status: project.status, settings: toPublicWidgetSettings(project.settings) },
    notReady: false,
    isOffline,
    offlineMessage,
    pageUrl,
    pageTitle,
  });
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const name = data?.project?.name ?? "AI Assistant";
  const description = `Chat with ${name} — powered by SiteGist`;
  const url = `https://app.sitegist.co/embed/${data?.project?.id ?? ""}`;

  return [
    { title: name },
    { name: "description", content: description },
    // Open Graph — for Slack/Twitter/iMessage link previews
    { property: "og:title", content: name },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: url },
    // Prevent search indexing — these are customer bots, not SEO content
    { name: "robots", content: "noindex, nofollow" },
  ];
};

export default function EmbedChat() {
  const { project, notReady, isOffline, offlineMessage, pageUrl, pageTitle } = useLoaderData<typeof loader>();
  const [isEmbedded, setIsEmbedded] = useState(true); // default true to avoid flash
  const [messages, setMessages] = useState<{ id?: string, role: 'user' | 'assistant', content: string, feedback?: number, citations?: any[], followups?: string[], timestamp?: Date }[]>([]);
  const [input, setInput] = useState("");
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [rateLimit, setRateLimit] = useState<{ remaining: number; window: string } | null>(null);
  const chatFetcher = useFetcher();
  const leadFetcher = useFetcher();
  const scrollRef = useRef<HTMLDivElement>(null);
  const offlineNotice = offlineMessage || "We're currently outside business hours. Please check back soon.";

  useEffect(() => {
    setIsEmbedded(window.self !== window.top);
  }, []);

  const settings = project.settings as any;
  const branding = settings?.branding || {};
  const removeBranding = branding.removeBranding || false;
  const primaryColor = branding.primaryColor || "#6C5CE7";
  const assistantName = branding.assistantName || "Support AI";
  const assistantLogo = branding.assistantLogo;
  const greetingMessage = branding.greetingMessage || "Hi there! How can I help you today?";
  const suggestions = branding.suggestions || [];
  const bubbleShape = branding.bubbleShape || "rounded-2xl";
  const font = branding.font || "sans";
  const leadPolicy = branding.leadPolicy || "keywords";
  const leadFields = (settings?.leadFields as any[]) || [];

  const storageKey = `sitegist_session_${project.id}`;

  useEffect(() => {
    if (primaryColor) {
      window.parent.postMessage({ type: 'sitegist-theme', color: primaryColor }, '*');
    }
  }, [primaryColor]);

  useEffect(() => {
    const proactive = branding.proactive || {};
    const delayMs =
      typeof proactive.delayMs === "number" && Number.isFinite(proactive.delayMs)
        ? Math.max(0, Math.round(proactive.delayMs))
        : 5000;
    const message =
      typeof proactive.message === "string" && proactive.message.trim()
        ? proactive.message.trim()
        : "Need help?";
    window.parent.postMessage(
      {
        type: "sitegist:proactive", // pragma: allowlist secret
        enabled: !!proactive.enabled,
        delayMs,
        message,
      },
      "*"
    );
  }, [branding.proactive]);

  const handleFeedback = async (messageId: string, val: number) => {
    if (!sessionId || !sessionToken) return;
    setFeedbackLoading(messageId);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, sessionId, sessionToken, feedback: val }),
      });
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, feedback: val } : m));
    } catch (e) {
      console.error(e);
    } finally {
      setFeedbackLoading(null);
    }
  };

  useEffect(() => {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setIsDarkMode(isDark);

    // Initial Lead Form Logic
    if (leadPolicy === "pre-chat" && !sessionId) {
      setShowLeadForm(true);
    }

    // Persist session ID
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(storageKey);
      if (saved) setSessionId(saved);
      setSessionToken(localStorage.getItem(`${storageKey}_token`));
      setRealtimeToken(localStorage.getItem(`${storageKey}_realtime`));
    }
  }, [leadPolicy, sessionId, storageKey]);

  useEffect(() => {
    if (sessionId) {
      localStorage.setItem(storageKey, sessionId);
    }
    if (sessionToken) localStorage.setItem(`${storageKey}_token`, sessionToken);
    if (realtimeToken) localStorage.setItem(`${storageKey}_realtime`, realtimeToken);
  }, [sessionId, sessionToken, realtimeToken, storageKey]);

  const handleSend = async (text?: string) => {
    const messageToSend = text || input;
    if (!messageToSend.trim() || isStreaming || isOffline) return;
    
    setInput("");
    setIsStreaming(true);
    setIsTyping(true);
    const now = new Date();
    setMessages(prev => [...prev, { role: 'user', content: messageToSend, timestamp: now }]);
    setMessages(prev => [...prev, { role: 'assistant', content: "", timestamp: new Date() }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, message: messageToSend, sessionId, sessionToken, pageUrl, pageTitle }),
      });

      if (response.status === 429) {
        let limitMsg = "You've reached today's message limit. Please check back later.";
        try {
          const errData = await response.json();
          if (errData?.message) limitMsg = errData.message;
        } catch {}

        setMessages(prev => {
          const newMsgs = [...prev];
          const last = newMsgs[newMsgs.length - 1];
          if (last && last.role === 'assistant' && !last.content) {
            newMsgs[newMsgs.length - 1] = { ...last, content: limitMsg };
          }
          return newMsgs;
        });
        setIsTyping(false);
        setIsStreaming(false);
        return;
      }

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        
        // Keep potential partial line in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("data: ")) {
            // Every SSE payload (content chunks AND the session/messageId/
            // metadata/ratelimit events) arrives on its own `data: ` line, so a
            // single handler must process them all. A previous second `data:`
            // branch below was unreachable — this `if` matched first — which
            // silently dropped sessionId (breaking multi-turn memory), messageId
            // (breaking feedback), citations, and the rate-limit banner.
            try {
              const data = JSON.parse(trimmed.slice(6));
              if (data.content) {
                // First real token arrived — hide the typing indicator
                setIsTyping(false);
                accumulated += data.content;
                setMessages(prev => {
                  const newMsgs = [...prev];
                  newMsgs[newMsgs.length - 1] = { ...newMsgs[newMsgs.length - 1], content: accumulated };
                  return newMsgs;
                });
              }
              if (data.sessionId) {
                setSessionId(data.sessionId);
              }
              if (data.sessionToken) setSessionToken(data.sessionToken);
              if (data.realtimeToken) setRealtimeToken(data.realtimeToken);
              if (data.messageId) {
                setMessages(prev => {
                  const newMsgs = [...prev];
                  newMsgs[newMsgs.length - 1] = { ...newMsgs[newMsgs.length - 1], id: data.messageId };
                  return newMsgs;
                });
              }
              // Server sends grounding under `sources` (api.chat.ts); accept
              // `citations` too for forward-compat.
              const cites = data.sources || data.citations;
              if (cites) {
                setMessages(prev => {
                  const newMsgs = [...prev];
                  newMsgs[newMsgs.length - 1] = { ...(newMsgs[newMsgs.length - 1] as any), citations: cites };
                  return newMsgs;
                });
              }
              if (data.remaining !== undefined) {
                setRateLimit({ remaining: data.remaining, window: data.window });
              }
              // Follow-up suggestions arrive as a bare JSON array (event:
              // suggestions). Attach them to the assistant message so we render
              // clickable chips instead of discarding the LLM call that made them.
              if (Array.isArray(data)) {
                const chips = data.filter((s: any) => typeof s === "string" && s.trim());
                if (chips.length > 0) {
                  setMessages(prev => {
                    const newMsgs = [...prev];
                    newMsgs[newMsgs.length - 1] = { ...newMsgs[newMsgs.length - 1], followups: chips };
                    return newMsgs;
                  });
                }
              }
            } catch (e) { }
          } else if (trimmed.startsWith("event: handoff")) {
            if (leadPolicy === "handoff" || leadPolicy === "keywords") {
              setTimeout(() => setShowLeadForm(true), 1000);
            }
          }
          // Other `event: ` lines (session/metadata/messageId/ratelimit) carry no
          // action themselves — their JSON arrives on the following `data: ` line
          // handled above.
        }
      }

      // Intelligent keyword-based lead collection. Match the VISITOR's message
      // for explicit contact/sales intent — not the bot's answer, which used to
      // pop the form whenever a reply merely mentioned "pricing" or "email".
      if (leadPolicy === "keywords") {
        const userText = messageToSend.toLowerCase();
        const intentPhrases = [
          "contact me", "contact us", "get in touch", "reach out", "reach me",
          "call me", "email me", "talk to sales", "speak to sales", "talk to someone",
          "book a demo", "schedule a demo", "request a demo", "get a demo",
          "get a quote", "request a quote", "pricing quote", "sign up", "sign me up",
        ];
        const shouldShow = intentPhrases.some(t => userText.includes(t));
        if (shouldShow) {
          setTimeout(() => setShowLeadForm(true), 1500);
        }
      }

    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => {
        const newMsgs = [...prev];
        const last = newMsgs[newMsgs.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          newMsgs[newMsgs.length - 1] = { ...last, content: "⚠️ Sorry, I'm having trouble connecting right now. Please try again or contact support." };
        }
        return newMsgs;
      });
    } finally {
      setIsTyping(false);
      setIsStreaming(false);
    }
  };

  const ensureWidgetSession = async () => {
    if (sessionId && sessionToken) return { sessionId, sessionToken };
    const response = await fetch("/api/widget/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, pageUrl, pageTitle }),
    });
    if (!response.ok) throw new Error("Unable to establish a secure widget session");
    const data = await response.json();
    setSessionId(data.sessionId);
    setSessionToken(data.sessionToken);
    if (data.realtimeToken) setRealtimeToken(data.realtimeToken);
    return { sessionId: data.sessionId as string, sessionToken: data.sessionToken as string };
  };

  const handleLeadSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = Object.fromEntries(formData);
    try {
      const auth = await ensureWidgetSession();
      leadFetcher.submit(
        JSON.stringify({ ...data, projectId: project.id, ...auth }),
        { method: "post", action: "/api/lead", encType: "application/json" }
      );
    } catch (error) {
      console.error("Lead session setup failed:", error);
    }
  };

  useEffect(() => {
    if (leadFetcher.data && leadFetcher.state === "idle") {
      const resp = leadFetcher.data as any;
      if (resp.success) {
        setShowLeadForm(false);
        setMessages(prev => [...prev, { role: 'assistant', content: "Thanks! We've received your contact info. How else can I help?" }]);
      }
    }
  }, [leadFetcher.data, leadFetcher.state]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (notReady) {
    return (
      <div className="flex h-screen items-center justify-center text-zinc-500 text-sm p-4 text-center">
        This chatbot is still being set up. Check back soon.
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-screen relative transition-colors duration-300 ${font === 'serif' ? 'font-serif' : font === 'mono' ? 'font-mono' : 'font-sans'} ${isDarkMode ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-zinc-900'}`}>
      <style>{`
        .typing-indicator {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 0;
        }
        .typing-indicator span {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background-color: currentColor;
          opacity: 0.35;
          animation: sitegist-typing 1.2s infinite ease-in-out both;
        }
        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes sitegist-typing {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
      `}</style>
      {/* Lead Form Overlay */}
      {showLeadForm && (
        <div className={`absolute inset-0 z-50 p-8 flex flex-col items-center justify-center animate-in fade-in slide-in-from-bottom-4 ${isDarkMode ? 'bg-zinc-950' : 'bg-white'}`}>
          <div className="w-full max-w-xs text-center">
            <div className={`w-16 h-16 rounded-3xl flex items-center justify-center mx-auto mb-6 overflow-hidden ${isDarkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
              {assistantLogo ? (
                <img src={assistantLogo} alt={assistantName} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <Bot className="text-primary w-8 h-8" />
              )}
            </div>
            <h2 className="text-2xl font-black mb-2">Get in touch</h2>
            <p className={`text-sm mb-8 ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>Leave your details and we'll get back to you shortly.</p>
            
            <form onSubmit={handleLeadSubmit} className="space-y-4 text-left w-full">
              <div className="space-y-4 max-h-[280px] overflow-y-auto pr-1 py-1">
                <div>
                  <label className="block text-xs font-bold mb-1.5 ml-1">Name</label>
                  <input name="name" required className={`w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-primary/20 outline-none transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-50 border-zinc-100'}`} placeholder="John Doe" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1.5 ml-1">Email</label>
                  <input type="email" name="email" required className={`w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-primary/20 outline-none transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-50 border-zinc-100'}`} placeholder="john@example.com" />
                </div>

                {leadFields.map(field => (
                  <div key={field.id} className="space-y-1.5">
                    <label className="block text-xs font-bold mb-1.5 ml-1">
                      {field.label}{field.required && <span className="text-red-500 ml-0.5">*</span>}
                    </label>

                     {field.type === 'text' && (
                       <input
                         name={`custom_${field.id}`}
                         required={field.required}
                         className={`w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-primary/20 outline-none transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-zinc-50 border-zinc-100 text-zinc-900'}`}
                         placeholder={field.label}
                       />
                     )}

                     {field.type === 'dropdown' && (
                       <select
                         name={`custom_${field.id}`}
                         required={field.required}
                         className={`w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-primary/20 outline-none transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-zinc-100' : 'bg-zinc-50 border-zinc-100 text-zinc-900'}`}
                       >
                         <option value="">Select…</option>
                         {(field.options || []).map((opt: string) => (
                           <option key={opt} value={opt}>{opt}</option>
                         ))}
                       </select>
                     )}

                     {field.type === 'checkbox' && (
                       <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                         <input
                           type="checkbox"
                           name={`custom_${field.id}`}
                           value="yes"
                           className="w-4 h-4 rounded border-zinc-300 text-primary focus:ring-primary/10 cursor-pointer"
                         />
                         <span className="text-sm font-semibold">{field.label}</span>
                       </label>
                     )}
                  </div>
                ))}
              </div>
              <button 
                type="submit" 
                disabled={leadFetcher.state !== "idle"}
                className="w-full py-4 bg-primary text-white rounded-xl font-bold mt-4 shadow-lg shadow-primary/20 hover:scale-105 active:scale-95 transition-all flex items-center justify-center"
              >
                {leadFetcher.state !== "idle" ? <Loader2 className="w-5 h-5 animate-spin" /> : "Send Details"}
              </button>
              <button type="button" onClick={() => setShowLeadForm(false)} className="w-full py-3 text-zinc-400 text-xs font-bold hover:text-zinc-600 transition-colors">
                Skip for now
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Header */}
      <header className={`p-4 flex items-center justify-between border-b ${isDarkMode ? 'border-zinc-800' : 'border-zinc-100'}`} style={{ backgroundColor: primaryColor }}>
        <div className="flex items-center gap-3 text-white">
          <div className="w-10 h-10 bg-white/20 rounded-xl overflow-hidden flex items-center justify-center shadow-inner">
            {assistantLogo ? (
              <img src={assistantLogo} alt={assistantName} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <Bot className="w-6 h-6" />
            )}
          </div>
          <div>
            <h1 className="font-bold text-sm">{assistantName}</h1>
            <p className="text-[10px] opacity-80 uppercase tracking-widest font-medium">
              {isOffline ? "Assistant • Offline" : "Assistant • Online"}
            </p>
            {isOffline && (
              <p className="text-[10px] opacity-70 font-medium mt-0.5">Outside business hours</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-1.5 hover:bg-white/10 rounded-lg text-white transition-colors"
          >
            {isDarkMode ? "🌙" : "☀️"}
          </button>
          {isEmbedded && (
            <button 
              onClick={() => window.parent.postMessage('sitegist-close', '*')}
              className="p-1.5 hover:bg-white/10 rounded-lg text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {/* Offline banner */}
      {isOffline && (
        <div className={`px-4 py-3 text-sm border-b ${isDarkMode ? 'bg-amber-950/40 border-zinc-800 text-amber-200' : 'bg-amber-50 border-amber-100 text-amber-900'}`}>
          <p className="font-bold text-xs uppercase tracking-wider mb-0.5">Outside business hours</p>
          <p className="text-xs leading-relaxed opacity-90">{offlineNotice}</p>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center py-10 px-6">
            <div className={`w-16 h-16 rounded-3xl flex items-center justify-center mx-auto mb-4 border shadow-sm overflow-hidden ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-50 border-zinc-100'}`}>
               {assistantLogo ? (
                <img src={assistantLogo} alt={assistantName} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <Bot className="text-primary w-8 h-8" />
              )}
            </div>
            <h2 className="font-bold mb-2">Welcome to {project.name}!</h2>
            <p className={`text-sm mb-8 ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
              {isOffline ? offlineNotice : greetingMessage}
            </p>
            
            {!isOffline && suggestions.length > 0 && (
              <div className="flex flex-col gap-2">
                {suggestions.map((s: string) => (
                  <button 
                    key={s}
                    onClick={() => handleSend(s)}
                    className={`w-full p-4 border rounded-2xl text-xs font-bold transition-all text-left flex items-center justify-between group ${
                      isDarkMode 
                        ? 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-primary hover:text-primary' 
                        : 'bg-white border-zinc-100 text-zinc-600 hover:border-primary hover:text-primary hover:shadow-lg hover:shadow-primary/5'
                    }`}
                  >
                    {s}
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${isDarkMode ? 'bg-zinc-800' : 'bg-zinc-50'} group-hover:bg-primary group-hover:text-white`}>
                      <Send className="w-2.5 h-2.5" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`max-w-[85%] p-3.5 ${bubbleShape} text-sm leading-relaxed prose prose-zinc prose-sm ${
              msg.role === 'user' 
                ? 'bg-zinc-900 text-white rounded-br-none shadow-sm' 
                : `${isDarkMode ? 'bg-zinc-900 text-zinc-200' : 'bg-zinc-100 text-zinc-800'} rounded-bl-none`
            }`}>
              {msg.role === 'assistant' && isTyping && i === messages.length - 1 && !msg.content ? (
                <div className="typing-indicator" aria-label="Assistant is typing">
                  <span></span><span></span><span></span>
                </div>
              ) : (
                <Markdown>{msg.content}</Markdown>
              )}
              
              {msg.role === 'assistant' && (msg as any).citations?.length > 0 && (
                <div className="mt-3 pt-3 border-t border-zinc-500/10">
                  <p className="text-[9px] font-black uppercase tracking-wider text-zinc-400 mb-1.5 underline decoration-primary">Sources</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(msg as any).citations.map((cite: any, i: number) => (
                      <a 
                        key={i}
                        href={cite.url || cite.source}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-white/20 border border-zinc-500/10 rounded-md text-[9px] font-bold text-primary hover:text-primary-dark transition-all no-underline"
                      >
                        <ExternalLink className="w-2.5 h-2.5" /> {cite.title || 'Source'}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {msg.timestamp && (
              <span className="text-[9px] mt-1 opacity-40 font-bold uppercase tracking-wider px-1">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            
            {msg.role === 'assistant' && msg.content && (
              <div className="flex items-center gap-2 mt-1 ml-1">
                <button 
                  onClick={() => msg.id && handleFeedback(msg.id, 1)}
                  className={`p-1 rounded-md hover:bg-zinc-100 transition-colors ${msg.feedback === 1 ? 'text-green-500' : 'text-zinc-400'}`}
                >
                  <ThumbsUp className="w-3 h-3" />
                </button>
                <button
                  onClick={() => msg.id && handleFeedback(msg.id, -1)}
                  className={`p-1 rounded-md hover:bg-zinc-100 transition-colors ${msg.feedback === -1 ? 'text-red-500' : 'text-zinc-400'}`}
                >
                  <ThumbsDown className="w-3 h-3" />
                </button>
              </div>
            )}

            {msg.role === 'assistant' && !isStreaming && !isOffline && (msg.followups?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-1.5 mt-2 ml-1">
                {msg.followups!.map((f, fi) => (
                  <button
                    key={fi}
                    onClick={() => handleSend(f)}
                    className={`text-left text-xs font-semibold px-3 py-2 rounded-xl border transition-all w-fit max-w-full ${
                      isDarkMode
                        ? 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-primary hover:text-primary'
                        : 'bg-white border-zinc-100 text-zinc-600 hover:border-primary hover:text-primary hover:shadow-sm'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {/* Loading dots... */}
      </div>

      {/* Input */}
      <div className={`p-4 border-t ${isDarkMode ? 'border-zinc-800' : 'border-zinc-100'}`}>
        {isOffline ? (
          <div className={`px-4 py-3 rounded-2xl text-sm text-center ${isDarkMode ? 'bg-zinc-900 text-zinc-400 border border-zinc-800' : 'bg-zinc-50 text-zinc-500 border border-zinc-100'}`}>
            Chat is unavailable outside business hours.
          </div>
        ) : (
        <div className={`flex items-center gap-2 border rounded-2xl px-4 py-2 focus-within:ring-2 focus-within:ring-primary/20 transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-50 border-zinc-100'}`}>
          <input 
            type="text" 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type your message..."
            disabled={isStreaming}
            className="flex-1 bg-transparent py-2 text-sm outline-none disabled:opacity-50"
          />
          <button 
            onClick={() => handleSend()}
            disabled={!input.trim() || isStreaming}
            className="p-2 bg-primary text-white rounded-xl disabled:opacity-30 transition-all active:scale-95 shadow-lg shadow-primary/20"
          >
            {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        )}
        {rateLimit && rateLimit.remaining <= 5 && (
          <p className="text-[10px] text-center text-zinc-400 mt-2 font-bold tracking-wide uppercase select-none">
            {rateLimit.remaining} message{rateLimit.remaining !== 1 ? 's' : ''} remaining {rateLimit.window === 'hour' ? 'this hour' : 'today'}
          </p>
        )}
        {!removeBranding && (
          <p className="text-[9px] text-center text-zinc-400 mt-3 font-medium tracking-wider">POWERED BY SITEGIST</p>
        )}
      </div>
    </div>
  );
}
