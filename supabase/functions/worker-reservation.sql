-- Apply 202610050020_email_validation.sql first, then run this in the
-- Supabase SQL Editor for Repls whose worker uses this reservation function.
ALTER TABLE public.destinatario
  ADD COLUMN IF NOT EXISTS processando_em timestamptz;

CREATE INDEX IF NOT EXISTS destinatario_processando_idx
  ON public.destinatario(processando_em,id)
  WHERE status='processando';

CREATE OR REPLACE FUNCTION public.reservar_destinatarios(
  p_campanha_id uuid,
  p_limite integer DEFAULT 100,
  p_is_lembrete boolean DEFAULT false
)
RETURNS SETOF public.destinatario
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
BEGIN
  PERFORM 1 FROM public.campanha c
  WHERE c.id=p_campanha_id
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

  -- Match the normalized cache column directly so its unique index is usable.
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

  RETURN QUERY
  WITH locked AS (
    SELECT d.id
    FROM public.destinatario d
    WHERE d.campanha_id=p_campanha_id
      AND d.is_lembrete=p_is_lembrete
      AND d.status='pendente'
      AND d.excluido_em IS NULL
      AND EXISTS (
        SELECT 1 FROM public.campanha c
        WHERE c.id=p_campanha_id
          AND c.status=CASE WHEN p_is_lembrete THEN 'concluida' ELSE 'enviando' END
      )
    ORDER BY d.data_ultima_compra DESC NULLS LAST,d.id
    LIMIT greatest(1,least(p_limite,100))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.destinatario d
    SET status='processando',
        tentativas=d.tentativas+1,
        processando_em=now(),
        erro=NULL
    FROM locked
    WHERE d.id=locked.id
    RETURNING d.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.reservar_destinatarios(uuid,integer,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reservar_destinatarios(uuid,integer,boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.recuperar_destinatarios_travados(
  p_limite integer DEFAULT 1000
)
RETURNS SETOF public.destinatario
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
BEGIN
  RETURN QUERY
  WITH locked AS (
    SELECT d.id
    FROM public.destinatario d
    WHERE d.status='processando'
      AND coalesce(d.processando_em,d.criado_em)<now()-interval '15 minutes'
    ORDER BY coalesce(d.processando_em,d.criado_em),d.id
    LIMIT greatest(1,least(p_limite,1000))
    FOR UPDATE SKIP LOCKED
  ), recovered AS (
    UPDATE public.destinatario d
    SET status=CASE WHEN d.tentativas<3 THEN 'pendente' ELSE 'erro' END,
        processando_em=NULL,
        erro=CASE
          WHEN d.tentativas<3 THEN NULL
          ELSE 'Reserva expirada após 15 minutos sem conclusão; limite de 3 tentativas atingido.'
        END
    FROM locked
    WHERE d.id=locked.id
    RETURNING d.*
  )
  SELECT * FROM recovered;
END;
$$;

REVOKE ALL ON FUNCTION public.recuperar_destinatarios_travados(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recuperar_destinatarios_travados(integer)
  TO service_role;
