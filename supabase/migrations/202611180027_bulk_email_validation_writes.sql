BEGIN;

CREATE OR REPLACE FUNCTION public.persist_validacao_email_batch(
  p_job_id uuid,
  p_cache_rows jsonb,
  p_item_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_catalog
AS $function$
DECLARE
  v_job_processing boolean := false;
  v_updated_items integer := 0;
  v_processed_items integer := 0;
  v_cache_rows jsonb := coalesce(p_cache_rows, '[]'::jsonb);
  v_item_updates jsonb := coalesce(p_item_updates, '[]'::jsonb);
BEGIN
  IF jsonb_typeof(v_cache_rows) <> 'array' THEN
    RAISE EXCEPTION 'email_validation_cache_rows_must_be_array';
  END IF;
  IF jsonb_typeof(v_item_updates) <> 'array' THEN
    RAISE EXCEPTION 'email_validation_item_updates_must_be_array';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_item_updates) AS entry(value)
    WHERE jsonb_typeof(entry.value) <> 'object'
       OR NOT (entry.value ? 'id')
  ) THEN
    RAISE EXCEPTION 'email_validation_item_update_requires_id';
  END IF;

  INSERT INTO public.verificacao_email(
    email,status,sub_status,free_email,did_you_mean,dominio,smtp_provider,
    mx_found,resposta_bruta,verificado_em,origem
  )
  SELECT
    row.email,row.status,row.sub_status,row.free_email,row.did_you_mean,
    row.dominio,row.smtp_provider,row.mx_found,row.resposta_bruta,
    row.verificado_em,row.origem
  FROM jsonb_to_recordset(v_cache_rows) AS row(
    email text,
    status text,
    sub_status text,
    free_email boolean,
    did_you_mean text,
    dominio text,
    smtp_provider text,
    mx_found boolean,
    resposta_bruta jsonb,
    verificado_em timestamptz,
    origem text
  )
  ON CONFLICT (email) DO NOTHING;

  SELECT coalesce(bool_or(job.status='processando'),false)
  INTO v_job_processing
  FROM public.validacao_email_job AS job
  WHERE job.id=p_job_id;

  IF NOT v_job_processing THEN
    RETURN jsonb_build_object(
      'job_processing',false,
      'updated_items',0,
      'processed_items',0
    );
  END IF;

  WITH source AS (
    SELECT entry.value AS patch
    FROM jsonb_array_elements(v_item_updates) AS entry(value)
  ),
  updated AS (
    UPDATE public.validacao_email_job_item AS item
    SET
      status = CASE WHEN source.patch ? 'status'
        THEN source.patch->>'status' ELSE item.status END,
      email_normalizado = CASE WHEN source.patch ? 'email_normalizado'
        THEN source.patch->>'email_normalizado' ELSE item.email_normalizado END,
      resultado_status = CASE WHEN source.patch ? 'resultado_status'
        THEN source.patch->>'resultado_status' ELSE item.resultado_status END,
      resposta_bruta = CASE WHEN source.patch ? 'resposta_bruta'
        THEN source.patch->'resposta_bruta' ELSE item.resposta_bruta END,
      verificado_em = CASE WHEN source.patch ? 'verificado_em'
        THEN nullif(source.patch->>'verificado_em','')::timestamptz
        ELSE item.verificado_em END,
      erro = CASE WHEN source.patch ? 'erro'
        THEN source.patch->>'erro' ELSE item.erro END,
      tentativas = CASE WHEN source.patch ? 'tentativas'
        THEN (source.patch->>'tentativas')::integer ELSE item.tentativas END,
      proxima_tentativa_em = CASE WHEN source.patch ? 'proxima_tentativa_em'
        THEN nullif(source.patch->>'proxima_tentativa_em','')::timestamptz
        ELSE item.proxima_tentativa_em END
    FROM source
    WHERE item.id=(source.patch->>'id')::uuid
      AND item.job_id=p_job_id
      AND item.status='pendente'
    RETURNING item.status
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE updated.status IN ('validado','formato_invalido'))::integer
  INTO v_updated_items,v_processed_items
  FROM updated;

  RETURN jsonb_build_object(
    'job_processing',true,
    'updated_items',v_updated_items,
    'processed_items',v_processed_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_validacao_email_batch(uuid,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_validacao_email_batch(uuid,jsonb,jsonb)
  TO service_role;

COMMIT;
