-- Aplicar manualmente APÓS 016 e 017. Não reserva nem envia e-mails.
-- Reexecutável: não põe destinatários enviados de volta em pendente.
BEGIN;
WITH classification AS (
  SELECT id, coalesce(
    nullif(btrim(payload #>> '{data,bounce,type}'),''),
    nullif(btrim(payload #>> '{data,bounce_type}'),''),
    nullif(btrim(payload #>> '{data,bounceType}'),''),
    nullif(btrim(payload #>> '{data,bounce}'),''),bounce_tipo_bruto,'<missing>'
  ) AS raw FROM public.evento_email WHERE tipo='email.bounced'
)
UPDATE public.evento_email e SET bounce_tipo_bruto=c.raw,
  bounce_permanente=lower(c.raw) IN ('permanent','hard')
  FROM classification c WHERE e.id=c.id;

-- Item 2: desfecho permanente vence entregue/aberto/clicado/erro.
WITH fixed AS (
  UPDATE public.destinatario d SET status='bounce',erro=NULL,processando_em=NULL
  WHERE d.status<>'bounce' AND EXISTS (
    SELECT 1 FROM public.evento_email e WHERE e.tipo='email.bounced' AND e.bounce_permanente=true
      AND (e.destinatario_id=d.id OR e.resend_email_id=d.resend_email_id)
  ) RETURNING d.campanha_id
)
INSERT INTO public.evento_auditoria(actor_name,action,entity_type,entity_id,metadata)
SELECT 'Sistema','campaign_bounce_status_repaired','campaign',campanha_id,
  jsonb_build_object('permanentes_corrigidos',count(*)) FROM fixed GROUP BY campanha_id;

-- Item 3: só desfaz o erro que a antiga RPC escreveu para soft/unknown
-- bounce. Erros reais da API não são tocados. Evidência mais forte vence.
WITH evidence AS (
  SELECT d.id,
    min(e.ocorrido_em) FILTER (WHERE e.tipo='email.sent') AS sent,
    min(e.ocorrido_em) FILTER (WHERE e.tipo IN ('email.delivered','email.complained','email.opened','email.clicked')) AS delivered,
    min(e.ocorrido_em) FILTER (WHERE e.tipo='email.opened') AS opened,
    min(e.ocorrido_em) FILTER (WHERE e.tipo='email.clicked') AS clicked,
    min(e.ocorrido_em) FILTER (WHERE e.tipo='email.bounced') AS bounced
  FROM public.destinatario d JOIN public.evento_email e
    ON e.destinatario_id=d.id OR e.resend_email_id=d.resend_email_id
  WHERE d.status='erro' AND (d.erro LIKE 'Bounce temporário informado pelo Resend%'
    OR d.erro LIKE 'Bounce não classificado informado pelo Resend%')
  GROUP BY d.id
), fixed AS (
  UPDATE public.destinatario d SET
    status=CASE
      WHEN coalesce(d.clicado_em,x.clicked) IS NOT NULL THEN 'clicado'
      WHEN coalesce(d.aberto_em,x.opened) IS NOT NULL THEN 'aberto'
      WHEN coalesce(d.entregue_em,x.delivered) IS NOT NULL THEN 'entregue'
      ELSE 'enviado' END,
    enviado_em=coalesce(d.enviado_em,x.sent,x.bounced),
    entregue_em=coalesce(d.entregue_em,x.delivered),
    aberto_em=coalesce(d.aberto_em,x.opened),clicado_em=coalesce(d.clicado_em,x.clicked),
    erro=NULL,processando_em=NULL
  FROM evidence x WHERE d.id=x.id AND x.bounced IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.evento_email e WHERE e.tipo='email.bounced' AND e.bounce_permanente=true
      AND (e.destinatario_id=d.id OR e.resend_email_id=d.resend_email_id)
  ) RETURNING d.campanha_id
)
INSERT INTO public.evento_auditoria(actor_name,action,entity_type,entity_id,metadata)
SELECT 'Sistema','campaign_soft_bounce_status_repaired','campaign',campanha_id,
  jsonb_build_object('temporarios_corrigidos',count(*)) FROM fixed GROUP BY campanha_id;

UPDATE public.destinatario d SET ultimo_soft_bounce_em=x.latest
FROM (
  SELECT d.id,max(e.ocorrido_em) AS latest FROM public.destinatario d JOIN public.evento_email e
    ON e.destinatario_id=d.id OR e.resend_email_id=d.resend_email_id
  WHERE e.tipo='email.bounced' AND lower(e.bounce_tipo_bruto) IN ('transient','temporary','soft','delayed')
  GROUP BY d.id
) x WHERE d.id=x.id AND (d.ultimo_soft_bounce_em IS NULL OR d.ultimo_soft_bounce_em<x.latest);
COMMIT;