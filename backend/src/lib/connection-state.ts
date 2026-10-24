/**
 * Máquina de estados da conexão WhatsApp — PURA (sem Baileys, sem I/O).
 * Toda a política de reconexão/fencing/QR vive aqui para ser testável com
 * relógio e timers injetados (sem rede real).
 *
 * Contrato público (aditivo, backward-compatible) ver specs/reliability_design.md.
 */

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'qr_required'
  | 'action_required'
  | 'disconnected';

/** Códigos de razão SEGUROS p/ expor na API (sem mensagem crua do Baileys/PII). */
export type ReasonCode =
  | 'logged_out'
  | 'connection_replaced'
  | 'forbidden'
  | 'bad_session'
  | 'multidevice_mismatch'
  | 'restart_required'
  | 'service_unavailable'
  | 'connection_closed'
  | 'timed_out'
  | 'qr_expired'
  | 'stopped'
  | 'unknown';

export interface MeInfo {
  jid: string;
  name: string | null;
}

export interface PublicConnectionStatus {
  /** Campos legados (compat) */
  connected: boolean;
  qr: string | null;
  me: MeInfo | null;
  syncing: boolean;
  /** Campos novos (aditivos) */
  connectionState: ConnectionState;
  reason: ReasonCode | null;
  /** Ação segura que o usuário deve tomar quando reason exige intervenção. */
  actionHint: string | null;
  updatedAt: string;
  lastConnectedAt: string | null;
  qrExpiresAt: string | null;
  readOnly: true;
}

export interface DisconnectDecision {
  reason: ReasonCode;
  /** true = pode reconectar sozinho (backoff); false = precisa ação do usuário. */
  autoRetry: boolean;
  delayMs: number;
  /** Credenciais podem ser apagadas? Apenas logout confirmado (401). */
  mayDeleteCreds: boolean;
  actionHint: string | null;
}

export const QR_TTL_MS = 60_000;

const HINTS: Partial<Record<ReasonCode, string>> = {
  logged_out: 'Sessão encerrada no WhatsApp. Pareie novamente escaneando um novo QR.',
  connection_replaced:
    'Outro aparelho conectou com esta sessão. Confira os "Aparelhos conectados" antes de parear de novo.',
  forbidden:
    'O WhatsApp recusou a conexão (conta bloqueada/restrição). Um novo QR NÃO resolve isso.',
  bad_session: 'Sessão inválida/corrompida. É preciso parear novamente com um novo QR.',
  multidevice_mismatch: 'Sessão multidevice incompatível. É preciso parear novamente.',
};

/** Razões que exigem ação do usuário — retry automático é BLOQUEADO. */
export function needsUserAction(reason: ReasonCode): boolean {
  return (
    reason === 'logged_out' ||
    reason === 'connection_replaced' ||
    reason === 'forbidden' ||
    reason === 'bad_session' ||
    reason === 'multidevice_mismatch'
  );
}

/**
 * Mapeia o statusCode do DisconnectReason do Baileys (vindo do Boom) para a
 * política interna. Valores conferidos no enum real do pacote:
 * 401 loggedOut, 440 connectionReplaced, 403 forbidden, 500 badSession,
 * 515 restartRequired, 411 multideviceMismatch, 428 connectionClosed,
 * 408 timedOut/connectionLost, 503 unavailableService.
 */
export function classifyDisconnect(code: number | undefined): {
  reason: ReasonCode;
  autoRetry: boolean;
  mayDeleteCreds: boolean;
} {
  switch (code) {
    case 401:
      return { reason: 'logged_out', autoRetry: false, mayDeleteCreds: true };
    case 440:
      return { reason: 'connection_replaced', autoRetry: false, mayDeleteCreds: false };
    case 403:
      return { reason: 'forbidden', autoRetry: false, mayDeleteCreds: false };
    case 500:
      return { reason: 'bad_session', autoRetry: false, mayDeleteCreds: false };
    case 411:
      return { reason: 'multidevice_mismatch', autoRetry: false, mayDeleteCreds: false };
    case 515:
      return { reason: 'restart_required', autoRetry: true, mayDeleteCreds: false };
    case 503:
      return { reason: 'service_unavailable', autoRetry: true, mayDeleteCreds: false };
    case 428:
      return { reason: 'connection_closed', autoRetry: true, mayDeleteCreds: false };
    case 408:
      return { reason: 'timed_out', autoRetry: true, mayDeleteCreds: false };
    default:
      return { reason: 'unknown', autoRetry: true, mayDeleteCreds: false };
  }
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: (delayMs: number) => number;
}

/** Backoff exponencial com teto — impede retry storm. attempt começa em 1. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 3_000;
  const max = opts.maxMs ?? 300_000;
  const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  return opts.jitter ? Math.min(max, Math.max(base, opts.jitter(raw))) : raw;
}

/**
 * Estado + fencing por geração. Cada tentativa de socket recebe uma geração;
 * eventos/timers de gerações velhas são descartados (isCurrent === false),
 * o que elimina sockets múltiplos e timers stale.
 */
export class ConnectionTracker {
  private generation = 0;
  private state: ConnectionState = 'disconnected';
  private reason: ReasonCode | null = null;
  private syncing = false;
  private qr: string | null = null;
  private qrIssuedAt: number | null = null;
  private me: MeInfo | null = null;
  private updatedAt = Date.now();
  private lastConnectedAt: number | null = null;
  private attempt = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  /** Inicia nova tentativa; invalida gerações anteriores. */
  beginAttempt(now?: number): number {
    this.generation += 1;
    this.attempt += 1;
    this.state = 'connecting';
    this.reason = null;
    this.qr = null;
    this.qrIssuedAt = null;
    this.updatedAt = now ?? this.now();
    return this.generation;
  }

  markQr(gen: number, qr: string, now?: number): boolean {
    if (!this.isCurrent(gen)) return false;
    this.qr = qr;
    this.qrIssuedAt = now ?? this.now();
    this.state = 'qr_required';
    this.updatedAt = this.qrIssuedAt;
    return true;
  }

  markConnected(gen: number, me: MeInfo | null, now?: number): boolean {
    if (!this.isCurrent(gen)) return false;
    const t = now ?? this.now();
    this.state = 'connected';
    this.qr = null;
    this.qrIssuedAt = null;
    this.me = me;
    this.lastConnectedAt = t;
    this.updatedAt = t;
    this.attempt = 0; // reconectou: zera o backoff
    return true;
  }

  markSyncing(gen: number, syncing: boolean, now?: number): boolean {
    if (!this.isCurrent(gen)) return false;
    this.syncing = syncing;
    this.updatedAt = now ?? this.now();
    return true;
  }

  markStopped(now?: number): void {
    // INVALIDA a geração corrente: uma startWhatsAppInner pendente em await
    // (auth state / version fetch) morre no recheck de isCurrent — logout
    // nunca deixa nascer socket de tentativa anterior.
    this.generation += 1;
    this.state = 'disconnected';
    this.reason = 'stopped';
    this.qr = null;
    this.qrIssuedAt = null;
    this.syncing = false;
    this.updatedAt = now ?? this.now();
  }

  /**
   * Registra queda. Retorna a decisão (retry automático? delay? apagar creds?).
   * Geração velha → decisão neutra (autoRetry false) — quem chamou ignora.
   */
  markDisconnected(gen: number, code: number | undefined, now?: number): DisconnectDecision {
    const cls = classifyDisconnect(code);
    const t = now ?? this.now();
    if (!this.isCurrent(gen)) {
      return { ...cls, autoRetry: false, mayDeleteCreds: false, delayMs: 0, actionHint: null };
    }
    this.state = cls.autoRetry ? 'reconnecting' : 'action_required';
    this.reason = cls.reason;
    this.updatedAt = t;
    this.qr = null;
    this.qrIssuedAt = null;
    this.syncing = false;
    const delayMs = cls.autoRetry ? backoffDelayMs(this.attempt) : 0;
    return { ...cls, delayMs, actionHint: HINTS[cls.reason] ?? null };
  }

  qrExpired(now?: number): boolean {
    if (!this.qr || this.qrIssuedAt === null) return false;
    return (now ?? this.now()) - this.qrIssuedAt >= QR_TTL_MS;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  snapshot(now?: number): PublicConnectionStatus {
    const t = now ?? this.now();
    const expired = this.qrExpired(t);
    const state = this.state;
    return {
      connected: state === 'connected',
      qr: expired ? null : this.qr,
      me: this.me,
      syncing: this.syncing,
      connectionState: expired && state === 'qr_required' ? 'qr_required' : state,
      reason: expired && state === 'qr_required' && this.qr ? 'qr_expired' : this.reason,
      actionHint:
        expired && state === 'qr_required' && this.qr
          ? 'QR expirado. Peça um novo QR (Configurações → Reconectar) e escaneie rapidamente.'
          : HINTS[this.reason as ReasonCode] ?? null,
      updatedAt: new Date(this.updatedAt).toISOString(),
      lastConnectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
      qrExpiresAt: this.qrIssuedAt !== null ? new Date(this.qrIssuedAt + QR_TTL_MS).toISOString() : null,
      readOnly: true,
    };
  }
}

export interface TimerFns {
  set: (fn: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

export const defaultTimerFns: TimerFns = {
  set: (fn, delayMs) => setTimeout(fn, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Timer único com fencing: só dispara se a geração ainda for a corrente e
 * qualquer agendamento novo cancela o anterior (nunca dois retries pendentes).
 */
export class FencedTimer {
  private handle: unknown = null;
  private sequence = 0;

  constructor(
    private readonly tracker: ConnectionTracker,
    private readonly fns: TimerFns = defaultTimerFns
  ) {}

  schedule(gen: number, fn: () => void, delayMs: number): void {
    this.clear();
    const sequence = ++this.sequence;
    this.handle = this.fns.set(() => {
      // A timer callback already queued when clear() ran must not execute a
      // stale retry/watchdog within the same connection generation.
      if (sequence !== this.sequence) return;
      this.handle = null;
      this.sequence += 1;
      if (this.tracker.isCurrent(gen)) fn();
    }, delayMs);
  }

  clear(): void {
    this.sequence += 1;
    if (this.handle !== null) {
      this.fns.clear(this.handle);
      this.handle = null;
    }
  }
}
