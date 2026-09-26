import { useMemo, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleAlert, KeyRound, LoaderCircle, Mail, ShieldCheck } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, useLocation } from 'wouter';
import { z } from 'zod';
import {
  getGetAuthSessionQueryKey,
  useAcceptTeamInvitation,
  useCompletePasswordRecovery,
  useRequestPasswordRecovery,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'error' in error) {
    const value = (error as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function AccessBrand({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between" data-testid="access-brand">
      <Link href="/login" className="flex items-center gap-3" data-testid="link-access-brand">
        <span className="relative flex h-9 w-9 items-center justify-center rounded-[11px] bg-[#d7ef56] text-[#263044] shadow-[3px_3px_0_#e96527]">
          <span className="absolute h-3 w-3 rounded-full border-[3px] border-[#263044]" />
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#e96527]" />
        </span>
        <span className="leading-none"><span className="block text-[17px] font-extrabold tracking-[-0.05em]">amo</span><span className="block font-mono text-[9px] uppercase tracking-[.17em] opacity-70">conecta</span></span>
      </Link>
      <span className="font-mono text-[9px] uppercase tracking-[.16em] text-[#8b7d7d]">{label}</span>
    </div>
  );
}

function AccessLayout({ children, title, description, label }: { children: ReactNode; title: string; description: string; label: string }) {
  return (
    <main className="amo-noise min-h-[100dvh] bg-[#263044] lg:grid lg:grid-cols-[minmax(340px,.8fr)_minmax(480px,1.2fr)]" data-testid="page-access">
      <section className="relative hidden overflow-hidden p-10 text-[#fbf9f5] lg:flex lg:flex-col">
        <div className="absolute -right-28 -top-20 h-[380px] w-[380px] rounded-full border border-[#d7ef56]/20" />
        <div className="absolute bottom-[-150px] left-[-110px] h-[390px] w-[390px] rounded-full bg-[#e96527]" />
        <div className="absolute bottom-[-125px] left-[-95px] h-[295px] w-[295px] rounded-full bg-[#f4a766]" />
        <div className="relative z-10"><AccessBrand label="Ambiente privado" /></div>
        <div className="relative z-10 mt-auto max-w-md pb-7">
          <div className="mb-8 flex items-center gap-3 text-[#d7ef56]"><span className="h-px w-9 bg-[#d7ef56]" /><span className="font-mono text-[10px] uppercase tracking-[.2em]">Acesso controlado</span></div>
          <h1 className="text-[clamp(3rem,5vw,5.2rem)] font-extrabold leading-[.94] tracking-[-.075em]">A operação começa pela confiança.</h1>
          <p className="mt-8 max-w-sm text-[15px] leading-7 text-[#d5d7dd]">Convites individuais, credenciais protegidas e um registro claro para cada decisão de campanha.</p>
        </div>
      </section>
      <section className="amo-grid flex min-h-[100dvh] items-center justify-center bg-[#f5f0e8] px-5 py-10 sm:px-10">
        <div className="w-full max-w-[460px] animate-rise-in">
          <div className="mb-12 lg:hidden"><AccessBrand label={label} /></div>
          <div className="mb-9">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#d7ef56] text-[#263044] shadow-[3px_3px_0_#e96527]"><KeyRound size={19} /></div>
            <p className="section-kicker">{label}</p>
            <h1 className="mt-3 text-3xl font-extrabold tracking-[-.06em] text-[#263044] sm:text-[2.65rem]">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-[#6d7180]">{description}</p>
          </div>
          {children}
          <div className="mt-12 flex items-center gap-2 border-t border-[#e1d8cb] pt-5 text-[10px] leading-4 text-[#8a8790]"><ShieldCheck size={14} className="shrink-0 text-[#d35f2a]" /> Ambiente exclusivo para a operação da Amo Ofertas.</div>
        </div>
      </section>
    </main>
  );
}

const acceptSchema = z.object({
  nome: z.string().min(1, 'Informe seu nome.').max(120, 'Use até 120 caracteres.'),
  password: z.string().min(12, 'A senha precisa ter ao menos 12 caracteres.'),
  passwordConfirmation: z.string(),
}).refine((values) => values.password === values.passwordConfirmation, { path: ['passwordConfirmation'], message: 'As senhas precisam ser iguais.' });
type AcceptValues = z.infer<typeof acceptSchema>;

export function AcceptInvitePage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const inviteId = params.get('invite_id') ?? params.get('inviteId') ?? '';
  const token = params.get('token') ?? '';
  const accept = useAcceptTeamInvitation();
  const form = useForm<AcceptValues>({ resolver: zodResolver(acceptSchema), defaultValues: { nome: '', password: '', passwordConfirmation: '' } });
  const submit = (values: AcceptValues) => {
    accept.mutate({ data: { invite_id: inviteId, token, nome: values.nome, password: values.password } }, {
      onSuccess: (session) => { queryClient.setQueryData(getGetAuthSessionQueryKey(), session); setLocation('/'); },
    });
  };
  const missingToken = !inviteId || !token;
  return (
    <AccessLayout label="Convite de equipe" title="Seu acesso começa aqui." description="Defina seu nome e uma senha forte para entrar no espaço privado de campanhas.">
      {missingToken ? (
        <div className="rounded-2xl border border-[#e8c56f] bg-[#fff7dc] px-5 py-4 text-sm leading-6 text-[#74561c]" data-testid="status-invite-token-missing"><CircleAlert size={17} className="mr-2 inline" />Este convite está incompleto. Abra o link recebido por e-mail novamente.</div>
      ) : (
        <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate data-testid="form-accept-invite">
          <div><label htmlFor="invite-name" className="field-label">Seu nome</label><input id="invite-name" autoComplete="name" className="field-control" placeholder="Como a equipe deve chamar você" {...form.register('nome')} data-testid="input-invite-name" />{form.formState.errors.nome && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-invite-name">{form.formState.errors.nome.message}</p>}</div>
          <div><label htmlFor="invite-password" className="field-label">Senha</label><input id="invite-password" type="password" autoComplete="new-password" className="field-control" placeholder="Mínimo de 12 caracteres" {...form.register('password')} data-testid="input-invite-password" />{form.formState.errors.password && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-invite-password">{form.formState.errors.password.message}</p>}</div>
          <div><label htmlFor="invite-password-confirmation" className="field-label">Confirme a senha</label><input id="invite-password-confirmation" type="password" autoComplete="new-password" className="field-control" placeholder="Repita sua senha" {...form.register('passwordConfirmation')} data-testid="input-invite-password-confirmation" />{form.formState.errors.passwordConfirmation && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-invite-password-confirmation">{form.formState.errors.passwordConfirmation.message}</p>}</div>
          {accept.isError && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" role="alert" data-testid="status-accept-invite-error"><CircleAlert size={16} className="mr-2 inline" />{getErrorMessage(accept.error, 'Não foi possível aceitar o convite.')}</div>}
          <button type="submit" disabled={accept.isPending} className="action-button action-button-primary h-13 w-full" data-testid="button-accept-invite">{accept.isPending ? <><LoaderCircle size={17} className="animate-spin" /> Ativando acesso...</> : <>Criar acesso <ArrowRight size={17} /></>}</button>
        </form>
      )}
      <Link href="/login" className="mt-6 inline-flex items-center gap-2 text-xs font-bold text-[#687080] hover:text-[#263044]" data-testid="link-invite-login"><ArrowLeft size={14} /> Voltar para o login</Link>
    </AccessLayout>
  );
}

const recoveryRequestSchema = z.object({ email: z.string().email('Digite um e-mail válido.') });
type RecoveryRequestValues = z.infer<typeof recoveryRequestSchema>;

export function ForgotPasswordPage() {
  const recovery = useRequestPasswordRecovery();
  const [sent, setSent] = useState(false);
  const form = useForm<RecoveryRequestValues>({ resolver: zodResolver(recoveryRequestSchema), defaultValues: { email: '' } });
  const submit = (values: RecoveryRequestValues) => recovery.mutate({ data: values }, { onSuccess: () => setSent(true) });
  return (
    <AccessLayout label="Recuperar acesso" title="Vamos abrir uma nova porta." description="Informe seu e-mail de trabalho. Se houver uma conta, enviaremos as instruções para redefinir a senha.">
      {sent ? (
        <div className="rounded-2xl border border-[#b9d9bc] bg-[#eef7ee] px-5 py-5 text-sm leading-6 text-[#3f7b46]" role="status" data-testid="status-recovery-sent"><CheckCircle2 size={18} className="mr-2 inline" />Se o endereço estiver cadastrado, você receberá um link de recuperação em instantes.</div>
      ) : (
        <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate data-testid="form-forgot-password">
          <div><label htmlFor="recovery-email" className="field-label">E-mail de trabalho</label><div className="relative"><Mail size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#89909e]" /><input id="recovery-email" type="email" autoComplete="email" className="field-control pl-11" placeholder="voce@amoofertas.com.br" {...form.register('email')} data-testid="input-recovery-email" /></div>{form.formState.errors.email && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-recovery-email">{form.formState.errors.email.message}</p>}</div>
          {recovery.isError && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#a64220]" role="alert" data-testid="status-recovery-error"><CircleAlert size={16} className="mr-2 inline" />{getErrorMessage(recovery.error, 'Não foi possível solicitar a recuperação.')}</div>}
          <button type="submit" disabled={recovery.isPending} className="action-button action-button-primary h-13 w-full" data-testid="button-request-recovery">{recovery.isPending ? <><LoaderCircle size={17} className="animate-spin" /> Enviando...</> : <>Enviar instruções <ArrowRight size={17} /></>}</button>
        </form>
      )}
      <Link href="/login" className="mt-6 inline-flex items-center gap-2 text-xs font-bold text-[#687080] hover:text-[#263044]" data-testid="link-recovery-login"><ArrowLeft size={14} /> Voltar para o login</Link>
    </AccessLayout>
  );
}

const resetSchema = z.object({ password: z.string().min(12, 'A senha precisa ter ao menos 12 caracteres.'), confirmation: z.string() }).refine((values) => values.password === values.confirmation, { path: ['confirmation'], message: 'As senhas precisam ser iguais.' });
type ResetValues = z.infer<typeof resetSchema>;

export function ResetPasswordPage() {
  const [, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = params.get('token') ?? '';
  const complete = useCompletePasswordRecovery();
  const form = useForm<ResetValues>({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirmation: '' } });
  const submit = (values: ResetValues) => complete.mutate({ data: { token, password: values.password } }, { onSuccess: () => setLocation('/login?recovered=1') });
  return (
    <AccessLayout label="Nova senha" title="Proteja seu próximo acesso." description="Escolha uma senha única com pelo menos 12 caracteres para voltar à operação.">
      {!token ? <div className="rounded-2xl border border-[#e8c56f] bg-[#fff7dc] px-5 py-4 text-sm leading-6 text-[#74561c]" data-testid="status-reset-token-missing"><CircleAlert size={17} className="mr-2 inline" />O link de recuperação está incompleto ou expirou.</div> : (
        <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate data-testid="form-reset-password">
          <div><label htmlFor="reset-password" className="field-label">Nova senha</label><input id="reset-password" type="password" autoComplete="new-password" className="field-control" placeholder="Mínimo de 12 caracteres" {...form.register('password')} data-testid="input-reset-password" />{form.formState.errors.password && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-reset-password">{form.formState.errors.password.message}</p>}</div>
          <div><label htmlFor="reset-confirmation" className="field-label">Confirme a nova senha</label><input id="reset-confirmation" type="password" autoComplete="new-password" className="field-control" placeholder="Repita sua senha" {...form.register('confirmation')} data-testid="input-reset-confirmation" />{form.formState.errors.confirmation && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-reset-confirmation">{form.formState.errors.confirmation.message}</p>}</div>
          {complete.isError && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#a64220]" role="alert" data-testid="status-reset-error"><CircleAlert size={16} className="mr-2 inline" />{getErrorMessage(complete.error, 'Não foi possível definir a nova senha.')}</div>}
          <button type="submit" disabled={complete.isPending} className="action-button action-button-primary h-13 w-full" data-testid="button-complete-recovery">{complete.isPending ? <><LoaderCircle size={17} className="animate-spin" /> Salvando...</> : <>Salvar nova senha <ArrowRight size={17} /></>}</button>
        </form>
      )}
      <Link href="/login" className="mt-6 inline-flex items-center gap-2 text-xs font-bold text-[#687080] hover:text-[#263044]" data-testid="link-reset-login"><ArrowLeft size={14} /> Voltar para o login</Link>
    </AccessLayout>
  );
}