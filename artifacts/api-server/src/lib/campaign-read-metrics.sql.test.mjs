import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const id = "00000000-0000-0000-0000-000000000001";
const migration = await readFile(new URL("../../../../supabase/migrations/202611170024_campaign_read_metrics.sql", import.meta.url), "utf8");

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE campanha(id uuid primary key, incluir_desengajados boolean default false);
    CREATE TABLE destinatario(campanha_id uuid,email text,status text,is_lembrete boolean default false,
      enviado_em timestamptz,entregue_em timestamptz,aberto_em timestamptz,clicado_em timestamptz,
      descadastrado_em timestamptz,excluido_em timestamptz,data_ultima_compra date);
    CREATE TABLE evento_email(campanha_id uuid,email text,tipo text,bounce_permanente boolean,bounce_tipo_bruto text);
    CREATE TABLE supressao(email text);
    CREATE TABLE contato_desengajamento(email text,desengajado_cronico boolean);
    INSERT INTO campanha(id) VALUES ('${id}');
  `);
  const canonical = await readFile(new URL("../../../../supabase/migrations/202610050020_email_validation.sql", import.meta.url), "utf8");
  // Install the actual canonical function, not a simplified test substitute.
  await db.exec(canonical.slice(canonical.indexOf("CREATE OR REPLACE FUNCTION public.normalize_email("),
    canonical.indexOf("COMMENT ON FUNCTION public.normalize_email")));
  await db.exec(migration);
});
after(() => db.close());

test("read rollup deduplicates events, preserves timestamp evidence and permanent bounce precedence", async () => {
  await db.query(`INSERT INTO destinatario(campanha_id,email,status,enviado_em,descadastrado_em)
    VALUES ($1,'a@example.test','pendente',now(),now()),($1,'b@example.test','bounce',null,null)`, [id]);
  await db.query(`INSERT INTO evento_email VALUES
    ($1,'A@example.test','email.opened',null,null),
    ($1,'a@example.test','email.opened',null,null),
    ($1,'a@example.test','email.clicked',null,null),
    ($1,'b@example.test','email.bounced',false,'soft'),
    ($1,'b@example.test','email.bounced',true,'hard'),
    ($1,'only-event@example.test','email.complained',null,null)`, [id]);
  const row = (await db.query("SELECT * FROM campaign_email_rollups(ARRAY[$1::uuid],false)", [id])).rows[0];
  for (const [key, value] of Object.entries({
    destinatarios:2,enviados:2,entregues:2,aberturas:1,cliques:1,bounces:1,
    bouncesPermanentes:1,bouncesTemporarios:0,bouncesIndeterminados:0,reclamacoes:1,descadastros:1,
  })) assert.equal(Number(row[key]),value,key);
  const reminder = (await db.query("SELECT * FROM campaign_email_rollups(ARRAY[$1::uuid],true)", [id])).rows[0];
  assert.equal(Number(reminder.destinatarios),0);
  assert.equal(Number(reminder.aberturas),1, "preserves existing attribution of campaign events in reminder metrics");
});

test("large recipient sets return one summary row rather than one row per recipient", async () => {
  await db.query(`INSERT INTO destinatario(campanha_id,email,status)
    SELECT $1,'volume-'||i||'@example.test','pendente' FROM generate_series(1,10000) i`, [id]);
  const rows = (await db.query("SELECT * FROM campaign_email_rollups(ARRAY[$1::uuid],false)", [id])).rows;
  assert.equal(rows.length,1);
  assert.equal(Number(rows[0].destinatarios),10002);
  assert.ok(JSON.stringify(rows).length < 500);
});

test("read projection preserves suppression, reversible exclusion, chronic disengagement and Gmail alias rules", async () => {
  await db.exec(`TRUNCATE destinatario,evento_email;
    INSERT INTO destinatario(campanha_id,email,status,excluido_em) VALUES
      ($1,'ok+tag@gmail.com','pendente',null),
      ($1,'other@domain.test','pendente',null),
      ($1,'suppressed@domain.test','pendente',null),
      ($1,'chronic@domain.test','pendente',null),
      ($1,'excluded@domain.test','pendente',now());
    INSERT INTO supressao VALUES('suppressed@domain.test');
    INSERT INTO contato_desengajamento VALUES('chronic@domain.test',true);`.replaceAll("$1", `'${id}'`));
  const projection = async (enabled) => (await db.query(
    "SELECT campaign_read_projection($1,$2,ARRAY['ok@gmail.com']) AS value",[id,enabled])).rows[0].value;
  assert.deepEqual(await projection(false),{
    total_na_lista:5,suprimidos_no_envio:1,permitidos_modo_teste:1,
    bloqueados_modo_teste:1,receberao_de_fato:1,
    desengajados_na_lista:1,bloqueados_desengajados:1,
  });
  assert.equal((await projection(true)).receberao_de_fato,2);
});

test("read RPCs are not executable by anonymous or authenticated callers", async () => {
  for (const role of ["anon","authenticated"]) {
    const row = (await db.query(`SELECT
      has_function_privilege($1,'campaign_email_rollups(uuid[],boolean)','EXECUTE') AS rollup,
      has_function_privilege($1,'campaign_read_projection(uuid,boolean,text[])','EXECUTE') AS projection,
      has_function_privilege($1,'campaign_read_counts(uuid,date)','EXECUTE') AS counts`,[role])).rows[0];
    assert.equal(row.rollup,false);
    assert.equal(row.projection,false);
    assert.equal(row.counts,false);
  }
});

test("status and recency counts include the same exclusions and reminder boundaries as the screen", async () => {
  const value = (await db.query("SELECT campaign_read_counts($1,'2026-11-17'::date) AS value",[id])).rows[0].value;
  assert.deepEqual(value.statusCounts,[4,0,0,0,0,0,0]);
  assert.deepEqual(value.reminderStatusCounts,[0,0,0,0,0,0,0]);
  assert.equal(value.excludedCount,1);
  assert.deepEqual(value.recencyCounts,[0,0,0,0,0,5]);
});

test("read counts preserve inclusive date boundaries, future dates, excluded rows and reminder states", async () => {
  const campaign = "00000000-0000-0000-0000-000000000002";
  await db.query(`INSERT INTO destinatario(campanha_id,email,is_lembrete,status,data_ultima_compra,excluido_em)
    SELECT $1,'boundary-'||v.n||'@example.com',v.n=12,v.status,
      CASE WHEN v.days IS NULL THEN NULL ELSE '2026-11-17'::date-v.days END,
      CASE WHEN v.n=3 THEN now() ELSE NULL END
    FROM (VALUES
      (1,'pendente',0),(2,'processando',30),(3,'bounce',31),
      (4,'entregue',90),(5,'aberto',91),(6,'clicado',180),(7,'enviado',181),
      (8,'bloqueado_validacao_email',365),(9,'suprimido',366),
      (10,'erro',NULL),(11,'pendente',-1),(12,'processando',NULL)
    ) AS v(n,status,days)`,[campaign]);
  const {value} = (await db.query("SELECT campaign_read_counts($1,'2026-11-17'::date) AS value",[campaign])).rows[0];
  assert.deepEqual(value.statusCounts,[3,1,3,0,1,1,1]);
  assert.deepEqual(value.reminderStatusCounts,[1,0,0,0,0,0,0]);
  assert.equal(value.excludedCount,1);
  assert.deepEqual(value.recencyCounts,[2,2,2,2,1,1]);
});
