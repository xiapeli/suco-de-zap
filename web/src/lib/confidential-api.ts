import type { ChatStats, ChatsResponse, DashboardData, MessagesResponse, Status } from './api';
import type { ConfidentialChannel } from './confidential-channel';

export interface PrivateSummary {
  id: string; chat_jid: string; chat_name: string; title: string;
  analysis_type: string; period_start: string; period_end: string;
  content: string; model: string; created_at: string; auto: false;
}
export interface PrivateSummaryRequest {
  request_id: string; chat_jid: string; start: string; end: string;
  analysis_type: string; template_version: string; personal_revision?: string;
  focus?: string; base_prompt?: string; title?: string;
}
export type PrivateSummaryStatus = { state: 'pending' } | { summary: PrivateSummary };
export interface PrivateSearchResult {
  messages: { id: string; chat_jid: string; chat_name: string; sender_name: string;
    ts: string; body: string; bodyTruncated: boolean }[];
  total: number; nextOffset: number | null;
  coverage: { firstMessageAt: string | null; lastMessageAt: string | null;
    totalMessages: number; selectedMessages: number; matchingMessages: number;
    scope: 'stored_messages'; historyComplete: false };
}
export interface PrivatePersonalType {
  id: string; name: string; category: string; base_type: string; instructions: string;
  created_at: string; updated_at: string; revision: number;
}

export class ConfidentialApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'ConfidentialApiError';
  }
}

function encoded(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function request<T>(channel: ConfidentialChannel, method: 'GET' | 'POST', path: string,
  body?: object): Promise<T> {
  const reply = await channel.rpc<unknown>(method, path, body);
  if (!reply || !Number.isInteger(reply.status) || typeof reply.body !== 'object' || !reply.body ||
      Array.isArray(reply.body)) throw Error('PRIVATE_RESPONSE_INVALID');
  const data = reply.body as Record<string, unknown>;
  if (reply.status < 200 || reply.status >= 300)
    throw new ConfidentialApiError(reply.status, typeof data.code === 'string' ? data.code : 'PRIVATE_REQUEST_FAILED');
  return data as T;
}

export const confidentialApi = {
  status: (channel: ConfidentialChannel) => request<Status>(channel, 'GET', '/api/status'),
  dashboard: (channel: ConfidentialChannel) => request<DashboardData>(channel, 'GET', '/api/dashboard'),
  chats: (channel: ConfidentialChannel, options: { kind: 'group' | 'all' | 'person'; q?: string; limit: number; offset: number }) => {
    const q = options.q?.trim();
    const path = `/api/chats?kind=${options.kind}&limit=${Math.min(500, Math.max(1, options.limit))}&offset=${Math.max(0, options.offset)}` +
      (q ? `&q=${encoded(q)}` : '');
    return request<ChatsResponse>(channel, 'GET', path);
  },
  messages: (channel: ConfidentialChannel, jid: string, limit: number, offset: number) =>
    request<MessagesResponse>(channel, 'GET',
      `/api/chats/${encoded(jid)}/messages?limit=${Math.min(5000, Math.max(1, limit))}&offset=${Math.max(0, offset)}`),
  stats: (channel: ConfidentialChannel, jid: string) =>
    request<ChatStats>(channel, 'GET', `/api/chats/${encoded(jid)}/stats`),
  reconnect: (channel: ConfidentialChannel) => request<Status>(channel, 'POST', '/api/connection/reconnect'),
  newPairing: (channel: ConfidentialChannel) =>
    request<Status>(channel, 'POST', '/api/connection/new-pairing', { confirm: 'NEW_PAIRING' }),
  generateSummary: (channel: ConfidentialChannel, body: PrivateSummaryRequest) =>
    request<PrivateSummaryStatus & { requestId?: string }>(channel, 'POST', '/api/summaries/generate', body),
  summaryStatus: (channel: ConfidentialChannel, id: string) =>
    request<PrivateSummaryStatus>(channel, 'GET', `/api/summaries/${encoded(id)}`),
  summaries: (channel: ConfidentialChannel, limit = 50, offset = 0) =>
    request<{ summaries: PrivateSummary[]; total: number }>(channel, 'GET',
      `/api/summaries?limit=${Math.min(200, Math.max(1, limit))}&offset=${Math.max(0, offset)}`),
  search: (channel: ConfidentialChannel, options: { query: string;
    kind: 'all' | 'pix' | 'email' | 'phone' | 'address'; limit?: number; offset?: number }) =>
    request<PrivateSearchResult>(channel, 'POST', '/api/search', options),
  personalTypes: (channel: ConfidentialChannel) =>
    request<{ types: PrivatePersonalType[] }>(channel, 'GET', '/api/private/personal-juices'),
  savePersonalType: (channel: ConfidentialChannel, input: Pick<PrivatePersonalType,
    'id' | 'revision' | 'name' | 'category' | 'base_type' | 'instructions'>) =>
    request<{ type: PrivatePersonalType }>(channel, 'POST', '/api/private/personal-juices/save', input),
  archivePersonalType: (channel: ConfidentialChannel, id: string, revision: number) =>
    request<{ ok: true }>(channel, 'POST', '/api/private/personal-juices/archive', { id, revision }),
  digests: (channel: ConfidentialChannel, limit = 60, offset = 0) =>
    request<{ digests: PrivateSummary[]; total: number }>(channel, 'GET',
      `/api/digests?limit=${Math.min(120, Math.max(1, limit))}&offset=${Math.max(0, offset)}`),
  generateDigest: (channel: ConfidentialChannel, day: string, requestId: string) =>
    request<{ state: 'pending'; requestId: string } | { digest: PrivateSummary }>(channel, 'POST',
      '/api/digests/generate', { day, request_id: requestId }),
};

export function confidentialErrorText(error: unknown): string {
  if (error instanceof ConfidentialApiError) {
    switch (error.code) {
      case 'PAIRING_IDENTITY_UNAVAILABLE':
        return 'Não conseguimos confirmar o WhatsApp anterior. A conta e o histórico foram preservados.';
      case 'PAIRING_RATE_LIMITED':
        return 'Aguarde alguns minutos antes de pedir outro QR.';
      case 'CONFIDENTIAL_FEATURE_UNAVAILABLE':
        return 'O processamento privado ainda está iniciando. Tente novamente em instantes.';
      case 'PRIVATE_SUMMARY_NO_MESSAGES':
        return 'Não há mensagens salvas nesse período. Escolha outro período ou sincronize a conversa.';
      case 'PRIVATE_SUMMARY_FAILED':
      case 'PROVIDER_UNAVAILABLE':
      case 'PROVIDER_CONNECTION_UNCERTAIN':
        return 'A geração falhou. Nenhum suco foi salvo; tente novamente.';
      case 'PRIVATE_SUMMARY_PENDING':
        return 'Este suco ainda está sendo gerado. Aguarde a confirmação.';
      case 'PRIVATE_SEARCH_INPUT':
        return 'Escreva o que quer encontrar ou escolha um tipo de informação.';
      case 'PRIVATE_PERSONAL_CHANGED':
      case 'PRIVATE_SUMMARY_CONFLICT':
        return 'Esse tipo mudou em outra aba. Atualize a lista antes de salvar.';
      case 'PRIVATE_PERSONAL_NOT_FOUND':
        return 'Esse tipo de suco não está mais disponível. Escolha outro.';
      case 'ENTITLEMENT_REQUIRED':
      case 'TRIAL_EXHAUSTED':
        return 'Sua conta precisa de autorização ativa para conectar o WhatsApp.';
      default:
        if (error.status === 401) return 'Sua sessão privada expirou. Reabra a conexão segura.';
        if (error.status === 429) return 'Muitas tentativas. Aguarde um pouco e tente novamente.';
        return 'Não conseguimos concluir agora. Tente novamente.';
    }
  }
  const code = error instanceof Error ? error.message : '';
  const diagnostic = /^[A-Z][A-Z_]{3,63}$/.test(code) ? ` (código ${code})` : '';
  if (code.startsWith('ATTEST_'))
    return `Não foi possível verificar o processamento privado. Sua chave não foi enviada.${diagnostic}`;
  if (code === 'CHANNEL_REMOTE' || code === 'CHANNEL_RELEASE')
    return `O processamento privado não respondeu. Tente abrir novamente.${diagnostic}`;
  if (code === 'OWNER_SESSION_AUTH')
    return `A sessão expirou antes de abrir o espaço privado. Saia e entre novamente.${diagnostic}`;
  if (code === 'AUTH_STATE_CORRUPT' || code === 'WORKER_REATTACH_DENIED')
    return `A chave salva não corresponde ao estado privado desta conta. Use o código de recuperação original.${diagnostic}`;
  if (code === 'CHANNEL_CLOSED') return 'A conexão privada foi encerrada. Abra novamente.';
  if (code === 'OWNER_HANDOFF_UNAVAILABLE' || code === 'OWNER_HANDOFF_INVALID')
    return `Não foi possível confirmar o WhatsApp anterior para esta conta. Sua chave não foi enviada.${diagnostic}`;
  if (code.startsWith('AUTH_STATE_') || code.startsWith('CONFIDENTIAL_') ||
      code.startsWith('WORKER_') || code.startsWith('OWNER_') || code.startsWith('CHANNEL_'))
    return `Não conseguimos preparar seu espaço privado. Sua chave continua neste navegador.${diagnostic}`;
  if (code === 'LOCAL_KEY_DAMAGED') return 'A chave salva neste dispositivo não pôde ser lida. Use seu código de recuperação.';
  if (code === 'LOCAL_KEY_STORAGE_UNAVAILABLE') return 'Este navegador não permitiu salvar sua chave. Guarde o código de recuperação.';
  return 'Não conseguimos abrir seus dados privados agora. Tente novamente.';
}
