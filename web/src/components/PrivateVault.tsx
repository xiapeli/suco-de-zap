import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Copy, Search } from 'lucide-react';
import { confidentialApi, confidentialErrorText } from '@/lib/confidential-api';
import type { ConfidentialChannel } from '@/lib/confidential-channel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Kind = 'all' | 'pix' | 'email' | 'phone' | 'address';

export function PrivateVault({ channel, accountId }: { channel: ConfidentialChannel; accountId: string }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [search, setSearch] = useState<{ query: string; kind: Kind } | null>(null);
  const [offset, setOffset] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const results = useQuery({
    queryKey: ['private', accountId, 'vault-search', search, offset],
    queryFn: () => confidentialApi.search(channel, { ...search!, limit: 30, offset }),
    enabled: !!search, retry: 1,
  });
  return <div className="private-vault">
    <section className="private-juice-card"><h2>O que você quer reencontrar?</h2>
      <p className="private-juice-hint">Busque nas mensagens salvas. Você pode filtrar por Pix, e-mail, telefone ou endereço.</p>
      <form className="private-vault-form" onSubmit={event => { event.preventDefault(); if (!query.trim() && kind === 'all') return;
        setOffset(0); setSearch({ query: query.trim(), kind }); }}>
        <label><span>Busca</span><Input value={query} maxLength={500} onChange={event => setQuery(event.target.value)}
          placeholder="Ex.: número da conta, cliente, endereço" /></label>
        <label><span>Tipo</span><select value={kind} onChange={event => setKind(event.target.value as Kind)}>
          <option value="all">Tudo</option><option value="pix">Pix</option><option value="email">E-mail</option>
          <option value="phone">Telefone</option><option value="address">Endereço</option></select></label>
        <Button type="submit" disabled={!query.trim() && kind === 'all'}><Search size={16} /> Buscar</Button>
      </form>
    </section>
    {search && <section className="private-juice-card" aria-live="polite">
      <h2>Resultados</h2>
      {results.isLoading && <p className="private-list-state" role="status">Buscando nas mensagens salvas…</p>}
      {results.error && <p className="private-error" role="alert">{confidentialErrorText(results.error)}</p>}
      {results.data && <><p className="private-juice-hint">{results.data.total} resultados em {results.data.coverage.selectedMessages} mensagens do recorte.
        Cobertura salva: {results.data.coverage.firstMessageAt ? new Date(results.data.coverage.firstMessageAt).toLocaleDateString('pt-BR') : '—'} até {results.data.coverage.lastMessageAt ? new Date(results.data.coverage.lastMessageAt).toLocaleDateString('pt-BR') : '—'}.
        O histórico antigo pode não estar completo.</p>
        {results.data.messages.length === 0 && <p className="private-list-state">Nada encontrado neste recorte. Tente outro termo ou tipo.</p>}
        <div className="private-vault-results">{results.data.messages.map(item => <article key={`${item.chat_jid}:${item.id}`}>
          <div><strong>{item.chat_name}</strong><span>{item.sender_name} · {new Date(item.ts).toLocaleString('pt-BR')}</span></div>
          <p>{item.body}{item.bodyTruncated ? '…' : ''}</p>
          <Button variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(item.body); setCopied(item.id); }
            catch { setCopied(null); } }}><Copy size={14} /> {copied === item.id ? 'Copiado' : 'Copiar trecho'}</Button>
        </article>)}</div>
        {results.data.total > 30 && <div className="private-juice-pagination"><Button variant="ghost" disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 30))}><ArrowLeft size={15} /> Anterior</Button>
          <span>{offset + 1}–{offset + results.data.messages.length} de {results.data.total}</span>
          <Button variant="ghost" disabled={results.data.nextOffset === null}
            onClick={() => setOffset(results.data!.nextOffset!)}>Próxima <ArrowRight size={15} /></Button></div>}
      </>}
    </section>}
  </div>;
}
