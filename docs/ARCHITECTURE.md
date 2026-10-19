# Arquitetura técnica provisória — ERMES 0.1

## Objetivo

Fornecer uma fundação executável, simples de instalar no ambiente acadêmico e fácil de evoluir sem acoplar regras de negócio a um framework específico.

Esta arquitetura é uma escolha técnica provisória. Ela não altera as decisões de domínio da baseline.

## Componentes

| Camada | Tecnologia atual | Responsabilidade |
| --- | --- | --- |
| Interface | HTML5, CSS3 e JavaScript | Páginas responsivas e interação com a API |
| Servidor | Node.js `node:http` | API HTTP, autenticação, autorização e arquivos estáticos |
| Persistência | SQLite por `node:sqlite` | Dados locais persistentes e restrições de integridade |
| Segurança inicial | `scrypt`, tokens aleatórios e cookies `HttpOnly` | Hash de senha e sessões locais |
| Testes | `node:test` | Regras puras e validações automatizadas |

Não há dependências npm externas nesta etapa.

## Decisões estruturais

- `src/deliveries.js` concentra estados, eventos e a matriz pura do fluxo normal `available -> heading_to_pickup -> awaiting_pickup -> in_transit -> awaiting_confirmation -> completed`. Os estados operacionais de exceção são `returning` e `awaiting_return_confirmation`; `completed`, `cancelled` e `returned` são terminais.
- `src/delivery-creation.js` garante uma única Entrega para um pedido `confirmed`, `paid` e com destino válido. A variante interna participa da transação do pagamento, evitando transações SQLite aninhadas. A unicidade de `deliveries.order_id`, `BEGIN IMMEDIATE`, a inserção de `delivery_created` e o hash do código ficam na mesma transação.
- `src/delivery-operations.js` implementa consultas isoladas e transições transacionais. Atualizações condicionadas ao estado, o índice parcial `one_active_delivery_per_courier` e a serialização do SQLite protegem aceite e avanço concorrentes. Cada mudança efetiva grava exatamente um evento.
- `src/finance.js` concentra as regras e o livro-razão financeiro. `financial_entries` registra lançamentos append-only de pagamento, reembolso e distribuição por componente (`products` ou `freight`), parte relacionada, motivo, Pedido, Entrega, horário e chave idempotente única. Triggers rejeitam UPDATE, DELETE, over-refund, valores fora do inteiro seguro, relações divergentes e combinações incompatíveis de tipo, componente e beneficiário. Colisões de chave comparam o conteúdo financeiro relevante e exigem reconciliação quando divergentes. As transições operacionais chamam essas regras dentro da mesma transação SQLite; falha financeira desfaz também estado e evento.
- O pagamento acadêmico simulado atualiza `orders` e garante a Entrega dentro da mesma transação. O código de seis dígitos usa hash `scrypt` para validação e AES-256-GCM para recuperação exclusiva pelo cliente durante a operação. A chave pode vir de `ERMES_CONFIRMATION_CODE_KEY` ou de arquivo local com permissão restrita ao lado do banco; banco e chave precisam ser preservados juntos em backup. Repetições retornam a mesma Entrega e o mesmo código sem novo evento ou timestamp.
- `Pedido` e `Entrega` são entidades distintas.
- Produto, preço e peso são preservados em `order_items` para impedir alterações retroativas.
- Endereço possui snapshot histórico no pedido. O campo reservado para rota não torna geocodificação, provedor de rotas ou snapshot externo uma dependência da Baseline 0.1; consulte `BASELINE_0.1_SCOPE_CORRECTION.md`.
- O endereço padrão atual do cliente fica em `client_default_addresses`, com uma linha por usuário; pedidos preservam cópias independentes em `orders.destination_snapshot_json`.
- A criação do Pedido aceita o endereço padrão ou um endereço manual exclusivo da operação. Os dois caminhos passam pelo contrato puro de validação e normalização de `src/address.js`; o endereço manual não altera o cadastro padrão.
- `orders.recipient_snapshot_json` preserva `{ type, name }`: `self` captura o nome do cliente no momento da criação e `other` exige somente o nome informado. Campos adicionais, inclusive a obrigatoriedade de telefone, continuam pendentes; não existe conta de usuário para o destinatário.
- O catálogo de consulta fica sob `/api/client`: a sessão limita o acesso ao papel `client`, empresas bloqueadas não são elegíveis e a consulta de produtos combina `company_id` com `is_available = 1`; as antigas rotas públicas de catálogo não fazem parte do contrato.
- `src/orders.js` concentra validação, consultas isoladas por cliente ou empresa, recálculo decimal do peso, subtotal seguro, criação/edição do `draft` e confirmação comercial transacional. A criação grava atomicamente os snapshots de destino e destinatário; a edição atual continua restrita aos itens e preserva ambos. A confirmação usa `orders.version` para concorrência otimista, grava `confirmed_at` e não cria entrega, pagamento ou frete. `src/server.js` mantém a autorização e o contrato HTTP. O carrinho efêmero fica em `public/js/client-cart.js`; a consulta e a edição dos drafts em `public/js/client-drafts.js`; a consulta e confirmação empresarial em `public/js/company-drafts.js`. `order_items` preserva os snapshots comerciais, e a migração aditiva de `orders` mantém bancos SQLite existentes.
- Existe índice parcial no banco para impedir mais de uma entrega ativa por motoboy. Migrações aditivas por `PRAGMA table_info` mantêm bancos SQLite anteriores. Pedidos legados sem `recipient_snapshot_json` são migrados como `self` com o nome então disponível do cliente, coerente com o único comportamento anterior.
- Entregas ativas de bancos anteriores que não possuam a representação cifrada recebem um novo código durante a migração; o cliente passa a consultá-lo pelo painel. Entregas terminais não são alteradas.
- `public/js/delivery-panels.js` fornece a interface mínima de cliente, empresa e motoboy, sempre subordinada às autorizações e validações do servidor. As projeções operacionais usam destino e destinatário preservados; o motoboy não depende de dados mutáveis do cadastro para executar a Entrega.
- Dinheiro é representado em centavos inteiros seguros e somado com `BigInt`. A conclusão normal divide 70/25/5 pelo maior resto a partir do frete efetivamente pago, com desempate motoboy, empresa e ERMES; nunca usa configuração atual. No cancelamento pós-coleta, a metade do cliente usa arredondamento para cima quando há centavo ímpar e o motoboy recebe o restante, de modo que a soma continue exatamente igual ao frete histórico.
- Pagamento simulado preserva lançamentos dos componentes conhecidos; frete `NULL` continua desconhecido, não zero. `payment_status` permanece restrito a `pending|paid`, enquanto `refundStatus` é derivado como `none|partial|full`. A migração idempotente recompõe apenas pedidos `confirmed` e `paid` com `payment_paid_at` válido, cliente/empresa existentes, itens e subtotal coerentes e valores seguros; efeitos terminais ainda exigem entrega, evento, horário e ator coerentes. Registros ambíguos são ignorados para reconciliação e nenhum estado é reescrito.
- As projeções financeiras são específicas por papel: cliente vê somente pagamento e próprios reembolsos; empresa e motoboy veem apenas suas parcelas. A parcela do ERMES é persistida para histórico, mas não cria caso de uso administrativo pendente.
- Empresa e usuário responsável são entidades distintas.
- O papel `platform_admin` existe no esquema, mas não possui casos de uso implementados porque suas permissões estão pendentes.
- Motoboys são criados já vinculados a uma empresa; não existe cadastro autônomo.

## Limites deliberados da fundação

- A API de cotação aceita distância e tempo apenas como entrada técnica para testar a fórmula. A interface do cliente não deve solicitar esses valores. A fonte operacional de distância e tempo permanece pendente de clarificação; não escolher nem antecipar uma solução geográfica.
- O cadastro atual cria um usuário responsável inicial para a empresa, sem declarar que a versão final terá apenas um usuário.
- Recuperação de senha não foi simulada de forma insegura.
- O SQLite atende ao desenvolvimento e demonstração local. Uma futura mudança de banco exigirá migrações e testes de concorrência equivalentes.

## Próximas integrações técnicas

1. Completar somente as distribuições e políticas de reembolso que continuam pendentes na Baseline 0.1 após decisão explícita.
2. Interface de tentativa de contato no destino.
3. Chat entre cliente e empresa.

Geocodificação, provedor real de rotas, mapas e rastreamento geográfico são
opcionais/futuros e não bloqueiam esta baseline. Acompanhar a operação por
estados e eventos permanece obrigatório. A classificação completa está em
`BASELINE_0.1_SCOPE_CORRECTION.md`.
