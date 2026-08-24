import { useEffect, useRef } from "react";

interface TurnstileProps {
  siteKey: string;
  onVerify?: (token: string) => void;
  onExpire?: () => void;
  options?: {
    theme?: "light" | "dark" | "fallback";
  };
}

export function Turnstile({ siteKey, options, onVerify, onExpire }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    const initTurnstile = () => {
      if (!active) return;
      
      const turnstile = (window as any).turnstile;
      if (turnstile && containerRef.current) {
        try {
          // Clear any residual elements before render
          containerRef.current.innerHTML = "";
          
          const id = turnstile.render(containerRef.current, {
            sitekey: siteKey,
            theme: options?.theme || "light",
            callback: (token: string) => onVerify?.(token),
            "expired-callback": () => onExpire?.(),
            "error-callback": () => onExpire?.(),
          });
          widgetIdRef.current = id;
        } catch (err) {
          console.warn("[Turnstile] Explicit render failed, falling back to implicit:", err);
        }
      }
    };

    if (typeof window !== "undefined") {
      const handleError = (event: ErrorEvent) => {
        const isTurnstileError = 
          event.message?.includes("Script error") || 
          event.filename?.includes("cloudflare") ||
          event.error?.stack?.includes("cloudflare");
          
        if (isTurnstileError) {
          try {
            event.preventDefault();
          } catch (e) {}
          console.warn("[Turnstile] Suppressed cross-origin iframe check error:", event.message);
        }
      };

      const handleRejection = (event: PromiseRejectionEvent) => {
        const reasonStr = String(event.reason || "");
        if (reasonStr.includes("cloudflare") || reasonStr.includes("Turnstile")) {
          try {
            event.preventDefault();
          } catch (e) {}
          console.warn("[Turnstile] Suppressed unhandled rejection:", event.reason);
        }
      };

      window.addEventListener("error", handleError);
      window.addEventListener("unhandledrejection", handleRejection);

      const existingScript = document.getElementById("cloudflare-turnstile-script");
      if (!existingScript) {
        const script = document.createElement("script");
        script.id = "cloudflare-turnstile-script";
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback";
        script.async = true;
        script.defer = true;
        
        script.onerror = (e) => {
          console.warn("[Turnstile] Script failed to load. This can happen in sandboxed iframe environments or when blocked by privacy extensions.", e);
        };
        
        (window as any).onloadTurnstileCallback = () => {
          if (active) {
            initTurnstile();
          }
        };

        document.body.appendChild(script);
      } else {
        if ((window as any).turnstile) {
          initTurnstile();
        } else {
          const interval = setInterval(() => {
            if ((window as any).turnstile) {
              clearInterval(interval);
              initTurnstile();
            }
          }, 100);
          return () => {
            active = false;
            clearInterval(interval);
            window.removeEventListener("error", handleError);
            window.removeEventListener("unhandledrejection", handleRejection);
          };
        }
      }

      return () => {
        active = false;
        window.removeEventListener("error", handleError);
        window.removeEventListener("unhandledrejection", handleRejection);
        if (widgetIdRef.current && (window as any).turnstile) {
          try {
            (window as any).turnstile.remove(widgetIdRef.current);
          } catch (err) {
            // Ignore
          }
        }
      };
    }
  }, [siteKey, options?.theme, onVerify, onExpire]);

  return (
    <div 
      ref={containerRef} 
      className="cf-turnstile-container h-[65px] max-h-[65px] overflow-hidden flex items-start justify-center w-full min-w-[250px]" 
    />
  );
}
