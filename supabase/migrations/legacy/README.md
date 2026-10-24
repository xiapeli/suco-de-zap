# Histórico incremental (referência)

Estes 15 arquivos são o histórico real de evolução do deployment de referência
do projeto. Eles **dependem do plano de importação legado** (schema
`suco_migration`, snapshots e vínculos de conta antigos) que não faz parte de
uma instalação nova e foram removidos do caminho principal.

**Para um deployment novo, aplique apenas `../0000_fresh_install.sql`.**

Não aplique estes arquivos sobre uma base que já recebeu o fresh install: a
ordem alfabética dos nomes não é a ordem de dependência (codex review,
finding 5) e os templates de dados exigem o plano legado preenchido (finding 6).

Ordem de dependência correta, se for reproduzir o histórico do zero em um
laboratório:

1. 20261022_stage_control_metadata
2. 20261022_control_accounts
3. 20261023_cipher_objects
4. 20261023_confidential_auth
5. 20261023_ingestion_spool
6. 20261023_private_messages
7. 20261023_private_metadata
8. 20261023_private_message_read
9. 20261023_cipher_delete
10. 20261023_owner_identity_handoff
11. 20261023_private_onboarding_consent
12. 20261023_bootstrap_partner_accounts
13. 20261023_owner_reset_intent
14. 20261023_preserve_owner_account
15. 20261023_private_account_write_gate

Os quatro marcados como TEMPLATE no cabeçalho carregam placeholders
(e-mails, UUIDs, hashes) — troque pelas identidades reais antes de aplicar.
