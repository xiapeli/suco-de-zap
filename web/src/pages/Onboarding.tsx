import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Copy, CupSoda, Loader2, RefreshCw, Search, ShieldCheck, Smartphone, WifiOff } from 'lucide-react';
import { api, ApiError, getApiUrl, getToken, type Chat, type Summary } from '@/lib/api';
import { useConnection } from '@/hooks/useConnection';
import { isSyncUnverified } from '@/lib/connection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { PrivateLayoutContext } from '@/components/AppLayout';
import { PrivateAccountMenu } from '@/components/PrivateAppLayout';
import SummaryMarkdown from '@/components/SummaryMarkdown';
import { ActivationSteps } from '@/components/onboarding/ActivationSteps';
import { draftKey, expiredQr, freezeRequest, goals, loadDraft, period, resetCorruptDraft, saveDraft, summaryFailure, type Draft, type DraftStorage, type FrozenRequest, type Stage } from '@/lib/onboarding-state';

const unavailableStorage:DraftStorage={getItem(){throw Error();},setItem(){throw Error();},removeItem(){}};
function browserStorage():DraftStorage { try{return window.localStorage;}catch{return unavailableStorage;} }
function date(value:string|null|undefined) { const at=Date.parse(value||'');return Number.isFinite(at)?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short'}).format(at):'data não disponível'; }
function syncDate(value:string|null|undefined) { const at=Date.parse(value||'');return Number.isFinite(at)?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(at):'data não disponível'; }
function displayError(error:unknown,fallback:string) { return error instanceof ApiError?error.message:fallback; }
const knownAccess=(value:string|undefined)=>['owner','paid','trial','trial_exhausted'].includes(value||'');
const LegacyUserNav = import.meta.env.VITE_SUCO_CONTROL === 'supabase' ? null :
  lazy(() => import('@/components/UserNav').then(module => ({ default: module.UserNav })));

export default function Onboarding() {
  const privateAccount = useContext(PrivateLayoutContext);
  const [params]=useSearchParams();const reconnecting=params.has('reconnect');
  const scope=useMemo(()=>getApiUrl(),[]);const key=useMemo(()=>draftKey(scope),[scope]);
  const [boot]=useState(()=>loadDraft(browserStorage(),key));
  const [draft,setDraft]=useState<Draft>(boot.draft);const draftRef=useRef(draft);draftRef.current=draft;
  const [storageProblem,setStorageProblem]=useState(boot.problem);
  const [recoveryMessage,setRecoveryMessage]=useState('');
  const [initialized,setInitialized]=useState(false);const hydrated=useRef(false);const live=useRef(true);const flight=useRef(false);
  const [understood,setUnderstood]=useState(false);const [result,setResult]=useState<Summary|null>(null);
  const [selected,setSelected]=useState<Chat|null>(null);const [search,setSearch]=useState('');const [searchTerm,setSearchTerm]=useState('');
  const [chatKind,setChatKind]=useState<'group'|'all'>('group');
  const [anchor,setAnchor]=useState(Date.now);const [now,setNow]=useState(Date.now);const [device,setDevice]=useState<'desktop'|'phone'>(()=>window.matchMedia('(max-width:767px)').matches?'phone':'desktop');
  const [showMobileQr,setShowMobileQr]=useState(false);const [copied,setCopied]=useState(false);const [copyError,setCopyError]=useState('');
  const [confirmFreshPairing,setConfirmFreshPairing]=useState(false);
  const [localError,setLocalError]=useState('');const [automate,setAutomate]=useState(false);const titleRef=useRef<HTMLHeadingElement>(null);
  const client=useQueryClient();const saved=useQuery({queryKey:['onboarding'],queryFn:api.onboarding,retry:false});
  const usage=useQuery({queryKey:['usage'],queryFn:api.usage,retry:false,refetchInterval:15000});const connection=useConnection();const status=connection.data;
  const access=usage.data&&'access'in usage.data?usage.data.access:undefined;const accessKnown=knownAccess(access);
  const trial=access==='trial'||access==='trial_exhausted';const exhausted=access==='trial_exhausted';const advanced=access==='owner'||access==='paid';
  const consentKnown=!!saved.data?.consent;
  const locked=!!draft.request||flight.current;
  const chosenGoal=goals.find(g=>g.id===draft.goal)||goals[0];
  function update(next:Draft,required=false) {
    if(storageProblem==='corrupt'&&!next.completedId){if(required)return false;draftRef.current=next;setDraft(next);return true;}
    const existing=loadDraft(browserStorage(),key);
    if(existing.problem){setStorageProblem(existing.problem);if(required)return false;draftRef.current=next;setDraft(next);return true;}
    if(existing.draft.request&&!draftRef.current.request&&existing.draft.request.request_id!==next.request?.request_id){draftRef.current=existing.draft;setDraft(existing.draft);setLocalError('Encontramos um pedido anterior. Vamos conferir esse pedido antes de começar outro.');return false;}
    const stored=saveDraft(browserStorage(),key,next);if(!stored)setStorageProblem('unavailable');else setStorageProblem(null);
    if(!stored&&required)return false;draftRef.current=next;setDraft(next);return true;
  }
  function go(stage:Stage){setLocalError('');update({...draftRef.current,stage});}
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{const timer=setTimeout(()=>setSearchTerm(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    const changed=(event:StorageEvent)=>{if(event.key!==key||flight.current||draftRef.current.request)return;const incoming=loadDraft(browserStorage(),key);if(incoming.draft.request){draftRef.current=incoming.draft;setDraft(incoming.draft);setLocalError('Este pedido foi iniciado em outra aba. Vamos conferir o mesmo pedido.');}};
    window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
  },[key]);

  useEffect(()=>{if(!status?.qr||draft.stage!=='connect')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[status?.qr,draft.stage]);
  useEffect(()=>{
    if(hydrated.current||saved.isPending||usage.isPending||saved.isError||usage.isError||!accessKnown)return;
    hydrated.current=true;let next={...draftRef.current};
    if(next.request)next.stage='prepare';
    else if(reconnecting)next.stage=consentKnown?'connect':'welcome';
    else if(next.completedId)next.stage='done';
    else if(saved.data?.firstSummary){setResult(saved.data.firstSummary);next={...next,stage:'done',completedId:saved.data.firstSummary.id};}
    else if(next.stage==='done'&&!next.completedId)next.stage='welcome';
    else if(!consentKnown)next.stage='welcome';
    update(next);setInitialized(true);
  },[saved.isPending,saved.isError,saved.data,usage.isPending,usage.isError,accessKnown,consentKnown,reconnecting]);
  useEffect(()=>{if(initialized){titleRef.current?.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}},[draft.stage,initialized]);
  const chats=useQuery({queryKey:['activation-chats',getApiUrl(),chatKind,searchTerm],queryFn:()=>api.chats({q:searchTerm,kind:chatKind,limit:100}),enabled:consentKnown&&initialized&&(draft.stage==='connect'||draft.stage==='prepare')&&!exhausted,retry:false,refetchInterval:status?.syncing?5000:status?.connected?15000:false,refetchOnWindowFocus:true,refetchOnReconnect:true});
  useEffect(()=>{if(status?.connected)void client.invalidateQueries({queryKey:['activation-chats']});},[status?.connected,client]);
  useEffect(()=>{if(!selected&&draft.chatId){const chat=chats.data?.chats.find(c=>c.jid===draft.chatId);if(chat)setSelected(chat);}},[draft.chatId,chats.data,selected]);
  const fullStats=useQuery({queryKey:['activation-full-stats',draft.chatId],queryFn:()=>api.chatStats(draft.chatId),enabled:initialized&&draft.stage==='prepare'&&!!draft.chatId&&!draft.request,retry:false});
  const windowRange=useMemo(()=>period(draft.range,anchor,fullStats.data?.first,fullStats.data?.last),[draft.range,anchor,fullStats.data?.first,fullStats.data?.last]);
  const rangeStats=useQuery({queryKey:['activation-range',draft.chatId,windowRange?.start,windowRange?.end],queryFn:()=>api.chatStats(draft.chatId,windowRange!),enabled:initialized&&draft.stage==='prepare'&&!!draft.chatId&&!!windowRange&&draft.range!=='all'&&!draft.request,retry:false});
  const stats=draft.range==='all'?fullStats:rangeStats;
  const resumed=useQuery({queryKey:['activation-result',draft.completedId],queryFn:()=>api.summary(draft.completedId!),enabled:initialized&&draft.stage==='done'&&!!draft.completedId&&!result,retry:false});
  const activeResult=result||resumed.data?.summary||null;
  const consent=useMutation({mutationFn:api.consent,onSuccess:data=>{if(!live.current)return;client.setQueryData(['onboarding'],data);
    go(status?.connected&&!isSyncUnverified(status,Date.now())?'prepare':'connect');}});
  const reconnect=useMutation({mutationFn:api.reconnect,onSuccess:()=>{setNow(Date.now());connection.refetch();}});
  const freshPairing=useMutation({mutationFn:api.newPairing,onSuccess:()=>{setConfirmFreshPairing(false);setNow(Date.now());void connection.refetch();}});
  const first=useMutation({
    mutationFn:async(request:FrozenRequest)=>{
      const response=await api.generateSummary(request);const summary=response.summary;
      if(!summary?.id||!summary.content?.trim()||summary.chat_jid!==request.chat_jid||summary.analysis_type!==request.analysis_type||Date.parse(summary.period_start)!==Date.parse(request.start)||Date.parse(summary.period_end)!==Date.parse(request.end))throw Error('SUMMARY_RESULT_UNCONFIRMED');
      return summary;
    },
    onSuccess:(summary,request)=>{
      if(!live.current||!getToken()||getApiUrl()!==scope||draftRef.current.request?.request_id!==request.request_id)return;
      setResult(summary);update({...draftRef.current,stage:'done',request:null,requestState:null,completedId:summary.id});
      for(const queryKey of [['usage'],['dashboard'],['onboarding'],['summaries']])void client.invalidateQueries({queryKey});
    },
    onError:(error,request)=>{
      if(!live.current||!getToken()||getApiUrl()!==scope||draftRef.current.request?.request_id!==request.request_id)return;
      const code=error instanceof ApiError?error.code:undefined;
      update({...draftRef.current,requestState:summaryFailure(code)==='terminal'?'failed':'uncertain'});
      void client.invalidateQueries({queryKey:['usage']});
    },
    onSettled:()=>{flight.current=false;},
  });
  const tracking=useMutation({mutationFn:()=>api.updateChat(activeResult!.chat_jid,{tracked:true}),onSuccess:()=>{setAutomate(false);void client.invalidateQueries({queryKey:['usage']});void client.invalidateQueries({queryKey:['activation-chats']});}});
  const recovery=useMutation({
    mutationFn:async()=>{
      const [verified,verifiedUsage]=await Promise.all([api.onboarding(),api.usage()]);
      if(!('access'in verifiedUsage)||!knownAccess(verifiedUsage.access))throw Error('RECOVERY_ACCESS_UNCONFIRMED');
      return {verified,verifiedUsage};
    },
    onSuccess:({verified,verifiedUsage})=>{
      if(!live.current||!getToken()||getApiUrl()!==scope)return;
      client.setQueryData(['onboarding'],verified);client.setQueryData(['usage'],verifiedUsage);
      const current=loadDraft(browserStorage(),key);
      if(current.problem!=='corrupt') {
        setStorageProblem(current.problem);
        if(!current.problem){const next={...current.draft,stage:current.draft.request?'prepare' as const:current.draft.stage};draftRef.current=next;setDraft(next);setRecoveryMessage('Encontramos o rascunho atualizado. Seu pedido foi preservado.');}
        return;
      }
      if(verified.firstSummary) {
        const next={...current.draft,stage:'done' as const,completedId:verified.firstSummary.id};
        if(!saveDraft(browserStorage(),key,next)){setStorageProblem('unavailable');return;}
        setResult(verified.firstSummary);draftRef.current=next;setDraft(next);setStorageProblem(null);setLocalError('');return;
      }
      if(verified.recovery?.canRestart!==true){setRecoveryMessage('Ainda não conseguimos confirmar que o pedido anterior terminou. Nenhuma análise foi reiniciada. Confira os sucos salvos ou tente conferir novamente.');return;}
      const restored=resetCorruptDraft(browserStorage(),key,true);
      setStorageProblem(restored.problem);
      if(!restored.problem){draftRef.current=restored.draft;setDraft(restored.draft);setLocalError('');setRecoveryMessage('Seu rascunho local foi recuperado. Nenhuma análise foi iniciada e seus créditos foram preservados.');}
    },
  });
  function generate() {
    if(flight.current||first.isPending||!accessKnown)return;setLocalError('');
    let request=draftRef.current.request;
    if(!request){
      if(exhausted||!draft.chatId||!windowRange||!stats.isSuccess||stats.data.count<1)return;
      if(storageProblem==='corrupt'){setLocalError('Não conseguimos recuperar o pedido anterior. Confira Meus sucos antes de começar outro.');return;}
      request=freezeRequest(crypto.randomUUID(),draft.chatId,draft.goal,windowRange.start,windowRange.end);
      if(!update({...draftRef.current,stage:'prepare',request,requestState:'pending'},true)){if(draftRef.current.request){setLocalError('Há um pedido anterior salvo. Confira esse pedido antes de começar outro.');return;}setLocalError('Este navegador não conseguiu guardar o identificador do pedido. Nenhuma análise começou. Permita o armazenamento deste site e tente novamente.');return;}
    }
    flight.current=true;first.mutate(request);
  }
  async function copyAddress(){setCopyError('');try{await navigator.clipboard.writeText(new URL('/account',location.origin).href);setCopied(true);}catch{setCopyError('Não conseguimos copiar. Abra este endereço no outro aparelho: '+new URL('/account',location.origin).href);}}
  const qrExpired=expiredQr(status?.qrExpiresAt,now);
  const qrSeconds=status?.qrExpiresAt?Math.max(0,Math.ceil((Date.parse(status.qrExpiresAt)-now)/1000)):null;
  const busyTrial=trial&&usage.data&&'trial'in usage.data&&(usage.data.trial?.remaining??0)<1;
  const connectionFailed=connection.isError;const blocked=status?.connectionState==='action_required';const forbidden=status?.reason==='forbidden';const pairingMismatch=status?.pairingError==='PAIRING_ACCOUNT_MISMATCH';const pairingIdentityUnavailable=status?.pairingError==='PAIRING_IDENTITY_UNAVAILABLE';
  const ingestionFailing=!!status?.syncEvidence?.pendingInMemory||!!status?.syncEvidence?.writeHealth?.consecutiveWriteFailures;
  const syncUnverified=isSyncUnverified(status,now);
  const firstLabel=draft.request?'Conferir o mesmo pedido':trial?'Preparar 1 suco grátis':'Preparar meu primeiro suco';
  const header=<header className="activation-top"><Link to="/" className="activation-brand" aria-label="Suco de Zap — meu espaço"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" alt="" width="52" height="52"/><span>Suco de Zap</span></Link><div className="flex items-center gap-3"><Link to="/" className="quiet-link activation-later">Continuar depois</Link>{privateAccount ? <PrivateAccountMenu {...privateAccount} /> : LegacyUserNav ? <Suspense fallback={null}><LegacyUserNav /></Suspense> : null}</div></header>;
  const error=(error:unknown,fallback:string)=><div className="activation-error" role="alert"><WifiOff size={20}/><div><h2>Não conseguimos concluir agora.</h2><p>{displayError(error,fallback)}</p></div></div>;
  const freshPairingControls=<div className="activation-fresh-pairing">
    {confirmFreshPairing?<div role="group" aria-label="Confirmar novo pareamento"><p>O Suco guardará a sessão atual em cópia privada e pedirá um novo QR. As conversas e os sucos já salvos continuam no seu espaço. Você precisará conectar este aparelho novamente pelo celular.</p><div className="flex flex-wrap gap-2 mt-3"><Button type="button" disabled={freshPairing.isPending} onClick={()=>freshPairing.mutate()}>{freshPairing.isPending?'Preparando novo QR…':'Confirmar novo pareamento'}</Button><Button type="button" variant="ghost" disabled={freshPairing.isPending} onClick={()=>setConfirmFreshPairing(false)}>Cancelar</Button></div></div>:<Button type="button" variant="outline" onClick={()=>setConfirmFreshPairing(true)}>Refazer vínculo com novo QR</Button>}
    {freshPairing.isError&&error(freshPairing.error,'Não conseguimos preservar sua sessão anterior. Nenhum dado salvo foi apagado.')}
  </div>;
  const title=(text:string,description:string)=><div className="activation-heading"><h1 ref={titleRef} tabIndex={-1}>{text}</h1><p>{description}</p></div>;
  return <main className="activation-shell">{header}<div className="activation-body"><ActivationSteps current={!initialized?1:draft.stage==='done'?3:draft.stage==='prepare'?2:1}/>
    {initialized&&storageProblem&&!draft.request&&!activeResult&&<section className="activation-panel" aria-label="Recuperar rascunho"><h2>Vamos retomar com segurança.</h2><p>{storageProblem==='corrupt'?'O rascunho deste navegador não pôde ser lido. Vamos conferir seus pedidos no servidor antes de recuperar as escolhas.':'Este navegador não conseguiu guardar sua retomada. Permita o armazenamento deste site e tente novamente.'}</p>{storageProblem==='corrupt'&&<Button className="mt-4" variant="outline" disabled={recovery.isPending} onClick={()=>{setRecoveryMessage('');recovery.mutate();}}>{recovery.isPending?<Loader2 className="animate-spin"/>:null}{recovery.isPending?'Conferindo seus pedidos…':'Conferir pedidos e recuperar rascunho'}</Button>}{recoveryMessage&&<p className="mt-4" role="status">{recoveryMessage}</p>}{recovery.isError&&<p className="mt-4" role="alert">Não conseguimos conferir seus pedidos agora. Seu rascunho foi preservado e nenhuma análise começou. Tente novamente.</p>}<Link className="quiet-link mt-4 inline-block" to="/summaries">Conferir meus sucos salvos</Link></section>}
    {!initialized?(saved.isError||usage.isError||(!usage.isPending&&!accessKnown)?<section className="activation-panel">{title('Vamos conferir seu espaço.','Não começamos nenhuma análise. Precisamos confirmar seu acesso e o ponto em que você parou.')}{error(saved.error||usage.error,'O serviço não respondeu como esperado. Seu cadastro e seus sucos salvos continuam na conta.')}<div className="flow-actions"><Button onClick={()=>{void saved.refetch();void usage.refetch();}}>Tentar novamente</Button><Button asChild variant="outline"><Link to="/account">Ver minha conta</Link></Button></div></section>:<section className="activation-panel" aria-busy="true"><h1 className="sr-only">Abrindo sua configuração</h1><div className="activation-skeleton"/><div className="activation-skeleton short"/><p className="mt-6 text-muted-foreground" role="status">Conferindo seu acesso e retomando de onde você parou…</p></section>):exhausted&&!draft.request&&!activeResult?<section className="activation-panel">{title('Seus sucos continuam aqui.','Os 3 sucos grátis desta conta já foram concluídos. Você pode reler os salvos; novas sincronizações e análises ficam pausadas até a assinatura.')}<div className="flow-actions"><Button asChild><Link to="/summaries">Ler meus sucos</Link></Button><Button asChild variant="outline"><Link to="/account">Ver minha conta</Link></Button></div></section>:<>
    {draft.stage==='welcome'&&<section className="activation-panel">
      {title('Seu primeiro suco começa com uma conversa.','Escolha o que você quer resolver. Depois conecte o WhatsApp e veja o que importa nas mensagens.')}
      <fieldset className="activation-goals"><legend>O que você quer tirar dessa conversa?</legend>{goals.map(goal=><label key={goal.id} className="activation-goal" data-selected={draft.goal===goal.id}><input type="radio" name="activation-goal" value={goal.id} checked={draft.goal===goal.id} onChange={()=>update({...draftRef.current,goal:goal.id})}/><span><strong>{goal.title}</strong><span>{goal.description}</span></span><span className="activation-choice-mark" aria-hidden="true">{draft.goal===goal.id&&<Check size={18}/>}</span></label>)}</fieldset>
      <p className="activation-outcome"><CupSoda size={20}/><span><strong>No seu primeiro suco:</strong> {chosenGoal.result}</span></p>
      <section className="activation-permission" aria-label="Sua autorização de leitura"><div className="flex items-center gap-3"><ShieldCheck size={22}/><h2>Você conecta. O Suco só lê.</h2></div><p>As conversas disponibilizadas pelo WhatsApp serão copiadas para seu espaço no serviço. Os recortes usados nas análises serão enviados à IA da Zhipu/BigModel. O Suco não envia mensagens nem marca conversas como lidas.</p><details><summary>Entender o acesso antes de autorizar<ChevronDown size={16}/></summary><p>Conectar funciona como adicionar um aparelho. Você pode revogar o acesso em Aparelhos conectados no WhatsApp. Escolher uma conversa para resumir não limita a sincronização inicial: outras conversas disponibilizadas também podem ser copiadas.</p><p>A conexão usa uma biblioteca não oficial e pode cair, pedir novo QR ou sofrer restrições pelo WhatsApp. Não garantimos recuperar todo o histórico. Não há transcrição de áudios ou leitura do conteúdo de arquivos nesta versão. As credenciais de conexão do WhatsApp não fazem parte dos pedidos à IA.</p></details>
      {consentKnown?<p className="activation-consented"><CheckCircle2 size={18}/>Sua autorização de leitura já está registrada nesta conta.</p>:<label className="consent-control"><Checkbox id="read-consent" checked={understood} onCheckedChange={value=>setUnderstood(value===true)}/><span>Sou responsável por esta conta do WhatsApp e autorizo a sincronização e o processamento descritos acima.</span></label>}</section>
      {consent.isError&&error(consent.error,'Não conseguimos registrar sua autorização. Tente novamente antes de conectar.')}
      <div className="activation-action-row"><Button size="lg" disabled={consent.isPending||(!consentKnown&&!understood)} onClick={()=>consentKnown?go(status?.connected&&!syncUnverified?'prepare':'connect'):consent.mutate()}>{consent.isPending?<Loader2 className="animate-spin"/>:null}{consentKnown?syncUnverified?'Conferir atualização do WhatsApp':status?.connected?'Escolher minha conversa':'Conectar meu WhatsApp':'Autorizar e conectar'}<ArrowRight/></Button><p>{trial?`${usage.data&&'trial'in usage.data?usage.data.trial?.remaining??0:0} de 3 sucos manuais grátis disponíveis. Sem cartão e sem cobrança automática.`:'Esta etapa não inicia uma cobrança. Você decide qual conversa resumir.'}</p></div>
    </section>}
    {draft.stage==='connect'&&<section className="activation-panel">
      {title(status?.connected?(syncUnverified?'Conexão aberta, atualização ainda não confirmada.':'Pronto. Seu WhatsApp conectou.'):reconnecting?'Vamos retomar seu zap.':'Conecte seu WhatsApp, do seu jeito.',status?.connected?(syncUnverified?'A conexão respondeu, mas ainda precisamos confirmar que as mensagens recentes estão chegando.':'As conversas chegam conforme o WhatsApp as disponibiliza. Você já pode escolher a primeira.'):'Seu número continua funcionando no celular. Esta conexão permite apenas ler e organizar as conversas.')}
      {connection.isPending?<p className="flow-loading" role="status"><Loader2 className="animate-spin" size={20}/>Conferindo sua conexão…</p>:connectionFailed?<>{error(connection.error,'Não conseguimos consultar a conexão. Não é necessário desconectar no celular.')}<Button className="mt-5" disabled={connection.isFetching} onClick={()=>connection.refetch()}>Conferir conexão</Button></>:status?.connected?<><div className={syncUnverified?'activation-sync-warning':'activation-connected'} role="status">{syncUnverified?<WifiOff size={36}/>:<CheckCircle2 size={36}/>}<div><h2>{syncUnverified?(ingestionFailing?'Mensagens aguardam gravação':'Ainda sem prova de mensagens novas'):'WhatsApp conectado'}</h2><p>{status.syncing?'Suas conversas estão chegando. A quantidade disponível pode mudar durante a sincronização.':'A conexão de rede abriu; confirme que uma mensagem nova chega antes de confiar na atualização.'}</p></div></div>{syncUnverified&&<div className="activation-sync-warning" role="status"><h2>{ingestionFailing?'A gravação de mensagens precisa se recuperar':'As mensagens recentes ainda precisam de confirmação'}</h2><p>{ingestionFailing?'Há mensagens que ainda não foram salvas. Aguarde a recuperação antes de confiar na atualização. ':''}{status.syncEvidence?.lastSavedMessageAt?`A última mensagem salva neste espaço é de ${syncDate(status.syncEvidence.lastSavedMessageAt)}.`:'Ainda não salvamos nenhuma mensagem neste espaço.'} Envie uma mensagem em um grupo seu e confira se ela aparece. Se não chegar, tente reconectar; se persistir, refaça o vínculo pelo QR.</p><div className="flex flex-wrap gap-2 mt-3"><Button type="button" variant="outline" disabled={connection.isFetching||chats.isFetching} onClick={()=>{void connection.refetch();void chats.refetch();}}>Conferir mensagens salvas</Button><Button type="button" variant="outline" disabled={reconnect.isPending} onClick={()=>reconnect.mutate()}>{reconnect.isPending?"Reconectando…":"Tentar sincronizar sem novo QR"}</Button></div>{reconnect.isSuccess&&<p role="status">Reconexão iniciada sem apagar o histórico. Aguarde a conexão responder e confira uma mensagem nova em seu grupo.</p>}{freshPairingControls}</div>}{!syncUnverified&&<details className="activation-sync-help"><summary>Minhas mensagens não estão atualizando</summary><p>Envie uma mensagem em um grupo seu e confira Conversas. Se ela não aparecer, tente reconectar sem apagar sua sessão. Se ainda falhar, use um novo QR.</p><Button type="button" variant="outline" className="mt-3" disabled={reconnect.isPending} onClick={()=>reconnect.mutate()}>{reconnect.isPending?"Reconectando…":"Tentar sincronizar sem novo QR"}</Button>{reconnect.isSuccess&&<p role="status">Reconexão iniciada sem apagar o histórico. Confira se uma mensagem nova aparece em seu grupo.</p>}{freshPairingControls}</details>}</>:<>
      <fieldset className="activation-device"><legend>Onde você está abrindo o Suco?</legend><div><label><input type="radio" name="device" checked={device==='desktop'} onChange={()=>setDevice('desktop')}/><span>No computador</span></label><label><input type="radio" name="device" checked={device==='phone'} onChange={()=>setDevice('phone')}/><span>No celular</span></label></div></fieldset>
      {device==='phone'&&!showMobileQr&&!blocked?<div className="activation-phone"><Smartphone size={32}/><h2>O celular precisa ler o QR em outra tela.</h2><p>Abra o Suco em um computador ou outro aparelho e entre na mesma conta. No seu celular, use Aparelhos conectados para ler o QR mostrado lá.</p><Button onClick={copyAddress}><Copy/>{copied?'Endereço copiado':'Copiar endereço para o outro aparelho'}</Button><p className="text-sm" role="status">{copied?'Entre com o mesmo e-mail. Copiar o endereço não conecta o WhatsApp.':copyError}</p><button className="quiet-link" type="button" onClick={()=>setShowMobileQr(true)}>Tenho outra tela. Mostrar QR aqui.</button></div>:<div className="activation-pairing"><ol className="activation-instructions"><li><span>1</span><div><strong>Abra o WhatsApp no celular.</strong><p>iPhone: Configurações. Android: menu de três pontos.</p></div></li><li><span>2</span><div><strong>Toque em Aparelhos conectados.</strong><p>Escolha Conectar um aparelho e desbloqueie o celular.</p></div></li><li><span>3</span><div><strong>Leia o QR desta tela.</strong><p>A confirmação aparece aqui quando o WhatsApp responder.</p></div></li></ol><div className="activation-qr">
      {blocked?<><Smartphone size={32}/><h2>{pairingMismatch?'Outro WhatsApp foi recusado.':pairingIdentityUnavailable?'Não conseguimos confirmar sua conta.':forbidden?'Confira sua conta no WhatsApp.':'Sua conexão precisa de atenção.'}</h2><p>{pairingMismatch?'Leia o próximo QR com o mesmo WhatsApp que já estava vinculado. Sua conta e seu histórico continuam preservados.':pairingIdentityUnavailable?'A identificação do WhatsApp anterior está indisponível. Sua sessão foi preservada; procure suporte antes de tentar outro QR.':forbidden?'O WhatsApp recusou a conexão. Uma restrição da conta não é resolvida gerando outro QR. Abra o WhatsApp no celular e siga a orientação mostrada lá.':status?.reason==='connection_replaced'?'Outra conexão substituiu esta sessão. Confira Aparelhos conectados antes de tentar novamente.':'A sessão precisa ser vinculada novamente. Confira a conta no celular antes de gerar outro QR.'}</p>{!forbidden&&!pairingIdentityUnavailable&&((status?.reason==='bad_session'||status?.reason==='multidevice_mismatch'||pairingMismatch)?freshPairingControls:<Button variant="outline" disabled={reconnect.isPending} onClick={()=>reconnect.mutate()}>Tentar reconectar</Button>)}</>:status?.qr&&!qrExpired?<><div className="qr-quiet-zone"><QRCodeSVG value={status.qr} size={240} level="M" title="QR para conectar o WhatsApp"/></div><p>{qrSeconds!==null&&Number.isFinite(qrSeconds)?`Este QR vale por mais ${qrSeconds}s.`:'Leia o QR atual desta tela.'}</p><p className="text-xs">Use apenas a câmera de Aparelhos conectados.</p></>:qrExpired?<><RefreshCw size={32}/><h2>Esse QR venceu.</h2><p>Não precisa começar de novo. Gere um QR novo e leia com o celular.</p><Button disabled={reconnect.isPending} onClick={()=>reconnect.mutate()}>Gerar novo QR</Button></>:status?.connectionState==='connecting'||status?.connectionState==='reconnecting'||connection.isPending?<><Loader2 size={32} className="animate-spin"/><h2>Esperando o WhatsApp responder.</h2><p>A conexão será confirmada quando o serviço responder. Você pode continuar depois.</p></>:<><Smartphone size={32}/><h2>Vamos preparar seu QR.</h2><p>O WhatsApp só conecta depois que você ler o código no celular.</p><Button disabled={reconnect.isPending} onClick={()=>reconnect.mutate()}>Preparar QR de conexão</Button></>}
      </div></div>}
      </>}
      {reconnect.isError&&error(reconnect.error,'Não conseguimos preparar a conexão. Seu histórico salvo foi preservado.')}
      <div className="flow-actions">{status?.connected?reconnecting?<Button size="lg" asChild><Link to="/">Voltar ao meu espaço<ArrowRight/></Link></Button>:<Button size="lg" onClick={()=>go('prepare')}>{syncUnverified?'Usar somente histórico salvo':'Escolher minha primeira conversa'}<ArrowRight/></Button>:null}{!status?.connected&&!!chats.data?.total&&<Button variant="outline" onClick={()=>go('prepare')}>Usar as conversas já sincronizadas</Button>}<Button variant="ghost" onClick={()=>go('welcome')}><ArrowLeft/>Voltar</Button></div>
      <p className="activation-help">O Suco consulta o que o WhatsApp disponibilizou. A conexão não garante todo o histórico antigo.</p>
    </section>}
    {draft.stage==='prepare'&&<section className="activation-panel">
      {title(draft.request?'Vamos conferir seu primeiro suco.':'Qual conversa merece um suco?',draft.request?'O identificador do pedido está guardado. Conferir novamente usa o mesmo pedido; não inicia outra análise.':'Escolha uma conversa e o período. Você vê a quantidade de mensagens antes de preparar.')}
      {draft.request?<div className="activation-recovery"><CupSoda size={28}/><h2>{first.isPending?'Seu suco está sendo preparado.':draft.requestState==='failed'?'O pedido anterior foi encerrado.':'Seu pedido aguarda confirmação.'}</h2><p>{first.isPending?'Não é necessário tocar de novo. Você pode sair desta tela e voltar para conferir o mesmo pedido.':draft.requestState==='failed'?'Não reiniciaremos esse pedido automaticamente. Você pode rever as escolhas para preparar um novo suco.':'A resposta pode ter se perdido ou o processamento ainda estar em andamento. Vamos consultar o mesmo pedido antes de preparar outro.'}</p><p className="text-sm">{chosenGoal.title} {draft.request?`${date(draft.request.start)} a ${date(draft.request.end)}.`:''}</p>{first.isPending&&<div className="activation-working" role="status"><Loader2 className="animate-spin" size={18}/>Aguardando o resultado do processamento…</div>}</div>:<>
      <div className="activation-chat-kind" role="group" aria-label="Mostrar conversas"><button type="button" aria-pressed={chatKind==='group'} onClick={()=>setChatKind('group')}>Grupos</button><button type="button" aria-pressed={chatKind==='all'} onClick={()=>setChatKind('all')}>Todas as conversas</button></div>
      <label className="search-label" htmlFor="activation-search">{chatKind==='group'?'Nome do grupo':'Pessoa ou grupo'}</label><div className="activation-search"><Search size={18}/><Input id="activation-search" value={search} maxLength={200} placeholder={chatKind==='group'?'Busque um grupo pelo nome':'Busque pelo nome da conversa'} onChange={event=>setSearch(event.target.value)}/></div>
      {chats.isPending?<p className="flow-loading" role="status"><Loader2 className="animate-spin" size={20}/>Buscando as conversas que já chegaram…</p>:chats.isError?<>{error(chats.error,'Não conseguimos carregar suas conversas. Sua seleção foi preservada.')}<Button className="mt-4" variant="outline" onClick={()=>chats.refetch()}>Buscar conversas novamente</Button></>:chats.data?.chats.length?<><fieldset className="activation-conversations"><legend className="sr-only">Escolha uma conversa</legend>{chats.data.chats.map(chat=><label key={chat.jid} className="activation-conversation" data-selected={draft.chatId===chat.jid}><input type="radio" name="first-chat" checked={draft.chatId===chat.jid} onChange={()=>{setSelected(chat);setAnchor(Date.now());update({...draftRef.current,chatId:chat.jid});}} disabled={chat.message_count<1}/><span><strong>{chat.name||'Conversa sem nome'}</strong><span>{chat.is_group?'Grupo · ':''}{chat.message_count.toLocaleString('pt-BR')} mensagens sincronizadas{chat.last_message_at?` · até ${date(chat.last_message_at)}`:''}{chat.message_count<1?' · aguardando mensagens':''}</span></span>{draft.chatId===chat.jid&&<Check size={18}/>}</label>)}</fieldset>{chats.data.total>chats.data.chats.length&&<p className="text-sm text-muted-foreground">Mostrando {chats.data.chats.length} de {chats.data.total}. Busque pelo nome para encontrar os demais.</p>}</>:<div className="activation-empty"><CupSoda size={30}/><h2>{search?'Não achei esse nome por aqui.':chatKind==='group'?'Os grupos ainda não apareceram.':'Suas conversas ainda estão chegando.'}</h2><p>{search?'Tente outro nome ou veja todas as conversas. A busca considera o que já foi sincronizado.':'O histórico disponível depende do WhatsApp. Não vamos gastar um suco sem mensagens para ler.'}</p><Button variant="outline" onClick={()=>search?setSearch(''):chats.refetch()}>{search?'Limpar busca':'Verificar se chegaram conversas'}</Button>{chatKind==='group'&&<Button variant="ghost" onClick={()=>setChatKind('all')}>Ver todas as conversas</Button>}{!status?.connected&&<Button variant="ghost" onClick={()=>go('connect')}>Conferir conexão</Button>}</div>}
      {draft.chatId&&<section className="activation-recap" aria-label="Confira seu primeiro suco"><h2>{selected?.name||'Sua conversa escolhida'}</h2><div className="activation-recap-fields"><div><label htmlFor="activation-goal">O que tirar da conversa</label><select id="activation-goal" value={draft.goal} onChange={event=>update({...draftRef.current,goal:event.target.value as Draft['goal']})}>{goals.map(goal=><option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></div><div><label htmlFor="activation-range">Período do seu suco</label><select id="activation-range" value={draft.range} onChange={event=>{setAnchor(Date.now());update({...draftRef.current,range:event.target.value as Draft['range']});}}><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="all">Histórico disponível da conversa</option></select></div></div>
      {stats.isPending?<p className="activation-count" role="status">Conferindo as mensagens deste período…</p>:stats.isError?<div className="activation-count" role="alert"><p>Não conseguimos conferir o período. Nenhuma análise começou.</p><Button variant="ghost" onClick={()=>stats.refetch()}>Conferir período novamente</Button></div>:<p className="activation-count" role="status">{stats.data.count.toLocaleString('pt-BR')} mensagens neste período.{windowRange?` ${date(windowRange.start)} a ${date(windowRange.end)}.`:''}</p>}
      {stats.isSuccess&&stats.data.count===0&&<div className="activation-empty-period"><p>Não há mensagens nesse período. Amplie o recorte para encontrar algo que já chegou.</p><Button variant="outline" onClick={()=>update({...draftRef.current,range:'all'})}>Usar o histórico disponível</Button></div>}
      <p className="text-xs leading-relaxed text-muted-foreground">Escolher esta conversa define apenas o resumo. Outras conversas disponibilizadas também podem ter sido sincronizadas.</p></section>}
      </>}
      {(first.isError||localError)&&<div className="activation-error" role="alert"><WifiOff size={20}/><div><h2>{localError?'Vamos conferir antes de continuar.':'Ainda não temos o resultado confirmado.'}</h2><p>{localError||displayError(first.error,'Não conseguimos confirmar o resultado. Use Conferir o mesmo pedido para evitar outra análise.')}</p></div></div>}
      {storageProblem&&<p className="activation-storage" role="status">{storageProblem==='corrupt'?'O rascunho salvo não pôde ser lido. Confira seus sucos antes de iniciar outro pedido.':'O navegador não conseguiu guardar a retomada. Você pode tentar novamente após permitir o armazenamento deste site.'}</p>}
      {usage.isError&&<div className="activation-storage" role="status"><p>Não conseguimos conferir seu acesso agora. Nenhuma nova análise será iniciada.</p><Button variant="ghost" onClick={()=>usage.refetch()}>Conferir acesso novamente</Button></div>}
      {busyTrial&&!draft.request&&<p className="activation-storage" role="status">Seus sucos disponíveis estão em processamento ou confirmação. Confira os salvos antes de começar outro.</p>}
      <div className="activation-action-row">{draft.requestState==='failed'?<Button onClick={()=>{first.reset();update({...draftRef.current,request:null,requestState:null});}}>Rever minhas escolhas</Button>:<Button size="lg" disabled={first.isPending||!accessKnown||usage.isError||(!draft.request&&(exhausted||busyTrial||!draft.chatId||!windowRange||!stats.isSuccess||stats.data.count<1))} onClick={generate}>{first.isPending?<Loader2 className="animate-spin"/>:<CupSoda/>}{first.isPending?'Preparando seu suco…':firstLabel}</Button>}<p>{draft.request?'Você pode sair. Seu pedido está guardado para retomar nesta conta.':trial?'1 resumo concluído usa 1 dos seus 3 sucos grátis. Pedidos ainda em confirmação ficam separados.':'Este é um resumo manual. A conversa só terá sucos automáticos se você escolher isso depois.'}</p></div>
      <div className="activation-bottom-links">{!locked&&<Button variant="ghost" onClick={()=>go('connect')}><ArrowLeft/>Voltar à conexão</Button>}<Link className="quiet-link" to="/summaries">Conferir meus sucos salvos</Link></div>
    </section>}
    {draft.stage==='done'&&<section className="activation-panel">
      {title('Agora você tem o suco.','Seu primeiro resumo está salvo. Leia o que importa e confira valores, prazos e decisões nas conversas de origem.')}
      {activeResult?<><div className="activation-success"><CheckCircle2 size={24}/><span>Salvo em Meus sucos. Você pode voltar quando quiser.</span></div><article className="activation-result"><p>{activeResult.chat_name||selected?.name||'Sua conversa'} · {date(activeResult.period_start)} a {date(activeResult.period_end)}</p><SummaryMarkdown content={activeResult.content}/></article><div className="flow-actions"><Button size="lg" asChild><Link to="/summaries">Ir para Meus sucos<ArrowRight/></Link></Button><Button variant="outline" asChild><Link to="/conversations">Conferir nas conversas</Link></Button></div>
      {advanced&&<section className="activation-follow"><h2>Quer o próximo suco sem pedir?</h2><p>Você pode acompanhar esta conversa para gerar resumos automáticos. Isso usa sua cota de análises e uma das vagas de conversas acompanhadas.</p>{tracking.isSuccess||chats.data?.chats.some(chat=>chat.jid===activeResult.chat_jid&&chat.tracked)?<p className="activation-consented" role="status"><CheckCircle2 size={18}/>Esta conversa está acompanhada. Você pode ajustar em Conversas.</p>:<><label className="consent-control"><Checkbox checked={automate} onCheckedChange={value=>setAutomate(value===true)}/><span>Quero ativar os sucos automáticos desta conversa.</span></label><Button variant="outline" disabled={!automate||tracking.isPending} onClick={()=>tracking.mutate()}>{tracking.isPending?'Ativando…':'Ativar acompanhamento'}</Button>{tracking.isError&&error(tracking.error,'Não conseguimos ativar o acompanhamento. Seu primeiro suco continua salvo.')}</>}</section>}
      </>:resumed.isPending?<p className="flow-loading" role="status"><Loader2 className="animate-spin"/>Buscando o suco que já ficou salvo…</p>:<>{error(resumed.error,'Não conseguimos abrir seu resumo agora. Isso não inicia outra análise.')}<div className="flow-actions"><Button onClick={()=>resumed.refetch()}>Abrir resumo novamente</Button><Button asChild variant="outline"><Link to="/summaries">Conferir Meus sucos</Link></Button></div></>}
    </section>}
    </>}
    <footer className="activation-footer"><span><ShieldCheck size={16}/>Somente leitura. A conversa continua sua.</span><Link to="/guide" className="quiet-link">Como o Suco funciona</Link></footer>
  </div></main>;
}
