-- Keep 010 as an immutable migration and replace its event processor with
-- classification-aware bounce handling.
CREATE OR REPLACE FUNCTION public.process_resend_email_event(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.evento_email%ROWTYPE;
  v_recipient public.destinatario%ROWTYPE;
  v_permanent boolean;
  v_temporary boolean;
  v_bounce_type_raw text;
  v_bounce_type text;
BEGIN
  SELECT * INTO v_event
  FROM public.evento_email
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'event_not_found');
  END IF;

  IF v_event.processado_em IS NOT NULL THEN
    RETURN jsonb_build_object('processed', true, 'duplicate', true);
  END IF;

  IF v_event.proxima_tentativa_em IS NOT NULL
     AND v_event.proxima_tentativa_em > now() THEN
    RETURN jsonb_build_object('processed', false, 'retryable', true, 'reason', 'retry_not_due');
  END IF;

  IF v_event.tipo NOT IN (
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.bounced',
    'email.complained',
    'email.opened',
    'email.clicked'
  ) THEN
    UPDATE public.evento_email
      SET processado_em = now(), erro_processamento = NULL
      WHERE id = p_event_id;
    RETURN jsonb_build_object('processed', true, 'supported', false);
  END IF;

  IF v_event.resend_email_id IS NULL THEN
    UPDATE public.evento_email
      SET processado_em = now(),
          proxima_tentativa_em = NULL,
          erro_processamento = 'missing_resend_email_id'
      WHERE id = p_event_id;
    RETURN jsonb_build_object('processed', true, 'matched', false);
  END IF;

  SELECT * INTO v_recipient
  FROM public.destinatario
  WHERE resend_email_id = v_event.resend_email_id
  ORDER BY criado_em
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    IF v_event.recebido_em < now() - interval '24 hours' THEN
      UPDATE public.evento_email
        SET processado_em = now(),
            proxima_tentativa_em = NULL,
            erro_processamento = 'recipient_not_found_after_24h',
            tentativas = tentativas + 1
        WHERE id = p_event_id;
      RETURN jsonb_build_object('processed', true, 'matched', false);
    END IF;

    UPDATE public.evento_email
      SET proxima_tentativa_em = now() + interval '30 seconds',
          erro_processamento = 'recipient_not_ready',
          tentativas = tentativas + 1
      WHERE id = p_event_id;
    RETURN jsonb_build_object('processed', false, 'matched', false, 'retryable', true);
  END IF;

  v_bounce_type_raw := coalesce(
    NULLIF(btrim(v_event.payload #>> '{data,bounce,type}'), ''),
    NULLIF(btrim(v_event.payload #>> '{data,bounce_type}'), ''),
    NULLIF(btrim(v_event.payload #>> '{data,bounceType}'), ''),
    NULLIF(btrim(v_event.payload #>> '{data,bounce}'), '')
  );
  v_bounce_type := lower(coalesce(v_bounce_type_raw, ''));
  v_permanent := v_event.tipo = 'email.bounced'
    AND v_bounce_type IN ('permanent', 'hard');
  v_temporary := v_event.tipo = 'email.bounced'
    AND v_bounce_type IN ('transient', 'temporary', 'soft', 'delayed');

  UPDATE public.evento_email
    SET destinatario_id = v_recipient.id,
        campanha_id = v_recipient.campanha_id,
        email = lower(btrim(v_recipient.email)),
        bounce_tipo_bruto = CASE
          WHEN v_event.tipo = 'email.bounced' THEN coalesce(v_bounce_type_raw, '<missing>')
          ELSE NULL
        END,
        bounce_permanente = CASE
          WHEN v_event.tipo = 'email.bounced' THEN v_permanent
          ELSE NULL
        END
    WHERE id = p_event_id;

  IF v_event.tipo IN (
    'email.sent',
    'email.delivered',
    'email.complained',
    'email.opened',
    'email.clicked',
    'email.bounced'
  ) THEN
    UPDATE public.destinatario AS d
    SET
      enviado_em = CASE
        WHEN v_event.tipo = 'email.sent' THEN least(coalesce(d.enviado_em, v_event.ocorrido_em), v_event.ocorrido_em)
        ELSE d.enviado_em
      END,
      entregue_em = CASE
        WHEN v_event.tipo IN ('email.delivered', 'email.complained', 'email.opened', 'email.clicked')
          THEN least(coalesce(d.entregue_em, v_event.ocorrido_em), v_event.ocorrido_em)
        ELSE d.entregue_em
      END,
      aberto_em = CASE
        WHEN v_event.tipo = 'email.opened'
          THEN least(coalesce(d.aberto_em, v_event.ocorrido_em), v_event.ocorrido_em)
        ELSE d.aberto_em
      END,
      clicado_em = CASE
        WHEN v_event.tipo = 'email.clicked'
          THEN least(coalesce(d.clicado_em, v_event.ocorrido_em), v_event.ocorrido_em)
        ELSE d.clicado_em
      END,
      status = CASE
        WHEN v_event.tipo = 'email.bounced' AND v_permanent THEN 'bounce'
        WHEN v_event.tipo = 'email.bounced' THEN 'erro'
        WHEN d.status IN ('bounce', 'erro') THEN d.status
        WHEN v_event.tipo = 'email.clicked' AND d.status <> 'clicado' THEN 'clicado'
        WHEN v_event.tipo = 'email.opened'
          AND d.status NOT IN ('aberto', 'clicado') THEN 'aberto'
        WHEN v_event.tipo = 'email.delivered'
          AND d.status NOT IN ('entregue', 'aberto', 'clicado') THEN 'entregue'
        WHEN v_event.tipo = 'email.complained'
          AND d.status NOT IN ('entregue', 'aberto', 'clicado') THEN 'entregue'
        WHEN v_event.tipo = 'email.sent'
          AND d.status IN ('pendente', 'processando') THEN 'enviado'
        ELSE d.status
      END,
      erro = CASE
        WHEN v_event.tipo = 'email.bounced' AND NOT v_permanent THEN
          CASE
            WHEN v_temporary THEN
              'Bounce temporário informado pelo Resend; tipo bruto: '
                || coalesce(v_bounce_type_raw, '<missing>')
            ELSE
              'Bounce não classificado informado pelo Resend; tipo bruto: '
                || coalesce(v_bounce_type_raw, '<missing>')
          END
        ELSE d.erro
      END,
      processando_em = CASE
        WHEN v_event.tipo = 'email.bounced' THEN NULL
        ELSE d.processando_em
      END
    WHERE d.id = v_recipient.id;
  END IF;

  IF v_event.tipo = 'email.bounced' AND v_permanent THEN
    INSERT INTO public.supressao (email, motivo, origem)
    VALUES (
      lower(btrim(v_recipient.email)),
      'bounce',
      'campanha:' || v_recipient.campanha_id::text
    )
    ON CONFLICT (email) WHERE email IS NOT NULL
    DO NOTHING;
  ELSIF v_event.tipo = 'email.complained' THEN
    INSERT INTO public.supressao (email, motivo, origem)
    VALUES (
      lower(btrim(v_recipient.email)),
      'reclamacao',
      'campanha:' || v_recipient.campanha_id::text
    )
    ON CONFLICT (email) WHERE email IS NOT NULL
    DO NOTHING;
  END IF;

  UPDATE public.evento_email
    SET processado_em = now(),
        proxima_tentativa_em = NULL,
        erro_processamento = NULL
    WHERE id = p_event_id;

  RETURN jsonb_build_object('processed', true, 'matched', true);
END;
$$;

REVOKE ALL ON FUNCTION public.process_resend_email_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_resend_email_event(uuid) TO service_role;
