import type { SupabaseClient } from "@supabase/supabase-js";
import { isRecipientAllowed } from "./safety-mode";

const RECIPIENT_PAGE_SIZE = 1_000;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type RecipientDeliveryProjection = {
  total_na_lista: number;
  suprimidos_no_envio: number;
  permitidos_modo_teste: number;
  bloqueados_modo_teste: number;
  receberao_de_fato: number;
};

export function buildRecipientDeliveryProjection(
  recipientEmails: readonly string[],
  suppressedEmails: ReadonlySet<string>,
): RecipientDeliveryProjection {
  const normalizedSuppressedEmails = new Set(
    [...suppressedEmails].map((email) => normalizeEmail(email)),
  );
  const normalizedRecipients = recipientEmails
    .map(normalizeEmail)
    .filter(Boolean);
  const suprimidosNoEnvio = normalizedRecipients.filter((email) =>
    normalizedSuppressedEmails.has(email),
  ).length;
  const recipientsAfterSuppression = normalizedRecipients.filter(
    (email) => !normalizedSuppressedEmails.has(email),
  );
  const permitidosModoTeste = recipientsAfterSuppression.filter(isRecipientAllowed).length;
  const bloqueadosModoTeste =
    recipientsAfterSuppression.length - permitidosModoTeste;

  return {
    total_na_lista: normalizedRecipients.length,
    suprimidos_no_envio: suprimidosNoEnvio,
    permitidos_modo_teste: permitidosModoTeste,
    bloqueados_modo_teste: bloqueadosModoTeste,
    receberao_de_fato: permitidosModoTeste,
  };
}

export async function recipientDeliveryProjection(
  client: SupabaseClient,
  campaignId: string,
): Promise<RecipientDeliveryProjection> {
  const recipientEmails: string[] = [];
  for (let offset = 0; ; offset += RECIPIENT_PAGE_SIZE) {
    const { data, error } = await client
      .from("destinatario")
      .select("email")
      .eq("campanha_id", campaignId)
      .eq("is_lembrete", false)
      .order("id", { ascending: true })
      .range(offset, offset + RECIPIENT_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (typeof row.email === "string") recipientEmails.push(row.email);
    }
    if (!data || data.length < RECIPIENT_PAGE_SIZE) break;
  }

  const suppressedEmails = new Set<string>();
  const { data, error } = await client.from("supressao").select("email");
  if (error) throw error;
  for (const row of data ?? []) {
    if (typeof row.email === "string") suppressedEmails.add(row.email);
  }

  return buildRecipientDeliveryProjection(recipientEmails, suppressedEmails);
}