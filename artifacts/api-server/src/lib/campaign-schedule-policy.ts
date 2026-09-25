import type { RecipientDeliveryProjection } from "./recipient-delivery-projection";

export const CAMPAIGN_TEST_REQUIRED_ABOVE_RECIPIENTS = 50;

export function isCampaignTestRequired(importedRecipientCount: number): boolean {
  return importedRecipientCount > CAMPAIGN_TEST_REQUIRED_ABOVE_RECIPIENTS;
}

export function campaignTestRequiredScheduleMessage(
  importedRecipientCount: number,
): string {
  return `Envie e confirme um teste bem-sucedido antes de agendar. O teste é obrigatório para ${new Intl.NumberFormat("pt-BR").format(importedRecipientCount)} destinatários importados.`;
}

export function noEligibleRecipientsScheduleMessage(
  delivery: RecipientDeliveryProjection,
): string {
  if (delivery.total_na_lista === 0) {
    return "A lista está vazia: 0 destinatários importados. Importe ao menos um destinatário antes de agendar.";
  }

  const formatNumber = (value: number) =>
    new Intl.NumberFormat("pt-BR").format(value);
  const formatCount = (value: number, singular: string, plural: string) =>
    `${formatNumber(value)} ${value === 1 ? singular : plural}`;
  const importedLabel =
    delivery.total_na_lista === 1
      ? "destinatário importado"
      : "destinatários importados";

  return `Há ${formatNumber(delivery.total_na_lista)} ${importedLabel}, mas nenhum está apto a receber: ${formatCount(delivery.permitidos_modo_teste, "liberado", "liberados")}, ${formatCount(delivery.bloqueados_modo_teste, "bloqueado pelo modo de segurança", "bloqueados pelo modo de segurança")} e ${formatCount(delivery.suprimidos_no_envio, "suprimido", "suprimidos")}.`;
}