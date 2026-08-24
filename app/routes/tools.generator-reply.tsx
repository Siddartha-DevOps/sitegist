import { Header } from "~/frontend/components/Header";
import { Footer } from "~/frontend/components/Footer";
import { MessageSquare, Copy, Check, Sparkles, Send, Loader2, RotateCcw } from "lucide-react";
import { useState, useRef, useCallback } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Turnstile } from "~/frontend/components/Turnstile";

export async function loader(_args: LoaderFunctionArgs) {
  return json({ turnstileSiteKey: process.env.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY || "" });
}

export default function ReplyGenerator() {
  const { turnstileSiteKey } = useLoaderData<typeof loader>();
  const [context, setContext] = useState("");
  const [tone, setTone] = useState("professional");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState("");
  const [copied, setCopied] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileVersion, setTurnstileVersion] = useState(0);
  const clearTurnstile = useCallback(() => setTurnstileToken(""), []);
  const resultEndRef = useRef<HTMLDivElement>(null);

  const tones = [
    { id: "professional", label: "Professional", icon: "💼" },
    { id: "friendly", label: "Friendly", icon: "👋" },
    { id: "concise", label: "Concise", icon: "⚡" },
    { id: "empathetic", label: "Empathetic", icon: "❤️" },
    { id: "persuasive", label: "Persuasive", icon: "🎯" },
  ];

  const handleGenerate = async () => {
    if (!context.trim() || (turnstileSiteKey && !turnstileToken)) return;

    setIsGenerating(true);
    setResult("");
    
    const prompt = `Generate a ${tone} reply to the following message/context:
    
    CONTEXT:
    ${context}
    
    REPLY:`;

    try {
      const response = await fetch("/api/tools/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, turnstileToken: turnstileToken || "bypass-token" }),
      });

      if (!response.ok) throw new Error("Failed to start generation");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No reader available");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const raw = decoder.decode(value);
        const lines = raw.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) {
                setResult(prev => prev + data.content);
              }
            } catch (e) {
              console.error("Parse error:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Generation error:", error);
      setResult("Error generating reply. Please try again.");
    } finally {
      setIsGenerating(false);
      if (turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileVersion((version) => version + 1);
      }
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-[#FAF7F2] min-h-screen font-sans">
      <Header />
      <div className="pt-32 pb-20 px-6 max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-light text-brand-gray text-[10px] font-bold uppercase tracking-widest mb-6 border border-brand-border">
            <Sparkles className="w-3 h-3 text-brand-accent" />
            AI Generator
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold text-brand-dark mb-4 tracking-tight leading-tight">
            AI <span className="text-brand-accent">Reply</span> Generator
          </h1>
          <p className="text-brand-gray font-medium max-w-lg mx-auto">
            Paste a message or context, choose a tone, and get a perfectly crafted AI reply in seconds.
          </p>
        </div>

        <div className="grid lg:grid-cols-1 gap-8">
          {/* Input Section */}
          <div className="bg-white p-8 rounded-[40px] border border-brand-border shadow-sm">
            <div className="mb-8">
              <label className="block text-sm font-bold text-brand-dark mb-3">Paste Message or Context</label>
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="e.g., An email from a client asking for a discount, or a support ticket about a delayed order..."
                className="w-full h-48 p-6 bg-brand-light/50 border border-brand-border rounded-3xl outline-none focus:ring-4 focus:ring-brand-accent/5 transition-all resize-none text-brand-dark placeholder:text-brand-gray/40 font-medium"
              />
            </div>

            <div className="mb-10">
              <label className="block text-sm font-bold text-brand-dark mb-4">Choose Tone</label>
              <div className="flex flex-wrap gap-3">
                {tones.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTone(t.id)}
                    className={`px-6 py-3 rounded-2xl border font-bold transition-all flex items-center gap-2 ${
                      tone === t.id
                        ? "bg-brand-dark text-white border-brand-dark shadow-lg shadow-brand-dark/10"
                        : "bg-white text-brand-gray border-brand-border hover:border-brand-accent/30 hover:bg-brand-light"
                    }`}
                  >
                    <span>{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleGenerate}
              disabled={isGenerating || !context.trim() || (!!turnstileSiteKey && !turnstileToken)}
              className="w-full py-5 bg-brand-accent text-white rounded-3xl font-extrabold text-lg flex items-center justify-center gap-3 hover:bg-brand-dark transition-all shadow-xl shadow-brand-accent/10 disabled:opacity-50 disabled:cursor-not-allowed group overflow-hidden relative"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-6 h-6 animate-spin" />
                  Generating Magic...
                </>
              ) : (
                <>
                  <Send className="w-5 h-5 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                  Generate Reply
                </>
              )}
            </button>
            {turnstileSiteKey && (
              <div className="mt-5 flex justify-center">
                <Turnstile key={turnstileVersion} siteKey={turnstileSiteKey} onVerify={setTurnstileToken} onExpire={clearTurnstile} />
              </div>
            )}
          </div>

          {/* Result Section */}
          {(result || isGenerating) && (
            <div className="bg-brand-dark p-10 rounded-[40px] border border-white/5 shadow-2xl relative overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-brand-accent to-transparent opacity-50"></div>
              
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-white font-extrabold text-xl flex items-center gap-3">
                  <div className="w-2 h-6 bg-brand-accent rounded-full"></div>
                  Generated Reply
                </h3>
                <div className="flex gap-3">
                   <button
                    onClick={handleGenerate}
                    className="p-3 bg-white/5 text-white/60 rounded-xl hover:bg-white/10 hover:text-white transition-all"
                    title="Regenerate"
                  >
                    <RotateCcw className="w-5 h-5" />
                  </button>
                  <button
                    onClick={handleCopy}
                    className="px-6 py-3 bg-white text-brand-dark rounded-2xl font-bold text-sm flex items-center gap-2 hover:bg-brand-accent hover:text-white transition-all active:scale-95"
                  >
                    {copied ? <Check className="w-5 h-5 text-brand-online" /> : <Copy className="w-5 h-5" />}
                    {copied ? "Copied!" : "Copy Result"}
                  </button>
                </div>
              </div>

              <div className="bg-white/5 rounded-3xl p-8 border border-white/10 relative">
                <div className="text-white/90 font-medium leading-relaxed whitespace-pre-wrap min-h-[100px]">
                  {result}
                  {isGenerating && <span className="inline-block w-2 h-5 bg-brand-accent ml-1 animate-pulse rounded-sm"></span>}
                </div>
                <div ref={resultEndRef} />
              </div>
              
              <div className="mt-8 flex items-center gap-4 text-white/30 text-[10px] font-bold uppercase tracking-widest">
                <Sparkles className="w-4 h-4" />
                Refined by SiteGist AI
              </div>
            </div>
          )}
        </div>

        {/* Feature Highlights */}
        <div className="mt-32 grid md:grid-cols-3 gap-8">
           {[
             { title: "Smart Context", desc: "Our AI understands the nuance of your messages and replies appropriately.", icon: <MessageSquare className="w-6 h-6 text-brand-accent" /> },
             { title: "Multiple Tones", desc: "Choose from 5+ different tones to match your brand and personality perfectly.", icon: <Sparkles className="w-6 h-6 text-brand-accent" /> },
             { title: "Lightning Fast", desc: "Generate high-quality replies in milliseconds, saving hours of manual work.", icon: <RotateCcw className="w-6 h-6 text-brand-accent" /> }
           ].map((feature, i) => (
             <div key={i} className="p-8 bg-white rounded-[32px] border border-brand-border">
               <div className="w-12 h-12 bg-brand-light rounded-xl flex items-center justify-center mb-6">
                 {feature.icon}
               </div>
               <h4 className="text-brand-dark font-extrabold mb-3">{feature.title}</h4>
               <p className="text-brand-gray text-sm font-medium leading-relaxed">{feature.desc}</p>
             </div>
           ))}
        </div>
      </div>
      <Footer />
    </div>
  );
}
