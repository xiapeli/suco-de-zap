# Cofre: reencontrar informações nas conversas

Pedido de Phelipe em 15/10/2026: procurar dados antigos (PIX, e-mails, contatos), escolher conversa/período, entender as funções do produto e configurar senha própria persistente.

## Comportamento

A consulta percorre mensagens armazenadas, independente do índice de fatos e sem enviar consulta/fontes ao provedor de IA. Recupera contexto próximo na mesma conversa para localizar chaves enviadas depois da mensagem com o rótulo. Mostra valores literais, conversa, data e trecho; candidatos não representam validação de titularidade ou chave ativa. Paginação mantém filtros e watermark do histórico. Datas da interface usam dias locais; limite final exclusivo.

Filtros: conversa, início/fim, tipo (tudo, PIX, e-mail, telefone, endereço). Cobertura mostra contagem e datas realmente armazenadas e distingue ausência no recorte de histórico não sincronizado. Não promete buscar arbitrariamente mensagens antigas que Baileys/WhatsApp não enviaram.

Senha escolhida pelo usuário, hash scrypt no servidor. Token adicional só em memória, sessão absoluta de 15 minutos, revogação por trancar/trocar senha. Recarregar/sair limpa acesso. Guardas no servidor para search/facts; cache e respostas pendentes no cliente não podem repovoar dados após bloqueio. Não altera proteção da área Conversas, nem adiciona criptografia dos dados. Sem fluxo de recuperação da senha do Cofre nesta entrega.

Guia interno explica Dashboard, Conversas, Sucos, Digest, Cofre e Configurações. Índice de fatos é secundário e atualização manual explícita; sua extração pode usar IA em nuvem. Busca local não gasta quota do provedor. Mantidos entitlement de proprietário/assinatura e freemium de três sucos manuais.

## Aceite

- Chave antiga recuperada apesar de muitas menções recentes sem valor.
- Mensagem vizinha, conversa, datas exclusivas e paginação estável verificados em PostgreSQL sintético.
- Consulta específica não mostra chaves de conversas sem correspondência.
- Sem senha/unlock válido, dados protegidos não saem pela API.
- Senha incorreta não desloga a conta principal; lock/expiração invalida cache e respostas em trânsito.
- Interface sem overflow mobile/desktop, fontes copiáveis e ausência contextualizada.
- Implantação preserva banco, volume de autenticação WhatsApp e binding do proprietário.

## Refinamento 15/10, 14h — tipo suficiente
Phelipe encontrou redundância: precisava selecionar Pix e digitar Pix. O texto agora é opcional quando há um tipo selecionado (Pix/e-mail/telefone/endereço); serve para refinar nome/assunto. Todos os tipos exige algum texto para evitar consulta indefinida. UI agrupa Dados financeiros→Pix e Dados de contato→e-mail/telefone/endereço, mantendo a distinção entre grupo e tipo realmente suportado. Validação igual na API e normalizador; qualificador vazio não restringe âncoras do tipo. Testes sintéticos PG e browser390/1440 cobrem tipo sem texto, texto refinando e todos+vazio bloqueado.
