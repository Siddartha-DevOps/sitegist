import {
  isRouteErrorResponse,
  json,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useLocation,
  useRouteError,
  useRouteLoaderData
} from "@remix-run/react";
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { pageMeta } from "~/lib/seo";
import React from "react";
import { Bot, Database, Key, AlertTriangle } from "lucide-react";

import "./frontend/styles/tailwind.css";
import { Header } from "./frontend/components/Header";
import { BlogHeader } from "./frontend/components/BlogHeader";
import { ChatWidget } from "./frontend/components/ChatWidget";

export async function loader({ request }: LoaderFunctionArgs) {
  return json({
    ENV: {
      VITE_POSTHOG_KEY: process.env.VITE_POSTHOG_KEY,
      VITE_POSTHOG_HOST: process.env.VITE_POSTHOG_HOST,
      PARTYKIT_HOST: process.env.PARTYKIT_HOST,
      VITE_CLOUDFLARE_TURNSTILE_SITE_KEY: process.env.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY || process.env.CLOUDFLARE_TURNSTILE_SITE_KEY,
      VITE_PADDLE_CLIENT_TOKEN: process.env.VITE_PADDLE_CLIENT_TOKEN,
      PADDLE_ENVIRONMENT: process.env.PADDLE_ENVIRONMENT,
      // Deployed build marker — lets you confirm from the live page which commit
      // production is actually serving (Vercel sets VERCEL_GIT_COMMIT_SHA).
      BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
      // Sentry DSN is public by design (it's a write-only key) — safe to ship to
      // the client for browser error capture. NODE_ENV tags the environment.
      SENTRY_DSN: process.env.SENTRY_DSN,
      NODE_ENV: process.env.NODE_ENV,
    },
  });
}

// Default meta for every route that doesn't export its own (Remix v2: a leaf
// route's meta replaces this). Gives sane link previews site-wide.
export const meta: MetaFunction = () =>
  pageMeta({
    title: "SiteGist — AI chatbot & lead generation for your website",
    description:
      "Train an AI chatbot on your website content in minutes. Answer customer questions 24/7, capture leads, and hand off to humans — embeddable anywhere.",
  });

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>SiteGist — AI-Powered Customer Support</title>
        <meta name="description" content="SiteGist understands your site and delivers instant, accurate answers to your customers — 24/7. No humans required." />
        <meta name="theme-color" content="#155DEE" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="SiteGist" />
        <meta property="og:title" content="SiteGist — AI-Powered Customer Support" />
        <meta property="og:description" content="SiteGist understands your site and delivers instant, accurate answers to your customers — 24/7." />
        <meta property="og:image" content="/images/hero.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:url" content="https://sitegist.co" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="SiteGist — AI-Powered Customer Support" />
        <meta name="twitter:description" content="SiteGist understands your site and delivers instant, accurate answers — 24/7." />
        <meta name="twitter:image" content="/images/hero.png" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var originalOnError = window.onerror;
                window.onerror = function(message, source, lineno, colno, error) {
                  var msg = String(message || '');
                  var src = String(source || '');
                  if (msg.indexOf('Script error') > -1 || msg.indexOf('cloudflare') > -1 || msg.indexOf('turnstile') > -1 || src.indexOf('cloudflare') > -1) {
                    console.warn('[SiteGist Guard] Gracefully suppressed cross-origin sandbox script event:', message);
                    return true;
                  }
                  if (originalOnError) {
                    return originalOnError.apply(this, arguments);
                  }
                  return false;
                };

                window.addEventListener('error', function(event) {
                  var msg = String(event.message || '');
                  if (msg.indexOf('Script error') > -1 || msg.indexOf('cloudflare') > -1 || msg.indexOf('turnstile') > -1) {
                    try {
                      event.preventDefault();
                      event.stopImmediatePropagation();
                    } catch(e){}
                  }
                }, true);

                window.addEventListener('unhandledrejection', function(event) {
                  var reason = String(event.reason || '');
                  if (reason.indexOf('cloudflare') > -1 || reason.indexOf('turnstile') > -1 || reason.indexOf('Script error') > -1) {
                    try {
                      event.preventDefault();
                      event.stopImmediatePropagation();
                    } catch(e){}
                  }
                }, true);
              })();
            `
          }}
        />
        <script
          defer
          data-website-id="dfid_jdhKNHuiQeBJuwVkakfYd"
          data-domain="stegist.co"
          src="https://datafa.st/js/script.js"
        ></script>
        <script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
        <Meta />
        <Links />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("ErrorBoundary caught an unhandled exception:", error);

  // Loaders/actions can `throw json({ dbError: true, message }, { status: 503 })`
  // to surface a real database error. Thrown Responses (unlike thrown Errors) are
  // NOT scrubbed to "Unexpected Server Error" by Remix in production, so the real
  // message survives to here for the operator to diagnose.
  const routeErrorData =
    isRouteErrorResponse(error) && error.data && typeof error.data === "object"
      ? (error.data as { dbError?: boolean; message?: string })
      : null;
  const isThrownDbError = !!routeErrorData?.dbError;

  const errorString = isThrownDbError
    ? String(routeErrorData?.message || "Database error")
    : error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);

  const isPrismaAuthError = errorString.includes("P6002") || errorString.includes("API key is invalid") || (errorString.includes("Unauthorized") && errorString.toLowerCase().includes("accelerate"));
  const isGenericDbError = !isPrismaAuthError && (
    isThrownDbError ||
    errorString.includes("Can't reach database") ||
    errorString.toLowerCase().includes("prisma") ||
    errorString.toLowerCase().includes("database")
  );

  const is404 = isRouteErrorResponse(error) && error.status === 404;

  if (isPrismaAuthError) {
    return (
      <div className="bg-[#F8FAFC] min-h-screen flex items-center justify-center p-6 text-[#1E293B]">
        <div className="max-w-xl w-full bg-white p-8 md:p-10 rounded-[32px] border border-amber-200 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-2 bg-gradient-to-r from-amber-400 via-orange-500 to-amber-400" />
          
          <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600 mb-6">
            <Key className="w-8 h-8" />
          </div>
          
          <h1 className="text-2xl font-black mb-3 text-zinc-900 tracking-tight flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0" /> Database Key Mismatch (Prisma P6002)
          </h1>
          
          <p className="text-zinc-600 text-sm font-bold mb-6 leading-relaxed">
            Your application's database connection is configured to use <span className="text-indigo-600 font-extrabold">Prisma Accelerate</span>, but the security API key embedded in your <span className="bg-slate-100 px-1 py-0.5 rounded font-mono text-[11px]">DATABASE_URL</span> is invalid or has expired.
          </p>

          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6 mb-8 text-left space-y-4">
            <div className="text-xs font-black text-slate-400 uppercase tracking-wider">How to Fix This Step-by-Step:</div>
            <ol className="list-decimal list-inside space-y-3 text-xs font-bold text-slate-700">
              <li>
                <span className="text-zinc-950 font-black">Open AI Studio Settings:</span> Go to the top-right corner of the AI Studio workspace and click on <span className="text-indigo-600 font-extrabold">Settings &gt; Environment Variables</span>.
              </li>
              <li>
                <span className="text-zinc-950 font-black">Verify Your URL:</span> Locate the <span className="bg-slate-200 px-1 py-0.5 rounded font-mono text-[10px] text-slate-800">DATABASE_URL</span>. It should begin with <span className="font-mono text-zinc-500 text-[10px]">prisma+postgres://</span> or <span className="font-mono text-zinc-500 text-[10px]">postgresql://</span>.
              </li>
              <li>
                <span className="text-zinc-950 font-black">Regenerate Key:</span> Visit your <a href="https://console.prisma.io" target="_blank" rel="noreferrer" className="text-indigo-600 underline font-black hover:text-indigo-800">Prisma Data Platform Console</a>, regenerate your connection string, paste it inside AI Studio settings, and save.
              </li>
            </ol>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-2">
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-zinc-900 text-white px-6 py-3 rounded-xl font-bold hover:bg-black transition-all cursor-pointer"
            >
              Retry Connection
            </button>
            <a
              href="/"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-100 text-slate-800 px-6 py-3 rounded-xl font-bold hover:bg-slate-200 transition-all text-center"
            >
              Back to Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (isGenericDbError) {
    return (
      <div className="bg-[#F8FAFC] min-h-screen flex items-center justify-center p-6 text-[#1E293B]">
        <div className="max-w-xl w-full bg-white p-8 md:p-10 rounded-[32px] border border-blue-200 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-2 bg-blue-500" />
          
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mb-6">
            <Database className="w-8 h-8" />
          </div>
          
          <h1 className="text-2xl font-black mb-3 text-zinc-900 tracking-tight">
            Database Connection Offline
          </h1>
          
          <p className="text-zinc-600 text-sm font-bold mb-6 leading-relaxed">
            The application failed to connect to the database. This typically happens during sudden traffic spikes or when your PostgreSQL instances are completing a routine maintenance cycle.
          </p>

          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6 mb-8 text-left">
            <div className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2">Technical Summary:</div>
            <div className="bg-zinc-950 text-emerald-400 p-4 rounded-xl font-mono text-[11px] leading-relaxed break-all max-h-32 overflow-y-auto w-full">
              {errorString}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-end gap-3">
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-blue-700 transition-all cursor-pointer"
            >
              Retry Connection
            </button>
            <a
              href="/"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-100 text-slate-800 px-6 py-3 rounded-xl font-bold hover:bg-slate-200 transition-all text-center"
            >
              Back to Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#FAF9F6] min-h-screen flex items-center justify-center p-6 text-[#1E293B]">
      <div className="max-w-md w-full bg-white p-8 rounded-[32px] border border-[#E2E8F0] shadow-xl text-center">
        <div className="w-16 h-16 bg-[#EFF6FF] rounded-2xl flex items-center justify-center text-[#2563EB] mx-auto mb-6">
          <Bot className="w-8 h-8 text-[#155DEE]" />
        </div>
        <h1 className="text-2xl font-extrabold mb-3 tracking-tight">
          {is404 ? "This Page has Wandered Off" : "Let's Re-establish Contact"}
        </h1>
        <p className="text-[#64748B] text-sm font-medium mb-8 leading-relaxed">
          {is404
            ? "The page you're seeking couldn't be located. Let me guide you back to secure ground."
            : "We are currently streamlining our secure assistant connections to handle your request. Let's refresh the assistant or head back to the main portal."}
        </p>
        {!is404 && errorString && (
          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 mb-8 text-left">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Error Diagnostics:</div>
            <div className="text-red-600 font-mono text-[11px] leading-relaxed break-all max-h-24 overflow-y-auto w-full font-bold">
              {errorString}
            </div>
          </div>
        )}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={() => {
              if (typeof window !== "undefined") {
                window.location.reload();
              }
            }}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#155DEE] text-white px-6 py-3 rounded-xl font-bold hover:bg-[#004AD6] transition-all cursor-pointer"
          >
            Retry Connection
          </button>
          <a
            href="/"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-100 text-slate-800 px-[#20px] py-3 rounded-xl font-bold hover:bg-slate-200 transition-all"
          >
            Back to Home
          </a>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const isBlog = location.pathname.startsWith("/blog");
  const isEmbed = location.pathname.startsWith("/embed");
  const isDashboard = location.pathname.startsWith("/dashboard");
  const data = useLoaderData<typeof loader>();

  React.useEffect(() => {
    // Live is Paddle.js default — do not call Environment.set("sandbox").
    // Token + optional Retain pwCustomer come from env / page loaders.
    void import("~/lib/paddle-browser").then(({ initializePaddleBrowser }) => {
      const ok = initializePaddleBrowser({
        token: data?.ENV?.VITE_PADDLE_CLIENT_TOKEN || undefined,
      });
      if (ok) {
        console.log("[Paddle Global Setup] Paddle.js initialized (live default).");
      }
    });
  }, [data?.ENV?.VITE_PADDLE_CLIENT_TOKEN]);

  return (
    <div key={location.pathname} className="min-h-screen flex flex-col">
      {!isEmbed && !isDashboard && (isBlog ? <BlogHeader /> : <Header />)}
      <main className="flex-grow">
        <Outlet />
      </main>
      {!isEmbed && !isDashboard && <ChatWidget />}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.ENV = ${JSON.stringify(data?.ENV || {})}`,
        }}
      />
    </div>
  );
}
