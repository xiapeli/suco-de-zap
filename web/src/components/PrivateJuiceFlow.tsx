import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { ArrowLeft, ArrowRight, GlassWater, Loader2, Search } from 'lucide-react';
import type { Chat } from '@/lib/api';
import { confidentialApi, confidentialErrorText, ConfidentialApiError,
  type PrivateSummary } from '@/lib/confidential-api';
import type { ConfidentialChannel } from '@/lib/confidential-channel';
import { customJuice, juiceTypes, personalJuiceId, requestedJuice, JUICE_CATALOG_VERSION } from '@/lib/juice-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
type Period = 1 | 7 | 30 | 'all';

function date(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '—' :
    new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(parsed);
}

function pendingStorageKey(accountId: string): string { return `suco-summary-pending:${accountId}`; }
function savedPending(accountId: string): string | null {
  try { const value = sessionStorage.getItem(pendingStorageKey(accountId)); return value && REQUEST_ID.test(value) ? value : null; }
  catch { return null; }
}
function persistPending(accountId: string, id: string | null): void {
  try { if (id) sessionStorage.setItem(pendingStorageKey(accountId), id);
    else sessionStorage.removeItem(pendingStorageKey(accountId)); } catch { /* In-memory polling still works. */ }
}

function SummaryContent({ summary }: { summary: PrivateSummary }) {
  return <article className="private-juice-result">
    <p className="private-eyebrow"><GlassWater size={15} /> Suco salvo</p>
    <h2>{summary.title}</h2>
    <p className="private-juice-meta">{summary.chat_name} · {date(summary.period_start)} a {date(summary.period_end)} · {date(summary.created_at)}</p>
    <div className="private-juice-markdown prose prose-sm max-w-none"><ReactMarkdown>{summary.content}</ReactMarkdown></div>
    <p className="private-juice-note">Confirme decisões, prazos e valores na conversa original.</p>
  </article>;
}

export function PrivateJuiceCreate({ channel, accountId, preselectedChat, searchParams, onOpenSummaries }: {
  channel: ConfidentialChannel; accountId: string; preselectedChat: Chat | null;
  searchParams: string; onOpenSummaries: () => void;
}) {
  const queryClient = useQueryClient();
  const params = new URLSearchParams(searchParams);
  const requestedType = requestedJuice(params.get('suco'));
  const [typeId, setTypeId] = useState(personalJuiceId(params.get('suco')) ? params.get('suco')! :
    requestedType?.id ?? (params.get('request')?.trim() ? 'custom' : 'general'));
  const [focus, setFocus] = useState(params.get('request')?.slice(0, 2000) ?? '');
  const [chatSearch, setChatSearch] = useState('');
  const [kind, setKind] = useState<'group' | 'all'>('group');
  const [chatOffset, setChatOffset] = useState(0);
  const [chat, setChat] = useState<Chat | null>(preselectedChat);
  const [period, setPeriod] = useState<Period>(7);
  const [consent, setConsent] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(() => savedPending(accountId));
  const [pollReady, setPollReady] = useState(() => !!savedPending(accountId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PrivateSummary | null>(null);
  const chats = useQuery({
    queryKey: ['private', accountId, 'create-chats', kind, chatSearch, chatOffset],
    queryFn: () => confidentialApi.chats(channel, { kind, q: chatSearch, limit: 100, offset: chatOffset }),
    refetchInterval: 15_000, refetchOnWindowFocus: true,
  });
  const personalTypes = useQuery({
    queryKey: ['private', accountId, 'personal-types'],
    queryFn: () => confidentialApi.personalTypes(channel), refetchOnWindowFocus: true,
  });
  const stats = useQuery({
    queryKey: ['private', accountId, 'create-stats', chat?.jid],
    queryFn: () => confidentialApi.stats(channel, chat!.jid), enabled: !!chat,
    refetchInterval: 15_000, refetchOnWindowFocus: true,
  });
  const status = useQuery({
    queryKey: ['private', accountId, 'summary-status', pendingId],
    queryFn: () => confidentialApi.summaryStatus(channel, pendingId!), enabled: !!pendingId && pollReady,
    refetchInterval: 4_000, refetchOnWindowFocus: true, retry: 1,
  });

  useEffect(() => {
    if (!pendingId || !status.data || !('summary' in status.data)) return;
    setResult(status.data.summary);
    setPendingId(null);
    setPollReady(false);
    persistPending(accountId, null);
    void queryClient.invalidateQueries({ queryKey: ['private', accountId, 'summaries'] });
    void queryClient.invalidateQueries({ queryKey: ['private', accountId, 'dashboard'] });
  }, [accountId, pendingId, queryClient, status.data]);

  useEffect(() => {
    if (!pendingId || !(status.error instanceof ConfidentialApiError) ||
        !['PRIVATE_SUMMARY_FAILED', 'PRIVATE_SUMMARY_NOT_FOUND'].includes(status.error.code)) return;
    setError(confidentialErrorText(status.error));
    setPendingId(null);
    setPollReady(false);
    persistPending(accountId, null);
  }, [accountId, pendingId, status.error]);

  const first = stats.data?.first ? Date.parse(stats.data.first) : NaN;
  const last = stats.data?.last ? Date.parse(stats.data.last) : NaN;
  const rangeReady = Number.isFinite(first) && Number.isFinite(last) && (stats.data?.count ?? 0) > 0;
  const start = rangeReady ? Math.max(first, last - (period === 'all' ? 365 : period) * DAY) : NaN;

  async function generate() {
    if (!chat || !rangeReady || !consent || pendingId || sending) return;
    if (typeId === 'custom' && !focus.trim()) {
      setError('Conte o que você quer tirar dessa conversa.'); return;
    }
    setError(''); setSending(true);
    const requestId = crypto.randomUUID();
    setPendingId(requestId);
    setPollReady(false);
    persistPending(accountId, requestId);
    try {
      const personal = typeId.startsWith('personal:') ?
        personalTypes.data?.types.find(type => type.id === typeId.slice('personal:'.length)) : undefined;
      if (typeId.startsWith('personal:') && !personal) {
        setError('Esse tipo de suco não está disponível. Atualize Meus tipos.');
        setPendingId(null); setPollReady(false); persistPending(accountId, null);
        return;
      }
      const response = await confidentialApi.generateSummary(channel, {
        request_id: requestId, chat_jid: chat.jid,
        start: new Date(start).toISOString(), end: new Date(last).toISOString(),
        analysis_type: typeId, template_version: JUICE_CATALOG_VERSION,
        ...(personal ? { personal_revision: String(personal.revision) } : {}),
        ...(typeId === 'custom' ? { base_prompt: focus.trim() } :
          focus.trim() ? { focus: focus.trim() } : {}),
      });
      if ('summary' in response) {
        setResult(response.summary);
        setPendingId(null); setPollReady(false); persistPending(accountId, null);
        void queryClient.invalidateQueries({ queryKey: ['private', accountId, 'summaries'] });
      } else setPollReady(true);
    } catch (reason) {
      if (reason instanceof ConfidentialApiError && [400, 404, 422].includes(reason.status)) {
        setPendingId(null); setPollReady(false); persistPending(accountId, null);
      } else setPollReady(true);
      setError(confidentialErrorText(reason));
    } finally { setSending(false); }
  }

  if (result) return <div className="private-juice-flow">
    <div className="private-juice-actions"><Button variant="outline" onClick={() => { setResult(null); setConsent(false); }}><ArrowLeft size={16} /> Fazer outro suco</Button>
      <Button variant="outline" onClick={onOpenSummaries}>Meus sucos <ArrowRight size={16} /></Button></div>
    <SummaryContent summary={result} />
  </div>;

  return <div className="private-juice-flow">
    <section className="private-juice-card"><div className="private-juice-card-heading"><span>1</span><div><h2>Escolha a conversa</h2><p>Grupos e conversas com mensagens salvas neste espaço.</p></div></div>
      <div className="private-juice-chat-controls"><label><span>Buscar conversa</span><span className="private-juice-search"><Search size={17} /><Input value={chatSearch} onChange={event => { setChatSearch(event.target.value); setChatOffset(0); }} placeholder="Nome do grupo ou pessoa" /></span></label>
        <label><span>Mostrar</span><select value={kind} onChange={event => { setKind(event.target.value as 'group' | 'all'); setChatOffset(0); }}><option value="group">Grupos</option><option value="all">Todas as conversas</option></select></label></div>
      {chats.error && <p className="private-error" role="alert">{confidentialErrorText(chats.error)}</p>}
      <div className="private-juice-chat-results" role="group" aria-label="Selecionar conversa">
        {chats.isLoading && <p className="private-list-state"><Loader2 className="h-4 w-4 animate-spin" /> Carregando conversas…</p>}
        {chats.data?.chats.map(item => <button key={item.jid} type="button" className={chat?.jid === item.jid ? 'is-selected' : ''}
          aria-pressed={chat?.jid === item.jid} onClick={() => { setChat(item); setPeriod(7); setError(''); }}>
          <strong>{item.name}</strong><span>{item.message_count} mensagens salvas</span></button>)}
        {chats.data?.chats.length === 0 && <p className="private-list-state">Nenhuma conversa encontrada. Confira a conexão ou busque outro nome.</p>}
      </div>
      {chats.data && chats.data.total > 100 && <div className="private-juice-pagination"><Button variant="ghost" disabled={chatOffset === 0} onClick={() => setChatOffset(Math.max(0, chatOffset - 100))}>Anterior</Button>
        <span>{chatOffset + 1}–{chatOffset + chats.data.chats.length} de {chats.data.total}</span>
        <Button variant="ghost" disabled={chatOffset + 100 >= chats.data.total} onClick={() => setChatOffset(chatOffset + 100)}>Próxima</Button></div>}
    </section>

    <section className="private-juice-card"><div className="private-juice-card-heading"><span>2</span><div><h2>Defina o recorte</h2><p>O período parte da última mensagem salva, mesmo se o grupo estiver quieto.</p></div></div>
      {!chat ? <p className="private-juice-hint">Escolha uma conversa acima.</p> : stats.isLoading ? <p className="private-juice-hint">Conferindo mensagens salvas…</p> :
        stats.error ? <p className="private-error" role="alert">{confidentialErrorText(stats.error)}</p> : !rangeReady ? <p className="private-juice-hint">Ainda não há mensagens salvas nesta conversa. Sincronize e confira novamente.</p> : <>
          <p className="private-juice-hint">{stats.data?.count} mensagens salvas · {date(stats.data?.first)} a {date(stats.data?.last)}</p>
          <div className="private-juice-period" role="group" aria-label="Período do suco">{([
            [1, '24 horas'], [7, '7 dias'], [30, '30 dias'], ['all', 'Tudo salvo'],
          ] as const).map(([value, label]) => <button key={value} type="button" className={period === value ? 'is-selected' : ''}
            aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
          <p className="private-juice-hint">Recorte: {date(new Date(start).toISOString())} a {date(new Date(last).toISOString())}.
            {period === 'all' && first < last - 365 * DAY ? ' O limite por suco é de 365 dias.' : ''}</p>
        </>}
    </section>

    <section className="private-juice-card"><div className="private-juice-card-heading"><span>3</span><div><h2>Escolha o tipo de suco</h2><p>Você pode indicar um assunto específico para a análise.</p></div></div>
      <label className="private-juice-field"><span>Tipo de suco</span><select value={typeId} onChange={event => setTypeId(event.target.value)}>
        {juiceTypes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        <option value="custom">{customJuice.title}</option>
        {personalTypes.data?.types.map(item => <option key={item.id} value={`personal:${item.id}`}>{item.name} · Meu tipo</option>)}
      </select></label>
      <label className="private-juice-field"><span>{typeId === 'custom' ? 'O que você quer tirar dessa conversa?' : 'Assunto ou detalhe (opcional)'}</span>
        {typeId === 'custom' ? <textarea required rows={5} value={focus} maxLength={10000}
          onChange={event => setFocus(event.target.value)} placeholder={customJuice.focusPlaceholder} /> :
          <Input value={focus.slice(0, 2000)} maxLength={2000}
            onChange={event => setFocus(event.target.value)} placeholder="Ex.: prazos do lançamento" />}</label>
      <label className="private-juice-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        <span>Autorizo enviar o trecho escolhido ao GLM (Zhipu/BigModel) para gerar este suco. Confira se a conversa contém dados que você pode compartilhar com o provedor.</span></label>
      {error && <p className="private-error" role="alert">{error}</p>}
      {pendingId && <p className="private-notice" role="status"><Loader2 className="inline h-4 w-4 animate-spin" /> Gerando seu suco. Você pode acompanhar o resultado aqui.</p>}
      <Button disabled={!chat || !rangeReady || !consent || (typeId === 'custom' && !focus.trim()) || !!pendingId || sending} onClick={() => void generate()}>
        {pendingId || sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <GlassWater size={17} />}
        {pendingId ? 'Aguardando resultado' : 'Gerar suco'}
      </Button>
    </section>
  </div>;
}

export function PrivateJuiceLibrary({ channel, accountId, onCreate }: {
  channel: ConfidentialChannel; accountId: string; onCreate: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<PrivateSummary | null>(null);
  const summaries = useQuery({
    queryKey: ['private', accountId, 'summaries', offset],
    queryFn: () => confidentialApi.summaries(channel, 50, offset),
    refetchInterval: 15_000, refetchOnWindowFocus: true,
  });
  return <div className="private-juice-flow">
    {open ? <><Button variant="outline" onClick={() => setOpen(null)}><ArrowLeft size={16} /> Meus sucos</Button><SummaryContent summary={open} /></> : <section className="private-juice-card">
      <div className="private-juice-library-heading"><div><h2>Meus sucos</h2><p>Resultados salvos na sua conta.</p></div><Button onClick={onCreate}><GlassWater size={17} /> Fazer um suco</Button></div>
      {summaries.isLoading && <p className="private-list-state"><Loader2 className="h-4 w-4 animate-spin" /> Carregando sucos…</p>}
      {summaries.error && <p className="private-error" role="alert">{confidentialErrorText(summaries.error)}</p>}
      {summaries.data?.summaries.length === 0 && <div className="private-juice-empty"><GlassWater size={28} /><strong>Seu primeiro suco começa com uma conversa.</strong><p>Escolha um grupo, um período e o tipo de resumo que quer criar.</p><Button onClick={onCreate}>Fazer um suco <ArrowRight size={16} /></Button></div>}
      {summaries.data?.summaries.map(item => <button key={item.id} type="button" className="private-juice-library-row" onClick={() => setOpen(item)}>
        <span><strong>{item.title}</strong><small>{item.chat_name} · {date(item.period_start)} a {date(item.period_end)}</small></span><ArrowRight size={17} /></button>)}
      {summaries.data && summaries.data.total > 50 && <div className="private-juice-pagination"><Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Anterior</Button>
        <span>{offset + 1}–{offset + summaries.data.summaries.length} de {summaries.data.total}</span>
        <Button variant="ghost" disabled={offset + 50 >= summaries.data.total} onClick={() => setOffset(offset + 50)}>Próxima</Button></div>}
    </section>}
  </div>;
}
