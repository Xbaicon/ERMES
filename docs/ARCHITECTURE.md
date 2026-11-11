# Arquitetura técnica atual — implementação incremental da Baseline 0.2

## Estado da transição

O checkpoint `baseline-0.1` permanece congelado. O desenvolvimento da Baseline
0.2 avança incrementalmente sobre SQLite após a conclusão da auditoria técnica
0.1 → 0.2. Este documento inclui os incrementos de `TentativaEntrega` e da
fundação persistente de `OcorrenciaEntrega`/classificação de responsabilidade.
Isso não declara implementado o ciclo completo da 0.2 nem altera a baseline
normativa. MySQL permanece uma etapa técnica posterior e não é gate para as
funcionalidades da 0.2.

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
- `src/delivery-attempts.js` concentra a persistência e o ciclo mínimo de `TentativaEntrega`. `delivery_attempts` usa os estados conceituais `active`, `returning`, `completed` e `closed_unsuccessfully`, equivalentes a `ATIVA`, `EM_RETORNO`, `CONCLUIDA` e `ENCERRADA_SEM_SUCESSO`. Cada tentativa possui `invalid_code_attempts` entre zero e três; a entidade não replica os estados operacionais detalhados da Entrega.
- `src/delivery-occurrences.js` concentra o registro persistente e a classificação de `OcorrenciaEntrega`. Falha do motoboy antes da coleta não se vincula a tentativa; falha após a coleta, ausência, recusa e terceira validação inválida se vinculam à tentativa aberta. O registro preserva relator, horário, descrição e evidência interna; a projeção empresarial omite identificadores internos e evidências.
- A responsabilidade permanece `NULL` enquanto não classificada e pode ser definida uma única vez pela empresa como `CLIENTE`, `EMPRESA`, `MOTOBOY`, `SISTEMA` ou `INDEFINIDO`. `INDEFINIDO` é uma classificação efetiva, distinta da ausência de classificação. A classificação e o evento `occurrence_classified` são atômicos e não alteram estado, tentativa ou financeiro.
- A confirmação da coleta executa em um único `BEGIN IMMEDIATE`: valida a Entrega atribuída em `awaiting_pickup`, verifica a ausência de tentativa aberta, calcula `MAX(attempt_number) + 1`, insere a tentativa, muda a Entrega para `in_transit`, grava `collected_at` e registra `order_collected`. Qualquer falha desfaz todos esses efeitos.
- `UNIQUE(delivery_id, attempt_number)` protege a sequência. O índice parcial único `one_open_attempt_per_delivery`, para `active` e `returning`, protege no banco a regra de uma tentativa aberta por Entrega; a aplicação também verifica a regra dentro da transação. Uma futura mudança de banco deverá reproduzir essa invariante com mecanismo equivalente.
- Código válido muda a tentativa ativa para `completed` e grava `ended_at` na mesma transação que conclui a Entrega, registra o evento e executa o financeiro existente. O código de confirmação, seu hash e sua representação cifrada continuam exclusivamente em `deliveries`.
- Os fluxos de retorno mudam a tentativa aberta para `returning` e a encerram somente na confirmação física do retorno: `recoverable` para falha do motoboy após coleta e `terminal` para ausência, recusa, terceira validação inválida e cancelamento pós-coleta. A terceira validação inválida cria ocorrência, mas não presume responsabilidade. `address_problem` genérico continua rejeitado antes de qualquer mutação até existir o fluxo tipado de evidências e revalidação que permita classificar sua causa.
- A criação da tentativa valida, por consultas portáveis, número inteiro positivo gerado internamente, papel `courier`, empresa da Entrega e atribuição atual. A aplicação não oferece alteração genérica de identidade, número, motoboy ou início da tentativa.
- Os detalhes de Entrega projetam o histórico `attempts` de forma aditiva. Listagens, rotas e interface visual permanecem inalteradas.
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
- `src/order-chat.js` implementa uma conversa por Pedido sem entidade vazia separada. `order_chat_messages` relaciona diretamente Pedido, remetente, papel preservado, texto e horário; índices ordenam por ID crescente, e triggers validam participante, bloqueiam escrita após terminalidade e proíbem UPDATE/DELETE. A aplicação aceita somente `draft` e `confirmed` como estados graváveis e deriva encerramento pelos estados terminais existentes da Entrega (`completed`, `cancelled`, `returned`). `public/js/order-chat.js` usa HTTP com polling de cinco segundos somente após a seleção de uma conversa, substitui a projeção completa para não duplicar mensagens e suspende a atualização quando a página fica oculta.
- Existem índices parciais no banco para impedir mais de uma entrega ativa por motoboy e mais de uma tentativa aberta por Entrega. Migrações aditivas por `PRAGMA table_info` e `CREATE TABLE IF NOT EXISTS` mantêm bancos SQLite anteriores. `delivery_occurrences` adiciona checks de tipo/responsabilidade, vínculo opcional à tentativa da mesma Entrega e classificação consistente/final. Pedidos legados sem `recipient_snapshot_json` são migrados como `self` com o nome então disponível do cliente, coerente com o único comportamento anterior.
- A evolução cria `delivery_attempts` vazia em bancos anteriores. Não há backfill de tentativas porque os estados legados não provam quando uma coleta ocorreu nem todos os dados semânticos do ciclo. Ao adicionar o contador, somente uma única tentativa acompanhada de eventos canônicos e coerentes recebe o valor legado; múltiplas tentativas ou evidência divergente permanecem em zero para reconciliação. Entregas históricas são preservadas; uma entrega em andamento sem tentativa recebe erro explícito de reconciliação antes de concluir ou entrar em retorno.
- A evolução cria `delivery_occurrences` vazia em bancos anteriores. Eventos históricos isolados não são convertidos em ocorrências por heurística, pois não provam descrição, evidências, vínculo semântico completo ou classificação.
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
- `delivery_attempts.invalid_code_attempts` é a única fonte operacional do contador. A coluna em `deliveries` permanece temporariamente como legado físico para evitar reconstrução invasiva, sem leitura, incremento ou sincronização pelo fluxo operacional.
- `order_blocked_until` também permanece como coluna legado física, mas não é gravada nem aplicada. A Baseline 0.2 não possui tolerância fixa de três minutos ou suspensão automática de duas horas.
- A migração completa dos estados de Pedido e Entrega para a nomenclatura da 0.2 permanece pendente; este incremento preserva valores como `completed` por compatibilidade.

## Portabilidade durante a fase SQLite

- Persistir valores monetários como inteiros em centavos; manter foreign keys,
  unicidades e constraints explícitas.
- Evitar novos acoplamentos desnecessários a `rowid`. Evitar novos `PRAGMA`,
  `GLOB`, `typeof()` e outras construções específicas do SQLite quando houver
  solução simples e clara na aplicação. Qualquer acoplamento novo necessário
  deve ser deliberado e documentado.
- Definir fronteiras explícitas para novas transações; documentar cada alteração
  de schema da 0.2. Evitar migrations e backfills improvisados no startup quando
  houver solução mais organizada.
- Manter lógica de negócio separada da persistência quando isso não exigir
  refatoração desproporcional.
- Cada teste deve criar seu próprio estado, sem depender de `data/ermes.sqlite`.
  O arquivo local e os dados de smoke não são presumidos como origem da futura
  migração; nenhuma feature pode depender de banco local pessoal.

Essas orientações reduzem o custo da migração futura; não implicam portar a
aplicação para MySQL agora.

## Próxima etapa técnica

1. Evoluir em incremento separado a revalidação, as ocorrências tipadas de endereço, os estados de Pedido/Entrega e as consequências financeiras da 0.2. O tipo genérico `address_problem` permanece bloqueado até essa modelagem.
2. Definir, se necessária, estratégia auditável de reconciliação de Entregas legadas pós-coleta sem `TentativaEntrega`, sem backfill heurístico.
3. Após regressão funcional completa da 0.2, migrar SQLite → MySQL como etapa técnica isolada em ambiente apropriado, com plano próprio para integridade, transações e concorrência; repetir regressão automatizada e smoke completo.

Geocodificação, provedor real de rotas, mapas e rastreamento geográfico são
itens futuros e não bloqueiam a Baseline 0.2. A classificação vigente está em
`ERMES_Baseline_0.2.md`; a correção de escopo da 0.1 permanece como registro
histórico e referência para comportamentos herdados.
