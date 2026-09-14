# ERMES — orientações obrigatórias para agentes

## Fonte de verdade

Antes de analisar ou alterar o projeto, leia integralmente:

1. `docs/ERMES_Baseline_0.1.md` — regras de negócio e escopo vigente.
2. `docs/IMPLEMENTATION_STATUS.md` — o que já existe e o que ainda está bloqueado.
3. `docs/ARCHITECTURE.md` — estrutura técnica provisória.

Se houver conflito entre o código e a baseline, a baseline prevalece. Relate o conflito antes de alterar comportamento de negócio.

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
- O frete usa a rota estabelecimento → destino, com tempo estimado; nunca a localização do motoboy nem o tempo real gasto.
- Não calcular frete quando distância/tempo não vierem de provedor confiável.
- Não finalizar entrega sem código válido; são permitidas no máximo três tentativas inválidas.
- Preservar snapshots históricos de preço, peso, endereço, rota, frete e divisão financeira.
- Não implementar funções específicas do Administrador do ERMES enquanto continuarem pendentes.
- Antes de remover requisito ou mudar estado, faça análise de impacto sobre fluxo, banco, API, interface e testes.

## Convenções técnicas atuais

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
