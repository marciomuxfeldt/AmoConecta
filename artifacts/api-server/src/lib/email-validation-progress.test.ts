import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { progressTimestampForIncrease } from "./email-validation-progress";

describe("progressTimestampForIncrease", () => {
  it("records the supplied time when the processed count advances", () => {
    assert.deepEqual(
      progressTimestampForIncrease(9, 10, "2026-11-17T12:00:00.000Z"),
      { progresso_atualizado_em: "2026-11-17T12:00:00.000Z" },
    );
  });

  it("does not refresh the progress time when the count stays the same or decreases", () => {
    assert.deepEqual(progressTimestampForIncrease(10, 10, "2026-11-17T12:00:00.000Z"), {});
    assert.deepEqual(progressTimestampForIncrease(10, 9, "2026-11-17T12:00:00.000Z"), {});
  });
});
