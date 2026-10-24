/** An exact account allowlist keeps one user's channel away from another VM.
 *  The deployer pins each account ID together with its worker URL and digest. */
export function workerTargetForAccount(accountId: string, env: Record<string, unknown>): { url: string; digest: string } | null {
  const target = accountId === env.VITE_SUCO_OWNER_WORKER_ID
    ? { url: env.VITE_SUCO_OWNER_WORKER_URL, digest: env.VITE_SUCO_OWNER_WORKER_DIGEST }
    : accountId === env.VITE_SUCO_PARTNER_WORKER_ID
      ? { url: env.VITE_SUCO_PARTNER_WORKER_URL, digest: env.VITE_SUCO_PARTNER_WORKER_DIGEST }
      : null;
  if (typeof target?.url !== 'string' || typeof target.digest !== 'string') return null;
  try {
    const url = new URL(target.url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      /^sha256:[0-9a-f]{64}$/.test(target.digest) ? { url: target.url, digest: target.digest } : null;
  } catch { return null; }
}
