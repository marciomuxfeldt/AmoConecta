-- Aplicação MANUAL após 016 e 017. Não envia nem retoma campanhas.
-- Não altera a recepção/assinatura dos webhooks ou o status de destinatários
-- sem correspondência. Conserva o payload e separa ignorados de erros técnicos.
BEGIN;
ALTER TABLE public.evento_email
  ADD COLUMN IF NOT EXISTS motivo_nao_correspondido text;
CREATE INDEX IF NOT EXISTS audit_test_resend_id_idx
  ON public.evento_auditoria ((metadata->>'resend_email_id'))
  WHERE action='campaign_test_sent' AND entity_type='campaign';

CREATE OR REPLACE FUNCTION public.process_resend_email_event(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_event public.evento_email%ROWTYPE;
  v_recipient public.destinatario%ROWTYPE;
  v_test_campaign uuid;
  v_attempts integer;
  v_reason text;
  v_raw text;
  v_permanent boolean;
  v_temporary boolean;
BEGIN
  SELECT * INTO v_event FROM public.evento_email WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('processed',false,'reason','event_not_found'); END IF;
  IF v_event.processado_em IS NOT NULL THEN RETURN jsonb_build_object('processed',true,'duplicate',true); END IF;
  IF v_event.proxima_tentativa_em>now() THEN
    RETURN jsonb_build_object('processed',false,'retryable',true,'reason','retry_not_due');
  END IF;
  IF v_event.tipo NOT IN ('email.sent','email.delivered','email.delivery_delayed',
    'email.bounced','email.complained','email.opened','email.clicked') THEN
    UPDATE public.evento_email SET processado_em=now(),proxima_tentativa_em=NULL,
      erro_processamento=NULL WHERE id=p_event_id;
    RETURN jsonb_build_object('processed',true,'supported',false);
  END IF;
  IF v_event.resend_email_id IS NULL THEN
    UPDATE public.evento_email SET processado_em=now(),proxima_tentativa_em=NULL,
      erro_processamento=NULL,motivo_nao_correspondido='missing_resend_email_id' WHERE id=p_event_id;
    RETURN jsonb_build_object('processed',true,'matched',false,'reason','missing_resend_email_id');
  END IF;

  -- Always try matching first, including events whose retry budget expired.
  SELECT * INTO v_recipient FROM public.destinatario
    WHERE resend_email_id=v_event.resend_email_id ORDER BY criado_em LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    -- Tests intentionally have no queue recipient. Their audit proves origin.
    SELECT entity_id INTO v_test_campaign FROM public.evento_auditoria
      WHERE action='campaign_test_sent' AND entity_type='campaign'
        AND metadata->>'resend_email_id'=v_event.resend_email_id
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      UPDATE public.evento_email SET processado_em=now(),proxima_tentativa_em=NULL,
        erro_processamento=NULL,motivo_nao_correspondido='test_email',
        campanha_id=v_test_campaign WHERE id=p_event_id;
      RETURN jsonb_build_object('processed',true,'matched',false,'retryable',false,
        'reason','test_email','campaign_id',v_test_campaign);
    END IF;

    v_attempts := coalesce(v_event.tentativas,0)+1;
    IF v_attempts>=10 OR v_event.recebido_em<=now()-interval '15 minutes' THEN
      v_reason := CASE WHEN v_attempts>=10 THEN 'recipient_not_found_retry_limit'
        ELSE 'recipient_not_found_timeout' END;
      UPDATE public.evento_email SET processado_em=now(),proxima_tentativa_em=NULL,
        erro_processamento=NULL,motivo_nao_correspondido=v_reason,
        tentativas=v_attempts WHERE id=p_event_id;
      RETURN jsonb_build_object('processed',true,'matched',false,'retryable',false,
        'reason',v_reason,'attempts',v_attempts,'max_attempts',10,'max_age_seconds',900);
    END IF;
    -- Briefly tolerate the gap between Resend acceptance and ID persistence.
    UPDATE public.evento_email SET proxima_tentativa_em=now()+interval '30 seconds',
      erro_processamento=NULL,motivo_nao_correspondido=NULL,
      tentativas=v_attempts WHERE id=p_event_id;
    RETURN jsonb_build_object('processed',false,'matched',false,'retryable',true,
      'reason','recipient_not_ready','attempts',v_attempts,'max_attempts',10,'max_age_seconds',900);
  END IF;

  v_raw := coalesce(
    nullif(btrim(v_event.payload #>> '{data,bounce,type}'),''),
    nullif(btrim(v_event.payload #>> '{data,bounce_type}'),''),
    nullif(btrim(v_event.payload #>> '{data,bounceType}'),''),
    nullif(btrim(v_event.payload #>> '{data,bounce}'),'')
  );
  v_permanent := v_event.tipo='email.bounced' AND lower(coalesce(v_raw,'')) IN ('permanent','hard');
  v_temporary := v_event.tipo='email.bounced' AND lower(coalesce(v_raw,'')) IN ('transient','temporary','soft','delayed');
  UPDATE public.evento_email SET destinatario_id=v_recipient.id,campanha_id=v_recipient.campanha_id,
    email=lower(btrim(v_recipient.email)),motivo_nao_correspondido=NULL,
    bounce_tipo_bruto=CASE WHEN v_event.tipo='email.bounced' THEN coalesce(v_raw,'<missing>') ELSE NULL END,
    bounce_permanente=CASE WHEN v_event.tipo='email.bounced' THEN v_permanent ELSE NULL END WHERE id=p_event_id;
  UPDATE public.destinatario d SET
    enviado_em=CASE WHEN v_event.tipo='email.sent'
      THEN least(coalesce(d.enviado_em,v_event.ocorrido_em),v_event.ocorrido_em) ELSE d.enviado_em END,
    entregue_em=CASE WHEN v_event.tipo IN ('email.delivered','email.complained','email.opened','email.clicked')
      THEN least(coalesce(d.entregue_em,v_event.ocorrido_em),v_event.ocorrido_em) ELSE d.entregue_em END,
    aberto_em=CASE WHEN v_event.tipo='email.opened'
      THEN least(coalesce(d.aberto_em,v_event.ocorrido_em),v_event.ocorrido_em) ELSE d.aberto_em END,
    clicado_em=CASE WHEN v_event.tipo='email.clicked'
      THEN least(coalesce(d.clicado_em,v_event.ocorrido_em),v_event.ocorrido_em) ELSE d.clicado_em END,
    ultimo_soft_bounce_em=CASE WHEN v_temporary
      THEN greatest(d.ultimo_soft_bounce_em,v_event.ocorrido_em) ELSE d.ultimo_soft_bounce_em END,
    status=CASE
      WHEN d.status='bounce' THEN d.status
      WHEN v_permanent THEN 'bounce'
      WHEN v_event.tipo IN ('email.bounced','email.delivery_delayed') THEN d.status
      WHEN v_event.tipo='email.clicked' THEN 'clicado'
      WHEN v_event.tipo='email.opened' AND d.status<>'clicado' THEN 'aberto'
      WHEN v_event.tipo IN ('email.delivered','email.complained') AND d.status NOT IN ('aberto','clicado') THEN 'entregue'
      WHEN v_event.tipo='email.sent' AND d.status IN ('pendente','processando') THEN 'enviado'
      ELSE d.status END,
    erro=CASE WHEN v_permanent THEN NULL
      WHEN d.status='erro' AND v_event.tipo IN ('email.delivered','email.complained','email.opened','email.clicked') THEN NULL
      ELSE d.erro END,
    processando_em=CASE WHEN v_permanent THEN NULL ELSE d.processando_em END
    WHERE d.id=v_recipient.id;
  IF v_permanent OR v_event.tipo='email.complained' THEN
    INSERT INTO public.supressao(email,motivo,origem)
    VALUES(lower(btrim(v_recipient.email)),CASE WHEN v_permanent THEN 'bounce' ELSE 'reclamacao' END,
      'campanha:'||v_recipient.campanha_id::text)
    ON CONFLICT(email) WHERE email IS NOT NULL DO NOTHING;
  END IF;
  UPDATE public.evento_email SET processado_em=now(),proxima_tentativa_em=NULL,erro_processamento=NULL
    WHERE id=p_event_id;
  RETURN jsonb_build_object('processed',true,'matched',true);
END;
$$;
REVOKE ALL ON FUNCTION public.process_resend_email_event(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_resend_email_event(uuid) TO service_role;
COMMIT;