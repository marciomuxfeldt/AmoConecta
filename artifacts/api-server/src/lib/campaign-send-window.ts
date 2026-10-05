export const CAMPAIGN_SEND_TIME_ZONE = "America/Sao_Paulo";
export const DEFAULT_CAMPAIGN_SEND_WINDOW_START = "09:00";
export const DEFAULT_CAMPAIGN_SEND_WINDOW_END = "20:00";

export type CampaignSendWindow = {
  janela_envio_inicio: string;
  janela_envio_fim: string;
};

export type CampaignSendBlockReason =
  | "fora_da_janela"
  | "teto_hora"
  | "teto_dia"
  | "campanha_pausada";

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const localDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAMPAIGN_SEND_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function campaignTimeMinutes(value: string): number {
  const match =
    /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?$/u.exec(value);
  if (!match) throw new RangeError("Horário de envio inválido.");
  if (Number(match[3] ?? 0) !== 0 || Number(`0.${match[4] ?? "0"}`) !== 0) {
    throw new RangeError("A janela de envio aceita precisão de um minuto.");
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function windowMinutes(window: CampaignSendWindow): { start: number; end: number } {
  const start = campaignTimeMinutes(window.janela_envio_inicio);
  const end = campaignTimeMinutes(window.janela_envio_fim);
  if (start >= end) {
    throw new RangeError("O fim da janela de envio precisa ser posterior ao início.");
  }
  return { start, end };
}

export function isValidCampaignSendWindow(start: string, end: string): boolean {
  try {
    return campaignTimeMinutes(start) < campaignTimeMinutes(end);
  } catch {
    return false;
  }
}

function localDateTime(date: Date): LocalDateTime {
  if (!Number.isFinite(date.getTime())) throw new RangeError("Data inválida.");
  const parts = new Map(
    localDateTimeFormatter
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  const values = {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  };
  if (Object.values(values).some((value) => !Number.isInteger(value))) {
    throw new RangeError("Não foi possível determinar o horário de São Paulo.");
  }
  return values;
}

function localDateTimeToInstant(parts: LocalDateTime): Date {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const represented = localDateTime(new Date(candidate));
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    const adjustment = desiredAsUtc - representedAsUtc;
    if (adjustment === 0) return new Date(candidate);
    candidate += adjustment;
  }
  throw new RangeError("Não foi possível converter o horário local de São Paulo.");
}

function calendarDate(parts: LocalDateTime, dayOffset = 0): Pick<LocalDateTime, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function campaignHourBucketStart(now = new Date()): Date {
  const parts = localDateTime(now);
  return localDateTimeToInstant({ ...parts, minute: 0, second: 0 });
}

export function campaignDayBucketStart(now = new Date()): Date {
  const parts = localDateTime(now);
  return localDateTimeToInstant({
    ...parts,
    hour: 0,
    minute: 0,
    second: 0,
  });
}

export function nextCampaignHourBucketStart(now = new Date()): Date {
  const parts = localDateTime(now);
  const nextHour = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour + 1),
  );
  return localDateTimeToInstant({
    year: nextHour.getUTCFullYear(),
    month: nextHour.getUTCMonth() + 1,
    day: nextHour.getUTCDate(),
    hour: nextHour.getUTCHours(),
    minute: 0,
    second: 0,
  });
}

export function nextCampaignDayBucketStart(now = new Date()): Date {
  const parts = localDateTime(now);
  const tomorrow = calendarDate(parts, 1);
  return localDateTimeToInstant({
    ...tomorrow,
    hour: 0,
    minute: 0,
    second: 0,
  });
}

export function isInsideCampaignSendWindow(
  window: CampaignSendWindow,
  now = new Date(),
): boolean {
  const { start, end } = windowMinutes(window);
  const parts = localDateTime(now);
  const currentMinute = parts.hour * 60 + parts.minute;
  return currentMinute >= start && currentMinute < end;
}

export function nextCampaignWindowOpenAtOrAfter(
  window: CampaignSendWindow,
  instant = new Date(),
): Date {
  const { start, end } = windowMinutes(window);
  const parts = localDateTime(instant);
  const currentMinute = parts.hour * 60 + parts.minute;
  if (currentMinute >= start && currentMinute < end) return new Date(instant);

  const targetDate = calendarDate(parts, currentMinute >= end ? 1 : 0);
  return localDateTimeToInstant({
    ...targetDate,
    hour: Math.floor(start / 60),
    minute: start % 60,
    second: 0,
  });
}

function nextSendAfterQuotaResets(
  now: Date,
  window: CampaignSendWindow,
  hourlyBlocked: boolean,
  dailyBlocked: boolean,
): Date {
  let candidate = now.getTime();
  if (hourlyBlocked) {
    candidate = Math.max(candidate, nextCampaignHourBucketStart(now).getTime());
  }
  if (dailyBlocked) {
    candidate = Math.max(candidate, nextCampaignDayBucketStart(now).getTime());
  }
  return nextCampaignWindowOpenAtOrAfter(window, new Date(candidate));
}

export function campaignSendDiagnostics(
  campaign: CampaignSendWindow & {
    status?: string;
    agendada_para?: string | null;
    teto_hora?: number | null;
    teto_dia?: number | null;
    pausa_motivo?: string | null;
  },
  sentThisHour: number,
  sentToday: number,
  now = new Date(),
): {
  motivo_parada_envio: CampaignSendBlockReason | null;
  proximo_envio_em: string | null;
} {
  if (campaign.status === "pausada") {
    return { motivo_parada_envio: "campanha_pausada", proximo_envio_em: null };
  }

  const scheduledCampaignIsDue =
    campaign.status === "agendada" &&
    typeof campaign.agendada_para === "string" &&
    Number.isFinite(Date.parse(campaign.agendada_para)) &&
    Date.parse(campaign.agendada_para) <= now.getTime();
  if (campaign.status !== "enviando" && !scheduledCampaignIsDue) {
    return { motivo_parada_envio: null, proximo_envio_em: null };
  }

  const insideWindow = isInsideCampaignSendWindow(campaign, now);
  const hourlyBlocked =
    typeof campaign.teto_hora === "number" &&
    campaign.teto_hora > 0 &&
    sentThisHour >= campaign.teto_hora;
  const dailyBlocked =
    typeof campaign.teto_dia === "number" &&
    campaign.teto_dia > 0 &&
    sentToday >= campaign.teto_dia;
  if (insideWindow && !hourlyBlocked && !dailyBlocked) {
    return { motivo_parada_envio: null, proximo_envio_em: null };
  }

  const nextSendAt = nextSendAfterQuotaResets(
    now,
    campaign,
    hourlyBlocked,
    dailyBlocked,
  );
  const reason: CampaignSendBlockReason = !insideWindow
    ? "fora_da_janela"
    : dailyBlocked
      ? "teto_dia"
      : "teto_hora";
  return {
    motivo_parada_envio: reason,
    proximo_envio_em: nextSendAt.toISOString(),
  };
}
