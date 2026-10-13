# Regras técnicas

`AGENTS.md` é a fonte primária de regras deste repositório. Desenvolvimento em worktree isolado; testes offline antes de produção; erros públicos por `buildErrorBody()`; nunca registrar segredo. O diagnóstico do 429 é somente projeção de campos permitidos, sem valores livres de headers ou request/response body.
