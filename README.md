# Suco de Zap

Resumo diário dos seus grupos de WhatsApp, com arquitetura **zero-knowledge**:
o servidor nunca vê o conteúdo das conversas em claro. A chave de cada usuário
nasce no navegador, as mensagens são cifradas com AES-256-GCM antes de deixar o
ambiente confidencial e o resumo ("suco") é gerado por um LLM dentro de uma VM
atestada (Google Confidential Space). Áudios de voz são transcritos dentro do
mesmo ambiente e nunca persistidos.

> ⚠️ **Leia antes de conectar um número:** o projeto usa Baileys, que não é a
> API oficial do WhatsApp. Há risco real de banimento do número.
> Veja [`SECURITY.md`](SECURITY.md) e [`docs/TERMO-DE-RISCO.md`](docs/TERMO-DE-RISCO.md).

## Como funciona

```
WhatsApp ──Baileys──▶ Worker (VM Confidential Space, imagem medida)
                        │  decodifica/transcreve áudio (ffmpeg + GLM-ASR)
                        │  cifra com a chave pública do usuário (AES-256-GCM)
                        ▼
                  Supabase (só blob cifrado: suco_private_messages)
                        ▲
Navegador ──chave local──┘ (a chave nunca sai do dispositivo do usuário)
                        │  pede o suco → worker decifra, resume (GLM-5.3),
                        │  re-cifra a resposta
                        ▼
                  Interface web (React + Vite)
```

- **Zero-knowledge do operador:** sem a chave do navegador, o banco é apenas
  ruído. Um `SELECT` no Supabase não revela mensagem nenhuma.
- **Atestado remoto:** a VM só libera as chaves do Secret Manager se a imagem
  medida conferir com o pin de deployment do tenant.
- **Um worker por usuário:** isolamento total de sessão WhatsApp, estado e
  memória entre contas.
- **A borda honesta:** o zero-knowledge protege contra o **operador** (banco,
  host, backups). Para gerar o suco, a VM decifra as mensagens e as envia por
  TLS ao provedor de IA que VOCÊ escolher (aqui, Zhipu/GLM) — o provedor, e
  qualquer entidade com jurisdição sobre ele, pode ver esse conteúdo. É o
  mesmo trade-off de qualquer assistente de IA; a diferença é que aqui a
  escolha de provedor é sua, e o caminho até ele é atestável.

## Módulos

| Pasta | O que é |
|---|---|
| `web/` | Interface React + Vite, onboarding com geração de chave no navegador |
| `backend/` | Motor Node/TypeScript: Baileys, cifra, extração e resumo com GLM-5.3, ASR |
| `confidential-channel/` | Entrypoint da VM confidencial, gateway operacional e Dockerfiles |
| `supabase/migrations/` | Schema SQL completo (controle de contas + plano privado cifrado) |
| `docs/` | Termo de risco e documentos de apoio |

## Requisitos

- Node 22+ (web e backend)
- Uma conta Supabase (grátis serve) para o schema e auth
- Para o worker completo: Docker, GCP com Confidential Space e uma chave da
  Zhipu/GLM (`open.bigmodel.cn`) — os testes rodam sem nenhum desses

## Rodando a interface (dev local)

```bash
cd web
npm install
cp .env.example .env.local   # preencha com o SEU projeto Supabase
npm run dev
```

## Rodando o motor local (modo legado)

O backend funciona standalone, sem GCP e sem TEE — aí o zero-knowledge não se
aplica e o motor vê as mensagens em claro do número que VOCÊ conectar:

```bash
cd backend
npm install
cp .env.example .env        # API_TOKEN, DATABASE_URL, LLM, crons
npm run dev
```

Escolha o cérebro dos sucos no `.env`: um servidor OpenAI-compatível local
(`OPENAI_COMPAT_URL`) ou Anthropic (`ANTHROPIC_API_KEY`). Sem LLM o motor
ingere e busca, mas não gera digest. Para apontar a interface para esse motor
local, use `VITE_SUCO_LEGACY_API_ORIGIN=http://127.0.0.1:8377` no `.env.local`
da web (origens não-pinadas são recusadas por design).

## Rodando os testes

Rode cada comando em um terminal próprio (dependências instaladas antes com
`npm install` na pasta correspondente):

```bash
# backend/ — 238 testes: motor, cifra, ASR, guards
npm test

# web/ — 55 testes (interface, onboarding, canal confidencial)
node --experimental-transform-types --test 'tests/*.test.ts' 'tests/*.test.mjs' 'scripts/*.test.ts'

# confidential-channel/ — 8 testes (gateway operacional, origem, capacidade)
node --test test.mjs operational-gateway.test.mjs private-daily.test.mjs

# backend/ — suites SQL contra um PostgreSQL 16 descartável (Docker):
# 5 arquivos, exercitam schema, RLS e RPCs de verdade
bash tests/run-sql-pg-tests.sh
```

## Montando o seu Supabase

1. Crie um projeto e aplique **apenas** `supabase/migrations/0000_fresh_install.sql`.
   É a instalação consolidada (schema, RLS, RPCs) e funciona sozinha num banco
   vazio — não aplique os arquivos de `legacy/` em cima dela.
2. `supabase/migrations/legacy/` guarda as migrations **históricas** do
   deployment original (ordem documentada no `legacy/README.md`), inclusive
   templates com placeholders (`owner@example.com`, UUIDs `00000000-…`).
   Use só para entender a evolução do schema — os placeholders nunca devem
   ir para produção.
3. A instalação nova já nasce **fechada**: admissão desativada, `email_grants`
   de exemplo desabilitados e o `private_storage_gate` com escrita desligada.
   Cadastre os usuários no Supabase Auth, confirme os e-mails e habilite os
   grants e o gate com a SUA data migration — sem isso nada escreve, por design.

## Conectando a sua IA (chave GLM)

O resumo ("suco") e a transcrição de áudio usam a API da Zhipu/GLM
(`open.bigmodel.cn`). **Cada deployment usa a própria chave** — nenhuma chave
vem neste repositório. Crie a sua em `open.bigmodel.cn` e escolha o caminho.
Lembre da borda de confiança: o provedor recebe o conteúdo em claro por TLS
(o TEE protege contra o operador, não contra o provedor de IA — escolha um em
cuja jurisdição você confia para os seus dados).

**Motor local (sem TEE):** aponte um arquivo com a chave (permissão 0600):

```bash
export SUCO_GLM_REGULAR_KEY_FILE=/caminho/seguro/glm.key
echo -n 'sua-chave-aqui' > /caminho/seguro/glm.key && chmod 600 /caminho/seguro/glm.key
```

**Worker confidencial (TEE):** guarde a chave no Secret Manager **do seu**
projeto GCP e indique o recurso completo na VM:

```bash
printf %s 'sua-chave-aqui' | gcloud secrets create suco-glm-regular --data-file=-
export SUCO_GLM_SECRET_RESOURCE=projects/SEU-PROJETO/secrets/suco-glm-regular/versions/latest
```

Sem `SUCO_GLM_SECRET_RESOURCE` o worker recusa buscar qualquer segredo
(fail closed). O acesso ao secret só é liberado à VM com atestado válido.

## Deploy do worker confidencial (visão geral)

1. `docker build -f confidential-channel/Dockerfile.worker .` a partir da raiz.
   A Confidential Space só permite `TUNNEL_TOKEN` como env em runtime — todo o
   resto é "assado" na imagem via build-arg: `SUCO_SUPABASE_URL`,
   `SUCO_SUPABASE_PUBLISHABLE_KEY`, `SUCO_GLM_SECRET_RESOURCE` e
   `SUCO_CHANNEL_ALLOWED_ORIGIN` (a origem da sua web que pode abrir canal;
   sem ela todo request com `Origin` é negado — fail closed).
2. Faça push da imagem para o seu Artifact Registry e suba uma VM
   **Confidential Space** por usuário (`tee-image-reference` aponta o digest).
3. O `deployment-pin.mjs` do repo é um placeholder fail-closed; o seu release
   deve "assar" o pin real (ownerId + fingerprint) na imagem antes do push.
4. A chave GLM fica no **seu** Secret Manager (ver seção anterior) e o acesso
   é condicionado ao atestado: conceda `roles/secretmanager.secretAccessor`
   à service account da VM apenas com uma condição CEL que exija o
   **digest da imagem** esperado (campo `attribution` do atestado no
   `request.auth`), por exemplo
   `request.auth.attribution.contains('SEU-DIGEST-SHA256')`. O túnel
   Cloudflare (`TUNNEL_TOKEN`) expõe o worker à interface.
5. Na web, preecha os pins do worker (IDs, URLs, digests, projeto/zona GCP do
   atestado) em `web/.env.example` — sem eles o canal fica fechado.

Os scripts de release/ops do deployment original (build, cutover, rollback,
backups) ficam fora deste repositório — o pipeline aqui é o código de produto.

## Transcrição de áudio

Áudios de voz viram texto pesquisável: dentro do TEE o ffmpeg decodifica o
opus para WAV 16 kHz mono, fatia em janelas de até 30 s e a GLM-ASR transcreve
com contexto acumulado. O áudio nunca é persistido; buffers são zerados e o
diretório temporário destruído. Falha degrada para `[audio]` sem travar a
ingestão.

## Estado do projeto

Em produção em escala pequena (poucas contas, cadastro fechado por grants).
Funciona ponta a ponta: pairing QR, ingestão cifrada, resumo diário com GLM-5.3
e transcrição de áudio. Veja `backend/DISCOVERY-API.md` e `backend/JUICE-CATALOG-API.md`
para os contratos internos.

## Licença

MIT — veja [LICENSE](LICENSE).
