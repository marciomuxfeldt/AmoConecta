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
    SELECT d.campanha_id, lower(btrim(d.email)) AS email, 1 AS recipients,
      d.enviado_em IS NOT NULL OR d.status IN ('enviado','entregue','aberto','clicado','bounce') AS sent,
      d.entregue_em IS NOT NULL OR d.status IN ('entregue','aberto','clicado') AS delivered,
      d.aberto_em IS NOT NULL AS opened, d.clicado_em IS NOT NULL AS clicked,
      d.status='bounce' AS bounced, 0 AS severity, false AS complained,
      d.descadastrado_em IS NOT NULL AS unsubscribed
    FROM destinatario d
    WHERE d.campanha_id=ANY(p_campaign_ids) AND d.is_lembrete=p_is_reminder
      AND nullif(btrim(d.email),'') IS NOT NULL
    UNION ALL
    -- Preserve the existing event attribution: events are grouped by campaign
    -- and address, including event-only contacts, for either message rollup.
    SELECT e.campanha_id, lower(btrim(e.email)), 0,
      e.tipo='email.sent',
      e.tipo IN ('email.delivered','email.opened','email.clicked','email.complained'),
      e.tipo='email.opened', e.tipo='email.clicked', e.tipo='email.bounced',
      CASE WHEN e.tipo<>'email.bounced' THEN 0
        WHEN e.bounce_permanente IS TRUE OR lower(btrim(e.bounce_tipo_bruto)) IN ('permanent','hard') THEN 3
        WHEN lower(btrim(e.bounce_tipo_bruto)) IN ('transient','temporary','soft','delayed') THEN 2
        ELSE 1 END,
      e.tipo='email.complained', false
    FROM evento_email e WHERE e.campanha_id=ANY(p_campaign_ids)
      AND nullif(btrim(e.email),'') IS NOT NULL
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
    SELECT public.normalize_email(d.email) AS email,d.excluido_em,
      coalesce(c.incluir_desengajados,false) AS include_disengaged
    FROM destinatario d JOIN campanha c ON c.id=d.campanha_id
    WHERE d.campanha_id=p_campaign_id AND d.is_lembrete=false
      AND nullif(public.normalize_email(d.email),'') IS NOT NULL
  ), exclusions AS (
    SELECT DISTINCT email FROM recipients WHERE excluido_em IS NOT NULL
  ), flags AS (
    SELECT r.email,
      EXISTS(SELECT 1 FROM supressao s WHERE public.normalize_email(s.email)=r.email) AS suppressed,
      EXISTS(SELECT 1 FROM contato_desengajamento cd
        WHERE cd.email=r.email AND cd.desengajado_cronico=true) AS chronic,
      EXISTS(SELECT 1 FROM exclusions x WHERE x.email=r.email) AS excluded,
      r.include_disengaged,
      -- Same Gmail plus alias semantics as isRecipientAllowed().
      CASE WHEN split_part(r.email,'@',2)='gmail.com'
        AND strpos(split_part(r.email,'@',1),'+')>1
        THEN split_part(split_part(r.email,'@',1),'+',1)||'@gmail.com'
        ELSE r.email END AS allowlist_email
    FROM recipients r
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

COMMIT;
