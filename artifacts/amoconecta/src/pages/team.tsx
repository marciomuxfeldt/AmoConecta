import { useMemo, useState } from 'react';
import { CircleAlert, Clock3, MailPlus, RefreshCw, RotateCw, Send, ShieldCheck, UserMinus, Users, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  getGetTeamAccessQueryKey,
  useCancelTeamInvitation,
  useCreateTeamInvitation,
  useDeactivateTeamMember,
  useGetTeamAccess,
  useResendTeamInvitation,
  type TeamMember,
  type TeamInvitation,
} from '@workspace/api-client-react';
import { Shell, type SessionUser } from './campaigns';

const inviteSchema = z.object({
  email: z.string()
    .email('Digite um e-mail válido.')
    .refine((value) => value.toLowerCase().endsWith('@amo.delivery'), {
      message: 'Use um endereço @amo.delivery.',
    }),
});
type InviteValues = z.infer<typeof inviteSchema>;

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Ainda não acessou';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date).replace('.', '');
}

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'error' in error) {
    const value = (error as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function TeamSkeleton() {
  return <div className="grid gap-5 lg:grid-cols-2" data-testid="status-team-loading">{[1, 2].map((section) => <div className="panel p-6" key={section}><div className="skeleton h-3 w-28 rounded-full" /><div className="skeleton mt-5 h-7 w-52 rounded-lg" /><div className="mt-8 space-y-4">{[1, 2, 3].map((row) => <div className="skeleton h-16 rounded-xl" key={row} />)}</div></div>)}</div>;
}

function MemberRow({
  member,
  onDeactivate,
  pending,
  currentUserEmail,
  activeCount,
}: {
  member: TeamMember;
  onDeactivate: (member: TeamMember) => void;
  pending: boolean;
  currentUserEmail: string;
  activeCount: number;
}) {
  const initials = member.nome.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const protectedLabel = member.email.toLowerCase() === currentUserEmail.toLowerCase()
    ? 'Sua conta'
    : activeCount <= 1
      ? 'Último membro ativo'
      : null;
  return (
    <div className="flex flex-col gap-4 border-b border-[#eee7dc] py-5 last:border-0 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-team-member-${member.user_id}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-extrabold ${member.ativo ? 'bg-[#263044] text-[#d7ef56]' : 'bg-[#ebe5dc] text-[#7d7e87]'}`} data-testid={`avatar-team-member-${member.user_id}`}>{initials || 'AM'}</div>
        <div className="min-w-0"><p className="truncate text-sm font-extrabold text-[#263044]" data-testid={`text-team-member-name-${member.user_id}`}>{member.nome}</p><p className="truncate text-xs text-[#85858b]" data-testid={`text-team-member-email-${member.user_id}`}>{member.email}</p><p className="mt-1 font-mono text-[9px] uppercase tracking-[.08em] text-[#a29b98]">{member.ativo ? `Último acesso: ${dateLabel(member.ultimo_acesso_em)}` : `Desativado em ${dateLabel(member.desativado_em)}`}</p></div>
      </div>
      {member.ativo
        ? protectedLabel
          ? <span className="status-pill bg-[#eee9e1] text-[#8a8790]" data-testid={`status-team-member-protected-${member.user_id}`}><ShieldCheck size={12} /> {protectedLabel}</span>
          : <button type="button" onClick={() => onDeactivate(member)} disabled={pending} className="action-button action-button-danger self-start !px-3 sm:self-auto" data-testid={`button-deactivate-member-${member.user_id}`}><UserMinus size={14} /> Desativar</button>
        : <span className="status-pill bg-[#eee9e1] text-[#8a8790]" data-testid={`status-team-member-inactive-${member.user_id}`}><span className="status-dot" /> Inativo</span>}
    </div>
  );
}

function InviteRow({ invite, onCancel, onResend, pending }: { invite: TeamInvitation; onCancel: (invite: TeamInvitation) => void; onResend: (invite: TeamInvitation) => void; pending: boolean }) {
  return <div className="flex flex-col gap-4 border-b border-[#eee7dc] py-5 last:border-0 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-team-invite-${invite.id}`}><div className="min-w-0"><p className="truncate text-sm font-extrabold text-[#263044]" data-testid={`text-team-invite-email-${invite.id}`}>{invite.email}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-[#85858b]"><Clock3 size={13} className="text-[#d35f2a]" /> Expira em {dateLabel(invite.expira_em)}</p><p className="mt-1 font-mono text-[9px] uppercase tracking-[.08em] text-[#a29b98]">Enviado por {invite.convidado_por_nome}</p></div><div className="flex gap-2 self-start sm:self-auto"><button type="button" onClick={() => onResend(invite)} disabled={pending} className="action-button action-button-secondary !px-3" data-testid={`button-resend-invite-${invite.id}`}><RotateCw size={14} /> Reenviar</button><button type="button" onClick={() => onCancel(invite)} disabled={pending} className="action-button action-button-danger !px-3" data-testid={`button-cancel-invite-${invite.id}`}><X size={14} /> Cancelar</button></div></div>;
}

export default function TeamPage({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient();
  const teamQuery = useGetTeamAccess({ query: { queryKey: getGetTeamAccessQueryKey() } });
  const createInvite = useCreateTeamInvitation();
  const resendInvite = useResendTeamInvitation();
  const cancelInvite = useCancelTeamInvitation();
  const deactivate = useDeactivateTeamMember();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');
  const [confirmMember, setConfirmMember] = useState<TeamMember | null>(null);
  const form = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: '' } });
  const team = teamQuery.data;
  const activeCount = useMemo(() => team?.membros.filter((member) => member.ativo).length ?? 0, [team]);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: getGetTeamAccessQueryKey() }); };
  const submitInvite = (values: InviteValues) => {
    setFormError(''); setNotice('');
    createInvite.mutate({ data: values }, { onSuccess: () => { form.reset(); setNotice('Convite enviado.'); refresh(); }, onError: (error) => setFormError(errorMessage(error, 'Não foi possível enviar o convite.')) });
  };
  const runAction = (action: 'resend' | 'cancel', invite: TeamInvitation) => {
    setNotice(''); setFormError('');
    const mutation = action === 'resend' ? resendInvite : cancelInvite;
    mutation.mutate({ inviteId: invite.id }, { onSuccess: () => { setNotice(action === 'resend' ? 'Convite reenviado e prazo renovado.' : 'Convite cancelado.'); refresh(); }, onError: (error) => setFormError(errorMessage(error, 'Não foi possível atualizar o convite.')) });
  };
  const deactivateMember = () => {
    if (!confirmMember) return;
    deactivate.mutate({ userId: confirmMember.user_id }, { onSuccess: () => { setConfirmMember(null); setNotice('Membro desativado.'); refresh(); }, onError: (error) => setFormError(errorMessage(error, 'Não foi possível desativar o membro.')) });
  };
  return <Shell user={user} title="Equipe" eyebrow="Acesso e governança" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
    {teamQuery.isLoading ? <TeamSkeleton /> : teamQuery.isError ? <div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-team-error"><CircleAlert className="mx-auto text-[#bd4f26]" size={24} /><h2 className="mt-4 font-extrabold text-[#8e3a20]">A equipe não carregou.</h2><p className="mt-2 text-sm text-[#a65d46]">Não conseguimos consultar os acessos agora.</p><button type="button" onClick={() => teamQuery.refetch()} className="action-button action-button-primary mt-5" data-testid="button-team-retry"><RefreshCw size={14} /> Tentar novamente</button></div> : <div className="animate-rise-in-delay space-y-5">
      <div className="grid gap-3 sm:grid-cols-3"><div className="panel p-5"><span className="section-kicker">Membros ativos</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-active-member-count">{activeCount}</strong><span className="mt-1 block text-xs text-[#7d7e87]">com acesso ao console</span></div><div className="panel p-5"><span className="section-kicker">Convites abertos</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-pending-invite-count">{team?.convites.length ?? 0}</strong><span className="mt-1 block text-xs text-[#7d7e87]">aguardando aceite</span></div><div className="panel p-5"><span className="section-kicker">Regra do espaço</span><strong className="mt-3 block text-sm font-extrabold text-[#263044]" data-testid="text-team-access-rule">Convite individual</strong><span className="mt-1 block text-xs text-[#7d7e87]">sem acesso compartilhado</span></div></div>
      {(notice || formError) && <div className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${formError ? 'border border-[#efc9ba] bg-[#fff0e9] text-[#a64220]' : 'border border-[#b9d9bc] bg-[#eef7ee] text-[#3f7b46]'}`} role={formError ? 'alert' : 'status'} data-testid={formError ? 'status-team-action-error' : 'status-team-action-success'}><ShieldCheck size={16} className="mt-0.5 shrink-0" />{formError || notice}</div>}
      <div className="grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
        <section className="panel p-6 sm:p-8" data-testid="panel-create-invite"><div className="flex items-start gap-4"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#263044] text-[#d7ef56]"><MailPlus size={20} /></div><div><p className="section-kicker">Abrir acesso</p><h2 className="mt-2 text-2xl font-extrabold tracking-[-.06em] text-[#263044]">Convide alguém da operação.</h2><p className="mt-2 text-sm leading-6 text-[#747783]">O convite é de uso único e expira automaticamente. A pessoa define o próprio nome e senha.</p></div></div><form onSubmit={form.handleSubmit(submitInvite)} className="mt-8 space-y-4" noValidate data-testid="form-create-invite"><div><label htmlFor="team-invite-email" className="field-label">E-mail de trabalho</label><input id="team-invite-email" type="email" autoComplete="email" className="field-control" placeholder="nova.pessoa@amo.delivery" {...form.register('email')} data-testid="input-team-invite-email" />{form.formState.errors.email && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-team-invite-email">{form.formState.errors.email.message}</p>}<p className="mt-1.5 text-xs text-[#7d7e87]">Aceitamos apenas endereços @amo.delivery.</p></div><button type="submit" disabled={createInvite.isPending} className="action-button action-button-primary" data-testid="button-create-invite">{createInvite.isPending ? <><RefreshCw size={15} className="animate-spin" /> Enviando...</> : <><Send size={15} /> Enviar convite</>}</button></form></section>
        <section className="panel p-6 sm:p-8" data-testid="panel-team-members">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="section-kicker">Acesso atual</p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-[-.06em] text-[#263044]">Membros da equipe</h2>
              <p className="mt-2 text-xs text-[#747783]">Todos os membros ativos têm as mesmas permissões.</p>
            </div>
            <Users size={22} className="text-[#d35f2a]" />
          </div>
          {team?.membros.length ? (
            <div className="mt-4">
              {team.membros.map((member) => (
                <MemberRow
                  key={member.user_id}
                  member={member}
                  onDeactivate={setConfirmMember}
                  pending={deactivate.isPending}
                  currentUserEmail={user?.email ?? ''}
                  activeCount={activeCount}
                />
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-dashed border-[#cdbfae] bg-[#f8f3ec] px-5 py-8 text-center text-sm text-[#7d7e87]" data-testid="empty-team-members">
              Nenhum membro encontrado.
            </div>
          )}
        </section>
      </div>
      <section className="panel p-6 sm:p-8" data-testid="panel-pending-invites"><div className="flex items-end justify-between gap-4"><div><p className="section-kicker">Aguardando aceite</p><h2 className="mt-2 text-2xl font-extrabold tracking-[-.06em] text-[#263044]">Convites pendentes</h2></div><span className="font-mono text-[10px] uppercase tracking-[.12em] text-[#979198]">{team?.convites.length ?? 0} registros</span></div>{team?.convites.length ? <div className="mt-4">{team.convites.map((invite) => <InviteRow key={invite.id} invite={invite} onCancel={(item) => runAction('cancel', item)} onResend={(item) => runAction('resend', item)} pending={resendInvite.isPending || cancelInvite.isPending} />)}</div> : <div className="mt-6 rounded-xl border border-dashed border-[#cdbfae] bg-[#f8f3ec] px-5 py-8 text-center text-sm text-[#7d7e87]" data-testid="empty-team-invites">Nenhum convite pendente.</div>}</section>
    </div>}
    {confirmMember && <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#263044]/35 px-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="deactivate-title" data-testid="dialog-deactivate-member"><div className="w-full max-w-md rounded-2xl border border-[#e3dbcf] bg-[#fbf9f5] p-6 shadow-[0_22px_60px_rgba(38,48,68,.2)]"><p className="section-kicker">Revisar alteração</p><h2 id="deactivate-title" className="mt-2 text-xl font-extrabold text-[#263044]">Desativar {confirmMember.nome}?</h2><p className="mt-2 text-sm leading-6 text-[#6d7180]">O histórico de campanhas permanece, mas esta pessoa perde o acesso ao console.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setConfirmMember(null)} className="action-button action-button-secondary" data-testid="button-cancel-deactivate-member">Voltar</button><button type="button" onClick={deactivateMember} disabled={deactivate.isPending} className="action-button action-button-danger" data-testid="button-confirm-deactivate-member">{deactivate.isPending ? <RefreshCw size={15} className="animate-spin" /> : <UserMinus size={15} />} Desativar acesso</button></div></div></div>}
  </Shell>;
}