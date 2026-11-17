BEGIN;

-- Read-only aggregation. No indexes, cached tables, or sending rules change.
CREATE OR REPLACE FUNCTION public.campaign_email_rollups(
  p_campaign_ids uuid[], p_is_reminder boolean DEFAULT false
) RETURNS TABLE (
  campanha_id uuid, destinatarios bigint, enviados bigint, entregues bigint,
  aberturas bigint, cliques bigint, bounces bigint, "bouncesPermanentes" bigint,
  "bouncesTemporarios" bigint, "bouncesIndeterminados" bigint,
  reclamacoes bigint, descadastros bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  WITH facts AS (
    SELECT d.campanha_id, public.normalize_email(d.email) AS email, 1 AS recipients,
      d.enviado_em IS NOT NULL OR d.status IN ('enviado','entregue','aberto','clicado','bounce') AS sent,
      d.entregue_em IS NOT NULL OR d.status IN ('entregue','aberto','clicado') AS delivered,
      d.aberto_em IS NOT NULL AS opened, d.clicado_em IS NOT NULL AS clicked,
      d.status='bounce' AS bounced, 0 AS severity, false AS complained,
      d.descadastrado_em IS NOT NULL AS unsubscribed
    FROM destinatario d
    WHERE d.campanha_id=ANY(p_campaign_ids) AND d.is_lembrete=p_is_reminder
      AND nullif(public.normalize_email(d.email),'') IS NOT NULL
    UNION ALL
    -- Preserve the existing event attribution: events are grouped by campaign
    -- and address, including event-only contacts, for either message rollup.
    SELECT e.campanha_id, public.normalize_email(e.email), 0,
      e.tipo='email.sent',
      e.tipo IN ('email.delivered','email.opened','email.clicked','email.complained'),
      e.tipo='email.opened', e.tipo='email.clicked', e.tipo='email.bounced',
      CASE WHEN e.tipo<>'email.bounced' THEN 0
        WHEN e.bounce_permanente IS TRUE OR lower(btrim(e.bounce_tipo_bruto)) IN ('permanent','hard') THEN 3
        WHEN lower(btrim(e.bounce_tipo_bruto)) IN ('transient','temporary','soft','delayed') THEN 2
        ELSE 1 END,
      e.tipo='email.complained', false
    FROM evento_email e WHERE e.campanha_id=ANY(p_campaign_ids)
      AND nullif(public.normalize_email(e.email),'') IS NOT NULL
  ), contacts AS (
    SELECT f.campanha_id,f.email,sum(recipients) AS recipients,
      bool_or(sent) AS sent, bool_or(delivered) AS delivered,
      bool_or(opened) AS opened, bool_or(clicked) AS clicked,
      bool_or(bounced) AS bounced, max(severity) AS severity,
      bool_or(complained) AS complained, bool_or(unsubscribed) AS unsubscribed
    FROM facts f GROUP BY f.campanha_id,f.email
  )
  SELECT c.campanha_id,sum(c.recipients)::bigint,
    count(*) FILTER(WHERE sent),count(*) FILTER(WHERE delivered),
    count(*) FILTER(WHERE opened),count(*) FILTER(WHERE clicked),
    count(*) FILTER(WHERE bounced),
    count(*) FILTER(WHERE bounced AND severity=3),
    count(*) FILTER(WHERE bounced AND severity=2),
    count(*) FILTER(WHERE bounced AND severity IN (0,1)),
    count(*) FILTER(WHERE complained),count(*) FILTER(WHERE unsubscribed)
  FROM contacts c GROUP BY c.campanha_id;
$$;

-- Projection for the summary screen only. The existing sending/import/
-- exclusion code paths continue using their existing implementation.
CREATE OR REPLACE FUNCTION public.campaign_read_projection(
  p_campaign_id uuid, p_send_enabled boolean, p_allowlist text[]
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  WITH recipients AS (
    SELECT d.email,d.excluido_em,
      coalesce(c.incluir_desengajados,false) AS include_disengaged
    FROM destinatario d JOIN campanha c ON c.id=d.campanha_id
    WHERE d.campanha_id=p_campaign_id AND d.is_lembrete=false
      AND nullif(d.email,'') IS NOT NULL
  ), flags AS (
    SELECT r.email,
      s.email IS NOT NULL AS suppressed,
      cd.email IS NOT NULL AS chronic,
      r.excluido_em IS NOT NULL AS excluded,
      r.include_disengaged,
      -- Same Gmail plus alias semantics as isRecipientAllowed().
      CASE WHEN split_part(r.email,'@',2)='gmail.com'
        AND strpos(split_part(r.email,'@',1),'+')>1
        THEN split_part(split_part(r.email,'@',1),'+',1)||'@gmail.com'
        ELSE r.email END AS allowlist_email
    FROM recipients r
    LEFT JOIN supressao s ON s.email=r.email
    LEFT JOIN contato_desengajamento cd
      ON cd.email=r.email AND cd.desengajado_cronico=true
  ), eligible AS (
    SELECT *, NOT suppressed AND NOT excluded AND (include_disengaged OR NOT chronic) AS eligible,
      p_send_enabled OR allowlist_email=ANY(p_allowlist)
        OR ('@'||split_part(email,'@',2))=ANY(p_allowlist) AS allowed
    FROM flags
  )
  SELECT jsonb_build_object(
    'total_na_lista',count(*),
    'suprimidos_no_envio',count(*) FILTER(WHERE suppressed),
    'permitidos_modo_teste',count(*) FILTER(WHERE eligible AND allowed),
    'bloqueados_modo_teste',count(*) FILTER(WHERE eligible AND NOT allowed),
    'receberao_de_fato',count(*) FILTER(WHERE eligible AND allowed),
    'desengajados_na_lista',count(*) FILTER(WHERE chronic),
    'bloqueados_desengajados',count(*) FILTER(WHERE chronic AND NOT suppressed AND NOT include_disengaged)
  ) FROM eligible;
$$;

CREATE OR REPLACE FUNCTION public.campaign_read_counts(p_campaign_id uuid,p_today date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  WITH source AS MATERIALIZED (
    SELECT status,is_lembrete,excluido_em,data_ultima_compra
    FROM destinatario WHERE campanha_id=p_campaign_id
  ), statuses AS (
    SELECT is_lembrete,jsonb_build_array(
      count(*) FILTER(WHERE status IN ('pendente','processando')),
      count(*) FILTER(WHERE status='enviado'),
      count(*) FILTER(WHERE status IN ('entregue','aberto','clicado')),
      count(*) FILTER(WHERE status='bounce'),
      count(*) FILTER(WHERE status IN ('bloqueado_modo_teste','bloqueado_desengajado','bloqueado_validacao_email')),
      count(*) FILTER(WHERE status='suprimido'),
      count(*) FILTER(WHERE status='erro')
    ) AS counts FROM source WHERE excluido_em IS NULL GROUP BY is_lembrete
  )
  SELECT jsonb_build_object(
    'statusCounts',coalesce((SELECT counts FROM statuses WHERE NOT is_lembrete),'[0,0,0,0,0,0,0]'::jsonb),
    'reminderStatusCounts',coalesce((SELECT counts FROM statuses WHERE is_lembrete),'[0,0,0,0,0,0,0]'::jsonb),
    'excludedCount',count(*) FILTER(WHERE excluido_em IS NOT NULL),
    'recencyCounts',jsonb_build_array(
      count(*) FILTER(WHERE data_ultima_compra>=p_today-30 AND data_ultima_compra<=p_today),
      count(*) FILTER(WHERE data_ultima_compra>=p_today-90 AND data_ultima_compra<p_today-30),
      count(*) FILTER(WHERE data_ultima_compra>=p_today-180 AND data_ultima_compra<p_today-90),
      count(*) FILTER(WHERE data_ultima_compra>=p_today-365 AND data_ultima_compra<p_today-180),
      count(*) FILTER(WHERE data_ultima_compra<p_today-365),
      count(*) FILTER(WHERE data_ultima_compra IS NULL)
    )
  ) FROM source WHERE NOT is_lembrete;
$$;

REVOKE ALL ON FUNCTION public.campaign_read_counts(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_read_counts(uuid,date) TO service_role;
REVOKE ALL ON FUNCTION public.campaign_email_rollups(uuid[],boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_read_projection(uuid,boolean,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_email_rollups(uuid[],boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_read_projection(uuid,boolean,text[]) TO service_role;

-- Diagnostic helpers live only in this SQL session, not in the public API.
-- Frozen normalization used by the previous JavaScript: trim(), toLowerCase().
CREATE OR REPLACE FUNCTION pg_temp.campaign_email_legacy_key(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(p_email,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
$$;

-- Independent SQL transcription of the previous JavaScript rollup.
-- No exclusion filter, and events belong to both main/reminder rollups.
-- The last recipient by id supplies descadastrado_em, as in the paged loop.
CREATE OR REPLACE FUNCTION pg_temp.campaign_email_rollups_previous(
  p_campaign_ids uuid[], p_is_reminder boolean
) RETURNS TABLE (
  campanha_id uuid, destinatarios bigint, enviados bigint, entregues bigint,
  aberturas bigint, cliques bigint, bounces bigint, "bouncesPermanentes" bigint,
  "bouncesTemporarios" bigint, "bouncesIndeterminados" bigint,
  reclamacoes bigint, descadastros bigint
)
LANGUAGE sql STABLE AS $$
  WITH recipients AS (
    SELECT d.campanha_id,pg_temp.campaign_email_legacy_key(d.email) AS email,
      count(*) AS recipients,
      bool_or(d.enviado_em IS NOT NULL OR d.status IN ('enviado','entregue','aberto','clicado','bounce')) AS sent,
      bool_or(d.entregue_em IS NOT NULL OR d.status IN ('entregue','aberto','clicado')) AS delivered,
      bool_or(d.aberto_em IS NOT NULL) AS opened,
      bool_or(d.clicado_em IS NOT NULL) AS clicked,
      bool_or(d.status='bounce') AS bounced,
      (array_agg(d.descadastrado_em IS NOT NULL ORDER BY d.id DESC))[1] AS unsubscribed
    FROM public.destinatario d
    WHERE d.campanha_id=ANY(p_campaign_ids) AND d.is_lembrete=p_is_reminder
      AND nullif(pg_temp.campaign_email_legacy_key(d.email),'') IS NOT NULL
    GROUP BY d.campanha_id,pg_temp.campaign_email_legacy_key(d.email)
  ), events AS (
    SELECT e.campanha_id,pg_temp.campaign_email_legacy_key(e.email) AS email,
      bool_or(e.tipo='email.sent') AS sent,
      bool_or(e.tipo IN ('email.delivered','email.opened','email.clicked','email.complained')) AS delivered,
      bool_or(e.tipo='email.opened') AS opened,bool_or(e.tipo='email.clicked') AS clicked,
      bool_or(e.tipo='email.bounced') AS bounced,
      max(CASE WHEN e.tipo<>'email.bounced' THEN 0
        WHEN e.bounce_permanente IS TRUE OR pg_temp.campaign_email_legacy_key(e.bounce_tipo_bruto) IN ('permanent','hard') THEN 3
        WHEN pg_temp.campaign_email_legacy_key(e.bounce_tipo_bruto) IN ('transient','temporary','soft','delayed') THEN 2
        ELSE 1 END) AS severity,
      bool_or(e.tipo='email.complained') AS complained
    FROM public.evento_email e WHERE e.campanha_id=ANY(p_campaign_ids)
      AND nullif(pg_temp.campaign_email_legacy_key(e.email),'') IS NOT NULL
    GROUP BY e.campanha_id,pg_temp.campaign_email_legacy_key(e.email)
  ), contacts AS (
    SELECT coalesce(r.campanha_id,e.campanha_id) AS campanha_id,
      coalesce(r.recipients,0) AS recipients,
      coalesce(r.sent,false) OR coalesce(e.sent,false) AS sent,
      coalesce(r.delivered,false) OR coalesce(e.delivered,false) AS delivered,
      coalesce(r.opened,false) OR coalesce(e.opened,false) AS opened,
      coalesce(r.clicked,false) OR coalesce(e.clicked,false) AS clicked,
      coalesce(r.bounced,false) OR coalesce(e.bounced,false) AS bounced,
      coalesce(e.severity,0) AS severity,coalesce(e.complained,false) AS complained,
      coalesce(r.unsubscribed,false) AS unsubscribed
    FROM recipients r FULL JOIN events e USING(campanha_id,email)
  )
  SELECT c.campanha_id,sum(recipients)::bigint,
    count(*) FILTER(WHERE sent),count(*) FILTER(WHERE delivered),
    count(*) FILTER(WHERE opened),count(*) FILTER(WHERE clicked),
    count(*) FILTER(WHERE bounced),count(*) FILTER(WHERE bounced AND severity=3),
    count(*) FILTER(WHERE bounced AND severity=2),
    count(*) FILTER(WHERE bounced AND severity IN (0,1)),
    count(*) FILTER(WHERE complained),count(*) FILTER(WHERE unsubscribed)
  FROM contacts c GROUP BY c.campanha_id;
$$;

-- Check the live invariants and indexes rather than assuming migrations ran.
SELECT conrelid::regclass AS tabela,conname,convalidated,
  pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid IN ('public.destinatario'::regclass,'public.supressao'::regclass,
  'public.contato_desengajamento'::regclass,'public.evento_email'::regclass)
  AND contype='c' ORDER BY tabela,conname;
SELECT tablename,indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('supressao','contato_desengajamento');
SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definicao FROM pg_trigger
WHERE tgrelid='public.evento_email'::regclass AND NOT tgisinternal;
SELECT
  (SELECT count(*) FROM public.evento_email
    WHERE email IS DISTINCT FROM public.normalize_email(email)) AS eventos_divergentes,
  (SELECT count(*) FROM public.destinatario
    WHERE nullif(public.normalize_email(email),'') IS NULL) AS destinatarios_email_vazio;

-- One final result set contains three timing rows and two comparison rows
-- per campaign (18 comparison rows for the current nine campaigns).
-- SELECT below is the last row-returning statement, including on ROLLBACK.
CREATE TEMP TABLE campaign_read_verification (
  secao text NOT NULL,
  funcao text,
  duracao_ms numeric,
  limite_ms integer,
  aprovado boolean,
  campanha_id uuid,
  lembrete boolean,
  anterior jsonb,
  nova jsonb,
  iguais boolean
) ON COMMIT DROP;

-- PL/pgSQL statements execute in this order: start -> call -> stop.
-- No timing relies on the planner's ordering of independent expressions.
DO $measurement$
DECLARE
  v_ids uuid[];
  v_started timestamptz;
  v_duration numeric;
  v_campaign constant uuid := '8141923e-e3b3-46fd-a59b-19dcf42d5336';
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO v_ids FROM public.campanha;

  v_started := clock_timestamp();
  PERFORM * FROM public.campaign_email_rollups(v_ids,false);
  v_duration := extract(epoch FROM clock_timestamp()-v_started)*1000;
  INSERT INTO campaign_read_verification(secao,funcao,duracao_ms,limite_ms,aprovado)
    VALUES('medicao','campaign_email_rollups',v_duration,1000,v_duration<1000);

  v_started := clock_timestamp();
  PERFORM public.campaign_read_counts(v_campaign,v_today);
  v_duration := extract(epoch FROM clock_timestamp()-v_started)*1000;
  INSERT INTO campaign_read_verification(secao,funcao,duracao_ms,limite_ms,aprovado)
    VALUES('medicao','campaign_read_counts',v_duration,1000,v_duration<1000);

  -- true/empty allowlist measures an isolated read. It changes no environment
  -- setting, authorizes no real sending, and preserves the previous scenario.
  v_started := clock_timestamp();
  PERFORM public.campaign_read_projection(v_campaign,true,ARRAY[]::text[]);
  v_duration := extract(epoch FROM clock_timestamp()-v_started)*1000;
  INSERT INTO campaign_read_verification(secao,funcao,duracao_ms,limite_ms,aprovado)
    VALUES('medicao','campaign_read_projection',v_duration,300,v_duration<300);
END;
$measurement$;

-- Compare after timing, so the reference calculation does not warm the
-- rollup's buffers first. {} means no contacts.
INSERT INTO campaign_read_verification(secao,campanha_id,lembrete,anterior,nova,iguais)
WITH ids AS (SELECT coalesce(array_agg(id),'{}'::uuid[]) AS ids FROM public.campanha),
previous AS (
  SELECT p.*,m.lembrete FROM ids CROSS JOIN (VALUES(false),(true)) m(lembrete)
  CROSS JOIN LATERAL pg_temp.campaign_email_rollups_previous(ids.ids,m.lembrete) p
), current AS (
  SELECT n.*,m.lembrete FROM ids CROSS JOIN (VALUES(false),(true)) m(lembrete)
  CROSS JOIN LATERAL public.campaign_email_rollups(ids.ids,m.lembrete) n
)
SELECT 'comparacao',c.id AS campanha_id,m.lembrete,
  coalesce(to_jsonb(p)-'campanha_id'-'lembrete','{}'::jsonb) AS anterior,
  coalesce(to_jsonb(n)-'campanha_id'-'lembrete','{}'::jsonb) AS nova,
  coalesce(to_jsonb(p)-'campanha_id'-'lembrete','{}'::jsonb)
    =coalesce(to_jsonb(n)-'campanha_id'-'lembrete','{}'::jsonb) AS iguais
FROM public.campanha c CROSS JOIN (VALUES(false),(true)) m(lembrete)
LEFT JOIN previous p ON p.campanha_id=c.id AND p.lembrete=m.lembrete
LEFT JOIN current n ON n.campanha_id=c.id AND n.lembrete=m.lembrete
ORDER BY c.id,m.lembrete;

-- One visible output: first the three times, then all comparisons.
-- Acceptance: all aprovado=true AND all iguais=true.
-- For a non-persistent trial, replace the final COMMIT with ROLLBACK.
SELECT secao,funcao,duracao_ms,limite_ms,aprovado,
  campanha_id,lembrete,anterior,nova,iguais
FROM campaign_read_verification
ORDER BY CASE secao WHEN 'medicao' THEN 0 ELSE 1 END,
  funcao,campanha_id,lembrete;

COMMIT;
