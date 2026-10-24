# Onboarding — revisão15/10/2026

Jornada solicitada porPhelipe e implementada emsrc/pages/Onboarding.tsx; brief e evidências em../../marketing/onboarding-senior-20261015. IdentidadeSurf/LP preservada. Objetivo é primeiro resumo útil com origem, não concluir um tutorial de features.

- Conta/e-mail e consentimento Convex existentes. Ao conectar o espaço, registrar o mesmo consentimento no worker antes de navegar. Não adicionar outro pedido de autorização para quem já autorizou na conta.
- Três intenções de resumo, conexão poraparelho, conversa/período/contagem, resumo salvo. Perfil deautomação é escolha posterior; não acompanha conversa por efeito colateral.
- Progresso emmetadata própria pororigem validada daAPI. Nada deconversas,senhas,QR,tokens ourespostas geradas emlocalStorage. Limpeza nologout e signOut nativo Convex nomenu.
- PrimeiroPOST exigeUUID+payloadgravados. Reload/erro usa mesmo pedido.502/503 não comprovam falha terminal; não criam novoUUID. Erro terminal explícito permite revisar escolhas por ação humana.
- Ausência de mensagens/período vazio/QRvencido/restrição/serviço sem resposta/storage bloqueado/cotaesgotada têm recuperação explícita e sem falso progresso.
- Testes depolítica/persistência emtests/onboarding-state.test.ts comNode nativo e browser comfontes reais eAPIsfictícias. Nenhuma conclusão sobrewhatsappreal/cadastro/remoto recuperado nestehost.

## Projeto anterior, preservado para histórico

# Onboarding e reconexão
Requisito: primeiro resultado real e recuperação clara sem perda de dados. Frontend nunca autentica por parâmetroURL nem usa chaveStripe; conta vinculada emConvex e acesso dados exige tokenporinstância independente. Loginlegacy existente preservado como acessoassistido.
Consentimento explícito não préselecionado antes de exibirQR/ativar nova conexão, salvo no backend quandoendpointdisponível. Preferências automáticas são por conversa; informar ingestãoatual ampla. Primeiroresumo usa chatcom mensagens dosúltimos7dias, sem envioWhatsApp, retornoIA renderizado escapado comreact-markdown. Sem retries automáticos de operaçõespagas.
GETstatus polling3segapenasforeground/query dedupe, GETreadiness30seg, reconnectPOST explícitoúnico pending. OfflineAPI≠QRnecessário; reconnecting≠ban; QRnovo invalidaanterior; datas apenas reais.
Testes: cenários sintéticos (semconvprivate) deconectado/QR/reconnecting/actionrequired/offline/sync/emptyAI503/resumo concluído,3203907681440 e interação teclado. Produçãonãoseafirma até auth/tenant/IA eHTTPS reais.
