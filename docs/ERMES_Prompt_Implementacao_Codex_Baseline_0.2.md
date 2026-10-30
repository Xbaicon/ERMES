# ERMES — Prompt de Implementação para Codex — Baseline 0.2

> **IMPORTANTE:** use este prompt somente depois que a Baseline 0.1 estiver concluída, testada, auditada e registrada em checkpoint/commit/tag. Não aplique a 0.2 sobre uma 0.1 parcial.

## Papel

Atue como engenheiro de software responsável por migrar o projeto ERMES da Baseline 0.1 estável para a Baseline 0.2, preservando comportamentos não alterados e implementando apenas o delta autorizado.

## Fontes de verdade

1. `ERMES_Baseline_0.2.md` — especificação funcional consolidada.
2. `ERMES_Changelog_0.1_para_0.2.md` — diferenças 0.1 → 0.2.
3. Código e testes do checkpoint estável da 0.1.

Se houver conflito entre código da 0.1 e a 0.2, não escolha silenciosamente um lado: identifique o conflito, explique seu impacto e adapte o código conforme a 0.2 apenas quando a regra estiver explicitamente definida.

## Fase 1 — Auditoria antes de alterar

Antes de editar código:

1. Identifique entidades/classes, enums, serviços, controllers, repositories, DTOs, telas e testes afetados.
2. Localize o fluxo atual de Pedido, Entrega, aceite, coleta, código, cancelamento, retorno e financeiro.
3. Liste cada requisito da 0.2 como: `IMPLEMENTADO`, `PARCIAL`, `NÃO IMPLEMENTADO` ou `CONFLITANTE`.
4. Identifique migrações de dados/banco necessárias.
5. Mostre o plano de implementação em etapas pequenas e coerentes.
6. Não implemente geocodificação/rotas, alteração voluntária de pedido pelo cliente, avaliações ou recuperação por segundo motoboy.

## Fase 2 — Ordem recomendada de implementação

1. Atualizar enums/estados sem quebrar persistência existente.
2. Introduzir `TentativaEntrega` e seus relacionamentos.
3. Alterar a fronteira de criação da tentativa para a coleta.
4. Separar contador de código da numeração da tentativa.
5. Introduzir/adequar `OcorrenciaEntrega` e classificação de responsabilidade.
6. Implementar retorno confirmado e revalidação.
7. Implementar cenários terminais/recuperáveis.
8. Atualizar regras financeiras.
9. Implementar ajuste excepcional por indisponibilidade.
10. Atualizar APIs/DTOs/telas conforme necessário.
11. Atualizar e ampliar testes.
12. Executar suíte completa e smoke test.

## Regras críticas que não podem ser violadas

- Aceite pré-coleta não cria TentativaEntrega.
- Coleta cria TentativaEntrega.
- Falha antes da coleta não incrementa tentativa.
- Nova tentativa da mesma Entrega só nasce numa nova coleta após falha recuperável.
- Uma Entrega nunca pode ter duas tentativas ativas simultaneamente.
- Código pertence à Entrega e não muda entre tentativas.
- Contador de códigos inválidos pertence à TentativaEntrega e começa em zero na nova tentativa.
- Terceira validação inválida encerra a tentativa atual; não é “tentativa de entrega nº 3”.
- Ocorrência ambígua não pode culpar automaticamente o cliente.
- AGUARDANDO_REVALIDACAO bloqueia novo aceite.
- Ausência/recusa: produtos reembolsados; frete 70/25/5.
- Endereço incorreto do cliente: terminal; novo endereço exige novo Pedido.
- Erro persistente do ERMES: reembolso integral e encerramento, sem espera indefinida.
- Produto indisponível: ajuste só com aceite explícito do cliente.
- Cancelamento pós-coleta: 100% produtos + 50% do frete reembolsados; 50% do frete para motoboy.
- Não aplicar tolerância de 3 minutos, regra de 30% ou suspensão de 2 horas.

## Critérios de qualidade

- Preferir alterações mínimas e coesas.
- Não reescrever módulos sem necessidade.
- Manter transações/locks adequados para aceite concorrente.
- Preservar histórico/auditoria.
- Não armazenar senha em texto puro.
- Não duplicar estado operacional de Entrega e TentativaEntrega de forma que possam divergir.
- Não esconder regras de negócio apenas na interface; garantir no backend.
- Não criar valores financeiros “no chute”.
- Não criar provider externo não autorizado.

## Testes obrigatórios

Crie/ajuste testes automatizados para cada critério de aceitação da especificação 0.2. Inclua cenários positivos, negativos e transições inválidas. Garanta especialmente concorrência no aceite, criação da tentativa na coleta, retorno/revalidação, código entre tentativas e regras financeiras.

## Relatório final esperado do Codex

Ao terminar, não faça apenas “feito”. Entregue:

1. Resumo das alterações.
2. Arquivos modificados/criados.
3. Migrações de banco.
4. Requisitos 0.2 implementados, um a um.
5. Pendências deliberadamente não implementadas.
6. Testes executados e resultados.
7. Smoke tests recomendados ao usuário.
8. Riscos ou débitos técnicos detectados.
9. Confirmação explícita de que nenhuma funcionalidade fora da 0.2 foi adicionada.

## Proibição de commit/push automático

Não faça commit, tag ou push sem autorização explícita do responsável pelo projeto. Ao terminar a implementação e os testes, pare e solicite revisão humana.
