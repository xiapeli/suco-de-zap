# Buscar no Suco — 16/10/2026

Modo: Operate. Pedido de Phelipe: entrada tipo Google depois de conectar, linguagem natural, lista de sucos relevantes e próximo suco pronto para preparar. Direção já definida pelo usuário; extensão da marca existente, sem troca de identidade.

## Experiência
Uma pergunta central: “O que você quer tirar do seu zap?”. Campo amplo com busca explícita, exemplos preenchíveis, acervo recente abaixo. Ao buscar, a composição se compacta e mostra resultados em lista: título clicável, trecho textual, conversa e período. Resultados são sucos JÁ salvos, não respostas novas inventadas. O pedido pode ser levado a Conversas para escolher fonte e período antes de gerar. Nunca consumir IA ao digitar/buscar. Pix/e-mail/telefone/endereço levam ao Cofre com filtros e texto opcionais; senha e entitlement preservados. Estado vazio explica a cobertura e oferece preparar um suco. Sem busca em PDF/áudio/telefone completo.

## Sistema visual
Papel #f7faed, folha #183c2c, secundário #526b56, ação lima #d9f779, Cofre lavanda #e8ddfb, resumo do dia pêssego #ffe0c5. Manrope local 400/800. Busca central, largura 800px; resultados alinhados à esquerda; navegação existente. Proximidade e espaços 8/16/24/32/48/64, fundamentos Surf já recuperados (bordas/espaçamento/tipografia/layout). Sem divisórias ou caixas por resultado. A assinatura memorável é o pedido em linguagem brasileira; os controles continuam familiares. Comparado ao dashboard de três cartões, uma única ação domina.

## Backend / segurança
POST /api/discover, autenticação e autorização de tenant existentes antes da rota; banco dedicado por tenant. Busca local determinística em summaries, com stemming português, ranking por título/conversa/conteúdo, intenção vocabular limitada e SQL parametrizado. Não é busca semântica universal. Paginação limitada 20/1000; tempo de query limitado; rate limit por conta. Não retorna mensagens brutas, fatos, conteúdo de anexos, nem chama IA. Resumos seguem o mesmo acesso da biblioteca existente. Texto tratado como texto React, sem HTML de ts_headline. Erros sem SQL/dados privados. Cache-Control no-store; consulta em corpo POST, sem URL/storage local. Sem mudanças em quotas, consentimento, Cofre ou cobrança.

## Aceite
- Busca com Enter/botão, exemplos preenchíveis, vazio/loading/erro/paginação e abertura do suco com fonte.
- Nenhum POST de geração em busca/abertura; cotas intocadas.
- Pedido via estado de navegação (não URL) chega a Conversas; usuário confere conversa/período e prompt.
- Categoria sensível aponta ao Cofre sem consultar dados protegidos; nenhum bypass de senha/402.
- Busca percorre todos os sucos no banco, não apenas os primeiros 100 do navegador.
- Acessível por teclado; foco nos resultados/limpar/voltar; 390 e 1440 sem overflow, também 320.
- QA com dados fictícios identificados; build real separado do preview, sem credenciais novas.

## Limites
Sem implantação automática deste fluxo até validar o endpoint na reconstrução e revisar a interação. Continuidade owner já autorizada; novas admissões seguem pausadas e incidente de credenciais segue pendente. Artefatos de publicação anterior permanecem históricos.
