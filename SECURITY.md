# Segurança

## Modelo em uma frase

O servidor nunca vê nada em claro: a chave de cada usuário nasce no navegador,
as mensagens são cifradas com AES-256-GCM antes de sair do ambiente confidencial
e o resumo é gerado dentro de uma VM atestada (Google Confidential Space).

## O que este repositório contém

- Código do motor (backend), da interface (web), do entrypoint confidencial
  (confidential-channel) e do schema SQL (supabase/migrations).
- **Nenhuma chave, token, `.env` ou dado de usuário.** Tudo que é secreto entra
  por variável de ambiente ou Secret Manager no seu próprio deployment. O repo
  não aponta para nenhuma infraestrutura do autor: IDs de contas, URLs e pins
  de atestado vazio fail-closed até o deployer preencher os seus.
- Domínios públicos (ex.: `sucodezap.xyz` no CSP e no audience do atestado)
  aparecem como identificadores de referência; troque pelos seus ao fazer o
  seu deployment.

## Limitações honestas

- **O provedor de IA vê o conteúdo.** O zero-knowledge é do **operador**: a VM
  confidencial decifra as mensagens para resumir/transcrever e as envia por TLS
  ao provedor de IA configurado (Zhipu/GLM por padrão). O provedor — ou quem
  tiver jurisdição sobre ele — pode ler esse tráfego. Escolha o provedor
  conscientemente; não há criptografia de ponta até o LLM.
- **Baileys não é a API oficial do WhatsApp.** Conectar um número tem risco
  real de banimento. Leia `docs/TERMO-DE-RISCO.md` antes de usar.
- O atestado (attestation) prova qual **imagem** está rodando na Confidential
  Space; a confiança de ponta a ponta depende de você conferir o digest
  divulgado e o lock do pin de deployment no seu release.
- O acesso ao Secret Manager deve ser condicionado ao atestado (binding IAM
  com condição CEL exigindo o digest da imagem — ver README, seção de deploy).
  Sem isso, a service account da VM acessa o secret independentemente de qual
  imagem esteja rodando.
- A API oficial (Cloud API) não lê grupos pessoais de usuário; por isso este
  projeto usa Baileys. Registre um número que você aceita perder.
- Nenhum sistema é infalível: bug no navegador, extensão maliciosa ou um fork
  adulterado do worker quebram o modelo. Use o build medido, verifique digests.

## Reportar vulnerabilidade

Abra uma issue privada em Security Advisories no GitHub deste repositório.
Não abra issue pública detalhando exploração antes da correção.
