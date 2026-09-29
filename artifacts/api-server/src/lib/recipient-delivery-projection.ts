import type { SupabaseClient } from "@supabase/supabase-js";
import { isRecipientAllowed } from "./safety-mode";

const RECIPIENT_PAGE_SIZE = 1_000;
const CHRONIC_EMAIL_QUERY_URL_BUDGET = 6_000;
const CHRONIC_EMAIL_QUERY_CONCURRENCY = 8;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function chronicEmailFilter(emails: readonly string[]): string {
  const values = emails
    .map((email) => `"${email.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`)
    .join(",");
  return `in.(${values})`;
}

function chronicEmailQueryLength(emails: readonly string[]): number {
  return new URLSearchParams({
    select: "email",
    desengajado_cronico: "eq.true",
    email: chronicEmailFilter(emails),
  }).toString().length;
}

export function buildChronicEmailQueryBatches(
  emails: readonly string[],
  maxEncodedQueryLength = CHRONIC_EMAIL_QUERY_URL_BUDGET,
): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];

  for (const email of emails) {
    const candidate = [...batch, email];
    if (
      batch.length > 0 &&
      chronicEmailQueryLength(candidate) > maxEncodedQueryLength
    ) {
      batches.push(batch);
      batch = [email];
    } else {
      batch = candidate;
    }
    if (chronicEmailQueryLength(batch) > maxEncodedQueryLength) {
      throw new Error("A recipient email exceeds the chronic lookup URL budget.");
    }
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function projectionQueryFailure(stage: string, cause: unknown): Error {
  return new Error(`Recipient delivery projection failed during ${stage}.`, {
    cause,
  });
}

export type RecipientDeliveryProjection = {
  total_na_lista: number;
  suprimidos_no_envio: number;
  permitidos_modo_teste: number;
  bloqueados_modo_teste: number;
  receberao_de_fato: number;
  desengajados_na_lista?: number;
  bloqueados_desengajados?: number;
};

export function buildRecipientDeliveryProjection(
  recipientEmails: readonly string[],
  suppressedEmails: ReadonlySet<string>,
  chronicDisengagedEmails: ReadonlySet<string> = new Set(),
  includeDisengaged = false,
): RecipientDeliveryProjection {
  const normalizedSuppressedEmails = new Set(
    [...suppressedEmails].map((email) => normalizeEmail(email)),
  );
  const normalizedRecipients = recipientEmails
    .map(normalizeEmail)
    .filter(Boolean);
  const normalizedChronicEmails = new Set(
    [...chronicDisengagedEmails].map((email) => normalizeEmail(email)),
  );
  const suprimidosNoEnvio = normalizedRecipients.filter((email) =>
    normalizedSuppressedEmails.has(email),
  ).length;
  const disengagedInList = normalizedRecipients.filter((email) =>
    normalizedChronicEmails.has(email),
  );
  const recipientsAfterSuppression = normalizedRecipients.filter(
    (email) =>
      !normalizedSuppressedEmails.has(email) &&
      (includeDisengaged || !normalizedChronicEmails.has(email)),
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
    desengajados_na_lista: disengagedInList.length,
    bloqueados_desengajados: includeDisengaged
      ? 0
      : disengagedInList.filter(
          (email) => !normalizedSuppressedEmails.has(normalizeEmail(email)),
        ).length,
  };
}

export async function recipientDeliveryProjection(
  client: SupabaseClient,
  campaignId: string,
  includeDisengaged?: boolean,
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
    if (error) {
      throw projectionQueryFailure(`recipient page at offset ${offset}`, error);
    }
    for (const row of data ?? []) {
      if (typeof row.email === "string") {
        recipientEmails.push(row.email);
      }
    }
    if (!data || data.length < RECIPIENT_PAGE_SIZE) break;
  }

  const chronicDisengagedEmails = new Set<string>();
  const uniqueRecipientEmails = [...new Set(recipientEmails.map(normalizeEmail))];
  const chronicEmailBatches = buildChronicEmailQueryBatches(uniqueRecipientEmails);
  for (
    let offset = 0;
    offset < chronicEmailBatches.length;
    offset += CHRONIC_EMAIL_QUERY_CONCURRENCY
  ) {
    const batchGroup = chronicEmailBatches.slice(
      offset,
      offset + CHRONIC_EMAIL_QUERY_CONCURRENCY,
    );
    const chronicRowsByBatch = await Promise.all(
      batchGroup.map(async (emailBatch, groupIndex) => {
        const { data: chronicRows, error: chronicError } = await client
          .from("contato_desengajamento")
          .select("email")
          .eq("desengajado_cronico", true)
          .in("email", emailBatch);
        if (chronicError) {
          const batchNumber = offset + groupIndex + 1;
          throw projectionQueryFailure(
            `chronic disengagement batch ${batchNumber}/${chronicEmailBatches.length} (${chronicEmailQueryLength(emailBatch)} encoded query characters)`,
            chronicError,
          );
        }
        return chronicRows ?? [];
      }),
    );
    for (const row of chronicRowsByBatch.flat()) {
      if (typeof row.email === "string") chronicDisengagedEmails.add(row.email);
    }
  }

  const suppressedEmails = new Set<string>();
  const { data, error } = await client.from("supressao").select("email");
  if (error) throw projectionQueryFailure("suppression lookup", error);
  for (const row of data ?? []) {
    if (typeof row.email === "string") suppressedEmails.add(row.email);
  }

  let shouldIncludeDisengaged = includeDisengaged;
  if (shouldIncludeDisengaged == null) {
    const { data: campaign, error: campaignError } = await client
      .from("campanha")
      .select("incluir_desengajados")
      .eq("id", campaignId)
      .maybeSingle();
    if (campaignError) {
      throw projectionQueryFailure("campaign setting lookup", campaignError);
    }
    shouldIncludeDisengaged = campaign?.incluir_desengajados === true;
  }

  return buildRecipientDeliveryProjection(
    recipientEmails,
    suppressedEmails,
    chronicDisengagedEmails,
    shouldIncludeDisengaged,
  );
}