import { Router, type IRouter, type Request } from "express";
import {
  CreateCampaignBody,
  CreateCampaignResponse,
  GetCampaignParams,
  GetCampaignResponse,
  ListCampaignsResponse,
  RequestCampaignAssetUploadUrlBody,
  RequestCampaignAssetUploadUrlResponse,
  UpdateCampaignBody,
  UpdateCampaignResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";
import { getTechnicalError } from "../lib/technical-error";
import { normalizeEmailBlocks } from "@workspace/email-template";
import { getSafetyMode, getSafetyModeMessage } from "../lib/safety-mode";

const router: IRouter = Router();
const CAMPAIGN_COLUMNS =
  "id,nome,assunto,assunto_lembrete,remetente_nome,remetente_email,valor_credito,validade_credito,url_deeplink,url_landing,teto_hora,teto_dia,status,agendada_para,lembrete_ativo,lembrete_horas,teste_enviado,corpo,criado_em";
// Public by design: this bucket contains only e-mail image assets.
// Never reuse the private CSV bucket from routes/imports.ts here.
const EMAIL_ASSET_BUCKET = "amoconecta-assets";
const MAX_EMAIL_IMAGE_BYTES = 5 * 1024 * 1024;
const EMAIL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

function logSupabaseError(
  req: Request,
  operation: string,
  error: unknown,
): void {
  req.log.error({ technicalError: getTechnicalError(error) }, operation);
}

function dateValue(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnlyValue(value: unknown): string | null {
  const result = dateValue(value);
  return result ? result.slice(0, 10) : null;
}

function campaignPayload(input: Record<string, unknown>, partial = false) {
  const payload: Record<string, unknown> = {};
  const stringFields = [
    "nome",
    "assunto",
    "remetente_nome",
    "remetente_email",
  ];
  for (const field of stringFields) {
    if (!partial || field in input) payload[field] = String(input[field] ?? "").trim();
  }

  if (!partial || "assunto_lembrete" in input) {
    payload.assunto_lembrete =
      typeof input.assunto_lembrete === "string" && input.assunto_lembrete.trim()
        ? input.assunto_lembrete.trim()
        : null;
  }
  if (!partial || "valor_credito" in input) {
    payload.valor_credito = input.valor_credito ?? null;
  }
  if (!partial || "validade_credito" in input) {
    payload.validade_credito = dateOnlyValue(input.validade_credito);
  }
  if (!partial || "url_deeplink" in input) {
    payload.url_deeplink = input.url_deeplink || null;
  }
  if (!partial || "url_landing" in input) {
    payload.url_landing = input.url_landing || null;
  }
  if (!partial || "teto_hora" in input) payload.teto_hora = input.teto_hora ?? null;
  if (!partial || "teto_dia" in input) payload.teto_dia = input.teto_dia ?? null;
  if (!partial || "status" in input) payload.status = input.status ?? "rascunho";
  if (!partial || "agendada_para" in input) {
    payload.agendada_para = dateValue(input.agendada_para);
  }
  if (!partial || "lembrete_ativo" in input) {
    payload.lembrete_ativo = input.lembrete_ativo ?? false;
  }
  if (!partial || "lembrete_horas" in input) {
    payload.lembrete_horas = input.lembrete_horas ?? 48;
  }
  if (!partial || "teste_enviado" in input) {
    payload.teste_enviado = input.teste_enviado ?? false;
  }
  if (!partial || "corpo" in input) {
    payload.corpo = normalizeEmailBlocks(input.corpo);
  }
  return payload;
}

function safeAssetFileName(fileName: string, mimeType: string): string {
  const base = fileName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/u, "")
    .toLocaleLowerCase("pt-BR");
  const extension = mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1];
  const withoutExtension = base.replace(/\.[a-z0-9]+$/iu, "") || "imagem";
  return `${withoutExtension}.${extension}`;
}

async function ensurePublicAssetBucket() {
  const client = supabaseAdminClient();
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw listError;
  const bucket = buckets?.find((item) => item.name === EMAIL_ASSET_BUCKET);
  if (!bucket) {
    const { error } = await client.storage.createBucket(EMAIL_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_EMAIL_IMAGE_BYTES}B`,
      allowedMimeTypes: [...EMAIL_IMAGE_TYPES],
    });
    if (error && !/already exists|duplicate/iu.test(error.message ?? "")) throw error;
  } else if (!bucket.public) {
    const { error } = await client.storage.updateBucket(EMAIL_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_EMAIL_IMAGE_BYTES}B`,
      allowedMimeTypes: [...EMAIL_IMAGE_TYPES],
    });
    if (error) throw error;
  }
  return client;
}

function campaignParams(campaignId: string) {
  return GetCampaignParams.parse({ campaignId });
}

async function findCampaign(campaignId: string) {
  const { data, error } = await supabaseAdminClient()
    .from("campanha")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

router.get("/campaigns", async (req, res) => {
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }

    const { data: campaigns, error } = await supabaseAdminClient()
      .from("campanha")
      .select("id,nome,status,agendada_para,criado_em")
      .order("criado_em", { ascending: false });

    if (error) {
      logSupabaseError(req, "Supabase campaign listing failed", error);
      res.status(502).json({ error: "Não foi possível carregar as campanhas." });
      return;
    }

    res.json(
      ListCampaignsResponse.parse(
        (campaigns ?? []).map((campaign) => ({
          ...campaign,
          enviados: 0,
          entregues: 0,
          abertos: 0,
          clicados: 0,
        })),
      ),
    );
  } catch (error) {
    logSupabaseError(req, "Campaign listing failed", error);
    res.status(502).json({ error: "Não foi possível carregar as campanhas." });
  }
});

router.post("/campaigns", async (req, res) => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Confira os dados da campanha." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      !getSafetyMode().envio_liberado
    ) {
      res.status(422).json({ error: getSafetyModeMessage() });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      !parsed.data.teste_enviado
    ) {
      res.status(422).json({
        error: "Envie e confirme o teste antes de agendar ou iniciar a campanha.",
      });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .insert(campaignPayload(parsed.data as Record<string, unknown>))
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase campaign creation failed", error);
      res.status(502).json({ error: "Não foi possível criar a campanha." });
      return;
    }
    res.status(201).json(CreateCampaignResponse.parse(data));
  } catch (error) {
    logSupabaseError(req, "Campaign creation failed", error);
    res.status(502).json({ error: "Não foi possível criar a campanha." });
  }
});

router.get("/campaigns/:campaignId", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .select(CAMPAIGN_COLUMNS)
      .eq("id", params.data.campaignId)
      .maybeSingle();
    if (error) {
      logSupabaseError(req, "Supabase campaign lookup failed", error);
      res.status(502).json({ error: "Não foi possível consultar a campanha." });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    res.json(GetCampaignResponse.parse(data));
  } catch (error) {
    logSupabaseError(req, "Campaign lookup failed", error);
    res.status(502).json({ error: "Não foi possível consultar a campanha." });
  }
});

router.post("/campaigns/:campaignId/assets/upload-url", async (req, res) => {
  const body = RequestCampaignAssetUploadUrlBody.safeParse(req.body);
  if (!body.success || !req.params.campaignId) {
    res.status(422).json({ error: "Informe uma imagem válida." });
    return;
  }
  if (body.data.tamanho > MAX_EMAIL_IMAGE_BYTES) {
    res.status(422).json({ error: "A imagem deve ter até 5 MB." });
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
    const client = await ensurePublicAssetBucket();
    const path = `${req.params.campaignId}/${crypto.randomUUID()}-${safeAssetFileName(body.data.nome_arquivo, body.data.mime_type)}`;
    const { data, error } = await client.storage
      .from(EMAIL_ASSET_BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      logSupabaseError(req, "Supabase email asset signed upload URL creation failed", error);
      res.status(502).json({ error: "Não foi possível preparar o upload da imagem." });
      return;
    }
    const publicUrl = client.storage.from(EMAIL_ASSET_BUCKET).getPublicUrl(path).data.publicUrl;
    res.json(
      RequestCampaignAssetUploadUrlResponse.parse({
        bucket: EMAIL_ASSET_BUCKET,
        path,
        signed_url: data.signedUrl,
        public_url: publicUrl,
        expires_in: 7200,
      }),
    );
  } catch (error) {
    logSupabaseError(req, "Campaign email asset upload URL request failed", error);
    res.status(502).json({ error: "Não foi possível preparar o upload da imagem." });
  }
});

router.patch("/campaigns/:campaignId", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  const parsed = UpdateCampaignBody.partial().safeParse(req.body);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  if (!parsed.success || Object.keys(req.body ?? {}).length === 0) {
    res.status(422).json({ error: "Nenhum dado válido foi enviado." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      !getSafetyMode().envio_liberado
    ) {
      res.status(422).json({ error: getSafetyModeMessage() });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      parsed.data.teste_enviado !== true
    ) {
      res.status(422).json({
        error: "Envie e confirme o teste antes de agendar ou iniciar a campanha.",
      });
      return;
    }
    const existing = await findCampaign(params.data.campaignId);
    if (!existing) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update(campaignPayload(parsed.data as Record<string, unknown>, true))
      .eq("id", params.data.campaignId)
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase campaign update failed", error);
      res.status(502).json({ error: "Não foi possível atualizar a campanha." });
      return;
    }
    res.json(UpdateCampaignResponse.parse(data));
  } catch (error) {
    logSupabaseError(req, "Campaign update failed", error);
    res.status(502).json({ error: "Não foi possível atualizar a campanha." });
  }
});

router.delete("/campaigns/:campaignId", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .delete()
      .eq("id", params.data.campaignId)
      .select("id")
      .maybeSingle();
    if (error) {
      logSupabaseError(req, "Supabase campaign deletion failed", error);
      res.status(502).json({ error: "Não foi possível excluir a campanha." });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    res.status(204).send();
  } catch (error) {
    logSupabaseError(req, "Campaign deletion failed", error);
    res.status(502).json({ error: "Não foi possível excluir a campanha." });
  }
});

export { campaignParams, findCampaign };
export default router;