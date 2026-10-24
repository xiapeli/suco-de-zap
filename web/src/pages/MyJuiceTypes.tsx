import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Copy, CupSoda, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, getApiUrl, type PersonalJuice, type PersonalJuiceMetadata, type SavePersonalJuice } from '@/lib/api';
import { juiceTypes, personalJuiceId } from '@/lib/juice-types';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';

const example = 'Liste pedidos de reunião com clientes, quem pediu, os e-mails enviados para esse fim e os horários mencionados. Separe o que foi confirmado do que ainda falta combinar. Cite as mensagens de origem. Não complete dados que não aparecem na conversa.';
const message = (error: unknown) => error instanceof Error ? error.message : 'Não conseguimos salvar agora. Tente novamente.';

export default function MyJuiceTypes() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const mode = parts[1] === 'new' ? 'new' : parts[2];
  const id = personalJuiceId('personal:' + parts[1]);
  const editing = mode === 'edit', copying = mode === 'copy';
  const model = useQuery({queryKey:['personal-juice',getApiUrl(),id],queryFn:()=>api.personalJuice(id!),enabled:!!id&&(editing||copying),retry:false});
  const isForm = mode === 'new' || editing || copying;
  const invalidRoute = (editing||copying)&&!id;
  return <AppLayout breadcrumbs={[{label:'Início',href:'/'},{label:'Meus tipos',href:isForm?'/my-juices':undefined},...(isForm?[{label:editing?'Editar tipo':copying?'Duplicar tipo':'Criar tipo'}]:[])]}>
    {isForm ? (!editing&&!copying ? <TypeEditor key="new"/> : model.data ? <TypeEditor key={pathname} original={model.data.type} copying={copying}/> : <div className="suco-personal-page"><p role={model.isError||invalidRoute?'alert':'status'}>{invalidRoute?'Esse endereço de tipo não é válido.':model.isError?'Esse tipo não carregou. Ele pode ter sido excluído.':'Carregando seu tipo…'}</p>{model.isError&&!invalidRoute&&<Button variant="outline" onClick={()=>model.refetch()}>Tentar novamente</Button>}<Link className="suco-personal-manage" to="/my-juices">Voltar aos meus tipos</Link></div>) : <TypesList/>}
  </AppLayout>;
}

function TypeEditor({original,copying=false}:{original?:PersonalJuice;copying?:boolean}) {
  const navigate = useNavigate(), client = useQueryClient();
  const [name,setName] = useState(original ? (copying ? `${original.name.slice(0,72)} (cópia)` : original.name) : '');
  const [category,setCategory] = useState(original?.category || '');
  const [instructions,setInstructions] = useState(original?.instructions || '');
  const [base,setBase] = useState(original?.base_type || 'custom');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [uncertain,setUncertain] = useState(false);
  const [conflict,setConflict] = useState(false);
  const operation = useRef<SavePersonalJuice|null>(null);
  const editing = !!original&&!copying;
  // The exact payload is frozen while a save has an uncertain response.
  const locked = busy || uncertain;
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(()=>{formRef.current?.querySelector<HTMLInputElement>('input')?.focus();},[]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if(busy||conflict)return;
    setError('');setBusy(true);
    if(!operation.current) operation.current={id:editing?original!.id:crypto.randomUUID(),revision_id:crypto.randomUUID(),name:name.trim(),category:category.trim(),instructions:instructions.trim(),base_type:base,...(editing?{expected_revision:original!.revision_id}:{})};
    try {
      const result=await api.savePersonalJuice(operation.current);
      client.setQueryData(['personal-juice',getApiUrl(),result.type.id],result);
      await client.invalidateQueries({queryKey:['personal-juices']});
      navigate('/my-juices',{replace:true,state:{saved:result.type.id}});
    } catch(e) {
      setError(message(e));
      const known=e instanceof ApiError&&[400,401,403,404,409,413,429].includes(e.status);
      setUncertain(!known);
      if(known){operation.current=null;if(e instanceof ApiError&&e.code==='PERSONAL_JUICE_CONFLICT')setConflict(true);}
    } finally {setBusy(false);}
  }
  return <div className="suco-personal-page suco-personal-editor">
    <Link to="/my-juices" className="suco-personal-back"><ArrowLeft size={17} aria-hidden="true"/> Meus tipos</Link>
    <header><h1>{editing?'Ajuste a receita.':copying?'Uma receita, outro sabor.':'Seu papo. Sua receita.'}</h1><p>Dê um nome e conte o que este suco deve organizar. Você escolhe a conversa e o período quando for usar.</p></header>
    <form ref={formRef} onSubmit={save} className="suco-personal-form">
      <fieldset disabled={locked||conflict}>
        <div className="suco-personal-fields">
          <label htmlFor="type-name">Nome do tipo<Input id="type-name" required maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Reuniões com meus clientes"/></label>
          <label htmlFor="type-category">Categoria <span>(opcional)</span><Input id="type-category" maxLength={60} value={category} onChange={e=>setCategory(e.target.value)} placeholder="Ex.: Comercial, casa, faculdade"/></label>
        </div>
        <label htmlFor="type-base">Começar a partir de<select id="type-base" value={base} onChange={e=>setBase(e.target.value)}><option value="custom">Meu próprio pedido</option>{juiceTypes.map(type=><option key={type.id} value={type.id}>{type.title}</option>)}</select><small>{base==='custom'?'Você define o que procurar e como organizar.':'Mantém a estrutura desse modelo e acrescenta suas instruções abaixo.'}</small></label>
        <label htmlFor="type-instructions">O que este suco deve organizar?<Textarea id="type-instructions" required minLength={1} maxLength={10000} rows={7} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="Conte o que procurar, como separar os achados e o que precisa aparecer no resultado." aria-describedby="type-instructions-help"/></label>
        <div className="suco-personal-help" id="type-instructions-help"><span>Peça as informações e o formato. O Suco analisa as mensagens disponíveis na conversa e no período escolhidos.</span><span>{instructions.length.toLocaleString('pt-BR')} / 10.000</span></div>
        {!instructions&&<button className="suco-personal-example" type="button" onClick={()=>{setInstructions(example);if(!name)setName('Reuniões com meus clientes');if(!category)setCategory('Comercial');}}>Preencher um exemplo de reuniões <ArrowUpRight size={16} aria-hidden="true"/></button>}
      </fieldset>
      <aside className="suco-personal-aside"><CupSoda size={24} aria-hidden="true"/><div><strong>Uma receita para usar de novo.</strong><p>Salvar um tipo não usa seus sucos disponíveis. Gerar a análise usa a cota do seu plano. Cada tipo fica só na sua conta.</p></div></aside>
      {editing&&<p className="suco-personal-caption">As mudanças valem para novos pedidos. Seus sucos prontos e pedidos em confirmação mantêm a receita original.</p>}
      {error&&<p role="alert" className="suco-personal-error">{error}</p>}
      {uncertain&&<p role="status">Ainda precisamos confirmar se foi salvo. Tente novamente abaixo para consultar o mesmo pedido.</p>}
      {conflict&&<p>Abra <Link to="/my-juices" className="underline">Meus tipos</Link> em outra aba para conferir a versão atual. Seu texto continua nesta tela.</p>}
      <div className="suco-personal-form-actions"><Button type="submit" disabled={busy||conflict||!name.trim()||!instructions.trim()}>{busy?'Salvando…':uncertain?'Tentar salvar novamente':editing?'Salvar alterações':'Salvar tipo de suco'}</Button><span>Salvar só guarda a receita. Nenhuma análise ou convite é enviado.</span></div>
    </form>
  </div>;
}

function TypesList() {
  const query=useQuery({queryKey:['personal-juices',getApiUrl()],queryFn:api.personalJuices,retry:false});
  const client=useQueryClient(), location=useLocation();
  const [removing,setRemoving]=useState<PersonalJuiceMetadata|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const categories=[...new Set(query.data?.types.map(type=>type.category)||[])];
  async function archive(){if(!removing||busy)return;setBusy(true);setError('');try{await api.archivePersonalJuice(removing.id,removing.revision_id);await client.invalidateQueries({queryKey:['personal-juices']});await client.invalidateQueries({queryKey:['personal-juice']});setRemoving(null);}catch(e){setError(message(e));}finally{setBusy(false);}}
  return <div className="suco-personal-page">
    <header className="suco-personal-list-heading"><div><h1>Meus tipos de suco</h1><p>Guarde o que você sempre quer entender. A próxima conversa já tem receita.</p></div><Button asChild><Link to="/my-juices/new"><Plus size={17} aria-hidden="true"/> Criar tipo de suco</Link></Button></header>
    {(location.state as {saved?:string}|null)?.saved&&<p className="suco-personal-saved" role="status">Tipo salvo. Escolha uma conversa para experimentar.</p>}
    {query.isPending&&<p role="status">Carregando seus tipos…</p>}
    {query.isError&&<div role="alert"><p>Seus tipos não carregaram.</p><Button variant="outline" onClick={()=>query.refetch()}>Tentar novamente</Button></div>}
    {query.isSuccess&&!query.data.types.length&&<div className="suco-personal-empty-state"><CupSoda size={42} strokeWidth={1.5} aria-hidden="true"/><h2>Esse sabor ainda é só seu.</h2><p>Reuniões de clientes, pendências da casa, decisões de um projeto. Crie um tipo para o papo que vive voltando.</p><Link to="/my-juices/new" className="suco-personal-manage">Criar meu primeiro tipo <ArrowUpRight size={17} aria-hidden="true"/></Link></div>}
    {categories.map(category=><section className="suco-personal-category" key={category}><h2>{category}</h2><ul>{query.data!.types.filter(type=>type.category===category).map(type=><li className="suco-personal-row" key={type.id}><div><h3><Link to={`/conversations?suco=personal:${type.id}`}>{type.name} <ArrowUpRight size={17} aria-hidden="true"/></Link></h3><p>{type.instructions_preview}</p></div><div className="suco-personal-row-actions"><Link aria-label={`Editar ${type.name}`} to={`/my-juices/${type.id}/edit`}><Pencil size={16} aria-hidden="true"/> Editar</Link><Link aria-label={`Duplicar ${type.name}`} to={`/my-juices/${type.id}/copy`}><Copy size={16} aria-hidden="true"/> Duplicar</Link><button aria-label={`Excluir ${type.name}`} onClick={()=>{setError('');setRemoving(type);}}><Trash2 size={16} aria-hidden="true"/> Excluir</button></div></li>)}</ul></section>)}
    <AlertDialog open={!!removing} onOpenChange={open=>{if(!open&&!busy)setRemoving(null);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Excluir “{removing?.name}” dos seus tipos?</AlertDialogTitle><AlertDialogDescription>Ele sai da sua lista. Seus sucos prontos continuam salvos e um pedido em confirmação mantém a receita original.</AlertDialogDescription></AlertDialogHeader>{error&&<p role="alert">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>Manter tipo</AlertDialogCancel><Button variant="destructive" disabled={busy} onClick={archive}>{busy?'Excluindo…':'Excluir tipo'}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
