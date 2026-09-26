import { getDownloadBiExportUrl } from "@workspace/api-client-react";

export type BiExportDownload = {
  blob: Blob;
  filename: string;
};

function responseErrorText(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const message = (parsed as { error?: unknown }).error;
      return typeof message === "string" ? message : null;
    }
  } catch {
    // Error responses may be plain text; do not show arbitrary HTML to the user.
  }
  return null;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;

  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(header);
  const ordinary =
    /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/iu.exec(header);
  let filename = extended?.[1]?.trim();
  if (filename) {
    try {
      filename = decodeURIComponent(filename);
    } catch {
      filename = undefined;
    }
  }
  filename ??= ordinary?.[1]?.replace(/\\(.)/gu, "$1") ?? ordinary?.[2]?.trim();
  if (!filename) return null;

  const safe = filename
    .replace(/[\\/\u0000-\u001f\u007f"]/gu, "-")
    .replace(/^\.+/u, "")
    .trim();
  return safe.toLowerCase().endsWith(".csv") ? safe : null;
}

function fallbackFilename(): string {
  return `amoconecta-export-${new Date().toISOString().slice(0, 10)}.csv`;
}

function httpErrorMessage(status: number, detail: string | null): string {
  if (status === 401) {
    return "Sua sessão expirou. Entre novamente e tente baixar o CSV.";
  }
  if (status === 404) {
    return "Este arquivo expirou ou não está disponível. Solicite uma nova exportação.";
  }
  const serverDetail = detail ? ` Detalhe: ${detail}` : "";
  return `A API não conseguiu entregar o CSV (HTTP ${status}). Tente novamente em instantes.${serverDetail}`;
}

export async function downloadBiExportFile(
  exportId: string,
  fetcher: typeof fetch = fetch,
): Promise<BiExportDownload> {
  let response: Response;
  try {
    // Keep the raw response: text/csv needs explicit Blob handling, and the
    // filename lives in Content-Disposition rather than in the generated hook.
    response = await fetcher(getDownloadBiExportUrl(exportId), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "text/csv" },
    });
  } catch {
    throw new Error(
      "Não foi possível conectar à API para baixar o CSV. Verifique sua conexão e tente novamente.",
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(httpErrorMessage(response.status, responseErrorText(body)));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/csv(?:\s*;|$)/iu.test(contentType)) {
    throw new Error(
      `A API respondeu sem um arquivo CSV válido (Content-Type: ${contentType || "ausente"}). Atualize a página e tente novamente.`,
    );
  }

  const disposition = response.headers.get("content-disposition");
  if (!disposition || !/\battachment\b/iu.test(disposition)) {
    throw new Error(
      "A API não marcou o arquivo como anexo para download. Tente novamente; se persistir, informe a equipe técnica.",
    );
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new Error(
      "A resposta da API chegou, mas o navegador não conseguiu ler o arquivo CSV. Tente novamente.",
    );
  }
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error(
      "A API não entregou um arquivo CSV válido. Gere uma nova exportação e tente novamente.",
    );
  }

  return {
    blob,
    filename: filenameFromDisposition(disposition) ?? fallbackFilename(),
  };
}