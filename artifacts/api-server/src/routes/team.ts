import { Router, type IRouter, type Request, type Response } from "express";
import {
  CancelTeamInvitationParams,
  CreateTeamInvitationBody,
  CreateTeamInvitationResponse,
  DeactivateTeamMemberParams,
  DeactivateTeamMemberResponse,
  GetTeamAccessResponse,
  ResendTeamInvitationParams,
  ResendTeamInvitationResponse,
} from "@workspace/api-zod";
import {
  getSupabaseUser,
  revokeAllPersistentSessions,
} from "../lib/auth-session";
import {
  recordAuditEvent,
  teamAuditActor,
} from "../lib/audit-events";
import {
  applicationUrl,
  emailIdempotencyKey,
  escapeHtml,
  sendTransactionalEmail,
} from "../lib/transactional-email";
import { getTechnicalError } from "../lib/technical-error";
import { supabaseAdminClient } from "../lib/supabase";
import { hashOneTimeToken, newOneTimeToken } from "../lib/auth-session";

const router: IRouter = Router();
const INVITATION_DURATION_MS = 7 * 24 * 60 * 60_000;

async function requireTeamSession(req: Request, res: Response) {
  const session = await getSupabaseUser(req, res);
  if (!session) {
    res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    return null;
  }
  return session;
}

async function recordTeamAudit(
  req: Request,
  event: Parameters<typeof recordAuditEvent>[0],
): Promise<void> {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    req.log.error(
      {
        action: event.action,
        technicalError: getTechnicalError(error),
      },
      "Could not persist team action audit event",
    );
  }
}

async function sendInvitationEmail(
  invitation: {
    id: string;
    email: string;
    convidado_por_nome: string;
  },
  token: string,
): Promise<void> {
  const link = applicationUrl("accept-invite", {
    invite_id: invitation.id,
    token,
  });
  const safeLink = escapeHtml(link);
  const safeInviter = escapeHtml(invitation.convidado_por_nome);
  const tokenHash = hashOneTimeToken(token);
  await sendTransactionalEmail({
    to: invitation.email,
    subject: "Convite para acessar o AmoConecta",
    text: `${invitation.convidado_por_nome} convidou você para acessar o AmoConecta. Ative sua conta em até 7 dias: ${link}`,
    html: `<p>${safeInviter} convidou você para acessar o AmoConecta.</p><p>O convite expira em 7 dias. Abra o link para escolher seu nome e senha:</p><p><a href="${safeLink}">Ativar minha conta</a></p><p>Se você não esperava este convite, ignore esta mensagem.</p>`,
    idempotencyKey: emailIdempotencyKey(
      `team-invitation:${invitation.id}:${tokenHash}`,
    ),
  });
}

router.get("/team", async (req, res) => {
  if (!(await requireTeamSession(req, res))) return;
  try {
    const admin = supabaseAdminClient();
    const [membersResult, invitationsResult] = await Promise.all([
      admin
        .from("membro_equipe")
        .select(
          "auth_user_id,email,nome,ativo,criado_em,ultimo_acesso_em,desativado_em",
        )
        .order("ativo", { ascending: false })
        .order("criado_em", { ascending: true }),
      admin
        .from("convite_equipe")
        .select(
          "id,email,criado_em,expira_em,convidado_por_nome,convidado_por_email",
        )
        .is("aceito_em", null)
        .is("cancelado_em", null)
        .order("criado_em", { ascending: false }),
    ]);
    if (membersResult.error) throw membersResult.error;
    if (invitationsResult.error) throw invitationsResult.error;

    res.json(
      GetTeamAccessResponse.parse({
        membros: (membersResult.data ?? []).map((member) => ({
          user_id: member.auth_user_id,
          email: member.email,
          nome: member.nome,
          ativo: member.ativo,
          criado_em: member.criado_em,
          ultimo_acesso_em: member.ultimo_acesso_em,
          desativado_em: member.desativado_em,
        })),
        convites: invitationsResult.data ?? [],
      }),
    );
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Team access list could not be loaded",
    );
    res.status(503).json({
      error: "Não foi possível carregar os acessos da equipe. Verifique a migração.",
    });
  }
});

router.post("/team/invites", async (req, res) => {
  const parsed = CreateTeamInvitationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Informe um e-mail válido." });
    return;
  }
  const session = await requireTeamSession(req, res);
  if (!session) return;
  const email = parsed.data.email.trim().toLowerCase();
  if (!/^[^\s@]+@amo\.delivery$/iu.test(email)) {
    res.status(400).json({
      error: "Só é possível convidar endereços do domínio @amo.delivery.",
    });
    return;
  }
  if (!session.user.email) {
    res.status(503).json({ error: "Não foi possível identificar quem enviará o convite." });
    return;
  }

  const admin = supabaseAdminClient();
  try {
    const { data: existingMember, error: memberError } = await admin
      .from("membro_equipe")
      .select("auth_user_id,ativo")
      .eq("email", email)
      .maybeSingle();
    if (memberError) throw memberError;
    if (existingMember?.ativo) {
      res.status(400).json({ error: "Este e-mail já tem acesso ativo à equipe." });
      return;
    }

    const { data: existingInvite, error: inviteLookupError } = await admin
      .from("convite_equipe")
      .select("id")
      .eq("email", email)
      .is("aceito_em", null)
      .is("cancelado_em", null)
      .maybeSingle();
    if (inviteLookupError) throw inviteLookupError;
    if (existingInvite) {
      res.status(400).json({
        error: "Já existe um convite pendente para este e-mail. Reenvie-o pela lista.",
      });
      return;
    }

    const token = newOneTimeToken();
    const expiresAt = new Date(Date.now() + INVITATION_DURATION_MS).toISOString();
    const { data: invitation, error: insertError } = await admin
      .from("convite_equipe")
      .insert({
        email,
        token_hash: hashOneTimeToken(token),
        convidado_por: session.user.id,
        convidado_por_nome: session.user.name,
        convidado_por_email: session.user.email,
        expira_em: expiresAt,
      })
      .select(
        "id,email,criado_em,expira_em,convidado_por_nome,convidado_por_email",
      )
      .single();
    if (insertError) throw insertError;

    try {
      await sendInvitationEmail(invitation, token);
    } catch (error) {
      await admin
        .from("convite_equipe")
        .update({ cancelado_em: new Date().toISOString() })
        .eq("id", invitation.id);
      throw error;
    }

    await recordTeamAudit(req, {
      actor: teamAuditActor(session.user),
      action: "team_invitation_created",
      entityType: "team_invitation",
      entityId: invitation.id,
      metadata: { email },
    });
    res
      .status(201)
      .json(CreateTeamInvitationResponse.parse(invitation));
  } catch (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Team invitation could not be sent",
    );
    res.status(503).json({
      error: "Não foi possível enviar o convite. Verifique o remetente transacional.",
    });
  }
});

router.post("/team/invites/:inviteId/resend", async (req, res) => {
  const params = ResendTeamInvitationParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de convite inválido." });
    return;
  }
  const session = await requireTeamSession(req, res);
  if (!session) return;

  const admin = supabaseAdminClient();
  const { data: previous, error: readError } = await admin
    .from("convite_equipe")
    .select(
      "id,email,token_hash,criado_em,expira_em,claim_id,claim_expires_at,convidado_por,convidado_por_nome,convidado_por_email",
    )
    .eq("id", params.data.inviteId)
    .is("aceito_em", null)
    .is("cancelado_em", null)
    .maybeSingle();
  if (readError) {
    req.log.error(
      { technicalError: getTechnicalError(readError) },
      "Pending invitation could not be loaded for resend",
    );
    res.status(503).json({ error: "Não foi possível carregar o convite." });
    return;
  }
  if (!previous) {
    res.status(404).json({ error: "Convite pendente não encontrado." });
    return;
  }

  const token = newOneTimeToken();
  const nextHash = hashOneTimeToken(token);
  const now = new Date().toISOString();
  const nextExpiry = new Date(Date.now() + INVITATION_DURATION_MS).toISOString();
  const { data: updated, error: updateError } = await admin
    .from("convite_equipe")
    .update({
      token_hash: nextHash,
      criado_em: now,
      expira_em: nextExpiry,
      claim_id: null,
      claim_expires_at: null,
      convidado_por: session.user.id,
      convidado_por_nome: session.user.name,
      convidado_por_email: session.user.email,
    })
    .eq("id", previous.id)
    .is("aceito_em", null)
    .is("cancelado_em", null)
    .select(
      "id,email,criado_em,expira_em,convidado_por_nome,convidado_por_email",
    )
    .maybeSingle();
  if (updateError || !updated) {
    req.log.error(
      { technicalError: getTechnicalError(updateError) },
      "Pending invitation could not be updated for resend",
    );
    res.status(503).json({ error: "Não foi possível atualizar o convite." });
    return;
  }

  try {
    await sendInvitationEmail(updated, token);
  } catch (error) {
    await admin
      .from("convite_equipe")
      .update({
        token_hash: previous.token_hash,
        criado_em: previous.criado_em,
        expira_em: previous.expira_em,
        claim_id: previous.claim_id,
        claim_expires_at: previous.claim_expires_at,
        convidado_por: previous.convidado_por,
        convidado_por_nome: previous.convidado_por_nome,
        convidado_por_email: previous.convidado_por_email,
      })
      .eq("id", previous.id)
      .eq("token_hash", nextHash);
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Team invitation resend email failed",
    );
    res.status(503).json({ error: "Não foi possível reenviar o convite." });
    return;
  }

  await recordTeamAudit(req, {
    actor: teamAuditActor(session.user),
    action: "team_invitation_resent",
    entityType: "team_invitation",
    entityId: previous.id,
    metadata: { email: previous.email },
  });
  res.json(
    ResendTeamInvitationResponse.parse({
      message: "O convite foi reenviado e agora expira em 7 dias.",
    }),
  );
});

router.post("/team/invites/:inviteId/cancel", async (req, res) => {
  const params = CancelTeamInvitationParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de convite inválido." });
    return;
  }
  const session = await requireTeamSession(req, res);
  if (!session) return;
  const now = new Date().toISOString();
  const { data: cancelled, error } = await supabaseAdminClient()
    .from("convite_equipe")
    .update({
      cancelado_em: now,
      claim_id: null,
      claim_expires_at: null,
    })
    .eq("id", params.data.inviteId)
    .is("aceito_em", null)
    .is("cancelado_em", null)
    .select("id,email")
    .maybeSingle();
  if (error) {
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Team invitation cancellation failed",
    );
    res.status(503).json({ error: "Não foi possível cancelar o convite." });
    return;
  }
  if (!cancelled) {
    res.status(404).json({ error: "Convite pendente não encontrado." });
    return;
  }

  await recordTeamAudit(req, {
    actor: teamAuditActor(session.user),
    action: "team_invitation_cancelled",
    entityType: "team_invitation",
    entityId: cancelled.id,
    metadata: { email: cancelled.email },
  });
  res.status(204).send();
});

router.post("/team/users/:userId/deactivate", async (req, res) => {
  const params = DeactivateTeamMemberParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de usuário inválido." });
    return;
  }
  const session = await requireTeamSession(req, res);
  if (!session) return;
  if (params.data.userId === session.user.id) {
    res.status(409).json({ error: "Você não pode desativar a própria conta." });
    return;
  }

  const { data: deactivated, error } = await supabaseAdminClient().rpc(
    "deactivate_team_member",
    {
      p_target_user_id: params.data.userId,
      p_actor_user_id: session.user.id,
      p_actor_name: session.user.name,
      p_actor_email: session.user.email,
    },
  );
  if (error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("self_deactivation") ||
      message.includes("last_active_member")
    ) {
      res.status(409).json({
        error: message.includes("self_deactivation")
          ? "Você não pode desativar a própria conta."
          : "A equipe precisa manter pelo menos um membro ativo.",
      });
      return;
    }
    if (message.includes("member_not_active")) {
      res.status(404).json({ error: "Membro ativo não encontrado." });
      return;
    }
    if (message.includes("actor_not_active")) {
      res.status(403).json({
        error: "Sua conta não tem mais acesso ativo ao AmoConecta.",
      });
      return;
    }
    req.log.error(
      { technicalError: getTechnicalError(error) },
      "Team member deactivation failed",
    );
    res.status(503).json({ error: "Não foi possível desativar o membro." });
    return;
  }
  if (deactivated !== true) {
    res.status(404).json({ error: "Membro ativo não encontrado." });
    return;
  }

  const revokeError = await revokeAllPersistentSessions(params.data.userId);
  if (revokeError) {
    req.log.error(
      {
        targetUserId: params.data.userId,
        technicalError: getTechnicalError(revokeError),
      },
      "Supabase did not confirm global sign-out after team deactivation",
    );
  }
  res.json(
    DeactivateTeamMemberResponse.parse({
      message: "Membro desativado e sessões do AmoConecta revogadas.",
    }),
  );
});

export default router;