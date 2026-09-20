import { type ReactNode, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CircleAlert,
  KeyRound,
  Link2,
  LoaderCircle,
  Mail,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  getGetAuthSessionQueryKey,
  useGetAuthSession,
  useLogin,
} from '@workspace/api-client-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import { CampaignDetailPage, CampaignsPage, NewCampaignPage } from '@/pages/campaigns';

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

function AmoMark() {
  return (
    <div className="flex items-center gap-3" data-testid="brand-amoconecta">
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
        <div className="w-52 space-y-2"><div className="skeleton mx-auto h-2 w-28 rounded-full" /><div className="skeleton h-2 w-full rounded-full" /></div>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#6d7180]">Verificando acesso</span>
      </div>
    </div>
  );
}

function SessionError({ retry }: { retry: () => void }) {
  return (
    <div className="amo-noise flex min-h-[100dvh] items-center justify-center bg-[#f5f0e8] px-6">
      <div className="panel w-full max-w-md p-8 text-center" data-testid="status-session-error">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[#fbe9e1] text-[#c75221]"><CircleAlert size={22} /></div>
        <p className="section-kicker">Acesso indisponível</p>
        <h1 className="mt-3 text-xl font-extrabold tracking-[-0.04em] text-[#263044]">Não conseguimos validar sua sessão.</h1>
        <p className="mt-2 text-sm leading-6 text-[#6d7180]">Tente novamente. Se o problema continuar, fale com a equipe de tecnologia.</p>
        <button onClick={retry} className="action-button action-button-primary mt-6" data-testid="button-session-retry"><RefreshCw size={15} /> Tentar novamente</button>
      </div>
    </div>
  );
}

function LoginPage() {
  const [, setLocation] = useLocation();
  const queryClientForLogin = useQueryClient();
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
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
        <div className="absolute -right-36 -top-28 h-[440px] w-[440px] rounded-full border border-[#d7ef56]/20" /><div className="absolute -right-20 -top-12 h-[290px] w-[290px] rounded-full border border-[#d7ef56]/20" /><div className="absolute bottom-[-140px] left-[-110px] h-[390px] w-[390px] rounded-full bg-[#e96527] opacity-90" /><div className="absolute bottom-[-125px] left-[-95px] h-[295px] w-[295px] rounded-full bg-[#f4a766]" />
        <div className="relative z-10 flex items-center justify-between"><AmoMark /><span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d7ef56]">Ambiente privado</span></div>
        <div className="relative z-10 mt-auto max-w-lg pb-7">
          <div className="mb-8 flex items-center gap-3 text-[#d7ef56]"><span className="h-px w-9 bg-[#d7ef56]" /><span className="font-mono text-[10px] uppercase tracking-[0.2em]">Centro de comando</span></div>
          <h1 className="max-w-md text-[clamp(3.5rem,6vw,5.7rem)] font-extrabold leading-[.92] tracking-[-0.075em]">Toda entrega começa com uma boa mensagem.</h1>
          <p className="mt-8 max-w-sm text-[15px] leading-7 text-[#d5d7dd]">O espaço da Amo Ofertas para planejar e validar campanhas com clareza operacional.</p>
          <div className="mt-14 flex items-center gap-5 text-[11px] text-[#c2c6ce]"><span className="flex items-center gap-2"><ShieldCheck size={15} className="text-[#d7ef56]" /> Acesso controlado</span><span className="h-1 w-1 rounded-full bg-[#e96527]" /><span className="flex items-center gap-2"><Link2 size={14} className="text-[#d7ef56]" /> Operação conectada</span></div>
        </div>
      </section>
      <section className="amo-grid flex min-h-[100dvh] items-center justify-center bg-[#f5f0e8] px-5 py-10 sm:px-10">
        <div className="w-full max-w-[420px] animate-rise-in">
          <div className="mb-12 flex items-center justify-between lg:hidden"><AmoMark /><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#7b6870]">Acesso privado</span></div>
          <div className="mb-9"><div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#d7ef56] text-[#263044] shadow-[3px_3px_0_#e96527]"><KeyRound size={19} strokeWidth={2.3} /></div><p className="section-kicker">Entrar no AmoConecta</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-0.06em] text-[#263044] sm:text-[2.65rem]">Bom ter você de volta.</h2><p className="mt-3 text-sm leading-6 text-[#6d7180]">Use suas credenciais de operação para acessar o controle de campanhas.</p></div>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate>
            <div><label htmlFor="email" className="field-label">E-mail de trabalho</label><div className="relative"><Mail size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#89909e]" /><input id="email" type="email" autoComplete="email" placeholder="voce@amoofertas.com.br" {...form.register('email')} className="field-control pl-11" data-testid="input-email" /></div>{form.formState.errors.email && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-email">{form.formState.errors.email.message}</p>}</div>
            <div><div className="mb-2 flex items-center justify-between"><label htmlFor="password" className="field-label mb-0">Senha</label><span className="font-mono text-[9px] uppercase tracking-[0.08em] text-[#92939a]">Uso interno</span></div><div className="relative"><KeyRound size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#89909e]" /><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Digite sua senha" {...form.register('password')} className="field-control px-11" data-testid="input-password" /><button type="button" onClick={() => setShowPassword((visible) => !visible)} className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[#737986] hover:text-[#263044]" data-testid="button-toggle-password">{showPassword ? 'ocultar' : 'mostrar'}</button></div>{form.formState.errors.password && <p className="mt-1.5 text-xs font-medium text-[#bd4f26]" data-testid="error-password">{form.formState.errors.password.message}</p>}</div>
            {login.isError && <div className="flex items-start gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-login-error"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{getErrorMessage(login.error, 'Não foi possível entrar. Confira seus dados e tente novamente.')}</span><button type="button" onClick={() => login.reset()} className="focus-ring ml-auto rounded p-0.5" aria-label="Fechar aviso" data-testid="button-dismiss-login-error"><X size={14} /></button></div>}
            <button type="submit" disabled={login.isPending} className="action-button action-button-primary h-13 w-full" data-testid="button-login">{login.isPending ? <><LoaderCircle size={17} className="animate-spin" /> Entrando...</> : <>Acessar o painel <ArrowRight size={17} /></>}</button>
          </form>
          <div className="mt-14 flex items-center gap-3 border-t border-[#e1d8cb] pt-5 text-[10px] leading-4 text-[#8a8790]"><ShieldCheck size={15} className="shrink-0 text-[#d35f2a]" /><span>Este ambiente é exclusivo para a operação de marketing da Amo Ofertas.</span></div>
        </div>
      </section>
    </main>
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
  const user = sessionQuery.data?.user ? { email: sessionQuery.data.user.email } : null;
  return (
    <Switch>
      <Route path="/login">{authenticated ? <CampaignsPage user={user} /> : <LoginPage />}</Route>
      <Route path="/campaigns/new">{authenticated ? <NewCampaignPage user={user} /> : <LoginPage />}</Route>
      <Route path="/campaigns/:campaignId">{(params) => authenticated ? <CampaignDetailPage user={user} campaignId={params.campaignId ?? ''} /> : <LoginPage />}</Route>
      <Route path="/">{authenticated ? <CampaignsPage user={user} /> : <LoginPage />}</Route>
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