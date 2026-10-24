import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getApiUrl, Chat, Summary } from '@/lib/api';
import { requestedJuice as findRequestedJuice, generationRequest as buildGenerationRequest, personalJuiceId, personalJuiceType } from '@/lib/juice-types';
import { loadManualRequest, saveManualRequest, removeManualRequest, manualRequestKey, manualIdentity, type ManualJuiceRequest } from '@/lib/manual-juice-request';
import { summaryFailure } from '@/lib/onboarding-state';
import { searchHandoff } from '@/lib/discovery';
import { AppLayout } from '@/components/AppLayout';
import DateRangeSelector from '@/components/period/DateRangeSelector';
import PeriodStats from '@/components/period/PeriodStats';
import AnalysisTypeSelector, { AnalysisType, analysisTypes, everydayJuices } from '@/components/analysis/AnalysisTypeSelector';
import { PersonalJuiceRecipe } from '@/components/analysis/PersonalJuiceRecipe';
import SummaryMarkdown from '@/components/SummaryMarkdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { useConnection } from '@/hooks/useConnection';
import { isSyncUnverified } from '@/lib/connection';
import {
  Search,
  Users,
  ArrowLeft,
  ArrowRight,
  CupSoda,
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { endOfDay, format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

type Step = 'period' | 'type' | 'custom' | 'generating' | 'result';
type PeriodMode = { kind: 'relative'; hours: number } | { kind: 'full' } | { kind: 'custom' };

const GENERATION_MESSAGES = [
  'Espremendo as mensagens do período...',
  'Lendo a conversa com atenção...',
  'Separando o bagaço do suco...',
  'Identificando decisões e pendências...',
  'Organizando os insights...',
  'Quase lá, finalizando o suco...',
];

const chatInitials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

const Conversations = () => {
  const queryClient = useQueryClient();
  const [routeParams] = useSearchParams();
  const location = useLocation();
  const [requestedPrompt] = useState(() => searchHandoff(location.state));
  const personalId = personalJuiceId(routeParams.get('suco'));
  const personalQuery = useQuery({queryKey:['personal-juice',getApiUrl(),personalId],queryFn:()=>api.personalJuice(personalId!),enabled:!!personalId,retry:false});
  const requestedJuice = personalId ? (personalQuery.data ? personalJuiceType(personalQuery.data.type) : undefined) : findRequestedJuice(routeParams.get('suco'));
  const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, retry: false });
  const access = usage.data && 'access' in usage.data ? usage.data.access : undefined;
  const isTrial = access === 'trial' || access === 'trial_exhausted';
  const trialBlocked = isTrial && usage.data && 'trial' in usage.data && usage.data.trial?.remaining < 1;
  const generationRequest = useRef<{ key: string; id: string; body: Readonly<ManualJuiceRequest>; chat: Chat; type: AnalysisType; detail: string } | null>(null);
  const { toast } = useToast();
  const [requestStorageKey] = useState(() => manualRequestKey(getApiUrl()));
  const [storedRequest, setStoredRequest] = useState(() => loadManualRequest(localStorage,requestStorageKey));
  const [storageProblem, setStorageProblem] = useState(storedRequest.problem);
  const [restoring, setRestoring] = useState(false);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [step, setStep] = useState<Step>('period');

  // ---------- Lista ----------
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [chatKind, setChatKind] = useState<'group' | 'all'>('group');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const chatsQuery = useQuery({
    queryKey: ['chats', getApiUrl(), chatKind, debouncedSearch],
    queryFn: () => api.chats({ q: debouncedSearch || undefined, kind: chatKind, limit: 200 }),
    enabled: !selectedChat,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const connection = useConnection();
  const [reconnectAttemptedAt, setReconnectAttemptedAt] = useState(0);
  const reconnect = useMutation({
    mutationFn: api.reconnect,
    onMutate: () => setReconnectAttemptedAt(Date.now()),
    onSuccess: () => {
      for (const queryKey of [['status'], ['chats'], ['chat-stats'], ['dashboard']])
        void queryClient.invalidateQueries({ queryKey });
    },
    onError: () => setReconnectAttemptedAt(0),
  });

  const trackedMutation = useMutation({
    mutationFn: ({ jid, tracked }: { jid: string; tracked: boolean }) =>
      api.updateChat(jid, { tracked }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast({
        title: variables.tracked ? 'Suco automático ligado' : 'Suco automático desligado',
        description: variables.tracked
          ? 'Essa conversa vai receber um suco diário automático.'
          : 'Essa conversa saiu do suco diário automático.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Erro ao atualizar conversa',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    },
  });

  // ---------- Fluxo de geração ----------
  const [startDate, setStartDate] = useState<Date | undefined>();
  const [endDate, setEndDate] = useState<Date | undefined>();
  const [periodMode, setPeriodMode] = useState<PeriodMode>({ kind: 'relative', hours: 7 * 24 });
  const [startDateOpen, setStartDateOpen] = useState(false);
  const [endDateOpen, setEndDateOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<AnalysisType | null>(null);
  const [customPrompt, setCustomPrompt] = useState(requestedPrompt);
  const [topicFocus, setTopicFocus] = useState(requestedPrompt);
  const [result, setResult] = useState<Summary | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(!!storedRequest.request);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Período completo real da conversa (stats sem filtro)
  const fullStatsQuery = useQuery({
    queryKey: ['chat-stats', getApiUrl(), selectedChat?.jid],
    queryFn: () => api.chatStats(selectedChat!.jid),
    enabled: !!selectedChat && step !== 'generating' && step !== 'result',
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const actualDateRange = useMemo(() => {
    const stats = fullStatsQuery.data;
    if (!stats?.first || !stats?.last) return null;
    return { start: new Date(stats.first), end: new Date(stats.last) };
  }, [fullStatsQuery.data]);

  // Enquanto a pessoa escolhe o período, os atalhos acompanham a última
  // mensagem salva. Um período customizado e um pedido em revisão ficam fixos.
  useEffect(() => {
    if (!actualDateRange || periodMode.kind === 'custom' || step !== 'period') return;
    const end = actualDateRange.end;
    const relativeStart = periodMode.kind === 'relative'
      ? new Date(end.getTime() - periodMode.hours * 60 * 60 * 1000)
      : actualDateRange.start;
    const start = relativeStart < actualDateRange.start ? actualDateRange.start : relativeStart;
    setStartDate(previous => previous?.getTime() === start.getTime() ? previous : start);
    setEndDate(previous => previous?.getTime() === end.getTime() ? previous : end);
  }, [actualDateRange, periodMode, step]);

  const newerStoredMessages = !!actualDateRange && !!endDate && actualDateRange.end.getTime() > endDate.getTime();

  // Preview do período selecionado
  const periodStatsQuery = useQuery({
    queryKey: [
      'chat-stats',
      getApiUrl(),
      selectedChat?.jid,
      startDate?.toISOString(),
      endDate?.toISOString(),
    ],
    queryFn: () =>
      api.chatStats(selectedChat!.jid, {
        start: startDate!.toISOString(),
        end: endDate!.toISOString(),
      }),
    enabled: !!selectedChat && !!startDate && !!endDate && step !== 'generating' && step !== 'result',
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const statsUnavailable = fullStatsQuery.isError || periodStatsQuery.isError;

  const selectPreset = (hours: number) => {
    if (!actualDateRange) return;
    setPeriodMode({ kind: 'relative', hours });
    const end = actualDateRange.end;
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    setStartDate(start < actualDateRange.start ? actualDateRange.start : start);
    setEndDate(end);
    setStartDateOpen(false);
    setEndDateOpen(false);
  };

  const selectFullPeriod = () => {
    if (!actualDateRange) return;
    setPeriodMode({ kind: 'full' });
    setStartDate(actualDateRange.start);
    setEndDate(actualDateRange.end);
    setStartDateOpen(false);
    setEndDateOpen(false);
  };

  const resetFlow = () => {
    setSelectedChat(null);
    setStep('period');
    setStartDate(undefined);
    setEndDate(undefined);
    setPeriodMode({ kind: 'relative', hours: 7 * 24 });
    setSelectedType(null);
    setCustomPrompt(requestedPrompt);
    setTopicFocus(requestedPrompt);
    setResult(null);
    setGenerationError(null);
  };

  const openChat = (chat: Chat) => {
    resetFlow();
    setSelectedChat(chat);
  };

  const startGeneration = async (type: AnalysisType, detail: string) => {
    if (!selectedChat || !startDate || !endDate) return;
    if (statsUnavailable && !generationRequest.current) {
      setGenerationError('Não conseguimos confirmar as mensagens desse período. Atualize as estatísticas antes de iniciar um novo suco.');
      return;
    }
    let chosen: ReturnType<typeof buildGenerationRequest>;
    try { chosen = buildGenerationRequest(type, detail); } catch (error) { setGenerationError(error instanceof Error ? error.message : 'Confira o pedido.'); return; }
    const key = manualIdentity({chat_jid:selectedChat.jid,start:startDate.toISOString(),end:endDate.toISOString(),...chosen});
    const persisted=loadManualRequest(localStorage,requestStorageKey);
    if(storageProblem || persisted.problem || manualRequestKey(getApiUrl())!==requestStorageKey) { setGenerationError('Não conseguimos guardar seu pedido com segurança neste navegador. A geração não foi iniciada.'); return; }
    if(persisted.request && (!generationRequest.current || persisted.request.request_id!==generationRequest.current.id)) { setStoredRequest(persisted);setPendingConfirmation(true);setGenerationError('Retome o pedido anterior antes de gerar outro suco.');return; }
    if (generationRequest.current && generationRequest.current.key !== key) { setGenerationError('Há um pedido aguardando confirmação. Retome esse pedido antes de iniciar outro.'); return; }
    if (trialBlocked && generationRequest.current?.key !== key) { setGenerationError('Seus sucos grátis estão concluídos ou em confirmação. Os sucos salvos continuam disponíveis; confira sua conta antes de iniciar outro pedido.'); return; }

    setStep('generating');
    setGenerationError(null);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((prev) => prev + 1), 1000);

    try {
      // A newer UI must never silently fall back to generic generation on an older worker.
      let catalog: Awaited<ReturnType<typeof api.juiceCatalog>>;
      try { catalog = await api.juiceCatalog(); }
      catch { throw new ApiError(503, 'Os modelos não carregaram. Seu suco não foi enviado; tente novamente.', 'TEMPLATE_CATALOG_UNAVAILABLE'); }
      if (catalog.version !== chosen.template_version || (type.personalRevision ? !catalog.personalTypes : type.id !== 'custom' && !catalog.types.some(item => item.id === type.id))) throw new ApiError(409, 'Os modelos foram atualizados. Recarregue a página antes de gerar.', 'TEMPLATE_VERSION_CHANGED');
      if (!generationRequest.current) {
        const id = crypto.randomUUID();
        const body = Object.freeze({ request_id:id,chat_jid:selectedChat.jid,start:startDate.toISOString(),end:endDate.toISOString(),...chosen });
        if(!saveManualRequest(localStorage,requestStorageKey,body)) { setStorageProblem('unavailable');throw new Error('Não conseguimos guardar o pedido. Seu suco não foi enviado.'); }
        setStoredRequest({request:body,problem:null});
        generationRequest.current = { key,id,body,chat:selectedChat,type,detail };
      }
      const response = await api.generateSummary(generationRequest.current.body);
      const completed=generationRequest.current;
      if(!removeManualRequest(localStorage,requestStorageKey,completed.id))setStorageProblem('unavailable');
      generationRequest.current = null;
      setStoredRequest(loadManualRequest(localStorage,requestStorageKey));
      setPendingConfirmation(false);
      queryClient.invalidateQueries({queryKey: ['usage']});
      setResult(response.summary);
      setStep('result');
      queryClient.invalidateQueries({ queryKey: ['summaries'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (error) {
      queryClient.invalidateQueries({queryKey: ['usage']});
      if (error instanceof ApiError && (summaryFailure(error.code) === 'terminal' || ['INVALID_PERSONAL_JUICE','PERSONAL_JUICE_NOT_FOUND','PERSONAL_JUICE_ARCHIVED','UNKNOWN_JUICE_TEMPLATE','TEMPLATE_VERSION_CHANGED','INVALID_JUICE_FOCUS','CUSTOM_JUICE_REQUEST_REQUIRED','TRIAL_EXHAUSTED'].includes(error.code || ''))) {
        if(generationRequest.current && !removeManualRequest(localStorage,requestStorageKey,generationRequest.current.id))setStorageProblem('unavailable');
        generationRequest.current = null;setStoredRequest(loadManualRequest(localStorage,requestStorageKey));
      }
      setPendingConfirmation(!!generationRequest.current);
      let message = 'Erro inesperado ao gerar o suco.';
      if (error instanceof ApiError) {
        if (error.status === 422) message = 'Não há mensagens nesse período. Ajuste as datas.';
        else if (error.status === 404) message = error.code?.startsWith('PERSONAL_') ? error.message : 'Conversa não encontrada no servidor.';
        else if (error.status === 502) message = 'A IA falhou ao gerar o suco. Tente novamente.';
        else message = error.message;
      } else if (error instanceof Error) {
        message = `Falha de conexão com o servidor: ${error.message}`;
      }
      setGenerationError(message);
      setStep('custom');
    } finally {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleSelectType = (type: AnalysisType) => {
    setSelectedType(type);
    setStep('custom');
  };

  async function restoreRequest() {
    const saved=loadManualRequest(localStorage,requestStorageKey);
    if(saved.problem || !saved.request || manualRequestKey(getApiUrl())!==requestStorageKey) {setStorageProblem(saved.problem||'unavailable');return;}
    const body=saved.request;setRestoring(true);
    try {
      const [name,stats]=await Promise.all([api.chatName(body.chat_jid),api.chatStats(body.chat_jid)]);
      const current=loadManualRequest(localStorage,requestStorageKey);
      if(current.request?.request_id!==body.request_id || manualRequestKey(getApiUrl())!==requestStorageKey)throw Error('Seu pedido mudou. Abra sua conta para continuar.');
      const id=personalJuiceId(body.analysis_type);
      const type=id?personalJuiceType((await api.personalJuice(id,body.personal_revision)).type):findRequestedJuice(body.analysis_type)!;
      if(!type)throw Error('Não conseguimos carregar o tipo desse pedido.');
      if(loadManualRequest(localStorage,requestStorageKey).request?.request_id!==body.request_id||manualRequestKey(getApiUrl())!==requestStorageKey)throw Error('Seu pedido mudou. Abra sua conta para continuar.');
      const chat:Chat={jid:body.chat_jid,name:name.name,is_group:body.chat_jid.endsWith('@g.us'),tracked:false,message_count:stats.count,last_message_at:stats.last,last_message_preview:null};
      const detail=body.base_prompt??body.focus??'';
      generationRequest.current={key:manualIdentity(body),id:body.request_id,body,chat,type,detail};
      setSelectedChat(chat);setSelectedType(type);setStartDate(new Date(body.start));setEndDate(new Date(body.end));
      if(type.id==='custom')setCustomPrompt(detail);else setTopicFocus(detail);
      setStoredRequest(saved);setPendingConfirmation(true);setGenerationError(null);setStep('custom');
    } catch(error) {setGenerationError(error instanceof Error?error.message:'Não conseguimos retomar o pedido. Tente novamente.');}
    finally{setRestoring(false);}
  }
  const resumeNotice=(pendingConfirmation || storedRequest.request || storageProblem) && <div className="suco-juice-pending" role="status"><p>{storageProblem?'Não conseguimos confirmar o pedido guardado neste navegador. Confira seus sucos e sua cota antes de iniciar outro.':'Seu pedido aguarda confirmação. Retome para consultar o mesmo pedido, sem iniciar uma análise duplicada.'}</p>{!storageProblem&&<Button variant="outline" disabled={restoring} onClick={restoreRequest}>{restoring?'Retomando…':'Retomar pedido anterior'}</Button>}<Link to="/summaries">Conferir meus sucos</Link></div>;

  if(personalId && !personalQuery.data && !selectedChat) return <AppLayout title="Seu tipo de suco"><p role={personalQuery.isError?'alert':'status'}>{personalQuery.isError?'Esse tipo de suco não carregou. Ele pode ter sido excluído.':'Carregando seu tipo de suco…'}</p>{personalQuery.isError&&<Button onClick={()=>personalQuery.refetch()}>Tentar novamente</Button>}<Link to="/my-juices" className="suco-personal-manage">Ver meus tipos</Link>{resumeNotice}</AppLayout>;

  // ---------- Render: lista de conversas ----------
  if (!selectedChat) {
    const chats = chatsQuery.data?.chats ?? [];
    const newestStoredMessage = chats.reduce<string | null>((latest, chat) =>
      chat.last_message_at && (!latest || new Date(chat.last_message_at) > new Date(latest))
        ? chat.last_message_at : latest, null);

    return (
      <AppLayout title="Conversas">
        <div className="space-y-4">
          {resumeNotice}
          {generationError && <p role="alert" className="text-sm text-destructive">{generationError}</p>}
          <p className="text-sm text-muted-foreground">
            {requestedPrompt ? `Seu pedido: ${requestedPrompt} Escolha a conversa; depois você confere o período e o texto antes de gerar.` : requestedJuice ? `Seu pedido: ${(everydayJuices[requestedJuice.id] || requestedJuice).title} Escolha a conversa; depois você confere o período antes de gerar.` : 'Escolha uma conversa para tirar o suco. Depois, você escolhe o período e o que quer descobrir.'}
          </p>

          <div className="activation-chat-kind" role="group" aria-label="Mostrar conversas">
            <button type="button" aria-pressed={chatKind === 'group'} onClick={() => setChatKind('group')}>Grupos</button>
            <button type="button" aria-pressed={chatKind === 'all'} onClick={() => setChatKind('all')}>Todas as conversas</button>
          </div>
          <label className="sr-only" htmlFor="conversation-search">{chatKind === 'group' ? 'Buscar grupo pelo nome' : 'Buscar conversa pelo nome'}</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="conversation-search"
              placeholder={chatKind === 'group' ? 'Buscar grupo pelo nome...' : 'Buscar conversa pelo nome...'}
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p>
              {newestStoredMessage
                ? `Mensagem mais recente nesta lista: ${format(new Date(newestStoredMessage), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}.`
                : 'Ainda não há mensagens nesta lista.'}
              {' '}A lista é verificada automaticamente com a aba em uso.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={chatsQuery.isFetching} onClick={() => void chatsQuery.refetch()}>
                <RefreshCw className={`mr-2 h-4 w-4 ${chatsQuery.isFetching ? 'animate-spin' : ''}`} />
                {chatsQuery.isFetching ? 'Verificando…' : 'Atualizar lista'}
              </Button>
              {connection.isError ? <Button type="button" size="sm" variant="outline" disabled={connection.isFetching} onClick={() => void connection.refetch()}>Verificar conexão</Button> : connection.isPending ? null : connection.data?.connected ? <Button type="button" size="sm" variant="outline" disabled={reconnect.isPending || (reconnectAttemptedAt > 0 && Date.now() - reconnectAttemptedAt < 30_000)} onClick={() => reconnect.mutate()}>
                <RefreshCw className={`mr-2 h-4 w-4 ${reconnect.isPending ? 'animate-spin' : ''}`} />
                {reconnect.isPending ? 'Reconectando…' : 'Tentar sincronizar'}
              </Button> : <Button asChild size="sm" variant="outline"><Link to="/onboarding?reconnect=1">Conectar WhatsApp</Link></Button>}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">Atualizar lista consulta o que já foi salvo. Tentar sincronizar reinicia a conexão com o WhatsApp sem apagar o histórico; a chegada de mensagens depende do WhatsApp.</p>
          {reconnect.isSuccess && <p role="status" className="text-sm text-muted-foreground">Reconexão iniciada. Envie uma mensagem em um grupo seu e confira se ela aparece. Se continuar sem chegar, <Link className="underline" to="/onboarding?reconnect=1">refaça o vínculo com um novo QR</Link>.</p>}
          {reconnect.isError && <p role="alert" className="text-sm text-destructive">Não conseguimos reiniciar a conexão. Seu histórico foi preservado. Tente novamente ou confira o vínculo do WhatsApp.</p>}
          {!connection.isError && isSyncUnverified(connection.data) && <p role="status" className="text-sm text-amber-800">A conexão respondeu, mas ainda não confirmou mensagens novas. Se você enviou uma mensagem recente e ela não apareceu, use Tentar sincronizar.</p>}

          {chatsQuery.isError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Erro ao carregar conversas</AlertTitle>
              <AlertDescription>
                {chatsQuery.error instanceof Error
                  ? chatsQuery.error.message
                  : 'Não foi possível falar com o servidor.'}
              </AlertDescription>
            </Alert>
          )}

          {chatsQuery.isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!chatsQuery.isLoading && !chatsQuery.isError && chats.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                {debouncedSearch
                  ? 'Nenhuma conversa encontrada para essa busca.'
                  : chatKind === 'group' ? 'Nenhum grupo sincronizado ainda. Confira a conexão do WhatsApp.' : 'Nenhuma conversa sincronizada ainda. Confira a conexão do WhatsApp.'}
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            {chats.map((chat) => (
              <Card
                key={chat.jid}
                className="suco-conversation-row"
              >
                <CardContent className="flex flex-col items-stretch gap-4 py-4 sm:flex-row sm:items-center">
                  <button type="button" className="suco-chat-open flex min-w-0 flex-1 items-center gap-4 text-left" aria-label={`Escolher conversa ${chat.name}`} onClick={() => openChat(chat)}>
                  <Avatar className="h-11 w-11 shrink-0">
                    <AvatarFallback
                      className={
                        chat.is_group
                          ? 'bg-indigo-100 text-indigo-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }
                    >
                      {chat.is_group ? <Users className="h-5 w-5" /> : chatInitials(chat.name)}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium truncate">{chat.name}</p>
                      {chat.is_group && (
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          Grupo
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {chat.last_message_preview || 'Sem mensagens'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {chat.message_count.toLocaleString('pt-BR')} mensagens
                      {chat.last_message_at &&
                        ` · ${formatDistanceToNow(new Date(chat.last_message_at), {
                          addSuffix: true,
                          locale: ptBR,
                        })}`}
                    </p>
                  </div>

                  </button>
                  <div
                    className="flex flex-row items-center justify-between gap-3 shrink-0 sm:flex-col sm:items-end"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-xs text-muted-foreground">Suco automático</span>
                    <Switch
                      aria-label={`Suco automático de ${chat.name}`}
                      checked={chat.tracked}
                      disabled={trackedMutation.isPending || isTrial}
                      onCheckedChange={(checked) =>
                        trackedMutation.mutate({ jid: chat.jid, tracked: checked })
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {!chatsQuery.isError && chatsQuery.data && chatsQuery.data.total > chats.length && (
            <p className="text-sm text-muted-foreground">Mostrando {chats.length} de {chatsQuery.data.total}. Busque pelo nome para encontrar os demais.</p>
          )}

        </div>
      </AppLayout>
    );
  }

  // ---------- Render: fluxo de geração ----------
  const headerBar = (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="sm" onClick={resetFlow}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Conversas
      </Button>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback
            className={
              selectedChat.is_group
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-emerald-100 text-emerald-700'
            }
          >
            {selectedChat.is_group ? <Users className="h-4 w-4" /> : chatInitials(selectedChat.name)}
          </AvatarFallback>
        </Avatar>
        <span className="font-semibold truncate">{selectedChat.name}</span>
        {selectedChat.is_group && <Badge variant="secondary">Grupo</Badge>}
      </div>
    </div>
  );

  return (
    <AppLayout
      breadcrumbs={[
        { label: 'Início', href: '/' },
        { label: 'Conversas', href: '/conversations' },
        { label: selectedChat.name },
      ]}
    >
      <div className="space-y-6">
        {headerBar}

        {generationError && step !== 'generating' && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{pendingConfirmation?'Seu suco aguarda confirmação':'Não foi possível gerar o suco'}</AlertTitle>
            <AlertDescription>{generationError}</AlertDescription>
          </Alert>
        )}

        {statsUnavailable && step !== 'generating' && step !== 'result' && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Não conseguimos atualizar a conversa</AlertTitle>
            <AlertDescription>
              A contagem e o período podem estar desatualizados. Seu pedido continua preservado.
              <Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={() => {
                void fullStatsQuery.refetch();
                if (startDate && endDate) void periodStatsQuery.refetch();
              }}>Tentar novamente</Button>
            </AlertDescription>
          </Alert>
        )}

        {newerStoredMessages && step !== 'generating' && step !== 'result' && (
          <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Há mensagens salvas mais recentes fora do período selecionado.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => {
              if (periodMode.kind === 'custom') setEndDate(actualDateRange!.end);
              setStep('period');
            }}>Incluir as mais recentes</Button>
          </div>
        )}

        {/* Passo 1: período */}
        {step === 'period' && (
          <>
            {fullStatsQuery.isLoading && (
              <div className="space-y-3">
                <Skeleton className="h-32 w-full rounded-lg" />
                <Skeleton className="h-64 w-full rounded-lg" />
              </div>
            )}

            {fullStatsQuery.isSuccess && !actualDateRange && (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  Essa conversa ainda não tem mensagens sincronizadas.
                </CardContent>
              </Card>
            )}

            {actualDateRange && !statsUnavailable && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                <DateRangeSelector
                  startDate={startDate}
                  endDate={endDate}
                  actualDateRange={actualDateRange}
                  startDateOpen={startDateOpen}
                  endDateOpen={endDateOpen}
                  onStartDateChange={date => { setPeriodMode({ kind: 'custom' }); setStartDate(date); }}
                  onEndDateChange={date => {
                    setPeriodMode({ kind: 'custom' });
                    setEndDate(date ? new Date(Math.min(endOfDay(date).getTime(), actualDateRange.end.getTime())) : undefined);
                  }}
                  onStartDateOpenChange={setStartDateOpen}
                  onEndDateOpenChange={setEndDateOpen}
                  onSelectPreset={selectPreset}
                  onSelectFullPeriod={selectFullPeriod}
                />

                <div className="space-y-4">
                  <PeriodStats
                    uploadData={{
                      chatName: selectedChat.name,
                      messageCount: fullStatsQuery.data?.count ?? selectedChat.message_count,
                      participantsCount:
                        periodStatsQuery.data?.by_sender.length ??
                        fullStatsQuery.data?.by_sender.length ??
                        0,
                      isGroupChat: selectedChat.is_group,
                    }}
                    actualDateRange={actualDateRange}
                    startDate={startDate}
                    endDate={endDate}
                    filteredMessageCount={periodStatsQuery.data?.count ?? 0}
                    loading={periodStatsQuery.isFetching}
                  />

                  <Button
                    className="w-full"
                    size="lg"
                    disabled={
                      !startDate ||
                      !endDate ||
                      periodStatsQuery.isFetching ||
                      statsUnavailable ||
                      (periodStatsQuery.data?.count ?? 0) === 0
                    }
                    onClick={() => { if (selectedType || requestedJuice || requestedPrompt) { setSelectedType(selectedType || requestedJuice || findRequestedJuice('custom')!); setStep('custom'); } else setStep('type'); }}
                  >
                    {selectedType || requestedJuice || requestedPrompt ? 'Conferir meu suco' : 'Escolher meu suco'}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Passo 2: tipo de análise */}
        {step === 'type' && startDate && endDate && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-muted/50 rounded-lg p-3">
              <p className="text-sm">
                Período: <span className="font-medium">{format(startDate, 'dd/MM/yyyy', { locale: ptBR })}</span>{' '}
                até <span className="font-medium">{format(endDate, 'dd/MM/yyyy', { locale: ptBR })}</span>
                {periodStatsQuery.isSuccess && periodStatsQuery.data && (
                  <span className="text-muted-foreground">
                    {' '}
                    · {periodStatsQuery.data.count.toLocaleString('pt-BR')} mensagens
                  </span>
                )}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setStep('period')}>
                Alterar período
              </Button>
            </div>

            <AnalysisTypeSelector onSelectType={handleSelectType} loading={false} preferredId={requestedJuice?.id} />
          </div>
        )}

        {/* Tema e foco são conferidos antes de qualquer geração. */}
        {step === 'custom' && selectedType && (
          <section className="suco-juice-review" aria-labelledby="juice-review-title">
            <h2 id="juice-review-title">Seu suco, do seu jeito.</h2>
            {resumeNotice}
            <div className="suco-juice-review-source"><p className="font-semibold">{selectedChat.name}</p><p>{startDate && format(startDate, 'dd/MM/yyyy', { locale: ptBR })} a {endDate && format(endDate, 'dd/MM/yyyy', { locale: ptBR })}{periodStatsQuery.isSuccess && periodStatsQuery.data ? ` · ${periodStatsQuery.data.count.toLocaleString('pt-BR')} mensagens` : ''}</p><Button variant="outline" onClick={() => setStep('period')}>Alterar período</Button></div>
            <div className="suco-juice-selected"><CupSoda size={24} aria-hidden="true"/><div><h3>{selectedType.title}</h3><p>{selectedType.description}</p></div></div>
            {selectedType.personalRevision&&<PersonalJuiceRecipe key={selectedType.personalRevision} type={selectedType}/>}
            <label htmlFor="juice-detail" className="font-semibold">{selectedType.id === 'custom' ? 'O que você quer tirar desse papo?' : 'Quer focar em algum assunto?'}{selectedType.id !== 'custom' && <span className="ml-2 text-sm font-normal text-muted-foreground">Opcional</span>}</label>
            <p id="juice-detail-help" className="text-sm text-muted-foreground">{selectedType.id === 'custom' ? 'Descreva o resultado que você quer. O Suco usa as mensagens da conversa e do período acima.' : 'Pode ser um termo, uma pessoa ou um combinado. Deixe em branco para usar o tema completo.'}</p>
            <Textarea id="juice-detail" aria-describedby="juice-detail-help" rows={4} maxLength={selectedType.id === 'custom' ? 10000 : 2000} placeholder={selectedType.focusPlaceholder} value={selectedType.id === 'custom' ? customPrompt : topicFocus} onChange={e => selectedType.id === 'custom' ? setCustomPrompt(e.target.value) : setTopicFocus(e.target.value)} />
            <p className="text-xs text-muted-foreground">O tema orienta a leitura. O detalhe define o foco. Se o assunto não aparecer nas mensagens disponíveis, o Suco deve avisar.</p>
            <div className="suco-juice-review-actions"><Button variant="outline" onClick={() => setStep('type')}><ArrowLeft size={16} className="mr-2"/>Alterar tema</Button><Button disabled={(selectedType.id === 'custom' && !customPrompt.trim()) || (trialBlocked && !generationRequest.current) || !!storageProblem || (statsUnavailable && !generationRequest.current)} onClick={() => startGeneration(selectedType, selectedType.id === 'custom' ? customPrompt : topicFocus)}><CupSoda size={18} className="mr-2"/>Gerar meu suco</Button></div>
            <p className="text-xs text-muted-foreground">{isTrial ? 'Um suco concluído usa 1 dos seus 3 sucos grátis.' : 'A geração usa sua cota de análises. Preparar e alterar o pedido não usa a cota.'}</p>
          </section>
        )}

        {/* Passo 3: gerando */}
        {step === 'generating' && (
          <Card>
            <CardContent className="py-16 text-center space-y-6">
              <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
              <div className="space-y-2">
                <p className="text-lg font-semibold">
                  {GENERATION_MESSAGES[Math.min(Math.floor(elapsed / 15), GENERATION_MESSAGES.length - 1)]}
                </p>
                <p className="text-sm text-muted-foreground">
                  A IA está lendo as mensagens do período. Isso pode levar até 2 minutos — não
                  feche a página.
                </p>
                <p className="text-xs text-muted-foreground">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} decorridos
                </p>
              </div>
              <div className="max-w-sm mx-auto">
                <Progress value={Math.min((elapsed / 120) * 100, 95)} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Passo 4: resultado */}
        {step === 'result' && result && (
          <div className="space-y-4">
            <Alert className="border-emerald-300 bg-emerald-50">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <AlertTitle className="text-emerald-800">Suco pronto!</AlertTitle>
              <AlertDescription className="text-emerald-700">
                Resumo salvo no seu histórico de sucos.
              </AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <CardTitle>{result.title || `Suco de ${result.chat_name}`}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {format(new Date(result.period_start), 'dd/MM/yyyy', { locale: ptBR })} até{' '}
                  {format(new Date(result.period_end), 'dd/MM/yyyy', { locale: ptBR })} · modelo{' '}
                  {result.model}
                </p>
              </CardHeader>
              <CardContent>
                <SummaryMarkdown content={result.content} />
              </CardContent>
            </Card>

            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline"><Link to={`/calendar?summary=${result.id}`}>Preparar convite</Link></Button>
              <Button asChild>
                <Link to="/summaries">
                  Ver todos os sucos
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setResult(null);
                  setSelectedType(null);
                  setStep('type');
                }}
              >
                Gerar outro suco desta conversa
              </Button>
              <Button variant="ghost" onClick={resetFlow}>
                Voltar para as conversas
              </Button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default Conversations;
