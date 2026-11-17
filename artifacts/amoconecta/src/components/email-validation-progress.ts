export type DurationRange = {
  minMinutes: number;
  maxMinutes: number;
};

function presentableMinutes(value: number): number {
  if (value < 5) return Math.max(1, value);
  return Math.max(5, Math.round(value / 5) * 5);
}

export function theoreticalDurationRange(itemCount: number): DurationRange | null {
  if (!Number.isFinite(itemCount) || itemCount <= 0) return null;
  const fastest = Math.max(1, Math.ceil(itemCount / 3_000));
  const slower = Math.max(fastest, Math.ceil(itemCount / 2_000));
  return {
    minMinutes: presentableMinutes(fastest),
    maxMinutes: presentableMinutes(slower),
  };
}

export function observedRemainingMinutes(
  processed: number,
  total: number,
  startedAt: string | null | undefined,
  now: number,
): number | null {
  if (!startedAt || processed < 1_000) return null;
  const started = Date.parse(startedAt);
  const elapsedMinutes = (now - started) / 60_000;
  if (!Number.isFinite(started) || elapsedMinutes < 2) return null;
  const remaining = Math.max(0, total - processed);
  if (remaining === 0) return 0;
  const ratePerMinute = processed / elapsedMinutes;
  if (ratePerMinute <= 0) return null;
  return Math.ceil(remaining / ratePerMinute);
}

export function isProgressStalled(
  status: string | undefined,
  lastProgressAt: string | null | undefined,
  now: number,
): boolean {
  if (status !== "processando" || !lastProgressAt) return false;
  const timestamp = Date.parse(lastProgressAt);
  return Number.isFinite(timestamp) && now - timestamp > 5 * 60_000;
}

export function validationPollInterval(
  status: string | undefined,
  isFetching: boolean,
): number | false {
  if (isFetching || (status !== "processando" && status !== "pendente")) {
    return false;
  }
  return 10_000;
}
