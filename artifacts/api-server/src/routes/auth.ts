import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  AcceptTeamInvitationBody,
  CompletePasswordRecoveryBody,
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
  RequestPasswordRecoveryResponse,
  RequestPasswordRecoveryBody,
} from "@workspace/api-zod";
import { getTechnicalError } from "../lib/technical-error";
import { supabaseAdminClient } from "../lib/supabase";
import {
  checkLoginAttempt,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
  resetLoginAttempts,
} from "../lib/login-rate-limit";
import {
  clearSessionCookie,
  createPersistentSession,
  getSupabaseUser,
  hashOneTimeToken,
  InactiveTeamMemberError,
  newOneTimeToken,
  rawSessionCookie,
  revokeAllPersistentSessions,
  revokePersistentSession,
  setSessionCookie,
  supabaseAuthClient,
} from "../lib/auth-session";
import { recordAuditEvent, systemAuditActor } from "../lib/audit-events";
import {
  applicationUrl,
  emailIdempotencyKey,
  escapeHtml,
  sendTransactionalEmail,
} from "../lib/transactional-email";

const router: IRouter = Router();
const RECOVERY_WINDOW_MS = 15 * 60_000;
const RECOVERY_LIMIT = 5;
type AuthSessionTokens = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
};
const recoveryAttempts = new Map<
  string,
  { startedAt: number; count: number }
>();

export { getSupabaseUser };

function allowRecoveryRequest(ip: string): boolean {
  const now = Date.now();
  const previous = recoveryAttempts.get(ip);
  if (!previous || now - previous.startedAt >= RECOVERY_WINDOW_MS) {
    recoveryAttempts.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (previous.count >= RECOVERY_LIMIT) return false;
  previous.count += 1;
  return true;
}

function publicRecoveryResponse(res: Response): void {
  res.status(202).json(
    RequestPasswordRecoveryResponse.parse({
      message:
        "Se o e-mail corresponder a uma conta ativa, enviaremos um link de recuperação.",
    }),
  );
}

async function auditWithoutChangingResponse(
  req: Request,
  event: Parameters<typeof recordAuditEvent>[0],
): Promise<void> {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error), action: event.action },
      "Could not persist team access audit event",
    );
  }
}

async function findAuthUserByEmail(email: string) {
  const admin = supabaseAdminClient();
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    const found = data.users.find(
      (user) => user.email?.toLowerCase() === email.toLowerCase(),
    );
    if (found) return found;
    if (data.users.length < 1000) return null;
  }
  return null;
}

async function releaseInvitationClaim(
  inviteId: string,
  claimId: string,
): Promise<void> {
  await supabaseAdminClient()
    .from("convite_equipe")
    .update({ claim_id: null, claim_expires_at: null })
    .eq("id", inviteId)
    .eq("claim_id", claimId);
}

async function logInWithCredentials(
  email: string,
  password: string,
): Promise<{
  userId: string;
  email: string;
  session: AuthSessionTokens;
}> {
  const { data, error } = await supabaseAuthClient().auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  if (!data.session?.access_token || !data.session.refresh_token || !data.user?.id) {
    throw new Error("Supabase não retornou uma sessão válida.");
  }
  return {
    userId: data.user.id,
    email: data.user.email ?? email,
    session: data.session,
  };
}

router.get("/auth/session", async (req, res) => {
  const session = await getSupabaseUser(req, res);
  const data = GetAuthSessionResponse.parse({
    authenticated: Boolean(session),
    user: session
      ? { id: session.user.id, email: session.user.email ?? "" }
      : null,
  });
  res.json(data);
});

router.post("/auth/login", async (req, res) => {
  const ip = req.ip || "unknown";
  const rateLimit = checkLoginAttempt(ip);
  if (!rateLimit.allowed) {
    req.log.warn(
      {
        ip,
        attempts: LOGIN_RATE_LIMIT,
        windowMinutes: LOGIN_RATE_WINDOW_MS / 60_000,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      "Login temporarily blocked by IP rate limit",
    );
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    res.status(429).json({
      error: "Muitas tentativas de login. Tente novamente mais tarde.",
    });
    return;
  }

  const parsedCredentials = LoginBody.safeParse(req.body);
  if (!parsedCredentials.success) {
    res.status(422).json({ error: "Informe um e-mail e uma senha válidos." });
    return;
  }

  const credentials = parsedCredentials.data;
  let authData: Awaited<ReturnType<typeof logInWithCredentials>>;
  try {
    authData = await logInWithCredentials(
      credentials.email.trim().toLowerCase(),
      credentials.password,
    );
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Supabase Auth login failed",
    );
    res.status(401).json({ error: "E-mail ou senha inválidos." });
    return;
  }

  const { data: member, error: memberError } = await supabaseAdminClient()
    .from("membro_equipe")
    .select("auth_user_id,email,nome,ativo")
    .eq("auth_user_id", authData.userId)
    .maybeSingle();
  if (memberError) {
    req.log.error(
      { technicalError: getTechnicalError(memberError) },
      "Could not verify team membership at login",
    );
    await supabaseAdminClient().auth.admin.signOut(
      authData.session.access_token,
      "local",
    );
    res.status(503).json({
      error: "Não foi possível validar o acesso da equipe. Aplique a migração de acesso.",
    });
    return;
  }
  if (
    !member ||
    member.ativo !== true ||
    !member.email.toLowerCase().endsWith("@amo.delivery")
  ) {
    await supabaseAdminClient().auth.admin.signOut(
      authData.session.access_token,
      "local",
    );
    res.status(403).json({
      error: "Esta conta não tem acesso ativo ao AmoConecta.",
    });
    return;
  }

  try {
    const sessionId = await createPersistentSession(
      authData.userId,
      authData.session,
    );
    setSessionCookie(res, sessionId);
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Could not persist authenticated session",
    );
    await supabaseAdminClient().auth.admin.signOut(
      authData.session.access_token,
      "local",
    );
    if (error instanceof InactiveTeamMemberError) {
      res.status(403).json({
        error: "Esta conta não tem acesso ativo ao AmoConecta.",
      });
      return;
    }
    res.status(503).json({
      error: "Não foi possível iniciar a sessão. Verifique a migração de acesso.",
    });
    return;
  }

  resetLoginAttempts(ip);
  res.json(
    LoginResponse.parse({
      authenticated: true,
      user: {
        id: authData.userId,
        email: authData.email,
      },
    }),
  );
});

router.post("/auth/logout", async (req, res) => {
  const cookieValue = rawSessionCookie(req);
  clearSessionCookie(res);
  if (!cookieValue) {
    res.status(204).send();
    return;
  }

  try {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cookieValue)) {
      const error = await revokePersistentSession(cookieValue, "local");
      if (error) throw error;
    } else {
      const { error } = await supabaseAdminClient().auth.admin.signOut(
        cookieValue,
        "local",
      );
      if (error) throw error;
    }
    res.status(204).send();
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Could not revoke Supabase session during logout",
    );
    res.status(502).json({
      error: "A sessão local foi encerrada, mas o Supabase não confirmou a revogação.",
    });
  }
});

router.post("/auth/invitations/accept", async (req, res) => {
  const parsed = AcceptTeamInvitationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Confira o convite, o nome e a senha informados." });
    return;
  }

  const input = parsed.data;
  const claimId = randomUUID();
  const admin = supabaseAdminClient();
  let inviteId: string | null = null;
  let createdUserId: string | null = null;
  let createdAuthUser = false;
  let invitationCompleted = false;

  try {
    const { data: claimedRows, error: claimError } = await admin.rpc(
      "claim_team_invitation",
      {
        p_invite_id: input.invite_id,
        p_token_hash: hashOneTimeToken(input.token),
        p_claim_id: claimId,
      },
    );
    if (claimError) throw claimError;
    const invitation = Array.isArray(claimedRows) ? claimedRows[0] : null;
    if (!invitation) {
      res.status(400).json({
        error: "Este convite é inválido, expirou ou já foi utilizado.",
      });
      return;
    }
    inviteId = invitation.id;

    const invitedEmail = String(invitation.email).toLowerCase();
    if (!invitedEmail.endsWith("@amo.delivery")) {
      await releaseInvitationClaim(input.invite_id, claimId);
      res.status(400).json({ error: "O convite não corresponde ao domínio permitido." });
      return;
    }

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: invitedEmail,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          name: input.nome,
          full_name: input.nome,
          team_invite_id: input.invite_id,
        },
      });

    let authUser = created.user;
    if (createError) {
      const existing = await findAuthUserByEmail(invitedEmail);
      if (!existing) throw createError;
      const { data: previousMember, error: previousMemberError } = await admin
        .from("membro_equipe")
        .select("auth_user_id,ativo")
        .eq("email", invitedEmail)
        .maybeSingle();
      if (previousMemberError) throw previousMemberError;
      const invitationRetry =
        existing.user_metadata?.team_invite_id === input.invite_id;
      const reactivation =
        previousMember?.auth_user_id === existing.id &&
        previousMember.ativo === false;
      if (!invitationRetry && !reactivation) {
        await releaseInvitationClaim(input.invite_id, claimId);
        res.status(409).json({
          error: "Este e-mail já está associado a outra conta.",
        });
        return;
      }
      const { data: updated, error: updateError } =
        await admin.auth.admin.updateUserById(existing.id, {
          password: input.password,
          email_confirm: true,
          user_metadata: {
            ...existing.user_metadata,
            name: input.nome,
            full_name: input.nome,
          },
        });
      if (updateError) throw updateError;
      authUser = updated.user;
    } else {
      createdAuthUser = true;
    }

    if (!authUser) throw new Error("Supabase não retornou a conta ativada.");
    createdUserId = authUser.id;

    const { data: completed, error: completionError } = await admin.rpc(
      "complete_team_invitation",
      {
        p_invite_id: input.invite_id,
        p_claim_id: claimId,
        p_auth_user_id: authUser.id,
        p_name: input.nome.trim(),
      },
    );
    if (completionError) throw completionError;
    if (completed !== true) {
      if (createdAuthUser) await admin.auth.admin.deleteUser(authUser.id);
      await releaseInvitationClaim(input.invite_id, claimId);
      res.status(400).json({
        error: "Este convite expirou durante a ativação. Solicite um novo convite.",
      });
      return;
    }
    invitationCompleted = true;

    const signedIn = await logInWithCredentials(invitedEmail, input.password);
    const sessionId = await createPersistentSession(
      signedIn.userId,
      signedIn.session,
    );
    setSessionCookie(res, sessionId);
    res.json(
      GetAuthSessionResponse.parse({
        authenticated: true,
        user: { id: signedIn.userId, email: signedIn.email },
      }),
    );
  } catch (error) {
    if (typeof inviteId === "string") {
      await releaseInvitationClaim(inviteId, claimId);
    }
    req.log.error(
      {
        invitationId: input.invite_id,
        createdUserId,
        technicalError: getTechnicalError(error),
      },
      "Team invitation acceptance failed",
    );
    res.status(503).json({
      error: invitationCompleted
        ? error instanceof InactiveTeamMemberError
          ? "A conta foi ativada, mas o acesso foi desativado antes da entrada. Peça ajuda a outro membro da equipe."
          : "A conta foi ativada, mas não foi possível iniciar a sessão. Entre pela página de login."
        : "Não foi possível ativar a conta. Tente novamente ou solicite um novo convite.",
    });
  }
});

router.post("/auth/password-recovery", async (req, res) => {
  const parsed = RequestPasswordRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Informe um e-mail válido." });
    return;
  }
  const ip = req.ip || "unknown";
  if (!allowRecoveryRequest(ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RECOVERY_WINDOW_MS / 1000)));
    res.status(429).json({ error: "Muitas solicitações. Tente novamente mais tarde." });
    return;
  }

  const genericMessage =
    "Se o e-mail corresponder a uma conta ativa, enviaremos um link de recuperação.";
  const email = parsed.data.email.trim().toLowerCase();
  const admin = supabaseAdminClient();
  try {
    const { data: member, error: memberError } = await admin
      .from("membro_equipe")
      .select("auth_user_id,nome,ativo,email")
      .eq("email", email)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member || member.ativo !== true) {
      publicRecoveryResponse(res);
      return;
    }

    const token = newOneTimeToken();
    const tokenHash = hashOneTimeToken(token);
    const { error: retireError } = await admin
      .from("token_recuperacao_senha")
      .update({ usado_em: new Date().toISOString() })
      .eq("auth_user_id", member.auth_user_id)
      .is("usado_em", null);
    if (retireError) throw retireError;

    const { error: insertError } = await admin
      .from("token_recuperacao_senha")
      .insert({
        auth_user_id: member.auth_user_id,
        token_hash: tokenHash,
        expira_em: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    if (insertError) throw insertError;

    const link = applicationUrl("reset-password", { token });
    const safeName = escapeHtml(String(member.nome));
    const safeLink = escapeHtml(link);
    try {
      await sendTransactionalEmail({
        to: email,
        subject: "Recupere seu acesso ao AmoConecta",
        text: `Olá, ${member.nome}. Use este link em até 30 minutos para definir uma nova senha: ${link}`,
        html: `<p>Olá, ${safeName}.</p><p>Use o link abaixo em até 30 minutos para definir uma nova senha.</p><p><a href="${safeLink}">Definir nova senha</a></p><p>Se você não solicitou a recuperação, ignore esta mensagem.</p>`,
        idempotencyKey: emailIdempotencyKey(`password-recovery:${tokenHash}`),
      });
    } catch (error) {
      await admin
        .from("token_recuperacao_senha")
        .update({ usado_em: new Date().toISOString() })
        .eq("token_hash", tokenHash);
      throw error;
    }

    await auditWithoutChangingResponse(req, {
      actor: systemAuditActor,
      action: "password_recovery_requested",
      entityType: "team_member",
      entityId: member.auth_user_id,
      metadata: { email },
    });
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Password recovery request could not be processed",
    );
  }
  publicRecoveryResponse(res);
});

router.post("/auth/password-recovery/complete", async (req, res) => {
  const parsed = CompletePasswordRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "O token ou a nova senha são inválidos." });
    return;
  }

  const claimId = randomUUID();
  const now = new Date();
  const { data: recovery, error: claimError } = await supabaseAdminClient()
    .from("token_recuperacao_senha")
    .update({
      claim_id: claimId,
      claim_expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
    })
    .eq("token_hash", hashOneTimeToken(parsed.data.token))
    .is("usado_em", null)
    .gt("expira_em", now.toISOString())
    .or(`claim_expires_at.is.null,claim_expires_at.lt.${now.toISOString()}`)
    .select("id,auth_user_id")
    .maybeSingle();
  if (claimError) {
    req.log.error(
      { technicalError: getTechnicalError(claimError) },
      "Password recovery token lookup failed",
    );
    res.status(503).json({ error: "Não foi possível validar o link agora." });
    return;
  }
  if (!recovery) {
    res.status(400).json({ error: "Este link é inválido, expirou ou já foi utilizado." });
    return;
  }

  const admin = supabaseAdminClient();
  const { data: consumed, error: consumeError } = await admin
    .from("token_recuperacao_senha")
    .update({
      usado_em: new Date().toISOString(),
      claim_id: null,
      claim_expires_at: null,
    })
    .eq("id", recovery.id)
    .eq("claim_id", claimId)
    .is("usado_em", null)
    .select("id")
    .maybeSingle();
  if (consumeError) {
    req.log.error(
      { technicalError: getTechnicalError(consumeError) },
      "Password recovery token could not be consumed",
    );
    res.status(503).json({ error: "Não foi possível validar o link. Solicite outro e-mail de recuperação." });
    return;
  }
  if (!consumed) {
    res.status(400).json({ error: "Este link é inválido, expirou ou já foi utilizado." });
    return;
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    recovery.auth_user_id,
    { password: parsed.data.password },
  );
  if (updateError) {
    req.log.error(
      { technicalError: getTechnicalError(updateError) },
      "Supabase password update failed",
    );
    res.status(503).json({
      error: "Não foi possível alterar a senha. Solicite um novo link de recuperação.",
    });
    return;
  }

  const sessionRevokeError = await revokeAllPersistentSessions(
    recovery.auth_user_id,
  ).catch((error: unknown) => error);
  if (sessionRevokeError) {
    req.log.error(
      { technicalError: getTechnicalError(sessionRevokeError) },
      "Sessions could not all be revoked after password recovery",
    );
  }

  await auditWithoutChangingResponse(req, {
    actor: systemAuditActor,
    action: "password_recovery_completed",
    entityType: "team_member",
    entityId: recovery.auth_user_id,
  });
  res.json({ message: "Sua senha foi alterada. Entre novamente com a nova senha." });
});

export default router;