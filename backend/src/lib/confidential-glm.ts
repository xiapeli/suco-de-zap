import { randomUUID } from 'node:crypto';
import { GlmRuntime } from '../cloud-glm/client.js';
import { RuntimeError, type Ledger, type Limits, type Usage } from '../cloud-glm/ledger.js';

// The GLM key lives in the deployer's own Secret Manager; the resource path is
// supplied via env so this repo never points at any specific GCP project.
const SECRET_RESOURCE_PATTERN = /^projects\/[a-z0-9-]+\/secrets\/[a-z0-9-]+\/versions\/(latest|[0-9]+)$/;
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Only concurrency lives in memory. The encrypted summary job is persisted before an AI call. */
class PrivateLedger implements Ledger {
  private pending = new Set<string>();
  async reserve(_accountId: string, _requestId: string, limits: Limits): Promise<string> {
    if (this.pending.size >= limits.globalConcurrency) throw new RuntimeError('PROCESSING_BUSY', 429);
    const id = randomUUID();
    this.pending.add(id);
    return id;
  }
  async settle(id: string, _state: 'committed' | 'released' | 'unknown', _outcome: string,
    _usage?: Usage): Promise<void> { this.pending.delete(id); }
}

/** TEE-only provider key from Secret Manager; shared by the chat runtime and ASR. */
export function createConfidentialKeyProvider(fetcher: typeof fetch = fetch): () => Promise<string> {
  let cachedKey: string | null = null;
  let fetchingKey: Promise<string> | null = null;
  return async function keyProvider(): Promise<string> {
    if (cachedKey) return cachedKey;
    if (fetchingKey) return fetchingKey;
    fetchingKey = (async () => {
      const tokenResponse = await fetcher(TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000),
      });
      if (!tokenResponse.ok) throw Error('CONFIDENTIAL_PROVIDER_SECRET');
      const tokenData = await tokenResponse.json() as { access_token?: unknown };
      const token = tokenData.access_token;
      if (typeof token !== 'string' || token.length < 50 || token.length > 4096)
        throw Error('CONFIDENTIAL_PROVIDER_SECRET');
      const resource = process.env.SUCO_GLM_SECRET_RESOURCE ?? '';
      if (!SECRET_RESOURCE_PATTERN.test(resource)) throw Error('CONFIDENTIAL_PROVIDER_SECRET');
      const secretResponse = await fetcher(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!secretResponse.ok) throw Error('CONFIDENTIAL_PROVIDER_SECRET');
      const secretData = await secretResponse.json() as { payload?: { data?: unknown } };
      const encoded = secretData.payload?.data;
      if (typeof encoded !== 'string' || encoded.length > 1024 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('CONFIDENTIAL_PROVIDER_SECRET');
      const key = Buffer.from(encoded, 'base64').toString('utf8').trim();
      if (!/^[A-Za-z0-9._-]{20,512}$/.test(key)) throw Error('CONFIDENTIAL_PROVIDER_SECRET');
      cachedKey = key;
      return key;
    })();
    try { return await fetchingKey; }
    finally { fetchingKey = null; }
  };
}

export function createConfidentialGlm(ownerId: string, fetcher: typeof fetch = fetch) {
  const keyProvider = createConfidentialKeyProvider(fetcher);
  const runtime = new GlmRuntime({
    keyProvider, ledger: new PrivateLedger(), timeoutMs: 90_000, fetch: fetcher,
    limits: { monthly: 100_000, daily: 100_000, accountConcurrency: 1, globalConcurrency: 1 },
    unmetered: () => true, estimatePublishedCny: true,
  });
  return {
    async summarize(requestId: string, transcript: string, instruction: string) {
      const result = await runtime.call(ownerId, requestId, transcript,
        { task: 'summary', instruction, maxTokens: 4096 });
      return { content: result.content, model: result.model };
    },
  };
}

export type ConfidentialGlm = ReturnType<typeof createConfidentialGlm>;
