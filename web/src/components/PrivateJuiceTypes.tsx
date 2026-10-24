import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Copy, CupSoda, Pencil, Plus, Trash2 } from 'lucide-react';
import { confidentialApi, confidentialErrorText, type PrivatePersonalType } from '@/lib/confidential-api';
import type { ConfidentialChannel } from '@/lib/confidential-channel';
import { juiceTypes } from '@/lib/juice-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function PrivateJuiceTypes({ channel, accountId, onUse }: {
  channel: ConfidentialChannel; accountId: string; onUse: (id: string) => void;
}) {
  const client = useQueryClient();
  const types = useQuery({ queryKey: ['private', accountId, 'personal-types'],
    queryFn: () => confidentialApi.personalTypes(channel), refetchOnWindowFocus: true });
  const [editing, setEditing] = useState<PrivatePersonalType | null | 'new'>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [base, setBase] = useState('custom');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function open(type?: PrivatePersonalType, duplicate = false) {
    setEditing(type && !duplicate ? type : 'new');
    setName(type ? `${type.name}${duplicate ? ' (cópia)' : ''}` : '');
    setCategory(type?.category ?? '');
    setBase(type?.base_type ?? 'custom');
    setInstructions(type?.instructions ?? '');
    setError(''); setNotice('');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy || !editing) return;
    setBusy(true); setError('');
    try {
      const current = editing === 'new' ? null : editing;
      await confidentialApi.savePersonalType(channel, {
        id: current?.id ?? crypto.randomUUID(), revision: current?.revision ?? 0,
        name: name.trim(), category: category.trim(), base_type: base, instructions: instructions.trim(),
      });
      setEditing(null); setNotice('Tipo salvo. Escolha uma conversa para usar.');
      await client.invalidateQueries({ queryKey: ['private', accountId, 'personal-types'] });
    } catch (reason) { setError(confidentialErrorText(reason)); }
    finally { setBusy(false); }
  }
  async function archive(type: PrivatePersonalType) {
    if (busy || !window.confirm(`Excluir “${type.name}” dos seus tipos? Seus sucos salvos continuam disponíveis.`)) return;
    setBusy(true); setError('');
    try { await confidentialApi.archivePersonalType(channel, type.id, type.revision);
      await client.invalidateQueries({ queryKey: ['private', accountId, 'personal-types'] });
      setNotice('Tipo excluído.'); }
    catch (reason) { setError(confidentialErrorText(reason)); }
    finally { setBusy(false); }
  }

  if (editing) return <div className="private-juice-flow"><Button variant="ghost" onClick={() => setEditing(null)}><ArrowLeft size={16} /> Meus tipos</Button>
    <form className="private-juice-card private-personal-form" onSubmit={event => void save(event)}>
      <h2>{editing === 'new' ? 'Seu papo. Sua receita.' : 'Ajuste a receita.'}</h2>
      <p className="private-juice-hint">Guarde o que esse tipo de suco deve encontrar e organizar. Você escolhe grupo e período quando for gerar.</p>
      <label>Nome do tipo<Input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Ex.: Reuniões com clientes" /></label>
      <label>Categoria (opcional)<Input maxLength={60} value={category} onChange={event => setCategory(event.target.value)} placeholder="Ex.: Comercial" /></label>
      <label>Começar a partir de<select value={base} onChange={event => setBase(event.target.value)}>
        <option value="custom">Meu próprio pedido</option>{juiceTypes.map(type => <option key={type.id} value={type.id}>{type.title}</option>)}
      </select></label>
      <label>O que este suco deve organizar?<textarea required maxLength={10000} rows={7} value={instructions}
        onChange={event => setInstructions(event.target.value)} placeholder="Conte o que procurar e como apresentar os achados." /></label>
      <p className="private-juice-hint">{instructions.length.toLocaleString('pt-BR')} / 10.000 caracteres. Salvar o tipo não gera uma análise.</p>
      {error && <p className="private-error" role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>{busy ? 'Salvando…' : 'Salvar tipo de suco'}</Button>
    </form>
  </div>;

  return <div className="private-juice-flow"><section className="private-juice-card">
    <div className="private-juice-library-heading"><div><h2>Meus tipos de suco</h2><p>Receitas salvas para usar em outras conversas.</p></div>
      <Button onClick={() => open()}><Plus size={16} /> Criar tipo de suco</Button></div>
    {notice && <p className="private-notice" role="status">{notice}</p>}
    {error && <p className="private-error" role="alert">{error}</p>}
    {types.isLoading && <p className="private-list-state">Carregando seus tipos…</p>}
    {types.error && <p className="private-error" role="alert">{confidentialErrorText(types.error)}</p>}
    {types.data?.types.length === 0 && <div className="private-juice-empty"><CupSoda size={28} /><strong>Esse sabor ainda é só seu.</strong>
      <p>Crie um tipo para o assunto que sempre volta nos seus grupos.</p><Button onClick={() => open()}>Criar meu primeiro tipo <ArrowRight size={16} /></Button></div>}
    {types.data?.types.map(type => <article className="private-personal-row" key={type.id}>
      <div><small>{type.category || 'Meu tipo'}</small><h3>{type.name}</h3><p>{type.instructions.slice(0, 160)}{type.instructions.length > 160 ? '…' : ''}</p></div>
      <div className="private-personal-actions"><Button variant="outline" onClick={() => onUse(type.id)}>Usar <ArrowRight size={15} /></Button>
        <Button variant="ghost" aria-label={`Editar ${type.name}`} onClick={() => open(type)}><Pencil size={16} /></Button>
        <Button variant="ghost" aria-label={`Duplicar ${type.name}`} onClick={() => open(type, true)}><Copy size={16} /></Button>
        <Button variant="ghost" aria-label={`Excluir ${type.name}`} onClick={() => void archive(type)}><Trash2 size={16} /></Button></div>
    </article>)}
  </section></div>;
}
