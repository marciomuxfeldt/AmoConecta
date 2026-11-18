import { randomUUID } from "node:crypto";
import { supabaseAdminClient } from "./supabase";
import {
  isSafeEmailForExternalValidation,
} from "./csv-import";
import { normalizeEmail } from "./email-normalization";
import {
  validateZeroBounceBatch,
  type ZeroBounceEmailResult,
  ZeroBounceError,
} from "./zerobounce";
import { getTechnicalError } from "./technical-error";
import { logger } from "./logger";
import {
  createSerializedProgressCounter,
  progressTimestampForIncrease,
} from "./email-validation-progress";
import {
  EMAIL_VALIDATION_RATE_LIMIT_WAIT_MS,
  MAX_EMAIL_VALIDATION_CONCURRENT_REQUESTS,
  MAX_EMAIL_VALIDATION_CYCLE_DURATION_MS,
  MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE,
  runEmailValidationCycle,
  type EmailValidationBatchOutcome,
} from "./email-validation-cycle";

const BATCH_SIZE = 100;
const PENDING_SCAN_SIZE = BATCH_SIZE * MAX_EMAIL_VALIDATION_CONCURRENT_REQUESTS;
const MAX_ADDRESS_ATTEMPTS = 3;
const PROVIDER_RETRY_MS = 30_000;
const MAX_CACHE_QUERY_LENGTH = 5_500;

type ValidationJob = {
  id: string;
  campanha_id: string;
  status: string;
  total_pendentes: number;
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

type ValidationCycleMetrics = {
  pendingRowsFetched: number;
  pendingSearchMs: number;
  cacheLookupMs: number;
  reservationMs: number;
  zeroBounceRequestMs: number;
  providerWaveWallMs: number;
  resultWriteMs: number;
  limiterWaitMs: number;
  leaseReleaseMs: number;
  providerCalls: number;
  providerEmails: number;
  cacheHits: number;
  peakConcurrentRequests: number;
  stopDetail: string | null;
};

function createValidationCycleMetrics(): ValidationCycleMetrics {
  return {
    pendingRowsFetched: 0,
    pendingSearchMs: 0,
    cacheLookupMs: 0,
    reservationMs: 0,
    zeroBounceRequestMs: 0,
    providerWaveWallMs: 0,
    resultWriteMs: 0,
    limiterWaitMs: 0,
    leaseReleaseMs: 0,
    providerCalls: 0,
    providerEmails: 0,
    cacheHits: 0,
    peakConcurrentRequests: 0,
    stopDetail: null,
  };
}

function addElapsed(
  metrics: ValidationCycleMetrics,
  field: keyof Pick<
    ValidationCycleMetrics,
    | "pendingSearchMs"
    | "cacheLookupMs"
    | "reservationMs"
    | "zeroBounceRequestMs"
    | "providerWaveWallMs"
    | "resultWriteMs"
    | "limiterWaitMs"
    | "leaseReleaseMs"
  >,
  startedAt: number,
): void {
  metrics[field] += performance.now() - startedAt;
}

function splitIntoBatches<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
}

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
    .select("id,campanha_id,status,total_pendentes,processados,tentativas")
    .eq("status", "processando")
    .order("criado_em")
    .limit(1)
    .maybeSingle();
  if (processing.error) throw processing.error;
  if (processing.data) return processing.data as ValidationJob;

  const pending = await client
    .from("validacao_email_job")
    .select("id,campanha_id,status,total_pendentes,processados,tentativas")
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
      progresso_atualizado_em: new Date().toISOString(),
      erro: null,
    })
    .eq("id", pending.data.id)
    .eq("status", "pendente")
    .select("id,campanha_id,status,total_pendentes,processados,tentativas")
    .maybeSingle();
  if (claimed.error) throw claimed.error;
  return claimed.data as ValidationJob | null;
}

type ItemUpdate = { id: string; values: Record<string, unknown> };

type PersistedBatch = {
  jobProcessing: boolean;
  updatedItems: number;
  processedItems: number;
};

async function persistValidationBatch(
  jobId: string,
  cacheResults: readonly ZeroBounceEmailResult[],
  updates: readonly ItemUpdate[],
): Promise<PersistedBatch> {
  const verifiedAt = new Date().toISOString();
  const cacheRows = cacheResults.map((result) => ({
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
  const itemUpdates = updates.map(({ id, values }) => ({ id, ...values }));
  const { data, error } = await supabaseAdminClient().rpc(
    "persist_validacao_email_batch",
    {
      p_job_id: jobId,
      p_cache_rows: cacheRows,
      p_item_updates: itemUpdates,
    },
  );
  if (error) throw error;
  const persisted = data as {
    job_processing?: unknown;
    updated_items?: unknown;
    processed_items?: unknown;
  } | null;
  if (
    typeof persisted?.job_processing !== "boolean" ||
    !Number.isSafeInteger(persisted.updated_items) ||
    !Number.isSafeInteger(persisted.processed_items)
  ) {
    throw new Error("A persistência em lote retornou uma resposta inválida.");
  }
  return {
    jobProcessing: persisted.job_processing,
    updatedItems: persisted.updated_items as number,
    processedItems: persisted.processed_items as number,
  };
}

async function updateItems(
  jobId: string,
  updates: Array<{ id: string; values: Record<string, unknown> }>,
): Promise<PersistedBatch> {
  return persistValidationBatch(jobId, [], updates);
}

async function markJob(
  jobId: string,
  status: string,
  values: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("validacao_email_job")
    .update({ status, ...values })
    .eq("id", jobId)
    .neq("status", "cancelada");
  if (error) throw error;
}

type JobProgressTracker = {
  advance: (completedItems: number) => Promise<number>;
};

function createJobProgressTracker(job: ValidationJob): JobProgressTracker {
  return createSerializedProgressCounter(
    job.processados,
    job.total_pendentes,
    async (previous, next) => {
      await markJob(job.id, "processando", {
          processados: next,
          ...progressTimestampForIncrease(previous, next),
          erro: null,
      });
    },
  );
}

async function isJobProcessing(jobId: string): Promise<boolean> {
  const { data, error } = await supabaseAdminClient()
    .from("validacao_email_job")
    .select("id")
    .eq("id", jobId)
    .eq("status", "processando")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
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

async function findItems(
  jobId: string,
  limit = PENDING_SCAN_SIZE,
): Promise<ValidationJobItem[]> {
  const { data, error } = await supabaseAdminClient()
    .from("validacao_email_job_item")
    .select("id,job_id,destinatario_id,email,email_normalizado,status,tentativas")
    .eq("job_id", jobId)
    .eq("status", "pendente")
    .order("id")
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ValidationJobItem[];
}

function cachedItemUpdates(
  items: readonly ValidationJobItem[],
  cache: ReadonlyMap<string, CachedEmail>,
): ItemUpdate[] {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  for (const item of items) {
    const email = item.email_normalizado;
    if (!email) continue;
    if (!cache.has(email)) continue;
    const result = cache.get(email)!;
    updates.push({
      id: item.id,
      values: {
        status: "validado",
        email_normalizado: email,
        resultado_status: result.status,
        resposta_bruta: result.resposta_bruta,
        verificado_em: result.verificado_em,
        erro: null,
        tentativas: item.tentativas,
        proxima_tentativa_em: null,
      },
    });
  }
  return updates;
}

function formatErrorUpdates(items: readonly ValidationJobItem[]): ItemUpdate[] {
  return items.filter((item) => !validCacheEmail(item.email)).map((item) => ({
    id: item.id,
    values: {
      status: "formato_invalido",
      email_normalizado: null,
      erro: "Endereço rejeitado antes da validação externa por conter formato invisível ou inválido.",
      proxima_tentativa_em: null,
    },
  }));
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
      email_normalizado: item.email_normalizado ?? normalizeEmail(item.email),
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
  const exhausted = await client
    .from("validacao_email_job_item")
    .select("id")
    .eq("job_id", job.id)
    .eq("status", "erro")
    .gte("tentativas", MAX_ADDRESS_ATTEMPTS)
    .limit(BATCH_SIZE);
  if (exhausted.error) throw exhausted.error;
  if (exhausted.data?.length) {
    const ignoredIds = exhausted.data.map((row) => row.id);
    const ignored = await client
      .from("validacao_email_job_item")
      .update({
        status: "ignorado",
        erro: "Ignorado após atingir o limite de três tentativas.",
        proxima_tentativa_em: null,
      })
      .in("id", ignoredIds)
      .eq("status", "erro");
    if (ignored.error) throw ignored.error;
    const nextProcessed = Math.min(job.total_pendentes, job.processados + ignoredIds.length);
    await markJob(job.id, "pendente", {
      processados: nextProcessed,
      ...progressTimestampForIncrease(job.processados, nextProcessed),
      proxima_tentativa_em: new Date().toISOString(),
      erro: null,
    });
    return;
  }

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
    await markJob(job.id, "pendente", {
      proxima_tentativa_em: earliest?.proxima_tentativa_em ?? new Date().toISOString(),
      erro: "Há falhas temporárias por endereço; o worker tentará novamente.",
    });
    return;
  }
  const { error: finishError } = await client.rpc(
    "finalizar_job_validacao_email",
    { p_job_id: job.id },
  );
  if (finishError) throw finishError;
}

type ClaimedValidationBatch = {
  token: string;
  emails: string[];
  items: ValidationJobItem[];
};

type ValidationRequestOutcome =
  | { kind: "completed"; requestStarted: true; processedItems: number; hasAddressErrors: boolean; insufficientCredits: boolean }
  | { kind: "rate_limited"; requestStarted: true; retryAfterMs: number }
  | { kind: "insufficient_credits"; requestStarted: true }
  | { kind: "provider_error"; requestStarted: true; failedItems: number }
  | { kind: "cancelled"; requestStarted: true }
  | { kind: "not_started"; requestStarted: false };

async function processClaimedValidationBatch(
  job: ValidationJob,
  batch: ClaimedValidationBatch,
  metrics: ValidationCycleMetrics,
  hasTimeRemaining: () => boolean,
  activeRequests: {
    count: number;
    firstStartedAt: number | null;
    lastCompletedAt: number | null;
  },
  progress: JobProgressTracker,
): Promise<ValidationRequestOutcome> {
  if (!hasTimeRemaining()) return { kind: "not_started", requestStarted: false };

  activeRequests.count += 1;
  metrics.peakConcurrentRequests = Math.max(
    metrics.peakConcurrentRequests,
    activeRequests.count,
  );
  metrics.providerCalls += 1;
  metrics.providerEmails += batch.emails.length;
  const requestStartedAt = performance.now();
  activeRequests.firstStartedAt ??= requestStartedAt;
  let results: Awaited<ReturnType<typeof validateZeroBounceBatch>>;
  try {
    results = await validateZeroBounceBatch(batch.emails);
  } catch (error) {
    const requestCompletedAt = performance.now();
    metrics.zeroBounceRequestMs += requestCompletedAt - requestStartedAt;
    activeRequests.lastCompletedAt = Math.max(
      activeRequests.lastCompletedAt ?? requestCompletedAt,
      requestCompletedAt,
    );
    activeRequests.count -= 1;
    if (error instanceof ZeroBounceError && error.insufficientCredits) {
      return { kind: "insufficient_credits", requestStarted: true };
    }
    if (error instanceof ZeroBounceError && error.status === 429) {
      return {
        kind: "rate_limited",
        requestStarted: true,
        retryAfterMs: error.retryAfterMs ?? 10 * 60_000,
      };
    }
    const technicalError = getTechnicalError(error);
    const writeStartedAt = performance.now();
    const persisted = await updateItems(job.id, batch.items.map((item) =>
      itemUpdate(item, "erro", undefined, undefined, technicalError.message),
    ));
    addElapsed(metrics, "resultWriteMs", writeStartedAt);
    if (!persisted.jobProcessing) {
      return { kind: "cancelled", requestStarted: true };
    }
    return {
      kind: "provider_error",
      requestStarted: true,
      failedItems: batch.items.length,
    };
  }
  const requestCompletedAt = performance.now();
  metrics.zeroBounceRequestMs += requestCompletedAt - requestStartedAt;
  activeRequests.lastCompletedAt = Math.max(
    activeRequests.lastCompletedAt ?? requestCompletedAt,
    requestCompletedAt,
  );
  activeRequests.count -= 1;

  const writeStartedAt = performance.now();
  const successful = results.flatMap((item) =>
    item.kind === "result" ? [item.value] : [],
  );
  // Persist paid results before checking whether cancellation stopped this job.
  const resultByEmail = new Map(
    results.flatMap((item) =>
      item.kind === "global_error"
        ? []
        : [[item.kind === "result" ? item.value.email : item.email, item] as const],
    ),
  );
  const claimedEmails = new Set(batch.emails);
  const updates = batch.items
    .filter((item) => {
      const email = item.email_normalizado ?? normalizeEmail(item.email);
      return claimedEmails.has(email) && resultByEmail.has(email);
    })
    .map((item) => {
      const email = item.email_normalizado ?? normalizeEmail(item.email);
      const result = resultByEmail.get(email);
      if (!result) {
        return itemUpdate(item, "erro", undefined, undefined, "Resposta individual ausente.");
      }
      return result.kind === "result"
        ? itemUpdate(item, "validado", result.value)
        : itemUpdate(item, "erro", undefined, result.raw, result.message);
    });
  const persisted = await persistValidationBatch(job.id, successful, updates);
  addElapsed(metrics, "resultWriteMs", writeStartedAt);

  if (!persisted.jobProcessing) return { kind: "cancelled", requestStarted: true };
  const processedItems = persisted.processedItems;
  const progressStartedAt = performance.now();
  await progress.advance(processedItems);
  addElapsed(metrics, "resultWriteMs", progressStartedAt);

  const insufficientCredits = results.some(
    (item) =>
      item.kind === "global_error" ||
      (item.kind === "error" &&
        /insufficient\s+credits|not\s+enough\s+credits|no\s+credits|out\s+of\s+credits/i.test(
          item.message,
        )),
  );
  return {
    kind: "completed",
    requestStarted: true,
    processedItems,
    hasAddressErrors: results.some((item) => item.kind === "error"),
    insufficientCredits,
  };
}

async function processJobBatch(
  job: ValidationJob,
  requestCapacity: number,
  hasTimeRemaining: () => boolean,
  metrics: ValidationCycleMetrics,
  progress: JobProgressTracker,
): Promise<EmailValidationBatchOutcome> {
  if (!(await isJobProcessing(job.id))) {
    metrics.stopDetail = "job_no_longer_processing";
    return { requestsStarted: 0, processedItems: 0, continueProcessing: false };
  }
  const searchStartedAt = performance.now();
  const items = await findItems(job.id);
  addElapsed(metrics, "pendingSearchMs", searchStartedAt);
  metrics.pendingRowsFetched += items.length;
  if (items.length === 0) {
    await finishOrRetry(job);
    metrics.stopDetail = "no_pending_items";
    return { requestsStarted: 0, processedItems: 0, continueProcessing: false };
  }

  const malformedItems = items.filter((item) => !validCacheEmail(item.email));
  const wellFormed = items
    .filter((item) => validCacheEmail(item.email))
    .map((item) => ({ ...item, email_normalizado: normalizeEmail(item.email) }));
  const itemsByEmail = new Map<string, ValidationJobItem[]>();
  for (const item of wellFormed) {
    const email = item.email_normalizado!;
    const matchingItems = itemsByEmail.get(email) ?? [];
    matchingItems.push(item);
    itemsByEmail.set(email, matchingItems);
  }
  const normalizedEmails = [...itemsByEmail.keys()];

  const cacheReadStartedAt = performance.now();
  const cache = await loadCache(normalizedEmails);
  addElapsed(metrics, "cacheLookupMs", cacheReadStartedAt);
  const cachedUpdates = cachedItemUpdates(wellFormed, cache);
  const initialUpdates = [
    ...formatErrorUpdates(malformedItems),
    ...cachedUpdates,
  ];
  let immediatelyCompleted = 0;
  if (initialUpdates.length > 0) {
    const writeStartedAt = performance.now();
    const persisted = await updateItems(job.id, initialUpdates);
    addElapsed(metrics, "resultWriteMs", writeStartedAt);
    metrics.cacheHits += cachedUpdates.length;
    if (!persisted.jobProcessing) {
      metrics.stopDetail = "job_no_longer_processing";
      return {
        requestsStarted: 0,
        processedItems: persisted.processedItems,
        continueProcessing: false,
      };
    }
    immediatelyCompleted = persisted.processedItems;
  }
  const progressWriteStartedAt = performance.now();
  await progress.advance(immediatelyCompleted);
  addElapsed(metrics, "resultWriteMs", progressWriteStartedAt);

  const cacheMisses = normalizedEmails.filter((email) => !cache.has(email));
  if (cacheMisses.length === 0) {
    return {
      requestsStarted: 0,
      processedItems: immediatelyCompleted,
      continueProcessing: true,
    };
  }
  if (!hasTimeRemaining()) {
    return {
      requestsStarted: 0,
      processedItems: immediatelyCompleted,
      continueProcessing: true,
    };
  }

  const requestGroups = splitIntoBatches(cacheMisses, BATCH_SIZE)
    .slice(0, requestCapacity);
  const claimAttempts = await Promise.allSettled(requestGroups.map(async (emails) => {
    if (!hasTimeRemaining()) return { kind: "not_started" as const };
    const token = randomUUID();
    const reservationStartedAt = performance.now();
    const claim = await claimEmails(job.id, emails, token);
    addElapsed(metrics, "reservationMs", reservationStartedAt);
    return { kind: "claimed" as const, token, emails, claim };
  }));
  const rejectedClaim = claimAttempts.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const successfulClaims = claimAttempts.flatMap((result) =>
    result.status === "fulfilled" && result.value.kind === "claimed"
      ? [result.value]
      : [],
  );
  const heldClaims = successfulClaims.filter((result) => result.claim.claimed.length > 0);
  if (rejectedClaim) {
    const releaseStartedAt = performance.now();
    await Promise.allSettled(heldClaims.map((result) => releaseClaims(result.token)));
    addElapsed(metrics, "leaseReleaseMs", releaseStartedAt);
    throw rejectedClaim.reason;
  }

  const busy = successfulClaims.some((result) => result.claim.busy.length > 0);
  const rateLimited = successfulClaims.some((result) => result.claim.rateLimited);
  const newlyCachedEmails = [...new Set(
    successfulClaims.flatMap((result) => result.claim.cached),
  )];

  try {
    let newlyCachedCount = 0;
    if (newlyCachedEmails.length > 0) {
      const cacheReadStartedAt = performance.now();
      const newlyCached = await loadCache(newlyCachedEmails);
      addElapsed(metrics, "cacheLookupMs", cacheReadStartedAt);
      const cachedSet = new Set(newlyCachedEmails);
      const newlyCachedItems = wellFormed.filter((item) =>
        cachedSet.has(item.email_normalizado ?? ""),
      );
      const updates = cachedItemUpdates(newlyCachedItems, newlyCached);
      if (updates.length > 0) {
        const writeStartedAt = performance.now();
        const persisted = await updateItems(job.id, updates);
        addElapsed(metrics, "resultWriteMs", writeStartedAt);
        metrics.cacheHits += updates.length;
        newlyCachedCount = persisted.processedItems;
        if (!persisted.jobProcessing) {
          metrics.stopDetail = "job_no_longer_processing";
          return {
            requestsStarted: 0,
            processedItems: immediatelyCompleted + newlyCachedCount,
            continueProcessing: false,
          };
        }
      }
    }
    const completedBeforeRequests = immediatelyCompleted + newlyCachedCount;
    const cacheProgressStartedAt = performance.now();
    await progress.advance(newlyCachedCount);
    addElapsed(metrics, "resultWriteMs", cacheProgressStartedAt);

    if (!(await isJobProcessing(job.id))) {
      metrics.stopDetail = "job_no_longer_processing";
      return {
        requestsStarted: 0,
        processedItems: completedBeforeRequests,
        continueProcessing: false,
      };
    }

    const requestBatches: ClaimedValidationBatch[] = heldClaims.map((result) => ({
      token: result.token,
      emails: result.claim.claimed,
      items: result.claim.claimed.flatMap((email) => itemsByEmail.get(email) ?? []),
    }));
    const activeRequests = {
      count: 0,
      firstStartedAt: null as number | null,
      lastCompletedAt: null as number | null,
    };
    const requestResults = await Promise.allSettled(requestBatches.map((batch) =>
      processClaimedValidationBatch(
        job,
        batch,
        metrics,
        hasTimeRemaining,
        activeRequests,
        progress,
      ),
    ));
    if (
      activeRequests.firstStartedAt !== null &&
      activeRequests.lastCompletedAt !== null
    ) {
      metrics.providerWaveWallMs +=
        activeRequests.lastCompletedAt - activeRequests.firstStartedAt;
    }
    const rejectedRequest = requestResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedRequest) throw rejectedRequest.reason;
    const outcomes = requestResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const requestsStarted = outcomes.filter((outcome) => outcome.requestStarted).length;
    const externallyCompleted = outcomes.reduce(
      (total, outcome) =>
        total + (outcome.kind === "completed" ? outcome.processedItems : 0),
      0,
    );
    const rateLimitedResult = outcomes.find((outcome) => outcome.kind === "rate_limited");
    const insufficientCredits = outcomes.some(
      (outcome) =>
        outcome.kind === "insufficient_credits" ||
        (outcome.kind === "completed" && outcome.insufficientCredits),
    );
    const providerErrors = outcomes.filter((outcome) => outcome.kind === "provider_error");
    const addressErrors = outcomes.some(
      (outcome) => outcome.kind === "completed" && outcome.hasAddressErrors,
    );
    const cancelled = outcomes.some((outcome) => outcome.kind === "cancelled");

    if (insufficientCredits) {
      metrics.stopDetail = "insufficient_credits";
      await markJob(job.id, "sem_creditos", {
        erro: "A ZeroBounce informou saldo insuficiente. Atualize os créditos e retome a validação.",
      });
      return {
        requestsStarted,
        processedItems: completedBeforeRequests + externallyCompleted,
        continueProcessing: false,
      };
    }
    if (rateLimitedResult?.kind === "rate_limited") {
      metrics.stopDetail = "provider_http_429";
      await markJob(job.id, "pendente", {
        proxima_tentativa_em: new Date(Date.now() + rateLimitedResult.retryAfterMs).toISOString(),
        erro: "A ZeroBounce limitou temporariamente as solicitações. A fila será retomada depois.",
      });
      return {
        requestsStarted,
        processedItems: completedBeforeRequests + externallyCompleted,
        continueProcessing: false,
      };
    }
    if (providerErrors.length > 0) {
      metrics.stopDetail = "provider_error";
      await markJob(job.id, "processando", {
        tentativas: job.tentativas + providerErrors.length,
        erro: "A validação externa falhou; endereços não foram armazenados no cache.",
      });
      return {
        requestsStarted,
        processedItems: completedBeforeRequests + externallyCompleted,
        continueProcessing: false,
      };
    }
    if (busy) {
      metrics.stopDetail = "address_lease_busy";
      await markJob(job.id, "pendente", {
        proxima_tentativa_em: new Date(Date.now() + 15_000).toISOString(),
      });
      return {
        requestsStarted,
        processedItems: completedBeforeRequests + externallyCompleted,
        continueProcessing: false,
      };
    }
    if (cancelled) {
      metrics.stopDetail = "job_cancelled";
      return {
        requestsStarted,
        processedItems: completedBeforeRequests + externallyCompleted,
        continueProcessing: false,
      };
    }
    if (requestsStarted > 0) {
      const writeStartedAt = performance.now();
      await markJob(job.id, "processando", {
        erro: addressErrors
          ? "Um ou mais endereços tiveram erro individual e serão tentados novamente."
          : null,
      });
      addElapsed(metrics, "resultWriteMs", writeStartedAt);
    }

    if (
      requestsStarted === 0 &&
      completedBeforeRequests === 0 &&
      newlyCachedCount === 0 &&
      !rateLimited
    ) {
      if (await isJobProcessing(job.id)) await finishOrRetry(job);
      return { requestsStarted: 0, processedItems: 0, continueProcessing: false };
    }
    return {
      requestsStarted,
      processedItems: completedBeforeRequests + externallyCompleted,
      continueProcessing: true,
      ...(rateLimited
        ? { waitMs: EMAIL_VALIDATION_RATE_LIMIT_WAIT_MS }
        : {}),
    };
  } finally {
    if (heldClaims.length > 0) {
      const releaseStartedAt = performance.now();
      await Promise.allSettled(heldClaims.map((result) => releaseClaims(result.token)));
      addElapsed(metrics, "leaseReleaseMs", releaseStartedAt);
    }
  }
}

export async function processCampaignEmailValidationJobs(): Promise<number> {
  const cycleStartedAt = performance.now();
  const metrics = createValidationCycleMetrics();
  let job: ValidationJob | null = null;
  let stopReason = "no_job";
  try {
    job = await selectJob();
    if (!job) {
      metrics.stopDetail = "no_job";
      return 0;
    }
    if (!process.env.ZEROBOUNCE_API_KEY?.trim()) {
      await markJob(job.id, "erro", {
        erro: "Configure ZEROBOUNCE_API_KEY no Repl do worker e retome a validação.",
      });
      stopReason = "missing_api_key";
      metrics.stopDetail = "missing_api_key";
      return 0;
    }
    const progress = createJobProgressTracker(job);
    const cycle = await runEmailValidationCycle(
      job,
      (currentJob, requestCapacity, hasTimeRemaining) =>
        processJobBatch(
          currentJob,
          requestCapacity,
          hasTimeRemaining,
          metrics,
          progress,
        ),
      {
        maxRequests: MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE,
        maxDurationMs: MAX_EMAIL_VALIDATION_CYCLE_DURATION_MS,
        maxConcurrentRequests: MAX_EMAIL_VALIDATION_CONCURRENT_REQUESTS,
        startedAt: cycleStartedAt,
        wait: async (ms) => {
          const waitStartedAt = performance.now();
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
          addElapsed(metrics, "limiterWaitMs", waitStartedAt);
        },
      },
    );
    stopReason = cycle.stopReason;
    if (!metrics.stopDetail) metrics.stopDetail = cycle.stopReason;
    if (cycle.stopReason !== "batch") {
      await finishOrRetry(cycle.job);
    }
    return cycle.requestsStarted > 0 || cycle.job.processados > job.processados
      ? 1
      : 0;
  } catch (error) {
    metrics.stopDetail = job ? "worker_error" : "job_selection_error";
    if (!job) throw error;
    logger.error(
      { jobId: job.id, technicalError: getTechnicalError(error) },
      "Campaign email validation worker batch failed",
    );
    await markJob(job.id, "pendente", {
      proxima_tentativa_em: new Date(Date.now() + PROVIDER_RETRY_MS).toISOString(),
      erro: "O worker encontrou uma falha temporária. Nenhum resultado incerto foi armazenado.",
    });
    stopReason = "worker_error";
    return 0;
  } finally {
    logger.info(
      {
        jobId: job?.id ?? null,
        stopReason,
        stopDetail: metrics.stopDetail,
        providerCalls: metrics.providerCalls,
        providerEmails: metrics.providerEmails,
        pendingRowsFetched: metrics.pendingRowsFetched,
        cacheHits: metrics.cacheHits,
        pendingSearchMs: Math.round(metrics.pendingSearchMs),
        cacheLookupMs: Math.round(metrics.cacheLookupMs),
        reservationMs: Math.round(metrics.reservationMs),
        zeroBounceRequestMs: Math.round(metrics.zeroBounceRequestMs),
        providerWaveWallMs: Math.round(metrics.providerWaveWallMs),
        resultWriteMs: Math.round(metrics.resultWriteMs),
        limiterWaitMs: Math.round(metrics.limiterWaitMs),
        leaseReleaseMs: Math.round(metrics.leaseReleaseMs),
        peakConcurrentRequests: metrics.peakConcurrentRequests,
        cycleWallMs: Math.round(performance.now() - cycleStartedAt),
      },
      "Campaign email validation cycle metrics",
    );
  }
}
