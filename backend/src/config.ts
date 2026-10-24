import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

const confidentialRuntime = process.env.SUCO_CONFIDENTIAL_RUNTIME === '1';
if (confidentialRuntime && process.env.DATABASE_URL) throw new Error('CONFIDENTIAL_DATABASE_FORBIDDEN');

export const config = {
  confidentialRuntime,
  port: Number(process.env.PORT || 8377),
  /**
   * ===== TRUST BOUNDARY (borda de confiança de rede) =====
   * Bind default: 127.0.0.1 (loopback). O servidor só aceita conexões
   * locais — o acesso externo vem SEMPRE via tunnel/adapter rodando na
   * MESMA máquina (cloudflared, SSH -L etc.), que preserva o bind em
   * loopback. Para o legado que escutava na LAN, setar explicitamente
   * HOST/BIND_HOST=0.0.0.0 (opção consciente, não default).
   */
  host: process.env.BIND_HOST || process.env.HOST || '127.0.0.1',
  /**
   * CF-Connecting-IP só é confiável quando TRUST_CLOUDFLARE_PROXY=true E o
   * transporte veio de loopback (tunnel na mesma máquina) — ou seja, só o
   * Cloudflare pode ter posto o header. Nessa configuração o bind DEVE
   * continuar loopback; expor 0.0.0.0 + confiar CF-IP permitiria forjar a
   * identidade de cliente (rate limit por IP falsificado).
   * X-Forwarded-For/x-real-ip NUNCA são confiáveis (qualquer cliente poe).
   */
  trustCloudflareProxy: process.env.TRUST_CLOUDFLARE_PROXY === 'true',
  // The confidential bootstrap installs an owner-bound JWT verifier instead.
  apiToken: confidentialRuntime ? '' : required('API_TOKEN'),
  databaseUrl: confidentialRuntime ? '' : required('DATABASE_URL'),
  // LLM local OpenAI-compatível (llama-server/LM Studio). Se setado, é o cérebro dos sucos.
  openaiCompatUrl: process.env.OPENAI_COMPAT_URL || '',
  openaiCompatModel: process.env.OPENAI_COMPAT_MODEL || 'qwen',
  // Probe de readiness apontando para o /ready da llm-queue (ex. http://127.0.0.1:8378/ready).
  // Vazio = fallback GET {OPENAI_COMPAT_URL}/models direto no servidor de modelo.
  llmReadyUrl: process.env.LLM_READY_URL || '',
  // Anthropic (usado só quando OPENAI_COMPAT_URL está vazio).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  authDir: process.env.WA_AUTH_DIR || './auth_state',
  // CORS: allowlist configurável (vírgula-separado, `*` curinga). Vazio = default
  // (localhost + Pages do produto + PUBLIC_DOMAIN). NUNCA usar "*" em produção.
  corsOrigins: process.env.CORS_ORIGINS || '',
  publicDomain: process.env.PUBLIC_DOMAIN || '',
  // Proxy SOCKS para o socket do WhatsApp (ex.: socks5://127.0.0.1:1080)
  // quando a rede local bloqueia o WhatsApp. Vazio = conexão direta.
  waProxy: process.env.WA_PROXY || '',
  sucoCron: process.env.SUCO_CRON || '0 8 * * *',
  // 00:05 gerando o dia ANTERIOR: cron às 21h deixava a janela 21h-24h fora de todo digest
  digestCron: process.env.DIGEST_CRON || '5 0 * * *',
  extractCron: process.env.EXTRACT_CRON || '*/30 * * * *',
  sucoMinMessages: Number(process.env.SUCO_MIN_MESSAGES || 5),
  timezone: process.env.TZ_SUCO || 'Asia/Shanghai',
  // LLM local tem contexto curto: 600k chars estouram/truncam silenciosamente o prompt
  maxTranscriptChars: Number(
    process.env.MAX_TRANSCRIPT_CHARS || (process.env.OPENAI_COMPAT_URL ? 60_000 : 600_000)
  ) > 48_000 && process.env.SUCO_GLM_REGULAR_KEY_FILE ? 48_000 : Number(process.env.MAX_TRANSCRIPT_CHARS || (process.env.OPENAI_COMPAT_URL ? 60_000 : 600_000)),
};
