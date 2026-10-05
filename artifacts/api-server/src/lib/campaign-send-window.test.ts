import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignDayBucketStart,
  campaignHourBucketStart,
  campaignSendDiagnostics,
  isInsideCampaignSendWindow,
  isValidCampaignSendWindow,
  nextCampaignDayBucketStart,
  nextCampaignHourBucketStart,
  nextCampaignWindowOpenAtOrAfter,
} from "./campaign-send-window";

const campaign = {
  janela_envio_inicio: "09:00",
  janela_envio_fim: "20:00",
  status: "enviando",
  teto_hora: 100,
  teto_dia: 1000,
};

test("uses São Paulo calendar-hour and calendar-day quota buckets", () => {
  const now = new Date("2026-10-05T17:34:00.000Z");
  assert.equal(campaignHourBucketStart(now).toISOString(), "2026-10-05T17:00:00.000Z");
  assert.equal(campaignDayBucketStart(now).toISOString(), "2026-10-05T03:00:00.000Z");
  assert.equal(nextCampaignHourBucketStart(now).toISOString(), "2026-10-05T18:00:00.000Z");
  assert.equal(nextCampaignDayBucketStart(now).toISOString(), "2026-10-06T03:00:00.000Z");
  assert.equal(
    campaignDayBucketStart(new Date("2026-10-06T02:59:59.000Z")).toISOString(),
    "2026-10-05T03:00:00.000Z",
  );
  assert.equal(
    campaignDayBucketStart(new Date("2026-10-06T03:00:00.000Z")).toISOString(),
    "2026-10-06T03:00:00.000Z",
  );
});

test("send windows include the start and exclude the end in São Paulo time", () => {
  assert.equal(isInsideCampaignSendWindow(campaign, new Date("2026-10-05T12:00:00Z")), true);
  assert.equal(isInsideCampaignSendWindow(campaign, new Date("2026-10-05T11:59:59Z")), false);
  assert.equal(isInsideCampaignSendWindow(campaign, new Date("2026-10-05T23:00:00Z")), false);
  assert.equal(isValidCampaignSendWindow("09:00", "09:01"), true);
  assert.equal(isValidCampaignSendWindow("09:00:00.001", "10:00"), false);
  assert.equal(isValidCampaignSendWindow("20:00", "09:00"), false);
});

test("finds the next local opening and quota resumption time", () => {
  const afterClosing = new Date("2026-10-05T23:30:00Z"); // 20:30 in São Paulo
  assert.equal(
    nextCampaignWindowOpenAtOrAfter(campaign, afterClosing).toISOString(),
    "2026-10-06T12:00:00.000Z",
  );

  const hourlyPause = campaignSendDiagnostics(
    campaign,
    100,
    300,
    new Date("2026-10-05T14:15:00Z"), // 11:15 local
  );
  assert.deepEqual(hourlyPause, {
    motivo_parada_envio: "teto_hora",
    proximo_envio_em: "2026-10-05T15:00:00.000Z",
  });

  const dailyPause = campaignSendDiagnostics(
    campaign,
    100,
    1000,
    new Date("2026-10-05T14:15:00Z"),
  );
  assert.deepEqual(dailyPause, {
    motivo_parada_envio: "teto_dia",
    proximo_envio_em: "2026-10-06T12:00:00.000Z",
  });

  const closedAfterCap = campaignSendDiagnostics(
    campaign,
    100,
    1000,
    afterClosing,
  );
  assert.deepEqual(closedAfterCap, {
    motivo_parada_envio: "fora_da_janela",
    proximo_envio_em: "2026-10-06T12:00:00.000Z",
  });
});

test("manual pause has no automated restart time", () => {
  assert.deepEqual(
    campaignSendDiagnostics(
      { ...campaign, status: "pausada" },
      0,
      0,
      new Date("2026-10-05T14:15:00Z"),
    ),
    { motivo_parada_envio: "campanha_pausada", proximo_envio_em: null },
  );
});
