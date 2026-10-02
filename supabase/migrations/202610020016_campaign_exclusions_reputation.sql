-- Aplicação MANUAL. Não envia mensagens nem modifica supressao.
BEGIN;
ALTER TABLE public.destinatario
  ADD COLUMN IF NOT EXISTS excluido_em timestamptz,
  ADD COLUMN IF NOT EXISTS exclusao_motivo text,
  ADD COLUMN IF NOT EXISTS excluido_por_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excluido_por_nome text,
  ADD COLUMN IF NOT EXISTS excluido_por_email text,
  ADD COLUMN IF NOT EXISTS ultimo_soft_bounce_em timestamptz;
ALTER TABLE public.campanha
  ADD COLUMN IF NOT EXISTS retomada_em timestamptz,
  ADD COLUMN IF NOT EXISTS retomada_enviados_base integer,
  ADD COLUMN IF NOT EXISTS retomado_por_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retomado_por_nome text,
  ADD COLUMN IF NOT EXISTS retomado_por_email text;
CREATE INDEX IF NOT EXISTS destinatario_nao_excluido_campanha_idx
  ON public.destinatario(campanha_id) WHERE excluido_em IS NULL;
CREATE INDEX IF NOT EXISTS destinatario_fila_ativa_idx
  ON public.destinatario(campanha_id,is_lembrete,data_ultima_compra DESC NULLS LAST,id)
  WHERE excluido_em IS NULL AND status = 'pendente';
CREATE INDEX IF NOT EXISTS destinatario_reputacao_periodo_idx
  ON public.destinatario(campanha_id,enviado_em,id) WHERE is_lembrete = false;

CREATE OR REPLACE FUNCTION public.email_provider(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN split_part(lower(btrim(p_email)), '@', 2) IN ('gmail.com','googlemail.com') THEN 'gmail'
    WHEN split_part(lower(btrim(p_email)), '@', 2) ~ '^(hotmail|outlook|live|msn)\.' THEN 'microsoft'
    WHEN split_part(lower(btrim(p_email)), '@', 2) ~ '^(yahoo|ymail|rocketmail)\.' THEN 'yahoo'
    ELSE 'outros' END;
$$;

-- Event flags belong to the exact main send, never a reminder or another
-- campaign. EXISTS prevents repeated webhooks from inflating numerators.
CREATE OR REPLACE FUNCTION public.campaign_reputation_counts(
  p_campanha_id uuid, p_desde timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH cohort AS (
    SELECT d.* FROM public.destinatario d
    WHERE d.campanha_id = p_campanha_id AND d.is_lembrete = false
      AND d.enviado_em IS NOT NULL
      AND (p_desde IS NULL OR d.enviado_em > p_desde)
  )
  SELECT jsonb_build_object(
    'enviados', count(*),
    'entregues', count(*) FILTER (WHERE d.entregue_em IS NOT NULL),
    'bounces_permanentes', count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.evento_email e WHERE
        (e.destinatario_id = d.id OR e.resend_email_id = d.resend_email_id)
        AND e.tipo = 'email.bounced' AND e.bounce_permanente = true
    )),
    'reclamacoes', count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.evento_email e WHERE
        (e.destinatario_id = d.id OR e.resend_email_id = d.resend_email_id)
        AND e.tipo = 'email.complained'
    ))
  ) FROM cohort d;
$$;

CREATE OR REPLACE FUNCTION public.campaign_provider_diagnostics(p_campanha_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH flags AS (
    SELECT d.*, public.email_provider(d.email) AS provider,
      EXISTS (SELECT 1 FROM public.evento_email e WHERE
        (e.destinatario_id = d.id OR e.resend_email_id = d.resend_email_id)
        AND e.tipo = 'email.bounced') AS bounced,
      EXISTS (SELECT 1 FROM public.evento_email e WHERE
        (e.destinatario_id = d.id OR e.resend_email_id = d.resend_email_id)
        AND e.tipo = 'email.bounced' AND e.bounce_permanente = true) AS hard
    FROM public.destinatario d WHERE d.campanha_id = p_campanha_id AND d.is_lembrete = false
  ), grouped AS (
    SELECT p.provider AS provedor, count(d.id) AS total,
      count(d.id) FILTER (WHERE d.status = 'pendente' AND d.excluido_em IS NULL) AS pendentes,
      count(d.id) FILTER (WHERE d.excluido_em IS NOT NULL) AS excluidos,
      count(d.id) FILTER (WHERE d.enviado_em IS NOT NULL) AS enviados,
      count(d.id) FILTER (WHERE d.entregue_em IS NOT NULL) AS entregues,
      count(d.id) FILTER (WHERE d.enviado_em IS NOT NULL AND d.bounced) AS bounces,
      count(d.id) FILTER (WHERE d.enviado_em IS NOT NULL AND d.hard) AS bounces_permanentes
    FROM (VALUES ('gmail'),('microsoft'),('yahoo'),('outros')) p(provider)
    LEFT JOIN flags d ON d.provider = p.provider GROUP BY p.provider
  )
  SELECT jsonb_agg(to_jsonb(g) || jsonb_build_object(
    'taxa_bounce', coalesce(g.bounces::numeric / nullif(g.enviados,0),0),
    'taxa_bounce_permanente', coalesce(g.bounces_permanentes::numeric / nullif(g.enviados,0),0)
  ) ORDER BY g.provedor) FROM grouped g;
$$;

CREATE OR REPLACE FUNCTION public.change_campaign_exclusions(
  p_campanha_id uuid, p_restore boolean, p_motivo text,
  p_actor_id uuid, p_actor_nome text, p_actor_email text,
  p_provedores text[] DEFAULT '{}', p_emails text[] DEFAULT '{}',
  p_ids uuid[] DEFAULT '{}', p_todos boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
  v_main integer;
  v_reminder integer;
  v_processing integer;
  v_processed integer;
  v_missing integer;
  v_result jsonb;
BEGIN
  SELECT status INTO v_status FROM public.campanha WHERE id = p_campanha_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;
  IF v_status IN ('concluida','cancelada') THEN RAISE EXCEPTION 'campaign_finished'; END IF;
  IF NOT p_restore AND (nullif(btrim(p_motivo),'') IS NULL OR length(p_motivo)>500) THEN
    RAISE EXCEPTION 'exclusion_reason_required';
  END IF;
  IF NOT p_restore AND cardinality(p_provedores)=0 AND cardinality(p_emails)=0 THEN
    RAISE EXCEPTION 'exclusion_selection_required';
  END IF;
  IF p_restore AND NOT p_todos AND cardinality(p_ids)=0 THEN
    RAISE EXCEPTION 'restoration_selection_required';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_provedores) p WHERE p NOT IN ('gmail','microsoft','yahoo','outros')) THEN
    RAISE EXCEPTION 'invalid_provider';
  END IF;
  WITH locked AS (
    SELECT d.id FROM public.destinatario d WHERE d.campanha_id = p_campanha_id
      AND d.status = 'pendente'
      AND CASE WHEN p_restore THEN
        d.excluido_em IS NOT NULL AND (p_todos OR d.id = ANY(p_ids)
          OR d.email IN (SELECT x.email FROM public.destinatario x WHERE x.id = ANY(p_ids)
            AND x.campanha_id = p_campanha_id AND x.is_lembrete = false AND x.excluido_em IS NOT NULL))
      ELSE d.excluido_em IS NULL AND
        (public.email_provider(d.email)=ANY(p_provedores) OR lower(btrim(d.email))=ANY(p_emails)) END
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.destinatario d SET
      excluido_em = CASE WHEN p_restore THEN NULL ELSE clock_timestamp() END,
      exclusao_motivo = CASE WHEN p_restore THEN NULL ELSE btrim(p_motivo) END,
      excluido_por_id = CASE WHEN p_restore THEN NULL ELSE p_actor_id END,
      excluido_por_nome = CASE WHEN p_restore THEN NULL ELSE p_actor_nome END,
      excluido_por_email = CASE WHEN p_restore THEN NULL ELSE p_actor_email END
    FROM locked WHERE d.id = locked.id RETURNING d.is_lembrete
  )
  SELECT count(*) FILTER (WHERE NOT is_lembrete), count(*) FILTER (WHERE is_lembrete)
    INTO v_main,v_reminder FROM changed;
  SELECT
    count(*) FILTER (WHERE d.status='processando'),
    count(*) FILTER (WHERE d.status NOT IN ('pendente','processando'))
    INTO v_processing,v_processed FROM public.destinatario d
    WHERE d.campanha_id=p_campanha_id AND d.is_lembrete=false
      AND (public.email_provider(d.email)=ANY(p_provedores) OR lower(btrim(d.email))=ANY(p_emails));
  SELECT count(*) INTO v_missing FROM unnest(p_emails) e WHERE NOT EXISTS (
    SELECT 1 FROM public.destinatario d WHERE d.campanha_id=p_campanha_id
      AND d.is_lembrete=false AND lower(btrim(d.email))=e
  );
  v_result := jsonb_build_object('alterados',v_main,'lembretes_alterados',v_reminder,
    'em_processamento',v_processing,'ja_processados',v_processed,'nao_encontrados',v_missing);
  INSERT INTO public.evento_auditoria(actor_user_id,actor_name,actor_email,action,entity_type,entity_id,metadata)
  VALUES(p_actor_id,p_actor_nome,p_actor_email,
    CASE WHEN p_restore THEN 'campaign_recipients_restored' ELSE 'campaign_recipients_excluded' END,
    'campaign',p_campanha_id,v_result || jsonb_build_object('motivo',p_motivo,
      'provedores',to_jsonb(p_provedores),'origem',CASE WHEN cardinality(p_emails)>0 THEN 'lista' ELSE 'provedor' END));
  RETURN v_result;
END;
$$;

-- A pause/resume and its audit record succeed or roll back together.
CREATE OR REPLACE FUNCTION public.transition_campaign_with_audit(
  p_campanha_id uuid, p_expected text, p_target text,
  p_actor_id uuid, p_actor_nome text, p_actor_email text,
  p_motivo text DEFAULT NULL, p_bounce numeric DEFAULT NULL,
  p_reclamacao numeric DEFAULT NULL, p_metadata jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.campanha%ROWTYPE; v_now timestamptz := clock_timestamp(); v_base integer;
BEGIN
  SELECT * INTO v_row FROM public.campanha WHERE id=p_campanha_id FOR UPDATE;
  IF NOT FOUND OR v_row.status<>p_expected THEN RETURN NULL; END IF;
  IF NOT ((p_target='pausada' AND p_expected='enviando') OR
    (p_target='enviando' AND p_expected='pausada')) THEN RAISE EXCEPTION 'invalid_transition'; END IF;
  SELECT count(*) INTO v_base FROM public.destinatario
    WHERE campanha_id=p_campanha_id AND NOT is_lembrete AND enviado_em IS NOT NULL;
  UPDATE public.campanha SET status=p_target,
    pausa_motivo=CASE WHEN p_target='pausada' THEN p_motivo ELSE NULL END,
    pausa_taxa_bounce=CASE WHEN p_target='pausada' THEN p_bounce ELSE NULL END,
    pausa_taxa_reclamacao=CASE WHEN p_target='pausada' THEN p_reclamacao ELSE NULL END,
    pausada_em=CASE WHEN p_target='pausada' THEN v_now ELSE NULL END,
    pausado_por_id=CASE WHEN p_target='pausada' THEN p_actor_id ELSE pausado_por_id END,
    pausado_por_nome=CASE WHEN p_target='pausada' THEN p_actor_nome ELSE pausado_por_nome END,
    pausado_por_email=CASE WHEN p_target='pausada' THEN p_actor_email ELSE pausado_por_email END,
    retomada_em=CASE WHEN p_target='enviando' THEN v_now ELSE retomada_em END,
    retomada_enviados_base=CASE WHEN p_target='enviando' THEN v_base ELSE retomada_enviados_base END,
    retomado_por_id=CASE WHEN p_target='enviando' THEN p_actor_id ELSE retomado_por_id END,
    retomado_por_nome=CASE WHEN p_target='enviando' THEN p_actor_nome ELSE retomado_por_nome END,
    retomado_por_email=CASE WHEN p_target='enviando' THEN p_actor_email ELSE retomado_por_email END
    WHERE id=p_campanha_id RETURNING * INTO v_row;
  INSERT INTO public.evento_auditoria(actor_user_id,actor_name,actor_email,action,entity_type,entity_id,metadata)
  VALUES(p_actor_id,p_actor_nome,p_actor_email,
    CASE WHEN p_target='enviando' THEN 'campaign_resumed'
      WHEN p_actor_id IS NULL THEN 'campaign_auto_paused' ELSE 'campaign_paused' END,
    'campaign',p_campanha_id,p_metadata || jsonb_build_object('from_status',p_expected,
      'to_status',p_target,'bounce_rate',p_bounce,'complaint_rate',p_reclamacao,
      'reason',p_motivo,'retomada_em',v_row.retomada_em,'retomada_enviados_base',v_row.retomada_enviados_base));
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.reservar_destinatarios(
  p_campanha_id uuid,p_limite integer DEFAULT 100,p_is_lembrete boolean DEFAULT false
) RETURNS SETOF public.destinatario LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  -- Serializes queue reservation against exclusion/restore/completion.
  PERFORM 1 FROM public.campanha c WHERE c.id=p_campanha_id
    AND c.status=CASE WHEN p_is_lembrete THEN 'concluida' ELSE 'enviando' END FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY WITH locked AS (
    SELECT d.id FROM public.destinatario d WHERE d.campanha_id=p_campanha_id
      AND d.is_lembrete=p_is_lembrete AND d.status='pendente' AND d.excluido_em IS NULL
    ORDER BY d.data_ultima_compra DESC NULLS LAST,d.id
    LIMIT greatest(1,least(p_limite,100)) FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.destinatario d SET status='processando',tentativas=d.tentativas+1,
      processando_em=now(),erro=NULL FROM locked WHERE d.id=locked.id RETURNING d.*
  ) SELECT * FROM claimed;
END;
$$;
CREATE OR REPLACE FUNCTION public.complete_campaign_if_queue_empty(p_campanha_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM public.campanha WHERE id=p_campanha_id AND status='enviando' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.destinatario WHERE campanha_id=p_campanha_id
    AND is_lembrete=false AND excluido_em IS NULL AND status IN ('pendente','processando')) THEN RETURN false; END IF;
  UPDATE public.campanha SET status='concluida' WHERE id=p_campanha_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_campaign_if_queue_empty(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_campaign_if_queue_empty(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.email_provider(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_reputation_counts(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_provider_diagnostics(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.change_campaign_exclusions(uuid,boolean,text,uuid,text,text,text[],text[],uuid[],boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.transition_campaign_with_audit(uuid,text,text,uuid,text,text,text,numeric,numeric,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reservar_destinatarios(uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.email_provider(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_reputation_counts(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_provider_diagnostics(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.change_campaign_exclusions(uuid,boolean,text,uuid,text,text,text[],text[],uuid[],boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_campaign_with_audit(uuid,text,text,uuid,text,text,text,numeric,numeric,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reservar_destinatarios(uuid,integer,boolean) TO service_role;
COMMIT;