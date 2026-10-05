BEGIN;

CREATE TABLE IF NOT EXISTS public.verificacao_email (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('valid','invalid','catch-all','unknown','spamtrap','abuse','do_not_mail')
  ),
  sub_status text,
  free_email boolean,
  did_you_mean text,
  dominio text,
  smtp_provider text,
  mx_found boolean,
  resposta_bruta jsonb NOT NULL,
  verificado_em timestamptz NOT NULL DEFAULT now(),
  origem text
);
CREATE UNIQUE INDEX IF NOT EXISTS verificacao_email_email_uidx
  ON public.verificacao_email(email);
ALTER TABLE public.verificacao_email ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.validacao_email_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campanha_id uuid NOT NULL REFERENCES public.campanha(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','processando','sem_creditos','erro','concluida','cancelada')),
  total_pendentes integer NOT NULL DEFAULT 0,
  processados integer NOT NULL DEFAULT 0,
  custo_estimado integer NOT NULL DEFAULT 0,
  creditos_no_inicio integer NOT NULL DEFAULT 0,
  resultados jsonb NOT NULL DEFAULT '{}'::jsonb,
  erro text,
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  criado_por_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  criado_por_nome text,
  criado_por_email text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  iniciado_em timestamptz,
  concluido_em timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS validacao_email_job_ativa_campanha_uidx
  ON public.validacao_email_job(campanha_id)
  WHERE status IN ('pendente','processando','sem_creditos','erro');
CREATE INDEX IF NOT EXISTS validacao_email_job_fila_idx
  ON public.validacao_email_job(proxima_tentativa_em,criado_em)
  WHERE status='pendente';
ALTER TABLE public.validacao_email_job ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.validacao_email_job_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.validacao_email_job(id) ON DELETE CASCADE,
  destinatario_id uuid NOT NULL REFERENCES public.destinatario(id) ON DELETE CASCADE,
  email text NOT NULL,
  email_normalizado text,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','validado','formato_invalido','erro','ignorado')),
  resultado_status text,
  resposta_bruta jsonb,
  verificado_em timestamptz,
  erro text,
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,destinatario_id)
);
CREATE INDEX IF NOT EXISTS validacao_email_job_item_fila_idx
  ON public.validacao_email_job_item(job_id,status,proxima_tentativa_em,destinatario_id);
CREATE INDEX IF NOT EXISTS validacao_email_job_item_email_idx
  ON public.validacao_email_job_item(job_id,email_normalizado);
ALTER TABLE public.validacao_email_job_item ENABLE ROW LEVEL SECURITY;

-- A durable per-address lease prevents two worker processes from paying for
-- the same cache miss while their PostgREST requests use pooled connections.
CREATE TABLE IF NOT EXISTS public.verificacao_email_lease (
  email text PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.validacao_email_job(id) ON DELETE CASCADE,
  token uuid NOT NULL,
  expira_em timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS verificacao_email_lease_expiry_idx
  ON public.verificacao_email_lease(expira_em);
ALTER TABLE public.verificacao_email_lease ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.verificacao_email_api_chamada (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitada_em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS verificacao_email_api_chamada_horario_idx
  ON public.verificacao_email_api_chamada(solicitada_em);
ALTER TABLE public.verificacao_email_api_chamada ENABLE ROW LEVEL SECURITY;

-- The cache join in reservar_destinatarios relies on an exact normalized
-- address. Validate both invariants before enabling that direct indexed join.
ALTER TABLE public.destinatario
  ADD CONSTRAINT destinatario_email_ascii_check
  CHECK (email ~ '^[[:ascii:]]+$') NOT VALID;
ALTER TABLE public.destinatario
  VALIDATE CONSTRAINT destinatario_email_ascii_check;
ALTER TABLE public.destinatario
  VALIDATE CONSTRAINT destinatario_email_normalizado_check;

CREATE OR REPLACE FUNCTION public.guard_validacao_email_queue_changes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_campaign_ids uuid[];
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT array_agg(DISTINCT campanha_id ORDER BY campanha_id)
      INTO v_campaign_ids
    FROM new_rows;
  ELSIF TG_OP='DELETE' THEN
    SELECT array_agg(DISTINCT campanha_id ORDER BY campanha_id)
      INTO v_campaign_ids
    FROM old_rows;
  ELSE
    WITH changed AS (
      SELECT o.campanha_id AS old_campaign_id,
        n.campanha_id AS new_campaign_id
      FROM old_rows o
      JOIN new_rows n USING (id)
      WHERE (o.campanha_id,o.email,o.is_lembrete)
        IS DISTINCT FROM (n.campanha_id,n.email,n.is_lembrete)
    ), affected AS (
      SELECT old_campaign_id AS campanha_id FROM changed
      UNION ALL
      SELECT new_campaign_id AS campanha_id FROM changed
    )
    SELECT array_agg(DISTINCT campanha_id ORDER BY campanha_id)
      INTO v_campaign_ids
    FROM affected
    WHERE campanha_id IS NOT NULL;
  END IF;

  IF coalesce(cardinality(v_campaign_ids),0)=0 THEN
    RETURN NULL;
  END IF;

  -- Lock each affected campaign once per SQL statement, not once per
  -- recipient row. Stable ordering avoids deadlocks for multi-campaign writes.
  PERFORM 1
  FROM public.campanha
  WHERE id=ANY(v_campaign_ids)
  ORDER BY id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.validacao_email_job
    WHERE campanha_id=ANY(v_campaign_ids)
      AND status IN ('pendente','processando','sem_creditos','erro')
  ) THEN
    RAISE EXCEPTION 'email_validation_job_active';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS destinatario_guard_validacao_email_queue ON public.destinatario;
CREATE TRIGGER destinatario_guard_validacao_email_queue_insert
AFTER INSERT ON public.destinatario
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_validacao_email_queue_changes();
CREATE TRIGGER destinatario_guard_validacao_email_queue_delete
AFTER DELETE ON public.destinatario
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_validacao_email_queue_changes();
CREATE TRIGGER destinatario_guard_validacao_email_queue_update
AFTER UPDATE ON public.destinatario
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_validacao_email_queue_changes();

ALTER TABLE public.destinatario
  DROP CONSTRAINT IF EXISTS destinatario_status_check;
ALTER TABLE public.destinatario
  ADD CONSTRAINT destinatario_status_check
  CHECK (status IN (
    'pendente',
    'processando',
    'enviado',
    'entregue',
    'aberto',
    'clicado',
    'bounce',
    'erro',
    'suprimido',
    'bloqueado_modo_teste',
    'bloqueado_desengajado',
    'bloqueado_validacao_email'
  ));

CREATE OR REPLACE FUNCTION public.criar_job_validacao_email(
  p_campanha_id uuid,
  p_total_pendentes_esperado integer,
  p_custo_estimado integer,
  p_creditos_no_inicio integer,
  p_actor_id uuid,
  p_actor_nome text,
  p_actor_email text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_status text;
  v_total integer;
  v_job_id uuid;
BEGIN
  SELECT status INTO v_status
  FROM public.campanha WHERE id=p_campanha_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;
  IF v_status IN ('concluida','cancelada') THEN
    RAISE EXCEPTION 'campaign_finished';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.destinatario
    WHERE campanha_id=p_campanha_id AND is_lembrete=false
      AND status='processando'
  ) THEN
    RAISE EXCEPTION 'recipients_processing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.validacao_email_job
    WHERE campanha_id=p_campanha_id
      AND status IN ('pendente','processando','sem_creditos','erro')
  ) THEN
    RAISE EXCEPTION 'validation_job_active';
  END IF;

  INSERT INTO public.validacao_email_job(
    campanha_id,total_pendentes,custo_estimado,creditos_no_inicio,
    criado_por_id,criado_por_nome,criado_por_email
  ) VALUES (
    p_campanha_id,p_total_pendentes_esperado,p_custo_estimado,p_creditos_no_inicio,
    p_actor_id,p_actor_nome,p_actor_email
  ) RETURNING id INTO v_job_id;

  INSERT INTO public.validacao_email_job_item(job_id,destinatario_id,email)
  SELECT v_job_id,d.id,d.email
  FROM public.destinatario d
  WHERE d.campanha_id=p_campanha_id AND d.is_lembrete=false
    AND d.status='pendente' AND d.excluido_em IS NULL
  ORDER BY d.id;
  GET DIAGNOSTICS v_total = ROW_COUNT;
  IF v_total <> p_total_pendentes_esperado THEN
    RAISE EXCEPTION 'queue_changed';
  END IF;
  IF v_total = 0 THEN RAISE EXCEPTION 'empty_queue'; END IF;
  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_verificacao_email_batch(
  p_job_id uuid,p_emails text[],p_token uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_email text;
  v_claimed text[] := '{}';
  v_cached text[] := '{}';
  v_busy text[] := '{}';
  v_recent_calls integer;
BEGIN
  -- This transaction lock serializes cache/lease/rate-limit decisions even
  -- when separate HTTP requests are served by different pooled connections.
  PERFORM pg_advisory_xact_lock(8102714021::bigint);
  IF NOT EXISTS (
    SELECT 1 FROM public.validacao_email_job
    WHERE id=p_job_id AND status='processando'
  ) THEN
    RETURN jsonb_build_object('claimed','[]'::jsonb,'cached','[]'::jsonb,
      'busy','[]'::jsonb,'rate_limited',false);
  END IF;

  DELETE FROM public.verificacao_email_lease
  WHERE expira_em <= clock_timestamp();
  DELETE FROM public.verificacao_email_api_chamada
  WHERE solicitada_em < clock_timestamp() - interval '2 minutes';

  SELECT count(*) INTO v_recent_calls
  FROM public.verificacao_email_api_chamada
  WHERE solicitada_em > clock_timestamp() - interval '1 minute';
  IF v_recent_calls >= 30 THEN
    RETURN jsonb_build_object('claimed','[]'::jsonb,'cached','[]'::jsonb,
      'busy','[]'::jsonb,'rate_limited',true);
  END IF;

  FOR v_email IN
    SELECT DISTINCT candidate
    FROM unnest(coalesce(p_emails,'{}'::text[])) AS candidate
    ORDER BY candidate
  LOOP
    IF EXISTS (SELECT 1 FROM public.verificacao_email WHERE email=v_email) THEN
      v_cached := array_append(v_cached,v_email);
      CONTINUE;
    END IF;
    INSERT INTO public.verificacao_email_lease(email,job_id,token,expira_em)
    VALUES(v_email,p_job_id,p_token,clock_timestamp()+interval '3 minutes')
    ON CONFLICT(email) DO UPDATE
      SET job_id=EXCLUDED.job_id,token=EXCLUDED.token,expira_em=EXCLUDED.expira_em
      WHERE public.verificacao_email_lease.expira_em <= clock_timestamp();
    IF FOUND THEN
      v_claimed := array_append(v_claimed,v_email);
    ELSE
      v_busy := array_append(v_busy,v_email);
    END IF;
  END LOOP;

  IF cardinality(v_claimed)>0 THEN
    INSERT INTO public.verificacao_email_api_chamada DEFAULT VALUES;
  END IF;
  RETURN jsonb_build_object(
    'claimed',to_jsonb(v_claimed),
    'cached',to_jsonb(v_cached),
    'busy',to_jsonb(v_busy),
    'rate_limited',false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.liberar_verificacao_email_batch(p_token uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.verificacao_email_lease WHERE token=p_token;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.retomar_job_validacao_email(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_ignored integer;
BEGIN
  UPDATE public.validacao_email_job
  SET status='pendente',erro=NULL,proxima_tentativa_em=now()
  WHERE id=p_job_id AND status IN ('sem_creditos','erro');
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.validacao_email_job_item
  SET status='ignorado',
      erro=coalesce(erro,'Ignorado após atingir o limite de três tentativas.'),
      proxima_tentativa_em=NULL
  WHERE job_id=p_job_id AND status='erro' AND tentativas>=3;
  GET DIAGNOSTICS v_ignored = ROW_COUNT;

  UPDATE public.validacao_email_job_item
  SET status='pendente',erro=NULL,proxima_tentativa_em=NULL
  WHERE job_id=p_job_id AND status='erro' AND tentativas<3;

  IF v_ignored>0 THEN
    UPDATE public.validacao_email_job
    SET processados=least(total_pendentes,processados+v_ignored)
    WHERE id=p_job_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancelar_job_validacao_email(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.validacao_email_job
  SET status='cancelada',erro='Validação cancelada pela equipe.',proxima_tentativa_em=now()
  WHERE id=p_job_id
    AND status IN ('pendente','processando','sem_creditos','erro');
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM public.verificacao_email_lease WHERE job_id=p_job_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalizar_job_validacao_email(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_job public.validacao_email_job%ROWTYPE;
  v_catch_all text[];
  v_unknown text[];
  v_catch_result jsonb := '{}'::jsonb;
  v_unknown_result jsonb := '{}'::jsonb;
  v_counts jsonb;
  v_summary jsonb;
BEGIN
  SELECT * INTO v_job FROM public.validacao_email_job
  WHERE id=p_job_id FOR UPDATE;
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
      v_job.campanha_id,false,'validacao: catch-all',
      v_job.criado_por_id,v_job.criado_por_nome,v_job.criado_por_email,
      '{}',v_catch_all,'{}',false
    );
  END IF;
  IF cardinality(v_unknown)>0 THEN
    v_unknown_result := public.change_campaign_exclusions(
      v_job.campanha_id,false,'validacao: unknown',
      v_job.criado_por_id,v_job.criado_por_nome,v_job.criado_por_email,
      '{}',v_unknown,'{}',false
    );
  END IF;

  SELECT jsonb_build_object(
    'valid',count(*) FILTER (WHERE resultado_status='valid'),
    'invalid',count(*) FILTER (WHERE resultado_status='invalid'),
    'spamtrap',count(*) FILTER (WHERE resultado_status='spamtrap'),
    'abuse',count(*) FILTER (WHERE resultado_status='abuse'),
    'do_not_mail',count(*) FILTER (WHERE resultado_status='do_not_mail'),
    'catch_all',count(*) FILTER (WHERE resultado_status='catch-all'),
    'unknown',count(*) FILTER (WHERE resultado_status='unknown'),
    'formato_invalido',count(*) FILTER (WHERE status='formato_invalido'),
    'ignorado',count(*) FILTER (WHERE status='ignorado'),
    'itens',count(*)
  ) INTO v_counts
  FROM public.validacao_email_job_item WHERE job_id=p_job_id;

  v_summary := jsonb_build_object(
    'por_status',v_counts,
    'exclusoes_automaticas',jsonb_build_object(
      'catch_all',coalesce((v_catch_result->>'alterados')::integer,0),
      'unknown',coalesce((v_unknown_result->>'alterados')::integer,0)
    )
  );
  UPDATE public.validacao_email_job
  SET status='concluida',resultados=v_summary,erro=NULL,concluido_em=now(),
    processados=(v_counts->>'itens')::integer
  WHERE id=p_job_id;
  RETURN v_summary;
END;
$$;

CREATE OR REPLACE FUNCTION public.resumo_job_validacao_email(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT to_jsonb(j) || jsonb_build_object(
    'por_status',jsonb_build_object(
      'valid',count(*) FILTER (WHERE i.resultado_status='valid'),
      'invalid',count(*) FILTER (WHERE i.resultado_status='invalid'),
      'spamtrap',count(*) FILTER (WHERE i.resultado_status='spamtrap'),
      'abuse',count(*) FILTER (WHERE i.resultado_status='abuse'),
      'do_not_mail',count(*) FILTER (WHERE i.resultado_status='do_not_mail'),
      'catch_all',count(*) FILTER (WHERE i.resultado_status='catch-all'),
      'unknown',count(*) FILTER (WHERE i.resultado_status='unknown'),
      'formato_invalido',count(*) FILTER (WHERE i.status='formato_invalido'),
      'erro',count(*) FILTER (WHERE i.status='erro'),
      'pendente',count(*) FILTER (WHERE i.status='pendente'),
      'ignorado',count(*) FILTER (WHERE i.status='ignorado')
    ),
    'exclusoes_automaticas',coalesce(
      j.resultados->'exclusoes_automaticas',
      jsonb_build_object('catch_all',0,'unknown',0)
    )
  )
  FROM public.validacao_email_job j
  LEFT JOIN public.validacao_email_job_item i ON i.job_id=j.id
  WHERE j.id=p_job_id
  GROUP BY j.id
$$;

CREATE OR REPLACE FUNCTION public.reservar_destinatarios(
  p_campanha_id uuid,p_limite integer DEFAULT 100,p_is_lembrete boolean DEFAULT false
) RETURNS SETOF public.destinatario
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM public.campanha c WHERE c.id=p_campanha_id
    AND c.status=CASE WHEN p_is_lembrete THEN 'concluida' ELSE 'enviando' END
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM public.validacao_email_job j
    WHERE j.campanha_id=p_campanha_id
      AND j.status IN ('pendente','processando','sem_creditos','erro')
  ) THEN
    RETURN;
  END IF;

  -- The cache column is compared directly with the normalized recipient
  -- value so PostgreSQL can use verificacao_email_email_uidx for this join.
  UPDATE public.destinatario d
  SET status='bloqueado_validacao_email',
      processando_em=NULL,
      erro='Bloqueado pela validação de e-mail (' || v.status || ').'
  FROM public.verificacao_email v
  WHERE d.campanha_id=p_campanha_id
    AND d.is_lembrete=p_is_lembrete
    AND d.status='pendente'
    AND d.excluido_em IS NULL
    AND v.email=d.email
    AND v.status IN ('invalid','spamtrap','abuse','do_not_mail');

  RETURN QUERY WITH locked AS (
    SELECT d.id FROM public.destinatario d
    WHERE d.campanha_id=p_campanha_id
      AND d.is_lembrete=p_is_lembrete
      AND d.status='pendente'
      AND d.excluido_em IS NULL
    ORDER BY d.data_ultima_compra DESC NULLS LAST,d.id
    LIMIT greatest(1,least(p_limite,100)) FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.destinatario d SET status='processando',
      tentativas=d.tentativas+1,processando_em=now(),erro=NULL
    FROM locked WHERE d.id=locked.id RETURNING d.*
  ) SELECT * FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_campaign_if_queue_empty(p_campanha_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM public.campanha WHERE id=p_campanha_id AND status='enviando' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public.validacao_email_job
    WHERE campanha_id=p_campanha_id
      AND status IN ('pendente','processando','sem_creditos','erro')
  ) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public.destinatario WHERE campanha_id=p_campanha_id
      AND is_lembrete=false AND excluido_em IS NULL
      AND status IN ('pendente','processando')
  ) THEN RETURN false; END IF;
  UPDATE public.campanha SET status='concluida' WHERE id=p_campanha_id;
  RETURN true;
END;
$$;

-- Reminders copy existing recipients, but clean ASCII controls as well so
-- this second recipient-insert path always persists a normalized address.
CREATE OR REPLACE FUNCTION public.enqueue_campaign_reminders(
  p_campaign_id uuid,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_campaign_id::text, 0));

  WITH candidates AS (
    SELECT d.*,
      regexp_replace(lower(btrim(d.email)), '[[:cntrl:]]', '', 'g') AS normalized_email
    FROM public.destinatario d
    JOIN public.campanha c ON c.id=d.campanha_id
    WHERE d.campanha_id=p_campaign_id
      AND nullif(btrim(c.assunto_lembrete), '') IS NOT NULL
      AND btrim(c.assunto_lembrete) <> btrim(c.assunto)
      AND CASE
        WHEN jsonb_typeof(c.corpo_lembrete)='array'
          THEN jsonb_array_length(c.corpo_lembrete)>0
        ELSE false
      END
      AND d.is_lembrete=false
      AND d.status='entregue'
      AND d.entregue_em IS NOT NULL
      AND d.entregue_em <= now() - make_interval(hours => c.lembrete_horas)
      AND d.aberto_em IS NULL
      AND d.clicado_em IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.destinatario r
        WHERE r.campanha_id=d.campanha_id
          AND r.is_lembrete=true
          AND r.email=regexp_replace(lower(btrim(d.email)), '[[:cntrl:]]', '', 'g')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.supressao s
        WHERE s.email IS NOT NULL
          AND s.email=regexp_replace(lower(btrim(d.email)), '[[:cntrl:]]', '', 'g')
      )
      AND (
        c.incluir_desengajados
        OR NOT EXISTS (
          SELECT 1
          FROM public.contato_desengajamento cd
          WHERE cd.email=regexp_replace(lower(btrim(d.email)), '[[:cntrl:]]', '', 'g')
            AND cd.desengajado_cronico=true
        )
      )
    ORDER BY d.data_ultima_compra DESC NULLS LAST,d.id
    LIMIT p_limit
  ),
  inserted AS (
    INSERT INTO public.destinatario(
      campanha_id,id_usuario,nome,email,telefone,regiao,
      data_ultima_compra,is_lembrete,status
    )
    SELECT campanha_id,id_usuario,nome,normalized_email,telefone,regiao,
      data_ultima_compra,true,'pendente'
    FROM candidates
    RETURNING id
  )
  SELECT count(*) INTO v_inserted FROM inserted;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON public.verificacao_email,public.validacao_email_job,
  public.validacao_email_job_item,public.verificacao_email_lease,
  public.verificacao_email_api_chamada FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.criar_job_validacao_email(uuid,integer,integer,integer,uuid,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_verificacao_email_batch(uuid,text[],uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.liberar_verificacao_email_batch(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retomar_job_validacao_email(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cancelar_job_validacao_email(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finalizar_job_validacao_email(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.resumo_job_validacao_email(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.guard_validacao_email_queue_changes()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reservar_destinatarios(uuid,integer,boolean)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_campaign_if_queue_empty(uuid)
  FROM PUBLIC,anon,authenticated;

GRANT ALL ON public.verificacao_email,public.validacao_email_job,
  public.validacao_email_job_item,public.verificacao_email_lease,
  public.verificacao_email_api_chamada TO service_role;
GRANT EXECUTE ON FUNCTION public.criar_job_validacao_email(uuid,integer,integer,integer,uuid,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_verificacao_email_batch(uuid,text[],uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.liberar_verificacao_email_batch(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retomar_job_validacao_email(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancelar_job_validacao_email(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalizar_job_validacao_email(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resumo_job_validacao_email(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_validacao_email_queue_changes()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reservar_destinatarios(uuid,integer,boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_campaign_if_queue_empty(uuid)
  TO service_role;

COMMIT;
