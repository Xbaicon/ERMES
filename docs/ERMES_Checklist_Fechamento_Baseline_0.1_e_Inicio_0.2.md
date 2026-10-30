# ERMES — Checklist de Fechamento da 0.1 e Início da 0.2

> **Estado atual:** o gate de fechamento foi concluído e a Baseline 0.1 está
> congelada na tag `baseline-0.1`. A Baseline 0.2 foi iniciada documentalmente;
> o próximo passo é a auditoria de migração em modo somente leitura. Os itens
> abaixo permanecem como checklist de rastreabilidade e não indicam, por si só,
> que funcionalidades específicas da 0.2 já estejam implementadas. A futura
> migração SQLite → MySQL será tratada como etapa técnica separada antes das
> grandes mudanças funcionais.

## Fechar Baseline 0.1

- [x] Todas as funcionalidades previstas para 0.1 estão implementadas ou explicitamente retiradas/corrigidas por decisão formal.
- [x] Não há trabalho parcial relevante escondido em branches/arquivos.
- [x] Aplicação inicia sem erro.
- [x] Testes automatizados passam.
- [x] Smoke test manual dos fluxos principais passa.
- [x] Auditoria requisito × código da 0.1 foi concluída.
- [x] Correções de escopo sobre geocodificação/rotas foram consideradas.
- [x] Nenhuma funcionalidade 0.2 foi implementada prematuramente por acidente.
- [x] Estado do repositório está limpo ou mudanças conhecidas estão documentadas.
- [x] Checkpoint/commit/tag da 0.1 foi criado após autorização humana.

## Preparar migração para 0.2

- [x] Ler integralmente `ERMES_Baseline_0.2.md`.
- [x] Ler `ERMES_Changelog_0.1_para_0.2.md`.
- [ ] Executar auditoria do Codex antes de editar.
- [ ] Identificar migrações de banco.
- [ ] Criar plano de implementação incremental.
- [ ] Implementar e testar por blocos.
- [ ] Executar suíte completa no final.
- [ ] Realizar smoke test humano.
- [ ] Comparar resultado com critérios de aceitação da 0.2.
- [ ] Só após aprovação humana criar checkpoint da 0.2.
