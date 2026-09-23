import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCheck2,
  Inbox,
  Link2,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  Pause,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserRound,
  X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import {
  CampaignStatus,
  type Campaign,
  type CampaignRecipientSummary,
  type CampaignListItem,
  type CreateCampaignInput,
  type ImportValidationJob,
  type ImportValidationSummary,
  type UpdateCampaignInput,
  getGetCampaignQueryKey,
  getGetCampaignRecipientSummaryQueryKey,
  getGetCampaignImportQueryKey,
  getGetAuthSessionQueryKey,
  getListCampaignsQueryKey,
  getGetSafetyModeQueryKey,
  useGetCampaignDefaults,
  useCreateCampaign,
  useClearCampaignRecipients,
  useDeleteCampaign,
  useGetCampaign,
  useGetCampaignRecipientSummary,
  useGetCampaignImport,
  useListCampaigns,
  useGetSafetyMode,
  useLogout,
  useRequestCampaignImportUploadUrl,
  useSendCampaignTest,
  useScheduleCampaign,
  usePauseCampaign,
  useResumeCampaign,
  useCancelCampaign,
  useUpdateCampaign,
  useValidateCampaignImport,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { type EmailBlock, normalizeEmailBlocks } from '@workspace/email-template';
import { EmailEditor } from '../components/EmailEditor';

type SessionUser = { email: string } | null;

const statusLabels: Record<string, string> = {
  rascunho: 'Rascunho',
  agendada: 'Agendada',
  enviando: 'Enviando',
  pausada: 'Pausada',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

const statusDescriptions: Record<string, string> = {
  rascunho: 'Metadados em preparação',
  agendada: 'Pronta para a janela definida',
  enviando: 'Operação em andamento',
  pausada: 'Aguardando uma decisão',
  concluida: 'Operação finalizada',
  cancelada: 'Operação cancelada',
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object') {
    const record = error as { error?: unknown; data?: unknown };
    if (typeof record.error === 'string') return record.error;
    if (record.data && typeof record.data === 'object' && 'error' in record.data) {
      const value = (record.data as { error?: unknown }).error;
      if (typeof value === 'string') return value;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR').format(value ?? 0);
}

function formatPercentage(value: number) {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function reputationTone(percentual: number, limit: number) {
  if (percentual >= limit) {
    return {
      card: 'border-[#efc9ba] bg-[#fff0e9]',
      value: 'text-[#a64220]',
      badge: 'bg-[#bd4f26] text-[#fffaf6]',
      label: 'No limite de pausa',
    };
  }
  if (percentual >= limit / 2) {
    return {
      card: 'border-[#e8c56f] bg-[#fff7dc]',
      value: 'text-[#8a651c]',
      badge: 'bg-[#d5a42e] text-[#fffaf6]',
      label: 'Atenção',
    };
  }
  return {
    card: 'border-[#b9d9bc] bg-[#eef7ee]',
    value: 'text-[#3f7b46]',
    badge: 'bg-[#63a76f] text-[#fffaf6]',
    label: 'Dentro da faixa',
  };
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date).replace('.', '');
}

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nullableNumber(value: string) {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toServerDate(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function isHttpUrl(value: string) {
  return /^https?:\/\/[^\s]+$/iu.test(value.trim());
}

function validateEmailBlocks(blocks: EmailBlock[]) {
  for (const block of blocks) {
    if (block.type === 'image') {
      if (!block.src || !isHttpUrl(block.src)) return 'Envie uma imagem antes de salvar o bloco de imagem.';
      if (block.href?.trim() && !isHttpUrl(block.href)) return 'O link opcional da imagem precisa começar com https:// ou http://.';
    }
    if (block.type === 'button') {
      if (!block.label.trim()) return 'Informe o rótulo de todos os botões.';
      if (!isHttpUrl(block.href)) return 'Informe um destino válido para todos os botões.';
    }
  }
  return null;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-${status}`} data-testid={`status-campaign-${status}`}>
      <span className="status-dot" />
      {statusLabels[status] ?? status}
    </span>
  );
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

function Shell({
  user,
  children,
  title,
  eyebrow,
  mobileNavOpen,
  setMobileNavOpen,
}: {
  user: SessionUser;
  children: ReactNode;
  title: string;
  eyebrow: string;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
}) {
  const logout = useLogout();
  const safetyModeQuery = useGetSafetyMode({
    query: { queryKey: getGetSafetyModeQueryKey() },
  });
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const doLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(getGetAuthSessionQueryKey(), { authenticated: false, user: null });
        setLocation('/login');
      },
    });
  };

  return (
    <div className="amo-noise min-h-[100dvh] bg-[#f5f0e8] text-[#263044]" data-testid="app-shell">
      <aside className={`fixed inset-y-0 left-0 z-30 flex w-[252px] flex-col bg-[#263044] px-5 py-6 text-[#fbf9f5] shadow-[12px_0_38px_rgba(38,48,68,.08)] transition-transform duration-300 md:translate-x-0 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between px-2">
          <AmoMark />
          <button onClick={() => setMobileNavOpen(false)} className="focus-ring rounded-lg p-1 text-[#cbd0d4] md:hidden" data-testid="button-close-navigation" aria-label="Fechar menu">
            <X size={18} />
          </button>
        </div>
        <div className="mt-14 px-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#aab2bd]">Espaço de trabalho</p>
          <nav className="mt-3">
            <Link href="/" onClick={() => setMobileNavOpen(false)} className="focus-ring flex items-center gap-3 rounded-xl bg-[#354157] px-3 py-3 text-sm font-bold text-[#fbf9f5]" data-testid="link-campaigns">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#d7ef56] text-[#263044]"><Mail size={15} /></span>
              Campanhas
            </Link>
          </nav>
        </div>
        <div className="mt-auto rounded-2xl border border-[#3b475c] bg-[#2d3950] p-4">
          <div className="flex items-center gap-2 text-[#d7ef56]">
            <span className="h-2 w-2 rounded-full bg-[#d7ef56]" />
            <span className="font-mono text-[9px] uppercase tracking-[0.16em]">Sistema operacional</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#c4cad2]">Metadados claros. Importações validadas. Decisões sem ruído.</p>
        </div>
        {logout.isError && <p className="mb-3 px-2 text-[10px] leading-4 text-[#f0a387]" data-testid="status-logout-error">Não foi possível sair. Tente novamente.</p>}
        <div className="mt-5 flex items-center justify-between border-t border-[#3b475c] px-2 pt-5">
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-[#fbf9f5]" data-testid="text-sidebar-email">{user?.email ?? 'Operação Amo'}</p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ca7b5]">Marketing</p>
          </div>
          <button onClick={doLogout} disabled={logout.isPending} className="focus-ring rounded-lg p-2 text-[#aab2bd] transition hover:bg-[#3b475c] hover:text-[#d7ef56] disabled:opacity-50" aria-label="Sair do AmoConecta" data-testid="button-logout">
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {mobileNavOpen && <button aria-label="Fechar menu" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-20 bg-[#263044]/35 backdrop-blur-sm md:hidden" data-testid="button-dismiss-navigation" />}
      <div className="min-h-[100dvh] md:pl-[252px]">
        <header className="flex h-[76px] items-center justify-between border-b border-[#e6ded3] bg-[#f8f3ec]/90 px-5 backdrop-blur sm:px-8 md:px-10">
          <button onClick={() => setMobileNavOpen(true)} className="focus-ring rounded-lg p-2 text-[#263044] md:hidden" aria-label="Abrir menu" data-testid="button-open-navigation"><Menu size={20} /></button>
          <div className="hidden items-center gap-2 md:flex">
            <span className="h-2 w-2 rounded-full bg-[#d7ef56]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.17em] text-[#777984]">Amo Ofertas <span className="px-1 text-[#d1c7b9]">/</span> Operação</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[10px] text-[#8c8b91] sm:block" data-testid="text-header-email">{user?.email}</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e96527] text-xs font-extrabold text-[#fbf9f5]" data-testid="avatar-operator">{user?.email?.slice(0, 1).toUpperCase() ?? 'A'}</div>
          </div>
        </header>
        <main className="mx-auto max-w-[1420px] px-5 pb-16 pt-10 sm:px-8 sm:pt-14 md:px-10">
          {safetyModeQuery.data?.message && (
            <div
              className="mb-7 flex items-start gap-3 rounded-2xl border border-[#e8c56f] bg-[#fff7dc] px-4 py-3 text-sm leading-6 text-[#74561c]"
              role="status"
              data-testid="status-safety-mode"
            >
              <ShieldCheck size={18} className="mt-1 shrink-0 text-[#b47b1c]" />
              <div>
                <strong className="font-bold">{safetyModeQuery.data.message}</strong>
                <p className="text-xs text-[#8a6b2c]">
                  A operação permanece bloqueada até a liberação explícita do ambiente.
                </p>
              </div>
            </div>
          )}
          <div className="animate-rise-in mb-9 flex flex-col justify-between gap-6 border-b border-[#e1d8cc] pb-8 lg:flex-row lg:items-end">
            <div>
              <p className="section-kicker">{eyebrow}</p>
              <h1 className="mt-3 text-[2.7rem] font-extrabold leading-none tracking-[-0.075em] text-[#263044] sm:text-5xl" data-testid="text-page-title">{title}</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-full border border-[#ded5c8] bg-[#fbf9f5] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#7d7e87]" data-testid="status-workspace">
                <span className="h-1.5 w-1.5 rounded-full bg-[#63a76f]" /> ambiente ativo
              </div>
              <span className="hidden h-8 w-px bg-[#ddd3c6] sm:block" />
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[#9b9897] sm:block">Fase 02</span>
            </div>
          </div>
          {children}
          <footer className="mt-10 flex flex-col justify-between gap-3 border-t border-[#e1d8cc] pt-5 text-[10px] text-[#a19c99] sm:flex-row">
            <span className="font-mono uppercase tracking-[0.1em]">AmoConecta · Fundação operacional</span>
            <span className="flex items-center gap-1.5"><ShieldCheck size={12} className="text-[#d35f2a]" /> Ambiente privado da operação</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function CampaignSkeleton() {
  return (
    <div className="panel overflow-hidden" data-testid="status-campaign-loading">
      <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-4 md:grid">
        {Array.from({ length: 5 }).map((_, index) => <div key={index} className="skeleton h-2 rounded-full" />)}
      </div>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="grid grid-cols-2 gap-4 border-b border-[#eee7dc] px-5 py-5 last:border-0 md:grid-cols-[2fr_1fr_1fr_1fr_1fr] md:px-6">
          <div className="skeleton h-4 w-40 rounded-full" /><div className="skeleton h-5 w-20 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function CampaignTable({ campaigns }: { campaigns: CampaignListItem[] }) {
  return (
    <div className="panel overflow-hidden" data-testid="campaign-list">
      <div className="hidden grid-cols-[2fr_1fr_.8fr_.8fr_.8fr_1.2fr] gap-4 border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-3 font-mono text-[9px] uppercase tracking-[0.14em] text-[#8b8d96] md:grid">
        <span>Campanha</span><span>Status</span><span>Destinatários</span><span>Enviados</span><span>Entregues</span><span>Próximo passo</span>
      </div>
      {campaigns.map((campaign) => (
        <Link href={`/campaigns/${campaign.id}`} key={campaign.id} className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-[#eee7dc] px-5 py-5 transition-colors last:border-0 hover:bg-[#f8f3ec] md:grid-cols-[2fr_1fr_.8fr_.8fr_.8fr_1.2fr] md:items-center md:px-6" data-testid={`row-campaign-${campaign.id}`}>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-[#263044]" data-testid={`text-campaign-name-${campaign.id}`}>{campaign.nome}</p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[#99959a]">Criada em {formatDate(campaign.criado_em)}</p>
          </div>
          <div><StatusPill status={campaign.status} /></div>
          <div><span className="text-sm font-bold tabular-nums text-[#263044]">{formatNumber(campaign.destinatarios_total)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">destinatários</span></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.enviados)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">enviados</span></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.entregues)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">entregues</span></div>
          <div className="col-span-2 border-t border-[#f0e9e0] pt-3 md:col-span-1 md:border-0 md:pt-0">
            <span className="flex items-center gap-2 text-xs font-semibold text-[#6d7180]"><Clock3 size={13} className="text-[#d35f2a]" /> {campaign.agendada_para ? formatDate(campaign.agendada_para) : 'Sem agendamento'}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

function EmptyCampaigns() {
  return (
    <div className="panel relative overflow-hidden px-6 py-16 text-center sm:px-10 sm:py-24" data-testid="empty-campaigns">
      <div className="absolute left-1/2 top-0 h-1 w-24 -translate-x-1/2 bg-[#d7ef56]" />
      <div className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-[26px] border border-[#e4daca] bg-[#f5efe7] text-[#d35f2a] shadow-[8px_8px_0_#f0e3d2]">
        <Inbox size={33} strokeWidth={1.5} /><span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#fbf9f5] bg-[#d7ef56]" />
      </div>
      <p className="mt-9 section-kicker">Primeira operação</p>
      <h2 className="mt-3 text-2xl font-extrabold tracking-[-0.05em] text-[#263044] sm:text-[2rem]">Comece pela mensagem certa.</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#747783]">Crie a campanha, confirme seus metadados e depois valide a base de destinatários antes de qualquer decisão de envio.</p>
      <div className="mx-auto mt-10 flex max-w-md items-center justify-center gap-3 border-t border-[#eee6db] pt-6 text-[10px] uppercase tracking-[0.13em] text-[#99959a]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#d7ef56]" /> Clareza primeiro <span className="h-1.5 w-1.5 rounded-full bg-[#e96527]" /> Envio depois
      </div>
    </div>
  );
}

export function CampaignsPage({ user }: { user: SessionUser }) {
  const campaignsQuery = useListCampaigns({ query: { queryKey: getListCampaignsQueryKey() } });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const campaigns = campaignsQuery.data ?? [];
  const counts = useMemo(() => ({
    total: campaigns.length,
    scheduled: campaigns.filter((campaign) => campaign.status === CampaignStatus.agendada).length,
    drafts: campaigns.filter((campaign) => campaign.status === CampaignStatus.rascunho).length,
  }), [campaigns]);

  return (
    <Shell user={user} title="Campanhas" eyebrow="Visão geral" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
      <div className="animate-rise-in-delay">
        <div className="mb-8 grid gap-3 sm:grid-cols-3">
          <div className="panel p-4"><span className="section-kicker">No espaço</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-campaign-count">{formatNumber(counts.total)}</strong><span className="mt-1 block text-xs text-[#7d7e87]">campanhas registradas</span></div>
          <div className="panel p-4"><span className="section-kicker">Em preparação</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-draft-count">{formatNumber(counts.drafts)}</strong><span className="mt-1 block text-xs text-[#7d7e87]">rascunhos em aberto</span></div>
          <div className="panel p-4"><span className="section-kicker">Próxima janela</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-scheduled-count">{formatNumber(counts.scheduled)}</strong><span className="mt-1 block text-xs text-[#7d7e87]">campanhas agendadas</span></div>
        </div>
        <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div><h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#263044]">Todas as campanhas</h2><p className="mt-1 text-xs text-[#85858b]">O ponto de partida para cada importação validada.</p></div>
          <Link href="/campaigns/new" className="action-button action-button-primary" data-testid="link-new-campaign"><span className="text-lg leading-none">+</span> Nova campanha <ArrowRight size={15} /></Link>
        </div>
        {campaignsQuery.isLoading ? <CampaignSkeleton /> : campaignsQuery.isError ? (
          <div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-campaign-error">
            <CircleAlert className="mx-auto text-[#bd4f26]" size={24} /><h3 className="mt-4 font-bold text-[#8e3a20]">A lista não carregou.</h3><p className="mt-2 text-sm text-[#a65d46]">Não conseguimos consultar suas campanhas agora.</p>
            <button onClick={() => campaignsQuery.refetch()} className="action-button action-button-primary mt-5" data-testid="button-campaigns-retry"><RefreshCw size={14} /> Tentar novamente</button>
          </div>
        ) : campaigns.length === 0 ? <EmptyCampaigns /> : <CampaignTable campaigns={campaigns} />}
        <div className="mt-5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.12em] text-[#969298]"><ShieldCheck size={13} className="text-[#d35f2a]" /> A lista é atualizada ao entrar e após cada alteração.</div>
      </div>
    </Shell>
  );
}

type CampaignFormValues = {
  nome: string;
  assunto: string;
  preheader: string;
  assunto_lembrete: string;
  remetente_nome: string;
  remetente_email: string;
  reply_to: string;
  valor_credito: string;
  validade_credito: string;
  url_deeplink: string;
  url_landing: string;
  teto_hora: string;
  teto_dia: string;
  agendada_para: string;
  lembrete_ativo: boolean;
  lembrete_horas: string;
  corpo: EmailBlock[];
};

function blankCampaign(
  senderEmail = '',
  senderName = '',
  replyTo = '',
  hourCap = '100',
  dayCap = '1000',
): CampaignFormValues {
  return {
    nome: '',
    assunto: '',
    preheader: '',
    assunto_lembrete: '',
    remetente_nome: senderName,
    remetente_email: senderEmail,
    reply_to: replyTo,
    valor_credito: '',
    validade_credito: '',
    url_deeplink: '',
    url_landing: '',
    teto_hora: hourCap,
    teto_dia: dayCap,
    agendada_para: '',
    lembrete_ativo: false,
    lembrete_horas: '48',
    corpo: [],
  };
}

function campaignToForm(
  campaign?: Campaign,
  senderEmail = '',
  senderName = '',
  replyTo = '',
  hourCap = '100',
  dayCap = '1000',
): CampaignFormValues {
  if (!campaign) return blankCampaign(senderEmail, senderName, replyTo, hourCap, dayCap);
  return {
    nome: campaign.nome,
    assunto: campaign.assunto,
    preheader: campaign.preheader ?? '',
    assunto_lembrete: campaign.assunto_lembrete ?? '',
    remetente_nome: campaign.remetente_nome,
    remetente_email: campaign.remetente_email,
    reply_to: campaign.reply_to ?? replyTo,
    valor_credito: campaign.valor_credito == null ? '' : String(campaign.valor_credito),
    validade_credito: campaign.validade_credito ?? '',
    url_deeplink: campaign.url_deeplink ?? '',
    url_landing: campaign.url_landing ?? '',
    teto_hora: campaign.teto_hora == null ? '' : String(campaign.teto_hora),
    teto_dia: campaign.teto_dia == null ? '' : String(campaign.teto_dia),
    agendada_para: toDateTimeLocal(campaign.agendada_para),
    lembrete_ativo: campaign.lembrete_ativo,
    lembrete_horas: String(campaign.lembrete_horas ?? 48),
    corpo: normalizeEmailBlocks(campaign.corpo),
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div><label className="field-label">{label}</label>{children}{hint && <p className="field-hint">{hint}</p>}</div>;
}

function campaignContentIsLocked(status?: string): boolean {
  return status === 'agendada' || status === 'enviando' || status === 'pausada';
}

function CampaignForm({
  campaign,
  onSaved,
  onSendTest,
  testPending,
  testError,
  testSent,
}: {
  campaign?: Campaign;
  onSaved: (campaign: Campaign) => void;
  onSendTest?: () => void;
  testPending?: boolean;
  testError?: string | null;
  testSent?: boolean;
}) {
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const defaultsQuery = useGetCampaignDefaults();
  const form = useForm<CampaignFormValues>({
    defaultValues: campaignToForm(
      campaign,
      defaultsQuery.data?.remetente_email,
      defaultsQuery.data?.remetente_nome,
      defaultsQuery.data?.reply_to,
      defaultsQuery.data?.teto_hora == null ? '100' : String(defaultsQuery.data.teto_hora),
      defaultsQuery.data?.teto_dia == null ? '1000' : String(defaultsQuery.data.teto_dia),
    ),
  });
  const isEditing = Boolean(campaign);
  const contentLocked = campaignContentIsLocked(campaign?.status);
  const emailBlocks = form.watch('corpo');
  const emailSubject = form.watch('assunto');
  const preheader = form.watch('preheader');
  const [uploadingBlockIds, setUploadingBlockIds] = useState<Set<string>>(() => new Set());
  const isUploadPending = uploadingBlockIds.size > 0;

  const handleUploadingChange = (blockId: string, uploading: boolean) => {
    setUploadingBlockIds((current) => {
      const next = new Set(current);
      if (uploading) {
        next.add(blockId);
      } else {
        next.delete(blockId);
      }
      return next;
    });
  };

  useEffect(() => {
    form.reset(campaignToForm(
      campaign,
      defaultsQuery.data?.remetente_email,
      defaultsQuery.data?.remetente_nome,
      defaultsQuery.data?.reply_to,
      defaultsQuery.data?.teto_hora == null ? '100' : String(defaultsQuery.data.teto_hora),
      defaultsQuery.data?.teto_dia == null ? '1000' : String(defaultsQuery.data.teto_dia),
    ));
  }, [
    campaign,
    defaultsQuery.data?.remetente_email,
    defaultsQuery.data?.remetente_nome,
    defaultsQuery.data?.reply_to,
    defaultsQuery.data?.teto_hora,
    defaultsQuery.data?.teto_dia,
    form,
  ]);

  const savePayload = (payload: CreateCampaignInput) => {
    if (campaign) {
      update.mutate({ campaignId: campaign.id, data: payload as UpdateCampaignInput }, { onSuccess: onSaved });
    } else {
      create.mutate({ data: payload }, { onSuccess: onSaved });
    }
  };

  const submit = (values: CampaignFormValues) => {
    if (isUploadPending) {
      form.setError('corpo', { type: 'upload', message: 'Aguarde o término do upload das imagens antes de salvar.' });
      return;
    }
    if (!values.nome.trim() || !values.assunto.trim() || !values.remetente_nome.trim() || !values.remetente_email.trim()) {
      const missingField: keyof CampaignFormValues = !values.nome.trim()
        ? 'nome'
        : !values.assunto.trim()
          ? 'assunto'
          : !values.remetente_nome.trim()
            ? 'remetente_nome'
            : 'remetente_email';
      form.setError(missingField, { message: 'Campo obrigatório.' });
      return;
    }
    const contentError = validateEmailBlocks(values.corpo);
    if (contentError) {
      form.setError('corpo', { type: 'validate', message: contentError });
      return;
    }
    const corpo = values.corpo.map((block) => (
      block.type === 'image' && !block.href?.trim()
        ? { ...block, href: undefined }
        : block
    ));
    const payload = {
      nome: values.nome.trim(),
      assunto: values.assunto.trim(),
      preheader: values.preheader.trim() || null,
      assunto_lembrete: values.assunto_lembrete.trim() || null,
      remetente_nome: values.remetente_nome.trim(),
      remetente_email: values.remetente_email.trim(),
      reply_to: values.reply_to.trim() || null,
      valor_credito: nullableNumber(values.valor_credito),
      validade_credito: values.validade_credito.trim() || null,
      url_deeplink: values.url_deeplink.trim() || null,
      url_landing: values.url_landing.trim() || null,
       teto_hora: nullableNumber(values.teto_hora) ?? 100,
       teto_dia: nullableNumber(values.teto_dia) ?? 1000,
      agendada_para: toServerDate(values.agendada_para),
      lembrete_ativo: values.lembrete_ativo,
       lembrete_horas: Math.min(168, Math.max(24, Number(values.lembrete_horas) || 48)),
      corpo,
    };
    savePayload(payload as CreateCampaignInput);
  };

  const isPending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate data-testid="form-campaign">
       <section className="panel p-5 sm:p-7">
        <div className="mb-6 flex items-start justify-between gap-4"><div><p className="section-kicker">01 · Identidade</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Como esta campanha será reconhecida?</h2></div><span className="font-mono text-[9px] uppercase tracking-[.12em] text-[#aaa3a1]">Obrigatório</span></div>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Nome interno"><input {...form.register('nome')} className="field-control" placeholder="Ex.: Ofertas de sexta — eletrônicos" data-testid="input-campaign-name" /></Field>
            <Field label="Assunto principal"><input {...form.register('assunto')} disabled={contentLocked} className="field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="Ex.: As melhores ofertas chegaram" data-testid="input-campaign-subject" /></Field>
            <div className="md:col-span-2"><Field label="Prévia na caixa de entrada" hint="Opcional. Resumo curto exibido ao lado do assunto em alguns clientes de e-mail."><input {...form.register('preheader')} disabled={contentLocked} maxLength={100} className="field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="Ex.: Aproveite as ofertas escolhidas para você" data-testid="input-campaign-preheader" /><p className="mt-1 text-right font-mono text-[10px] text-[#99959a]">{(preheader?.length ?? 0)}/100</p></Field></div>
           <div className="md:col-span-2"><Field label="Assunto do lembrete" hint="Opcional. Usado para identificar uma eventual mensagem de lembrete."><input {...form.register('assunto_lembrete')} disabled={contentLocked} className="field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="Ex.: Você ainda pode aproveitar estas ofertas" data-testid="input-campaign-reminder-subject" /></Field></div>
        </div>
        {form.formState.errors.nome && <p className="mt-4 flex items-center gap-2 text-xs font-bold text-[#bd4f26]" data-testid="error-campaign-form"><CircleAlert size={14} /> {form.formState.errors.nome.message}</p>}
      </section>

      <section className="panel p-5 sm:p-7">
        <div className="mb-6"><p className="section-kicker">02 · Remetente</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">De quem a mensagem chega?</h2></div>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Nome do remetente"><div className="relative"><UserRound size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('remetente_nome')} disabled={contentLocked} className="field-control pl-10 disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="Amo Ofertas" data-testid="input-sender-name" /></div></Field>
           <Field label="E-mail do remetente" hint="Somente endereços do domínio verificado marketing.amo.delivery."><div className="relative"><Mail size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('remetente_email')} type="email" readOnly aria-readonly="true" className="field-control bg-[#f3eee7] pl-10 text-[#6d7180]" placeholder="Carregando remetente seguro…" data-testid="input-sender-email" /></div>{form.formState.errors.remetente_email && <p className="mt-2 text-xs font-bold text-[#bd4f26]" data-testid="error-sender-email">{form.formState.errors.remetente_email.message}</p>}</Field>
           <Field label="Reply-To" hint="Respostas dos destinatários serão encaminhadas para este endereço."><div className="relative"><Mail size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('reply_to')} disabled={contentLocked} type="email" className="field-control pl-10 disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="contato@marketing.amo.delivery" data-testid="input-reply-to" /></div>{form.formState.errors.reply_to && <p className="mt-2 text-xs font-bold text-[#bd4f26]" data-testid="error-reply-to">{form.formState.errors.reply_to.message}</p>}</Field>
        </div>
      </section>

      <section className="panel p-5 sm:p-7">
        <div className="mb-6"><p className="section-kicker">03 · Incentivo e destino</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Quais regras acompanham a oferta?</h2></div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Valor do crédito" hint="Use o valor numérico em reais."><input {...form.register('valor_credito')} inputMode="decimal" className="field-control" placeholder="0,00" data-testid="input-credit-value" /></Field>
          <Field label="Validade do crédito" hint="Data limite do crédito."><input {...form.register('validade_credito')} type="date" className="field-control" data-testid="input-credit-expiry" /></Field>
           <Field label="Teto por hora" hint="Sugestão inicial para a rampa: 100."><input {...form.register('teto_hora')} inputMode="numeric" className="field-control" placeholder="Sem limite" data-testid="input-hour-cap" /></Field>
           <Field label="Teto por dia" hint="Sugestão inicial para a rampa: 1.000."><input {...form.register('teto_dia')} inputMode="numeric" className="field-control" placeholder="Sem limite" data-testid="input-day-cap" /></Field>
           <div className="sm:col-span-2 lg:col-span-2"><Field label="Deep link"><div className="relative"><Link2 size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('url_deeplink')} disabled={contentLocked} type="url" className="field-control pl-10 disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="https://..." data-testid="input-deeplink" /></div></Field></div>
           <div className="sm:col-span-2 lg:col-span-2"><Field label="Landing page"><div className="relative"><Link2 size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('url_landing')} disabled={contentLocked} type="url" className="field-control pl-10 disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="https://..." data-testid="input-landing-page" /></div></Field></div>
        </div>
      </section>

      <EmailEditor
        blocks={emailBlocks}
        onChange={(blocks) => form.setValue('corpo', blocks, { shouldDirty: true })}
        campaignId={campaign?.id}
        subject={emailSubject}
         valorCredito={nullableNumber(form.watch('valor_credito'))}
         validadeCredito={form.watch('validade_credito') || null}
         disabled={contentLocked}
        onUploadingChange={handleUploadingChange}
        onSendTest={onSendTest}
        testPending={testPending}
        testError={testError}
        testSent={testSent}
      />
       {contentLocked && <p className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] px-4 py-3 text-xs leading-5 text-[#6d7180]" role="status" data-testid="campaign-content-locked">O corpo, assunto, remetente e links ficam bloqueados enquanto a campanha está agendada, enviando ou pausada.</p>}
      {form.formState.errors.corpo?.message && <p className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs leading-5 text-[#a64220]" data-testid="error-email-content">{form.formState.errors.corpo.message}</p>}
      {isUploadPending && <p className="flex items-center gap-2 rounded-xl border border-[#d4e5df] bg-[#f1f7f5] px-4 py-3 text-xs text-[#247b79]" role="status" data-testid="status-image-upload-blocking"><LoaderCircle size={14} className="animate-spin" /> Aguarde o upload das imagens terminar para salvar a campanha.</p>}

      <section className="panel p-5 sm:p-7">
        <div className="mb-6"><p className="section-kicker">05 · Operação</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Quando e em que estado ela está?</h2></div>
        <div className="grid gap-5 md:grid-cols-3">
           <Field label="Status"><div className="field-control flex items-center bg-[#f3eee7] font-bold text-[#565c6a]" data-testid="select-campaign-status">{statusLabels[campaign?.status ?? CampaignStatus.rascunho]}</div></Field>
          <Field label="Agendamento"><input {...form.register('agendada_para')} type="datetime-local" className="field-control" data-testid="input-scheduled-at" /></Field>
           <Field label="Horas até o lembrete"><input {...form.register('lembrete_horas')} type="number" min="24" max="168" className="field-control" data-testid="input-reminder-hours" /></Field>
        </div>
        <div className="mt-6 grid gap-3 border-t border-[#eee7dc] pt-5 sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-3 text-xs text-[#565c6a]"><input {...form.register('lembrete_ativo')} type="checkbox" className="mt-0.5 accent-[#e96527]" data-testid="checkbox-reminder-active" /><span><strong className="block text-[#263044]">Lembrete ativo</strong><span className="mt-1 block leading-5">Deixa o lembrete habilitado para a operação.</span></span></label>
           <div className="flex items-start gap-3 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-3 text-xs text-[#565c6a]" data-testid="status-test-sent"><CheckCircle2 size={15} className={`mt-0.5 ${campaign?.teste_enviado ? 'text-[#417846]' : 'text-[#aaa3a1]'}`} /><span><strong className="block text-[#263044]">Teste de conteúdo</strong><span className="mt-1 block leading-5">{campaign?.teste_enviado_em ? `Teste enviado em ${new Date(campaign.teste_enviado_em).toLocaleDateString('pt-BR')} às ${new Date(campaign.teste_enviado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'Nenhum teste enviado ainda.'}</span></span></div>
        </div>
      </section>

      {error && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-save-error"><div className="flex items-start gap-3"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{getErrorMessage(error, 'Não foi possível salvar a campanha.')}</span></div></div>}
       <div className="flex flex-col-reverse justify-end gap-3 sm:flex-row"><Link href={campaign ? `/campaigns/${campaign.id}` : '/'} className="action-button action-button-secondary" data-testid="link-cancel-campaign">Cancelar</Link><button type="submit" disabled={isPending || isUploadPending} className="action-button action-button-primary" data-testid="button-save-campaign">{isPending ? <><LoaderCircle size={16} className="animate-spin" /> Salvando...</> : isUploadPending ? <><LoaderCircle size={16} className="animate-spin" /> Aguardando upload...</> : <><Save size={16} /> {isEditing ? 'Salvar alterações' : 'Criar campanha'}</>}</button></div>
    </form>
  );
}

function ImportSummary({ summary }: { summary: ImportValidationSummary }) {
  const maxRecency = Math.max(...(summary.recencia?.map((item) => item.quantidade) ?? [1]), 1);
  const issueRows = [
    ['E-mails inválidos', summary.emails_invalidos],
    ['Datas inválidas', summary.datas_invalidas],
    ['Nomes ausentes', summary.nomes_ausentes],
    ['Telefones inválidos', summary.telefones_invalidos],
    ['Duplicados no arquivo', summary.duplicados_no_arquivo],
    ['Duplicados por telefone', summary.duplicados_telefone],
    ['Suprimidos na validação', summary.suprimidos],
  ];
  return (
    <div className="mt-6 border-t border-[#eee7dc] pt-6" data-testid="import-validation-summary">
      <div className="mb-5 flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><p className="section-kicker">Resultado da validação</p><h3 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Base pronta para uma decisão.</h3></div><span className="font-mono text-[9px] text-[#989498]" data-testid="text-import-storage-path">{summary.storage_path}</span></div>
       <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <div className="metric-tile"><strong>{formatNumber(summary.total_linhas)}</strong><span>Linhas lidas</span></div>
        <div className="metric-tile border-[#cfe4c7] bg-[#f2f8ee]"><strong className="text-[#417846]">{formatNumber(summary.validos)}</strong><span>Válidos</span></div>
        <div className="metric-tile border-[#efc9ba] bg-[#fff3ee]"><strong className="text-[#a64220]">{formatNumber(summary.invalidos)}</strong><span>Inválidos</span></div>
         <div className="metric-tile border-[#cfe4c7] bg-[#f2f8ee]"><strong className="text-[#417846]">{formatNumber(summary.novos)}</strong><span>Salvos</span></div>
         <div className="metric-tile"><strong>{formatNumber(summary.atualizados)}</strong><span>Atualizados</span></div>
         <div className="metric-tile border-[#f1dfb8] bg-[#fff9e9]"><strong className="text-[#9b6b17]">{formatNumber(summary.duplicados_no_arquivo)}</strong><span>Duplicados</span></div>
         <div className="metric-tile"><strong>{formatNumber(summary.suprimidos)}</strong><span>Suprimidos na validação</span></div>
      </div>
       <div className="mt-6 rounded-xl border border-[#d9e3e0] bg-[#f1f7f5] p-4" data-testid="import-current-delivery-summary">
         <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-extrabold text-[#263044]">Situação atual da lista</h4><ShieldCheck size={15} className="text-[#247b79]" /></div>
         <p className="mt-1 text-xs leading-5 text-[#6d7180]">Esses números cruzam a lista atual com a tabela de supressão, inclusive alterações feitas depois desta importação.</p>
         <div className="mt-4 grid gap-3 sm:grid-cols-3">
           <div className="rounded-xl border border-[#d9e3e0] bg-white/70 p-3"><strong className="block text-xl font-extrabold tabular-nums text-[#263044]">{formatNumber(summary.total_na_lista)}</strong><span className="text-[11px] font-bold text-[#6d7180]">Total na lista</span></div>
           <div className="rounded-xl border border-[#efc9ba] bg-[#fff3ee] p-3"><strong className="block text-xl font-extrabold tabular-nums text-[#a64220]">{formatNumber(summary.suprimidos_no_envio)}</strong><span className="text-[11px] font-bold text-[#6d7180]">Serão suprimidos no envio</span></div>
           <div className="rounded-xl border border-[#cfe4c7] bg-[#f2f8ee] p-3"><strong className="block text-xl font-extrabold tabular-nums text-[#417846]">{formatNumber(summary.receberao_de_fato)}</strong><span className="text-[11px] font-bold text-[#6d7180]">Receberão de fato</span></div>
         </div>
       </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4">
          <div className="flex items-center justify-between"><h4 className="text-sm font-extrabold text-[#263044]">Pontos de atenção</h4><CircleAlert size={15} className="text-[#d35f2a]" /></div>
          <div className="mt-4 space-y-3">{issueRows.map(([label, value]) => <div key={label as string} className="flex items-center justify-between gap-3 text-xs"><span className="text-[#6d7180]">{label}</span><span className={`font-mono font-medium ${Number(value) > 0 ? 'text-[#a64220]' : 'text-[#8a8790]'}`}>{formatNumber(Number(value))}</span></div>)}</div>
        </div>
        <div className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4">
          <div className="flex items-center justify-between"><h4 className="text-sm font-extrabold text-[#263044]">Recência da base</h4><Clock3 size={15} className="text-[#247b79]" /></div>
          <div className="mt-5 space-y-4">{(summary.recencia ?? []).length === 0 ? <p className="text-xs text-[#7d7e87]">A API não retornou distribuição de recência.</p> : summary.recencia.map((bucket) => <div key={bucket.faixa}><div className="mb-1.5 flex justify-between gap-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#7d7e87]"><span>{bucket.faixa}</span><span>{formatNumber(bucket.quantidade)}</span></div><div className="h-2 overflow-hidden rounded-full bg-[#e6ded3]"><div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${Math.max(4, (bucket.quantidade / maxRecency) * 100)}%` }} /></div></div>)}</div>
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-[#e5ddd0] bg-[#fffdf9] p-4">
        <div className="flex items-center justify-between"><h4 className="text-sm font-extrabold text-[#263044]">Amostras de erros</h4><span className="font-mono text-[9px] uppercase tracking-[.1em] text-[#989498]">{summary.amostras_erros?.length ?? 0} mostradas</span></div>
        {(summary.amostras_erros ?? []).length === 0 ? <p className="mt-4 flex items-center gap-2 text-xs text-[#417846]"><CheckCircle2 size={15} /> Nenhuma amostra de erro retornada.</p> : <div className="mt-4 overflow-hidden rounded-lg border border-[#eee7dc]"><div className="grid grid-cols-[75px_1fr] bg-[#f7f2eb] px-3 py-2 font-mono text-[9px] uppercase tracking-[.1em] text-[#8b8d96]"><span>Linha</span><span>Motivo</span></div>{summary.amostras_erros.map((item, index) => <div key={`${item.linha}-${index}`} className="grid grid-cols-[75px_1fr] border-t border-[#eee7dc] px-3 py-2.5 text-xs text-[#626876]"><span className="font-mono text-[#a64220]">{item.linha}</span><span>{item.motivo}</span></div>)}</div>}
      </div>
    </div>
  );
}

function ImportPanel({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const requestUpload = useRequestCampaignImportUploadUrl();
  const validateImport = useValidateCampaignImport();
  const recipientSummaryQuery = useGetCampaignRecipientSummary(campaignId, {
    query: {
      enabled: Boolean(campaignId),
      queryKey: getGetCampaignRecipientSummaryQueryKey(campaignId),
    },
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deduplicatePhone, setDeduplicatePhone] = useState(false);
  const [summary, setSummary] = useState<ImportValidationSummary | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'uploading' | 'processing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [importConfirmed, setImportConfirmed] = useState(false);
  const importJobQuery = useGetCampaignImport(campaignId, importJobId ?? '', {
    query: {
      enabled: Boolean(importJobId),
      queryKey: getGetCampaignImportQueryKey(campaignId, importJobId ?? ''),
      refetchInterval: 1000,
    },
  });

  useEffect(() => {
    const job = importJobQuery.data;
    if (!job) return;
    if (job.status === 'concluida') {
      setSummary(job.resultado);
      setImportJobId(null);
      setPhase('idle');
      queryClient.invalidateQueries({ queryKey: getGetCampaignRecipientSummaryQueryKey(campaignId) });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      return;
    }
    if (job.status === 'erro') {
      setError(job.erro ?? 'Não foi possível validar o arquivo.');
      setImportJobId(null);
      setPhase('idle');
    }
  }, [importJobQuery.data]);

  useEffect(() => {
    if (!importJobQuery.isError || !importJobId) return;
    setError(getErrorMessage(importJobQuery.error, 'Não foi possível consultar o progresso da validação.'));
    setImportJobId(null);
    setPhase('idle');
  }, [importJobQuery.error, importJobQuery.isError, importJobId]);

  const chooseFile = (nextFile?: File) => {
    if (!nextFile) return;
    if (!nextFile.name.toLowerCase().endsWith('.csv') && nextFile.type !== 'text/csv') {
      setError('Escolha um arquivo CSV para continuar.');
      setFile(null);
      return;
    }
    setError(null);
    setSummary(null);
    setImportJobId(null);
    setImportConfirmed(false);
    setFile(nextFile);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };
  const validate = async () => {
    if (!file) {
      setError('Selecione um CSV antes de validar.');
      return;
    }
    if (recipientSummaryQuery.isLoading || recipientSummaryQuery.isError) {
      setError('Aguarde a consulta da lista de destinatários terminar antes de validar.');
      return;
    }
    const existingRecipients =
      recipientSummaryQuery.data?.total_na_lista ??
      recipientSummaryQuery.data?.total ??
      0;
    if (existingRecipients > 0 && !importConfirmed) {
      setError('Confirme que a nova base deve ser somada aos destinatários atuais.');
      return;
    }
    setError(null);
    try {
      setPhase('requesting');
      const upload = await requestUpload.mutateAsync({ campaignId, data: { nome_arquivo: file.name, tamanho: file.size } });
      setPhase('uploading');
      const uploadBody = new FormData();
      uploadBody.append('cacheControl', '3600');
      uploadBody.append('', file);
      const response = await fetch(upload.signed_url, { method: 'PUT', body: uploadBody });
      if (!response.ok) throw new Error(`O upload do arquivo foi recusado (${response.status}).`);
       setPhase('processing');
       const job = await validateImport.mutateAsync({ campaignId, data: { storage_path: upload.path, deduplicar_por_telefone: deduplicatePhone } });
       setImportJobId(job.id);
    } catch (uploadError) {
      setPhase('idle');
      setError(getErrorMessage(uploadError, 'Não foi possível concluir a validação do CSV.'));
    }
  };
  const isBusy = phase !== 'idle';
  const existingRecipients =
    recipientSummaryQuery.data?.total_na_lista ??
    recipientSummaryQuery.data?.total ??
    0;
  const job = importJobQuery.data;
  const progress = job?.total_linhas
    ? Math.min(100, Math.round((job.linhas_processadas / job.total_linhas) * 100))
    : null;
  const phaseLabel = phase === 'requesting'
    ? 'Preparando upload...'
    : phase === 'uploading'
      ? 'Enviando arquivo...'
      : phase === 'processing'
        ? 'Processando destinatários...'
        : 'Validar CSV';

  return (
    <section className="panel p-5 sm:p-7" data-testid="panel-import">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div><p className="section-kicker">Importação de destinatários</p><h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Traga a base. Nós mostramos o risco.</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#747783]">O arquivo é enviado diretamente para o armazenamento assinado e só depois validado. Nada é enviado a clientes nesta fase.</p></div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-[#cfe4c7] bg-[#f2f8ee] px-3 py-2 font-mono text-[9px] uppercase tracking-[.12em] text-[#417846]"><ShieldCheck size={13} /> Sem envio</div>
      </div>
      <div className={`drop-zone mt-6 p-6 text-center ${dragging ? 'is-dragging' : ''}`} data-testid="dropzone-import">
        <label htmlFor="campaign-csv" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} className="block cursor-pointer">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#d7ef56] text-[#263044] shadow-[4px_4px_0_#e96527]"><UploadCloud size={25} /></span>
          <span className="mt-5 block text-sm font-extrabold text-[#263044]">{file ? file.name : 'Solte o CSV aqui ou escolha um arquivo'}</span>
          <span className="mt-2 block text-xs text-[#7d7e87]">{file ? `${(file.size / 1024).toFixed(1)} KB · pronto para validação` : 'Somente .csv · os bytes não passam pelo servidor da API'}</span>
          <input ref={inputRef} id="campaign-csv" type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => chooseFile(event.target.files?.[0])} data-testid="input-import-csv" />
        </label>
      </div>
      {file && existingRecipients > 0 && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border-2 border-[#e8c56f] bg-[#fff7dc] px-4 py-4 text-sm leading-6 text-[#74561c] sm:flex-row sm:items-center sm:justify-between" role="alert" data-testid="status-existing-recipients-warning">
          <p><strong>Esta campanha já contém {formatNumber(existingRecipients)} destinatários. A importação vai somar a eles.</strong></p>
          <button type="button" onClick={() => setImportConfirmed(true)} disabled={importConfirmed} className="action-button action-button-secondary shrink-0 !border-[#d6b95c] !bg-[#fffdf1] !text-[#74561c] disabled:opacity-60" data-testid="button-confirm-import-sum">{importConfirmed ? <><CheckCircle2 size={14} /> Soma confirmada</> : 'Continuar e somar'}</button>
        </div>
      )}
      {recipientSummaryQuery.isError && (
        <div className="mt-5 flex items-start justify-between gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs leading-5 text-[#a64220]" data-testid="status-recipient-count-import-error">
          <span>Não foi possível consultar os destinatários atuais. A validação fica bloqueada até essa contagem ser confirmada.</span>
          <button type="button" onClick={() => recipientSummaryQuery.refetch()} className="font-bold underline" data-testid="button-retry-recipient-count">Tentar novamente</button>
        </div>
      )}
      <div className="mt-5 flex flex-col justify-between gap-4 border-t border-[#eee7dc] pt-5 sm:flex-row sm:items-center">
        <label className="flex items-start gap-3 text-xs text-[#626876]"><input type="checkbox" checked={deduplicatePhone} onChange={(event) => setDeduplicatePhone(event.target.checked)} className="mt-0.5 accent-[#e96527]" data-testid="checkbox-deduplicate-phone" /><span><strong className="block text-[#263044]">Deduplicar por telefone</strong><span className="mt-1 block leading-5">Além do e-mail, considera o telefone na validação.</span></span></label>
         <button onClick={validate} disabled={!file || isBusy || recipientSummaryQuery.isLoading || recipientSummaryQuery.isError || (existingRecipients > 0 && !importConfirmed)} className="action-button action-button-primary" data-testid="button-validate-import">{isBusy ? <><LoaderCircle size={16} className="animate-spin" /> {phaseLabel}</> : <><FileCheck2 size={16} /> {phaseLabel}</>}</button>
      </div>
      {phase === 'processing' && job && <div className="mt-5 rounded-xl border border-[#d9e3e0] bg-[#f1f7f5] p-4" data-testid="import-progress">
        <div className="flex items-center justify-between gap-3 text-xs font-bold text-[#247b79]">
          <span>{job.status === 'pendente' ? 'Aguardando processamento...' : 'Validação em andamento...'}</span>
          <span>{progress == null ? `${formatNumber(job.linhas_processadas)} linhas processadas` : `${progress}%`}</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#dce9e5]">
          <div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${progress ?? 4}%` }} />
        </div>
        <p className="mt-2 text-[11px] text-[#6d7f7c]">{job.total_linhas == null ? 'Lendo o arquivo e contando linhas...' : `${formatNumber(job.linhas_processadas)} de ${formatNumber(job.total_linhas)} linhas`}</p>
      </div>}
      {error && <div className="mt-5 flex items-start gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-import-error"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{error}</span><button onClick={() => setError(null)} className="ml-auto rounded p-1" aria-label="Fechar erro de importação" data-testid="button-dismiss-import-error"><X size={14} /></button></div>}
      {summary && <ImportSummary summary={summary} />}
    </section>
  );
}

function RecipientSummaryPanel({
  summary,
  loading,
  onClear,
  confirmClear,
  onCancelClear,
  canClear,
  clearPending,
  error,
  clearError,
}: {
  summary?: CampaignRecipientSummary;
  loading: boolean;
  onClear: () => void;
  confirmClear: boolean;
  onCancelClear: () => void;
  canClear: boolean;
  clearPending: boolean;
  error?: string | null;
  clearError?: string | null;
}) {
  const statusRows = [
    { key: 'pendente', label: 'Pendente', tone: 'text-[#9b6b17]', dot: 'bg-[#d5a42e]' },
    { key: 'enviado', label: 'Enviado', tone: 'text-[#247b79]', dot: 'bg-[#247b79]' },
    { key: 'entregue', label: 'Entregue', tone: 'text-[#417846]', dot: 'bg-[#63a76f]' },
    { key: 'bloqueado', label: 'Bloqueado', tone: 'text-[#8e3a20]', dot: 'bg-[#d35f2a]' },
    { key: 'suprimido', label: 'Suprimido (processado)', tone: 'text-[#6d7180]', dot: 'bg-[#8f9299]' },
    { key: 'erro', label: 'Erro', tone: 'text-[#a64220]', dot: 'bg-[#bd4f26]' },
  ] as const;
  const maxRecency = Math.max(...(summary?.recencia.map((item) => item.quantidade) ?? [1]), 1);
  const reputationMetrics = summary?.reputacao
    ? [
        {
          key: 'bounce',
          label: 'Bounce',
          description: 'Endereços rejeitados pelo provedor.',
          metric: summary.reputacao.bounce,
        },
        {
          key: 'reclamacao',
          label: 'Reclamação',
          description: 'Destinatários que marcaram a mensagem como spam.',
          metric: summary.reputacao.reclamacao,
        },
      ]
    : [];

  return (
    <section className="panel relative z-0 p-5 shadow-[0_12px_34px_rgba(38,48,68,.08)] sm:p-7" data-testid="panel-recipient-summary">
      <div className="flex flex-col justify-between gap-4 border-b border-[#eee7dc] pb-5 sm:flex-row sm:items-start">
        <div>
          <p className="section-kicker">Gestão da base</p>
          <h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Destinatários desta campanha</h2>
          <p className="mt-1 text-xs text-[#7d7e87]">A contagem considera a lista principal, sem os destinatários de lembrete.</p>
        </div>
        <div className="flex flex-wrap items-stretch justify-end gap-2">
          <div className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] px-3 py-2.5 text-right">
            <span className="block font-mono text-[9px] uppercase tracking-[.1em] text-[#6d7180]">Total na lista</span>
            <strong className="mt-1 block text-2xl font-extrabold tabular-nums tracking-[-.06em] text-[#263044]" data-testid="text-recipient-list-total">{loading ? '…' : error ? '—' : formatNumber(summary?.total_na_lista)}</strong>
          </div>
          <div className="rounded-xl border border-[#efc9ba] bg-[#fff3ee] px-3 py-2.5 text-right">
            <span className="block font-mono text-[9px] uppercase tracking-[.1em] text-[#a64220]">Serão suprimidos no envio</span>
            <strong className="mt-1 block text-2xl font-extrabold tabular-nums tracking-[-.06em] text-[#a64220]" data-testid="text-recipient-suppressed">{loading ? '…' : error ? '—' : formatNumber(summary?.suprimidos_no_envio)}</strong>
          </div>
          <div className="rounded-xl border border-[#cfe4c7] bg-[#f2f8ee] px-3 py-2.5 text-right">
            <span className="block font-mono text-[9px] uppercase tracking-[.1em] text-[#417846]">Receberão de fato</span>
            <strong className="mt-1 block text-3xl font-extrabold tabular-nums tracking-[-.07em] text-[#247b79]" data-testid="text-recipient-total">{loading ? '…' : error ? '—' : formatNumber(summary?.receberao_de_fato)}</strong>
          </div>
          <button type="button" onClick={onClear} disabled={clearPending || loading || !canClear || !summary?.total_na_lista} className="action-button action-button-secondary !px-3 !text-[#a64220] disabled:opacity-50" title={canClear ? 'Limpar destinatários' : 'A campanha está em operação'} data-testid="button-clear-recipients"><Trash2 size={15} /> <span className="hidden sm:inline">{confirmClear ? 'Confirmar limpeza' : 'Limpar lista'}</span></button>
        </div>
      </div>
      {error ? (
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-recipient-summary-error"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{error}</span></div>
      ) : loading ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="skeleton h-16 rounded-xl" />)}</div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {statusRows.map((row) => (
              <div key={row.key} className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-3" data-testid={`recipient-status-${row.key}`}>
                <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${row.dot}`} /><span className="text-[11px] font-bold text-[#6d7180]">{row.label}</span></div>
                <strong className={`mt-2 block text-xl font-extrabold tabular-nums tracking-[-.05em] ${row.tone}`}>{formatNumber(summary?.status[row.key])}</strong>
              </div>
            ))}
          </div>
           <div className="mt-5 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4" data-testid="panel-reputation-metrics">
             <div className="flex items-start justify-between gap-3">
               <div>
                 <h3 className="text-sm font-extrabold text-[#263044]">Sinais de reputação</h3>
                 <p className="mt-1 text-xs text-[#7d7e87]">Percentuais sobre {formatNumber(summary?.reputacao.total_enviado)} enviados. Estes indicadores orientam a pausa automática.</p>
               </div>
               <ShieldCheck size={16} className="text-[#247b79]" />
             </div>
             <div className="mt-4 grid gap-3 sm:grid-cols-2">
               {reputationMetrics.map((item) => {
                 const tone = reputationTone(item.metric.percentual, item.metric.limite_percentual);
                 return (
                   <div key={item.key} className={`rounded-xl border p-4 ${tone.card}`} data-testid={`recipient-reputation-${item.key}`}>
                     <div className="flex items-start justify-between gap-3">
                       <div>
                         <span className="text-xs font-extrabold text-[#263044]">{item.label}</span>
                         <p className="mt-1 text-[11px] leading-4 text-[#6d7180]">{item.description}</p>
                       </div>
                       <span className="shrink-0 rounded-full bg-[#263044] px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[.08em] text-[#fffaf6]">limite {formatPercentage(item.metric.limite_percentual)}</span>
                     </div>
                     <div className="mt-4 flex items-end justify-between gap-3">
                       <div>
                         <strong className={`block text-3xl font-extrabold tabular-nums tracking-[-.07em] ${tone.value}`}>{formatPercentage(item.metric.percentual)}</strong>
                         <span className="mt-1 block text-[11px] text-[#6d7180]">{formatNumber(item.metric.quantidade)} ocorrência(s) em {formatNumber(summary?.reputacao.total_enviado)} enviados</span>
                       </div>
                       <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${tone.badge}`}>{tone.label}</span>
                     </div>
                   </div>
                 );
               })}
             </div>
           </div>
          <div className="mt-5 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4">
            <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-extrabold text-[#263044]">Recência da base</h3><p className="mt-1 text-xs text-[#7d7e87]">Distribuição por data da última compra.</p></div><Clock3 size={16} className="text-[#247b79]" /></div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {summary?.recencia.map((bucket) => (
                <div key={bucket.faixa}>
                  <div className="mb-1.5 flex justify-between gap-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#7d7e87]"><span>{bucket.faixa}</span><span>{formatNumber(bucket.quantidade)}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-[#e6ded3]"><div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${Math.max(bucket.quantidade > 0 ? 4 : 0, (bucket.quantidade / maxRecency) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {clearError && <div className="mt-4 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs text-[#a64220]" data-testid="status-clear-recipients-error">{clearError}</div>}
      {confirmClear && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border-2 border-[#efc9ba] bg-[#fff3ee] px-4 py-4 text-xs leading-5 text-[#8e3a20] sm:flex-row sm:items-center sm:justify-between" role="alert" data-testid="status-clear-recipients-confirmation">
          <p><strong>Remover os {formatNumber(summary?.total)} destinatários desta campanha?</strong> Esta ação não pode ser desfeita.</p>
          <button type="button" onClick={onCancelClear} className="action-button action-button-secondary shrink-0 !px-3" data-testid="button-cancel-clear-recipients">Cancelar</button>
        </div>
      )}
    </section>
  );
}

function SendQuotaPanel({ campaign }: { campaign: Campaign }) {
  const hourSent = campaign.enviados_hora ?? 0;
  const daySent = campaign.enviados_dia ?? 0;
  const quotaRows = [
    { label: 'Hora corrente', sent: hourSent, cap: campaign.teto_hora },
    { label: 'Dia corrente', sent: daySent, cap: campaign.teto_dia },
  ];
  const formatRate = (value: number | null | undefined) =>
    value == null ? null : `${(value * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

  return (
    <section className="panel p-5 sm:p-7" data-testid="panel-send-quota">
      <div className="mb-5 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div>
          <p className="section-kicker">Controle de rampa</p>
          <h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Quanto já foi enviado?</h2>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[.12em] text-[#989498]">Contagem atualizada ao abrir</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {quotaRows.map((row) => {
          const percentage = row.cap && row.cap > 0 ? Math.min(100, (row.sent / row.cap) * 100) : 0;
          return (
            <div key={row.label} className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4" data-testid={`quota-${row.label === 'Hora corrente' ? 'hour' : 'day'}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-[#565c6a]">{row.label}</span>
                <span className="font-mono text-[10px] text-[#7d7e87]">
                  {formatNumber(row.sent)} / {row.cap && row.cap > 0 ? formatNumber(row.cap) : 'sem teto'}
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e6ded3]">
                <div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${row.cap ? Math.max(row.sent > 0 ? 3 : 0, percentage) : 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {campaign.status === 'pausada' && campaign.pausa_motivo && (
        <div className="mt-5 rounded-xl border border-[#efc9ba] bg-[#fff3ee] px-4 py-3 text-xs leading-5 text-[#8e3a20]" data-testid="status-campaign-pause-reason">
          <strong className="block">Motivo da pausa</strong>
          <span>{campaign.pausa_motivo}</span>
          {(campaign.pausa_taxa_bounce != null || campaign.pausa_taxa_reclamacao != null) && (
            <span className="mt-1 block text-[#a65d46]">
              {campaign.pausa_taxa_bounce != null && `Bounce: ${formatRate(campaign.pausa_taxa_bounce)}`}
              {campaign.pausa_taxa_bounce != null && campaign.pausa_taxa_reclamacao != null && ' · '}
              {campaign.pausa_taxa_reclamacao != null && `Reclamações: ${formatRate(campaign.pausa_taxa_reclamacao)}`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

export function NewCampaignPage({ user }: { user: SessionUser }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  return (
    <Shell user={user} title="Nova campanha" eyebrow="Campanhas / Criar" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
      <div className="mx-auto max-w-4xl animate-rise-in-delay">
        <div className="mb-7 flex items-center gap-3"><Link href="/" className="action-button action-button-secondary !px-3" data-testid="link-back-campaigns"><ArrowLeft size={15} /></Link><div><p className="text-sm font-bold text-[#263044]">Voltar para a lista</p><p className="mt-1 text-xs text-[#85858b]">Preencha os metadados essenciais antes da importação.</p></div></div>
         <CampaignForm onSaved={(campaign) => { queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() }); setLocation(`/campaigns/${campaign.id}`); }} />
      </div>
    </Shell>
  );
}

export function CampaignDetailPage({ user, campaignId }: { user: SessionUser; campaignId: string }) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClearRecipients, setConfirmClearRecipients] = useState(false);
  const campaignQuery = useGetCampaign(campaignId, { query: { enabled: Boolean(campaignId), queryKey: getGetCampaignQueryKey(campaignId), refetchInterval: 15000 } });
  const recipientSummaryQuery = useGetCampaignRecipientSummary(campaignId, {
    query: { enabled: Boolean(campaignId), queryKey: getGetCampaignRecipientSummaryQueryKey(campaignId), refetchInterval: 15000 },
  });
  const deleteCampaign = useDeleteCampaign();
  const clearRecipients = useClearCampaignRecipients();
  const sendTest = useSendCampaignTest();
  const scheduleCampaign = useScheduleCampaign();
  const pauseCampaign = usePauseCampaign();
  const resumeCampaign = useResumeCampaign();
  const cancelCampaign = useCancelCampaign();
  const [testSent, setTestSent] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [scheduleConfirmation, setScheduleConfirmation] = useState('');
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const campaign = campaignQuery.data;

  const clearCurrentRecipients = () => {
    if (!confirmClearRecipients) {
      setConfirmClearRecipients(true);
      return;
    }
    clearRecipients.mutate(
      { campaignId },
      {
        onSuccess: () => {
          setConfirmClearRecipients(false);
          queryClient.invalidateQueries({ queryKey: getGetCampaignRecipientSummaryQueryKey(campaignId) });
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        },
      },
    );
  };

  const deleteCurrent = () => {
    deleteCampaign.mutate({ campaignId }, {
      onSuccess: () => {
        queryClient.removeQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setLocation('/');
      },
    });
  };

  const sendCampaignTest = () => {
    setTestSent(false);
    sendTest.mutate(
      { campaignId },
      {
        onSuccess: () => {
          setTestSent(true);
          queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
        },
      },
    );
  };

  const changeCampaignStatus = (status: 'pausada' | 'enviando') => {
    setOperationError(null);
    const mutation = status === 'pausada' ? pauseCampaign : resumeCampaign;
    mutation.mutate(
      { campaignId },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetCampaignQueryKey(campaignId), updated);
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        },
        onError: (error) => setOperationError(getErrorMessage(error, 'Não foi possível alterar o estado da campanha.')),
      },
    );
  };

  const cancelCurrentCampaign = () => {
    setOperationError(null);
    cancelCampaign.mutate(
      { campaignId },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetCampaignQueryKey(campaignId), updated);
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        },
        onError: (error) => setOperationError(getErrorMessage(error, 'Não foi possível cancelar a campanha.')),
      },
    );
  };

  const openScheduleDialog = () => {
    setOperationError(null);
    if (!campaign) return;
    if (!campaign.teste_enviado) {
      setOperationError('Envie um teste bem-sucedido antes de agendar a campanha.');
      return;
    }
    if (!campaign.agendada_para || Number.isNaN(Date.parse(campaign.agendada_para)) || Date.parse(campaign.agendada_para) <= Date.now()) {
      setOperationError('O agendamento precisa estar no futuro.');
      return;
    }
    if (campaign.lembrete_ativo && (campaign.lembrete_horas < 24 || campaign.lembrete_horas > 168 || !campaign.assunto_lembrete?.trim() || campaign.assunto_lembrete.trim().toLocaleLowerCase('pt-BR') === campaign.assunto.trim().toLocaleLowerCase('pt-BR'))) {
      setOperationError('Revise o assunto e o intervalo do lembrete (24 a 168 horas).');
      return;
    }
    const invalidButton = normalizeEmailBlocks(campaign.corpo).some((block) => block.type === 'button' && !isHttpUrl(block.href));
    if (invalidButton) {
      setOperationError('Informe um destino válido para todos os botões.');
      return;
    }
    const total = recipientSummaryQuery.data?.receberao_de_fato;
    if (total == null) {
      setOperationError('Aguarde a contagem atual dos destinatários antes de agendar.');
      return;
    }
    setScheduleConfirmation(total > 5000 ? '' : String(total));
    setScheduleDialogOpen(true);
  };

  const confirmSchedule = () => {
    const total = recipientSummaryQuery.data?.receberao_de_fato ?? 0;
    if (total > 5000 && scheduleConfirmation.trim() !== String(total)) return;
    scheduleCampaign.mutate(
      { campaignId, data: { confirmacao_destinatarios: scheduleConfirmation.trim() } },
      {
        onSuccess: (updated) => {
          setScheduleDialogOpen(false);
          queryClient.setQueryData(getGetCampaignQueryKey(campaignId), updated);
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        },
        onError: (error) => setOperationError(getErrorMessage(error, 'Não foi possível agendar a campanha.')),
      },
    );
  };

  if (campaignQuery.isLoading) {
    return <Shell user={user} title="Campanha" eyebrow="Campanhas / Abrir" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><div className="panel mx-auto max-w-4xl p-7" data-testid="status-campaign-detail-loading"><div className="skeleton h-5 w-48 rounded-full" /><div className="mt-7 grid gap-4 sm:grid-cols-2">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton h-12 rounded-xl" />)}</div></div></Shell>;
  }
  if (campaignQuery.isError || !campaign) {
    return <Shell user={user} title="Campanha indisponível" eyebrow="Campanhas / Erro" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-campaign-detail-error"><CircleAlert className="mx-auto text-[#bd4f26]" size={24} /><h2 className="mt-4 text-xl font-extrabold text-[#8e3a20]">Não conseguimos abrir esta campanha.</h2><p className="mt-2 text-sm text-[#a65d46]">O registro pode ter sido removido ou estar temporariamente indisponível.</p><div className="mt-5 flex justify-center gap-3"><button onClick={() => campaignQuery.refetch()} className="action-button action-button-primary" data-testid="button-campaign-detail-retry"><RefreshCw size={14} /> Tentar novamente</button><Link href="/" className="action-button action-button-secondary" data-testid="link-campaign-detail-back">Voltar</Link></div></div></Shell>;
  }
  return (
    <Shell user={user} title={campaign.nome} eyebrow="Campanhas / Operação" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
      <div className="animate-rise-in-delay mx-auto max-w-5xl space-y-5">
         <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3"><Link href="/" className="action-button action-button-secondary !px-3" data-testid="link-back-campaign-list"><ArrowLeft size={15} /></Link><div><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#92939a]">ID {campaign.id}</p><div className="mt-1 flex items-center gap-2"><StatusPill status={campaign.status} /><span className="text-xs text-[#777984]">{statusDescriptions[campaign.status]}</span></div></div></div>
           <div className="flex flex-wrap items-center justify-end gap-2">
              {campaign.status === 'rascunho' && (
                <button onClick={openScheduleDialog} disabled={scheduleCampaign.isPending} className="action-button action-button-primary" data-testid="button-schedule-campaign">
                  {scheduleCampaign.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Clock3 size={15} />} Agendar envio
                </button>
              )}
             {(campaign.status === 'enviando' || campaign.status === 'pausada') && (
               <button
                 onClick={() => changeCampaignStatus(campaign.status === 'enviando' ? 'pausada' : 'enviando')}
                  disabled={pauseCampaign.isPending || resumeCampaign.isPending}
                 className={`action-button ${campaign.status === 'enviando' ? 'action-button-secondary' : 'action-button-primary'}`}
                 data-testid={campaign.status === 'enviando' ? 'button-pause-campaign' : 'button-resume-campaign'}
               >
                  {pauseCampaign.isPending || resumeCampaign.isPending ? <LoaderCircle size={15} className="animate-spin" /> : campaign.status === 'enviando' ? <Pause size={15} /> : <Play size={15} />}
                 {campaign.status === 'enviando' ? 'Pausar envio' : 'Retomar envio'}
               </button>
             )}
              {(['agendada', 'enviando', 'pausada'] as string[]).includes(campaign.status) && (
                <button onClick={cancelCurrentCampaign} disabled={cancelCampaign.isPending} className="action-button action-button-secondary !text-[#a64220]" data-testid="button-cancel-campaign">
                  {cancelCampaign.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <X size={15} />} Cancelar envio
                </button>
              )}
             <div className="relative"><button onClick={() => setConfirmDelete((open) => !open)} className="action-button action-button-danger" data-testid="button-delete-campaign"><Trash2 size={15} /> Excluir campanha</button>{confirmDelete && <div className="absolute right-0 top-12 z-10 w-72 rounded-xl border border-[#efc9ba] bg-[#fffaf6] p-4 text-left shadow-[0_18px_45px_rgba(38,48,68,.14)]"><p className="text-sm font-extrabold text-[#263044]">Excluir esta campanha?</p><p className="mt-1 text-xs leading-5 text-[#7d6c6c]">Esta ação remove os metadados da campanha.</p><div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfirmDelete(false)} className="action-button action-button-secondary !px-3" data-testid="button-cancel-delete">Cancelar</button><button onClick={deleteCurrent} disabled={deleteCampaign.isPending} className="action-button action-button-danger !px-3" data-testid="button-confirm-delete">{deleteCampaign.isPending ? <LoaderCircle size={14} className="animate-spin" /> : 'Excluir'}</button></div></div>}</div>
           </div>
        </div>
        {deleteCampaign.isError && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#a64220]" data-testid="status-delete-error">Não foi possível excluir a campanha. Tente novamente.</div>}
         {operationError && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#a64220]" data-testid="status-campaign-operation-error">{operationError}</div>}
          {scheduleDialogOpen && (
            <div className="rounded-2xl border-2 border-[#d35f2a] bg-[#fff8ef] p-5 sm:p-6" role="dialog" aria-labelledby="schedule-confirmation-title" data-testid="dialog-schedule-confirmation">
              <p className="section-kicker text-[#a64220]">Confirmação de agendamento</p>
              <h3 id="schedule-confirmation-title" className="mt-2 text-lg font-extrabold text-[#263044]">Revise o tamanho do disparo antes de continuar.</h3>
              <p className="mt-2 text-sm leading-6 text-[#6d7180]">A lista atual tem <strong className="text-xl font-extrabold tabular-nums text-[#a64220]">{formatNumber(recipientSummaryQuery.data?.receberao_de_fato)}</strong> destinatários que receberão de fato.</p>
              {(recipientSummaryQuery.data?.receberao_de_fato ?? 0) > 5000 ? (
                <label className="mt-5 block text-xs font-bold text-[#565c6a]">Digite {formatNumber(recipientSummaryQuery.data?.receberao_de_fato)} para confirmar<input value={scheduleConfirmation} onChange={(event) => setScheduleConfirmation(event.target.value.replace(/\D/g, ''))} inputMode="numeric" className="field-control mt-2" placeholder={String(recipientSummaryQuery.data?.receberao_de_fato)} data-testid="input-schedule-confirmation" /></label>
              ) : (
                <p className="mt-5 rounded-xl border border-[#e5ddd0] bg-[#fffdf9] px-4 py-3 text-xs leading-5 text-[#6d7180]">A confirmação é registrada com a contagem atual da lista.</p>
              )}
              <div className="mt-5 flex flex-col-reverse justify-end gap-3 sm:flex-row">
                <button type="button" onClick={() => setScheduleDialogOpen(false)} className="action-button action-button-secondary" data-testid="button-cancel-schedule-confirmation">Voltar</button>
                <button type="button" onClick={confirmSchedule} disabled={scheduleCampaign.isPending || ((recipientSummaryQuery.data?.receberao_de_fato ?? 0) > 5000 && scheduleConfirmation.trim() !== String(recipientSummaryQuery.data?.receberao_de_fato))} className="action-button action-button-primary" data-testid="button-confirm-schedule">{scheduleCampaign.isPending ? <><LoaderCircle size={16} className="animate-spin" /> Agendando...</> : <><CheckCircle2 size={16} /> Confirmar agendamento</>}</button>
              </div>
            </div>
          )}
          <RecipientSummaryPanel
            summary={recipientSummaryQuery.data}
            loading={recipientSummaryQuery.isLoading}
            onClear={clearCurrentRecipients}
            confirmClear={confirmClearRecipients}
            onCancelClear={() => setConfirmClearRecipients(false)}
            canClear={campaign.status !== 'agendada' && campaign.status !== 'enviando'}
            clearPending={clearRecipients.isPending}
            error={recipientSummaryQuery.error ? getErrorMessage(recipientSummaryQuery.error, 'Não foi possível carregar o resumo dos destinatários.') : null}
            clearError={clearRecipients.error ? getErrorMessage(clearRecipients.error, 'Não foi possível limpar os destinatários.') : null}
          />
          <CampaignForm
            campaign={campaign}
            onSaved={(updated) => {
              queryClient.setQueryData(getGetCampaignQueryKey(campaignId), updated);
              queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
            }}
            onSendTest={sendCampaignTest}
            testPending={sendTest.isPending}
            testError={sendTest.error ? getErrorMessage(sendTest.error, "Não foi possível enviar o teste.") : null}
            testSent={testSent}
          />
         <SendQuotaPanel campaign={campaign} />
        <ImportPanel campaignId={campaignId} />
      </div>
    </Shell>
  );
}