import { ApiError, clearPrivateTransport, registerPrivateTransport,
  type DiscoveryResponse, type PersonalJuice, type PersonalJuiceMetadata,
  type SavePersonalJuice, type Summary, type OnboardingState } from './api';
import { ConfidentialApiError, confidentialErrorText, type PrivatePersonalType } from './confidential-api';
import type { ConfidentialChannel } from './confidential-channel';
import { getSucoSupabase } from './supabase';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Options = { method?: string; body?: unknown };
type Reply = { status: number; body: Record<string, unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pause = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

function legacyType(value: PrivatePersonalType): PersonalJuice & PersonalJuiceMetadata {
  return { ...value, revision_id: String(value.revision),
    instructions_preview: value.instructions.slice(0, 160), archived: false };
}

/** Only the measured worker receives private product requests. No legacy fetch fallback. */
export function installPrivateLegacyBridge(channel: ConfidentialChannel, accountId: string,
  entitlement: string): () => void {
  const scope = `https://private-${accountId}.sucodezap.xyz`;
  let active = true;
  let summaryCache: { expiresAt: number; items: Summary[] } | null = null;
  let summaryFlight: Promise<Summary[]> | null = null;
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!active) throw new ApiError(503, 'Sua conexão privada foi encerrada.', 'CONFIDENTIAL_CHANNEL_CLOSED');
    const reply = await channel.rpc<unknown>(method, path, body && typeof body === 'object' ? body as object : undefined) as Reply;
    if (!reply || typeof reply.status !== 'number' || !reply.body || typeof reply.body !== 'object')
      throw new ApiError(502, 'O processamento privado respondeu de forma inválida.', 'PRIVATE_RESPONSE_INVALID');
    if (reply.status < 200 || reply.status >= 300) {
      const code = typeof reply.body.code === 'string' ? reply.body.code : 'PRIVATE_REQUEST_FAILED';
      throw new ApiError(reply.status, confidentialErrorText(new ConfidentialApiError(reply.status, code)), code);
    }
    return reply.body;
  }
  async function allSummaries(): Promise<Summary[]> {
    if (summaryCache && summaryCache.expiresAt > Date.now()) return summaryCache.items;
    if (summaryFlight) return summaryFlight;
    summaryFlight = (async () => {
      const results: Summary[] = [];
      for (let offset = 0; offset < 100_000; offset += 200) {
        const page = await call('GET', `/api/summaries?limit=200&offset=${offset}`);
        const batch = page.summaries;
        if (!Array.isArray(batch) || batch.length > 200 ||
            (page.total !== undefined && (typeof page.total !== 'number' ||
              !Number.isSafeInteger(page.total) || page.total < 0)))
          throw new ApiError(502, 'A biblioteca respondeu de forma inválida.', 'PRIVATE_RESPONSE_INVALID');
        results.push(...batch as Summary[]);
        if (results.length >= Number(page.total ?? Infinity) || batch.length < 200) {
          summaryCache = { expiresAt: Date.now() + 15_000, items: results };
          return results;
        }
      }
      throw new ApiError(503, 'Sua biblioteca é grande demais para esta busca. Tente novamente.', 'PRIVATE_SUMMARY_LIST_LIMIT');
    })().finally(() => { summaryFlight = null; });
    return summaryFlight;
  }
  async function awaitSummary(id: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 180_000;
    while (active && Date.now() < deadline) {
      const reply = await call('GET', `/api/summaries/${encodeURIComponent(id)}`);
      if (reply.summary) return { summary: reply.summary };
      await pause(1_500);
    }
    throw new ApiError(503, 'A geração ainda não foi confirmada. Retome o mesmo pedido.', 'PRIVATE_SUMMARY_PENDING');
  }
  async function privateConsent(accept: boolean): Promise<OnboardingState> {
    const client = getSucoSupabase();
    if (!client) throw new ApiError(503, 'Sua conta não está disponível.', 'PRIVATE_ACCOUNT_UNAVAILABLE');
    const session = (await client.auth.getSession()).data.session;
    if (!session || session.user.id !== accountId)
      throw new ApiError(401, 'Entre novamente na sua conta.', 'PRIVATE_ACCOUNT_UNAVAILABLE');
    const result = accept
      ? await client.rpc('suco_consent_accept', { p_version: 'readonly-2026-10-15' })
      : await client.rpc('suco_consent_status');
    if (result.error || !result.data || typeof result.data !== 'object')
      throw new ApiError(503, 'Não conseguimos conferir seu consentimento.', 'PRIVATE_CONSENT_UNAVAILABLE');
    const raw = (result.data as { consent?: unknown }).consent;
    const consent = raw === null ? null : raw && typeof raw === 'object' &&
      typeof (raw as { version?: unknown }).version === 'string' &&
      typeof (raw as { acceptedAt?: unknown }).acceptedAt === 'string'
        ? raw as OnboardingState['consent'] : undefined;
    if (consent === undefined) throw new ApiError(502, 'Resposta de consentimento inválida.', 'PRIVATE_RESPONSE_INVALID');
    const firstSummary = (await allSummaries())[0] ?? null;
    return { consent, firstSummary };
  }
  const transport = { scope, async request(path: string, options: Options): Promise<unknown> {
    const method = (options.method ?? 'GET') as Method;
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method) || !path.startsWith('/api/'))
      throw new ApiError(400, 'Requisição privada inválida.', 'PRIVATE_REQUEST_INVALID');
    const url = new URL(path, scope);
    if (url.origin !== scope || url.pathname.includes('..'))
      throw new ApiError(400, 'Requisição privada inválida.', 'PRIVATE_REQUEST_INVALID');
    const body = options.body;

    if (method === 'GET' && url.pathname === '/api/usage' &&
        ['owner', 'partner_full'].includes(entitlement))
      return { available: false, access: 'owner' };
    if (method === 'GET' && url.pathname === '/api/onboarding') return privateConsent(false);
    if (method === 'POST' && url.pathname === '/api/onboarding/consent') {
      const input = body as { accepted?: unknown; version?: unknown } | undefined;
      if (input?.accepted !== true || input.version !== 'readonly-2026-10-15')
        throw new ApiError(400, 'Confira o consentimento.', 'PRIVATE_CONSENT_INPUT');
      return privateConsent(true);
    }

    if (method === 'POST' && url.pathname === '/api/summaries/generate') {
      const request = body as { request_id?: string } | undefined;
      if (!request?.request_id || !UUID.test(request.request_id))
        throw new ApiError(400, 'Pedido de suco inválido.', 'PRIVATE_SUMMARY_INPUT');
      const reply = await call('POST', url.pathname, body);
      summaryCache = null;
      return reply.summary ? reply : await awaitSummary(request.request_id);
    }
    if (method === 'POST' && url.pathname === '/api/discover') {
      const query = String((body as { query?: unknown })?.query ?? '').trim().toLocaleLowerCase('pt-BR');
      const offset = Math.max(0, Math.min(1000, Number((body as { offset?: unknown })?.offset ?? 0)));
      if (!query || query.length > 500) throw new ApiError(400, 'Confira a busca.', 'DISCOVERY_INPUT');
      const summaries = await allSummaries();
      const hits = summaries.filter(item => [item.title, item.chat_name, item.content]
        .some(value => (value ?? '').toLocaleLowerCase('pt-BR').includes(query)));
      return { results: hits.slice(offset, offset + 20).map(({ content, auto: _auto, model: _model, ...item }) =>
        ({ ...item, excerpt: content.slice(0, 260) })), total: hits.length, saved: summaries.length,
        nextOffset: offset + 20 < hits.length ? offset + 20 : null,
        scope: 'saved_summaries', generated: false } satisfies DiscoveryResponse;
    }
    if (method === 'GET' && url.pathname === '/api/summaries' && url.searchParams.has('chat_jid')) {
      const chat = url.searchParams.get('chat_jid');
      const matches = (await allSummaries()).filter(item => item.chat_jid === chat);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      return { summaries: matches.slice(offset, offset + limit), total: matches.length };
    }
    if (method === 'GET' && url.pathname === '/api/personal-juices') {
      const reply = await call('GET', '/api/private/personal-juices');
      return { types: (reply.types as PrivatePersonalType[] ?? []).map(legacyType) satisfies PersonalJuiceMetadata[] };
    }
    const personal = /^\/api\/personal-juices\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (personal && method === 'GET') {
      const reply = await call('GET', '/api/private/personal-juices');
      const item = (reply.types as PrivatePersonalType[] ?? []).find(type => type.id === personal[1]);
      if (!item) throw new ApiError(404, 'Esse tipo de suco não foi encontrado.', 'PRIVATE_PERSONAL_NOT_FOUND');
      const revision = url.searchParams.get('revision');
      if (revision && revision !== String(item.revision))
        throw new ApiError(409, 'Esse tipo foi atualizado. Abra a versão atual.', 'PRIVATE_PERSONAL_CHANGED');
      return { type: legacyType(item) };
    }
    if ((method === 'POST' && url.pathname === '/api/personal-juices') ||
        (method === 'PATCH' && !!personal)) {
      const item = body as SavePersonalJuice;
      const expected = item.expected_revision ? Number(item.expected_revision) : 0;
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new ApiError(400, 'Versão inválida.', 'PRIVATE_SUMMARY_INPUT');
      const reply = await call('POST', '/api/private/personal-juices/save', {
        id: item.id, revision: expected, name: item.name, category: item.category || 'Meus tipos',
        base_type: item.base_type, instructions: item.instructions,
      });
      return { type: legacyType(reply.type as unknown as PrivatePersonalType) };
    }
    if (method === 'DELETE' && personal) {
      const revision = Number((body as { expected_revision?: string })?.expected_revision);
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new ApiError(400, 'Versão inválida.', 'PRIVATE_SUMMARY_INPUT');
      return await call('POST', '/api/private/personal-juices/archive', { id: personal[1], revision });
    }
    if (method === 'POST' && url.pathname === '/api/digests/generate') {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const field = (name: string) => parts.find(part => part.type === name)?.value ?? '';
      const day = `${field('year')}-${field('month')}-${field('day')}`;
      const id = crypto.randomUUID();
      const result = await call('POST', '/api/digests/generate', { day, request_id: id });
      const summary = result.digest ?? (await awaitSummary(id)).summary;
      return { digest: digestFromSummary(summary as Summary) };
    }
    if (method === 'GET' && url.pathname === '/api/digests') {
      const result = await call('GET', `/api/digests${url.search}`);
      return { digests: (result.digests as Summary[] ?? []).map(digestFromSummary), total: result.total };
    }
    if (method === 'GET' && url.pathname === '/api/juice-catalog')
      return await call('GET', '/api/juice-catalog');
    const summaryToDelete = /^\/api\/summaries\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (method === 'DELETE' && summaryToDelete)
      { const deleted = await call('POST', '/api/private/summaries/delete', { id: summaryToDelete[1] });
        summaryCache = null; return deleted; }
    if (method === 'PATCH' && /^\/api\/chats\/[^/]+$/.test(url.pathname)) {
      const jid = decodeURIComponent(url.pathname.slice('/api/chats/'.length));
      const tracked = (body as { tracked?: unknown } | undefined)?.tracked;
      if (typeof tracked !== 'boolean') throw new ApiError(400, 'Confira o acompanhamento.', 'PRIVATE_CHAT_INPUT');
      return await call('POST', '/api/private/chats/tracking', { jid, tracked });
    }
    const directGet = method === 'GET' && (
      ['/api/status','/api/dashboard','/api/chats','/api/usage','/api/summaries'].includes(url.pathname) ||
      /^\/api\/chats\/[^/]+\/(stats|messages|name)$/.test(url.pathname) ||
      /^\/api\/summaries\/[0-9a-f-]{36}$/.test(url.pathname));
    const directPost = method === 'POST' && ['/api/connection/reconnect','/api/connection/new-pairing'].includes(url.pathname);
    if (directGet) return await call('GET', `${url.pathname}${url.search}`);
    if (directPost) return await call('POST', `${url.pathname}${url.search}`, body);
    throw new ApiError(503, 'Este recurso ainda não foi ligado ao canal privado.', 'CONFIDENTIAL_FEATURE_UNAVAILABLE');
  }};
  registerPrivateTransport(transport);
  return () => { active = false; clearPrivateTransport(transport); };
}

function digestFromSummary(summary: Summary) {
  return { id: summary.id, day: summary.chat_jid.startsWith('digest:') ?
    summary.chat_jid.slice(7) : summary.period_start.slice(0, 10), content: summary.content,
    stats: null, model: summary.model, created_at: summary.created_at };
}
