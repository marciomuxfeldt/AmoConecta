BEGIN;

CREATE OR REPLACE FUNCTION public.correct_campaign_recipient_domain(
  p_campaign_id uuid,
  p_original_email text,
  p_corrected_email text,
  p_actor_id uuid,
  p_actor_name text,
  p_actor_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_campaign_status text;
  v_recipient public.destinatario%ROWTYPE;
  v_cache_status text;
  v_suppressed boolean;
BEGIN
  SELECT status INTO v_campaign_status
  FROM public.campanha WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;
  IF v_campaign_status IN ('concluida','cancelada') THEN
    RAISE EXCEPTION 'campaign_finished';
  END IF;
  IF p_original_email IS NULL OR p_corrected_email IS NULL
     OR public.normalize_email(p_original_email) <> p_original_email
     OR public.normalize_email(p_corrected_email) <> p_corrected_email
     OR p_corrected_email !~ '^[\x21-\x7E]+$'
     OR p_corrected_email ~ '[[:space:]]'
     OR p_corrected_email !~ '^[^@]+@[^@]+\.[^@]+$'
     OR split_part(p_original_email, '@', 1) <> split_part(p_corrected_email, '@', 1)
     OR split_part(p_original_email, '@', 2) = split_part(p_corrected_email, '@', 2) THEN
    RAISE EXCEPTION 'invalid_correction';
  END IF;

  SELECT * INTO v_recipient
  FROM public.destinatario
  WHERE campanha_id=p_campaign_id AND is_lembrete=false
    AND email=p_original_email
  FOR UPDATE;
  IF NOT FOUND OR v_recipient.status <> 'pendente' OR v_recipient.excluido_em IS NOT NULL THEN
    RAISE EXCEPTION 'recipient_not_correctable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.destinatario
    WHERE campanha_id=p_campaign_id AND is_lembrete=false
      AND email=p_corrected_email AND id<>v_recipient.id
  ) THEN
    INSERT INTO public.evento_auditoria(
      actor_user_id,actor_name,actor_email,action,entity_type,entity_id,metadata
    ) VALUES (
      p_actor_id,p_actor_name,p_actor_email,'campaign_recipient_domain_correction_duplicate',
      'campaign',p_campaign_id,jsonb_build_object(
        'recipient_id',v_recipient.id,'email_original',p_original_email,
        'email_corrigido',p_corrected_email,'resultado','destinatario_removido_duplicado'
      )
    );
    UPDATE public.destinatario
    SET excluido_em=clock_timestamp(),
        exclusao_motivo='duplicado apos correcao de dominio',
        excluido_por_id=p_actor_id,
        excluido_por_nome=p_actor_name,
        excluido_por_email=p_actor_email
    WHERE id=v_recipient.id;
    RETURN jsonb_build_object('resultado','duplicado_removido','email',p_corrected_email);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.supressao
    WHERE lower(btrim(email))=p_corrected_email
  ) INTO v_suppressed;
  SELECT status INTO v_cache_status
  FROM public.verificacao_email WHERE email=p_corrected_email;

  UPDATE public.destinatario
  SET email=p_corrected_email,
      status=CASE
        WHEN v_suppressed THEN 'suprimido'
        WHEN v_cache_status IN ('invalid','spamtrap','abuse','do_not_mail')
          THEN 'bloqueado_validacao_email'
        ELSE 'pendente'
      END
  WHERE id=v_recipient.id;

  INSERT INTO public.evento_auditoria(
    actor_user_id,actor_name,actor_email,action,entity_type,entity_id,metadata
  ) VALUES (
    p_actor_id,p_actor_name,p_actor_email,'campaign_recipient_domain_corrected',
    'campaign',p_campaign_id,jsonb_build_object(
      'recipient_id',v_recipient.id,'email_original',p_original_email,
      'email_corrigido',p_corrected_email,'cache_verificacao',v_cache_status,
      'suprimido',v_suppressed
    )
  );
  RETURN jsonb_build_object(
    'resultado',CASE WHEN v_suppressed THEN 'suprimido'
      WHEN v_cache_status IN ('invalid','spamtrap','abuse','do_not_mail') THEN 'bloqueado'
      WHEN v_cache_status IS NULL THEN 'nao_verificado'
      ELSE 'corrigido' END,
    'email',p_corrected_email,'cache_status',v_cache_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_campaign_recipient_domain(uuid,text,text,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_campaign_recipient_domain(uuid,text,text,uuid,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.criar_validacao_unitaria_destinatario(
  p_campaign_id uuid,
  p_email text,
  p_creditos integer,
  p_actor_id uuid,
  p_actor_name text,
  p_actor_email text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_job_id uuid;
  v_recipient public.destinatario%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.campanha WHERE id=p_campaign_id
    AND status NOT IN ('concluida','cancelada') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_finished'; END IF;
  SELECT * INTO v_recipient FROM public.destinatario
    WHERE campanha_id=p_campaign_id AND is_lembrete=false
      AND email=p_email AND status='pendente' AND excluido_em IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recipient_not_pending'; END IF;
  IF p_creditos < 1 THEN RAISE EXCEPTION 'insufficient_credits'; END IF;
  IF EXISTS (SELECT 1 FROM public.validacao_email_job
    WHERE campanha_id=p_campaign_id
      AND status IN ('pendente','processando','sem_creditos','erro')) THEN
    RAISE EXCEPTION 'validation_job_active';
  END IF;
  IF EXISTS (SELECT 1 FROM public.verificacao_email WHERE email=p_email) THEN
    RAISE EXCEPTION 'already_cached';
  END IF;
  INSERT INTO public.validacao_email_job(
    campanha_id,total_pendentes,custo_estimado,creditos_no_inicio,
    criado_por_id,criado_por_nome,criado_por_email
  ) VALUES (p_campaign_id,1,1,p_creditos,p_actor_id,p_actor_name,p_actor_email)
  RETURNING id INTO v_job_id;
  INSERT INTO public.validacao_email_job_item(job_id,destinatario_id,email,email_normalizado)
  VALUES (v_job_id,v_recipient.id,p_email,p_email);
  INSERT INTO public.evento_auditoria(
    actor_user_id,actor_name,actor_email,action,entity_type,entity_id,metadata
  ) VALUES (
    p_actor_id,p_actor_name,p_actor_email,'campaign_email_validation_single_started',
    'campaign',p_campaign_id,jsonb_build_object(
      'job_id',v_job_id,'recipient_id',v_recipient.id,'email',p_email,'custo',1
    )
  );
  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.criar_validacao_unitaria_destinatario(uuid,text,integer,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_validacao_unitaria_destinatario(uuid,text,integer,uuid,text,text)
  TO service_role;

COMMIT;
