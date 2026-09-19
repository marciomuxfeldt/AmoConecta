import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  getGetAuthSessionQueryKey,
  getListCampaignsQueryKey,
  useGetAuthSession,
  useListCampaigns,
  useLogin,
  useLogout,
} from '@workspace/api-client-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  ArrowRight,
  CircleAlert,
  Clock3,
  Inbox,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

const loginSchema = z.object({
  email: z.string().email('Digite um e-mail válido.'),
  password: z.string().min(1, 'Digite sua senha.'),
});
type LoginValues = z.infer<typeof loginSchema>;

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'error' in error) {
    const value = (error as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function AmoMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`} data-testid="brand-amoconecta">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[#d7ef56] text-[#263044] shadow-[3px_3px_0_hsl(24_86%_50%)]">
        <span className="absolute h-3 w-3 rounded-full border-[3px] border-[#263044]" />
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#e96527]" />
      </span>
      <span className="leading-none">
        <span className="block text-[17px] font-extrabold tracking-[-0.05em]">amo</span>
        <span className="block font-mono text-[9px] font-medium uppercase tracking-[0.17em] opacity-70">conecta</span>
      </span>
    </div>
  );
}

function SessionLoading() {
  return (
    <div className="amo-noise flex min-h-[100dvh] items-center justify-center bg-[#f5f0e8] px-6">
      <div className="flex flex-col items-center gap-5 text-center" data-testid="status-session-loading">
        <AmoMark />
        <div className="w-52 space-y-2">
          <div className="skeleton mx-auto h-2 w-28 rounded-full" />
          <div className="skeleton h-2 w-full rounded-full" />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#6d7180]">Verificando acesso</span>
      </div>
    </div>
  );
}

function SessionError({ retry }: { retry: () => void }) {
  return (
    <div className="amo-noise flex min-h-[100dvh] items-center justify-center bg-[#f5f0e8] px-6">
      <div className="w-full max-w-md rounded-2xl border border-[#e5ddd0] bg-[#fbf9f5] p-8 text-center shadow-[0_18px_55px_rgba(38,48,68,.08)]" data-testid="status-session-error">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[#fbe9e1] text-[#c75221]">
          <CircleAlert size={22} />
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8a6270]">Acesso indisponível</p>
        <h1 className="mt-3 text-xl font-extrabold tracking-[-0.04em] text-[#263044]">Não conseguimos validar sua sessão.</h1>
        <p className="mt-2 text-sm leading-6 text-[#6d7180]">Tente novamente. Se o problema continuar, fale com a equipe de tecnologia.</p>
        <button onClick={retry} className="focus-ring mt-6 inline-flex items-center gap-2 rounded-xl bg-[#263044] px-5 py-3 text-sm font-bold text-[#fbf9f5] transition hover:-translate-y-0.5 hover:bg-[#303b55]" data-testid="button-session-retry">
          <RefreshCw size={15} /> Tentar novamente
        </button>
      </div>
    </div>
  );
}

function LoginPage() {
  const [, setLocation] = useLocation();
  const queryClientForLogin = useQueryClient();
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const submit = (values: LoginValues) => {
    login.mutate({ data: values }, {
      onSuccess: (session) => {
        queryClientForLogin.setQueryData(getGetAuthSessionQueryKey(), session);
        setLocation('/');
      },
    });
  };

  return (
    <main className="amo-noise grid min-h-[100dvh] bg-[#263044] lg:grid-cols-[minmax(420px,0.92fr)_minmax(480px,1.08fr)]" data-testid="page-login">
      <section className="relative hidden overflow-hidden bg-[#263044] p-10 text-[#fbf9f5] lg:flex lg:flex-col">
        <div className="absolute -right-36 -top-28 h-[440px] w-[440px] rounded-full border border-[#d7ef56]/20" />
        <div className="absolute -right-20 -top-12 h-[290px] w-[290px] rounded-full border border-[#d7ef56]/20" />
        <div className="absolute bottom-[-140px] left-[-110px] h-[390px] w-[390px] rounded-full bg-[#e96527] opacity-90" />
        <div className="absolute bottom-[-125px] left-[-95px] h-[295px] w-[295px] rounded-full bg-[#f4a766]" />
        <div className="relative z-10 flex items-center justify-between">
          <AmoMark />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d7ef56]">Ambiente privado</span>
        </div>
        <div className="relative z-10 mt-auto max-w-lg pb-7">
          <div className="mb-8 flex items-center gap-3 text-[#d7ef56]">
            <span className="h-px w-9 bg-[#d7ef56]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em]">Centro de comando</span>
          </div>
          <h1 className="max-w-md text-[clamp(3.5rem,6vw,5.7rem)] font-extrabold leading-[.92] tracking-[-0.075em]">Toda entrega começa com uma boa mensagem.</h1>
          <p className="mt-8 max-w-sm text-[15px] leading-7 text-[#d5d7dd]">O espaço da Amo Ofertas para planejar, acompanhar e enviar campanhas com clareza.</p>
          <div className="mt-14 flex items-center gap-5 text-[11px] text-[#c2c6ce]">
            <span className="flex items-center gap-2"><ShieldCheck size={15} className="text-[#d7ef56]" /> Acesso controlado</span>
            <span className="h-1 w-1 rounded-full bg-[#e96527]" />
            <span className="flex items-center gap-2"><Link2 size={14} className="text-[#d7ef56]" /> Operação conectada</span>
          </div>
        </div>
      </section>

      <section className="amo-grid flex min-h-[100dvh] items-center justify-center bg-[#f5f0e8] px-5 py-10 sm:px-10">
        <div className="w-full max-w-[420px] animate-rise-in">
          <div className="mb-12 flex items-center justify-between lg:hidden">
            <AmoMark />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#7b6870]">Acesso privado</span>
          </div>
          <div className="mb-9">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#d7ef56] text-[#263044] shadow-[3px_3px_0_#e96527]">
              <KeyRound size={19} strokeWidth={2.3} />
            </div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d35f2a]">Entrar no AmoConecta</p>
            <h2 className="mt-3 text-3xl font-extrabold tracking-[-0.06em] text-[#263044] sm:text-[2.65rem]">Bom ter você de volta.</h2>
            <p className="mt-3 text-sm leading-6 text-[#6d7180]">Use suas credenciais de operação para acessar o controle de campanhas.</p>
          </div>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate>
            <div>
              <label htmlFor="email" className="mb-2 block text-xs font-bold text-[#42495b]">E-mail de trabalho</label>
              <div className="relative">
                <Mail size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#89909e]" />
                <input id="email" type="email" autoComplete="email" placeholder="voce@amoofertas.com.br" {...form.register('email')} className="focus-ring h-13 w-full rounded-xl border border-[#dcd3c5] bg-[#fbf9f5] pl-11 pr-4 text-sm text-[#263044] outline-none transition placeholder:text-[#a7a7aa] focus:border-[#e96527]" data-testid="input-email" />
              </div>
              {form.formState.errors.email && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-email">{form.formState.errors.email.message}</p>}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="password" className="block text-xs font-bold text-[#42495b]">Senha</label>
                <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-[#92939a]">Uso interno</span>
              </div>
              <div className="relative">
                <KeyRound size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#89909e]" />
                <input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Digite sua senha" {...form.register('password')} className="focus-ring h-13 w-full rounded-xl border border-[#dcd3c5] bg-[#fbf9f5] px-11 text-sm text-[#263044] outline-none transition placeholder:text-[#a7a7aa] focus:border-[#e96527]" data-testid="input-password" />
                <button type="button" onClick={() => setShowPassword((visible) => !visible)} className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[#737986] hover:text-[#263044]" data-testid="button-toggle-password">
                  {showPassword ? 'ocultar' : 'mostrar'}
                </button>
              </div>
              {form.formState.errors.password && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-password">{form.formState.errors.password.message}</p>}
            </div>
            {login.isError && (
              <div className="flex items-start gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-login-error">
                <CircleAlert size={17} className="mt-0.5 shrink-0" />
                <span>{getErrorMessage(login.error, 'Não foi possível entrar. Confira seus dados e tente novamente.')}</span>
                <button type="button" onClick={() => login.reset()} className="focus-ring ml-auto rounded p-0.5" aria-label="Fechar aviso" data-testid="button-dismiss-login-error"><X size={14} /></button>
              </div>
            )}
            <button type="submit" disabled={login.isPending} className="focus-ring group flex h-13 w-full items-center justify-center gap-3 rounded-xl bg-[#263044] text-sm font-extrabold text-[#fbf9f5] shadow-[0_8px_0_#d7ef56] transition hover:-translate-y-0.5 hover:bg-[#303b55] active:translate-y-0 active:shadow-[0_4px_0_#d7ef56] disabled:cursor-wait disabled:opacity-70" data-testid="button-login">
              {login.isPending ? <><LoaderCircle size={17} className="animate-spin" /> Entrando...</> : <>Acessar o painel <ArrowRight size={17} className="transition-transform group-hover:translate-x-1" /></>}
            </button>
          </form>
          <div className="mt-14 flex items-center gap-3 border-t border-[#e1d8cb] pt-5 text-[10px] leading-4 text-[#8a8790]">
            <ShieldCheck size={15} className="shrink-0 text-[#d35f2a]" />
            <span>Este ambiente é exclusivo para a operação de marketing da Amo Ofertas.</span>
          </div>
        </div>
      </section>
    </main>
  );
}

const statusLabels: Record<string, string> = {
  rascunho: 'Rascunho',
  agendada: 'Agendada',
  enviando: 'Enviando',
  pausada: 'Pausada',
  concluida: 'Concluída',
};

function formatNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date).replace('.', '');
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`} data-testid={`status-campaign-${status}`}><span className="status-dot" />{statusLabels[status] ?? status}</span>;
}

function CampaignSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e3dbcf] bg-[#fbf9f5]">
      <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-4 border-b border-[#eee7dc] px-6 py-4 md:grid">
        {Array.from({ length: 6 }).map((_, index) => <div key={index} className="skeleton h-2 rounded-full" />)}
      </div>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="grid grid-cols-2 gap-4 border-b border-[#eee7dc] px-5 py-5 last:border-0 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] md:px-6">
          <div className="skeleton h-4 w-36 rounded-full" /><div className="skeleton h-5 w-20 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function CampaignTable({ campaigns }: { campaigns: Array<{ id: string; nome: string; status: string; enviados: number; entregues: number; abertos: number; clicados: number; agendada_para: string | null; criado_em: string }> }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e3dbcf] bg-[#fbf9f5] shadow-[0_12px_35px_rgba(38,48,68,.045)]" data-testid="campaign-list">
      <div className="hidden grid-cols-[2fr_1.1fr_.8fr_.8fr_.8fr_1fr] gap-4 border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-3 font-mono text-[9px] uppercase tracking-[0.14em] text-[#8b8d96] md:grid">
        <span>Campanha</span><span>Status</span><span>Enviados</span><span>Entregues</span><span>Abertos</span><span>Próximo passo</span>
      </div>
      {campaigns.map((campaign) => (
        <div key={campaign.id} className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-[#eee7dc] px-5 py-5 transition-colors last:border-0 hover:bg-[#f8f3ec] md:grid-cols-[2fr_1.1fr_.8fr_.8fr_.8fr_1fr] md:items-center md:px-6" data-testid={`row-campaign-${campaign.id}`}>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-[#263044]" data-testid={`text-campaign-name-${campaign.id}`}>{campaign.nome}</p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[#99959a]">Criada em {formatDate(campaign.criado_em)}</p>
          </div>
          <div><StatusPill status={campaign.status} /></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.enviados)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">enviados</span></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.entregues)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">entregues</span></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.abertos)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">abertos</span></div>
          <div className="col-span-2 border-t border-[#f0e9e0] pt-3 md:col-span-1 md:border-0 md:pt-0"><span className="flex items-center gap-2 text-xs font-semibold text-[#6d7180]"><Clock3 size={13} className="text-[#d35f2a]" /> {campaign.agendada_para ? formatDate(campaign.agendada_para) : 'Sem agendamento'}</span></div>
        </div>
      ))}
    </div>
  );
}

function EmptyCampaigns() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#e3dbcf] bg-[#fbf9f5] px-6 py-16 text-center shadow-[0_12px_35px_rgba(38,48,68,.045)] sm:px-10 sm:py-24" data-testid="empty-campaigns">
      <div className="absolute left-1/2 top-0 h-1 w-24 -translate-x-1/2 bg-[#d7ef56]" />
      <div className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-[26px] border border-[#e4daca] bg-[#f5efe7] text-[#d35f2a] shadow-[8px_8px_0_#f0e3d2]">
        <Inbox size={33} strokeWidth={1.5} />
        <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#fbf9f5] bg-[#d7ef56]" />
      </div>
      <p className="mt-9 font-mono text-[10px] uppercase tracking-[0.2em] text-[#d35f2a]">Tudo pronto por aqui</p>
      <h2 className="mt-3 text-2xl font-extrabold tracking-[-0.05em] text-[#263044] sm:text-[2rem]">Seu espaço de envio está livre.</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#747783]">Quando uma campanha estiver disponível, ela aparecerá nesta lista para você acompanhar cada etapa da operação.</p>
      <div className="mx-auto mt-10 flex max-w-md items-center justify-center gap-3 border-t border-[#eee6db] pt-6 text-[10px] uppercase tracking-[0.13em] text-[#99959a]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#d7ef56]" /> Base pronta <span className="h-1.5 w-1.5 rounded-full bg-[#e96527]" /> Operação em espera
      </div>
    </div>
  );
}

function CampaignsPage({ user }: { user: { email: string } | null }) {
  const logout = useLogout();
  const queryClientForLogout = useQueryClient();
  const campaignsQuery = useListCampaigns({ query: { enabled: true, queryKey: getListCampaignsQueryKey() } });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [, setLocation] = useLocation();
  const campaigns = useMemo(() => campaignsQuery.data ?? [], [campaignsQuery.data]);

  const doLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClientForLogout.setQueryData(getGetAuthSessionQueryKey(), { authenticated: false, user: null });
        setLocation('/login');
      },
    });
  };

  return (
    <div className="amo-noise min-h-[100dvh] bg-[#f5f0e8] text-[#263044]" data-testid="page-campaigns">
      <aside className={`fixed inset-y-0 left-0 z-30 flex w-[252px] flex-col bg-[#263044] px-5 py-6 text-[#fbf9f5] shadow-[12px_0_38px_rgba(38,48,68,.08)] transition-transform duration-300 md:translate-x-0 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between px-2"><AmoMark /><button onClick={() => setMobileNavOpen(false)} className="focus-ring rounded-lg p-1 text-[#cbd0d4] md:hidden" data-testid="button-close-navigation"><X size={18} /></button></div>
        <div className="mt-14 px-2"><p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#aab2bd]">Espaço de trabalho</p><nav className="mt-3"><Link href="/" onClick={() => setMobileNavOpen(false)} className="focus-ring flex items-center gap-3 rounded-xl bg-[#354157] px-3 py-3 text-sm font-bold text-[#fbf9f5]" data-testid="link-campaigns"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#d7ef56] text-[#263044]"><Mail size={15} /></span>Campanhas</Link></nav></div>
        <div className="mt-auto rounded-2xl border border-[#3b475c] bg-[#2d3950] p-4"><div className="flex items-center gap-2 text-[#d7ef56]"><span className="h-2 w-2 rounded-full bg-[#d7ef56]" /><span className="font-mono text-[9px] uppercase tracking-[0.16em]">Sistema operacional</span></div><p className="mt-3 text-xs leading-5 text-[#c4cad2]">A base do seu controle de campanhas está pronta.</p></div>
        {logout.isError && <p className="mb-3 px-2 text-[10px] leading-4 text-[#f0a387]" data-testid="status-logout-error">Não foi possível sair. Tente novamente.</p>}
        <div className="mt-5 flex items-center justify-between border-t border-[#3b475c] px-2 pt-5"><div className="min-w-0"><p className="truncate text-xs font-bold text-[#fbf9f5]" data-testid="text-sidebar-email">{user?.email ?? 'Operação Amo'}</p><p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ca7b5]">Marketing</p></div><button onClick={doLogout} disabled={logout.isPending} className="focus-ring rounded-lg p-2 text-[#aab2bd] transition hover:bg-[#3b475c] hover:text-[#d7ef56] disabled:opacity-50" aria-label="Sair do AmoConecta" data-testid="button-logout"><LogOut size={16} /></button></div>
      </aside>
      {mobileNavOpen && <button aria-label="Fechar menu" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-20 bg-[#263044]/35 backdrop-blur-sm md:hidden" data-testid="button-dismiss-navigation" />}
      <div className="min-h-[100dvh] md:pl-[252px]">
        <header className="flex h-[76px] items-center justify-between border-b border-[#e6ded3] bg-[#f8f3ec]/90 px-5 backdrop-blur sm:px-8 md:px-10">
          <button onClick={() => setMobileNavOpen(true)} className="focus-ring rounded-lg p-2 text-[#263044] md:hidden" aria-label="Abrir menu" data-testid="button-open-navigation"><Menu size={20} /></button>
          <div className="hidden items-center gap-2 md:flex"><span className="h-2 w-2 rounded-full bg-[#d7ef56]" /><span className="font-mono text-[10px] uppercase tracking-[0.17em] text-[#777984]">Amo Ofertas <span className="px-1 text-[#d1c7b9]">/</span> Controle interno</span></div>
          <div className="ml-auto flex items-center gap-3"><span className="hidden font-mono text-[10px] text-[#8c8b91] sm:block" data-testid="text-header-email">{user?.email}</span><div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e96527] text-xs font-extrabold text-[#fbf9f5]" data-testid="avatar-operator">{user?.email?.slice(0, 1).toUpperCase() ?? 'A'}</div></div>
        </header>
        <main className="mx-auto max-w-[1420px] px-5 pb-16 pt-10 sm:px-8 sm:pt-14 md:px-10">
          <div className="animate-rise-in flex flex-col justify-between gap-7 border-b border-[#e1d8cc] pb-9 lg:flex-row lg:items-end">
            <div><p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#d35f2a]">Visão geral</p><h1 className="mt-3 text-[2.7rem] font-extrabold leading-none tracking-[-0.075em] text-[#263044] sm:text-5xl">Campanhas</h1><p className="mt-4 max-w-lg text-sm leading-6 text-[#727682]">Um ponto de vista claro sobre o que está pronto para chegar aos clientes.</p></div>
            <div className="flex items-center gap-3"><div className="flex items-center gap-2 rounded-full border border-[#ded5c8] bg-[#fbf9f5] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#7d7e87]" data-testid="status-workspace"><span className="h-1.5 w-1.5 rounded-full bg-[#63a76f]" /> ambiente ativo</div><span className="hidden h-8 w-px bg-[#ddd3c6] sm:block" /><span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[#9b9897] sm:block">Fase 01</span></div>
          </div>
          <div className="animate-rise-in-delay pt-8">
            <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#263044]">Todas as campanhas</h2><p className="mt-1 text-xs text-[#85858b]" data-testid="text-campaign-count">{campaigns.length === 1 ? '1 campanha registrada' : `${formatNumber(campaigns.length)} campanhas registradas`}</p></div><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#989498]"><Search size={14} /> Somente leitura</div></div>
            {campaignsQuery.isLoading ? <CampaignSkeleton /> : campaignsQuery.isError ? <div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-campaign-error"><CircleAlert className="mx-auto text-[#bd4f26]" size={24} /><h3 className="mt-4 font-bold text-[#8e3a20]">A lista não carregou.</h3><p className="mt-2 text-sm text-[#a65d46]">Não conseguimos consultar suas campanhas agora.</p><button onClick={() => campaignsQuery.refetch()} className="focus-ring mt-5 inline-flex items-center gap-2 rounded-xl bg-[#263044] px-4 py-2.5 text-xs font-bold text-[#fbf9f5]" data-testid="button-campaigns-retry"><RefreshCw size={14} /> Tentar novamente</button></div> : campaigns.length === 0 ? <EmptyCampaigns /> : <CampaignTable campaigns={campaigns} />}
          </div>
          <footer className="mt-10 flex flex-col justify-between gap-3 border-t border-[#e1d8cc] pt-5 text-[10px] text-[#a19c99] sm:flex-row"><span className="font-mono uppercase tracking-[0.1em]">AmoConecta · Fundação operacional</span><span className="flex items-center gap-1.5"><Sparkles size={12} className="text-[#d35f2a]" /> Feito para manter o foco no que importa</span></footer>
        </main>
      </div>
    </div>
  );
}

function Router() {
  const [location, setLocation] = useLocation();
  const sessionQuery = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey() } });
  const authenticated = Boolean(sessionQuery.data?.authenticated);
  useEffect(() => {
    if (location === '/login' && authenticated) setLocation('/');
  }, [authenticated, location, setLocation]);
  if (sessionQuery.isLoading) return <SessionLoading />;
  if (sessionQuery.isError) return <SessionError retry={() => sessionQuery.refetch()} />;
  if (location === '/login' && authenticated) return null;
  return (
    <Switch>
      <Route path="/login">{authenticated ? <CampaignsPage user={sessionQuery.data?.user ?? null} /> : <LoginPage />}</Route>
      <Route path="/">{authenticated ? <CampaignsPage user={sessionQuery.data?.user ?? null} /> : <LoginPage />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <RoutedErrorBoundary><Router /></RoutedErrorBoundary>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;