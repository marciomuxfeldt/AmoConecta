import { describe, expect, it } from "vitest";
import {
  isProgressStalled,
  observedRemainingMinutes,
  theoreticalDurationRange,
  validationPollInterval,
} from "./email-validation-progress";

describe("email validation progress estimates", () => {
  it("presents the requested theoretical range for a large queue", () => {
    expect(theoreticalDurationRange(98_309)).toEqual({
      minMinutes: 35,
      maxMinutes: 50,
    });
  });

  it("waits for both minimum sample size and elapsed time before estimating ETA", () => {
    const startedAt = "2026-11-17T10:00:00.000Z";
    const now = Date.parse(startedAt) + 120_000;
    expect(observedRemainingMinutes(999, 3_000, startedAt, now)).toBeNull();
    expect(observedRemainingMinutes(1_000, 3_000, startedAt, now - 1)).toBeNull();
    expect(observedRemainingMinutes(2_000, 3_000, startedAt, now)).toBe(1);
  });

  it("flags only processing jobs whose persisted progress is over five minutes old", () => {
    const now = Date.parse("2026-11-17T10:10:00.000Z");
    const exactlyFiveMinutesOld = "2026-11-17T10:05:00.000Z";
    expect(isProgressStalled("processando", exactlyFiveMinutesOld, now)).toBe(false);
    expect(isProgressStalled("processando", "2026-11-17T10:04:59.999Z", now)).toBe(true);
    expect(isProgressStalled("pendente", "2026-11-17T09:00:00.000Z", now)).toBe(false);
  });

  it("polls active jobs every ten seconds and does not start another while fetching", () => {
    expect(validationPollInterval("processando", false)).toBe(10_000);
    expect(validationPollInterval("pendente", false)).toBe(10_000);
    expect(validationPollInterval("processando", true)).toBe(false);
    expect(validationPollInterval("concluida", false)).toBe(false);
  });
});
