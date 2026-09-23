export type TestSendErrorResponse = {
  status: 422 | 500 | 502 | 503;
  message: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function isUserActionableMessage(message: string): boolean {
  return /modo de segurança|suprimido|não encontrada|remetente da campanha|APP_BASE_URL|UNSUBSCRIBE_SECRET|RESEND_API_KEY|SENDER_EMAIL|SENDER_NAME|REPLY_TO_EMAIL|Resend não retornou/iu.test(
    message,
  );
}

export function getTestSendErrorResponse(error: unknown): TestSendErrorResponse {
  const message = errorMessage(error);
  if (isUserActionableMessage(message)) {
    return { status: 422, message };
  }

  const status = errorStatus(error);
  if (status === 429) {
    return {
      status: 503,
      message: "O provedor de e-mail está temporariamente indisponível. Tente novamente em instantes.",
    };
  }
  if (status !== null && status >= 400) {
    return {
      status: 502,
      message: "O provedor de e-mail recusou o envio do teste. Verifique a configuração e tente novamente.",
    };
  }
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return {
      status: 502,
      message: "Não foi possível concluir o envio do teste com o serviço de dados. Tente novamente.",
    };
  }
  return {
    status: 500,
    message: "Não foi possível enviar o teste agora. A falha foi registrada. Tente novamente mais tarde.",
  };
}