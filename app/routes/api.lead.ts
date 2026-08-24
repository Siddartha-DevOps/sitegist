import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Prisma } from "@prisma/client";
import { prisma } from "~/database/db.server";
import { sendEmail } from "~/lib/email.server";
import { sendWebhook, webhookEventEnabled } from "~/lib/webhook.server";
import { notifySlackLeadCaptured } from "~/lib/slack.server";
import { verifyWidgetSessionToken } from "~/lib/widget-session.server";
import { enforcePublicRateLimit } from "~/lib/public-rate-limit.server";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, { status: 400 });
  const { projectId, name, email, phone, company, sessionId, sessionToken } = body;

  if (
    typeof projectId !== "string" || !projectId || projectId.length > 200 ||
    typeof sessionId !== "string" || !sessionId || sessionId.length > 200 ||
    typeof sessionToken !== "string" || !sessionToken || !email
  ) {
    return json({ error: "Project ID and Email are required" }, { status: 400 });
  }

  if (typeof email !== "string" || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Enter a valid email address" }, { status: 400 });
  }
  for (const value of [name, phone, company]) {
    if (value != null && (typeof value !== "string" || value.length > 500)) {
      return json({ error: "Lead field is too long" }, { status: 400 });
    }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId }
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const session = await prisma.chatSession.findFirst({ where: { id: sessionId, projectId }, select: { id: true } });
  if (!session || !verifyWidgetSessionToken(sessionToken, sessionId, projectId)) {
    return json({ error: "Invalid widget session" }, { status: 401 });
  }

  const limit = await enforcePublicRateLimit(request, `lead:${projectId}`, 8, 3600);
  if (!limit.allowed) {
    return json({ error: "Too many lead submissions" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }

  // Collect custom field answers — keys prefixed with "custom_"
  const customEntries = Object.entries(body).filter(([key]) => key.startsWith("custom_"));
  if (customEntries.length > 20 || customEntries.some(([, value]) => typeof value !== "string" || value.length > 1000)) {
    return json({ error: "Invalid custom lead fields" }, { status: 400 });
  }
  const customAnswers = Object.fromEntries(customEntries.filter(([, value]) => value)) as Record<string, string>;

  // Resolve custom_<id> → human-readable label using project.settings.leadFields
  const leadFields = (project.settings as any)?.leadFields || [];
  const labelledAnswers: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(customAnswers)) {
    const fieldId = key.replace('custom_', '');
    const field = leadFields.find((f: any) => f.id === fieldId);
    labelledAnswers[field?.label || fieldId] = value;
  }

  const notes = Object.keys(labelledAnswers).length
    ? JSON.stringify(labelledAnswers)
    : undefined;

  const existingLead = await prisma.lead.findUnique({ where: { sessionId }, select: { id: true } });
  if (existingLead) return json({ success: true, leadId: existingLead.id, duplicate: true });

  let lead;
  try {
    lead = await prisma.lead.create({
      include: { project: true },
      data: { projectId, name, email, phone, company, notes, sessionId },
    });
  } catch (error) {
    // Two retries can race between the lookup and create. The unique sessionId
    // constraint is the final idempotency guard; only the winner sends events.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await prisma.lead.findUnique({ where: { sessionId }, select: { id: true } });
      if (duplicate) return json({ success: true, leadId: duplicate.id, duplicate: true });
    }
    throw error;
  }

  // Feature 3: Real-Time Notifications
  if (lead.project.webhookUrl && webhookEventEnabled((lead.project.settings as any), 'lead.captured')) {
    try {
      let customFields = {};
      if (lead.notes) {
        try {
          customFields = JSON.parse(lead.notes);
        } catch (parseError) {
          console.warn("[api.lead.ts] Failed to parse lead notes as JSON for custom fields:", parseError);
        }
      }
      await sendWebhook(lead.project.webhookUrl, 'lead.captured', {
        id: lead.project.id,
        name: lead.project.name,
      }, {
        lead: {
          id: lead.id,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          customFields,
          createdAt: lead.createdAt,
        },
        session: { id: lead.sessionId },
      });
    } catch (e) {
      console.error("Webhook notification failed:", e);
    }
  }

  const slackWebhookUrl = (lead.project.settings as any)?.slackWebhookUrl;
  if (slackWebhookUrl) {
    try {
      await notifySlackLeadCaptured(slackWebhookUrl, {
        projectName: lead.project.name,
        projectId: lead.project.id,
        lead: { name, email, phone, company },
        sessionId: lead.sessionId ?? undefined,
      });
    } catch (e) {
      console.error("[Slack] Lead notification trigger failed:", e);
    }
  }

  // HubSpot CRM sync — push the captured lead as a contact when connected.
  // Fire-and-forget: never block or fail lead capture on a CRM hiccup.
  try {
    const hubspot = await prisma.integration.findUnique({
      where: { projectId_provider: { projectId, provider: "hubspot" } },
    });
    if (hubspot?.accessToken && email) {
      const { upsertHubspotContact } = await import("~/lib/hubspot.server");
      const [firstName, ...rest] = String(name || "").trim().split(/\s+/).filter(Boolean);
      await upsertHubspotContact({
        token: hubspot.accessToken,
        email,
        firstName: firstName || undefined,
        lastName: rest.join(" ") || undefined,
        phone: phone || undefined,
        company: company || undefined,
      }).catch((e) => console.error("[HubSpot] Contact sync failed:", e));
    }
  } catch (e) {
    console.error("[HubSpot] Lead sync error:", e);
  }

  // Email the chatbot owner about the new lead (default ON, never blocks lead capture)
  try {
    const settings = (lead.project.settings as any) || {};
    const notifyOnLead = settings?.notifications?.emailOnLead !== false; // default ON
    if (notifyOnLead) {
      const owner = await prisma.user.findUnique({
        where: { id: lead.project.userId },
        select: { email: true },
      });
      if (owner?.email) {
        await sendEmail({
          to: owner.email,
          subject: `New lead captured on ${lead.project.name}`,
          html: `
            <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
              <h2 style="color:#155DEE; margin-bottom:4px;">New lead captured 🎉</h2>
              <p style="color:#52525b; margin-top:0;">Your chatbot <strong>${escapeHtml(lead.project.name)}</strong> just captured a new lead.</p>
              <table style="width:100%; border-collapse:collapse; margin:20px 0;">
                <tr><td style="padding:8px 0; color:#a1a1aa;">Name</td><td style="padding:8px 0; font-weight:bold;">${escapeHtml(name || "—")}</td></tr>
                <tr><td style="padding:8px 0; color:#a1a1aa;">Email</td><td style="padding:8px 0; font-weight:bold;">${escapeHtml(email)}</td></tr>
                <tr><td style="padding:8px 0; color:#a1a1aa;">Phone</td><td style="padding:8px 0; font-weight:bold;">${escapeHtml(phone || "—")}</td></tr>
                <tr><td style="padding:8px 0; color:#a1a1aa;">Company</td><td style="padding:8px 0; font-weight:bold;">${escapeHtml(company || "—")}</td></tr>
              </table>
              <p style="color:#a1a1aa; font-size:12px;">Sent by SiteGist · You can manage notifications in your chatbot settings.</p>
            </div>
          `,
        });
      }
    }
  } catch (e) {
    console.error("Lead email notification failed:", e);
  }

  // Do not return the included project: it contains private settings and
  // integration configuration that are never part of the public API contract.
  return json({ success: true, leadId: lead.id });
}
