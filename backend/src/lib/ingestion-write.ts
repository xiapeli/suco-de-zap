/** A write can be retried only when its SQL is idempotent. */
export function retryableIngestionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code.startsWith('08') || new Set([
    '40001', // serialization failure
    '40P01', // deadlock
    '55P03', // lock not available
    '53300', // too many connections
    '57P01', '57P02', '57P03', // server shutting down / unavailable
    'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  ]).has(code);
}

export async function retryIngestionWrite<T>(
  write: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  const delays = [75, 200, 500];
  for (const delay of delays) {
    try {
      return await write();
    } catch (error) {
      if (!retryableIngestionError(error)) throw error;
      await wait(delay);
    }
  }
  return write();
}
