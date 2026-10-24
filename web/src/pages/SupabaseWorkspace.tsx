import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleAlert, Copy, GlassWater, KeyRound, Loader2,
  LockKeyhole, MessageCircle, RefreshCw, Search, ShieldCheck,
} from 'lucide-react';
import type { Chat } from '@/lib/api';
import { juiceGroups, juicesInGroup, type JuiceGroup } from '@/lib/juice-types';
import { confidentialApi, confidentialErrorText } from '@/lib/confidential-api';
import { installPrivateLegacyBridge } from '@/lib/private-legacy-bridge';
import { openConfidentialChannel, parseLegacyIdentityHandoff, type ConfidentialChannel } from '@/lib/confidential-channel';
import { forgetLocalKey, formatRecoveryCode, loadLocalKey, parseRecoveryCode, saveLocalKey } from '@/lib/confidential-key';
import { getSucoSupabase } from '@/lib/supabase';
import { workerTargetForAccount } from '@/lib/worker-targets';
import { PrivateAppLayout } from '@/components/PrivateAppLayout';
import { PrivateLayoutContext } from '@/components/AppLayout';
import { PrivateJuiceCreate, PrivateJuiceLibrary } from '@/components/PrivateJuiceFlow';
import { PrivateVault } from '@/components/PrivateVault';
import { PrivateJuiceTypes } from '@/components/PrivateJuiceTypes';
import { PrivateDigest } from '@/components/PrivateDigest';
import { PrivateCalendar } from '@/components/PrivateCalendar';
import { PrivateGuide } from '@/components/PrivateGuide';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import './supabase-workspace.css';

type Account = { accountId: string; email: string; entitlement: string; legacyLinked: boolean };
type Phase = 'checking' | 'needs-key' | 'conflict' | 'opening' | 'ready' | 'unavailable' | 'error';
type WorkspaceView = 'home' | 'create' | 'conversations' | 'summaries' | 'myTypes' | 'calendar' | 'digest' | 'cofre' | 'settings' | 'guide' | 'whatsapp';
type RenderView = WorkspaceView | 'other';
const paths: Record<WorkspaceView, string> = {
  home: '/', create: '/create', conversations: '/conversations',
  summaries: '/summaries', myTypes: '/my-juices', calendar: '/calendar', digest: '/digest', cofre: '/cofre',
  settings: '/settings', guide: '/guide', whatsapp: '/onboarding',
};
const keyEpoch = 1;
const OriginalDashboard = lazy(() => import('@/pages/Dashboard'));
const OriginalConversations = lazy(() => import('@/pages/Conversations'));
const OriginalSummaries = lazy(() => import('@/pages/Summaries'));
const OriginalMyTypes = lazy(() => import('@/pages/MyJuiceTypes'));
const OriginalDigest = lazy(() => import('@/pages/Digest'));
const OriginalGuide = lazy(() => import('@/pages/Guide'));
const OriginalOnboarding = lazy(() => import('@/pages/Onboarding'));
const OriginalSettings = lazy(() => import('@/pages/Settings'));

function dateLabel(value: string | null | undefined): string {
  if (!value) return 'Ainda não registrada';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Data indisponível' :
    new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function relativeLabel(value: string | null | undefined): string {
  if (!value) return 'Sem mensagens';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Data indisponível';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'Agora';
  if (minutes < 60) return `Há ${minutes} min`;
  if (minutes < 24 * 60) return `Há ${Math.floor(minutes / 60)} h`;
  return dateLabel(value);
}

function firstName(name: string): string { return name.trim().charAt(0).toLocaleUpperCase('pt-BR') || '?'; }

export default function SupabaseWorkspace({ session, account, onSignOut }: {
  session: Session; account: Account; onSignOut: () => Promise<void>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const view: RenderView = location.pathname === '/account' || location.pathname === '/home' ? 'home' :
    location.pathname.startsWith('/my-juices/') ? 'myTypes' :
    (Object.keys(paths) as WorkspaceView[]).find(item => paths[item] === location.pathname) ?? 'other';
  const queryClient = useQueryClient();
  const [homeRequest, setHomeRequest] = useState('');
  const [juiceGroup, setJuiceGroup] = useState<JuiceGroup>('everyday');
  const [phase, setPhase] = useState<Phase>('checking');
  const [channel, setChannel] = useState<ConfidentialChannel | null>(null);
  const channelRef = useRef<ConfidentialChannel | null>(null);
  const bridgeCleanup = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const openGeneration = useRef(0);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [settingsCode, setSettingsCode] = useState('');
  const [keySavedLocally, setKeySavedLocally] = useState(true);
  const [keyError, setKeyError] = useState('');
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [kind, setKind] = useState<'group' | 'all' | 'person'>('group');
  const [chatLimit, setChatLimit] = useState(100);
  const [chatOffset, setChatOffset] = useState(0);
  const [messageLimit, setMessageLimit] = useState(100);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const lastRenderedChat = useRef<string | null>(null);
  const followLatestMessage = useRef(true);
  const olderMessageAnchor = useRef<{ chat: string; top: number; height: number } | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [pairingConfirmed, setPairingConfirmed] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualNotice, setManualNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const scope = ['private', account.accountId];
  const open = useCallback(async (provided?: Uint8Array): Promise<boolean> => {
    const generation = ++openGeneration.current;
    const target = workerTargetForAccount(account.accountId, import.meta.env);
    if (!target) { setPhase('unavailable'); return false; }
    setPhase('opening'); setKeyError('');
    let key = provided;
    try {
      key ??= await loadLocalKey(account.accountId, keyEpoch) ?? undefined;
      if (!mounted.current || generation !== openGeneration.current) return false;
      if (!key) { setPhase('needs-key'); return false; }
      const current = (await getSucoSupabase()?.auth.getSession())?.data.session;
      if (!mounted.current || generation !== openGeneration.current) return false;
      if (!current || current.user.id !== account.accountId)
        throw Error('SESSION_UNAVAILABLE');
      const release = { baseUrl: target.url, imageDigest: target.digest,
        ownerId: account.accountId, keyEpoch, userKey: key,
        accessToken: current.access_token, refreshToken: current.refresh_token };
      let next: ConfidentialChannel;
      try { next = await openConfidentialChannel(release); }
      catch (error) {
        if (!account.legacyLinked || !(error instanceof Error) ||
            error.message !== 'CONFIDENTIAL_LEGACY_IDENTITY_REQUIRED') throw error;
        if (!mounted.current || generation !== openGeneration.current) return false;
        const response = await getSucoSupabase()!.rpc('suco_owner_identity_handoff');
        if (!mounted.current || generation !== openGeneration.current) return false;
        if (response.error) throw Error('OWNER_HANDOFF_UNAVAILABLE');
        const legacyIdentity = parseLegacyIdentityHandoff(response.data);
        next = await openConfidentialChannel({ ...release, legacyIdentity });
      }
      if (!mounted.current || generation !== openGeneration.current) { next.close(); return false; }
      bridgeCleanup.current?.();
      channelRef.current?.close();
      bridgeCleanup.current = installPrivateLegacyBridge(next, account.accountId, account.entitlement);
      channelRef.current = next;
      setChannel(next);
      setPhase('ready');
      return true;
    } catch (error) {
      if (mounted.current && generation === openGeneration.current) {
        setKeyError(confidentialErrorText(error));
        const code = error instanceof Error ? error.message : '';
        setPhase(['LOCAL_KEY_DAMAGED', 'LOCAL_KEY_STORAGE_UNAVAILABLE'].includes(code) ? 'needs-key'
          : ['AUTH_STATE_CORRUPT', 'WORKER_REATTACH_DENIED'].includes(code) ? 'conflict' : 'error');
      }
      return false;
    } finally { key?.fill(0); }
  }, [account.accountId, account.entitlement]);

  /** First entry on a device creates the key silently; the recovery code is never a blocking step. */
  const bootstrap = useCallback(async (): Promise<boolean> => {
    if (!workerTargetForAccount(account.accountId, import.meta.env)) { setPhase('unavailable'); return false; }
    let existing: Uint8Array | null = null;
    try { existing = await loadLocalKey(account.accountId, keyEpoch); }
    catch {
      setPhase('needs-key');
      setKeyError('A chave salva neste dispositivo não pôde ser lida. Use seu código de recuperação.');
      return false;
    }
    if (existing) return open(existing);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    try { await saveLocalKey(account.accountId, keyEpoch, raw); setKeySavedLocally(true); }
    catch (error) {
      if (error instanceof Error && error.message === 'LOCAL_KEY_EXISTS') return open();
      setPhase('needs-key');
      setKeyError('Este navegador não permitiu guardar sua chave. Tente outro navegador ou dispositivo.');
      return false;
    }
    setRecoveryCode(formatRecoveryCode(raw));
    setCopied(false);
    return open(raw);
  }, [account.accountId, open]);

  useEffect(() => {
    mounted.current = true;
    if (!workerTargetForAccount(account.accountId, import.meta.env)) setPhase('unavailable');
    else void bootstrap();
    return () => {
      mounted.current = false;
      openGeneration.current++;
      bridgeCleanup.current?.();
      bridgeCleanup.current = null;
      channelRef.current?.close();
      channelRef.current = null;
      queryClient.clear();
    };
  }, [account.accountId, bootstrap, queryClient]);

  useEffect(() => {
    if (phase === 'ready' && location.pathname === '/account') navigate('/', { replace: true });
  }, [phase, location.pathname, navigate]);

  useEffect(() => {
    if (phase === 'ready' && view === 'other') navigate('/', { replace: true });
  }, [phase, view, navigate]);

  useEffect(() => {
    if (phase !== 'ready' || !channel || view !== 'home') return;
    let cancelled = false;
    void (async () => {
      const client = getSucoSupabase();
      if (!client) return;
      const response = await client.rpc('suco_consent_status');
      if (!cancelled && !response.error && response.data &&
          typeof response.data === 'object' &&
          (response.data as { consent?: unknown }).consent === null)
        navigate('/onboarding', { replace: true });
    })();
    return () => { cancelled = true; };
  }, [phase, channel, view, navigate, account.accountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  async function recoverKey(event: React.FormEvent) {
    event.preventDefault(); setKeyError('');
    let raw: Uint8Array;
    try { raw = parseRecoveryCode(recoveryInput); }
    catch { setKeyError('Código de recuperação inválido. Confira todos os caracteres.'); return; }
    setRecoveryInput('');
    const recoveryCopy = raw.slice();
    try {
      const ready = await open(raw);
      if (!ready) return;
      try {
        // A verified release may replace an unreadable local record, never an unverified guess.
        await forgetLocalKey(account.accountId, keyEpoch);
        await saveLocalKey(account.accountId, keyEpoch, recoveryCopy);
        setKeySavedLocally(true);
      } catch { setKeySavedLocally(false); }
    } finally { recoveryCopy.fill(0); }
  }

  const statusQuery = useQuery({
    queryKey: [...scope, 'status'], queryFn: () => confidentialApi.status(channel!),
    enabled: false,
    refetchInterval: query => {
      const state = query.state.data?.connectionState;
      return state === 'qr_required' || state === 'connecting' || state === 'reconnecting' ? 3_000 : 15_000;
    },
    refetchOnWindowFocus: true, refetchOnReconnect: true, retry: 1,
  });
  const dashboardQuery = useQuery({
    queryKey: [...scope, 'dashboard'], queryFn: () => confidentialApi.dashboard(channel!),
    enabled: false,
    refetchInterval: 30_000, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: 1,
  });
  const recentSummariesQuery = useQuery({
    queryKey: [...scope, 'summaries', 0], queryFn: () => confidentialApi.summaries(channel!, 50, 0),
    enabled: false, refetchInterval: 30_000, refetchOnWindowFocus: true, retry: 1,
  });
  const chatsQuery = useQuery({
    queryKey: [...scope, 'chats', kind, debouncedSearch, chatLimit, chatOffset],
    queryFn: () => confidentialApi.chats(channel!, { kind, q: debouncedSearch, limit: chatLimit, offset: chatOffset }),
    enabled: false, refetchInterval: 15_000, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: 1,
  });
  const currentChat = chatsQuery.data?.chats.find(chat => chat.jid === selectedChat?.jid) ?? selectedChat;
  const statsQuery = useQuery({
    queryKey: [...scope, 'stats', currentChat?.jid],
    queryFn: () => confidentialApi.stats(channel!, currentChat!.jid),
    enabled: false, refetchInterval: 15_000,
    refetchOnWindowFocus: true, refetchOnReconnect: true, retry: 1,
  });
  const messageCount = statsQuery.data?.count ?? 0;
  const messageOffset = Math.max(0, messageCount - messageLimit);
  const messagesQuery = useQuery({
    queryKey: [...scope, 'messages', currentChat?.jid, messageOffset, messageLimit],
    queryFn: () => confidentialApi.messages(channel!, currentChat!.jid, messageLimit, messageOffset),
    enabled: false,
    refetchInterval: 15_000, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: 1,
  });

  useLayoutEffect(() => {
    const element = messageScrollRef.current;
    if (!element || !currentChat || !messagesQuery.data) return;
    const anchor = olderMessageAnchor.current;
    if (anchor?.chat === currentChat.jid) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      olderMessageAnchor.current = null;
    } else if (lastRenderedChat.current !== currentChat.jid || followLatestMessage.current) {
      element.scrollTop = element.scrollHeight;
    }
    lastRenderedChat.current = currentChat.jid;
  }, [currentChat?.jid, messagesQuery.data]);

  async function manualSync() {
    setManualBusy(true); setManualNotice('');
    const result = await Promise.all([statusQuery.refetch(), chatsQuery.refetch(),
      currentChat ? statsQuery.refetch() : Promise.resolve(null),
      currentChat ? messagesQuery.refetch() : Promise.resolve(null)]);
    const failed = result.some(item => item && item.error);
    setManualNotice(failed ? 'Não foi possível conferir todas as conversas. Tente novamente.' :
      'Conferimos as mensagens salvas agora. Novas mensagens chegam automaticamente quando o WhatsApp as entrega.');
    setManualBusy(false);
  }

  async function connectionAction(fresh: boolean) {
    if (!channel || connectionBusy) return;
    setConnectionBusy(true); setConnectionError('');
    try {
      if (fresh) await confidentialApi.newPairing(channel);
      else await confidentialApi.reconnect(channel);
      setPairingConfirmed(false);
      await statusQuery.refetch();
    } catch (error) { setConnectionError(confidentialErrorText(error)); }
    finally { setConnectionBusy(false); }
  }

  async function signOut() {
    bridgeCleanup.current?.();
    bridgeCleanup.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    setChannel(null);
    queryClient.clear();
    try {
      await forgetLocalKey(account.accountId, keyEpoch);
      await onSignOut();
    } catch {
      setPhase('needs-key');
      setKeyError('Não foi possível concluir a saída e remover a chave local. Confira os dados deste navegador antes de compartilhar o dispositivo.');
    }
  }

  const status = statusQuery.data;
  const qrSeconds = status?.qrExpiresAt ? Math.max(0, Math.ceil((Date.parse(status.qrExpiresAt) - now) / 1_000)) : 0;
  const qrActive = !!status?.qr && qrSeconds > 0;
  const actionRequired = status?.connectionState === 'action_required';
  const needsNewPairing = actionRequired && (status?.pairingError === 'PAIRING_ACCOUNT_MISMATCH' ||
    (!status?.pairingError && ['bad_session', 'multidevice_mismatch', 'logged_out'].includes(status?.reason ?? '')));
  const identityBlocked = status?.pairingError === 'PAIRING_IDENTITY_UNAVAILABLE';
  const forbidden = status?.reason === 'forbidden';
  const canReconnect = !!status && !status.connected && !qrActive && !needsNewPairing && !identityBlocked &&
    !forbidden && !['connecting', 'reconnecting'].includes(status.connectionState ?? '');
  const sync = status?.syncEvidence;
  const visibleChats = chatsQuery.data?.chats ?? [];
  const pageTitle: Record<RenderView, string> = {
    home: 'Seu espaço', create: 'Fazer um suco', conversations: 'Suas conversas',
    summaries: 'Meus sucos', myTypes: 'Meus tipos', calendar: 'Agenda', digest: 'Resumo do dia',
    cofre: 'Cofre', settings: 'Configurações', guide: 'Guia do Suco',
    whatsapp: 'Conexão do WhatsApp', other: 'Seu espaço',
  };

  function goTo(next: WorkspaceView) {
    setMobileDetail(false);
    navigate(paths[next]);
  }

  if (phase === 'ready' && channel &&
      ['home', 'create', 'conversations', 'summaries', 'myTypes', 'digest', 'guide', 'whatsapp', 'settings'].includes(view)) {
    const Original = view === 'home' ? OriginalDashboard :
      view === 'create' || view === 'conversations' ? OriginalConversations :
      view === 'summaries' ? OriginalSummaries : view === 'myTypes' ? OriginalMyTypes :
      view === 'digest' ? OriginalDigest : view === 'whatsapp' ? OriginalOnboarding :
      view === 'settings' ? OriginalSettings : OriginalGuide;
    return <PrivateLayoutContext.Provider value={{ email: account.email, onSignOut: signOut }}>
      <Suspense fallback={<p className="p-8" role="status">Abrindo sua página…</p>}><Original /></Suspense>
    </PrivateLayoutContext.Provider>;
  }

  return <main className="private-workspace">
    {phase !== 'ready' && <header className="private-header">
      <div className="private-brand"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" width="48" height="48" alt="" />
        <div><strong>Suco de Zap</strong><span>Seu espaço privado</span></div></div>
      <div className="private-header-actions"><span className="private-account-email" title={account.email}>{account.email}</span>
        <Button variant="outline" size="sm" onClick={signOut}>Sair e remover chave</Button></div>
    </header>}

    {phase !== 'ready' ? <section className="private-entry" aria-live="polite">
      <div className="private-entry-icon"><LockKeyhole size={30} /></div>
      <p className="private-eyebrow">Processamento privado</p>
      <h1>{phase === 'unavailable' ? 'Seu espaço ainda não está disponível.' :
        phase === 'checking' || phase === 'opening' ? 'Abrindo seu espaço privado…' :
        phase === 'conflict' ? 'Este espaço já tem uma chave.' :
        phase === 'error' ? 'Não conseguimos abrir o espaço.' : 'Sua chave fica com você.'}</h1>
      {phase === 'unavailable' && <p>A conexão segura ainda não foi publicada para esta conta. Seu WhatsApp e seu histórico permanecem preservados.</p>}
      {(phase === 'checking' || phase === 'opening') && <p role="status"><Loader2 className="inline h-4 w-4 animate-spin" /> Verificando o worker antes de abrir seus dados.</p>}
      {phase === 'needs-key' && <><p>Este navegador não tem sua chave. Entre com o código de recuperação que você guardou ao abrir seu espaço pela primeira vez.</p>
        <div className="private-entry-actions"><Button onClick={() => setRecoveryMode(true)} variant={recoveryMode ? 'default' : 'outline'}>Tenho meu código</Button></div>
        {recoveryMode && <form className="private-recovery-form" onSubmit={recoverKey}><Label htmlFor="recovery-key">Código de recuperação</Label>
          <Input id="recovery-key" type="password" autoComplete="off" spellCheck={false} value={recoveryInput}
            onChange={event => setRecoveryInput(event.target.value)} placeholder="SUCO1-…" required />
          <Button type="submit">Abrir com meu código</Button></form>}
        <p className="private-entry-note">Sem o código, o espaço privado pode ser redefinido: o pareamento e os resumos salvos começam de novo, e as conversas seguem intactas no seu WhatsApp.</p>
      </>}
      {phase === 'conflict' && <><p>Este espaço privado já foi aberto com outra chave, provavelmente em outro navegador. Entre com o código de recuperação original para continuar com todo o histórico.</p>
        <form className="private-recovery-form" onSubmit={recoverKey}><Label htmlFor="recovery-key">Código de recuperação</Label>
          <Input id="recovery-key" type="password" autoComplete="off" spellCheck={false} value={recoveryInput}
            onChange={event => setRecoveryInput(event.target.value)} placeholder="SUCO1-…" required />
          <Button type="submit">Abrir com meu código</Button></form>
        <p className="private-entry-note">Perdeu o código? O espaço privado pode ser redefinido: o pareamento e os resumos salvos começam de novo, e as conversas seguem intactas no seu WhatsApp.</p>
      </>}
      {phase === 'error' && <><p>Se o worker estiver reiniciando, você poderá tentar novamente. Nenhuma conversa foi enviada para um serviço legível.</p>
        <Button onClick={() => void open()}>Tentar abrir novamente</Button></>}
      {keyError && <p className="private-error" role="alert">{keyError}</p>}
    </section> : <PrivateAppLayout email={account.email} onSignOut={signOut}><div className="private-body">
      {recoveryCode && <section className="private-recovery-banner" role="status" aria-label="Código de recuperação">
        <div><strong>Guarde seu código de recuperação</strong>
          <p>Ele abre seu espaço privado em outro navegador. O Suco não consegue recuperá-lo depois.</p></div>
        <code>{recoveryCode}</code>
        <div className="private-entry-actions">
          <Button variant="outline" size="sm" onClick={async () => {
            try { await navigator.clipboard.writeText(recoveryCode); setCopied(true); }
            catch { setKeyError('Não foi possível copiar automaticamente. Selecione e copie o código acima.'); }
          }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copiado' : 'Copiar'}</Button>
          <Button variant="outline" size="sm" onClick={() => { setRecoveryCode(''); setCopied(false); }}>Já guardei</Button>
        </div>
      </section>}
      {view !== 'home' && <section className="private-heading"><div><p className="private-eyebrow"><ShieldCheck size={15} /> Canal verificado</p>
        <h1>{pageTitle[view]}</h1><p>{view === 'conversations' ? 'As mensagens salvas aparecem aqui e são conferidas automaticamente.' :
          view === 'whatsapp' ? 'Confira a conexão, sincronize as mensagens ou leia um novo QR.' :
          view === 'create' ? 'Escolha um grupo para transformar as mensagens em informação útil.' :
          view === 'myTypes' ? 'Crie receitas para usar de novo nos seus grupos.' :
          view === 'calendar' ? 'Transforme um combinado em um evento da sua agenda.' :
          view === 'digest' ? 'Veja os assuntos e combinados de um dia de conversas.' :
          view === 'cofre' ? 'Encontre dados e trechos nas mensagens que já foram salvas.' :
          view === 'settings' ? 'Confira a conexão e atualize sua conta.' :
          view === 'guide' ? 'Entenda onde encontrar cada recurso do Suco.' :
          'Encontre os sucos criados nesta conta.'}</p></div>
        {(view === 'conversations' || view === 'whatsapp' || view === 'settings') && <Button variant="outline" disabled={manualBusy} onClick={manualSync}><RefreshCw className={manualBusy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Sincronizar conversas</Button>}</section>}

      {(manualNotice || statusQuery.error || chatsQuery.error) && <div className={statusQuery.error || chatsQuery.error ? 'private-error' : 'private-notice'} role={statusQuery.error || chatsQuery.error ? 'alert' : 'status'}>
        {statusQuery.error || chatsQuery.error ? confidentialErrorText(statusQuery.error || chatsQuery.error) : manualNotice}</div>}
      {!keySavedLocally && <p className="private-soft-warning" role="status"><KeyRound size={16} /> A chave não foi salva neste navegador. Você precisará do código de recuperação após o F5.</p>}

      {view === 'home' && <div className="suco-search-home">
        <section className="suco-search-start" aria-labelledby="search-title">
          <h1 id="search-title">De que papo vai sair suco?</h1>
          <p>Escolha um tema ou conte o que você quer entender.</p>
          <form role="search" className="suco-search-form" onSubmit={event => { event.preventDefault(); if (homeRequest.trim()) navigate(`/create?request=${encodeURIComponent(homeRequest.trim())}`); }}>
            <label className="sr-only" htmlFor="suco-private-search">Que assunto você quer transformar em suco?</label>
            <Search aria-hidden="true" className="suco-search-icon" />
            <input id="suco-private-search" type="search" autoComplete="off" maxLength={500} value={homeRequest}
              onChange={event => setHomeRequest(event.target.value)} placeholder="Ex.: o que combinamos sobre a viagem?" />
            <Button type="submit" disabled={!homeRequest.trim()}><Search size={18} aria-hidden="true" /><span>Preparar suco</span></Button>
          </form>
          <p className="suco-search-help">Você escolhe a conversa e o período antes de gerar.</p>
          <div className="suco-search-examples" aria-label="Ideias de busca">
            {['O que ficou combinado?', 'Prazos do lançamento', 'Pendências com clientes'].map(example =>
              <button key={example} type="button" onClick={() => setHomeRequest(example)}>{example}<ArrowRight size={14} aria-hidden="true" /></button>)}
          </div>
        </section>
        <section className="suco-juice-catalog" aria-labelledby="home-juice-title">
          <header><h2 id="home-juice-title">Escolhe o sabor do papo.</h2><p>17 jeitos de tirar o que interessa. Do grupo do trabalho à conversa a dois.</p></header>
          <div className="suco-juice-groups" role="group" aria-label="Temas de suco">{juiceGroups.map(group =>
            <button key={group.id} type="button" aria-pressed={juiceGroup === group.id} onClick={() => setJuiceGroup(group.id)}>{group.label}</button>)}</div>
          <p role="status" className="suco-juice-count">{juicesInGroup(juiceGroup).length} modelos · {juiceGroups.find(group => group.id === juiceGroup)?.label.replace(' (17)', '')}</p>
          <ul className="suco-juice-options">{juicesInGroup(juiceGroup).map(type => <li key={type.id}>
            <button type="button" className="suco-juice-choice" onClick={() => navigate(`/create?suco=${encodeURIComponent(type.id)}`)}>
              <GlassWater size={21} aria-hidden="true" /><span><strong>{type.title}</strong><small>{type.description}</small></span><ArrowUpRight size={17} aria-hidden="true" />
            </button></li>)}</ul>
          <p className="suco-juice-note">Escolher um tema prepara o pedido; você confere antes de gerar.</p>
        </section>
        <section className="suco-search-recent" aria-labelledby="recent-title"><div className="suco-search-output-heading"><h2 id="recent-title">{recentSummariesQuery.data?.summaries.length ? 'Seus sucos recentes' : 'O primeiro gole é seu.'}</h2>
          <button type="button" onClick={() => goTo('summaries')}>Ver todos</button></div>
          {recentSummariesQuery.error && <p className="private-error" role="alert">{confidentialErrorText(recentSummariesQuery.error)}</p>}
          {recentSummariesQuery.data?.summaries.length ? <div className="private-home-summaries">{recentSummariesQuery.data.summaries.slice(0, 3).map(summary =>
            <button type="button" key={summary.id} onClick={() => goTo('summaries')}><strong>{summary.title}</strong><span>{summary.chat_name} · {dateLabel(summary.created_at)}</span><ArrowRight size={16} /></button>)}</div> :
          <div className="suco-search-empty"><p>Seu zap já tem história. Escolha uma conversa e transforme as mensagens em um resumo do que interessa.</p>
            <Button variant="outline" onClick={() => goTo('conversations')}>Conferir minhas conversas <ArrowRight size={16} className="ml-2" /></Button></div>
          }
        </section>
        <details className="suco-search-collection"><summary>O que já está no meu Suco?</summary><p>{dashboardQuery.data ?
          `${dashboardQuery.data.chats.toLocaleString('pt-BR')} conversas e ${dashboardQuery.data.messages.toLocaleString('pt-BR')} mensagens sincronizadas.` :
          'Conferindo seu acervo…'} O Suco só lê e organiza. Nenhuma mensagem é enviada pelo seu número.</p>
          <button type="button" onClick={() => goTo('whatsapp')}>Conferir conexão</button></details>
      </div>}

      {view === 'settings' && <section className="private-juice-card private-settings-overview"><h2>Sua conta</h2>
        <p><strong>E-mail:</strong> {account.email}</p><p><strong>Canal privado:</strong> verificado nesta sessão</p>
        <p><strong>Mensagens salvas:</strong> {dashboardQuery.data?.messages.toLocaleString('pt-BR') ?? 'Conferindo…'}</p>
        <p><strong>Chave neste navegador:</strong> {keySavedLocally ? 'salva para recarregar a página' : 'use seu código de recuperação após recarregar'}</p>
        <p><strong>Código de recuperação:</strong> {settingsCode
          ? <code className="private-recovery-inline">{settingsCode}</code>
          : <Button variant="outline" size="sm" onClick={async () => {
              try {
                const local = await loadLocalKey(account.accountId, keyEpoch);
                if (local) setSettingsCode(formatRecoveryCode(local));
                else setKeyError('Sem chave salva neste navegador. Use seu código de recuperação.');
              } catch { setKeyError('A chave salva neste dispositivo não pôde ser lida.'); }
            }}>Mostrar</Button>}</p>
        <Button variant="outline" onClick={() => goTo('whatsapp')}>Abrir conexão e QR <ChevronRight size={16} /></Button>
      </section>}
      {(view === 'whatsapp' || view === 'settings') && <section className="private-connection" aria-label="Conexão do WhatsApp">
        <div className="private-connection-copy"><span className={`private-connection-dot ${status?.connected ? 'is-connected' : ''}`} />
          <div><h2>{status?.connected ? 'WhatsApp conectado' : statusQuery.isLoading ? 'Conferindo WhatsApp…' :
            qrActive ? 'Leia este QR no WhatsApp' : actionRequired ? 'Sua conexão precisa de atenção' : 'WhatsApp aguardando conexão'}</h2>
            <p>{status?.connected ? sync?.newMessageAfterConnect ? 'Uma mensagem nova já foi salva após a conexão.' :
              'Conectado. Aguardando uma mensagem nova para confirmar a atualização.' :
              status?.pairingError === 'PAIRING_ACCOUNT_MISMATCH' ? 'O QR foi lido com outro WhatsApp. Use o mesmo número já vinculado a esta conta.' :
              identityBlocked ? 'A identidade anterior não pôde ser confirmada. A conta e o histórico foram preservados.' :
              forbidden ? 'O WhatsApp recusou a conexão. Confira a conta no celular.' :
              status?.reason === 'connection_replaced' ? 'Outra conexão substituiu esta sessão. Confira Aparelhos conectados no celular antes de tentar novamente.' :
              status?.connectionState === 'reconnecting' || status?.connectionState === 'connecting' ? 'Esperando a resposta do WhatsApp.' :
              qrActive ? 'No celular: Aparelhos conectados → Conectar aparelho. O código expira em breve.' :
              'Prepare um novo QR para conectar esta conta.'}</p>
            {sync && <p className="private-sync-evidence">Última mensagem salva: <strong>{dateLabel(sync.lastIngestedAt)}</strong>
              {sync.pendingInMemory ? ` · ${sync.pendingInMemory} aguardando gravação` : ''}</p>}
          </div></div>
        <div className="private-connection-action">
          {qrActive && status?.qr ? <div className="private-qr"><QRCodeSVG value={status.qr} size={190} level="M" title="QR do WhatsApp" />
            <small>Expira em {qrSeconds}s</small></div> :
            needsNewPairing ? <div className="private-pairing"><label><input type="checkbox" checked={pairingConfirmed} onChange={event => setPairingConfirmed(event.target.checked)} />
              <span>Vou ler o novo QR com o mesmo WhatsApp desta conta.</span></label>
              <Button disabled={!pairingConfirmed || connectionBusy} onClick={() => connectionAction(true)}>
                {connectionBusy ? 'Preparando…' : 'Preparar novo pareamento'}</Button></div> :
            status?.connected ? <Button variant="outline" disabled={connectionBusy} onClick={() => connectionAction(false)}>
              {connectionBusy ? 'Reconectando…' : 'Reconectar WhatsApp'}</Button> :
            canReconnect ? <Button disabled={connectionBusy} onClick={() => connectionAction(false)}>
              {connectionBusy ? 'Preparando…' : status?.reason === 'qr_expired' ? 'Gerar outro QR' : 'Preparar QR de conexão'}</Button> : null}
          {connectionError && <p className="private-error" role="alert">{connectionError}</p>}
        </div>
      </section>}

      {sync?.available === false && <p className="private-soft-warning" role="status"><CircleAlert size={16} /> Ainda não conseguimos verificar quando a última mensagem foi salva.</p>}
      {sync?.writeHealth && sync.writeHealth.consecutiveWriteFailures > 0 && <p className="private-soft-warning" role="alert"><CircleAlert size={16} /> A gravação de mensagens está instável. Vamos continuar tentando; confira novamente em instantes.</p>}
      {view === 'create' && channel && <PrivateJuiceCreate channel={channel} accountId={account.accountId}
        preselectedChat={currentChat} searchParams={location.search} onOpenSummaries={() => goTo('summaries')} />}
      {view === 'summaries' && channel && <PrivateJuiceLibrary channel={channel} accountId={account.accountId}
        onCreate={() => goTo('create')} />}
      {view === 'cofre' && channel && <PrivateVault channel={channel} accountId={account.accountId} />}
      {view === 'myTypes' && channel && <PrivateJuiceTypes channel={channel} accountId={account.accountId}
        onUse={id => navigate(`/create?suco=personal:${id}`)} />}
      {view === 'digest' && channel && <PrivateDigest channel={channel} accountId={account.accountId} />}
      {view === 'calendar' && channel && <PrivateCalendar channel={channel} accountId={account.accountId} />}
      {view === 'guide' && <PrivateGuide onNavigate={path => navigate(path)} />}

      {view === 'conversations' && <div className="private-conversations">
        <aside className={`private-chat-list ${mobileDetail ? 'is-mobile-hidden' : ''}`} aria-label="Lista de conversas">
          <div className="private-list-heading"><div><h2>Conversas</h2><span>{chatsQuery.data?.total ?? '—'}</span></div>
            <p>Grupos aparecem assim que o WhatsApp os entrega. O histórico anterior pode levar mais tempo.</p></div>
          <div className="private-filter"><Search size={17} aria-hidden="true" /><Input aria-label="Buscar conversa" placeholder="Buscar conversa" value={search} onChange={event => { setSearch(event.target.value); setChatLimit(100); setChatOffset(0); listScrollRef.current?.scrollTo(0, 0); }} /></div>
          <div className="private-tabs" role="group" aria-label="Tipo de conversa">
            {([['group', 'Grupos'], ['all', 'Todas'], ['person', 'Pessoas']] as const).map(([value, label]) =>
              <button key={value} type="button" className={kind === value ? 'is-active' : ''} aria-pressed={kind === value}
                onClick={() => { setKind(value); setChatLimit(100); setChatOffset(0); listScrollRef.current?.scrollTo(0, 0); }}>{label}</button>)}</div>
          {chatsQuery.isLoading && <p className="private-list-state" role="status"><Loader2 className="inline h-4 w-4 animate-spin" /> Carregando conversas…</p>}
          {!chatsQuery.isLoading && chatsQuery.error && <p className="private-list-state" role="alert">{confidentialErrorText(chatsQuery.error)}</p>}
          {!chatsQuery.isLoading && !chatsQuery.error && visibleChats.length === 0 && <div className="private-list-state"><MessageCircle size={24} />
            <strong>Nenhuma conversa por aqui ainda.</strong><span>{search ? 'Tente outro termo.' : 'Quando o WhatsApp entregar mensagens ou grupos, eles aparecerão aqui.'}</span></div>}
          <div className="private-chat-items" ref={listScrollRef}>{visibleChats.map(chat => <button key={chat.jid} type="button" className={`private-chat-item ${currentChat?.jid === chat.jid ? 'is-selected' : ''}`}
            onClick={() => { setSelectedChat(chat); setMessageLimit(100); setMobileDetail(true); followLatestMessage.current = true; olderMessageAnchor.current = null; }}>
            <span className="private-avatar">{firstName(chat.name)}</span><span className="private-chat-main"><span className="private-chat-title">{chat.name}</span>
              <span className="private-chat-preview">{chat.last_message_preview || (chat.message_count ? 'Mensagem sem prévia' : 'Aguardando mensagens')}</span></span>
            <span className="private-chat-meta"><small>{relativeLabel(chat.last_message_at)}</small><small>{chat.message_count}</small></span></button>)}</div>
          {(chatOffset > 0 || chatOffset + visibleChats.length < (chatsQuery.data?.total ?? 0)) && <div className="private-pagination">
            <Button variant="ghost" disabled={chatOffset === 0} onClick={() => setChatOffset(offset => Math.max(0, offset - chatLimit))}>Anterior</Button>
            <span>{chatOffset + 1}–{chatOffset + visibleChats.length} de {chatsQuery.data?.total ?? 0}</span>
            <Button variant="ghost" disabled={chatOffset + visibleChats.length >= (chatsQuery.data?.total ?? 0)} onClick={() => setChatOffset(offset => offset + chatLimit)}>Próxima</Button>
          </div>}
        </aside>
        <section className={`private-thread ${mobileDetail ? 'is-mobile-visible' : ''}`} aria-label="Mensagens da conversa">
          {!currentChat ? <div className="private-thread-empty"><MessageCircle size={32} /><h2>Escolha uma conversa</h2><p>As mensagens salvas aparecerão aqui sem sair do seu espaço privado.</p></div> : <>
            <div className="private-thread-heading"><Button variant="ghost" size="icon" className="private-back" aria-label="Voltar às conversas" onClick={() => setMobileDetail(false)}><ArrowLeft size={19} /></Button>
              <span className="private-avatar">{firstName(currentChat.name)}</span><div><h2>{currentChat.name}</h2><p>{currentChat.is_group ? 'Grupo' : 'Conversa'} · {statsQuery.data?.count ?? currentChat.message_count} mensagens salvas</p></div>
              <Button variant="outline" className="private-thread-juice" aria-label="Fazer suco desta conversa" onClick={() => goTo('create')}><GlassWater size={16} /> Fazer suco</Button></div>
            <div className="private-thread-summary"><span>Primeira salva: <strong>{dateLabel(statsQuery.data?.first)}</strong></span><span>Última salva: <strong>{dateLabel(statsQuery.data?.last)}</strong></span></div>
            <div className="private-message-scroll" ref={messageScrollRef} aria-live="polite" onScroll={event => {
              const element = event.currentTarget;
              followLatestMessage.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
            }}>
              {statsQuery.data && statsQuery.data.count > messageLimit && <Button variant="ghost" className="private-older" onClick={() => {
                const element = messageScrollRef.current;
                if (element) olderMessageAnchor.current = { chat: currentChat.jid, top: element.scrollTop, height: element.scrollHeight };
                followLatestMessage.current = false;
                setMessageLimit(limit => Math.min(5000, limit + 100));
              }}>Carregar mensagens anteriores</Button>}
              {messagesQuery.isLoading && <p className="private-list-state" role="status"><Loader2 className="inline h-4 w-4 animate-spin" /> Carregando mensagens…</p>}
              {messagesQuery.error && <p className="private-list-state" role="alert">{confidentialErrorText(messagesQuery.error)}</p>}
              {messagesQuery.data?.messages.length === 0 && <div className="private-thread-empty"><p>Ainda não há mensagens salvas desta conversa. O WhatsApp pode não enviar o histórico antigo após reconexão.</p></div>}
              {messagesQuery.data?.messages.map(message => <article key={message.id} className={`private-message ${message.from_me ? 'is-mine' : ''}`}>
                <div className="private-message-bubble">{!message.from_me && <strong>{message.sender_name || 'Participante'}</strong>}
                  <p>{message.body || `[${message.msg_type || 'mensagem'}]`}</p><time dateTime={message.timestamp}>{dateLabel(message.timestamp)}</time></div></article>)}
            </div>
          </>}
        </section>
      </div>}
    </div></PrivateAppLayout>}
  </main>;
}
