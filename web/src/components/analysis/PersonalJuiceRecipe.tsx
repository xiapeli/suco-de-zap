import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, getApiUrl } from '@/lib/api';
import { juiceTypes, personalJuiceId, type JuiceType } from '@/lib/juice-types';

export function PersonalJuiceRecipe({type}:{type:JuiceType}) {
  const [open,setOpen]=useState(false);
  const id=personalJuiceId(type.id);
  const recipe=useQuery({queryKey:['personal-juice-revision',getApiUrl(),id,type.personalRevision],
    queryFn:()=>api.personalJuice(id!,type.personalRevision),enabled:open&&!!id&&!!type.personalRevision,retry:false});
  if(!id)return null;
  return <details className="suco-personal-recipe" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Conferir receita completa</summary>
    {recipe.isPending&&<p role="status">Carregando as instruções desse pedido…</p>}
    {recipe.isError&&<p role="alert">Não conseguimos carregar as instruções. <button type="button" onClick={()=>recipe.refetch()}>Tentar novamente</button></p>}
    {recipe.data&&<><p><strong>Base: </strong>{juiceTypes.find(item=>item.id===recipe.data.type.base_type)?.title||'Meu próprio pedido'}</p><p className="suco-personal-recipe-text">{recipe.data.type.instructions}</p></>}
  </details>;
}
