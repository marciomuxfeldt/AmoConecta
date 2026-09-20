import { Router, type IRouter, type Request } from "express";
import {
  RequestCampaignImportUploadUrlBody,
  RequestCampaignImportUploadUrlResponse,
  ValidateCampaignImportBody,
  ValidateCampaignImportResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { findCampaign } from "./campaigns";
import { supabaseAdminClient } from "../lib/supabase";
import {
  ImportValidationError,
  validateAndImportCsv,
} from "../lib/csv-import";

const router: IRouter = Router();
const IMPORT_BUCKET = "amoconecta-imports";
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

function logSupabaseError(req: Request, operation: string, error: unknown) {
  req.log.error({ supabaseError: error }, operation);
}

function safeFileName(fileName: string): string {
  const base = fileName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/u, "");
  return base.toLocaleLowerCase("pt-BR").endsWith(".csv") ? base : `${base}.csv`;
}

async function ensurePrivateBucket() {
  const client = supabaseAdminClient();
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw listError;
  if (!buckets?.some((bucket) => bucket.name === IMPORT_BUCKET)) {
    const { error } = await client.storage.createBucket(IMPORT_BUCKET, {
      public: false,
      fileSizeLimit: `${MAX_IMPORT_BYTES}B`,
      allowedMimeTypes: ["text/csv", "application/csv", "text/plain"],
    });
    if (error && !/already exists|duplicate/iu.test(error.message ?? "")) throw error;
  }
  return client;
}

router.post("/campaigns/:campaignId/imports/upload-url", async (req, res) => {
  const body = RequestCampaignImportUploadUrlBody.safeParse(req.body);
  if (!body.success || !req.params.campaignId) {
    res.status(422).json({ error: "Informe um arquivo CSV válido." });
    return;
  }
  if (
    body.data.tamanho > MAX_IMPORT_BYTES ||
    !body.data.nome_arquivo.toLocaleLowerCase("pt-BR").endsWith(".csv")
  ) {
    res.status(422).json({ error: "O arquivo deve ser CSV e ter até 50 MB." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const campaign = await findCampaign(req.params.campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const client = await ensurePrivateBucket();
    const path = `${req.params.campaignId}/${crypto.randomUUID()}-${safeFileName(body.data.nome_arquivo)}`;
    const { data, error } = await client.storage
      .from(IMPORT_BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      logSupabaseError(req, "Supabase signed upload URL creation failed", error);
      res.status(502).json({ error: "Não foi possível preparar o upload." });
      return;
    }
    res.json(
      RequestCampaignImportUploadUrlResponse.parse({
        bucket: IMPORT_BUCKET,
        path,
        signed_url: data.signedUrl,
        expires_in: 7200,
      }),
    );
  } catch (error) {
    logSupabaseError(req, "Import upload URL request failed", error);
    res.status(502).json({ error: "Não foi possível preparar o upload." });
  }
});

router.post("/campaigns/:campaignId/imports/validate", async (req, res) => {
  const body = ValidateCampaignImportBody.safeParse(req.body);
  if (!body.success || !req.params.campaignId) {
    res.status(422).json({ error: "Informe o caminho do arquivo enviado." });
    return;
  }
  const storagePath = body.data.storage_path;
  const expectedPrefix = `${req.params.campaignId}/`;
  if (
    !storagePath.startsWith(expectedPrefix) ||
    !/^[^/]+\/[a-f0-9-]+-[a-z0-9._-]+\.csv$/iu.test(storagePath)
  ) {
    res.status(422).json({ error: "Caminho de importação inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const campaign = await findCampaign(req.params.campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const client = supabaseAdminClient();
    const { data: signed, error: signedError } = await client.storage
      .from(IMPORT_BUCKET)
      .createSignedUrl(storagePath, 300);
    if (signedError) throw signedError;
    const fileResponse = await fetch(signed.signedUrl);
    if (!fileResponse.ok || !fileResponse.body) {
      throw new Error(`Falha ao baixar o arquivo de importação (${fileResponse.status}).`);
    }
    const summary = await validateAndImportCsv({
      client,
      stream: fileResponse.body,
      campaignId: req.params.campaignId,
      storagePath,
      deduplicatePhone: body.data.deduplicar_por_telefone,
    });
    res.json(ValidateCampaignImportResponse.parse(summary));
  } catch (error) {
    if (error instanceof ImportValidationError) {
      res.status(422).json({ error: error.message });
      return;
    }
    logSupabaseError(req, "Campaign import validation failed", error);
    res.status(502).json({ error: "Não foi possível validar o arquivo." });
  }
});

export default router;