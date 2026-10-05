BEGIN;

ALTER TABLE public.campanha
  ADD COLUMN IF NOT EXISTS janela_envio_inicio time without time zone,
  ADD COLUMN IF NOT EXISTS janela_envio_fim time without time zone;

UPDATE public.campanha
SET janela_envio_inicio = COALESCE(janela_envio_inicio, time '09:00'),
    janela_envio_fim = COALESCE(janela_envio_fim, time '20:00');

ALTER TABLE public.campanha
  ALTER COLUMN janela_envio_inicio SET DEFAULT time '09:00',
  ALTER COLUMN janela_envio_inicio SET NOT NULL,
  ALTER COLUMN janela_envio_fim SET DEFAULT time '20:00',
  ALTER COLUMN janela_envio_fim SET NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.campanha'::regclass
      AND conname = 'campanha_janela_envio_valida'
  ) THEN
    ALTER TABLE public.campanha
      ADD CONSTRAINT campanha_janela_envio_valida CHECK (
        janela_envio_inicio < janela_envio_fim
        AND extract(second FROM janela_envio_inicio) = 0
        AND extract(second FROM janela_envio_fim) = 0
      ) NOT VALID;
  END IF;
END;
$migration$;

ALTER TABLE public.campanha
  VALIDATE CONSTRAINT campanha_janela_envio_valida;

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
  PERFORM 1
  FROM public.campanha c
  WHERE c.id = p_campanha_id
    AND c.status = CASE WHEN p_is_lembrete THEN 'concluida' ELSE 'enviando' END
    AND timezone('America/Sao_Paulo', clock_timestamp())::time >= c.janela_envio_inicio
    AND timezone('America/Sao_Paulo', clock_timestamp())::time < c.janela_envio_fim
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.validacao_email_job j
    WHERE j.campanha_id = p_campanha_id
      AND j.status IN ('pendente', 'processando', 'sem_creditos', 'erro')
  ) THEN
    RETURN;
  END IF;

  UPDATE public.destinatario d
  SET status = 'bloqueado_validacao_email',
      processando_em = NULL,
      erro = 'Bloqueado pela validação de e-mail (' || v.status || ').'
  FROM public.verificacao_email v
  WHERE d.campanha_id = p_campanha_id
    AND d.is_lembrete = p_is_lembrete
    AND d.status = 'pendente'
    AND d.excluido_em IS NULL
    AND v.email = d.email
    AND v.status IN ('invalid', 'spamtrap', 'abuse', 'do_not_mail');

  RETURN QUERY
  WITH locked AS (
    SELECT d.id
    FROM public.destinatario d
    WHERE d.campanha_id = p_campanha_id
      AND d.is_lembrete = p_is_lembrete
      AND d.status = 'pendente'
      AND d.excluido_em IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.campanha c
        WHERE c.id = p_campanha_id
          AND c.status = CASE WHEN p_is_lembrete THEN 'concluida' ELSE 'enviando' END
          AND timezone('America/Sao_Paulo', clock_timestamp())::time >= c.janela_envio_inicio
          AND timezone('America/Sao_Paulo', clock_timestamp())::time < c.janela_envio_fim
      )
    ORDER BY d.data_ultima_compra DESC NULLS LAST, d.id
    LIMIT greatest(1, least(p_limite, 100))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.destinatario d
    SET status = 'processando',
        tentativas = d.tentativas + 1,
        processando_em = now(),
        erro = NULL
    FROM locked
    WHERE d.id = locked.id
    RETURNING d.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.reservar_destinatarios(uuid, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservar_destinatarios(uuid, integer, boolean)
  TO service_role;

COMMIT;
