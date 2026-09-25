import { normalizeEmailBlocks } from "@workspace/email-template";

export const CAMPAIGN_CONTENT_LOCKED_STATUSES = [
  "agendada",
  "enviando",
  "pausada",
] as const;

export const CAMPAIGN_CONTENT_LOCKED_FIELDS = [
  "assunto",
  "preheader",
  "assunto_lembrete",
  "corpo_lembrete",
  "lembrete_horas",
  "cor_botao_snapshot",
  "incluir_desengajados",
  "remetente_nome",
  "remetente_email",
  "reply_to",
  "corpo",
] as const;

export type CampaignContentLockedField =
  (typeof CAMPAIGN_CONTENT_LOCKED_FIELDS)[number];

const fieldLabels: Record<CampaignContentLockedField, string> = {
  assunto: "o assunto",
  preheader: "a prévia",
  assunto_lembrete: "o assunto do lembrete",
  corpo_lembrete: "o corpo do lembrete",
  lembrete_horas: "o prazo do lembrete",
  cor_botao_snapshot: "a cor do botão",
  incluir_desengajados: "o público de desengajados",
  remetente_nome: "o nome do remetente",
  remetente_email: "o e-mail do remetente",
  reply_to: "o Reply-To",
  corpo: "o corpo do e-mail",
};

function comparableValue(field: CampaignContentLockedField, value: unknown): string {
  if (field === "corpo" || field === "corpo_lembrete") {
    return JSON.stringify(normalizeEmailBlocks(value));
  }
  return JSON.stringify(value ?? null);
}

export function changedLockedCampaignFields(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
): CampaignContentLockedField[] {
  if (
    !CAMPAIGN_CONTENT_LOCKED_STATUSES.includes(
      existing.status as (typeof CAMPAIGN_CONTENT_LOCKED_STATUSES)[number],
    )
  ) {
    return [];
  }

  return CAMPAIGN_CONTENT_LOCKED_FIELDS.filter(
    (field) =>
      field in update &&
      comparableValue(field, existing[field]) !== comparableValue(field, update[field]),
  );
}

export function campaignContentLockMessage(
  fields: readonly CampaignContentLockedField[],
): string {
  const labels = fields.map((field) => fieldLabels[field]);
  const formatted =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`;
  return `Não é possível editar ${formatted} depois que a campanha entra em agendamento ou envio.`;
}