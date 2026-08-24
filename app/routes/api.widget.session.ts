import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/database/db.server";
import { isOriginAllowed, originHost } from "~/lib/domains";
import { createRealtimeClientToken } from "~/lib/partykit.server";
import { enforcePublicRateLimit } from "~/lib/public-rate-limit.server";
import { createWidgetSessionToken } from "~/lib/widget-session.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const body = await request.json().catch(() => null);
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  if (!projectId || projectId.length > 200) return json({ error: "Invalid projectId" }, { status: 400 });

  // Use a fixed scope before project lookup so arbitrary project IDs cannot
  // create unbounded Redis or in-memory rate-limit keys.
  const limit = await enforcePublicRateLimit(request, "widget-session", 20, 3600);
  if (!limit.allowed) {
    return json({ error: "Too many session requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true, settings: true } });
  if (!project || project.status !== "ACTIVE") return json({ error: "Project not found" }, { status: 404 });

  const settings = (project.settings as any) || {};
  const origin = request.headers.get("origin") || request.headers.get("referer");
  const allowedDomains: string[] = Array.isArray(settings.allowedDomains) ? settings.allowedDomains : [];
  if (allowedDomains.length > 0 && !isOriginAllowed(origin, allowedDomains)) {
    return json({ error: "Unauthorized domain" }, { status: 403 });
  }
  if ((process.env.WIDGET_STRICT_DOMAINS === "1" || settings.strictDomains === true) && allowedDomains.length === 0) {
    if (originHost(origin) !== originHost(request.url)) return json({ error: "Unauthorized domain" }, { status: 403 });
  }

  const session = await prisma.chatSession.create({
    data: {
      projectId,
      ...(body?.pageUrl ? { pageUrl: String(body.pageUrl).slice(0, 2048) } : {}),
      ...(body?.pageTitle ? { pageTitle: String(body.pageTitle).slice(0, 512) } : {}),
    },
    select: { id: true },
  });

  return json({
    sessionId: session.id,
    sessionToken: createWidgetSessionToken(session.id, projectId),
    realtimeToken: await createRealtimeClientToken(session.id, "visitor"),
  });
}
