import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const migration = readFile(
  new URL("../../../../supabase/migrations/202610220023_campaign_domain_corrections.sql", import.meta.url),
  "utf8",
);
const campaign = "00000000-0000-0000-0000-000000000001";
const actor = "00000000-0000-0000-0000-000000000002";
const recipient = "00000000-0000-0000-0000-000000000003";
const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const correct = (source, target) => db.query(
  "SELECT public.correct_campaign_recipient_domain($1,$2,$3,$4,'Operador','op@example.com') AS result",
  [campaign, source, target, actor],
);

before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.campanha(id uuid primary key, status text not null);
    CREATE TABLE public.destinatario(
      id uuid primary key, campanha_id uuid not null, is_lembrete boolean not null default false,
      email text not null, status text not null, excluido_em timestamptz,
      exclusao_motivo text, excluido_por_id uuid, excluido_por_nome text, excluido_por_email text
    );
    CREATE TABLE public.supressao(email text);
    CREATE TABLE public.verificacao_email(email text primary key, status text);
    CREATE TABLE public.evento_auditoria(
      actor_user_id uuid, actor_name text, actor_email text, action text,
      entity_type text, entity_id uuid, metadata jsonb
    );
    CREATE TABLE public.validacao_email_job(
      id uuid primary key default gen_random_uuid(), campanha_id uuid, status text default 'pendente',
      total_pendentes integer, custo_estimado integer, creditos_no_inicio integer,
      criado_por_id uuid, criado_por_nome text, criado_por_email text
    );
    CREATE UNIQUE INDEX validacao_email_job_ativa_campanha_uidx
      ON public.validacao_email_job(campanha_id)
      WHERE status IN ('pendente','processando','sem_creditos','erro');
    CREATE TABLE public.validacao_email_job_item(
      job_id uuid, destinatario_id uuid, email text, email_normalizado text
    );
    CREATE FUNCTION public.normalize_email(value text) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT lower(btrim(value)) $$;
    INSERT INTO public.campanha VALUES ('${campaign}','rascunho');
    INSERT INTO public.destinatario VALUES ('${recipient}','${campaign}',false,'a@ivloud.com','pendente',null);
  `);
  await db.exec(await migration);
});

after(() => db.close());

test("correction stores original address in audit and marks bad cache as blocked", async () => {
  await db.query("INSERT INTO verificacao_email(email,status) VALUES($1,'spamtrap')", ["a@icloud.com"]);
  const { result } = await row("SELECT public.correct_campaign_recipient_domain($1,$2,$3,$4,'Operador','op@example.com') AS result", [
    campaign, "a@ivloud.com", "a@icloud.com", actor,
  ]);
  assert.equal(result.resultado, "bloqueado");
  assert.equal((await row("SELECT email,status FROM destinatario WHERE id=$1", [recipient])).status, "bloqueado_validacao_email");
  const audit = await row("SELECT metadata FROM evento_auditoria ORDER BY action LIMIT 1");
  assert.equal(audit.metadata.email_original, "a@ivloud.com");
  assert.equal(audit.metadata.email_corrigido, "a@icloud.com");
});

test("correcting into suppression applies suppressed state", async () => {
  const next = "00000000-0000-0000-0000-000000000004";
  await db.query("INSERT INTO destinatario(id,campanha_id,is_lembrete,email,status,excluido_em) VALUES($1,$2,false,'b@ivloud.com','pendente',null)", [next, campaign]);
  await db.query("INSERT INTO supressao(email) VALUES('b@icloud.com')");
  const { result } = await row("SELECT public.correct_campaign_recipient_domain($1,$2,$3,$4,'Operador','op@example.com') AS result", [
    campaign, "b@ivloud.com", "b@icloud.com", actor,
  ]);
  assert.equal(result.resultado, "suprimido");
});

test("duplicate target removes the incorrect recipient without creating a duplicate", async () => {
  const source = "00000000-0000-0000-0000-000000000005";
  const existing = "00000000-0000-0000-0000-000000000006";
  await db.query("INSERT INTO destinatario(id,campanha_id,is_lembrete,email,status,excluido_em) VALUES($1,$2,false,'c@ivloud.com','pendente',null)", [source, campaign]);
  await db.query("INSERT INTO destinatario(id,campanha_id,is_lembrete,email,status,excluido_em) VALUES($1,$2,false,'c@icloud.com','pendente',null)", [existing, campaign]);
  const { result } = await row("SELECT public.correct_campaign_recipient_domain($1,$2,$3,$4,'Operador','op@example.com') AS result", [
    campaign, "c@ivloud.com", "c@icloud.com", actor,
  ]);
  assert.equal(result.resultado, "duplicado_removido");
  assert.equal((await row("SELECT count(*)::int AS count FROM destinatario WHERE campanha_id=$1 AND email='c@icloud.com'", [campaign])).count, 1);
  const retained = await row("SELECT email,excluido_em,exclusao_motivo FROM destinatario WHERE id=$1", [source]);
  assert.equal(retained.email, "c@ivloud.com");
  assert.ok(retained.excluido_em);
  assert.equal(retained.exclusao_motivo, "duplicado apos correcao de dominio");
});

test("single-address validation creates exactly one queued item and refuses a non-ASCII email", async () => {
  const id = "00000000-0000-0000-0000-000000000007";
  await db.query("INSERT INTO destinatario(id,campanha_id,is_lembrete,email,status,excluido_em) VALUES($1,$2,false,'d@ivloud.com','pendente',null)", [id, campaign]);
  await correct("d@ivloud.com", "d@icloud.com");
  const job = await row("SELECT public.criar_validacao_unitaria_destinatario($1,$2,1,$3,'Operador','op@example.com') AS id", [
    campaign, "d@icloud.com", actor,
  ]);
  assert.equal((await row("SELECT count(*)::int AS count FROM validacao_email_job_item WHERE job_id=$1", [job.id])).count, 1);
  await assert.rejects(correct("d@ivloud.com", "d@iclóud.com"), /invalid_correction/u);
});
