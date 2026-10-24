import { useQuery } from '@tanstack/react-query';
import { api, getApiUrl, MANAGED_SESSION_KEY } from '@/lib/api';

function connectionScope(): [string, string] {
  try {
    const origin = getApiUrl();
    const raw = localStorage.getItem(MANAGED_SESSION_KEY);
    const tenantId = raw ? JSON.parse(raw)?.tenantId : null;
    return [origin, typeof tenantId === 'string' ? tenantId : 'legacy'];
  } catch {
    // A malformed or unavailable local store should produce the API's normal
    // recoverable query error, not crash the page while building its key.
    return ['invalid-origin', 'unknown'];
  }
}

export function useConnection() {
  const [origin, tenantId] = connectionScope();
  return useQuery({ queryKey: ['status', origin, tenantId], queryFn: api.status, refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 1500, retry: false });
}
