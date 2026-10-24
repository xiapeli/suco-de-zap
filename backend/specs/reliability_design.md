# Suco de Zap — Plano de Confiabilidade & Segurança (backend)

Data: 2026-10-15 · Escopo: backend isolado `.local/state/suco-launch-20261015/backend`
(cópia fiel de `~/suco-server`; `diff -rq src` vazio antes desta mudança).
Parceiro de revisão: Codex. Produto é SOMENTE LEITURA do WhatsApp — nada de
sendMessage/readMessages/presence/auto-resposta foi adicionado.

## 1. Robustez da conexão Baileys

Problemas do código original (`src/wa.ts`):
1. QR impresso no terminal (segredo de pareamento vaza em logs/journal).
2. Toda queda reconectava em 3s fixos, sem distinguir razão — inclusive 401/440/403/500 (retry inútil ou tempestade).
3. `setTimeout` soltos: sync de grupos/contatos e retry podiam disparar de tentativas velhas (timers stale) e, com chamadas concorrentes de `startWhatsApp`, gerar múltiplos sockets.
4. Status sem `connectionState`/motivo — UI não sabia distinguir "QR pendente" de "ação necessária".

Solução (implementada em `src/lib/connection-state.ts`, pura e testável):
- **`ConnectionTracker`**: fonte única de estado com **fencing por geração**.
  Cada `startWhatsAppInner()` abre geração nova; eventos/timers de gerações
  velhas são descartados (`isCurrent`). Mutex `starting` impede duas
  inicializações paralelas; `startWhatsAppInner` remove listeners e encerra
  socket anterior antes de criar outro → **no máximo 1 socket ativo**.
- **`FencedTimer`**: no máximo 1 retry pendente; agendar cancela o anterior e
  só dispara se a geração ainda for corrente.
- **Classificação de queda** (statusCode Boom / `DisconnectReason` real do pacote):
  | code | reason | retry auto | apagar creds |
  |---|---|---|---|
  | 401 | `logged_out` | ❌ (ação: parear de novo) | ✅ (logout CONFIRMADO) |
  | 440 | `connection_replaced` | ❌ (ação: revisar aparelhos) | ❌ |
  | 403 | `forbidden` | ❌ (bloqueio/ban — **QR NÃO resolve**, hint diz isso) | ❌ |
  | 500 | `bad_session` | ❌ (ação: parear de novo) | ❌ |
  | 411 | `multidevice_mismatch` | ❌ | ❌ |
  | 515 | `restart_required` | ✅ backoff | ❌ |
  | 503 | `service_unavailable` | ✅ backoff | ❌ |
  | 428/408/outros | `connection_closed`/`timed_out`/`unknown` | ✅ backoff | ❌ |
- **Credenciais**: só são apagadas em logout explícito (`POST /api/logout`) ou
  401 `loggedOut` confirmado. Nunca em queda transitória/badSession/forbidden.
- **Backoff exponencial com teto** (3s → 5min, base 2, reset ao conectar):
  mata retry storm; 1 timer pendente no máximo.
- **QR**: TTL 60s (`QR_TTL_MS`). Expirou → `qr=null`, `reason=qr_expired`,
  `actionHint` manda o usuário pedir novo via `POST /api/connection/reconnect`.
  Nenhum loop automático de re-geração de QR.
- **QR/PII fora do terminal**: impressão via `qrcode-terminal` removida; QR só
  sai pelo `GET /api/status` (autenticado). Logs usam apenas códigos/motivos.

### Contrato de status (aditivo, backward-compatible)
`GET /api/status` continua com `connected/qr/me/syncing` (mesmos significados:
`qr` só não-nulo enquanto não expira) e adiciona:
`connectionState` (`connecting|connected|reconnecting|qr_required|action_required|disconnected`),
`reason` (códigos seguros da tabela acima + `qr_expired`/`stopped`/`unknown`),
`actionHint` (texto seguro, sem PII/erro cru), `updatedAt`, `lastConnectedAt`,
`qrExpiresAt`, `readOnly: true`.

`POST /api/connection/reconnect` (novo): encerra socket atual, inicia tentativa
nova (novo QR quando for o caso). Não apaga credenciais. Seguro em qualquer estado.
`POST /api/logout` e `GET /api/status` preservados.

## 2. Auth/CORS/limites

- **CORS allowlist** (`buildCorsAllowlist`): `CORS_ORIGINS` (vírgula, `*` curinga)
  substitui o default; default = `http://localhost:*`, `http://127.0.0.1:*`,
  `https://suco-de-zap.pages.dev`, `https://*.suco-de-zap.pages.dev` (previews) +
  `PUBLIC_DOMAIN` se configurado. Sem origem (same-origin/curl) passa; origem
  desconhecida não recebe headers CORS (preflight → 403) e **métodos de escrita
  (POST/PUT/PATCH/DELETE) de origem desconhecida são 403 na entrada — não agem
  por CSRF**; GET de origem ruim processa sem ACAO (browser não lê a resposta).
  `cors()` aberto removido.
- **Trust boundary de rede / identidade de cliente**:
  - **Bind default `127.0.0.1`** (`HOST`/`BIND_HOST` para override explícito de
    legado, ex. `0.0.0.0` — decisão consciente, nunca default). O caminho público
    é o adapter/tunnel na MESMA máquina, preservando o bind loopback.
  - **`X-Forwarded-For`/`x-real-ip` NUNCA identificam cliente** (forjáveis por
    qualquer cliente; rotação de header não evade o limite — testado).
  - **`CF-Connecting-IP` é confiável só com `TRUST_CLOUDFLARE_PROXY=true` E
    conexão vinda de loopback** (`c.env.incoming.remoteAddress` do adapter) —
    configuração que pressupõe bind localhost; com bind exposto + flag ligada,
    qualquer cliente forjaria a identidade.
  - Sem confiança de CF: rotas de abuso usam **chave estática global** (1 entrada,
    bornada) e operações autenticadas usam **chave por conta (token)** — limite
    da conta independente de IP.
- **Rate limit** (`RateLimiter`, janela fixa, relógio injetável, **mapa bornado**:
  `maxKeys` com eviction de janelas expiradas/mais antiga — sem DoS de memória):
  - falhas de auth: 30/15min (bucket global ou por IP confiável do CF) → 429 + `Retry-After`;
  - `POST /site/waitlist`: 10/min (idem);
  - operações caras de LLM (`summaries/generate`, `digests/generate`,
    `facts/extract`, `facts/retag`, `search`): 30/5min **por conta** (autenticado);
  - **concorrência de IA = 1** (`AiConcurrencyGate`): operação já em andamento →
    429 imediato com `Retry-After` (não enfileira);
  - **LLM desligado/não configurado → 503 imediato** com `Retry-After: 300`:
    geração nem é aceita (o cliente não fica 5 min aguardando na fila).
- **Body size**: middleware **oficial `hono/body-limit`** (streaming, conta BYTES
  de verdade e corta a leitura no teto) aplicado a **TODAS as rotas, sem bypass**
  — teto global 256 KiB; waitlist reaperta 16 KiB em `parseJsonBody` (que agora
  conta bytes do `arrayBuffer`, não unidades UTF-16 — emoji 🚀 = 4 bytes/2 units);
  JSON inválido/array/null → 400.
- **`Cache-Control: no-store` em toda `/api/*`** (status/QR/resumos incluídos),
  inclusive em respostas curtadas (401/413/429/503); `/ready` também.
- **`/health`**: liveness puro (`{ok:true}`), sem dependências.
- **`/ready`**: checa PG (`SELECT 1`) e LLM. Probe: **`LLM_READY_URL` (ex.
  `http://127.0.0.1:8378/ready` da llm-queue)** com precedência; sem ela, cai no
  `GET /models` direto. 503/erro de rede = `unreachable` (**erro não vira ok**).
  Timeout 2s, cache 60s (`LlmReadiness`). Sem segredos na resposta. **Fora de
  auth a resposta é genérica** (`{ok:boolean}`); detalhe de componentes só com
  token. 503 quando não pronto.

## 3. Guards de IA no cron
Antes de digest/extração/sucos: `llmAvailable()` — se não há LLM configurado, ou
o Qwen local está off (probe barato falha), a tarefa **pula com log** em vez de
queimar a rodada. Dados/leituras existentes intactos (guard só evita chamada nova).

## 4. Provisionamento (`deploy/novo-usuario.sh`) — endurecido, NÃO executado
- **Nunca grava falso aceite**: default escreve `provisionamento.txt` com
  `Status: PENDENTE`; aceite só com `--aceite "declaração literal"` (autoria de
  quem provisiona, texto nunca inventado pelo script).
- **Slug × DB**: hífen→underscore na criação do DB + slug com `_` rejeitado
  (evita `a-b` vs `a_b` colidirem) + checagem `pg_database` antes do `createdb`.
- **Lock**: `flock` em `$BASE/.provision.lock` serializa porta/DB/diretório
  (duas execuções paralelas não pegam a mesma porta nem o mesmo DB).
- **Porta**: incrementa até achar porta livre (`ss -ltn`), não só max+1.
- **Permissões**: `umask 077`; `chmod 700` no diretório da instância,
  `auth_state` e `logs`; `.env` continua 600.
- **Roles PG futuros**: limitação documentada no script (hoje 1 role compartilhado)
  + receita comentada de `CREATE ROLE suco_<slug>` por instância.

## 5. Testes (node:test + tsx, sem rede real)
- `tests/connection-state.test.ts`: máquina (QR→conectado→quedas por código),
  fencing de geração, backoff/teto, expiração de QR, política de creds, `FencedTimer`
  com timers falsos (cancelamento + descarte de geração velha),
  **`markStopped` invalida geração (start pendente morre)**, **`markSyncing`
  true- durante o lote / false- ao terminar (estado real)**.
- `tests/http-guards.test.ts`: allowlist CORS (default/config/origem ruim),
  `RateLimiter` (janela, 429, reset, **teto `maxKeys` com eviction**),
  **`AiConcurrencyGate` (concorrência 1, fail-fast, release idempotente)**,
  `isBodyTooLarge`, `validateWaitlistInput`, shape de `/ready` público vs detalhado.
- `tests/api.test.ts`: app Hono real com env de teste — 401/429 de auth,
  CORS preflight (permitida 204 / proibida 403), 413 de body na waitlist,
  `GET /api/status` autenticado com campos aditivos, `/health`.
  **Round 2:** rotação de XFF/x-real-ip/cf-connecting-ip NÃO evade o bucket
  global; **bodyLimit streaming com `ReadableStream` sem content-length** (6.000
  emojis = 24 KiB em bytes vs 12 K units UTF-16 → 413; 300 KiB no teto global →
  413); **JSON `[]`/`null` → 400 limpo**; **CSRF: POST de origem desconhecida →
  403 (autenticada e pública), sem Origin passa, LLM off → 503 com Retry-After**;
  **`Cache-Control: no-store` em `/api/*` inclusive em erro**.
- `tests/llm-readiness.test.ts`: probe falso (ok/unreachable), cache TTL com
  relógio falso, `not_configured`, **precedência de `readyUrl` sobre `/models`**,
  **`httpProbe` real contra servidor HTTP local (200/404/503/porta morta)**.
- `tests/llm-queue.test.ts`: **processo real da fila** (`tools/llm-queue.mjs`)
  em porta efêmera com upstream falso local: `GET /ready` → 200 com upstream no
  ar (fallback `/health`→`/v1/models`), **503 quando o upstream morre** (TTL
  vencido), passthrough `/v1/models`, e **probe do backend via `LLM_READY_URL`
  vendo ok→unreachable**. Não toca o serviço de produção nem sobe modelo.
Comandos: `npm run typecheck` (src), `npm run typecheck:test` (src+tests),
`npm test`, `npm run build`.

## 6. Limitações honestas
- Rate limit é por processo/em memória (reinício zera) — ok p/ single-instância.
- `TRUST_CLOUDFLARE_PROXY` sem tunnel/adapter real de loopback não tem efeito
  (o header é ignorado fora do loopback) — mas se alguém ligar a flag E expor
  o bind na LAN, o CF-IP volta a ser forjável: a combinação é proibida por design.
- LLM remoto (Anthropic) não tem probe barato — `/ready` marca `ok` sem testar.
- Isolamento PG entre usuários ainda é por database, não por role (ver §4).
- `llm-queue` nova (com `/ready`) só entra em vigor quando o Root reiniciar o
  serviço da fila (não foi reiniciado aqui); até lá o backend sem `LLM_READY_URL`
  continua probando `/models` — que a fila deste staging já faz passthrough.

## 6a. Correções da rodada 2 (revisão pós-deploy-1)

1. **clientIp/bind** (§2 trust boundary): bind default localhost
   (`HOST`/`BIND_HOST`), fim do XFF como identidade, CF-IP só com flag +
   loopback, `RateLimiter` bornado (`maxKeys` + eviction), chaves global/por-conta,
   concorrência IA 1 + 503 quando LLM off.
2. **Body**: `hono/body-limit` oficial (streaming, bytes, sem bypass) +
   `parseJsonBody` por bytes; testes reais com ReadableStream chunked sem
   content-length, emojis UTF-8 e JSON array/null; CSRF bloqueado em escrita
   de origem desconhecida.
3. **start/logout race**: `beginAttempt()` ANTES do primeiro await; recheck
   `stopped`+geração antes de cada continuação e na criação do socket;
   `markStopped()` invalida a geração; `logout` desapega do socket antes do
   await de logout; TODOS os handlers de evento cercados por `isLive()`
   (socket corrente + geração corrente + não-stopped) inclusive os loops de
   escrita de DB do history sync; authdir não é limpo em falha transitória
   (política 401-only preservada); `markSyncing` reflete o lote real.
   Erros de startup (version fetch/auth state) viram estado explícito +
   UM retry cercado (backoff/fencing) — sem 'connecting' eterno nem storm.
4. **Startup**: `serve()` ANTES de `initDb()`/WhatsApp — API/QR/reconnect não
   esperam PG nem o fetch de versão do WA.
5. **LLM ready**: fila ganha `GET /ready` (probe real `/health`→`/v1/models`,
   TTL + timeout + single-flight, 503 offline, erro nunca mascara); backend
   ganha `LLM_READY_URL` (precedência sobre `/models`). Confere do staging:
   a fila JÁ tinha passthrough `GET /v1/*` (linha do `llm-queue.mjs`), logo o
   probe antigo NÃO dava false negative aqui — `/ready` adicionado mesmo assim
   como rota de readiness própria. MODEL default e Qwen/Muse intocados.
6. **Misc**: `Cache-Control: no-store` em `/api/*` + `/ready`; logs sem
   QR/nome/JID de contato (identificadores anonimizados com sha256-8);
   nenhuma chamada Baileys de send/read/presence (grep conferido); nenhum
   retry de operação paga do usuário (`callLLM` single-shot, sempre foi).
- Mensagens view-once: **não tocamos** na extração (o.unwrap já ignora conteúdo
  protocollar; política de view-once fica p/ decisão futura, como pedido).
- `logoutWhatsApp` mantém o comportamento original de reiniciar p/ gerar novo QR.
