import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignContentLockMessage,
  changedLockedCampaignFields,
} from "./campaign-edit-lock";

const existingCampaign = {
  status: "enviando",
  assunto: "Oferta original",
  preheader: "Resumo original",
  assunto_lembrete: "Ainda dá tempo",
  remetente_nome: "Amo Ofertas",
  remetente_email: "envios@marketing.amo.delivery",
  reply_to: "respostas@marketing.amo.delivery",
  corpo: [{ id: "text-1", type: "text", html: "<p>Olá</p>" }],
};

test("detects locked campaign content changes while allowing operational fields", () => {
  assert.deepEqual(
    changedLockedCampaignFields(existingCampaign, {
      assunto: "Oferta alterada",
      teto_hora: 200,
      status: "pausada",
    }),
    ["assunto"],
  );
});

test("compares normalized email blocks and allows unchanged locked values", () => {
  assert.deepEqual(
    changedLockedCampaignFields(existingCampaign, {
      corpo: [{ id: "text-1", type: "text", html: "<p>Olá</p>" }],
      remetente_email: existingCampaign.remetente_email,
    }),
    [],
  );
});

test("locks reminder content, button-color snapshot, and disengaged-recipient opt-in", () => {
  const lockedCampaign = {
    ...existingCampaign,
    assunto_lembrete: "Ainda dá tempo",
    corpo_lembrete: [{ id: "reminder", type: "text", html: "<p>Última chance</p>" }],
    lembrete_horas: 48,
    cor_botao_snapshot: "#e96527",
    incluir_desengajados: false,
  };
  const changed = changedLockedCampaignFields(lockedCampaign, {
    assunto_lembrete: "Lembrete atualizado",
    corpo_lembrete: [{ id: "reminder", type: "text", html: "<p>Oferta alterada</p>" }],
    lembrete_horas: 72,
    cor_botao_snapshot: "#112233",
    incluir_desengajados: true,
  });

  assert.deepEqual(changed.sort(), [
    "assunto_lembrete",
    "cor_botao_snapshot",
    "corpo_lembrete",
    "incluir_desengajados",
    "lembrete_horas",
  ]);
});

test("does not lock content before the campaign is scheduled or sending", () => {
  assert.deepEqual(
    changedLockedCampaignFields(
      { ...existingCampaign, status: "rascunho" },
      { assunto: "Oferta alterada", corpo: [] },
    ),
    [],
  );
});

test("describes the fields that cannot be edited", () => {
  assert.equal(
    campaignContentLockMessage(["assunto", "corpo"]),
    "Não é possível editar o assunto e o corpo do e-mail depois que a campanha entra em agendamento ou envio.",
  );
});