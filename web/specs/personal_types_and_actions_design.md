# Tipos de suco personalizados e próximos passos

Data:16/10/2026. Status: tipos pessoais implementados nas fontes/prévia local; automações e agenda são desenho de produto, sem implementação ou deploy público. Continua as prévias Googlehome+17temas. Phelipe pediu salvar tipos próprios por situação/tema e trouxe a hipótese reunião→e-mail→convite. Última orientação: pensar UI/UX e estrutura inteira para não lançar automação incompleta. Nenhum convite real, OAuth novo, chamada de provider ou escrita em aplicação externa é autorizado por este exemplo hipotético.

## Decisões de produto

Três entidades, com nomes que o usuário entende:

1. Tipo de suco: instrução reutilizável da própria pessoa. Define o que procurar e como organizar; não é uma permissão para agir fora do app.
2. Suco pronto: execução daquele tipo sobre uma conversa/período, com resultado e mensagens de origem. Cada execução aponta para a revisão exata do tipo.
3. Próximo passo: proposta concreta derivada de evidências daquele suco. Pode pedir dados, ser descartada ou ser aprovada. Enviar um convite tem autorização própria; não acontece por existir um e-mail no resumo.

Manter os17tipos originais e o pedido livre. “Meus tipos de suco” ao lado dos modelos prontos. Criar/editar/duplicar/excluir modelos não consome processamento de IA; gerar um suco mantém as cotas já contratadas. Ações externas não são executadas durante leitura, geração, extração, edição de modelo ou retomada de pedido.

## Tipo personalizado — UX

Entrada: seção Meus tipos de suco na home, com Criar tipo de suco. Pode começar em branco ou adaptar um dos17temas. Exemplo:
- Nome: Reuniões com meus clientes.
- Categoria: Comercial (texto livre reutilizável; categorias derivadas dos modelos, sem cadastro extra obrigatório).
- O que este suco deve organizar?: Liste pedidos de reunião, quem pediu, e-mails enviados para esse fim, datas/horários mencionados e pontos ainda sem confirmação. Cite as mensagens.
- Como entregar?: campo de instruções/estrutura, com exemplo simples editável. Na primeira implementação pode fazer parte do mesmo texto, evitando formulário grande.
- Tema de base opcional: pedido próprio ou um modelo pronto. Herdar um modelo preserva seu prompt canônico no servidor; o navegador edita apenas o complemento.

Salvar não gera análise. Depois de salvar: Usar este tipo→conversa→período→foco opcional→conferir→Gerar meu suco. Modelos privados, sincronizados por conta; não somente localStorage. Editar cria revisão imutável, sem mudar um pedido que aguarda confirmação. Excluir tira da lista; preserva revisão necessária a execução/retomada antiga e não apaga sucos prontos. Duplicar gera nova identidade e mantém o original.

## Reunião — experiência completa

Exemplo com dados fictícios:
- Você: “Vamos marcar uma reunião? Me passa seu e-mail.”
- Ana: “ana@example.com”.

O resultado mostra: Pedido de reunião encontrado / e-mail identificado para revisão / mensagens de origem. Estado Falta combinar horário. CTA Preparar convite. Pedir data, hora, fuso, duração, título e agenda. Não criar compromisso só porque existe um contato. Um horário sugerido é diferente de um horário aceito.

Tela de revisão: destinatários, título, data/hora no fuso escolhido, duração, agenda do remetente, descrição que será compartilhada, local ou videoconferência se solicitado, evidências consultáveis. Não copiar o histórico inteiro nem dados internos para a descrição pública do evento. Mostrar claramente quais pessoas receberão notificação.

Se a agenda ainda não foi conectada: preservar rascunho e oferecer Conectar minha agenda; a conexão não equivale a confirmar o convite. Após conectar, voltar à mesma revisão. Botão final Criar convite e notificar participantes. Enquanto não houver recibo do provedor, não mostrar Concluído. Criado na agenda, notificação solicitada, entregue e aceito são estados distintos; resposta de criação não prova entrega/aceitação.

## Estados de uma ação

- needs_details: faltam dados ou há ambiguidade; completar/revisar, sem operação externa.
- ready_to_review: todos os campos necessários podem ser conferidos; nada enviado.
- needs_connection: falta autorização da agenda; rascunho preservado.
- awaiting_confirmation: revisão completa disponível ao usuário.
- executing: aprovação daquele conteúdo/revisão foi registrada e um trabalho foi iniciado.
- reconciling: houve timeout/resposta incerta; consultar o mesmo evento antes de tentar outra criação.
- completed: recibo real da agenda salvo; exibir link ao evento e o status observado.
- failed: falha terminal confirmada; comunicar causa recuperável sem alegar envio.
- dismissed: usuário descartou a proposta; não recriar automaticamente a mesma intenção em outro suco.

Alterar horário, destinatário, calendário ou descrição compartilhada invalida a aprovação anterior. Um texto no WhatsApp ou uma instrução no tipo de suco nunca conta como aprovação externa. Reconectar, recarregar ou gerar outro suco com as mesmas mensagens não dispara convite.

## Evidência e ambiguidades

A engine de leitura deve devolver achados estruturados junto do resultado, com referências verificáveis, não interpretar Markdown livre como comando. Cada campo extraído guarda sua mensagem de origem e posição literal quando aplicável; dados corrigidos pelo usuário ficam marcados como confirmação manual. Verificador consulta as fontes reais; não aceita só IDs alegados pelo modelo.

Um e-mail só deve ser associado a um convite se houver intenção de reunião no mesmo contexto e associação ao participante. Em grupo com múltiplos remetentes/assuntos, exigir revisão. Distinguir o e-mail do próprio usuário do e-mail do convidado. Se há negação, reunião cancelada ou duas opções de horário, não escolher silenciosamente.

“Amanhã às15h” depende da data da mensagem e do fuso da conversa, não do relógio de hoje do worker. Fuso do navegador não comprova o fuso do interlocutor. Phelipe usa Asia/Shanghai, enquanto contatos podem usar America/Sao_Paulo: mostrar ambos quando útil e exigir confirmação se a origem não deixa claro. Duração padrão pode ser sugerida como padrão editável, nunca atribuída à conversa como fato.

Endereço de e-mail deve vir literalmente da fonte ou ser digitado e confirmado, sem completar letras por IA. Um pedido “passa seu e-mail” sem resposta mantém campo em branco. Oferta “podemos falarsextaouterça?” não é compromisso confirmado.

## Motor e persistência

Usar o backend existente autenticado, Postgres dedicado por tenant e account_id originado da sessão verificada. Não colocar mensagens no Convex. Catálogo do sistema permanece versão suco-17-v1; tipos pessoais recebem UUID e revisões UUID imutáveis.

Entidades propostas:
- personal_juice_types(id,account_id,created_at,archived_at).
- personal_juice_versions(id,template_id,account_id,revision,name,category,instructions,base_type,base_prompt_snapshot,created_at).
- personal_juice_request_refs(account_id,request_id,template_id,revision_id,config_fingerprint); vincula o pedido original à receita e ao recorte exatos antes da geração.
- suco_action_proposals(id,account_id,source_intent_key,summary_id,template_revision_id,revision,payload_json,evidence_refs,missing_fields,status).
- suco_action_approvals(action_id,action_revision,payload_hash,account_id,approved_at).
- suco_action_outbox(action_id,approved_revision,provider_operation_id,state,attempts,last_error_code).
- suco_action_receipts(action_id,provider,event_id,observed_status,observed_at).

Toda consulta/alteração filtra account_id no servidor, incluindo revisão histórica. SQL parametrizado. Updates com revisão esperada para impedir sobrescrever alterações em outra aba. Criar/duplicar usa IDs de operação estáveis contra dupla gravação por resposta perdida. Limites de tamanho/quantidade/rate são guardas operacionais explícitos, não preço novo. Excluir não permite apagar revisão necessária a pedido em voo; leitura de revisão arquivada serve somente ao próprio usuário e à retomada autorizada.

Resolver tipo/revisão e instruções antes do processamento. Guardar UUID+corpo antesPOST como no manual-juice-request existente. Modelo define estrutura de saída; nunca pode registrar ferramentas arbitrárias, HTTP livre, SQL ou execução de código. Campos de ação passam por validação determinística e autorização da sessão; IA só propõe.

## Execução externa e duplicação

A proposta é separada da execução. Confirmar grava aprovação da revisão e trabalho na mesma transação; worker específico usa credencial da conta e calendário escolhido, com allowlist de operações. Permissões de Google/Microsoft são separadas do pareamento WhatsApp. Baileys continua só leitura.

source_intent_key deriva da conta e das mensagens/contexto que originaram o combinado, não apenas do ID do suco ou do texto que a IA resumiu. Assim, outro resumo das mesmas mensagens não cria outra reunião. Correções posteriores produzem uma revisão da proposta ligada à intenção anterior, sem enviar alterações automaticamente.

provider_operation_id é estável por ação aprovada e calendário. Em Google, ID de evento escolhido pelo cliente permite consultar/reconciliar a mesma operação; respeitar regras do ID e não alegar garantia absoluta de exactly-once do provedor. Em timeout, consultar evento pelo mesmo ID/recibo; não emitir segundo POST com novo ID nem reenviar notificações às cegas. Regras de retry finitas e estado desconhecido visível. Atualizar/cancelar evento é outra ação revisada e confirmada.

Criar Meet requer conferência nova por evento, solicitação própria e confirmação de que link foi gerado; não reutilizar link de outra conversa nem bloquear evento concluído atrás de spinner infinito. Checagem de conflito usa apenas agendas às quais a conta tem acesso; ausência de acesso não significa que o convidado está livre.

Tokens OAuth permanecem server-side e separados por conta, com escopo mínimo, criptografia em repouso e revogação. Logs sem e-mails, texto bruto ou credenciais; registrar IDs/estados e recibos mínimos necessários. Ao lançar ações, ajustar a promessa do produto para “não envia mensagens no WhatsApp”, distinguindo notificações consentidas da agenda. Não emitir credenciais novas no FAEX1 com incidente pendente.

## Entrega por etapas, com aceite

A. Tipos pessoais reutilizáveis: CRUD privado + revisão imutável + geração/retry com tipo salvo. Aceite de isolamento real entre duas contas, persistência após login em outro aparelho, revisão conflitante, arquivo durante pedido pendente e cota3 intacta. Implementado nas fontes, com CRUD privado, revisão e pedido fixo. Validação local com PostgreSQL sintético e UI; ainda sem publicação/aceite na conta de produção ou em outro aparelho.
B. Proposta de reunião: extração estruturada e fontes, coleta de dados faltantes, revisão e rascunho. Medir associação correta do e-mail e erros de data/negação/ambiguidade em corpus fictício PT-BR e depois beta consentido. Sem envio nesta fase.
C. Um conector de agenda completo: conectar, conferir disponibilidade acessível, confirmar, criar, reconciliar e apresentar recibo. Provider inicial pendente da resposta de Phelipe; Google documentado como primeiro candidato, arquitetura não depende exclusivamente dele.
D. Só depois avaliar regras automáticas aprovadas por usuário, com contatos/agendas/horários/limites definidos. Não lançar um montador genérico de automações ou um botão que apenas finge enviar.

Outros próximos passos que cabem no mesmo núcleo: tarefas com responsável/prazo para uma lista interna; lembretes de acompanhamento de cliente; rascunhos de resposta revisáveis. Priorizar um fluxo de reunião completo antes de multiplicar conectores. Nenhuma promessa de100kMRR depende só de adicionar automação; validar utilidade/confiabilidade/ativação com uso real.

## Fontes verificadas em16Oct

- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert : autorização, start/end, attendees[].email, sendUpdates, conferenceDataVersion, IDs e resposta.
- https://developers.google.com/workspace/calendar/api/guides/create-events : criação de evento, convidados e identificação da operação.
- https://developers.google.com/workspace/calendar/api/auth : seleção de escopo apropriado.

Consulta de documentação é pesquisa de produto; não é conector implementado, autorização OAuth obtida ou evento criado. As ferramentas Calendar disponíveis ao assistente não são integração SaaS por conta de cada cliente.


## Contrato implementado dos tipos pessoais

GET/POST /api/personal-juices; GET/PATCH/DELETE /api/personal-juices/:id. GET com revision=UUID retorna a própria revisão histórica, inclusive arquivada; o resolvedor só permite gerar com tipo arquivado se a conta/UUID/revisão/recorte/foco já foram vinculados exatamente antes do arquivo. Revisão histórica de outro usuário nunca é consultável. Arquivar impede pedidos novos, mantém histórico e reenvios idempotentes.

O formulário salva nome(80), categoria livre opcional(60), instruções(10000), base_type(custom ou um dos17). POST inclui id+revision_id UUID; PATCH inclui expected_revision e novo revision_id. Edição concorrente409 preserva o texto da tela; resposta incerta trava os campos para repetir o mesmo payload/UUID enquanto o formulário está aberto. Recarregar um formulário de criação com resposta perdida não tem retomada durável do rascunho nesta versão; a lista persistida permite conferir se foi salvo. Não confundir esse limite de edição de receita com o pedido de geração, cujo UUID/corpo é durável após reload/navegação.

Tipos aparecem na home e no seletor sob Meus tipos, com gerenciamento completo em /my-juices. Criar pode usar o exemplo editável de reuniões; duplicar preserva conteúdo e cria identidade nova. Excluir pede confirmação. Na revisão da geração, Conferir receita completa consulta a revisão fixada, sem gerar ou enviar nada. Os sucos pessoais usam nome da receita no título salvo; editar a receita não altera o título de sucos antigos.

Geração: analysis_type=personal:<UUID>, personal_revision=<UUID>, template_version=suco-17-v1 e focus opcional2000. Prompt é composto no servidor com snapshot canônico da base+instruções+regras de evidência. O navegador não substitui esse snapshot. GET/api/juice-catalog anuncia personalTypes:true; a UI bloqueia geração em worker antigo sem essa capacidade, mesmo se a versão dos17temas for igual. Limites:100 tipos ativos/conta e30 mutações/minuto; cada leitura/escrita filtra a conta verificada no servidor. A cota3 de geração usa o workflow existente; CRUD não chama IA/cobrança.

A prévia usa fixtures declaradas e sem upstream. O banco temporário de testes comprova persistência SQL e isolamento de contas com registros sintéticos; não comprova aceitação de IA real, sincronização de histórico WhatsApp, OAuth ou criação de evento. Os22cenários de automação continuam especificados e NÃO EXECUTADOS, porque o motor de ações ainda é futuro.
