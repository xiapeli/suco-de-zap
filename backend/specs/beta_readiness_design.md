# Aceite do beta — 15/10/2026

Pedido: publicar a LP r3 aprovada e validar a engine antes de testers. A aprovação visual não comprova integridade do host nem libera os workers contidos.

## Escopo desta correção

O cliente de reservas freemium ainda decodifica respostas sem o limite de 64 KiB aplicado ao autorizador. Também não exige confirmação de estado no commit/release. Usar o leitor limitado existente, impedir redirects de POSTs assinados, manter o timeout durante a leitura e converter respostas inválidas em indisponibilidade sem expor conteúdo. Conferir a coerência de estado/allowed/access/reservationId: reserva sem ID é legítima para owner/pago; trial exige ID. Commit e release só terminam após estado esperado.

Interface: erros continuam usando TRIAL_VERIFICATION_UNAVAILABLE/503 e a mesma operação pode reconciliar confirmações sem executar IA novamente. Backend: alteração restrita a SignedTrialControl; não modificar ledger, oferta, autenticação, WhatsApp ou regra de cobrança. Segurança: HMAC continua vinculado ao caminho e corpo, resposta limitada, redirects recusados, nenhuma chave real nos testes.

## Validação

Executar testes sintéticos com Node nativo em diretório próprio contendo apenas fontes revisadas, com transformador TypeScript nativo, sem node_modules/provedor/banco real/credenciais. Cobrir owner/pago legítimos, trial legítimo/negação, resposta inconsistente, corpos grandes/fracionados/parados, estados de commit/release e requisição assinada. Registrar primeiro a falha da regressão, depois a correção. Essa execução local não é prova de recuperação do FAEX1 nem substitui build/typecheck/suíte/fluxos em host confiável.

## Aceite de testers pendente

Reconstrução em destino limpo e rotação em dispositivo confiável; suítes backend/controle/UI e PG concorrente; duas contas isoladas; cadastro/verificação/reset/logout; três resumos com franquia atômica e sem repetição paga; reconexão WhatsApp e histórico parcial explícito; Cofre fechado/timeout/filtros/fonte; orçamento e falha do provedor; backup fora do host com restauração; capacidade real e admissão. Sem essas provas o estado é NÃO LIBERADO.
