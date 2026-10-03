import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const sqlFile = (name) => readFile(new URL(`../../../../supabase/${name}`, import.meta.url), "utf8");
const campaign = "00000000-0000-0000-0000-000000000001";
const other = "00000000-0000-0000-0000-000000000002";
const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const recipient = async (email, status = "pendente", reminder = false) => (await row(
  `INSERT INTO destinatario(campanha_id,email,status,is_lembrete) VALUES($1,$2,$3,$4) RETURNING id`,
  [campaign, email, status, reminder],
)).id;
const event = async (id, type, bounce = null) => {
  const d = await row("SELECT * FROM destinatario WHERE id=$1", [id]);
  const e = await row(`INSERT INTO evento_email(resend_email_id,tipo,payload,ocorrido_em)
    VALUES($1,$2,$3,now()) RETURNING id`, [d.resend_email_id, type,
    JSON.stringify({ data: { bounce: { type: bounce } } })]);
  return e.id;
};

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE campanha(id uuid PRIMARY KEY,status text,pausa_motivo text,pausa_taxa_bounce numeric,
      pausa_taxa_reclamacao numeric,pausada_em timestamptz,pausado_por_id uuid,
      pausado_por_nome text,pausado_por_email text);
    CREATE TABLE destinatario(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campanha_id uuid,
      email text,nome text,status text DEFAULT 'pendente',is_lembrete boolean DEFAULT false,
      criado_em timestamptz DEFAULT now(),data_ultima_compra date,tentativas integer DEFAULT 0,
      processando_em timestamptz,erro text,resend_email_id text,
      enviado_em timestamptz,entregue_em timestamptz,aberto_em timestamptz,clicado_em timestamptz);
    CREATE TABLE evento_email(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),destinatario_id uuid,
      campanha_id uuid,email text,resend_email_id text,tipo text,payload jsonb,
      ocorrido_em timestamptz DEFAULT now(),recebido_em timestamptz DEFAULT now(),
      processado_em timestamptz,proxima_tentativa_em timestamptz,erro_processamento text,
      tentativas integer DEFAULT 0,bounce_tipo_bruto text,bounce_permanente boolean);
    CREATE TABLE supressao(email text,motivo text,origem text);
    CREATE UNIQUE INDEX suppression_email ON supressao(email) WHERE email IS NOT NULL;
    CREATE TABLE evento_auditoria(id uuid DEFAULT gen_random_uuid(),actor_user_id uuid,
      actor_name text,actor_email text,action text,entity_type text,entity_id uuid,
      metadata jsonb,created_at timestamptz DEFAULT now());
    INSERT INTO campanha VALUES('${campaign}','enviando',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO campanha VALUES('${other}','enviando',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
  `);
  await db.exec(await sqlFile("migrations/202610020016_campaign_exclusions_reputation.sql"));
  await db.exec(await sqlFile("migrations/202610020017_bounce_terminal_semantics.sql"));
  await db.exec(await sqlFile("migrations/202610030018_bounded_event_matching.sql"));
});
after(() => db.close());

const unmatched = async (providerId, attempts = 0, age = "0 seconds") => (await row(
  `INSERT INTO evento_email(resend_email_id,tipo,payload,tentativas,recebido_em)
    VALUES($1,'email.opened','{"data":{}}',$2,now()-$3::interval) RETURNING id`,
  [providerId, attempts, age],
)).id;

test("known test messages leave the retry queue immediately, including old high-attempt events", async () => {
  for (const [providerId, attempts] of [["known-test", 0], ["old-known-test", 1400]]) {
    await db.query(`INSERT INTO evento_auditoria(action,entity_type,entity_id,metadata)
      VALUES('campaign_test_sent','campaign',$1,jsonb_build_object('resend_email_id',$2::text))`,
    [campaign, providerId]);
    const id = await unmatched(providerId, attempts);
    const result = (await row("SELECT process_resend_email_event($1) AS value", [id])).value;
    assert.equal(result.reason, "test_email");
    assert.equal(result.retryable, false);
    const e = await row("SELECT * FROM evento_email WHERE id=$1", [id]);
    assert.ok(e.processado_em);
    assert.equal(e.proxima_tentativa_em, null);
    assert.equal(e.erro_processamento, null);
    assert.equal(e.motivo_nao_correspondido, "test_email");
    assert.equal(e.campanha_id, campaign);
    assert.equal((await row("SELECT count(*) AS n FROM destinatario WHERE resend_email_id=$1", [providerId])).n, 0);
    assert.equal((await row("SELECT process_resend_email_event($1) AS value", [id])).value.duplicate, true);
  }
});

test("unknown IDs retry briefly, and attempt 10 ends with audit reason, never technical error", async () => {
  const id = await unmatched("short-race");
  let result = (await row("SELECT process_resend_email_event($1) AS value", [id])).value;
  assert.equal(result.retryable, true);
  assert.equal(result.attempts, 1);
  assert.equal((await row("SELECT process_resend_email_event($1) AS value", [id])).value.reason, "retry_not_due");
  await db.query("UPDATE evento_email SET tentativas=9,proxima_tentativa_em=NULL WHERE id=$1", [id]);
  result = (await row("SELECT process_resend_email_event($1) AS value", [id])).value;
  assert.equal(result.reason, "recipient_not_found_retry_limit");
  assert.equal(result.attempts, 10);
  const e = await row("SELECT * FROM evento_email WHERE id=$1", [id]);
  assert.ok(e.processado_em);
  assert.equal(e.erro_processamento, null);
  assert.equal(e.proxima_tentativa_em, null);
  assert.equal(e.motivo_nao_correspondido, result.reason);
  assert.ok(e.payload);
});

test("15 minutes is a terminal time bound independent of attempt count", async () => {
  const id = await unmatched("aged-race", 0, "16 minutes");
  const result = (await row("SELECT process_resend_email_event($1) AS value", [id])).value;
  assert.equal(result.reason, "recipient_not_found_timeout");
  assert.equal(result.retryable, false);
  assert.equal(result.max_age_seconds, 900);
});

test("a recipient that appears before a retry still gets its event, even beyond the budget", async () => {
  const id = await unmatched("late-persisted");
  await db.query("SELECT process_resend_email_event($1)", [id]);
  const d = await recipient("late-persisted@example.test", "enviado");
  await db.query("UPDATE destinatario SET resend_email_id='late-persisted' WHERE id=$1", [d]);
  await db.query("UPDATE evento_email SET proxima_tentativa_em=NULL,tentativas=1400 WHERE id=$1", [id]);
  const result = (await row("SELECT process_resend_email_event($1) AS value", [id])).value;
  assert.equal(result.matched, true);
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [d])).status, "aberto");
});

test("provider and CSV-list exclusions preserve pending, records, author, suppression and restoration", async () => {
  const id = await recipient("pending@hotmail.com");
  const reminder = await recipient("pending@hotmail.com", "pendente", true);
  await recipient("other@outlook.com");
  await recipient("reserved@live.com", "processando");
  await recipient("sent@msn.com", "enviado");
  const gmail = await recipient("active@gmail.com");
  const result = await row(`SELECT change_campaign_exclusions($1,false,'provedor: reputação',
    NULL,'Operador','operator@example.test',ARRAY['microsoft'],'{}','{}',false) AS value`, [campaign]);
  assert.equal(result.value.alterados, 2);
  assert.equal(result.value.lembretes_alterados, 1);
  assert.equal(result.value.em_processamento, 1);
  assert.equal(result.value.ja_processados, 1);
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [id])).status, "pendente");
  assert.equal((await row("SELECT count(*) AS n FROM supressao")).n, 0);
  const reserved = await db.query("SELECT id FROM reservar_destinatarios($1,100,false)", [campaign]);
  assert.deepEqual(reserved.rows.map((d) => d.id), [gmail]);
  await db.query(`SELECT change_campaign_exclusions($1,true,NULL,NULL,'Operador',NULL,'{}','{}',ARRAY[$2::uuid],false)`,
    [campaign, id]);
  assert.equal((await row("SELECT excluido_em FROM destinatario WHERE id=$1", [id])).excluido_em, null);
  assert.equal((await row("SELECT excluido_em FROM destinatario WHERE id=$1", [reminder])).excluido_em, null);
  assert.equal((await row("SELECT id FROM reservar_destinatarios($1,100,false)", [campaign])).id, id);
  await db.query(`SELECT change_campaign_exclusions($1,false,'validacao: lista externa',NULL,'Operador',
    NULL,'{}',ARRAY['other@outlook.com','missing@example.test'],'{}',false)`, [campaign]);
  const r = await row("SELECT status,exclusao_motivo FROM destinatario WHERE email='other@outlook.com'");
  assert.equal(r.status, "pendente");
  assert.equal(r.exclusao_motivo, "provedor: reputação"); // Re-exclude never overwrites first decision.
  assert.equal((await row("SELECT complete_campaign_if_queue_empty($1) AS done", [campaign])).done, false);
});

test("permanent bounce wins delivered, opened, clicked and error; soft never changes status", async () => {
  for (const state of ["entregue", "aberto", "clicado", "erro"]) {
    const id = await recipient(`hard-${state}@example.test`, state);
    await db.query("UPDATE destinatario SET resend_email_id=id::text,enviado_em=now() WHERE id=$1", [id]);
    const e = await event(id, "email.bounced", "Permanent");
    await db.query("SELECT process_resend_email_event($1)", [e]);
    assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [id])).status, "bounce");
    await db.query("SELECT process_resend_email_event($1)", [await event(id, "email.clicked")]);
    assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [id])).status, "bounce");
    assert.equal((await row("SELECT process_resend_email_event($1) AS value", [e])).value.duplicate, true);
  }
  for (const state of ["enviado", "entregue", "aberto", "clicado", "erro"]) {
    const id = await recipient(`soft-${state}@example.test`, state);
    await db.query("UPDATE destinatario SET resend_email_id=id::text,erro='erro original' WHERE id=$1", [id]);
    await db.query("SELECT process_resend_email_event($1)", [await event(id, "email.bounced", "Transient")]);
    const d = await row("SELECT * FROM destinatario WHERE id=$1", [id]);
    assert.equal(d.status, state);
    assert.equal(d.erro, "erro original");
    assert.ok(d.ultimo_soft_bounce_em);
    assert.equal((await row("SELECT count(*) AS n FROM supressao WHERE email=$1", [d.email])).n, 0);
  }
  const complaint = await recipient("complaint@example.test", "clicado");
  await db.query("UPDATE destinatario SET resend_email_id=id::text WHERE id=$1", [complaint]);
  await db.query("SELECT process_resend_email_event($1)", [await event(complaint, "email.complained")]);
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [complaint])).status, "clicado");
  assert.equal((await row("SELECT motivo FROM supressao WHERE email='complaint@example.test'")).motivo, "reclamacao");
});

test("reputation cohort excludes pre-resume sends and reminders, not just pre-resume events", async () => {
  await db.exec(`INSERT INTO destinatario(campanha_id,email,enviado_em,entregue_em,resend_email_id)
    VALUES('${other}','old@example.test','2026-01-01','2026-01-01','old'),
    ('${other}','new@example.test','2026-02-01','2026-02-01','new');
    INSERT INTO destinatario(campanha_id,email,enviado_em,resend_email_id,is_lembrete)
    VALUES('${other}','reminder@example.test','2026-02-01','reminder',true);
    INSERT INTO evento_email(resend_email_id,tipo,bounce_permanente,ocorrido_em) VALUES
      ('old','email.bounced',true,'2026-03-01'),('new','email.bounced',true,'2026-03-01'),
      ('new','email.bounced',true,'2026-03-02'),('reminder','email.bounced',true,'2026-03-02');`);
  const all = await row("SELECT campaign_reputation_counts($1,NULL) AS value", [other]);
  const period = await row("SELECT campaign_reputation_counts($1,'2026-01-15') AS value", [other]);
  assert.equal(all.value.enviados, 2);
  assert.equal(all.value.bounces_permanentes, 2);
  assert.equal(period.value.enviados, 1);
  assert.equal(period.value.bounces_permanentes, 1);
  const pause = await row(`SELECT transition_campaign_with_audit($1,'enviando','pausada',
    NULL,'Sistema',NULL,'Pausa automática: teste',0.05,0,'{"gatilho":"catastrofe"}') AS value`, [other]);
  assert.equal(pause.value.status, "pausada");
  const resumed = await row(`SELECT transition_campaign_with_audit($1,'pausada','enviando',
    NULL,'Operador',NULL,NULL,0.05,0,'{}') AS value`, [other]);
  assert.equal(resumed.value.retomada_enviados_base, 2);
  assert.ok(resumed.value.retomada_em);
  assert.equal((await row("SELECT campaign_reputation_counts($1,$2) AS value",
    [other, resumed.value.retomada_em])).value.enviados, 0);
  assert.equal((await row("SELECT count(*) AS n FROM evento_auditoria WHERE entity_id=$1", [other])).n, 2);
});

test("historical repair restores strong evidence without requeueing, resending or touching real errors", async () => {
  const soft = await recipient("historical-soft@example.test", "erro");
  const realError = await recipient("api-error@example.test", "erro");
  const hard = await recipient("historical-hard@example.test", "entregue");
  await db.query("UPDATE destinatario SET resend_email_id=id::text,erro='Bounce temporário informado pelo Resend; tipo bruto: Transient' WHERE id=$1", [soft]);
  await db.query("UPDATE destinatario SET resend_email_id=id::text,erro='API recusou' WHERE id=$1", [realError]);
  await db.query("UPDATE destinatario SET resend_email_id=id::text WHERE id=$1", [hard]);
  await event(soft, "email.bounced", "Transient");
  await event(realError, "email.bounced", "Transient");
  await event(hard, "email.bounced", "Permanent");
  await db.exec(await sqlFile("repairs/20261002_repair_bounce_statuses.sql"));
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [soft])).status, "enviado");
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [realError])).status, "erro");
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [hard])).status, "bounce");
  await db.exec(await sqlFile("repairs/20261002_repair_bounce_statuses.sql")); // Safe to repeat.
  assert.equal((await row("SELECT status FROM destinatario WHERE id=$1", [soft])).status, "enviado");
});

test("exclusion restoration is rejected after completion and diagnostics show four groups", async () => {
  const diagnostic = await row("SELECT campaign_provider_diagnostics($1) AS value", [campaign]);
  assert.equal(diagnostic.value.length, 4);
  await db.query("UPDATE campanha SET status='concluida' WHERE id=$1", [campaign]);
  await assert.rejects(db.query(`SELECT change_campaign_exclusions($1,true,NULL,NULL,'Operador',
    NULL,'{}','{}','{}',true)`, [campaign]), /campaign_finished/);
  await db.exec(await sqlFile("functions/worker-reservation.sql"));
  assert.equal((await row("SELECT count(*) AS n FROM reservar_destinatarios($1,100,false)", [campaign])).n, 0);
});