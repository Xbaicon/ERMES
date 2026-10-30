# ERMES — orientações obrigatórias para agentes

## Baseline ativa e fonte de verdade

A Baseline 0.1 está encerrada e congelada na tag `baseline-0.1`. Ela não é
mais a baseline ativa de desenvolvimento. A Baseline 0.2 é a baseline ativa,
mas sua existência documental não significa que suas funcionalidades já estejam
implementadas.

Antes de analisar ou alterar o projeto, leia integralmente:

1. `docs/ERMES_Baseline_0.2.md` — principal referência funcional da Baseline 0.2.
2. `docs/ERMES_Changelog_0.1_para_0.2.md` — delta autorizado entre as baselines 0.1 e 0.2.
3. `docs/IMPLEMENTATION_STATUS.md` — o que está efetivamente implementado e a etapa técnica vigente.
4. `docs/ARCHITECTURE.md` — arquitetura atual do checkpoint e transição técnica planejada.
5. `docs/API.md` — contrato da API efetivamente implementada.
6. `docs/ERMES_Baseline_0.1.md` e `docs/BASELINE_0.1_SCOPE_CORRECTION.md` — histórico da Baseline 0.1 e referência para comportamentos não alterados pela 0.2.

`docs/ERMES_Especificacao_Consolidada_Baseline_0.2.docx` é documento oficial
complementar. Em caso de conflito sobre uma regra explicitamente alterada na
Baseline 0.2, prevalece a documentação da 0.2. Para comportamentos não alterados,
os documentos da 0.1 continuam válidos como referência histórica e funcional.
Relate qualquer conflito entre código e documentação antes de alterar comportamento
de negócio.

## Classificação das decisões

- **DEFINIDO:** respeitar e testar.
- **PENDENTE:** não inventar; registrar a lacuna e solicitar decisão a David.
- **FORA DO ESCOPO:** não implementar sem autorização explícita e análise de impacto.
- **OPCIONAL / SE HOUVER TEMPO:** não transformar em dependência do núcleo.
- **EVOLUÇÃO FUTURA:** não antecipar na primeira versão.

## Guardrails essenciais

- Não criar entrega agendada, reserva antecipada ou motoboy autônomo.
- Todo motoboy deve estar vinculado a uma empresa.
- Um motoboy pode possuir no máximo uma entrega ativa.
- Uma entrega pode ser aceita por somente um motoboy; a garantia deve existir no banco/servidor.
- Não criar controle completo de estoque.
- Não permitir pedido com peso total superior a 12 kg.
- A fórmula tarifária usa peso, distância e tempo estimado como conceitos de domínio; a fonte operacional de distância/tempo está PENDENTE e não deve ser inventada.
- Não tratar geocodificação, provedor de rotas, mapas, localização atual ou rastreamento geográfico como pré-requisitos bloqueadores da Baseline 0.2.
- O acompanhamento operacional da entrega (estados, eventos, coleta, transporte, chegada, confirmação e ocorrências) permanece obrigatório e é distinto de rastreamento geográfico.
- Não finalizar entrega sem código válido; são permitidas no máximo três tentativas inválidas.
- Preservar snapshots históricos comerciais e operacionais que existirem, como preço, peso, endereço, frete e divisão financeira; não exigir ou criar snapshots provenientes de rota externa sem decisão explícita.
- Não implementar funções específicas do Administrador do ERMES enquanto continuarem pendentes.
- Antes de remover requisito ou mudar estado, faça análise de impacto sobre fluxo, banco, API, interface e testes.

## Convenções técnicas atuais

Estas convenções descrevem o checkpoint congelado da Baseline 0.1. Qualquer
mudança para a 0.2 depende primeiro da auditoria de migração em modo somente
leitura. A futura migração SQLite → MySQL deve ser uma etapa técnica separada,
anterior às grandes alterações funcionais da 0.2.

- Node.js 22.5+ com módulos ES.
- Backend sem dependências externas, baseado em `node:http` e `node:sqlite`.
- Frontend HTML, CSS e JavaScript sem framework.
- Valores monetários persistidos em centavos.
- Banco local em `data/ermes.sqlite`, nunca versionado.
- Não armazenar senhas em texto puro. Sessões devem usar cookie `HttpOnly`.
- Não introduzir dependência de produção sem justificar e registrar em `docs/ARCHITECTURE.md`.

## Verificação obrigatória

Após mudanças:

```bash
npm run check
npm test
```

Para mudanças de API ou interface, inicie `npm start` e execute um teste de fumaça do fluxo afetado. Atualize `docs/IMPLEMENTATION_STATUS.md` quando o estado de uma funcionalidade mudar.
