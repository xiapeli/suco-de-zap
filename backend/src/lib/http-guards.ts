/**
 * Guards HTTP puros: CORS allowlist, rate limit por janela fixa, limite de
 * body e validação da waitlist. Sem I/O — testáveis direto.
 */

// ===== CORS allowlist =====

/** Converte padrão com `*` (ex.: `https://*.pages.dev`) em RegExp. */
export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export interface CorsAllowlist {
  patterns: string[];
  allowed(origin: string | undefined): boolean;
}

/**
 * Allowlist de origens. Padrões suportam `*` como curinga simples.
 * Defaults: localhost/127.0.0.1 (qualquer porta), Pages do produto
 * (produção + previews) e o domínio público, se configurado.
 */
export function buildCorsAllowlist(env: {
  corsOrigins?: string;
  publicDomain?: string;
}): CorsAllowlist {
  const patterns: string[] = [];
  if (env.corsOrigins && env.corsOrigins.trim()) {
    for (const raw of env.corsOrigins.split(',')) {
      const p = raw.trim();
      if (p) patterns.push(p);
    }
  } else {
    patterns.push(
      'http://localhost:*',
      'http://127.0.0.1:*',
      'https://suco-de-zap.pages.dev',
      'https://*.suco-de-zap.pages.dev'
    );
    if (env.publicDomain) {
      const d = env.publicDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (d) patterns.push(`https://${d}`, `https://*.${d}`);
    }
  }
  const regexes = patterns.map(patternToRegex);
  return {
    patterns,
    allowed(origin: string | undefined): boolean {
      if (!origin) return false; // mesma origem/sem CORS não precisa allowlist
      return regexes.some((re) => re.test(origin));
    },
  };
}

// ===== Rate limit (janela fixa, por chave, relógio injetável) =====

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly opts: {
      windowMs: number;
      max: number;
      /** Teto de chaves simultâneas: impede DoS de memória via chaves forjadas. */
      maxKeys?: number;
      now?: () => number;
    }
  ) {}

  check(key: string): RateLimitDecision {
    const now = (this.opts.now ?? Date.now)();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.opts.windowMs) {
      this.evictIfNeeded(now);
      this.hits.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: this.opts.max - 1, retryAfterMs: 0 };
    }
    entry.count += 1;
    const allowed = entry.count <= this.opts.max;
    return {
      allowed,
      remaining: Math.max(0, this.opts.max - entry.count),
      retryAfterMs: allowed ? 0 : entry.windowStart + this.opts.windowMs - now,
    };
  }

  /** Limpa contadores (útil p/ testes/liberar janela). */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  get keyCount(): number {
    return this.hits.size;
  }

  /**
   * Mantém o mapa bornado: antes de inserir chave nova, varre entradas com
   * janela expirada; se ainda cheio (todas em janela ativa), evicta a mais
   * antiga (ordem de inserção do Map). Custo O(n) só no limiar do teto.
   */
  private evictIfNeeded(now: number): void {
    const maxKeys = this.opts.maxKeys ?? 10_000;
    if (this.hits.size < maxKeys) return;
    for (const [k, e] of this.hits) {
      if (now - e.windowStart >= this.opts.windowMs) this.hits.delete(k);
    }
    while (this.hits.size >= maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

// ===== Body size =====

export function isBodyTooLarge(
  contentLengthHeader: string | undefined,
  actualByteLength: number,
  maxBytes: number
): boolean {
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) return true;
  }
  return actualByteLength > maxBytes;
}

// ===== Validação waitlist (pura; a rota só consome) =====

export interface WaitlistInput {
  email: string;
  name: string | null;
  profession: string | null;
  whatsapp: string | null;
  source: string | null;
}

export type WaitlistValidation =
  | { ok: true; value: WaitlistInput }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateWaitlistInput(body: unknown): WaitlistValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Corpo inválido' };
  }
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: 'E-mail inválido' };
  }
  const clip = (v: unknown, n: number): string | null => {
    const s = typeof v === 'string' ? v.trim().slice(0, n) : '';
    return s || null;
  };
  return {
    ok: true,
    value: {
      email,
      name: clip(b.name, 120),
      profession: clip(b.profession, 60),
      whatsapp: clip(b.whatsapp, 30),
      source: clip(b.source, 60),
    },
  };
}

// ===== /ready: shape da resposta (genérica fora de auth, detalhada dentro) =====

export interface ReadyChecks {
  postgres: 'ok' | 'fail';
  llm: 'ok' | 'unreachable' | 'not_configured';
}

export type ReadyReport =
  | { ok: true; checks: ReadyChecks }
  | { ok: false; checks: ReadyChecks; failing: Array<keyof ReadyChecks> };

export function buildReadyReport(checks: ReadyChecks): ReadyReport {
  const failing = (Object.keys(checks) as Array<keyof ReadyChecks>).filter(
    (k) => checks[k] !== 'ok'
  );
  return failing.length ? { ok: false, checks, failing } : { ok: true, checks };
}

/** Fora de auth: só o ok booleano — sem nomes de componentes nem detalhes. */
export function renderReadyPublic(report: ReadyReport): { ok: boolean } {
  return { ok: report.ok };
}
