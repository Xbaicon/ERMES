# ERMES — Pacote Oficial da Baseline 0.2

Este pacote reúne os artefatos necessários para preservar as decisões da Baseline 0.2 e, futuramente, migrar a implementação estável da 0.1 para a 0.2.

## Estado atual

A Baseline 0.1 foi concluída e congelada na tag `baseline-0.1`. A Baseline 0.2
é agora a baseline ativa de desenvolvimento. A presença destes documentos não
declara suas funcionalidades como implementadas: o próximo passo é a auditoria
de migração 0.1 → 0.2 em modo somente leitura. A futura migração SQLite → MySQL
deve ocorrer como etapa técnica separada antes das grandes mudanças funcionais.

## Arquivos

- `ERMES_Especificacao_Consolidada_Baseline_0.2.docx` — documento principal, formatado para leitura/apresentação.
- `ERMES_Baseline_0.2.md` — fonte textual consolidada da especificação.
- `ERMES_Changelog_0.1_para_0.2.md` — delta funcional 0.1 → 0.2.
- `ERMES_Prompt_Implementacao_Codex_Baseline_0.2.md` — handoff para o Codex após fechamento estável da 0.1.
- `ERMES_Checklist_Fechamento_Baseline_0.1_e_Inicio_0.2.md` — checklist de gate entre as baselines.

## Regra de uso

A condição de fechamento da 0.1 foi atendida pela tag `baseline-0.1`. Não iniciar
a implementação funcional da 0.2 antes da auditoria técnica de migração e da
etapa separada de persistência planejada.

Novas funcionalidades após o fechamento da 0.2 devem ser direcionadas à 0.3, salvo correção de contradição ou erro documental comprovado.
