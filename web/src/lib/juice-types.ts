import { juiceCatalog, JUICE_CATALOG_VERSION } from './juice-catalog.ts';
import { controlMode } from './suco-env.ts';
export { JUICE_CATALOG_VERSION };
export type JuiceCategory = 'popular' | 'business' | 'relationship' | 'productivity' | 'hr' | 'accounting' | 'personal';
export interface JuiceType {
  id: string; title: string; description: string; legacyTitle: string;
  icon: string; category: JuiceCategory; popular: boolean; focusPlaceholder: string;
  personalRevision?: string;
}
export const juiceTypes: readonly JuiceType[] = juiceCatalog;
export const customJuice: JuiceType = { id:'custom',title:'Suco do meu jeito',description:'Você conta o que quer entender. O Suco organiza o que encontrar.',legacyTitle:'Pedido personalizado',icon:'MessageSquare',category:'productivity',popular:false,focusPlaceholder:'Ex.: junte os combinados sobre a viagem e o que falta decidir.' };
export type JuiceGroup = 'everyday' | 'work' | 'hr' | 'relationship' | 'accounting' | 'all';
export const juiceGroups: readonly {id:JuiceGroup;label:string}[] = [{id:'everyday',label:'Dia a dia'},{id:'work',label:'Trabalho'},{id:'hr',label:'RH'},{id:'relationship',label:'Relacionamento'},{id:'accounting',label:'Finanças'},{id:'all',label:'Todos (17)'}];
const everyday = new Set(['general','meeting','project','negotiation','accounting_financial','ideation','alignment','discussion']);
export function juicesInGroup(group: JuiceGroup): readonly JuiceType[] {
  if(group==='all')return juiceTypes;
  if(group==='everyday')return juiceTypes.filter(type=>everyday.has(type.id));
  if(group==='work')return juiceTypes.filter(type=>['business','productivity'].includes(type.category));
  return juiceTypes.filter(type=>type.category===group);
}
export function requestedJuice(id:string|null): JuiceType|undefined { return id==='custom'?customJuice:juiceTypes.find(type=>type.id===id); }
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function personalJuiceId(value:string|null):string|null { const id=value?.startsWith('personal:')?value.slice(9):'';return uuidPattern.test(id)?id:null; }
export function personalJuiceType(value:{id:string;revision_id:string;name:string;instructions_preview?:string;instructions?:string}):JuiceType {
  return {id:`personal:${value.id}`,personalRevision:value.revision_id,title:value.name,legacyTitle:value.name,
    description:value.instructions_preview||value.instructions?.slice(0,160)||'Seu tipo de suco, com as instruções que você salvou.',icon:'CupSoda',category:'personal',popular:false,
    focusPlaceholder:'Algum detalhe só para este suco? Ex.: apenas o projeto Aurora.'};
}
export function generationRequest(type:JuiceType,detail:string) {
  const value=detail.trim(),custom=type.id==='custom';
  if(custom&&!value)throw Error('Conte o que você quer tirar da conversa.');
  if(value.length>(custom?10000:2000))throw Error(custom?'Use um pedido de até 10.000 caracteres.':'Use um detalhe de até 2.000 caracteres.');
  const validPersonalRevision = controlMode() === 'supabase'
    ? /^[1-9][0-9]{0,18}$/.test(type.personalRevision || '')
    : uuidPattern.test(type.personalRevision || '');
  if(type.id.startsWith('personal:')&&(!personalJuiceId(type.id)||!validPersonalRevision))throw Error('Carregue seu tipo de suco novamente antes de gerar.');
  return { analysis_type:type.id,template_version:JUICE_CATALOG_VERSION,...(type.personalRevision?{personal_revision:type.personalRevision}:{}),...(custom?{base_prompt:value}:value?{focus:value}:{}) };
}
