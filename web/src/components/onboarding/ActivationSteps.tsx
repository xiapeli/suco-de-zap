import { Check } from 'lucide-react';
const labels=['Sua conta','Conectar o zap','Primeiro suco','Pronto'];
export function ActivationSteps({current}:{current:0|1|2|3}) {
  return <ol className="activation-steps" aria-label="Seu caminho até o primeiro suco">{labels.map((label,index)=><li key={label} data-state={index<current?'complete':index===current?'current':'upcoming'} aria-current={index===current?'step':undefined}><span className="activation-step-marker" aria-hidden="true">{index<current?<Check size={15}/>:index+1}</span><span>{label}</span></li>)}</ol>;
}
