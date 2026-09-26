-- Team accounts stay in Supabase Auth; this schema stores AmoConecta access,
-- opaque server sessions, one-time links, and immutable action history.

CREATE TABLE IF NOT EXISTS public.membro_equipe (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  email text NOT NULL,
  nome text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_acesso_em timestamptz,
  desativado_em timestamptz,
  desativado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT membro_equipe_amo_delivery_email
    CHECK (lower(email) LIKE '%@amo.delivery')
);

CREATE UNIQUE INDEX IF NOT EXISTS membro_equipe_email_lower_unique
  ON public.membro_equipe (lower(email));

INSERT INTO public.membro_equipe (
  auth_user_id,
  email,
  nome,
  ativo,
  criado_em,
  ultimo_acesso_em
)
SELECT
  id,
  lower(email),
  coalesce(
    nullif(raw_user_meta_data ->> 'name', ''),
    nullif(raw_user_meta_data ->> 'full_name', ''),
    split_part(email, '@', 1)
  ),
  true,
  coalesce(created_at, now()),
  last_sign_in_at
FROM auth.users
WHERE email IS NOT NULL
  AND lower(email) LIKE '%@amo.delivery'
ON CONFLICT (auth_user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.convite_equipe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL,
  convidado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  convidado_por_nome text NOT NULL,
  convidado_por_email text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  claim_id uuid,
  claim_expires_at timestamptz,
  aceito_em timestamptz,
  cancelado_em timestamptz,
  CONSTRAINT convite_equipe_amo_delivery_email
    CHECK (lower(email) LIKE '%@amo.delivery')
);

CREATE UNIQUE INDEX IF NOT EXISTS convite_equipe_email_pending_unique
  ON public.convite_equipe (lower(email))
  WHERE aceito_em IS NULL AND cancelado_em IS NULL;

CREATE INDEX IF NOT EXISTS convite_equipe_pending_expiry_idx
  ON public.convite_equipe (expira_em)
  WHERE aceito_em IS NULL AND cancelado_em IS NULL;

CREATE TABLE IF NOT EXISTS public.sessao_app (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES public.membro_equipe(auth_user_id) ON DELETE RESTRICT,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  refresh_lock_id uuid,
  refresh_lock_until timestamptz,
  revogado_em timestamptz,
  motivo_revogacao text
);

CREATE INDEX IF NOT EXISTS sessao_app_active_user_idx
  ON public.sessao_app (auth_user_id)
  WHERE revogado_em IS NULL;

CREATE TABLE IF NOT EXISTS public.token_recuperacao_senha (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES public.membro_equipe(auth_user_id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  claim_id uuid,
  claim_expires_at timestamptz,
  usado_em timestamptz
);

CREATE INDEX IF NOT EXISTS token_recuperacao_senha_pending_user_idx
  ON public.token_recuperacao_senha (auth_user_id, criado_em DESC)
  WHERE usado_em IS NULL;

CREATE TABLE IF NOT EXISTS public.evento_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text NOT NULL,
  actor_email text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evento_auditoria_entity_created_idx
  ON public.evento_auditoria (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS evento_auditoria_action_created_idx
  ON public.evento_auditoria (action, created_at DESC);

ALTER TABLE public.campanha
  ADD COLUMN IF NOT EXISTS criado_por_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS criado_por_nome text,
  ADD COLUMN IF NOT EXISTS criado_por_email text,
  ADD COLUMN IF NOT EXISTS agendado_por_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agendado_por_nome text,
  ADD COLUMN IF NOT EXISTS agendado_por_email text,
  ADD COLUMN IF NOT EXISTS agendado_em timestamptz,
  ADD COLUMN IF NOT EXISTS pausado_por_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pausado_por_nome text,
  ADD COLUMN IF NOT EXISTS pausado_por_email text;

ALTER TABLE public.membro_equipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.convite_equipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessao_app ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_recuperacao_senha ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evento_auditoria ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.membro_equipe FROM anon, authenticated;
REVOKE ALL ON public.convite_equipe FROM anon, authenticated;
REVOKE ALL ON public.sessao_app FROM anon, authenticated;
REVOKE ALL ON public.token_recuperacao_senha FROM anon, authenticated;
REVOKE ALL ON public.evento_auditoria FROM anon, authenticated;

GRANT ALL ON public.membro_equipe TO service_role;
GRANT ALL ON public.convite_equipe TO service_role;
GRANT ALL ON public.sessao_app TO service_role;
GRANT ALL ON public.token_recuperacao_senha TO service_role;
GRANT ALL ON public.evento_auditoria TO service_role;

CREATE OR REPLACE FUNCTION public.create_persistent_session(
  p_session_id uuid,
  p_auth_user_id uuid,
  p_access_token_encrypted text,
  p_refresh_token_encrypted text,
  p_access_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active boolean;
BEGIN
  SELECT ativo INTO v_active
  FROM public.membro_equipe
  WHERE auth_user_id = p_auth_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_active IS DISTINCT FROM true THEN
    RETURN false;
  END IF;

  INSERT INTO public.sessao_app (
    id,
    auth_user_id,
    access_token_encrypted,
    refresh_token_encrypted,
    access_expires_at
  )
  VALUES (
    p_session_id,
    p_auth_user_id,
    p_access_token_encrypted,
    p_refresh_token_encrypted,
    p_access_expires_at
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_team_invitation(
  p_invite_id uuid,
  p_token_hash text,
  p_claim_id uuid
)
RETURNS SETOF public.convite_equipe
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.convite_equipe
  SET claim_id = p_claim_id,
      claim_expires_at = now() + interval '15 minutes'
  WHERE id = p_invite_id
    AND token_hash = p_token_hash
    AND aceito_em IS NULL
    AND cancelado_em IS NULL
    AND expira_em > now()
    AND (claim_expires_at IS NULL OR claim_expires_at <= now())
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.complete_team_invitation(
  p_invite_id uuid,
  p_claim_id uuid,
  p_auth_user_id uuid,
  p_name text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.convite_equipe%ROWTYPE;
BEGIN
  SELECT * INTO v_invite
  FROM public.convite_equipe
  WHERE id = p_invite_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_invite.aceito_em IS NOT NULL
    OR v_invite.cancelado_em IS NOT NULL
    OR v_invite.claim_id IS DISTINCT FROM p_claim_id
    OR v_invite.claim_expires_at <= now()
  THEN
    RETURN false;
  END IF;

  INSERT INTO public.membro_equipe (
    auth_user_id, email, nome, ativo, criado_em
  )
  VALUES (
    p_auth_user_id, lower(v_invite.email), p_name, true, now()
  )
  ON CONFLICT (auth_user_id) DO UPDATE
    SET email = EXCLUDED.email,
        nome = EXCLUDED.nome,
        ativo = true,
        desativado_em = NULL,
        desativado_por = NULL;

  UPDATE public.convite_equipe
  SET aceito_em = now(),
      claim_id = NULL,
      claim_expires_at = NULL
  WHERE id = p_invite_id;

  INSERT INTO public.evento_auditoria (
    actor_user_id, actor_name, actor_email, action, entity_type, entity_id, metadata
  )
  VALUES (
    p_auth_user_id,
    p_name,
    lower(v_invite.email),
    'team_invitation_accepted',
    'team_member',
    p_auth_user_id,
    jsonb_build_object('invitation_id', p_invite_id)
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_team_member(
  p_target_user_id uuid,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_email text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_active boolean;
  v_active_count integer;
  v_target_email text;
BEGIN
  IF p_target_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'self_deactivation' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(741822001);

  SELECT ativo INTO v_actor_active
  FROM public.membro_equipe
  WHERE auth_user_id = p_actor_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_actor_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'actor_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_target_email
  FROM public.membro_equipe
  WHERE auth_user_id = p_target_user_id AND ativo = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.membro_equipe
  WHERE ativo = true;

  IF v_active_count <= 1 THEN
    RAISE EXCEPTION 'last_active_member' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.membro_equipe
  SET ativo = false,
      desativado_em = now(),
      desativado_por = p_actor_user_id
  WHERE auth_user_id = p_target_user_id;

  INSERT INTO public.evento_auditoria (
    actor_user_id, actor_name, actor_email, action, entity_type, entity_id, metadata
  )
  VALUES (
    p_actor_user_id,
    p_actor_name,
    p_actor_email,
    'team_member_deactivated',
    'team_member',
    p_target_user_id,
    jsonb_build_object('target_email', v_target_email)
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_team_invitation(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_persistent_session(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_team_invitation(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deactivate_team_member(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_team_invitation(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_persistent_session(uuid, uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_team_invitation(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_team_member(uuid, uuid, text, text) TO service_role;