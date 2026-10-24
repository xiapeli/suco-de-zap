import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getVaultSnapshot, subscribeVault } from '@/lib/api';

export function VaultCacheGuard() {
  const client = useQueryClient();
  useEffect(() => subscribeVault(() => {
    if (getVaultSnapshot().unlocked) return;
    const privateKey = (key: readonly unknown[]) => ['facts','fact-tags','extraction-settings','vault-search','vault-extract','vault-delete'].includes(String(key[0]));
    void client.cancelQueries({predicate:query => privateKey(query.queryKey)});
    client.removeQueries({predicate:query => privateKey(query.queryKey)});
    client.getMutationCache().getAll().filter(mutation => privateKey(mutation.options.mutationKey || [])).forEach(mutation => client.getMutationCache().remove(mutation));
  }), [client]);
  return null;
}
