import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyPaddleWebhook } from "~/backend/paddle.server";
import { prisma } from "~/database/db.server";
import { isPaddleLiveWebhookIp } from "~/lib/paddle-webhook-ips.server";

export async function action({ request }: ActionFunctionArgs) {
  // Reject non-Paddle source IPs (Live allowlist from https://api.paddle.com/ips).
  const ipCheck = await isPaddleLiveWebhookIp(request);
  if (!ipCheck.ok) {
    console.warn("[Paddle Webhook] Rejected request", { ip: ipCheck.ip, reason: ipCheck.reason });
    return json({ error: "Forbidden" }, { status: 403 });
  }

  const event = await verifyPaddleWebhook(request);
  if (!event) return json({ error: "Invalid signature" }, { status: 401 });
  
  const eventType = event.eventType;
  const data = event.data;

  // For modern Paddle v3, we often store userId in custom_data
  const customData = (data as any).customData || {};
  const userId = customData.userId as string;
  
  // Alternatively fallback to email if userId isn't in customData
  const customerId = (data as any).customerId as string;
  
  console.log(`[Paddle Webhook] Received ${eventType}`, { userId, customerId });

  const REMOVE_BRANDING_ADDON_ID = process.env.VITE_PADDLE_REMOVE_BRANDING_ADDON_ID;

  if (
    eventType === "subscription.created" ||
    eventType === "subscription.updated" ||
    eventType === "subscription.activated"
  ) {
    const subscription = data as any;
    const planId = subscription.items?.[0]?.price?.id || subscription.items?.[0]?.price?.productId || subscription.discount?.id;
    const email = subscription.customer?.email;
    const status = subscription.status;
    const externalSubscriptionId = subscription.id;
    const externalCustomerId = subscription.customerId;
    const nextBilledAt = subscription.nextBilledAt ? new Date(subscription.nextBilledAt) : null;

    let user = null;
    if (email) {
      user = await prisma.user.findUnique({ where: { email } });
    } else if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    }

    if (user) {
      // Check if this is a remove-branding add-on purchase
      if (REMOVE_BRANDING_ADDON_ID && planId === REMOVE_BRANDING_ADDON_ID) {
        await prisma.userAddon.upsert({
          where: { userId_type: { userId: user.id, type: "remove_branding" } },
          update: { status: "active", externalSubscriptionId, externalCustomerId, updatedAt: new Date() },
          create: { userId: user.id, type: "remove_branding", status: "active", externalSubscriptionId, externalCustomerId },
        });
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionTier: planId || "pro" }
        });

        await prisma.billingSubscription.upsert({
          where: { externalSubscriptionId },
          update: {
            status,
            planId: planId || "pro",
            nextBilledAt,
            updatedAt: new Date()
          },
          create: {
            userId: user.id,
            externalSubscriptionId,
            externalCustomerId,
            status,
            planId: planId || "pro",
            provider: "paddle",
            nextBilledAt,
          }
        });
      }
    }
  }

  if (eventType === "subscription.canceled") {
    const subscription = data as any;
    const externalSubscriptionId = subscription.id;
    const email = subscription.customer?.email;

    // Check if this is an add-on cancellation
    const addonRecord = await prisma.userAddon.findFirst({ where: { externalSubscriptionId } });
    if (addonRecord) {
      await prisma.userAddon.update({
        where: { id: addonRecord.id },
        data: { status: "cancelled", updatedAt: new Date() },
      });
    } else {
      if (email || userId) {
        const user = email
          ? await prisma.user.findUnique({ where: { email } })
          : await prisma.user.findUnique({ where: { id: userId } });

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionTier: "free" }
          });
        }
      }

      await prisma.billingSubscription.updateMany({
        where: { externalSubscriptionId },
        data: { status: "canceled", updatedAt: new Date() }
      });
    }
  }

  if (eventType === "transaction.completed") {
    const txn = data as any;
    const transactionId = txn.id;
    const status = txn.status || "completed";
    const currency = txn.currencyCode || txn.currency_code || "USD";

    // Paddle reports totals in the currency's smallest unit (e.g. cents) as a string
    const rawTotal = txn.details?.totals?.grandTotal ?? txn.details?.totals?.total ?? "0";
    const amount = Number(rawTotal) / 100;

    // Paddle does NOT include the PDF URL in the webhook; capture it if present, else null.
    const invoiceUrl = txn.invoice_pdf_url || txn.invoicePdfUrl || null;
    const paidAt = txn.billedAt ? new Date(txn.billedAt) : new Date();

    // Resolve the owning user: customData.userId first, then via the customer id.
    let txnUser = null;
    const txnUserId = txn.customData?.userId || customData.userId;
    if (txnUserId) {
      txnUser = await prisma.user.findUnique({ where: { id: txnUserId } });
    }
    if (!txnUser && txn.customerId) {
      const sub = await prisma.billingSubscription.findFirst({
        where: { externalCustomerId: txn.customerId },
      });
      if (sub) txnUser = await prisma.user.findUnique({ where: { id: sub.userId } });
    }

    if (txnUser && transactionId) {
      await prisma.billingPayment.upsert({
        where: { transactionId },
        update: { amount, currency, status, invoiceUrl, paidAt },
        create: {
          userId: txnUser.id,
          transactionId,
          amount,
          currency,
          status,
          invoiceUrl,
          paidAt,
        },
      });
    }
  }

  return json({ received: true });
}
