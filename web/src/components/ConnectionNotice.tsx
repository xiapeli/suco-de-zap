import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link, useLocation } from 'react-router-dom';
import { AlertCircle, RefreshCw, Smartphone } from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { connectionView } from '@/lib/connection';
import { Button } from '@/components/ui/button';

export function ConnectionNotice() {
  const { data, isError, isPending, refetch, isFetching } = useConnection();
  const location = useLocation();
  const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, retry: false });
  if (usage.data && 'access' in usage.data && usage.data.access === 'trial_exhausted') return null;
  const view = connectionView(data, isError);
  if (isPending || (!isError && data?.connected && view.state !== 'sync_unverified') || location.pathname === '/onboarding') return null;
  return <section aria-label="Conexão do WhatsApp" className="connection-notice" data-state={view.state}>
    <div className="flex min-w-0 items-start gap-3" role="status" aria-live="polite">
      {view.state === 'reconnecting' ? <RefreshCw className="h-5 w-5 shrink-0" /> : <AlertCircle className="h-5 w-5 shrink-0" />}
      <div><p className="font-semibold">{view.title}</p><p className="mt-1 text-sm">{view.description}</p></div>
    </div>
    {isError ? <Button variant="outline" disabled={isFetching} onClick={() => refetch()}>{view.action}</Button> : <Button asChild variant="outline"><Link to="/onboarding?reconnect=1"><Smartphone className="mr-2 h-4 w-4" />{view.action}</Link></Button>}
  </section>;
}
