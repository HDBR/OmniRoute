# Specsfy — OmniRoute (fork HDBR)

Escopo desta branch: diagnóstico seguro de respostas HTTP 429 do executor Antigravity/agy. Não altera escolha de conta, modelo, rota, retries, corpo enviado ao provedor ou deploy. Nunca registrar credenciais, prompts, valores de headers ou resposta upstream bruta no diagnóstico. O registro deve permitir distinguir status e reason conhecidos com testes offline; causa do 429 permanece não comprovada.

Contexto: [STACK.md](STACK.md), [DATABASE.md](DATABASE.md), [CRONS.md](CRONS.md), [RULES.md](RULES.md), [INTERFACE.md](../INTERFACE.md), [DESIGNSYSTEM.MD](../DESIGNSYSTEM.MD), [PROJECT.md](../PROJECT.md). As instruções existentes em `AGENTS.md` continuam válidas.
