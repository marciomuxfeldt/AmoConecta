import { Router, type IRouter, type Request, type Response } from "express";
import { getTechnicalError } from "../lib/technical-error";
import { supabaseAdminClient } from "../lib/supabase";
import { processPendingEmailEvents } from "../lib/worker";
import { verifyResendWebhookSignature } from "../lib/resend-webhook-signature";

const router: IRouter = Router();

const handledEventTypes = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
]);

function recordString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstRecipientEmail(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim().toLowerCase()
    : null;
}

function eventDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function eventBounceIsPermanent(eventType: string, data: Record<string, unknown>): boolean | null {
  if (eventType !== "email.bounced") return null;
  const bounce = data.bounce;
  const type =
    typeof bounce === "object" && bounce !== null && "type" in bounce
      ? String((bounce as { type?: unknown }).type ?? "").toLowerCase()
      : String(data.bounce_type ?? "").toLowerCase();

  // Resend documents email.bounced as a permanent rejection. Honor an
  // explicit temporary classification defensively if one is supplied.
  return ["soft", "temporary", "transient", "delayed"].includes(type)
    ? false
    : true;
}

async function receiveWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "O corpo do webhook precisa ser JSON." });
    return;
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    req.log.error("RESEND_WEBHOOK_SECRET não está configurado.");
    res.status(503).json({ error: "Webhook temporariamente indisponível." });
    return;
  }

  const svixId = req.header("svix-id");
  const svixTimestamp = req.header("svix-timestamp");
  const svixSignature = req.header("svix-signature");
  const verified = verifyResendWebhookSignature(
    rawBody,
    { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
    secret,
  );
  if (!verified) {
    res.status(401).json({ error: "Assinatura do webhook inválida." });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "O payload assinado não contém JSON válido." });
    return;
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    res.status(400).json({ error: "Formato de evento inválido." });
    return;
  }
  const envelope = payload as Record<string, unknown>;
  const eventType = recordString(envelope.type);
  const occurredAt = eventDate(envelope.created_at);
  const data =
    typeof envelope.data === "object" &&
    envelope.data !== null &&
    !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : null;
  if (!svixId || !eventType || !occurredAt || !data) {
    res.status(400).json({ error: "O payload assinado não contém os campos de evento obrigatórios." });
    return;
  }

  const resendEmailId = recordString(data.email_id);
  const email = firstRecipientEmail(data.to);
  try {
    const { error } = await supabaseAdminClient()
      .from("evento_email")
      .insert({
        svix_id: svixId,
        tipo: eventType,
        resend_email_id: resendEmailId,
        email,
        ocorrido_em: occurredAt,
        payload: envelope,
        bounce_permanente: eventBounceIsPermanent(eventType, data),
      });

    if (error?.code === "23505") {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    if (error) throw error;

    // The durable insert is the acknowledgement boundary. Processing is
    // retried by the campaign worker if this in-process task is interrupted.
    res.status(200).json({ received: true });
    setImmediate(() => {
      void processPendingEmailEvents().catch((error: unknown) => {
        req.log.error(
          { technicalError: getTechnicalError(error) },
          "Asynchronous Resend event processing failed",
        );
      });
    });

    if (!handledEventTypes.has(eventType)) {
      req.log.warn(
        { eventType, svixId },
        "Verified Resend event stored but not handled",
      );
    }
  } catch (error) {
    req.log.error(
      { svixId, technicalError: getTechnicalError(error) },
      "Resend webhook event persistence failed",
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "Não foi possível registrar o evento." });
    }
  }
}

router.post("/", receiveWebhook);

export default router;