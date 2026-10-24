import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Loader2, Newspaper, RefreshCw } from 'lucide-react';
import { confidentialApi, confidentialErrorText, ConfidentialApiError,
  type PrivateSummary } from '@/lib/confidential-api';
import type { ConfidentialChannel } from '@/lib/confidential-channel';
import { Button } from '@/components/ui/button';

const todayInSaoPaulo = () => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const field = (name: string) => parts.find(part => part.type === name)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
};
const key = (accountId: string) => `suco-digest-pending:${accountId}`;
const stored = (accountId: string): string | null => {
  try { const value = sessionStorage.getItem(key(accountId));
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null; } catch { return null; }
};
const persist = (accountId: string, value: string | null) => {
  try { if (value) sessionStorage.setItem(key(accountId), value);
    else sessionStorage.removeItem(key(accountId)); } catch { /* Polling remains in memory. */ }
};

export function PrivateDigest({ channel, accountId }: { channel: ConfidentialChannel; accountId: string }) {
  const client = useQueryClient();
  const [day, setDay] = useState(todayInSaoPaulo);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(() => stored(accountId));
  const [pollReady, setPollReady] = useState(() => !!stored(accountId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const digests = useQuery({ queryKey: ['private', accountId, 'digests'],
    queryFn: () => confidentialApi.digests(channel), refetchInterval: 30_000,
    refetchOnWindowFocus: true });
  const status = useQuery({ queryKey: ['private', accountId, 'digest-status', pendingId],
    queryFn: () => confidentialApi.summaryStatus(channel, pendingId!),
    enabled: !!pendingId && pollReady, refetchInterval: 4_000, retry: 1 });
  useEffect(() => {
    if (!pendingId || !status.data || !('summary' in status.data)) return;
    setSelectedId(status.data.summary.id); setPendingId(null); setPollReady(false);
    persist(accountId, null);
    void client.invalidateQueries({ queryKey: ['private', accountId, 'digests'] });
  }, [accountId, client, pendingId, status.data]);
  useEffect(() => {
    if (!pendingId || !(status.error instanceof ConfidentialApiError) ||
        !['PRIVATE_SUMMARY_FAILED', 'PRIVATE_SUMMARY_NOT_FOUND'].includes(status.error.code)) return;
    setError(confidentialErrorText(status.error)); setPendingId(null); setPollReady(false);
    persist(accountId, null);
  }, [accountId, pendingId, status.error]);
  const current: PrivateSummary | undefined = digests.data?.digests.find(item => item.id === selectedId) ??
    digests.data?.digests[0] ?? ('summary' in (status.data ?? {}) ?
      (status.data as { summary: PrivateSummary }).summary : undefined);

  async function generate() {
    if (!consent || pendingId || busy) return;
    setError(''); setBusy(true);
    const id = crypto.randomUUID(); setPendingId(id); setPollReady(false); persist(accountId, id);
    try {
      const response = await confidentialApi.generateDigest(channel, day, id);
      if ('digest' in response) {
        setSelectedId(response.digest.id); setPendingId(null); setPollReady(false); persist(accountId, null);
        void client.invalidateQueries({ queryKey: ['private', accountId, 'digests'] });
      } else setPollReady(true);
    } catch (reason) {
      if (reason instanceof ConfidentialApiError && [400, 404, 422].includes(reason.status)) {
        setPendingId(null); setPollReady(false); persist(accountId, null);
      } else setPollReady(true);
      setError(confidentialErrorText(reason));
    } finally { setBusy(false); }
  }

  return <div className="private-juice-flow"><section className="private-juice-card">
    <h2>Seu dia, espremido.</h2><p className="private-juice-hint">Assuntos, decisões e pendências das conversas sincronizadas no dia escolhido.</p>
    <div className="private-digest-controls"><label>Dia (horário de São Paulo)
      <input type="date" value={day} max={todayInSaoPaulo()} onChange={event => setDay(event.target.value)} /></label>
      <Button variant="outline" disabled={!day || !consent || !!pendingId || busy} onClick={() => void generate()}>
        {pendingId ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw size={16} />}
        {pendingId ? 'Gerando…' : 'Gerar agora'}</Button></div>
    <label className="private-juice-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
      <span>Autorizo enviar os trechos das conversas salvas neste dia ao GLM (Zhipu/BigModel) para gerar o resumo.</span></label>
    {error && <p className="private-error" role="alert">{error}</p>}
    {pendingId && <p className="private-notice" role="status">Preparando o resumo. O resultado aparecerá aqui e ficará salvo.</p>}
  </section>
    {digests.error && <p className="private-error" role="alert">{confidentialErrorText(digests.error)}</p>}
    {digests.isLoading && <p className="private-list-state">Carregando resumos do dia…</p>}
    {!!digests.data?.digests.length && <nav className="private-digest-days" aria-label="Resumos anteriores">
      {digests.data.digests.map(item => <button type="button" key={item.id} className={current?.id === item.id ? 'is-selected' : ''}
        onClick={() => setSelectedId(item.id)}>{new Date(item.period_start).toLocaleDateString('pt-BR')}</button>)}
    </nav>}
    {current ? <article className="private-juice-result"><p className="private-eyebrow"><Newspaper size={15} /> Resumo do dia</p>
      <h2>{current.title}</h2><div className="private-juice-markdown prose prose-sm max-w-none"><ReactMarkdown>{current.content}</ReactMarkdown></div>
      <p className="private-juice-note">Confira decisões, prazos e valores nas conversas originais.</p></article> :
      !digests.isLoading && <div className="private-juice-card private-juice-empty"><Newspaper size={28} />
        <strong>Nenhum resumo do dia salvo.</strong><p>Escolha um dia com mensagens sincronizadas e gere o primeiro.</p></div>}
  </div>;
}
