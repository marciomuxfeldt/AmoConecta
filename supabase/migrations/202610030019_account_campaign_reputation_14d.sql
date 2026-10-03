-- Aplicação MANUAL. Esta aproximação local não substitui a métrica oficial da SES.
BEGIN;

CREATE INDEX IF NOT EXISTS destinatario_reputacao_conta_enviado_idx
  ON public.destinatario (enviado_em, id)
  WHERE enviado_em IS NOT NULL;

CREATE OR REPLACE FUNCTION public.account_campaign_reputation_counts_14d()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT now() - interval '14 days' AS periodo_inicio, now() AS periodo_fim
  ),
  cohort AS (
    SELECT d.id, d.resend_email_id, d.entregue_em
    FROM public.destinatario d
    CROSS JOIN bounds b
    WHERE d.enviado_em >= b.periodo_inicio
      AND d.enviado_em < b.periodo_fim
  ),
  totals AS (
    SELECT
      count(*)::integer AS total_enviado,
      count(*) FILTER (WHERE d.entregue_em IS NOT NULL)::integer AS total_entregue,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1
        FROM public.evento_email e
        WHERE (e.destinatario_id = d.id OR e.resend_email_id = d.resend_email_id)
          AND e.tipo = 'email.bounced'
          AND e.bounce_permanente = true
      ))::integer AS bounces_permanentes,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1
        FROM public.evento_email e
        WHERE (e.destinatario_id = d.id OR e.resend_email_id = d.resend_email_id)
          AND e.tipo = 'email.complained'
      ))::integer AS reclamacoes
    FROM cohort d
  )
  SELECT jsonb_build_object(
    'periodo_inicio', b.periodo_inicio,
    'periodo_fim', b.periodo_fim,
    'total_enviado', t.total_enviado,
    'total_entregue', t.total_entregue,
    'bounces_permanentes', t.bounces_permanentes,
    'reclamacoes', t.reclamacoes
  )
  FROM bounds b CROSS JOIN totals t;
$$;

REVOKE ALL ON FUNCTION public.account_campaign_reputation_counts_14d()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_campaign_reputation_counts_14d()
  TO service_role;

COMMIT;