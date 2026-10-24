import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, getApiUrl, type DiscoveryHit, type DiscoveryResponse } from '@/lib/api';
import { plainExcerpt, vaultDestination } from '@/lib/discovery';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { JuiceCatalog } from '@/components/analysis/JuiceCatalog';
import SummaryMarkdown from '@/components/SummaryMarkdown';
import { Search, ArrowRight, CupSoda, LockKeyhole, X, RefreshCw } from 'lucide-react';

const examples = ['O que ficou combinado?', 'Prazos do lançamento', 'Pendências com clientes'];
function date(value: string) { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'data não informada' : d.toLocaleDateString('pt-BR'); }
function SavedJuice({ hit, open }: { hit: Pick<DiscoveryHit, 'id' | 'title' | 'chat_name' | 'period_start' | 'period_end' | 'excerpt'>; open: (id: string) => void }) {
  return <article className="suco-search-result">
    <p className="suco-search-source">{hit.chat_name || 'Conversa de origem'}<span>{date(hit.period_start)} a {date(hit.period_end)}</span></p>
    <h3><button type="button" onClick={() => open(hit.id)}>{hit.title || `Suco de ${hit.chat_name || 'uma conversa'}`}</button></h3>
    <p className="suco-search-excerpt">{plainExcerpt(hit.excerpt)}</p>
    <span className="suco-search-saved"><CupSoda size={14} aria-hidden="true" />Suco salvo</span>
  </article>;
}
function JuiceView({ id, onClose }: { id: string | null; onClose: () => void }) {
  const summary = useQuery({ queryKey: ['discovery-summary', getApiUrl(), id], queryFn: () => api.summary(id!), enabled: !!id, retry: false, gcTime: 0 });
  return <Dialog open={!!id} onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-3xl">
    <DialogHeader><DialogTitle>{summary.data?.summary.title || 'Seu suco salvo'}</DialogTitle><DialogDescription>{summary.data ? `${summary.data.summary.chat_name} · ${date(summary.data.summary.period_start)} a ${date(summary.data.summary.period_end)}` : 'O resumo e a conversa de origem aparecem aqui.'}</DialogDescription></DialogHeader>
    {summary.isPending && <div role="status" aria-label="Carregando o suco"><Skeleton className="h-28 w-full" /></div>}
    {summary.isError && <div role="alert"><p>{summary.error instanceof Error ? summary.error.message : 'O suco não carregou.'}</p><Button variant="outline" onClick={() => summary.refetch()}>Tentar novamente</Button></div>}
    {summary.data && <><ScrollArea className="max-h-[60vh] pr-4"><SummaryMarkdown content={summary.data.summary.content} /></ScrollArea><Button asChild variant="outline"><Link to="/conversations">Conferir minhas conversas</Link></Button></>}
  </DialogContent></Dialog>;
}

export default function Dashboard() {
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 30000 });
  const recent = useQuery({ queryKey: ['summaries', 'home-recent'], queryFn: () => api.summaries({ limit: 3 }), retry: false });
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  const vault = vaultDestination(submitted);
  const edited = !!submitted && query.trim() !== submitted;
  async function search(text: string, offset = 0) {
    const value = text.trim();
    if (!value || value.length > 500) { input.current?.focus(); return; }
    const request = ++epoch.current, origin = getApiUrl();
    setQuery(value); setSubmitted(value); setPending(true); setError('');
    if (offset === 0) setResult(null);
    try {
      const response = await api.discover(value, offset);
      if (request !== epoch.current || getApiUrl() !== origin) return;
      setResult(old => offset ? { ...response, results: [...(old?.results || []), ...response.results.filter(hit => !old?.results.some(previous => previous.id === hit.id))] } : response);
      requestAnimationFrame(() => results.current?.focus({ preventScroll: true }));
    } catch (cause) {
      if (request === epoch.current) setError(cause instanceof Error ? cause.message : 'A busca não carregou. Tente novamente.');
    } finally { if (request === epoch.current) setPending(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void search(query); }
  function clear() { epoch.current++; setQuery(''); setSubmitted(''); setResult(null); setError(''); setPending(false); input.current?.focus(); }
  return <AppLayout>
    <div className="suco-search-home" data-searching={!!submitted}>
      <section className="suco-search-start" aria-labelledby="search-title">
        <h1 id="search-title">De que papo vai sair suco?</h1>
        <p>Escolha um tema ou conte o que você quer entender.</p>
        <form role="search" onSubmit={submit} className="suco-search-form">
          <label className="sr-only" htmlFor="suco-search">Que assunto você quer transformar em suco?</label>
          <Search aria-hidden="true" className="suco-search-icon" />
          <input ref={input} id="suco-search" type="search" autoComplete="off" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} placeholder="Ex.: o que combinamos sobre a viagem?" aria-describedby="search-help" />
          {query && <button type="button" className="suco-search-clear" aria-label="Limpar busca" onClick={clear}><X size={18} /></button>}
          <Button type="submit" disabled={!query.trim() || pending}><Search size={18} aria-hidden="true" /><span>Preparar suco</span></Button>
        </form>
        <p id="search-help" className="suco-search-help">Você escolhe a conversa e o período antes de gerar. Preparar não usa sua cota.</p>
        {!submitted && <div className="suco-search-examples" aria-label="Ideias de busca">{examples.map(example => <button key={example} type="button" onClick={() => { setQuery(example); input.current?.focus(); }}>{example}<ArrowRight size={14} aria-hidden="true" /></button>)}</div>}
      </section>

      {!submitted && <JuiceCatalog request={query.trim()} />}
      {submitted ? <section className="suco-search-output" ref={results} tabIndex={-1} aria-label="Resultados da busca" aria-busy={pending}>
        <div className="suco-search-output-heading"><h2>{pending && !result ? 'Procurando seus sucos…' : 'Já saiu suco desse assunto?'}</h2><button type="button" onClick={clear}>Voltar ao início</button></div>
        <p className="suco-search-caption" role="status">{result ? `${result.total} ${result.total === 1 ? 'suco encontrado' : 'sucos encontrados'} no acervo salvo.` : pending ? 'Conferindo títulos, assuntos e conversas de origem.' : 'A busca ainda não foi concluída.'}{edited ? ' O campo mudou. Toque em Preparar suco para atualizar o pedido.' : ''}</p>
        <div className="suco-search-prepare"><CupSoda size={26} aria-hidden="true" /><div><h3>Seu pedido tá na mão.</h3><p>Escolha a conversa e o período. Confira o pedido antes de gerar um novo suco.</p><Button asChild><Link to="/conversations?suco=custom" state={{ sucoRequest: submitted }}>Preparar meu suco<ArrowRight size={16} className="ml-2" aria-hidden="true" /></Link></Button></div></div>
        {vault && <div className="suco-search-vault"><LockKeyhole size={22} aria-hidden="true" /><div><h3>Procurando um {vault.label} na conversa?</h3><p>No Cofre você busca a informação nas mensagens sincronizadas, com senha e filtro de período.</p><Link to={`/cofre?tipo=${vault.kind}`} state={{ sucoRequest: submitted }}>Continuar no Cofre<ArrowRight size={16} aria-hidden="true" /></Link></div></div>}
        {pending && !result && <div className="space-y-6 mt-6" aria-hidden="true">{[1, 2, 3].map(item => <Skeleton key={item} className="h-24 w-full" />)}</div>}
        {error && <div role="alert" className="suco-search-error"><p>{error}</p><Button variant="outline" disabled={pending} onClick={() => search(submitted, result?.nextOffset || 0)}><RefreshCw size={16} className="mr-2" />Tentar novamente</Button></div>}
        {result?.results.map(hit => <SavedJuice key={hit.id} hit={hit} open={setViewing} />)}
        {result && result.total === 0 && <div className="suco-search-empty"><h3>Esse assunto ainda não virou suco por aqui.</h3><p>{result.saved ? 'Tente o nome da conversa ou outro jeito de escrever o assunto. Você também pode preparar um suco com esse pedido.' : 'Seu primeiro suco começa escolhendo uma conversa e um período. Seu pedido já vai preenchido.'}</p></div>}
        {result?.nextOffset !== null && result?.nextOffset !== undefined && <Button variant="outline" disabled={pending} onClick={() => search(submitted, result.nextOffset!)}>{pending ? 'Carregando…' : 'Ver mais sucos'}</Button>}

        <p className="suco-search-coverage">Esta busca consulta os sucos já salvos. O Cofre consulta mensagens sincronizadas; o histórico disponível pode ser menor que o do celular.</p>
      </section> : <section className="suco-search-recent" aria-labelledby="recent-title">
        <div className="suco-search-output-heading"><h2 id="recent-title">{recent.data?.total === 0 ? 'O primeiro gole é seu.' : 'Seus últimos sucos'}</h2><Link to="/summaries">Ver todos</Link></div>
        {recent.isPending && <div role="status" aria-label="Carregando últimos sucos"><Skeleton className="h-28 w-full" /></div>}
        {recent.isError && <div role="alert" className="suco-search-error"><p>Seus últimos sucos não carregaram.</p><Button variant="outline" onClick={() => recent.refetch()}>Tentar novamente</Button></div>}
        {recent.data?.summaries.map(summary => <SavedJuice key={summary.id} hit={{ ...summary, excerpt: plainExcerpt(summary.content).slice(0, 200) }} open={setViewing} />)}
        {recent.data?.total === 0 && <div className="suco-search-empty"><p>Seu zap já tem história. Escolha uma conversa e transforme as mensagens em um resumo do que interessa.</p><Button asChild><Link to="/conversations">Preparar meu primeiro suco<ArrowRight size={16} className="ml-2" aria-hidden="true" /></Link></Button></div>}
      </section>}
      {submitted && <JuiceCatalog request={submitted} />}
      <nav className="suco-search-shortcuts" aria-label="Mais jeitos de usar o Suco"><Link to="/conversations"><CupSoda size={18} aria-hidden="true" />Tirar um novo suco</Link><Link to="/cofre"><LockKeyhole size={18} aria-hidden="true" />Reencontrar um dado</Link><Link to="/digest">O que rolou hoje?<ArrowRight size={16} aria-hidden="true" /></Link></nav>
      <details className="suco-search-collection"><summary>O que já está no meu Suco?</summary><p>{dashboard.isError ? 'Não conseguimos conferir o acervo agora. Tente atualizar a página.' : dashboard.data ? `${dashboard.data.chats.toLocaleString('pt-BR')} conversas, ${dashboard.data.messages.toLocaleString('pt-BR')} mensagens sincronizadas e ${dashboard.data.summaries.toLocaleString('pt-BR')} sucos salvos.` : 'Conferindo seu acervo…'} O Suco só lê e organiza. Nenhuma mensagem é enviada pelo seu número.</p><Link to="/onboarding">Conferir conexão</Link></details>
    </div>
    <JuiceView id={viewing} onClose={() => setViewing(null)} />
  </AppLayout>;
}
