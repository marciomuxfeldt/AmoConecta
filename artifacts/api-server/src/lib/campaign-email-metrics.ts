export type CampaignEmailMetricCounts = {
  destinatarios: number;
  enviados: number;
  entregues: number;
  aberturas: number;
  cliques: number;
  bounces: number;
  bouncesPermanentes: number;
  bouncesTemporarios: number;
  bouncesIndeterminados: number;
  reclamacoes: number;
  descadastros: number;
};

export type CampaignEmailMetric = {
  quantidade: number;
  percentual: number;
};

export type CampaignEmailMetrics = {
  enviados: CampaignEmailMetric;
  entregues: CampaignEmailMetric;
  aberturas: CampaignEmailMetric;
  cliques: CampaignEmailMetric;
  bounces: CampaignEmailMetric;
  bounces_permanentes: CampaignEmailMetric;
  bounces_temporarios: CampaignEmailMetric;
  bounces_indeterminados: CampaignEmailMetric;
  reclamacoes: CampaignEmailMetric;
  descadastros: CampaignEmailMetric;
};

export function buildCampaignEmailMetrics(
  counts: CampaignEmailMetricCounts,
  recipientListTotal = counts.destinatarios,
): CampaignEmailMetrics {
  const metric = (quantity: number, denominator: number): CampaignEmailMetric => ({
    quantidade: quantity,
    percentual: denominator > 0 ? (quantity / denominator) * 100 : 0,
  });

  return {
    enviados: metric(counts.enviados, recipientListTotal),
    entregues: metric(counts.entregues, counts.enviados),
    aberturas: metric(counts.aberturas, counts.entregues),
    cliques: metric(counts.cliques, counts.entregues),
    bounces: metric(counts.bounces, counts.enviados),
    bounces_permanentes: metric(counts.bouncesPermanentes, counts.enviados),
    bounces_temporarios: metric(counts.bouncesTemporarios, counts.enviados),
    bounces_indeterminados: metric(counts.bouncesIndeterminados, counts.enviados),
    reclamacoes: metric(counts.reclamacoes, counts.entregues),
    descadastros: metric(counts.descadastros, counts.entregues),
  };
}