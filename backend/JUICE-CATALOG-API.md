# Modelos de suco e geração por tema

17 modelos existentes preservados por ID e SHA256 dos prompts originais; custom continua separado. Canônico: src/data/juice-catalog.json, versão suco-17-v1. scripts/sync-juice-catalog.py gera somente metadados do web; --check detecta divergência. Ao alterar o significado de um prompt, publicar uma versão de catálogo apropriada; não mudar o conteúdo silenciosamente sob a mesma versão.

GET /api/juice-catalog exige auth/tenant e retorna {version,types:[metadados]} com Cache-Control:no-store, sem prompt/IA/quota. Tipo custom é aceito como pedido livre e não conta entre os17.

POST /api/summaries/generate mantém chat_jid,start,end,request_id; novo contrato inclui template_version e analysis_type canônico. focus opcional até2000caracteres para tema. Cliente não envia base_prompt para temas conhecidos; motor ignora substituição do browser e usa o prompt canônico. Custom envia base_prompt obrigatório até10000. IDs/versões/foco inválidos falham antes de SQL/IA/quota dentro do motor. Prompts incluem foco e regras de evidência, sem inventar valores, prazos, intenções ou diagnósticos; contexto completo da conversa/período é fornecido pelo summarizer existente. Foco orienta saída; não é filtro SQL nem nova busca semântica/RAG.

Compatibilidade: chamadas legadas sem template_version mantêm o prompt exato e o fingerprint anterior (onboarding/cron/retries). Chamadas versionadas incluem prompt efetivo e versão na identidade. Nova UI confere catálogo do worker antes do POST, evitando geração genérica silenciosa se o backend ainda for antigo. Deploy UI+backend juntos; preview atual NÃO é release de produção.

Web persiste somente UUID/corpo do pedido em chave por origem de API, com allowlist, readback antes do POST e proteção contra sobrescrever outro pedido. Não guarda mensagens, nomes de contato, QR ou tokens no rascunho. Em resposta incerta, recarregar/navegar exige retomada explícita do mesmo UUID/corpo; armazenamento indisponível/corrupto bloqueia novas gerações. Logout apaga rascunhos manuais. Nome da conversa e contagem real são consultados na retomada via rotas já autenticadas. Alterar tema/período mantém o tema/foco escolhidos; escolha de conversa usa botão nativo separado de automação.

Testes: original17SHA, resolução17+focus/custom, metadataauth/no-store, legado, IDsinválidosantesdeSQL; web28testes, backend105PASS/3PGskip, QA20POSTsFICTÍCIOS/0providers em3larguras. Não é aceite de saída real dos17modelos nem do histórico WhatsApp completo. Segurança/novas admissões/runtime atuais não foram alterados.
