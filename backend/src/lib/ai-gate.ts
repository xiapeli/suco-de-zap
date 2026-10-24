/**
 * Gate de concorrência de operações de IA (LLM local = efetivamente
 * single-stream; a llm-queue serializa o upstream, mas o pedido já teria
 * esperado minutos na fila). Política: concorrência 1 por instância —
 * requisição extra recebe 429 + Retry-After na hora, sem enfileirar.
 *
 * Sem I/O — testável direto.
 */

export type AiSlot =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterMs: number };

/** Dica de espera: operação local pode levar minutos, mas 60s é um balanço razoável. */
export const AI_BUSY_RETRY_AFTER_MS = 60_000;

export class AiConcurrencyGate {
  private inflight = 0;

  constructor(private readonly maxConcurrent = 1) {}

  /** Tenta entrar; NÃO espera (fail-fast 429 no caller). */
  tryAcquire(): AiSlot {
    if (this.inflight >= this.maxConcurrent) {
      return { ok: false, retryAfterMs: AI_BUSY_RETRY_AFTER_MS };
    }
    this.inflight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return; // idempotente: double-release não rouba slot alheio
        released = true;
        this.inflight = Math.max(0, this.inflight - 1);
      },
    };
  }

  get current(): number {
    return this.inflight;
  }
}
