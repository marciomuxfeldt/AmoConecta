import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSerializedProgressCounter,
  progressTimestampForIncrease,
} from "./email-validation-progress";

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

  it("serializes parallel batch increments without losing completed items", async () => {
    const writes: Array<[number, number]> = [];
    const counter = createSerializedProgressCounter(44_000, 98_447, async (previous, next) => {
      await Promise.resolve();
      writes.push([previous, next]);
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => counter.advance(100)),
    );

    assert.deepEqual(writes, [
      [44_000, 44_100],
      [44_100, 44_200],
      [44_200, 44_300],
      [44_300, 44_400],
      [44_400, 44_500],
      [44_500, 44_600],
    ]);
    assert.deepEqual(results, [44_100, 44_200, 44_300, 44_400, 44_500, 44_600]);
  });

  it("never advances beyond the job total", async () => {
    const writes: Array<[number, number]> = [];
    const counter = createSerializedProgressCounter(98_400, 98_447, async (previous, next) => {
      writes.push([previous, next]);
    });

    assert.equal(await counter.advance(100), 98_447);
    assert.equal(await counter.advance(100), 98_447);
    assert.deepEqual(writes, [[98_400, 98_447]]);
  });
});
