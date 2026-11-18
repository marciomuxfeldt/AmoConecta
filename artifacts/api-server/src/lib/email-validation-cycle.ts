export const MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE = 25;
export const MAX_EMAIL_VALIDATION_CYCLE_DURATION_MS = 50_000;
export const EMAIL_VALIDATION_RATE_LIMIT_WAIT_MS = 1_000;

export type EmailValidationBatchOutcome = {
  requestStarted: boolean;
  processedItems: number;
  continueProcessing: boolean;
  waitMs?: number;
};

export type EmailValidationCycleStopReason =
  | "request_limit"
  | "time_limit"
  | "batch";

type ProgressJob = {
  processados: number;
  total_pendentes: number;
};

type CycleOptions = {
  maxRequests?: number;
  maxDurationMs?: number;
  startedAt?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runEmailValidationCycle<T extends ProgressJob>(
  initialJob: T,
  processBatch: (job: T) => Promise<EmailValidationBatchOutcome>,
  options: CycleOptions = {},
): Promise<{
  job: T;
  requestsStarted: number;
  stopReason: EmailValidationCycleStopReason;
}> {
  const maxRequests = options.maxRequests ?? MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE;
  const maxDurationMs =
    options.maxDurationMs ?? MAX_EMAIL_VALIDATION_CYCLE_DURATION_MS;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? delay;
  const startedAt = options.startedAt ?? now();

  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new RangeError("maxRequests must be a positive integer.");
  }
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new RangeError("maxDurationMs must be positive.");
  }

  let job = initialJob;
  let requestsStarted = 0;

  while (
    requestsStarted < maxRequests &&
    now() - startedAt < maxDurationMs
  ) {
    // The deadline stops later batches; an in-flight paid request keeps its
    // existing provider timeout so an abort cannot leave an uncertain result.
    const outcome = await processBatch(job);
    if (!Number.isSafeInteger(outcome.processedItems) || outcome.processedItems < 0) {
      throw new RangeError("processedItems must be a non-negative integer.");
    }
    if (outcome.requestStarted) requestsStarted += 1;
    if (outcome.processedItems > 0) {
      job = {
        ...job,
        processados: Math.min(
          job.total_pendentes,
          job.processados + outcome.processedItems,
        ),
      };
    }

    if (!outcome.continueProcessing) {
      return { job, requestsStarted, stopReason: "batch" };
    }

    if (outcome.waitMs !== undefined && outcome.waitMs > 0) {
      const remainingMs = maxDurationMs - (now() - startedAt);
      if (remainingMs <= 0) break;
      await wait(Math.min(outcome.waitMs, remainingMs));
    }
  }

  return {
    job,
    requestsStarted,
    stopReason:
      requestsStarted >= maxRequests ? "request_limit" : "time_limit",
  };
}
