import { clearManualRequests } from './manual-juice-request.ts';
import { controlMode, sucoEnv } from './suco-env.ts';
// Cliente HTTP tipado para o backend Baileys (WhatzApp Chronicles).
// Contrato: API-CONTRACT.md na raiz do projeto.

// ---------- Tipos ----------

export interface Me {
  jid: string;
  name: string;
}

export interface Status {
  connected: boolean;
  qr: string | null;
  me: Me | null;
  syncing: boolean;
  connectionState?: 'connecting' | 'connected' | 'reconnecting' | 'qr_required' | 'action_required' | 'disconnected';
  pairingError?: 'PAIRING_ACCOUNT_MISMATCH' | 'PAIRING_IDENTITY_UNAVAILABLE' | null;
  reason?: string | null;
  updatedAt?: string | null;
  lastConnectedAt?: string | null;
  qrExpiresAt?: string | null;
  readOnly?: boolean;
  syncEvidence?: {
    lastIngestedAt: string | null;
    lastSavedMessageAt: string | null;
    maxSavedSeq?: string | null;
    writeHealth?: {
      lastWriteSuccessAt: string | null;
      lastWriteFailureAt: string | null;
      consecutiveWriteFailures: number;
    };
    pendingInMemory?: number;
    recoveryDurable?: boolean;
    newMessageAfterConnect: boolean;
    available: boolean;
  };
}

export interface OnboardingState {
  consent: { version: string; acceptedAt: string } | null;
  firstSummary: Summary | null;
  recovery?: { canRestart: boolean };
}

export type UsageData = { available: false } | { available?: true; period: string; timezone: 'UTC'; monthlyUsed: number; dailyUsed: number; monthlyLimit: number; dailyLimit: number; monitoredLimit: number; monitoredUsed?: number; unlimited?:boolean; access?: 'owner' | 'paid' | 'trial' | 'trial_exhausted'; trial?: { limit: number; completed: number; remaining: number; reserved: number } };

export interface DashboardData {
  chats: number;
  messages: number;
  summaries: number;
  tracked: number;
  last_message_at: string | null;
  connected: boolean;
}

export interface Chat {
  jid: string;
  name: string;
  is_group: boolean;
  tracked: boolean;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
}

export interface ChatsResponse {
  chats: Chat[];
  total: number;
}

export interface Message {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  from_me: boolean;
  body: string;
  msg_type: string;
  timestamp: string;
}

export interface MessagesResponse {
  messages: Message[];
  total: number;
}

export interface SenderStat {
  sender_name: string;
  count: number;
}

export interface ChatStats {
  count: number;
  by_sender: SenderStat[];
  first: string | null;
  last: string | null;
}

export interface Summary {
  id: string;
  chat_jid: string;
  chat_name: string;
  title: string | null;
  analysis_type: string;
  period_start: string;
  period_end: string;
  content: string;
  model: string;
  auto: boolean;
  created_at: string;
}

export interface SummariesResponse {
  summaries: Summary[];
  total: number;
}

export interface DiscoveryHit extends Omit<Summary, 'content' | 'auto' | 'model'> { excerpt: string; }
export interface DiscoveryResponse {
  results: DiscoveryHit[];
  total: number;
  saved: number;
  nextOffset: number | null;
  scope: 'saved_summaries';
  generated: false;
}

export interface GenerateSummaryInput {
  request_id?: string;
  chat_jid: string;
  start: string;
  end: string;
  analysis_type: string;
  base_prompt?: string;
  template_version?: string;
  personal_revision?: string;
  focus?: string;
  title?: string;
}

export interface PersonalJuiceMetadata {
  id: string; revision_id: string; revision: number; name: string; category: string;
  base_type: string; instructions_preview: string; created_at: string; updated_at: string;
}
export interface PersonalJuice extends Omit<PersonalJuiceMetadata, 'instructions_preview'> {
  instructions: string; archived: boolean;
}
export interface SavePersonalJuice {
  id: string; revision_id: string; name: string; category: string; instructions: string;
  base_type: string; expected_revision?: string;
}

// ---------- Tipos v2 (API-CONTRACT-V2.md) ----------

export interface ExtractionSetting {
  kind: string;
  label: string;
  enabled: boolean;
  pointer_only: boolean;
  count: number;
}

export interface Fact {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  message_id: string;
  kind: string;
  label: string;
  value: string | null;
  context: string | null;
  sender_name: string | null;
  sensitive: boolean;
  confidence: number | null;
  /** Subcategorias automáticas geradas por IA. Ausente em backends antigos. */
  tags?: string[];
  ts: string | null;
  created_at: string;
}

export interface FactsResponse {
  facts: Fact[];
  total: number;
}

export interface FactTag {
  tag: string;
  count: number;
}

export interface FactTagsResponse {
  tags: FactTag[];
}

export interface SearchHitMessage {
  chat_jid: string;
  chat_name: string;
  sender_name: string | null;
  body: string;
  ts: string;
  id: string;
}

export interface SearchFilters { timezone?: string; start?: string; end?: string; chat_jid?: string; kind?: 'all' | 'pix' | 'email' | 'phone' | 'address'; limit?: number; cursor?: string }
export interface SensitiveMatch { kind: 'ambiguous_number' | 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' | 'address'; value: string; chat_jid: string; messageId: string; ts: string; labelMessageId?: string; confidence: 'explicit' | 'contextual'; status: 'candidate' | 'revoked' | 'unconfirmed'; sourceExcerpt: string; highlights: { start: number; end: number }[] }
export interface SearchResponse {
  answerMode?: 'local_evidence';
  answer: string; facts: Fact[]; messages: (SearchHitMessage & { anchorId?: string; bodyTruncated?: boolean })[]; took_ms: number;
  sensitiveMatches?: SensitiveMatch[];
  coverage?: { firstMessageAt: string | null; lastMessageAt: string | null; totalMessages: number; selectedMessages: number; matchingMessages: number; matchingAnchors: number; hasMore: boolean; scope: 'stored_messages'; historyComplete: false; warnings: string[] };
  filters?: { start: string | null; end: string | null; chat_jid: string | null; kind: string; scope: 'all_stored_history' | 'selected_period'; inferredKind?: string };
  nextCursor?: string | null;
}
export interface VaultStatus { configured: boolean; locked: boolean; expiresAt: number | null }

export interface DigestStats {
  messages: number;
  chats: number;
  top_chats: { name: string; count: number }[];
  audios: number;
}

export interface Digest {
  id: string;
  day: string;
  content: string;
  stats: DigestStats | null;
  model: string | null;
  created_at: string;
}

export interface DigestsResponse {
  digests: Digest[];
  total: number;
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---------- Token / URL ----------

// Vault bearer is deliberately volatile: never store it in URLs or browser storage.
let vaultToken: string | null = null;
let vaultTimer: ReturnType<typeof setTimeout> | null = null;
let vaultSnapshot: { unlocked: boolean; expiresAt: number | null; version: number } = {unlocked:false, expiresAt:null, version:0};
const activeVaultRequests = new Set<AbortController>();
const vaultListeners = new Set<() => void>();
export function getVaultSnapshot() { return vaultSnapshot; }
export function subscribeVault(listener: () => void) { vaultListeners.add(listener); return () => { vaultListeners.delete(listener); }; }
export function clearVaultSession() {
  if (vaultTimer) clearTimeout(vaultTimer);
  vaultTimer = null; vaultToken = null;
  activeVaultRequests.forEach(controller => controller.abort()); activeVaultRequests.clear();
  vaultSnapshot = {unlocked:false, expiresAt:null, version:vaultSnapshot.version+1};
  vaultListeners.forEach(listener => listener());
}
function storeVaultSession(token: string, expiresAt: number) {
  if (typeof token !== 'string' || !token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ApiError(503, 'Não conseguimos abrir o Cofre. Tente novamente.', 'VAULT_UNAVAILABLE');
  clearVaultSession(); vaultToken = token;
  const deadline = Math.min(expiresAt, Date.now() + 15 * 60_000);
  vaultSnapshot = {unlocked:true, expiresAt:deadline, version:vaultSnapshot.version+1};
  vaultTimer = setTimeout(clearVaultSession, deadline-Date.now());
  vaultListeners.forEach(listener => listener());
}
const sensitiveVaultPath = (path: string) => /^\/api\/(?:facts(?:\/|\?|$)|search(?:\?|$))/.test(path);

const TOKEN_KEY = 'wzp_token';
const API_URL_KEY = 'wzp_api_url';
export const MANAGED_SESSION_KEY = 'wzp_managed_session';
type SessionResolver = () => Promise<string | null>;
let resolveSessionToken: SessionResolver | null = null;
type PrivateTransport = { scope: string; request: (path: string, options: RequestOptions) => Promise<unknown> };
let privateTransport: PrivateTransport | null = null;
/** The Supabase build may only use a verified confidential channel for product data. */
export function registerPrivateTransport(transport: PrivateTransport | null): void {
  privateTransport = transport;
}
export function clearPrivateTransport(transport: PrivateTransport): void {
  if (privateTransport === transport) privateTransport = null;
}
const sessionResolverWaiters = new Set<(ready: boolean) => void>();
export function registerSessionResolver(resolver: SessionResolver | null) {
  resolveSessionToken = resolver;
  if (resolver) sessionResolverWaiters.forEach(notify => notify(true));
}
function waitForSessionResolver(): Promise<void> {
  if (resolveSessionToken) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer); sessionResolverWaiters.delete(finish);
      if (ready) resolve();
      else reject(new Error('Entre novamente na sua conta para continuar.'));
    };
    const timer = setTimeout(() => finish(false), 10_000);
    sessionResolverWaiters.add(finish);
  });
}
function managedScope(raw: string): {tenantId: string; expiresAt: number} {
  const value = JSON.parse(raw);
  if (!value || typeof value.tenantId !== 'string' || !value.tenantId || !Number.isFinite(value.expiresAt)) throw new Error('Sua sessão precisa ser renovada. Entre novamente.');
  return value;
}
// The legacy-mode API origin is pinned by the deployer (no default): only
// that exact origin, or a local dev server, may receive credentials.
function pinnedLegacyApiOrigin(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?? process.env as Record<string, string | undefined>;
  return (env.VITE_SUCO_LEGACY_API_ORIGIN ?? '').trim().replace(/\/+$/, '');
}

/** Only the operator-pinned origin may ever receive access or vault credentials. */
export function validateApiUrl(value: string): string {
  try {
    const url = new URL(value);
    const pinned = pinnedLegacyApiOrigin();
    const approved = pinned !== '' && url.origin === pinned;
    const localPage = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    const localApi = localPage && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
    if ((!approved && !localApi) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new ApiError(400, 'Use o endereço de conexão oficial do seu deployment.', 'API_ORIGIN_INVALID'); }
}

export function getApiUrl(): string {
  if (controlMode() === 'supabase') {
    if (!privateTransport) throw new ApiError(503, 'Abra seu espaço privado para continuar.', 'CONFIDENTIAL_CHANNEL_REQUIRED');
    return privateTransport.scope;
  }
  const stored = localStorage.getItem(API_URL_KEY);
  if (stored && stored.trim()) return validateApiUrl(stored.trim());
  const pinned = pinnedLegacyApiOrigin();
  if (pinned === '') throw new ApiError(503,
    'Modo legado exige VITE_SUCO_LEGACY_API_ORIGIN (origem oficial do seu deployment).', 'API_ORIGIN_REQUIRED');
  return validateApiUrl(pinned);
}

export function setApiUrl(url: string | null): void {
  if (url && url.trim()) {
    localStorage.setItem(API_URL_KEY, validateApiUrl(url.trim()));
  } else {
    localStorage.removeItem(API_URL_KEY);
  }
}

export function getToken(): string | null {
  if (controlMode() === 'supabase') return privateTransport ? 'confidential-session' : null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  try { clearManualRequests(localStorage); } catch { /* Logout still completes without storage. */ }
  clearVaultSession();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(MANAGED_SESSION_KEY);
  sessionResolverWaiters.forEach(notify => notify(false));
}

// ---------- Request base ----------

interface RequestOptions {
  vaultTokenOverride?: string;
  method?: string;
  body?: unknown;
  /** Sobrescreve o token salvo (usado na validação do login). */
  token?: string;
  /** Sobrescreve a base URL salva (usado na validação do login). */
  baseUrl?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (controlMode() === 'supabase') {
    if (!privateTransport) throw new ApiError(503, 'Abra seu espaço privado para continuar.', 'CONFIDENTIAL_CHANNEL_REQUIRED');
    return privateTransport.request(path, options) as Promise<T>;
  }
  const vaultAtStart = vaultToken; const vaultEpoch = vaultSnapshot.version;
  const { method = 'GET', body, token, baseUrl } = options;
  const url = `${baseUrl ? validateApiUrl(baseUrl) : getApiUrl()}${path}`;

  const managedAtStart = !token ? localStorage.getItem(MANAGED_SESSION_KEY) : null;
  let sessionToken: string | null;
  if (managedAtStart) {
    const initialScope = managedScope(managedAtStart);
    // Native auth restores asynchronously on reload. Wait before sending a stale
    // tenant bearer; the registered resolver renews it using the native session.
    await waitForSessionResolver();
    const resolver = resolveSessionToken;
    const current = localStorage.getItem(MANAGED_SESSION_KEY);
    if (!resolver || !current || managedScope(current).tenantId !== initialScope.tenantId || getApiUrl() !== new URL(url).origin) throw new Error('Seu espaço mudou. Abra sua conta para continuar.');
    sessionToken = await resolver();
    const latest = localStorage.getItem(MANAGED_SESSION_KEY);
    if (!sessionToken || sessionToken !== getToken() || !latest || managedScope(latest).tenantId !== initialScope.tenantId || getApiUrl() !== new URL(url).origin) throw new Error('Sua sessão mudou. Abra sua conta para continuar.');
  } else {
    sessionToken = token ?? (resolveSessionToken ? await resolveSessionToken() : getToken());
  }
  if (vaultSnapshot.expiresAt && vaultSnapshot.expiresAt <= Date.now()) clearVaultSession();
  if (sensitiveVaultPath(path) && (!vaultAtStart || vaultEpoch !== vaultSnapshot.version || !vaultSnapshot.unlocked)) throw new ApiError(423, 'O Cofre está trancado. Abra novamente para consultar os dados.', 'VAULT_LOCKED');
  const vaultAtSend = options.vaultTokenOverride ?? (sensitiveVaultPath(path) ? vaultAtStart : vaultToken);
  const headers: Record<string, string> = { Authorization: `Bearer ${sessionToken ?? ''}` };
  if (vaultAtSend && (sensitiveVaultPath(path) || path.startsWith('/api/vault'))) headers['X-Suco-Vault-Token'] = vaultAtSend;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), method === 'GET' ? 20_000 : 330_000);
  if (sensitiveVaultPath(path)) activeVaultRequests.add(controller);
  try {
  const response = await fetch(url, {
    method,
    redirect: 'error',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  });

  if (response.status === 401) {
    const body = await response.clone().json().catch(() => null);
    if (typeof body?.code === 'string' && body.code.startsWith('VAULT_')) throw new ApiError(401, 'Senha do Cofre incorreta. Confira e tente novamente.', body.code);
    // Token inválido: limpar e voltar para a tela de login.
    // Se a validação veio com token explícito (fluxo de login), não redireciona.
    if (!token) {
      clearToken();
      if (window.location.pathname !== '/auth') {
        window.location.href = '/auth';
      }
    }
    throw new ApiError(401, 'Token inválido ou expirado');
  }

  if (!response.ok) {
    let message = `Erro ${response.status}`;
    let code: string | undefined;
    try {
      const data = await response.json();
      if (data && typeof data.code === 'string') code = data.code;
      if (data && typeof data.error === 'string') message = data.error;
      else if (data && typeof data.message === 'string') message = data.message;
    } catch {
      // corpo não-JSON: mantém a mensagem padrão
    }
    if (code === 'VAULT_LOCKED' || code === 'VAULT_NOT_CONFIGURED') { clearVaultSession(); message = 'O Cofre está trancado. Desbloqueie para continuar.'; }
    if (code === 'VAULT_RATE_LIMITED') message = 'Muitas tentativas de senha. Aguarde 15 minutos antes de tentar novamente.';
    if (code === 'VAULT_UNAVAILABLE') message = 'Não conseguimos acessar o Cofre agora. Tente novamente em instantes.';
    if (code === 'VAULT_PASSWORD_LENGTH') message = 'Use uma senha de pelo menos 12 caracteres.';
    if (code === 'TRIAL_EXHAUSTED') message = 'Seus 3 sucos grátis já foram concluídos. Assine para preparar novos sucos. Os resumos salvos continuam disponíveis.';
    if (code === 'UPGRADE_REQUIRED') message = 'Essa análise faz parte da assinatura. Seu teste gratuito inclui 3 resumos manuais.';
    if (code === 'TRIAL_COMMIT_PENDING') message = 'Seu suco está sendo confirmado. Tente novamente nesta mesma etapa; o mesmo pedido não inicia outra análise.';
    if (code === 'TRIAL_VERIFICATION_UNAVAILABLE') message = 'Não conseguimos conferir seu teste gratuito agora. Sua cota não foi confirmada; tente novamente em instantes.';
    throw new ApiError(response.status, message, code);
  }

  const result = await response.json();
  if (sensitiveVaultPath(path) && (!vaultToken || vaultEpoch !== vaultSnapshot.version || vaultToken !== vaultAtSend || !vaultSnapshot.unlocked || vaultSnapshot.expiresAt <= Date.now())) throw new ApiError(423, 'O Cofre foi trancado. Abra novamente para consultar os dados.', 'VAULT_LOCKED');
  return result as T;
  } finally { clearTimeout(deadline); activeVaultRequests.delete(controller); }
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

// ---------- Endpoints ----------

export const api = {
  vaultStatus(): Promise<VaultStatus> { return request('/api/vault/status'); },
  async vaultPassword(input: {newPassword: string; currentPassword?: string}): Promise<VaultStatus> { const result = await request<VaultStatus>('/api/vault/password', {method:'POST',body:input}); clearVaultSession(); return result; },
  async vaultUnlock(password: string): Promise<{expiresAt: number}> { const epoch = vaultSnapshot.version; const result = await request<{token: string; expiresAt: number}>('/api/vault/unlock', {method:'POST',body:{password}}); if (vaultSnapshot.version !== epoch) throw new ApiError(423, 'O Cofre foi trancado. Abra novamente para continuar.', 'VAULT_LOCKED'); storeVaultSession(result.token,result.expiresAt); return {expiresAt:result.expiresAt}; },
  async vaultLock(): Promise<void> { const current = vaultToken; clearVaultSession(); if(current) await request('/api/vault/lock', {method:'POST',body:{},vaultTokenOverride:current}); },
  usage(): Promise<UsageData> { return request<UsageData>('/api/usage'); },
  onboarding(): Promise<OnboardingState> { return request('/api/onboarding'); },
  consent(): Promise<OnboardingState> { return request('/api/onboarding/consent', { method: 'POST', body: { accepted: true, version: 'readonly-2026-10-15' } }); },
  reconnect(): Promise<Status> {
    return request<Status>('/api/connection/reconnect', { method: 'POST', body: {} });
  },
  newPairing(): Promise<Status> {
    return request<Status>('/api/connection/new-pairing', { method: 'POST', body: { confirm: 'NEW_PAIRING' } });
  },
  status(): Promise<Status> {
    return request<Status>('/api/status');
  },

  /** Valida um token (e opcionalmente uma URL) sem tocar no estado salvo. */
  validate(token: string, baseUrl?: string): Promise<Status> {
    return request<Status>('/api/status', { token, baseUrl });
  },

  logout(): Promise<{ ok: boolean }> {
    clearVaultSession();
    return request<{ ok: boolean }>('/api/logout', { method: 'POST' });
  },

  dashboard(): Promise<DashboardData> {
    return request<DashboardData>('/api/dashboard');
  },

  chats(params: { q?: string; kind?: 'all' | 'group' | 'person'; limit?: number; offset?: number } = {}): Promise<ChatsResponse> {
    return request<ChatsResponse>(`/api/chats${qs(params)}`);
  },

  updateChat(jid: string, patch: { tracked: boolean }): Promise<Chat> {
    return request<Chat>(`/api/chats/${encodeURIComponent(jid)}`, {
      method: 'PATCH',
      body: patch,
    });
  },

  chatMessages(
    jid: string,
    params: { start?: string; end?: string; limit?: number; offset?: number } = {},
  ): Promise<MessagesResponse> {
    return request<MessagesResponse>(`/api/chats/${encodeURIComponent(jid)}/messages${qs(params)}`);
  },

  chatName(jid: string): Promise<{name:string}> {
    return request(`/api/chats/${encodeURIComponent(jid)}/name`);
  },

  chatStats(jid: string, params: { start?: string; end?: string } = {}): Promise<ChatStats> {
    return request<ChatStats>(`/api/chats/${encodeURIComponent(jid)}/stats${qs(params)}`);
  },

  generateSummary(input: GenerateSummaryInput): Promise<{ summary: Summary }> {
    return request<{ summary: Summary }>('/api/summaries/generate', {
      method: 'POST',
      body: input,
    });
  },

  meetingProposals(id: string): Promise<{summaryId:string;truncated:boolean;candidates:{intentKey:string;emails:string[];suggestedEmails:string[];ambiguous:boolean;sourceTicket:string;evidence:{id:string;sender:string;body:string;ts:string}[]}[]}> {
    return request(`/api/summaries/${encodeURIComponent(id)}/calendar-proposals`);
  },

  juiceCatalog(): Promise<{ version: string; personalTypes?: boolean; types: { id: string }[] }> {
    return request('/api/juice-catalog');
  },

  personalJuices(): Promise<{types: PersonalJuiceMetadata[]}> { return request('/api/personal-juices'); },
  personalJuice(id: string, revision?: string): Promise<{type: PersonalJuice}> {
    return request(`/api/personal-juices/${encodeURIComponent(id)}${qs({revision})}`);
  },
  savePersonalJuice(input: SavePersonalJuice): Promise<{type: PersonalJuice}> {
    return request(`/api/personal-juices${input.expected_revision ? '/' + encodeURIComponent(input.id) : ''}`, {
      method: input.expected_revision ? 'PATCH' : 'POST', body: input,
    });
  },
  archivePersonalJuice(id: string, revision: string): Promise<{ok: boolean}> {
    return request(`/api/personal-juices/${encodeURIComponent(id)}`, {method:'DELETE',body:{expected_revision:revision}});
  },

  summaries(params: { chat_jid?: string; limit?: number; offset?: number } = {}): Promise<SummariesResponse> {
    return request<SummariesResponse>(`/api/summaries${qs(params)}`);
  },

  summary(id: string): Promise<{ summary: Summary }> {
    return request<{ summary: Summary }>(`/api/summaries/${encodeURIComponent(id)}`);
  },

  discover(query: string, offset = 0): Promise<DiscoveryResponse> {
    return request<DiscoveryResponse>('/api/discover', { method: 'POST', body: { query, offset } });
  },

  deleteSummary(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/summaries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // ----- v2: extração / cofre / busca / digest -----

  extractionSettings(): Promise<{ settings: ExtractionSetting[] }> {
    return request<{ settings: ExtractionSetting[] }>('/api/settings/extraction');
  },

  updateExtractionSetting(kind: string, enabled: boolean): Promise<{ setting: ExtractionSetting }> {
    return request<{ setting: ExtractionSetting }>(
      `/api/settings/extraction/${encodeURIComponent(kind)}`,
      { method: 'PATCH', body: { enabled } },
    );
  },

  facts(
    params: {
      kind?: string;
      chat_jid?: string;
      q?: string;
      tag?: string;
      limit?: number;
      offset?: number;
      start?: string;
      end?: string;
    } = {},
  ): Promise<FactsResponse> {
    return request<FactsResponse>(`/api/facts${qs(params)}`);
  },

  factTags(params: { kind?: string } = {}): Promise<FactTagsResponse> {
    return request<FactTagsResponse>(`/api/facts/tags${qs(params)}`);
  },

  retagFacts(): Promise<{ retagged: number; scanned: number }> {
    return request<{ retagged: number; scanned: number }>('/api/facts/retag', {
      method: 'POST',
      body: {},
    });
  },

  deleteFact(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/facts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  extractFacts(input: { chat_jid?: string; since?: string; force?: boolean } = {}): Promise<{
    extracted: number;
    scanned: number;
    chats: number;
  }> {
    return request('/api/facts/extract', { method: 'POST', body: input });
  },

  search(query: string, filters: SearchFilters | number = {}): Promise<SearchResponse> {
    return request<SearchResponse>('/api/search', { method: 'POST', body: { query, ...(typeof filters === 'number' ? {limit:filters} : filters) } });
  },

  digests(params: { limit?: number; offset?: number } = {}): Promise<DigestsResponse> {
    return request<DigestsResponse>(`/api/digests${qs(params)}`);
  },

  digest(day: string): Promise<{ digest: Digest }> {
    return request<{ digest: Digest }>(`/api/digests/${encodeURIComponent(day)}`);
  },

  generateDigest(day?: string): Promise<{ digest: Digest }> {
    return request<{ digest: Digest }>('/api/digests/generate', {
      method: 'POST',
      body: day ? { day } : {},
    });
  },
};
