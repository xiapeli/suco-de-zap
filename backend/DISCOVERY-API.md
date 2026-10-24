# POST /api/discover

Autenticação bearer e autorização de tenant antes da rota; acesso de leitura dos sucos já salvos, inclusive freemium. Mesmo banco dedicado da biblioteca. Escopo de gerenciamento não permite esta rota. Não gera IA nem reserva/consome cotas; não consulta wa_messages/facts nem altera Cofre.

Body JSON: query:string (1–500 caracteres, sem controles), offset:integer (opcional0, máximo1000). Teto4KiB e limite30requisições/min por worker/conta, além dos guards globais. SQL parametrizado; escapa % e _ na comparação literal. Stemming português e expansão limitada de palavras de intenção. Ordem: frase exata, todos os termos, ranking título/conversa/conteúdo, data e ID. Retorno20itens/página, não apenas os primeiros100 da biblioteca.

Resposta: {results:[{id,chat_jid,chat_name,title,analysis_type,period_start,period_end,created_at,excerpt}],total,saved,nextOffset,scope:'saved_summaries',generated:false}. Trecho é texto; renderizar com escaping normal, jamais innerHTML. Sem conteúdo bruto/fatos/modelo/chaves. 400entrada inválida,401sem autenticação,402entitlement indisponível,403escopo,413teto,429limite comRetry-After,503busca indisponível. Respostas herdando Cache-Control:no-store.

Limites: busca lexical, sem embeddings/LLM; não entende qualquer pedido nem busca arquivos. Páginas offset podem mudar quando novos sucos são salvos; UI deduplica IDs. Ao atingir o teto de paginação, refinar o assunto. Driver query_timeout8000ms; não é statement_timeout do servidor. Sem migração/index novo nesta etapa. Identidade/incidente/rotação/chaves/novas ativações continuam sob as regras vigentes da recuperação.
