import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdminClient } from "./supabase";

export const SESSION_COOKIE = "amoconecta_session";
const SESSION_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365;
const REFRESH_BEFORE_EXPIRY_MS = 60_000;
const REFRESH_LOCK_MS = 15_000;
const REFRESH_WAIT_MS = 20_000;

type SupabaseSessionTokens = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
};

type StoredSession = {
  id: string;
  auth_user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_expires_at: string;
  refresh_lock_id: string | null;
  refresh_lock_until: string | null;
  revogado_em: string | null;
};

export type AuthenticatedUser = {
  id: string;
  email: string | null;
  name: string;
};

export class InactiveTeamMemberError extends Error {
  constructor() {
    super("A conta da equipe não está mais ativa.");
    this.name = "InactiveTeamMemberError";
  }
}

let encryptionKeyCache: Buffer | undefined;

function encryptionKey(): Buffer {
  if (encryptionKeyCache) return encryptionKeyCache;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET é obrigatória para proteger sessões.");
  }
  encryptionKeyCache = createHmac("sha256", secret)
    .update("amoconecta-auth-session-encryption-v1")
    .digest();
  return encryptionKeyCache;
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptToken(value: string): string {
  const [ivPart, tagPart, ciphertextPart] = value.split(".");
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Sessão armazenada em formato inválido.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function supabaseAuthClient() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórias para autenticação.",
    );
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function rawSessionCookie(req: Request): string | undefined {
  const token = req.cookies?.[SESSION_COOKIE];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

function sessionExpiresAt(session: SupabaseSessionTokens): string {
  const expiresAt =
    session.expires_at ??
    Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);
  return new Date(expiresAt * 1000).toISOString();
}

export async function createPersistentSession(
  authUserId: string,
  session: SupabaseSessionTokens,
): Promise<string> {
  const sessionId = randomUUID();
  const { data, error } = await supabaseAdminClient().rpc(
    "create_persistent_session",
    {
      p_session_id: sessionId,
      p_auth_user_id: authUserId,
      p_access_token_encrypted: encryptToken(session.access_token),
      p_refresh_token_encrypted: encryptToken(session.refresh_token),
      p_access_expires_at: sessionExpiresAt(session),
    },
  );
  if (error) throw error;
  if (data !== true) throw new InactiveTeamMemberError();
  return sessionId;
}

async function loadPersistentSession(
  sessionId: string,
): Promise<StoredSession | null> {
  const { data, error } = await supabaseAdminClient()
    .from("sessao_app")
    .select(
      "id,auth_user_id,access_token_encrypted,refresh_token_encrypted,access_expires_at,refresh_lock_id,refresh_lock_until,revogado_em",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return data as StoredSession | null;
}

function needsRefresh(session: StoredSession): boolean {
  return (
    Date.parse(session.access_expires_at) <=
    Date.now() + REFRESH_BEFORE_EXPIRY_MS
  );
}

function isInvalidAuthError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  return status === 400 || status === 401 || status === 403;
}

async function revokeStoredSession(
  sessionId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("sessao_app")
    .update({
      revogado_em: new Date().toISOString(),
      motivo_revogacao: reason,
      refresh_lock_id: null,
      refresh_lock_until: null,
    })
    .eq("id", sessionId)
    .is("revogado_em", null);
  if (error) throw error;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function refreshPersistentSession(
  initial: StoredSession,
): Promise<StoredSession | null> {
  let current = initial;
  const admin = supabaseAdminClient();
  const maxAttempts = Math.ceil(REFRESH_WAIT_MS / 100);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (current.revogado_em) return null;
    if (!needsRefresh(current)) return current;

    const now = new Date();
    const lockId = randomUUID();
    const nowIso = now.toISOString();
    const lockUntil = new Date(now.getTime() + REFRESH_LOCK_MS).toISOString();
    const { data: lock, error: lockError } = await admin
      .from("sessao_app")
      .update({
        refresh_lock_id: lockId,
        refresh_lock_until: lockUntil,
      })
      .eq("id", current.id)
      .is("revogado_em", null)
      .or(`refresh_lock_until.is.null,refresh_lock_until.lt.${nowIso}`)
      .select("id")
      .maybeSingle();
    if (lockError) throw lockError;

    if (!lock) {
      await wait(100);
      const reloaded = await loadPersistentSession(current.id);
      if (!reloaded || reloaded.revogado_em) return null;
      current = reloaded;
      continue;
    }

    try {
      current = (await loadPersistentSession(current.id)) ?? current;
      if (current.revogado_em) return null;
      if (!needsRefresh(current)) {
        await admin
          .from("sessao_app")
          .update({ refresh_lock_id: null, refresh_lock_until: null })
          .eq("id", current.id)
          .eq("refresh_lock_id", lockId);
        return current;
      }

      let refreshToken: string;
      try {
        refreshToken = decryptToken(current.refresh_token_encrypted);
      } catch {
        await revokeStoredSession(current.id, "refresh_token_unreadable");
        return null;
      }

      const { data, error } = await supabaseAuthClient().auth.refreshSession({
        refresh_token: refreshToken,
      });
      if (error || !data.session?.access_token || !data.session.refresh_token) {
        if (isInvalidAuthError(error)) {
          await revokeStoredSession(current.id, "refresh_token_rejected");
          return null;
        }
        throw error ?? new Error("Supabase não retornou uma sessão renovada.");
      }

      const { data: updated, error: updateError } = await admin
        .from("sessao_app")
        .update({
          access_token_encrypted: encryptToken(data.session.access_token),
          refresh_token_encrypted: encryptToken(data.session.refresh_token),
          access_expires_at: sessionExpiresAt(data.session),
          atualizado_em: new Date().toISOString(),
          refresh_lock_id: null,
          refresh_lock_until: null,
        })
        .eq("id", current.id)
        .eq("refresh_lock_id", lockId)
        .is("revogado_em", null)
        .select(
          "id,auth_user_id,access_token_encrypted,refresh_token_encrypted,access_expires_at,refresh_lock_id,refresh_lock_until,revogado_em",
        )
        .maybeSingle();
      if (updateError) throw updateError;
      return (updated as StoredSession | null) ?? null;
    } catch (error) {
      await admin
        .from("sessao_app")
        .update({ refresh_lock_id: null, refresh_lock_until: null })
        .eq("id", current.id)
        .eq("refresh_lock_id", lockId);
      throw error;
    }
  }

  throw new Error("A renovação da sessão está em andamento. Tente novamente.");
}

export async function getSupabaseUser(
  req: Request,
  res: Response,
): Promise<{ token: string; sessionId: string; user: AuthenticatedUser } | null> {
  const sessionId = rawSessionCookie(req);
  if (!sessionId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
    clearSessionCookie(res);
    return null;
  }

  let stored = await loadPersistentSession(sessionId);
  if (!stored || stored.revogado_em) {
    clearSessionCookie(res);
    return null;
  }

  const admin = supabaseAdminClient();
  const { data: member, error: memberError } = await admin
    .from("membro_equipe")
    .select("auth_user_id,email,nome,ativo,ultimo_acesso_em")
    .eq("auth_user_id", stored.auth_user_id)
    .maybeSingle();
  if (memberError) throw memberError;
  if (
    !member ||
    member.ativo !== true ||
    !member.email.toLowerCase().endsWith("@amo.delivery")
  ) {
    await revokeStoredSession(sessionId, "team_member_inactive");
    clearSessionCookie(res);
    return null;
  }

  stored = (await refreshPersistentSession(stored)) ?? null;
  if (!stored) {
    clearSessionCookie(res);
    return null;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(stored.access_token_encrypted);
  } catch {
    await revokeStoredSession(sessionId, "access_token_unreadable");
    clearSessionCookie(res);
    return null;
  }

  const { data, error } =
    await supabaseAuthClient().auth.getUser(accessToken);
  if (error || !data.user || data.user.id !== stored.auth_user_id) {
    if (error && !isInvalidAuthError(error)) throw error;
    await revokeStoredSession(sessionId, "access_token_rejected");
    clearSessionCookie(res);
    return null;
  }

  const lastSeenAt = member.ultimo_acesso_em
    ? Date.parse(member.ultimo_acesso_em)
    : 0;
  if (!lastSeenAt || Date.now() - lastSeenAt > 5 * 60_000) {
    const { error: updateError } = await admin
      .from("membro_equipe")
      .update({ ultimo_acesso_em: new Date().toISOString() })
      .eq("auth_user_id", stored.auth_user_id)
      .eq("ativo", true);
    if (updateError) throw updateError;
  }

  setSessionCookie(res, sessionId);
  return {
    token: accessToken,
    sessionId,
    user: {
      id: data.user.id,
      email: data.user.email ?? member.email ?? null,
      name: member.nome,
    },
  };
}

export async function revokePersistentSession(
  sessionId: string,
  scope: "local" | "global" = "local",
): Promise<unknown | null> {
  const session = await loadPersistentSession(sessionId);
  if (!session || session.revogado_em) return null;

  let signOutError: unknown | null = null;
  try {
    const refreshed = await refreshPersistentSession(session);
    if (refreshed) {
      const accessToken = decryptToken(refreshed.access_token_encrypted);
      const result = await supabaseAdminClient().auth.admin.signOut(
        accessToken,
        scope,
      );
      signOutError = result.error;
    }
  } catch (error) {
    signOutError = error;
  }

  await revokeStoredSession(sessionId, `user_logout_${scope}`);
  return signOutError;
}

export async function revokeAllPersistentSessions(
  authUserId: string,
): Promise<unknown | null> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("sessao_app")
    .select(
      "id,auth_user_id,access_token_encrypted,refresh_token_encrypted,access_expires_at,refresh_lock_id,refresh_lock_until,revogado_em",
    )
    .eq("auth_user_id", authUserId)
    .is("revogado_em", null);
  if (error) throw error;

  let signOutError: unknown | null = null;
  let revokedInSupabase = !data?.length;
  for (const raw of data ?? []) {
    const session = raw as StoredSession;
    try {
      const refreshed = await refreshPersistentSession(session);
      if (!refreshed) continue;
      const accessToken = decryptToken(refreshed.access_token_encrypted);
      const result = await admin.auth.admin.signOut(accessToken, "global");
      if (!result.error) {
        revokedInSupabase = true;
        break;
      }
      signOutError = result.error;
    } catch (sessionError) {
      signOutError = sessionError;
    }
  }

  const { error: revokeError } = await admin
    .from("sessao_app")
    .update({
      revogado_em: new Date().toISOString(),
      motivo_revogacao: "team_member_deactivated",
      refresh_lock_id: null,
      refresh_lock_until: null,
    })
    .eq("auth_user_id", authUserId)
    .is("revogado_em", null);
  if (revokeError) throw revokeError;

  return revokedInSupabase ? null : signOutError ?? new Error("Supabase não confirmou a revogação global.");
}

export function hashOneTimeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newOneTimeToken(): string {
  return randomBytes(32).toString("base64url");
}