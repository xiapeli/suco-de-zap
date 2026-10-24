import { useQuery } from '@tanstack/react-query';
import { api, getApiUrl } from '@/lib/api';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CupSoda, Users, Heart, Handshake, Calendar, Briefcase, Lightbulb, Target, ShieldCheck, FileCheck, Calculator, Wallet, MessageSquare } from 'lucide-react';
import { juiceGroups, juicesInGroup, customJuice, personalJuiceType, type JuiceGroup, type JuiceType } from '@/lib/juice-types';
const icons:Record<string,typeof CupSoda>={general:CupSoda,discussion:MessageSquare,meeting:Calendar,project:Briefcase,negotiation:Handshake,relationship:Heart,ideation:Lightbulb,alignment:Target,hr_performance:Users,hr_climate:Users,hr_conflicts:Users,hr_onboarding:Users,accounting_financial:Wallet,accounting_compliance:ShieldCheck,accounting_contracts:FileCheck,accounting_audit:Calculator,accounting_investments:Wallet,custom:MessageSquare};
export function JuiceCatalog({request='',onSelect,preferredId,disabled=false,compact=false}:{request?:string;onSelect?:(type:JuiceType)=>void;preferredId?:string;disabled?:boolean;compact?:boolean}) {
 const [group,setGroup]=useState<JuiceGroup>(()=>preferredId?.startsWith('hr_')?'hr':preferredId==='relationship'?'relationship':preferredId?.startsWith('accounting_')?'accounting':'everyday');
 const types=juicesInGroup(group);
 const item=(type:JuiceType)=>{const Icon=icons[type.id]||CupSoda;const content=<><Icon size={21} aria-hidden="true"/><span><strong>{type.title}</strong><small>{type.description}</small></span><ArrowUpRight size={17} aria-hidden="true"/></>;
 return <li key={type.id}>{onSelect?<button type="button" className="suco-juice-choice" disabled={disabled} onClick={()=>onSelect(type)}>{content}</button>:<Link className="suco-juice-choice" to={`/conversations?suco=${type.id}`} state={{sucoRequest:request}}>{content}</Link>}</li>;};
 return <section className="suco-juice-catalog" data-compact={compact} aria-labelledby={compact?'choose-juice-title':'home-juice-title'}>
  <header><h2 id={compact?'choose-juice-title':'home-juice-title'}>{compact?'Qual suco combina com esse papo?':'Escolhe o sabor do papo.'}</h2><p>17 jeitos de tirar o que interessa. Do grupo do trabalho à conversa a dois.</p></header>
  <div className="suco-juice-groups" role="group" aria-label="Temas de suco">{juiceGroups.map(item=><button type="button" key={item.id} aria-pressed={group===item.id} onClick={()=>setGroup(item.id)}>{item.label}</button>)}</div>
  <p role="status" className="suco-juice-count">{types.length} {types.length===1?'modelo':'modelos'} · {juiceGroups.find(item=>item.id===group)?.label.replace(' (17)','')}</p>
  <ul className="suco-juice-options">{types.map(item)}</ul>
  <ul className="suco-juice-custom">{item(customJuice)}</ul>
  <PersonalTypes onSelect={onSelect} disabled={disabled} request={request}/>
  {!onSelect&&<p className="suco-juice-note">Escolher um tema só prepara o pedido. Você confere a conversa, o período e o foco antes de gerar.</p>}
 </section>;
}

function PersonalTypes({onSelect,disabled,request}:{onSelect?:(type:JuiceType)=>void;disabled:boolean;request:string}) {
 const types=useQuery({queryKey:['personal-juices',getApiUrl()],queryFn:api.personalJuices,retry:false});
 return <div className="suco-personal-home">
  <header><div><h3>Meus tipos de suco</h3><p>Tem papo que se repete. Salve o seu jeito de organizar.</p></div><Link to="/my-juices/new" className="suco-personal-new">+ Criar tipo de suco</Link></header>
  {types.isPending&&<p role="status">Carregando seus tipos…</p>}
  {types.isError&&<p role="alert">Seus tipos não carregaram. <button type="button" onClick={()=>types.refetch()}>Tentar novamente</button></p>}
  {types.isSuccess&&types.data.types.length===0&&<p className="suco-personal-empty">Do acompanhamento de clientes aos combinados de casa: dê um nome, conte o que procurar e use sempre que quiser.</p>}
  {types.data&&<ul className="suco-juice-options">{types.data.types.slice(0,4).map(model=>{
   const type=personalJuiceType(model),content=<><CupSoda size={21} aria-hidden="true"/><span><strong>{type.title}</strong><small>{model.category}</small></span><ArrowUpRight size={17} aria-hidden="true"/></>;
   return <li key={model.id}>{onSelect?<button type="button" className="suco-juice-choice" disabled={disabled} onClick={()=>onSelect(type)}>{content}</button>:<Link className="suco-juice-choice" to={`/conversations?suco=${type.id}`} state={{sucoRequest:request}}>{content}</Link>}</li>;
  })}</ul>}
  {!!types.data?.types.length&&<Link to="/my-juices" className="suco-personal-manage">Gerenciar meus tipos ({types.data.types.length}) <ArrowUpRight size={15} aria-hidden="true"/></Link>}
 </div>;
}
