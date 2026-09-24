type ValidationIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
  received?: string;
};

const FIELD_LABELS: Record<string, string> = {
  nome: "nome",
  assunto: "assunto",
  assunto_lembrete: "assunto do lembrete",
  remetente_nome: "nome do remetente",
  remetente_email: "e-mail do remetente",
  valor_credito: "valor do crédito",
  validade_credito: "validade do crédito",
  teto_hora: "teto por hora",
  teto_dia: "teto por dia",
  status: "status",
  agendada_para: "agendamento",
  lembrete_ativo: "lembrete ativo",
  lembrete_horas: "horas até o lembrete",
  teste_enviado: "teste enviado",
  corpo: "corpo do e-mail",
  nome_arquivo: "nome do arquivo",
  tamanho: "tamanho do arquivo",
  mime_type: "tipo do arquivo",
  storage_path: "caminho do arquivo",
};

function issueMessage(issue: ValidationIssue): string {
  const firstPath = issue.path?.[0];
  const field =
    typeof firstPath === "string"
      ? FIELD_LABELS[firstPath] ?? firstPath
      : "dados enviados";
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `Campo obrigatório: ${field}.`;
  }
  return `Campo inválido: ${field}. ${issue.message ?? "Confira o valor informado."}`;
}

export function formatValidationError(error: unknown): string {
  const issues =
    typeof error === "object" && error !== null
      ? (error as { issues?: unknown[] }).issues
      : undefined;
  const firstIssue = issues?.find(
    (issue): issue is ValidationIssue =>
      typeof issue === "object" && issue !== null,
  );
  return firstIssue
    ? issueMessage(firstIssue)
    : "Confira os campos obrigatórios e tente novamente.";
}