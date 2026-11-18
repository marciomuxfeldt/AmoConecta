import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EMAIL_VALIDATION_CYCLE_DURATION_MS,
  MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE,
  runEmailValidationCycle,
} from "./email-validation-cycle";

const job = { id: "job-1", processados: 44_000, total_pendentes: 98_447 };

test("caps one validation cycle at 25 provider requests", async () => {
  let calls = 0;
  const capacities: number[] = [];
  const result = await runEmailValidationCycle(
    job,
    async (_job, requestCapacity) => {
      calls += 1;
      capacities.push(requestCapacity);
      return {
        requestsStarted: requestCapacity,
        processedItems: requestCapacity * 100,
        continueProcessing: true,
      };
    },
    { now: () => 0 },
  );

  assert.equal(calls, MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE);
  assert.equal(result.requestsStarted, MAX_EMAIL_VALIDATION_REQUESTS_PER_CYCLE);
  assert.equal(result.stopReason, "request_limit");
  assert.equal(result.job.processados, 46_500);
  assert.deepEqual(capacities, [6, 6, 6, 6, 1]);
});

test("does not start another batch after the 50-second budget", async () => {
  let clock = 0;
  let calls = 0;
  const result = await runEmailValidationCycle(
    job,
    async () => {
      calls += 1;
      clock += 25_000;
      return { requestsStarted: 1, processedItems: 100, continueProcessing: true };
    },
    { now: () => clock },
  );

  assert.equal(calls, 2);
  assert.equal(result.requestsStarted, 2);
  assert.equal(result.stopReason, "time_limit");
  assert.equal(MAX_EMAIL_VALIDATION_CYCLE_DURATION_MS, 50_000);
});

test("stops the cycle when a batch signals that it must stop", async () => {
  let calls = 0;
  const result = await runEmailValidationCycle(
    job,
    async () => {
      calls += 1;
      return { requestsStarted: 1, processedItems: 0, continueProcessing: false };
    },
    { now: () => 0 },
  );

  assert.equal(calls, 1);
  assert.equal(result.requestsStarted, 1);
  assert.equal(result.stopReason, "batch");
});

test("waits for a shared rate-limit slot without counting a provider request", async () => {
  let clock = 0;
  const waits: number[] = [];
  let calls = 0;
  const result = await runEmailValidationCycle(
    job,
    async () => {
      calls += 1;
      return calls === 1
        ? {
            requestsStarted: 0,
            processedItems: 1,
            continueProcessing: true,
            waitMs: 1_000,
          }
        : { requestsStarted: 1, processedItems: 1, continueProcessing: false };
    },
    {
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    },
  );

  assert.deepEqual(waits, [1_000]);
  assert.equal(result.requestsStarted, 1);
  assert.equal(result.job.processados, 44_002);
  assert.equal(result.stopReason, "batch");
});

test("never reports more processed items than the job total", async () => {
  const result = await runEmailValidationCycle(
    { ...job, processados: 98_446 },
    async () => ({
      requestsStarted: 0,
      processedItems: 100,
      continueProcessing: false,
    }),
    { now: () => 0 },
  );

  assert.equal(result.job.processados, 98_447);
});
