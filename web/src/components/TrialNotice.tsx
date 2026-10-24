import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function TrialNotice() {
  const { data } = useQuery({ queryKey: ['usage'], queryFn: api.usage, retry: false, refetchInterval: 15_000 });
  if (!data || !('access' in data)) return null;
  if (data.access === 'owner') return <div className="suco-trial" data-owner="true" role="status">Seu Suco, por conta da casa. Acesso de proprietário.</div>;
  if (!['trial', 'trial_exhausted'].includes(data.access || '') || !data.trial) return null;
  const { trial } = data;
  const exhausted = data.access === 'trial_exhausted';
  return <section className="suco-trial" aria-label="Seu teste gratuito">
    <div role="status"><p className="font-semibold">{exhausted ? 'Seus sucos grátis foram concluídos.' : `${trial.remaining} de ${trial.limit} sucos grátis disponíveis.`}</p><p className="mt-1">{exhausted ? 'Seus resumos salvos continuam disponíveis. Novas sincronizações e análises ficam pausadas até a assinatura.' : 'O teste inclui resumos manuais. Só os sucos concluídos usam sua cota; ela não renova todo mês.'}</p>{trial.reserved > 0 && <p className="mt-1">{trial.reserved} pedido(s) em processamento ou confirmação.</p>}</div>
    <Button asChild variant="outline"><Link to="/account">{exhausted ? 'Conhecer a assinatura' : 'Minha conta'}</Link></Button>
  </section>;
}
