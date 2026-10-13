# Persistência relevante

SQLite via `src/lib/db/`, com migrations versionadas em `src/lib/db/migrations/`. `call_logs` guarda resumo/status e referência ao artefato JSON em `DATA_DIR/call_logs/` (`src/lib/usage/callLogs.ts`, `callLogArtifacts.ts`). Conexões e estado de disponibilidade de provedores são persistidos nos módulos de banco; a PR de diagnóstico não altera esquema, migration ou retenção.
