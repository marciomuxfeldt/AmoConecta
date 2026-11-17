import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const id = "00000000-0000-0000-0000-000000000001";
const migration = await readFile(new URL("../../../../supabase/migrations/202611170024_campaign_read_metrics.sql", import.meta.url), "utf8");
let verificationRows;

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE campanha(id uuid primary key, incluir_desengajados boolean default false);
    CREATE TABLE destinatario(id uuid default gen_random_uuid(),campanha_id uuid,email text,status text,is_lembrete boolean default false,
      enviado_em timestamptz,entregue_em timestamptz,aberto_em timestamptz,clicado_em timestamptz,
      descadastrado_em timestamptz,excluido_em timestamptz,data_ultima_compra date);
    CREATE TABLE evento_email(campanha_id uuid,email text,tipo text,bounce_permanente boolean,bounce_tipo_bruto text);
    CREATE TABLE supressao(email text);
    CREATE TABLE contato_desengajamento(email text,desengajado_cronico boolean);
    CREATE UNIQUE INDEX supressao_email_uidx ON supressao(email) WHERE email IS NOT NULL;
    ALTER TABLE contato_desengajamento ADD PRIMARY KEY(email);
    CREATE UNIQUE INDEX destinatario_campanha_email_lembrete_uidx
      ON destinatario(campanha_id,email,is_lembrete);
    INSERT INTO campanha(id) VALUES ('${id}');
  `);
  const canonical = await readFile(new URL("../../../../supabase/migrations/202610050020_email_validation.sql", import.meta.url), "utf8");
  // Install the actual canonical function, not a simplified test substitute.
  await db.exec(canonical.slice(canonical.indexOf("CREATE OR REPLACE FUNCTION public.normalize_email("),
    canonical.indexOf("COMMENT ON FUNCTION public.normalize_email")));
  await db.exec(`
    ALTER TABLE destinatario ADD CONSTRAINT destinatario_email_normalizado_check
      CHECK (email=public.normalize_email(email) AND email !~ '[[:space:]]') NOT VALID;
    ALTER TABLE destinatario VALIDATE CONSTRAINT destinatario_email_normalizado_check;
  `);
  const results = await db.exec(migration);
  verificationRows = results.filter((result) => result.fields.some((field) => field.name === "secao")).at(-1).rows;
});
after(() => db.close());

test("recipient fixture guarantees normalized emails with a validated database constraint", async () => {
  const constraint = (await db.query(`
    SELECT convalidated FROM pg_constraint
    WHERE conname='destinatario_email_normalizado_check'
  `)).rows[0];
  assert.equal(constraint.convalidated,true);
  await assert.rejects(
    db.query("INSERT INTO destinatario(campanha_id,email,status) VALUES($1,'UPPER@example.test','pendente')",[id]),
    /destinatario_email_normalizado_check/,
  );
});

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

test("new rollups match the frozen previous algorithm for exclusions, reminders, empty emails and delivered plus bounce", async () => {
  const campaign = "00000000-0000-0000-0000-000000000003";
  await db.query(`INSERT INTO destinatario(campanha_id,email,status,is_lembrete,entregue_em,excluido_em) VALUES
    ($1,'bounce@example.test','bounce',false,now(),null),
    ($1,'excluded@example.test','entregue',false,now(),now()),
    ($1,'reminder@example.test','enviado',true,null,null),
    ($1,'','pendente',false,null,null)`,[campaign]);
  await db.query(`INSERT INTO evento_email VALUES
    ($1,'bounce@example.test','email.delivered',null,null),
    ($1,'bounce@example.test','email.bounced',true,'hard'),
    ($1,'reminder@example.test','email.opened',null,null)`,[campaign]);
  for (const reminder of [false,true]) {
    const previous = (await db.query("SELECT * FROM pg_temp.campaign_email_rollups_previous(ARRAY[$1::uuid],$2)",[campaign,reminder])).rows;
    const current = (await db.query("SELECT * FROM campaign_email_rollups(ARRAY[$1::uuid],$2)",[campaign,reminder])).rows;
    assert.deepEqual(current,previous);
  }
  const row = (await db.query("SELECT * FROM campaign_email_rollups(ARRAY[$1::uuid],false)",[campaign])).rows[0];
  assert.equal(Number(row.destinatarios),2,"excluded recipient remains counted; empty address does not");
  assert.equal(Number(row.entregues),3,"delivery and bounce are independent in the previous screen metrics");
  assert.equal(Number(row.bounces),1);
  assert.equal(Number(row.aberturas),1,"reminder event is attributed to both rollups, as before");
});

test("canonical event normalization prevents an invisible address from creating a second contact", async () => {
  const campaign = "00000000-0000-0000-0000-000000000004";
  await db.query(`INSERT INTO destinatario(campanha_id,email,status,entregue_em)
    VALUES($1,'same@example.test','entregue',now())`,[campaign]);
  for (const type of ["email.sent","email.delivered"]) {
    await db.query("INSERT INTO evento_email VALUES($1,$2,$3,null,null)",[campaign,"\u200Bsame@example.test",type]);
  }
  const current = (await db.query("SELECT * FROM campaign_email_rollups(ARRAY[$1::uuid],false)",[campaign])).rows[0];
  const previous = (await db.query("SELECT * FROM pg_temp.campaign_email_rollups_previous(ARRAY[$1::uuid],false)",[campaign])).rows[0];
  assert.equal(Number(current.enviados),1);
  assert.equal(Number(current.entregues),1);
  assert.equal(Number(previous.enviados),2);
  assert.equal(Number(previous.entregues),2);
});

test("verification returns all three identified timings and both campaign comparisons in one result", () => {
  const timings = verificationRows.filter((row) => row.secao === "medicao");
  assert.deepEqual(timings.map((row) => [row.funcao,row.limite_ms]),[
    ["campaign_email_rollups",1000],
    ["campaign_read_counts",1000],
    ["campaign_read_projection",300],
  ]);
  for (const row of timings) {
    assert.ok(Number(row.duracao_ms)>=0);
    assert.equal(row.aprovado,Number(row.duracao_ms)<row.limite_ms);
  }
  const comparisons = verificationRows.filter((row) => row.secao === "comparacao");
  assert.deepEqual(comparisons.map((row) => [row.campanha_id,row.lembrete,row.iguais]),[
    [id,false,true],[id,true,true],
  ]);
  const plans = verificationRows.filter((row) => row.secao === "plano");
  assert.equal(plans.length,1);
  assert.ok(Array.isArray(plans[0].plano));
  assert.ok(plans[0].plano[0].Plan);
  assert.ok("Execution Time" in plans[0].plano[0]);
  assert.ok("Shared Hit Blocks" in plans[0].plano[0].Plan);
  const diagnostics = verificationRows.filter((row) => row.secao === "diagnostico");
  assert.equal(diagnostics.length,1);
  assert.equal(diagnostics[0].metadados.provolatile,"i");
  assert.equal(diagnostics[0].metadados.proparallel,"s");
  assert.equal(diagnostics[0].metadados.prosecdef,false);
  assert.equal(diagnostics[0].metadados.language_name,"sql");
});

test("joined projection preserves all counters with overlapping suppression, chronic disengagement and exclusion", async () => {
  const campaign = "00000000-0000-0000-0000-000000000005";
  await db.query("INSERT INTO campanha(id) VALUES($1)",[campaign]);
  await db.query(`INSERT INTO destinatario(campanha_id,email,status,excluido_em) VALUES
    ($1,'allowed+tag@gmail.com','pendente',null),
    ($1,'domain@join.test','pendente',null),
    ($1,'suppressed@join.test','pendente',null),
    ($1,'excluded@join.test','pendente',now()),
    ($1,'chronic@join.test','pendente',null)`,[campaign]);
  await db.exec(`INSERT INTO supressao VALUES('suppressed@join.test');
    INSERT INTO contato_desengajamento VALUES
      ('suppressed@join.test',true),('excluded@join.test',true),('chronic@join.test',true);`);
  const projection = async (enabled,allowlist) => (await db.query(
    "SELECT campaign_read_projection($1,$2,$3::text[]) AS value",[campaign,enabled,allowlist])).rows[0].value;
  const expected = {
    total_na_lista:5,suprimidos_no_envio:1,permitidos_modo_teste:1,
    bloqueados_modo_teste:1,receberao_de_fato:1,
    desengajados_na_lista:3,bloqueados_desengajados:2,
  };
  assert.deepEqual(await projection(false,["allowed@gmail.com"]),expected);
  const unrestricted = {...expected,permitidos_modo_teste:2,bloqueados_modo_teste:0,receberao_de_fato:2};
  assert.deepEqual(await projection(false,["allowed@gmail.com","@join.test"]),unrestricted);
  assert.deepEqual(await projection(true,[]),unrestricted);
  await db.query("UPDATE campanha SET incluir_desengajados=true WHERE id=$1",[campaign]);
  assert.deepEqual(await projection(false,["allowed@gmail.com","@join.test"]),{
    ...unrestricted,permitidos_modo_teste:3,receberao_de_fato:3,bloqueados_desengajados:0,
  });
});
