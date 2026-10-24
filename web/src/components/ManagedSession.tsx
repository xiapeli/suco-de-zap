import { useEffect } from 'react';
import { useAction, useConvexAuth } from 'convex/react';
import { anyApi } from 'convex/server';
import { useAuth } from '@/hooks/useAuth';
import { getApiUrl, getToken, MANAGED_SESSION_KEY, registerSessionResolver, setToken } from '@/lib/api';
import { useCloudEnabled } from './CloudProvider';

function NativeManagedSession() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const tenantAccess = useAction(anyApi.accounts.tenantAccess);
  const { logout } = useAuth();
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated && localStorage.getItem(MANAGED_SESSION_KEY)) { logout(); return; }
    let flight: Promise<string | null> | null = null;
    let mounted = true;
    registerSessionResolver(async () => {
      const raw = localStorage.getItem(MANAGED_SESSION_KEY);
      if (!raw) return getToken();
      if (!isAuthenticated) throw new Error('Entre novamente na sua conta para continuar.');
      let meta;
      try { meta = JSON.parse(raw); } catch { throw new Error('Sua sessão precisa ser renovada. Entre novamente.'); }
      if (meta.expiresAt > Date.now() + 30_000) return getToken();
      if (!flight) flight = tenantAccess({scope:'read'}).then((next: any) => {
        if (!mounted || localStorage.getItem(MANAGED_SESSION_KEY) !== raw || next.tenantId !== meta.tenantId || next.apiUrl !== getApiUrl()) throw new Error('Seu espaço mudou. Abra a página da conta para reconectar com segurança.');
        setToken(next.accessToken); localStorage.setItem(MANAGED_SESSION_KEY, JSON.stringify({tenantId:next.tenantId,expiresAt:next.expiresAt})); return next.accessToken;
      }).catch(() => { throw new Error('Não conseguimos renovar seu acesso. Confira a assinatura na página da conta.'); }).finally(() => { flight = null; });
      return flight;
    });
    return () => { mounted = false; registerSessionResolver(null); };
  }, [isAuthenticated, isLoading, logout, tenantAccess]);
  return null;
}
export function ManagedSession() { return useCloudEnabled() ? <NativeManagedSession /> : null; }
