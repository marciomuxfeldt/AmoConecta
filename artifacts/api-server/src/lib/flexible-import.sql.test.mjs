import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const migration = readFile(
  new URL("../../../../supabase/migrations/202610080022_flexible_campaign_import.sql", import.meta.url),
  "utf8",
);
const campaignId = "00000000-0000-0000-0000-000000000001";
const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];

before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.campanha (id uuid PRIMARY KEY);
    CREATE TABLE public.importacao (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campanha_id uuid NOT NULL REFERENCES public.campanha(id),
      caminho_arquivo text NOT NULL,
      status text NOT NULL DEFAULT 'pendente'
        CHECK (status IN ('pendente', 'processando', 'concluida', 'erro')),
      linhas_processadas integer NOT NULL DEFAULT 0,
      total_linhas integer,
      resultado jsonb,
      erro text,
      criado_em timestamptz NOT NULL DEFAULT now(),
      concluido_em timestamptz
    );
    INSERT INTO public.campanha(id) VALUES ('${campaignId}');
  `);
  await db.exec(await migration);
});

after(() => db.close());

test("campaign reference-date metadata accepts supported meanings and requires custom labels only for other", async () => {
  await db.query(
    "UPDATE campanha SET data_referencia_tipo='acesso' WHERE id=$1",
    [campaignId],
  );
  assert.equal(
    (await row("SELECT data_referencia_tipo FROM campanha WHERE id=$1", [campaignId]))
      .data_referencia_tipo,
    "acesso",
  );
  await assert.rejects(
    db.query(
      "UPDATE campanha SET data_referencia_tipo='outro',data_referencia_rotulo=NULL WHERE id=$1",
      [campaignId],
    ),
    /campanha_data_referencia_check/u,
  );
  await db.query(
    "UPDATE campanha SET data_referencia_tipo='outro',data_referencia_rotulo='Renovação' WHERE id=$1",
    [campaignId],
  );
  await assert.rejects(
    db.query(
      "UPDATE campanha SET data_referencia_rotulo=$2 WHERE id=$1",
      [campaignId, "x".repeat(81)],
    ),
    /campanha_data_referencia_check/u,
  );
});

test("import jobs permit the preflight and cancellation states while rejecting unknown states", async () => {
  const { id } = await row(
    "INSERT INTO importacao(campanha_id,caminho_arquivo,status) VALUES($1,'campaign/a.csv','aguardando_confirmacao') RETURNING id",
    [campaignId],
  );
  await db.query("UPDATE importacao SET status='cancelada' WHERE id=$1", [id]);
  await assert.rejects(
    db.query("UPDATE importacao SET status='unexpected' WHERE id=$1", [id]),
    /importacao_status_check/u,
  );
});

test("saved header mappings are service-role-only and store normalized signatures", async () => {
  const signature = "a".repeat(64);
  await db.query(
    "INSERT INTO importacao_mapeamento_cabecalho(assinatura,mapeamento) VALUES($1,$2::jsonb)",
    [signature, JSON.stringify(["email", "ignore"])],
  );
  assert.deepEqual(
    (await row(
      "SELECT mapeamento FROM importacao_mapeamento_cabecalho WHERE assinatura=$1",
      [signature],
    )).mapeamento,
    ["email", "ignore"],
  );
  const privileges = await row(`
    SELECT
      has_table_privilege('anon','public.importacao_mapeamento_cabecalho','SELECT') AS anon_select,
      has_table_privilege('authenticated','public.importacao_mapeamento_cabecalho','SELECT') AS authenticated_select,
      has_table_privilege('service_role','public.importacao_mapeamento_cabecalho','SELECT') AS service_select
  `);
  assert.equal(privileges.anon_select, false);
  assert.equal(privileges.authenticated_select, false);
  assert.equal(privileges.service_select, true);
  assert.equal(
    (await row(`
      SELECT relrowsecurity AS enabled
      FROM pg_class
      WHERE oid='public.importacao_mapeamento_cabecalho'::regclass
    `)).enabled,
    true,
  );
});
