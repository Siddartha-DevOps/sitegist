import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";
import { integrationCryptoExtension } from "~/lib/crypto.server";
import fs from "fs";
import path from "path";

/**
 * Prisma Client singleton.
 * Using a singleton pattern ensures we don't exhaust database connections
 * during development hot reloads.
 */

let _cachedDb: any = null;
let _usingFallback = false;
let _entirelyOffline = false;

function isUsingFallback(): boolean {
  if (typeof global !== "undefined" && (global as any).__db_using_fallback__ !== undefined) {
    return (global as any).__db_using_fallback__;
  }
  return _usingFallback;
}

function setUsingFallback(val: boolean) {
  _usingFallback = val;
  if (typeof global !== "undefined") {
    (global as any).__db_using_fallback__ = val;
  }
}

function isEntirelyOffline(): boolean {
  if (typeof global !== "undefined" && (global as any).__db_entirely_offline__ !== undefined) {
    return (global as any).__db_entirely_offline__;
  }
  return _entirelyOffline;
}

function setEntirelyOffline(val: boolean) {
  _entirelyOffline = val;
  if (typeof global !== "undefined") {
    (global as any).__db_entirely_offline__ = val;
  }
}

// Global mockup state for elegant offline fallback
if (typeof global !== "undefined" && !(global as any).__mockDb__) {
  (global as any).__mockDb__ = {
    user: [
      {
        id: "demo-user-id",
        email: "demo-user@stegist.co",
        role: "OWNER",
        subscriptionTier: "pro",
        subscriptionStatus: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        subscriptions: []
      }
    ],
    project: [],
    knowledgesource: [],
    lead: [],
    chatsession: [],
    message: [],
    unansweredquestion: [],
    blogpost: [],
    knowledgeqa: [],
    projectmember: []
  };
}

const mockDb = typeof global !== "undefined" && (global as any).__mockDb__ ? (global as any).__mockDb__ : {
  user: [],
  project: [],
  knowledgesource: [],
  lead: [],
  chatsession: [],
  message: [],
  unansweredquestion: [],
  blogpost: [],
  knowledgeqa: [],
  projectmember: []
};

function enrichWithMockRelations(modelLower: string, item: any): any {
  if (!item) return item;
  const res = { ...item };

  if (modelLower === "project") {
    res._count = {
      knowledgeSources: (mockDb.knowledgesource || []).filter((x: any) => x.projectId === res.id).length,
      sessions: (mockDb.chatsession || []).filter((x: any) => x.projectId === res.id).length,
      leads: (mockDb.lead || []).filter((x: any) => x.projectId === res.id).length,
      integrations: (mockDb.integration || []).filter((x: any) => x.projectId === res.id).length,
      knowledgeQAs: (mockDb.knowledgeqa || []).filter((x: any) => x.projectId === res.id).length,
    };
    res.knowledgeSources = (mockDb.knowledgesource || []).filter((x: any) => x.projectId === res.id);
    res.integrations = (mockDb.integration || []).filter((x: any) => x.projectId === res.id);
    res.sessions = (mockDb.chatsession || []).filter((x: any) => x.projectId === res.id);
    res.leads = (mockDb.lead || []).filter((x: any) => x.projectId === res.id);
    res.knowledgeQAs = (mockDb.knowledgeqa || []).filter((x: any) => x.projectId === res.id);
  }

  if (modelLower === "chatsession" || modelLower === "session") {
    res._count = {
      messages: (mockDb.message || []).filter((x: any) => x.sessionId === res.id).length
    };
    res.messages = (mockDb.message || []).filter((x: any) => x.sessionId === res.id);
    const proj = (mockDb.project || []).find((p: any) => p.id === res.projectId) || {
      id: res.projectId || "mock-proj-1",
      name: "Default Website Chatbot",
      userId: "demo-user-id"
    };
    res.project = proj;
  }

  if (modelLower === "blogpost") {
    res.author = {
      id: "author-1",
      name: "Founder",
      email: "founder@sitegist.co"
    };
  }

  if (modelLower === "lead") {
    const proj = (mockDb.project || []).find((p: any) => p.id === res.projectId) || {
      id: res.projectId || "mock-proj-1",
      name: "Default Website Chatbot",
      userId: "demo-user-id"
    };
    res.project = proj;
  }

  return res;
}

/**
 * The mock/offline fallback is a DEVELOPMENT convenience only. In production it
 * would silently serve fake data and accept writes that vanish — a data-integrity
 * and trust hazard. It is therefore disabled in production unless explicitly
 * opted in with ALLOW_DB_MOCK=1.
 */
function isMockAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_DB_MOCK === "1";
}

function getFallbackMockData(model: string | undefined, operation: string, args: any): any {
  const modelLower = (model || "").toLowerCase();

  if (!isMockAllowed()) {
    // Fail loud rather than fake: surface the outage so it's caught by error
    // tracking and the user sees a real error instead of corrupt/empty data.
    throw new Error(
      `[DB] Database is unavailable and the mock fallback is disabled in production ` +
      `(model=${model}, op=${operation}). Refusing to serve or accept mock data.`
    );
  }

  if (typeof global !== "undefined" && !(global as any).__db_warned_mock__) {
    (global as any).__db_warned_mock__ = true;
    console.warn("================================================================================");
    console.warn("[SiteGist Resiliency] Operating in Elegant Local Sandbox Mode (DEV ONLY).");
    console.warn("Active cloud database is currently unreachable. Local high-fidelity mock data active.");
    console.warn("================================================================================");
  }

  if (!mockDb[modelLower]) {
    mockDb[modelLower] = [];
  }
  
  const list = mockDb[modelLower];
  
  if (operation === "findMany") {
    let result = [...list];
    if (args?.where) {
      result = result.filter((item: any) => {
        for (const [key, val] of Object.entries(args.where)) {
          if (val === undefined) continue;
          if (typeof val === "object" && val !== null) {
            if ("in" in val && Array.isArray(val.in)) {
              if (!val.in.includes(item[key])) return false;
            }
          } else if (item[key] !== val) {
            return false;
          }
        }
        return true;
      });
    }
    
    return result.map(item => enrichWithMockRelations(modelLower, item));
  }
  
  if (operation === "findUnique" || operation === "findFirst" || operation === "findUniqueOrThrow") {
    let result = [...list];
    if (args?.where) {
      result = result.filter((item: any) => {
        for (const [key, val] of Object.entries(args.where)) {
          if (val === undefined) continue;
          if (typeof val === "object" && val !== null) {
            if ("in" in val && Array.isArray(val.in)) {
              if (!val.in.includes(item[key])) return false;
            }
          } else if (item[key] !== val) {
            return false;
          }
        }
        return true;
      });
    }
    
    if (result.length > 0) {
      return enrichWithMockRelations(modelLower, result[0]);
    }
    
    // Automatic creation of User if looking up by id to prevent login pages getting completely dead ends
    if (modelLower === "user" && args?.where?.id) {
      let email = "demo-user@stegist.co";
      if (args.where.id.startsWith("usr_hex_")) {
        try {
          const hex = args.where.id.substring("usr_hex_".length);
          email = Buffer.from(hex, "hex").toString("utf-8");
        } catch (e) {}
      }
      const newUser = {
        id: args.where.id,
        email,
        role: "OWNER",
        subscriptionTier: "pro",
        subscriptionStatus: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        subscriptions: []
      };
      list.push(newUser);
      return enrichWithMockRelations(modelLower, newUser);
    }
    if (modelLower === "user" && args?.where?.email) {
      const safeId = "usr_hex_" + Buffer.from(args.where.email).toString("hex");
      const newUser = {
        id: safeId,
        email: args.where.email,
        role: "OWNER",
        subscriptionTier: "pro",
        subscriptionStatus: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        subscriptions: []
      };
      list.push(newUser);
      return enrichWithMockRelations(modelLower, newUser);
    }
    return null;
  }
  
  if (operation === "count") {
    let result = [...list];
    if (args?.where) {
      result = result.filter((item: any) => {
        for (const [key, val] of Object.entries(args.where)) {
          if (val === undefined) continue;
          if (item[key] !== val) return false;
        }
        return true;
      });
    }
    return result.length;
  }
  
  if (operation === "create" || operation === "createMany") {
    const data = args?.data || {};
    let newId = data.id;
    if (!newId) {
      if (modelLower === "user" && data.email) {
        newId = "usr_hex_" + Buffer.from(data.email).toString("hex");
      } else {
        newId = `mock-${modelLower}-${Math.random().toString(36).substring(2, 9)}`;
      }
    }
    const newItem = {
      id: newId,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    list.push(newItem);
    return enrichWithMockRelations(modelLower, newItem);
  }
  
  if (operation === "update" || operation === "updateMany") {
    const data = args?.data || {};
    let updatedCount = 0;
    let lastUpdatedItem = null;
    
    for (let i = 0; i < list.length; i++) {
      let matches = true;
      if (args?.where) {
        for (const [key, val] of Object.entries(args.where)) {
          if (list[i][key] !== val) {
            matches = false;
            break;
          }
        }
      }
      if (matches) {
        list[i] = {
          ...list[i],
          ...data,
          updatedAt: new Date()
        };
        updatedCount++;
        lastUpdatedItem = list[i];
      }
    }
    
    if (operation === "updateMany") {
      return { count: updatedCount };
    }
    return enrichWithMockRelations(modelLower, lastUpdatedItem);
  }
  
  if (operation === "upsert") {
    let foundIdx = -1;
    if (args?.where) {
      foundIdx = list.findIndex((item: any) => {
        for (const [key, val] of Object.entries(args.where)) {
          if (item[key] !== val) return false;
        }
        return true;
      });
    }
    if (foundIdx !== -1) {
      list[foundIdx] = {
        ...list[foundIdx],
        ...(args?.update || {}),
        updatedAt: new Date()
      };
      return enrichWithMockRelations(modelLower, list[foundIdx]);
    } else {
      const newId = args?.where?.id || `mock-${modelLower}-${Math.random().toString(36).substring(2, 9)}`;
      const newItem = {
        id: newId,
        ...(args?.create || {}),
        createdAt: new Date(),
        updatedAt: new Date()
      };
      list.push(newItem);
      return enrichWithMockRelations(modelLower, newItem);
    }
  }
  
  if (operation === "delete" || operation === "deleteMany") {
    let deletedCount = 0;
    if (args?.where) {
      const initialLength = list.length;
      mockDb[modelLower] = list.filter((item: any) => {
        for (const [key, val] of Object.entries(args.where)) {
          if (item[key] === val) return false;
        }
        return true;
      });
      deletedCount = initialLength - mockDb[modelLower].length;
    } else {
      deletedCount = list.length;
      mockDb[modelLower] = [];
    }
    
    if (operation === "deleteMany") {
      return { count: deletedCount };
    }
    return { id: args?.where?.id || "deleted" };
  }
  
  return null;
}

// Strip surrounding quotes from an env value. Module scope so both the one-time
// resolver and getClient can use it.
function stripQuotes(val: string | undefined): string {
  if (!val) return "";
  let trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// Resolve DB connection config ONCE at module load — NOT per getClient call.
// Strips quotes on the platform vars, and only if DATABASE_URL is missing/
// placeholder does it read the local .env file a single time. After this,
// process.env.DATABASE_URL / DIRECT_DATABASE_URL hold the resolved values that
// getClient reads — so no fs access happens on the hot path (including the
// failover getClient(true) path).
function resolveDbEnvOnce() {
  if (process.env.DATABASE_URL) process.env.DATABASE_URL = stripQuotes(process.env.DATABASE_URL);
  if (process.env.DIRECT_DATABASE_URL) process.env.DIRECT_DATABASE_URL = stripQuotes(process.env.DIRECT_DATABASE_URL);

  const isUrlEmptyOrPlaceholder =
    !process.env.DATABASE_URL ||
    process.env.DATABASE_URL.trim() === "" ||
    process.env.DATABASE_URL.includes("placeholder");

  if (isUrlEmptyOrPlaceholder) {
    try {
      const envPath = path.join(process.cwd(), ".env");
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, "utf-8");
        const dbUrlMatch = envContent.match(/DATABASE_URL\s*=\s*(['\"]?)(.*?)\1(?:[\r\n]|$)/);
        if (dbUrlMatch && dbUrlMatch[2]) {
          const localUrl = stripQuotes(dbUrlMatch[2]);
          if (localUrl && !localUrl.includes("placeholder")) process.env.DATABASE_URL = localUrl;
        }
        const directUrlMatch = envContent.match(/DIRECT_DATABASE_URL\s*=\s*(['\"]?)(.*?)\1(?:[\r\n]|$)/);
        if (directUrlMatch && directUrlMatch[2]) {
          const localDirectUrl = stripQuotes(directUrlMatch[2]);
          if (localDirectUrl && !localDirectUrl.includes("placeholder")) process.env.DIRECT_DATABASE_URL = localDirectUrl;
        }
      }
    } catch (err) {
      console.warn("[Prisma Config] Local .env parsing failed or not found, using system variables:", err);
    }
  }
}

// Run the resolution exactly once per process (guarded against dev hot-reload).
if (typeof global === "undefined" || !(global as any).__db_env_resolved__) {
  resolveDbEnvOnce();
  if (typeof global !== "undefined") (global as any).__db_env_resolved__ = true;
}

function getClient(useFallback = false): any {
  // Connection config (.env parsing, quote stripping) is resolved once at module
  // load by resolveDbEnvOnce() — getClient no longer touches the filesystem.
  let url = process.env.DATABASE_URL || "";
  
  if (useFallback && process.env.DIRECT_DATABASE_URL) {
    console.log("[Prisma Client] Forcing failover direct connection using DIRECT_DATABASE_URL.");
    url = process.env.DIRECT_DATABASE_URL;
  }
  
  if (!url || url.trim() === "") {
    if (process.env.DIRECT_DATABASE_URL) {
      console.log("[Prisma Client] DATABASE_URL is empty. Falling back to DIRECT_DATABASE_URL immediately.");
      url = process.env.DIRECT_DATABASE_URL;
    } else {
      // Set a placeholder so Prisma can initialize without throwing a module-load exception
      url = "postgresql://placeholder_user:placeholder_pass@127.0.0.1:5432/placeholder_db";
      setEntirelyOffline(true);
    }
  }

  // Clean up any remaining quotes if present
  url = stripQuotes(url);

  if (url.includes("placeholder") || url.includes("your-database-url")) {
    setEntirelyOffline(true);
  }

  // On serverless, an unpooled connection string will exhaust DB connections at
  // scale. Warn once in production if the URL doesn't look pooled (Accelerate,
  // PgBouncer, or a provider pooler endpoint).
  if (
    process.env.NODE_ENV === "production" &&
    url &&
    !url.includes("placeholder") &&
    typeof global !== "undefined" &&
    !(global as any).__db_pool_warned__
  ) {
    const pooled =
      url.startsWith("prisma") ||
      url.includes("pgbouncer=true") ||
      url.includes("-pooler.") ||
      url.includes(":6543");
    if (!pooled) {
      (global as any).__db_pool_warned__ = true;
      console.warn(
        "[DB] DATABASE_URL does not look pooled. On serverless, use Prisma Accelerate " +
        "(prisma://…) or a pooled endpoint (PgBouncer / Neon -pooler / Supabase :6543) " +
        "and keep DIRECT_DATABASE_URL for migrations. See docs/PRODUCTION_SAFETY.md."
      );
    }
  }

  const rawClient = new PrismaClient({
    datasourceUrl: url,
    log: [], // Suppress internal raw driver stderr/stdout prints to prevent console noise
  });

  const isAccelerate = url.startsWith("prisma");
  const rawExtended = isAccelerate ? rawClient.$extends(withAccelerate()) : rawClient;

  // Intercept operations and implement robust automatic failover query retry
  const client = rawExtended.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (isEntirelyOffline()) {
            return getFallbackMockData(model, operation, args);
          }

          const maxAttempts = 2;
          let attempt = 0;
          let triedSchemaHeal = false;

          while (attempt < maxAttempts) {
            attempt++;
            try {
              return await query(args);
            } catch (err: any) {
              const errMsg = err.message || "";
              
              // Check for API key / Accelerate errors. Includes P5000 so this
              // single surviving layer covers everything the removed proxy matched.
              const isKeyError = errMsg.includes("P5000") ||
                                 errMsg.includes("P6002") ||
                                 errMsg.includes("API key is invalid") ||
                                 (errMsg.includes("Unauthorized") && errMsg.toLowerCase().includes("accelerate"));
              
              if (isKeyError) {
                if (process.env.DIRECT_DATABASE_URL && !useFallback && !isUsingFallback()) {
                  setUsingFallback(true);
                  const fallbackClient = getClient(true);
                  _cachedDb = fallbackClient;
                  if (typeof global !== "undefined") {
                    (global as any).__db_fallback__ = fallbackClient;
                  }
                  
                  // Re-bind to the correct model and run the query directly
                  if (model) {
                    const fallbackDelegate = fallbackClient[model];
                    if (fallbackDelegate && typeof fallbackDelegate[operation] === "function") {
                      try {
                        return await fallbackDelegate[operation](args);
                      } catch (fallbackErr: any) {
                        setEntirelyOffline(true);
                        return getFallbackMockData(model, operation, args);
                      }
                    }
                  }
                } else {
                  setEntirelyOffline(true);
                  return getFallbackMockData(model, operation, args);
                }
              }
              
              // Check for transient socket resets, connection drops, or Peer Connection Resets (e.g., Os { code: 104, kind: ConnectionReset })
              const isTransientError = 
                errMsg.includes("ConnectionReset") ||
                errMsg.includes("Connection reset") ||
                errMsg.includes("104") ||
                errMsg.includes("Io") ||
                errMsg.includes("ECONNRESET") ||
                errMsg.includes("socket hang up") ||
                errMsg.includes("EPIPE") ||
                errMsg.includes("ETIMEDOUT") ||
                errMsg.includes("P1017") || 
                errMsg.includes("closed by peer") ||
                errMsg.toLowerCase().includes("connection reset") ||
                errMsg.toLowerCase().includes("can't reach database");
                
              if (isTransientError && attempt < maxAttempts) {
                const backoffMs = attempt * 150;
                console.log(`[Database Connection] Transient fluctuation encountered. Re-evaluating...`);
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                continue;
              }

              // Optional schema-drift self-heal. ensureSchemaApplied is disabled
              // unless AUTO_SCHEMA_SYNC=1 so normal web requests cannot execute DDL.
              const isUndefinedSchema =
                errMsg.includes("42703") || errMsg.includes("42P01") ||
                (errMsg.includes("does not exist") && (errMsg.includes("column") || errMsg.includes("relation")));
              if (isUndefinedSchema && !triedSchemaHeal) {
                triedSchemaHeal = true;
                try {
                  const { ensureSchemaApplied, isSchemaSyncing } = await import("~/backend/ensure-schema.server");
                  if (!isSchemaSyncing()) {
                    await ensureSchemaApplied();
                    attempt = 0; // give the healed query a fresh retry
                    continue;
                  }
                } catch (healErr: any) {
                  console.error("[Database Connection] Schema auto-heal failed:", healErr?.message);
                }
              }

              // Transient/unknown error after retries: do NOT permanently latch
              // the whole instance into offline mock mode — that makes real data
              // (e.g. the user's projects) vanish on every subsequent query until
              // the container restarts. Surface the error so the caller can handle
              // it and the next request retries the real database.
              throw err;
            }
          }
          // Fallback return if loop finishes without throwing (TypeScript safety)
          return getFallbackMockData(model, operation, args);
        }
      }
    }
  });

  // Encrypt/decrypt Integration secrets at rest (outermost so it wraps the
  // failover layer): no-op unless ENCRYPTION_KEY is set.
  const cryptoClient = (client as any).$extends(integrationCryptoExtension);

  // Skip early eager logging. Active query endpoints and startup config hooks handle the connection check.
  return cryptoClient as any;
}

type ExtendedPrismaClient = PrismaClient;

declare global {
  // eslint-disable-next-line no-var
  var __db__: ExtendedPrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __db_fallback__: ExtendedPrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __db_using_fallback__: boolean | undefined;
}

function getPrisma() {
  if (isUsingFallback()) {
    if (process.env.NODE_ENV === "production") {
      if (!_cachedDb) {
        _cachedDb = getClient(true);
      }
      return _cachedDb;
    } else {
      if (!global.__db_fallback__) {
        global.__db_fallback__ = getClient(true);
      }
      return global.__db_fallback__;
    }
  }

  if (process.env.NODE_ENV === "production") {
    if (!_cachedDb) {
      _cachedDb = getClient(false);
    }
    return _cachedDb;
  }
  
  if (global.__db__) return global.__db__;
  
  const client = getClient(false);
  global.__db__ = client;
  return client;
}

const prisma = new Proxy({} as ExtendedPrismaClient, {
  get(target, prop) {
    const client = getPrisma();
    const val = Reflect.get(client, prop);
    
    if (typeof prop === "string" && val && typeof val === "object" && !prop.startsWith("$")) {
      // Model delegates already run through the single $extends failover layer
      // ($allOperations). No second proxy layer — that was the duplicate matching.
      return val;
    }
    
    if (typeof prop === "string" && typeof val === "function" && prop.startsWith("$")) {
      return async function (...args: any[]) {
        try {
          return await val.apply(client, args);
        } catch (err: any) {
          const errMsg = err.message || "";
          const isKeyError = errMsg.includes("P5000") || errMsg.includes("P6002") || errMsg.includes("API key is invalid");

          // Accelerate key failure only: retry once through the direct connection.
          // Its result (success OR error) is returned/propagated as-is.
          if (isKeyError && process.env.DIRECT_DATABASE_URL && !isUsingFallback()) {
            console.log(`[Prisma Failover] Client operation '${prop}' retrying via direct connection.`);
            setUsingFallback(true);
            const fallbackClient = getPrisma();
            const fallbackMethod = fallbackClient[prop];
            if (typeof fallbackMethod === "function") {
              return await fallbackMethod.apply(fallbackClient, args);
            }
          }

          // Never hide a query/transaction failure behind an empty array — a
          // silent [] here can make a failed $transaction or $queryRaw look like
          // a successful empty result. Surface the real error to the caller.
          throw err;
        }
      };
    }
    
    return typeof val === "function" ? val.bind(client) : val;
  },
});

export { prisma };
