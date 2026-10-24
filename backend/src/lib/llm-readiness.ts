/**
 * Readiness do LLM: probe barato (GET /models — NÃO dispara inferência) com
 * cache por TTL, para o cron não gastar rodadas quando o Qwen local está off.
 * Probe e relógio injetáveis → testável sem rede.
 */

export type LlmProbeResult = 'ok' | 'unreachable' | 'not_configured';

export type LlmProbe = (url: string, timeoutMs: number) => Promise<LlmProbeResult>;

/**
 * Probe real, SEM inferência:
 * - readyUrl configurado (LLM_READY_URL → GET /ready da llm-queue): a fila
 *   própria checa o upstream (/health ou /v1/models) com TTL e responde
 *   200/503. 200 = ok; qualquer outra coisa (503, erro de rede, timeout)
 *   = unreachable — erro NÃO é mascarado como ok.
 * - sem readyUrl: GET {baseUrl}/models direto (compat: servidor sem fila).
 */
export const httpProbe: LlmProbe = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
};

export class LlmReadiness {
  private cached: { result: LlmProbeResult; at: number } | null = null;
  private probing: Promise<LlmProbeResult> | null = null;

  constructor(
    private readonly opts: {
      baseUrl: string; // vazio = LLM remoto (Anthropic) → não probe, assume ok
      /** URL completa do /ready da llm-queue (config LLM_READY_URL). Tem precedência sobre /models. */
      readyUrl?: string;
      probe?: LlmProbe;
      ttlMs?: number;
      timeoutMs?: number;
      now?: () => number;
    }
  ) {}

  /** URL efetiva do probe: readyUrl (fila) se configurada, senão /models direto. */
  probeUrl(): string {
    if (this.opts.readyUrl) return this.opts.readyUrl;
    return `${this.opts.baseUrl.replace(/\/$/, '')}/models`;
  }

  async check(): Promise<LlmProbeResult> {
    // LLM remoto configurado (sem URL local): não há probe barato confiável;
    // não bloqueia o cron por causa disso.
    if (!this.opts.baseUrl) return 'ok';
    const now = this.opts.now ?? Date.now;
    const ttl = this.opts.ttlMs ?? 60_000;
    if (this.cached && now() - this.cached.at < ttl) return this.cached.result;
    if (this.probing) return this.probing;
    this.probing = (this.opts.probe ?? httpProbe)(
      this.probeUrl(),
      this.opts.timeoutMs ?? 2_000
    ).then((result) => {
      this.cached = { result, at: (this.opts.now ?? Date.now)() };
      this.probing = null;
      return result;
    });
    return this.probing;
  }

  /** Força nova medição na próxima checagem (ex.: após erro de chamada real). */
  invalidate(): void {
    this.cached = null;
  }

  get lastResult(): LlmProbeResult | null {
    return this.cached?.result ?? null;
  }
}
