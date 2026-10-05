import { randomUUID } from "node:crypto";
import { supabaseAdminClient } from "./supabase";
import {
  isSafeEmailForExternalValidation,
  normalizeEmail,
} from "./csv-import";
import {
  validateZeroBounceBatch,
  type ZeroBounceEmailResult,
  ZeroBounceError,
} from "./zerobounce";
import { getTechnicalError } from "./technical-error";
import { logger } from "./logger";

const BATCH_SIZE = 100;
const MAX_ADDRESS_ATTEMPTS = 3;
const PROVIDER_RETRY_MS = 30_000;
const MAX_CACHE_QUERY_LENGTH = 5_500;

type ValidationJob = {
  id: string;
  campanha_id: string;
  status: string;
  processados: number;
  tentativas: number;
};

type ValidationJobItem = {
  id: string;
  job_id: string;
  destinatario_id: string;
  email: string;
  email_normalizado: string | null;
  status: string;
  tentativas: number;
};

type CachedEmail = {
  email: string;
  status: string;
  sub_status: string | null;
  free_email: boolean | null;
  did_you_mean: string | null;
  dominio: string | null;
  smtp_provider: string | null;
  mx_found: boolean | null;
  resposta_bruta: Record<string, unknown>;
  verificado_em: string;
};

function cacheQueryLength(emails: readonly string[]): number {
  const values = emails
    .map((email) => `"${email.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`)
    .join(",");
  return new URLSearchParams({
    select: "email,status,verificado_em",
    email: `in.(${values})`,
  }).toString().length;
}

function queryBatches(emails: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const email of [...new Set(emails)]) {
    const candidate = [...current, email];
    if (current.length > 0 && cacheQueryLength(candidate) > MAX_CACHE_QUERY_LENGTH) {
      batches.push(current);
      current = [email];
    } else {
      current = candidate;
    }
    if (cacheQueryLength(current) > MAX_CACHE_QUERY_LENGTH) {
      throw new Error("A normalized e-mail exceeds the cache query URL budget.");
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function loadCache(emails: readonly string[]): Promise<Map<string, CachedEmail>> {
  const cache = new Map<string, CachedEmail>();
  const client = supabaseAdminClient();
  for (const batch of queryBatches(emails)) {
    const { data, error } = await client
      .from("verificacao_email")
      .select("email,status,sub_status,free_email,did_you_mean,dominio,smtp_provider,mx_found,resposta_bruta,verificado_em")
      .in("email", batch);
    if (error) throw error;
    for (const row of data ?? []) cache.set(row.email, row as CachedEmail);
  }
  return cache;
}

function validCacheEmail(email: string): boolean {
  return isSafeEmailForExternalValidation(email);
}

async function selectJob(): Promise<ValidationJob | null> {
  const client = supabaseAdminClient();
  const processing = await client
    .from("validacao_email_job")
    .select("id,campanha_id,status,processados,tentativas")
    .eq("status", "processando")
    .order("criado_em")
    .limit(1)
    .maybeSingle();
  if (processing.error) throw processing.error;
  if (processing.data) return processing.data as ValidationJob;

  const pending = await client
    .from("validacao_email_job")
    .select("id,campanha_id,status,processados,tentativas")
    .eq("status", "pendente")
    .lte("proxima_tentativa_em", new Date().toISOString())
    .order("criado_em")
    .limit(1)
    .maybeSingle();
  if (pending.error) throw pending.error;
  if (!pending.data) return null;
  const claimed = await client
    .from("validacao_email_job")
    .update({
      status: "processando",
      iniciado_em: new Date().toISOString(),
      erro: null,
    })
    .eq("id", pending.data.id)
    .eq("status", "pendente")
    .select("id,campanha_id,status,processados,tentativas")
    .maybeSingle();
  if (claimed.error) throw claimed.error;
  return claimed.data as ValidationJob | null;
}

async function updateItems(
  updates: Array<{ id: string; values: Record<string, unknown> }>,
): Promise<void> {
  const client = supabaseAdminClient();
  const concurrency = 10;
  for (let offset = 0; offset < updates.length; offset += concurrency) {
    const group = updates.slice(offset, offset + concurrency);
    const results = await Promise.all(group.map(({ id, values }) =>
      client.from("validacao_email_job_item").update(values).eq("id", id),
    ));
    const failed = results.find((result) => result.error)?.error;
    if (failed) throw failed;
  }
}

async function persistCache(results: readonly ZeroBounceEmailResult[], jobId: string) {
  if (results.length === 0) return;
  const verifiedAt = new Date().toISOString();
  const rows = results.map((result) => ({
    email: result.email,
    status: result.status,
    sub_status: result.subStatus,
    free_email: result.freeEmail,
    did_you_mean: result.didYouMean,
    dominio: result.domain,
    smtp_provider: result.smtpProvider,
    mx_found: result.mxFound,
    resposta_bruta: result.raw,
    verificado_em: verifiedAt,
    origem: `campaign-validation:${jobId}`,
  }));
  const { error } = await supabaseAdminClient()
    .from("verificacao_email")
    .upsert(rows, { onConflict: "email", ignoreDuplicates: true });
  if (error) throw error;
}

async function markJob(
  jobId: string,
  status: string,
  values: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("validacao_email_job")
    .update({ status, ...values })
    .eq("id", jobId);
  if (error) throw error;
}

async function releaseClaims(token: string): Promise<void> {
  const { error } = await supabaseAdminClient().rpc(
    "liberar_verificacao_email_batch",
    { p_token: token },
  );
  if (error) throw error;
}

async function claimEmails(jobId: string, emails: string[], token: string) {
  const { data, error } = await supabaseAdminClient().rpc(
    "claim_verificacao_email_batch",
    { p_job_id: jobId, p_emails: emails, p_token: token },
  );
  if (error) throw error;
  const result = data as {
    claimed?: string[];
    cached?: string[];
    busy?: string[];
    rate_limited?: boolean;
  } | null;
  return {
    claimed: result?.claimed ?? [],
    cached: result?.cached ?? [],
    busy: result?.busy ?? [],
    rateLimited: result?.rate_limited === true,
  };
}

async function findItems(jobId: string): Promise<ValidationJobItem[]> {
  const { data, error } = await supabaseAdminClient()
    .from("validacao_email_job_item")
    .select("id,job_id,destinatario_id,email,email_normalizado,status,tentativas")
    .eq("job_id", jobId)
    .eq("status", "pendente")
    .order("id")
    .limit(BATCH_SIZE);
  if (error) throw error;
  return (data ?? []) as ValidationJobItem[];
}

async function applyCached(
  items: readonly ValidationJobItem[],
  cache: ReadonlyMap<string, CachedEmail>,
): Promise<number> {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  for (const item of items) {
    const email = item.email_normalizado;
    if (!email) {
      if (!validCacheEmail(item.email)) {
        updates.push({
          id: item.id,
          values: {
            status: "formato_invalido",
            email_normalizado: null,
            erro: "Endereço rejeitado antes da validação externa por conter formato invisível ou inválido.",
          },
        });
      }
      continue;
    }
    if (!cache.has(email)) continue;
    const result = cache.get(email)!;
    updates.push({
      id: item.id,
      values: {
        status: "validado",
        resultado_status: result.status,
        resposta_bruta: result.resposta_bruta,
        verificado_em: result.verificado_em,
        erro: null,
        tentativas: item.tentativas,
        proxima_tentativa_em: null,
      },
    });
  }
  await updateItems(updates);
  return updates.length;
}

async function markFormatErrors(items: readonly ValidationJobItem[]): Promise<number> {
  const malformed = items.filter((item) => !validCacheEmail(item.email));
  await updateItems(malformed.map((item) => ({
    id: item.id,
    values: {
      status: "formato_invalido",
      email_normalizado: null,
      erro: "Endereço rejeitado antes da validação externa por conter formato invisível ou inválido.",
      proxima_tentativa_em: null,
    },
  })));
  return malformed.length;
}

function itemUpdate(
  item: ValidationJobItem,
  status: string,
  result?: ZeroBounceEmailResult,
  rawError?: Record<string, unknown>,
  message?: string,
) {
  const attempts = status === "erro" ? item.tentativas + 1 : item.tentativas;
  return {
    id: item.id,
    values: {
      status,
      ...(result ? {
        resultado_status: result.status,
        resposta_bruta: result.raw,
        verificado_em: new Date().toISOString(),
      } : {}),
      ...(rawError ? { resposta_bruta: rawError } : {}),
      erro: message ?? null,
      tentativas: attempts,
      proxima_tentativa_em: status === "erro"
        ? new Date(Date.now() + PROVIDER_RETRY_MS * Math.min(attempts, 8)).toISOString()
        : null,
    },
  };
}

async function finishOrRetry(job: ValidationJob): Promise<void> {
  const client = supabaseAdminClient();
  const dueErrors = await client
    .from("validacao_email_job_item")
    .select("id")
    .eq("job_id", job.id)
    .eq("status", "erro")
    .lt("tentativas", MAX_ADDRESS_ATTEMPTS)
    .lte("proxima_tentativa_em", new Date().toISOString())
    .limit(BATCH_SIZE);
  if (dueErrors.error) throw dueErrors.error;
  if (dueErrors.data?.length) {
    const reset = await client
      .from("validacao_email_job_item")
      .update({ status: "pendente", proxima_tentativa_em: null })
      .in("id", dueErrors.data.map((row) => row.id));
    if (reset.error) throw reset.error;
    await markJob(job.id, "pendente", { proxima_tentativa_em: new Date().toISOString() });
    return;
  }

  const [pending, errors] = await Promise.all([
    client.from("validacao_email_job_item").select("id", { count: "exact", head: true })
      .eq("job_id", job.id).eq("status", "pendente"),
    client.from("validacao_email_job_item").select("id,tentativas,proxima_tentativa_em", { count: "exact" })
      .eq("job_id", job.id).eq("status", "erro").order("proxima_tentativa_em").limit(1),
  ]);
  if (pending.error) throw pending.error;
  if (errors.error) throw errors.error;
  if ((pending.count ?? 0) > 0) {
    await markJob(job.id, "pendente", {
      proxima_tentativa_em: new Date(Date.now() + 15_000).toISOString(),
    });
    return;
  }
  if ((errors.count ?? 0) > 0) {
    const earliest = errors.data?.[0];
    const exhausted =
      (earliest?.tentativas ?? 0) >= MAX_ADDRESS_ATTEMPTS ||
      !earliest?.proxima_tentativa_em;
    if (exhausted) {
      await markJob(job.id, "erro", {
        erro: "Um ou mais endereços não puderam ser verificados após três tentativas. Retome para tentar novamente.",
      });
    } else {
      await markJob(job.id, "pendente", {
        proxima_tentativa_em: earliest.proxima_tentativa_em,
        erro: "Há falhas temporárias por endereço; o worker tentará novamente.",
      });
    }
    return;
  }
  const { error: finishError } = await client.rpc(
    "finalizar_job_validacao_email",
    { p_job_id: job.id },
  );
  if (finishError) throw finishError;
}

async function processJobBatch(job: ValidationJob): Promise<void> {
  const client = supabaseAdminClient();
  const items = await findItems(job.id);
  if (items.length === 0) {
    await finishOrRetry(job);
    return;
  }

  const malformedCount = await markFormatErrors(items);
  const wellFormed = items
    .filter((item) => validCacheEmail(item.email))
    .map((item) => ({ ...item, email_normalizado: normalizeEmail(item.email) }));
  const normalizedByItem = new Map(wellFormed.map((item) => [
    item.id,
    normalizeEmail(item.email),
  ]));
  const normalizedEmails = [...new Set(normalizedByItem.values())];
  for (const [itemId, email] of normalizedByItem) {
    const { error } = await client.from("validacao_email_job_item")
      .update({ email_normalizado: email }).eq("id", itemId);
    if (error) throw error;
  }

  const cache = await loadCache(normalizedEmails);
  const cachedCount = await applyCached(wellFormed, cache);
  const cacheMisses = normalizedEmails.filter((email) => !cache.has(email));
  if (cacheMisses.length === 0) {
    const completed = malformedCount + cachedCount;
    if (completed > 0) {
      await markJob(job.id, "processando", {
        processados: job.processados + completed,
        erro: null,
      });
    }
    await finishOrRetry({ ...job, processados: job.processados + completed });
    return;
  }

  const token = randomUUID();
  let claimed: string[] = [];
  try {
    const claim = await claimEmails(job.id, cacheMisses, token);
    if (claim.rateLimited) {
      await markJob(job.id, "pendente", {
        proxima_tentativa_em: new Date(Date.now() + 15_000).toISOString(),
      });
      return;
    }
    claimed = claim.claimed;
    let newlyCachedCount = 0;

    if (claim.cached.length) {
      const newlyCached = await loadCache(claim.cached);
      for (const item of wellFormed) {
        const email = normalizedByItem.get(item.id);
        const result = newlyCached.get(email ?? "");
        if (result) {
          const { error } = await client.from("validacao_email_job_item")
            .update({
              status: "validado",
              resultado_status: result.status,
              resposta_bruta: result.resposta_bruta,
              verificado_em: result.verificado_em,
              erro: null,
              proxima_tentativa_em: null,
            }).eq("id", item.id);
          if (error) throw error;
          newlyCachedCount += 1;
        }
      }
    }
    if (claimed.length === 0) {
      const completed = malformedCount + cachedCount + newlyCachedCount;
      if (completed > 0) {
        await markJob(job.id, "processando", {
          processados: job.processados + completed,
          erro: null,
        });
      }
      await finishOrRetry({ ...job, processados: job.processados + completed });
      if (claim.busy.length > 0) {
        await markJob(job.id, "pendente", {
          proxima_tentativa_em: new Date(Date.now() + 15_000).toISOString(),
        });
      }
      return;
    }

    let results;
    try {
      results = await validateZeroBounceBatch(claimed);
    } catch (error) {
      if (error instanceof ZeroBounceError && error.insufficientCredits) {
        await markJob(job.id, "sem_creditos", {
          erro: "A ZeroBounce informou saldo insuficiente. Atualize os créditos e retome a validação.",
        });
        return;
      }
      if (error instanceof ZeroBounceError && error.status === 429) {
        await markJob(job.id, "pendente", {
          proxima_tentativa_em: new Date(Date.now() + (error.retryAfterMs ?? 10 * 60_000)).toISOString(),
          erro: "A ZeroBounce limitou temporariamente as solicitações. A fila será retomada depois.",
        });
        return;
      }
      const technicalError = getTechnicalError(error);
      const failedItems = wellFormed.filter((item) =>
        claimed.includes(normalizedByItem.get(item.id) ?? ""),
      );
      await updateItems(failedItems.map((item) =>
        itemUpdate(item, "erro", undefined, undefined, technicalError.message),
      ));
      await markJob(job.id, "processando", {
        tentativas: job.tentativas + 1,
        erro: "A validação externa falhou; endereços não foram armazenados no cache.",
      });
      return;
    }

    const successful = results.flatMap((item) =>
      item.kind === "result" ? [item.value] : [],
    );
    await persistCache(successful, job.id);
    const resultByEmail = new Map(
      results.flatMap((item) =>
        item.kind === "global_error"
          ? []
          : [[item.kind === "result" ? item.value.email : item.email, item] as const],
      ),
    );
    const updates = wellFormed
      .filter((item) => {
        const email = normalizedByItem.get(item.id) ?? "";
        return claimed.includes(email) && resultByEmail.has(email);
      })
      .map((item) => {
        const email = normalizedByItem.get(item.id)!;
        const result = resultByEmail.get(email);
        if (!result) {
          return itemUpdate(item, "erro", undefined, undefined, "Resposta individual ausente.");
        }
        return result.kind === "result"
          ? itemUpdate(item, "validado", result.value)
          : itemUpdate(item, "erro", undefined, result.raw, result.message);
      });
    await updateItems(updates);

    const completed = malformedCount + cachedCount + newlyCachedCount +
      updates.filter((update) => update.values.status === "validado").length;
    const insufficientCreditsForAddress = results.some(
      (item) =>
        item.kind === "global_error" ||
        (item.kind === "error" &&
          /insufficient\s+credits|not\s+enough\s+credits|no\s+credits|out\s+of\s+credits/i.test(
            item.message,
          )),
    );
    await markJob(job.id, "processando", {
      processados: job.processados + completed,
      erro: insufficientCreditsForAddress
        ? "A ZeroBounce informou saldo insuficiente."
        : results.some((item) => item.kind === "error")
        ? "Um ou mais endereços tiveram erro individual e serão tentados novamente."
        : null,
    });
    if (insufficientCreditsForAddress) {
      await markJob(job.id, "sem_creditos", {
        erro: "A ZeroBounce informou saldo insuficiente. Atualize os créditos e retome a validação.",
      });
      return;
    }
    await finishOrRetry({ ...job, processados: job.processados + completed });
  } finally {
    if (claimed.length) await releaseClaims(token);
  }
}

export async function processCampaignEmailValidationJobs(): Promise<number> {
  const job = await selectJob();
  if (!job) return 0;
  try {
    if (!process.env.ZEROBOUNCE_API_KEY?.trim()) {
      await markJob(job.id, "erro", {
        erro: "Configure ZEROBOUNCE_API_KEY no Repl do worker e retome a validação.",
      });
      return 0;
    }
    await processJobBatch(job);
    return 1;
  } catch (error) {
    logger.error(
      { jobId: job.id, technicalError: getTechnicalError(error) },
      "Campaign email validation worker batch failed",
    );
    await markJob(job.id, "pendente", {
      proxima_tentativa_em: new Date(Date.now() + PROVIDER_RETRY_MS).toISOString(),
      erro: "O worker encontrou uma falha temporária. Nenhum resultado incerto foi armazenado.",
    });
    return 0;
  }
}
