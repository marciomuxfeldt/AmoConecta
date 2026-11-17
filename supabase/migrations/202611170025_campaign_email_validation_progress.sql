BEGIN;

ALTER TABLE public.validacao_email_job
  ADD COLUMN IF NOT EXISTS progresso_atualizado_em timestamptz;

UPDATE public.validacao_email_job
SET progresso_atualizado_em = CASE
  WHEN status IN ('pendente', 'processando', 'sem_creditos', 'erro')
    THEN clock_timestamp()
  ELSE coalesce(concluido_em, iniciado_em, criado_em, clock_timestamp())
END
WHERE progresso_atualizado_em IS NULL;

ALTER TABLE public.validacao_email_job
  ALTER COLUMN progresso_atualizado_em SET DEFAULT clock_timestamp(),
  ALTER COLUMN progresso_atualizado_em SET NOT NULL;

CREATE OR REPLACE FUNCTION public.campaign_email_validation_quote(p_campaign_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=public,pg_catalog
AS $function$
  WITH pending AS MATERIALIZED (
    SELECT
      d.email AS raw_email,
      coalesce(public.normalize_email(d.email), '') AS normalized_email
    FROM public.destinatario d
    WHERE d.campanha_id = p_campaign_id
      AND d.is_lembrete = false
      AND d.status = 'pendente'
      AND d.excluido_em IS NULL
  ),
  classified AS MATERIALIZED (
    SELECT
      raw_email,
      normalized_email,
      (
        octet_length(normalized_email) = char_length(normalized_email)
        AND normalized_email !~ U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028-\2029\202F\205F\3000]'
        AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}$'
      ) AS safe_for_external_validation
    FROM pending
  ),
  eligible AS (
    SELECT DISTINCT normalized_email AS email
    FROM classified
    WHERE safe_for_external_validation
  ),
  cache_lookup AS (
    SELECT e.email, v.email AS cached_email, v.verificado_em
    FROM eligible e
    LEFT JOIN public.verificacao_email v ON v.email = e.email
  )
  SELECT jsonb_build_object(
    'pendentes', (SELECT count(*)::integer FROM pending),
    'cacheados', (
      SELECT count(*)::integer FROM cache_lookup WHERE cached_email IS NOT NULL
    ),
    'a_verificar', (
      SELECT count(*)::integer FROM eligible
    ) - (
      SELECT count(*)::integer FROM cache_lookup WHERE cached_email IS NOT NULL
    ),
    'formato_invalido', (
      SELECT count(DISTINCT coalesce(nullif(normalized_email, ''), raw_email))::integer
      FROM classified
      WHERE NOT safe_for_external_validation
    ),
    'cache_mais_antigo_em', (
      SELECT min(verificado_em)
      FROM cache_lookup
      WHERE cached_email IS NOT NULL
    )
  );
$function$;

REVOKE ALL ON FUNCTION public.campaign_email_validation_quote(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_email_validation_quote(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.retomar_job_validacao_email(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $function$
DECLARE
  v_ignored integer;
BEGIN
  UPDATE public.validacao_email_job
  SET status='pendente', erro=NULL, proxima_tentativa_em=now()
  WHERE id=p_job_id AND status IN ('sem_creditos','erro');
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.validacao_email_job_item
  SET status='ignorado',
      erro=coalesce(erro,'Ignorado após atingir o limite de três tentativas.'),
      proxima_tentativa_em=NULL
  WHERE job_id=p_job_id AND status='erro' AND tentativas>=3;
  GET DIAGNOSTICS v_ignored = ROW_COUNT;

  UPDATE public.validacao_email_job_item
  SET status='pendente', erro=NULL, proxima_tentativa_em=NULL
  WHERE job_id=p_job_id AND status='erro' AND tentativas<3;

  IF v_ignored>0 THEN
    UPDATE public.validacao_email_job
    SET processados=least(total_pendentes,processados+v_ignored),
        progresso_atualizado_em=CASE
          WHEN least(total_pendentes,processados+v_ignored)>processados
            THEN clock_timestamp()
          ELSE progresso_atualizado_em
        END
    WHERE id=p_job_id;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalizar_job_validacao_email(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $function$
DECLARE
  v_job public.validacao_email_job%ROWTYPE;
  v_catch_all text[];
  v_unknown text[];
  v_catch_result jsonb := '{}'::jsonb;
  v_unknown_result jsonb := '{}'::jsonb;
  v_counts jsonb;
  v_summary jsonb;
BEGIN
  SELECT * INTO v_job
  FROM public.validacao_email_job
  WHERE id=p_job_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'processando' THEN
    RAISE EXCEPTION 'validation_job_not_processing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.validacao_email_job_item
    WHERE job_id=p_job_id AND status IN ('pendente','erro')
  ) THEN
    RAISE EXCEPTION 'validation_job_items_incomplete';
  END IF;

  SELECT coalesce(array_agg(DISTINCT email_normalizado), '{}')
    INTO v_catch_all
  FROM public.validacao_email_job_item
  WHERE job_id=p_job_id AND status='validado'
    AND resultado_status='catch-all' AND email_normalizado IS NOT NULL;
  SELECT coalesce(array_agg(DISTINCT email_normalizado), '{}')
    INTO v_unknown
  FROM public.validacao_email_job_item
  WHERE job_id=p_job_id AND status='validado'
    AND resultado_status='unknown' AND email_normalizado IS NOT NULL;

  IF cardinality(v_catch_all)>0 THEN
    v_catch_result := public.change_campaign_exclusions(
      v_job.campanha_id, false, 'validacao: catch-all',
      v_job.criado_por_id, v_job.criado_por_nome, v_job.criado_por_email,
      '{}', v_catch_all, '{}', false
    );
  END IF;
  IF cardinality(v_unknown)>0 THEN
    v_unknown_result := public.change_campaign_exclusions(
      v_job.campanha_id, false, 'validacao: unknown',
      v_job.criado_por_id, v_job.criado_por_nome, v_job.criado_por_email,
      '{}', v_unknown, '{}', false
    );
  END IF;

  SELECT jsonb_build_object(
    'valid', count(*) FILTER (WHERE resultado_status='valid'),
    'invalid', count(*) FILTER (WHERE resultado_status='invalid'),
    'spamtrap', count(*) FILTER (WHERE resultado_status='spamtrap'),
    'abuse', count(*) FILTER (WHERE resultado_status='abuse'),
    'do_not_mail', count(*) FILTER (WHERE resultado_status='do_not_mail'),
    'catch_all', count(*) FILTER (WHERE resultado_status='catch-all'),
    'unknown', count(*) FILTER (WHERE resultado_status='unknown'),
    'formato_invalido', count(*) FILTER (WHERE status='formato_invalido'),
    'ignorado', count(*) FILTER (WHERE status='ignorado'),
    'itens', count(*)
  ) INTO v_counts
  FROM public.validacao_email_job_item
  WHERE job_id=p_job_id;

  v_summary := jsonb_build_object(
    'por_status', v_counts,
    'exclusoes_automaticas', jsonb_build_object(
      'catch_all', coalesce((v_catch_result->>'alterados')::integer,0),
      'unknown', coalesce((v_unknown_result->>'alterados')::integer,0)
    )
  );
  UPDATE public.validacao_email_job
  SET status='concluida',
      resultados=v_summary,
      erro=NULL,
      concluido_em=now(),
      processados=(v_counts->>'itens')::integer,
      progresso_atualizado_em=CASE
        WHEN (v_counts->>'itens')::integer>processados THEN clock_timestamp()
        ELSE progresso_atualizado_em
      END
  WHERE id=p_job_id;
  RETURN v_summary;
END;
$function$;

CREATE TEMP TABLE campaign_email_validation_quote_verification (
  campaign_id uuid NOT NULL,
  old_result jsonb NOT NULL,
  new_result jsonb NOT NULL,
  results_match boolean NOT NULL,
  old_sql_ms numeric NOT NULL,
  new_sql_ms numeric NOT NULL
) ON COMMIT DROP;

DO $verification$
DECLARE
  v_campaign_id uuid := '8141923e-e3b3-46fd-a59b-19dcf42d5336';
  v_old jsonb;
  v_new jsonb;
  v_started timestamptz;
  v_old_ms numeric;
  v_new_ms numeric;
BEGIN
  v_started := clock_timestamp();
  WITH pending AS MATERIALIZED (
    SELECT
      d.email AS raw_email,
      coalesce(public.normalize_email(d.email), '') AS normalized_email
    FROM public.destinatario d
    WHERE d.campanha_id = v_campaign_id
      AND d.is_lembrete = false
      AND d.status = 'pendente'
      AND d.excluido_em IS NULL
  ),
  classified AS MATERIALIZED (
    SELECT
      raw_email,
      normalized_email,
      (
        octet_length(normalized_email) = char_length(normalized_email)
        AND normalized_email !~ U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028-\2029\202F\205F\3000]'
        AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}$'
      ) AS safe_for_external_validation
    FROM pending
  ),
  eligible AS (
    SELECT DISTINCT normalized_email AS email
    FROM classified
    WHERE safe_for_external_validation
  ),
  cache_lookup AS (
    SELECT e.email, v.email AS cached_email, v.verificado_em
    FROM eligible e
    LEFT JOIN public.verificacao_email v ON v.email=e.email
  ),
  metrics AS (
    SELECT
      (SELECT count(*)::integer FROM pending) AS pendentes,
      (SELECT count(*)::integer FROM cache_lookup WHERE cached_email IS NOT NULL) AS cacheados,
      (SELECT count(*)::integer FROM eligible)
        - (SELECT count(*)::integer FROM cache_lookup WHERE cached_email IS NOT NULL) AS a_verificar,
      (
        SELECT count(DISTINCT coalesce(nullif(normalized_email, ''), raw_email))::integer
        FROM classified
        WHERE NOT safe_for_external_validation
      ) AS formato_invalido,
      (SELECT min(verificado_em) FROM cache_lookup WHERE cached_email IS NOT NULL)
        AS cache_mais_antigo_em
  )
  SELECT jsonb_build_object(
    'pendentes', pendentes,
    'cacheados', cacheados,
    'a_verificar', a_verificar,
    'formato_invalido', formato_invalido,
    'cache_mais_antigo_em', cache_mais_antigo_em
  ) INTO v_old
  FROM metrics;
  v_old_ms := extract(epoch FROM clock_timestamp()-v_started)*1000;

  v_started := clock_timestamp();
  SELECT public.campaign_email_validation_quote(v_campaign_id) INTO v_new;
  v_new_ms := extract(epoch FROM clock_timestamp()-v_started)*1000;

  INSERT INTO campaign_email_validation_quote_verification
    (campaign_id, old_result, new_result, results_match, old_sql_ms, new_sql_ms)
  VALUES
    (v_campaign_id, v_old, v_new, v_old=v_new, round(v_old_ms,2), round(v_new_ms,2));
END;
$verification$;

SELECT
  campaign_id,
  old_result,
  new_result,
  results_match,
  old_sql_ms,
  new_sql_ms,
  new_sql_ms < 300 AS new_sql_under_300ms
FROM campaign_email_validation_quote_verification;

-- Para apenas medir, substitua COMMIT por ROLLBACK antes de executar.
COMMIT;
