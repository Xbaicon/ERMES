# Arquitetura técnica atual — implementação incremental da Baseline 0.2

## Estado da transição

O checkpoint `baseline-0.1` permanece congelado. O desenvolvimento da Baseline
0.2 avança incrementalmente sobre SQLite após a conclusão da auditoria técnica
0.1 → 0.2. Este documento inclui os incrementos de `TentativaEntrega` e da
fundação persistente de `OcorrenciaEntrega`/classificação de responsabilidade,
o fluxo de impedimento externo com revalidação pela empresa, o erro de apresentação
de endereço atribuído ao ERMES e o fechamento operacional terminal por ausência,
recusa do destinatário e três códigos inválidos.
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
- A responsabilidade permanece `NULL` enquanto não classificada e pode ser definida uma única vez pela empresa como `CLIENTE`, `EMPRESA`, `MOTOBOY`, `SISTEMA` ou `INDEFINIDO`. `INDEFINIDO` é uma classificação efetiva, distinta da ausência de classificação. A classificação e o evento `occurrence_classified` são atômicos e não alteram estado ou tentativa. Para `confirmation_failed`, os refunds do cliente participam dessa mesma transação; as demais classificações não alteram o financeiro.
- A confirmação da coleta executa em um único `BEGIN IMMEDIATE`: valida a Entrega atribuída em `awaiting_pickup`, verifica a ausência de tentativa aberta, calcula `MAX(attempt_number) + 1`, insere a tentativa, muda a Entrega para `in_transit`, grava `collected_at` e registra `order_collected`. Qualquer falha desfaz todos esses efeitos.
- `UNIQUE(delivery_id, attempt_number)` protege a sequência. O índice parcial único `one_open_attempt_per_delivery`, para `active` e `returning`, protege no banco a regra de uma tentativa aberta por Entrega; a aplicação também verifica a regra dentro da transação. Uma futura mudança de banco deverá reproduzir essa invariante com mecanismo equivalente.
- Código válido muda a tentativa ativa para `completed` e grava `ended_at` na mesma transação que conclui a Entrega, registra o evento e executa o financeiro existente. O código de confirmação, seu hash e sua representação cifrada continuam exclusivamente em `deliveries`.
- Os fluxos de retorno mudam a tentativa aberta para `returning` e a encerram somente na confirmação física do retorno: `recoverable` para falha do motoboy após coleta, impedimento externo e erro de endereço `SISTEMA`; `terminal` para ausência, recusa, terceira validação inválida, cancelamento pós-coleta e endereço atribuído ao cliente. `address_problem` registra evidência imutável sem iniciar retorno nem inferir responsabilidade. `CLIENTE` inicia seu retorno na classificação e aplica products refund mais freight 70/25/5 no fechamento. `SISTEMA` permite conclusão normal ou início explícito de retorno, seguido por resolução auditada corrigível/persistente. Helpers distintos preservam as duas responsabilidades e seus triggers exigem as respectivas cadeias.
- A criação da tentativa valida, por consultas portáveis, número inteiro positivo gerado internamente, papel `courier`, empresa da Entrega e atribuição atual. A aplicação não oferece alteração genérica de identidade, número, motoboy ou início da tentativa.
- Os detalhes de Entrega projetam o histórico `attempts` de forma aditiva. Listagens, rotas e interface visual permanecem inalteradas.
- `src/finance.js` concentra as regras e o livro-razão financeiro. `financial_entries` registra lançamentos append-only de pagamento, reembolso e distribuição por componente (`products` ou `freight`), parte relacionada, motivo, Pedido, Entrega, horário e chave idempotente única. Triggers rejeitam UPDATE, DELETE, over-refund, valores fora do inteiro seguro, relações divergentes e combinações incompatíveis de tipo, componente e beneficiário. Colisões de chave comparam o conteúdo financeiro relevante e exigem reconciliação quando divergentes. As transições operacionais chamam essas regras dentro da mesma transação SQLite; falha financeira desfaz também estado e evento.
- O pagamento acadêmico simulado atualiza `orders` e garante a Entrega dentro da mesma transação. O código de seis dígitos pertence à Entrega, permanece preservado no banco e é reutilizado entre tentativas da mesma Entrega. Usa hash `scrypt` para validação e AES-256-GCM para recuperação exclusiva pelo cliente nos estados permitidos pela API. A chave pode vir de `ERMES_CONFIRMATION_CODE_KEY` ou de arquivo local com permissão restrita ao lado do banco; banco e chave precisam ser preservados juntos em backup. Repetições do pagamento preservam a mesma Entrega sem novo evento ou timestamp, mas a exposição do código depende do estado: durante retorno recuperável e `awaiting_revalidation`, o pagamento retorna `confirmationCode: null` e a consulta de detalhe do cliente omite o campo. Quando o estado permite sua exposição, o cliente recupera o mesmo código preservado, conforme o contrato em `API.md`.
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
- `users.role = 'company'` continua sendo o tipo técnico do ator nas sessões,
  eventos, chats, ocorrências e triggers. `users.company_profile` é a permissão
  interna (`RESPONSAVEL` ou `ATENDENTE`), obrigatória somente para empresa;
  outros papéis têm `NULL`. CHECK e triggers protegem a regra em banco novo e
  legado. A migração aditiva atribui `RESPONSAVEL` aos usuários empresariais
  históricos com perfil ausente, dentro do bootstrap transacional e de modo
  idempotente, preservando IDs, vínculos e sessões.
- A sessão consulta o perfil atual do banco a cada requisição. A autorização
  central valida papel, empresa e perfil; ações administrativas exigem
  `RESPONSAVEL` e as rotas operacionais aceitam ambos os perfis. O servidor
  sempre deriva `company_id` da sessão.
- `company_audit_events` registra confirmação comercial, criação/alteração de
  produto, criação de motoboy/usuário e mudança tarifária. Triggers validam
  ator e entidade da mesma empresa, impedem a troca posterior da empresa do
  ator auditado, restringem ações administrativas ao
  responsável e proíbem UPDATE/DELETE. Índice único impede duas evidências de
  confirmação para o mesmo Pedido. A gravação ocorre na mesma transação da ação;
  falha da auditoria reverte a mudança de domínio. Chats, ocorrências, ajustes
  e eventos de Entrega conservam os campos de ator já existentes.
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

1. Evoluir em incrementos separados os demais cenários e consequências financeiras ainda pendentes da 0.2, preservando os fluxos de endereço já implementados.
2. Definir, se necessária, estratégia auditável de reconciliação de Entregas legadas pós-coleta sem `TentativaEntrega`, sem backfill heurístico.
3. Após regressão funcional completa da 0.2, migrar SQLite → MySQL como etapa técnica isolada em ambiente apropriado, com plano próprio para integridade, transações e concorrência; repetir regressão automatizada e smoke completo.

Geocodificação, provedor real de rotas, mapas e rastreamento geográfico são
itens futuros e não bloqueiam a Baseline 0.2. A classificação vigente está em
`ERMES_Baseline_0.2.md`; a correção de escopo da 0.1 permanece como registro
histórico e referência para comportamentos herdados.

## Estados oficiais e revalidação incremental

`src/official-statuses.js` centraliza os nomes oficiais e projeta os valores legados, sem armazenar uma segunda fonte de verdade. Pedidos continuam `draft|confirmed`; Entregas adicionam apenas `awaiting_revalidation`. A projeção `officialStatus` de Pedido consulta a Entrega e exige evidência histórica explícita para os resultados terminais. `returned + client_cancelled_after_pickup` permanece `CANCELADA/CANCELADO`; `returned + recipient_absent|recipient_refused` e `confirmation_failed` com evidência coerente passam a `NAO_REALIZADA/ENCERRADO`. `returned` não é convertido globalmente: quando falta causa comprovada a projeção é `null`. `AGUARDANDO_CONFIRMACAO` de Pedido, `RECUSADO` e os demais cenários terminais ainda não receberam operações novas.

No fluxo de ausência/recusa, a ocorrência e a mudança para retorno continuam na
transação original. A confirmação empresarial de recebimento fecha a tentativa
como `closed_unsuccessfully/terminal`, mantém o motivo específico, limpa o
motoboy, grava `returned_at`, persiste `returned` e `return_confirmed` na mesma
transação. As consultas de Entrega, de Pedido e a criação idempotente resolvem a
mesma causa a partir do evento histórico, sem usar `return_reason` como atalho.
Falha no evento final reverte tentativa, Entrega, atribuição e timestamp. O
`recordRecipientTerminalFailureInTransaction` participa desse fechamento:
valida pagamentos persistidos, completa somente o saldo de produtos ainda não
reembolsado e divide o frete pago em 70/25/5 via `splitNormalFreight()`.
O beneficiário motoboy vem da tentativa terminal correspondente, mesmo após
`deliveries.courier_id` ser limpo. Sua identidade é confrontada com coleta,
ocorrência e retorno do ciclo terminal; divergência exige reconciliação. Um
refund anterior positivo de frete também exige reconciliação antes de novos
lançamentos. Chaves idempotentes e triggers protegem o
ledger append-only; falha financeira reverte também o fechamento operacional.
Frete `NULL` sem pagamento gera `freight_amount_unavailable`, sem valor inventado;
pagamento divergente exige reconciliação. Backfill automático não infere
consequências para fechamentos históricos ambíguos.

O impedimento específico `temporary_external_obstruction` é registrado no destino pelo motoboy atribuído, com descrição e metadados internos do estado. Não declara contato ou alternativa segura como realizados automaticamente. Ocorrência, retorno da tentativa, estado da Entrega e evento são uma transação. Não altera financeiro nem responsabilidade.

Após o motoboy informar devolução e a empresa confirmar o recebimento físico, a mesma transação encerra a tentativa como recuperável, remove a atribuição, persiste `awaiting_revalidation` e cria `delivery_revalidations`. Esta tabela preserva o ciclo exato Entrega/Tentativa/Ocorrência, recebedor, horário e verificação posterior. Triggers rejeitam ciclo cruzado, ocorrência de tipo incompatível, participante com papel/empresa incorretos, alteração do recebimento, segunda verificação e DELETE. Não há tentativa aberta na espera.

A operação de revalidação exige `revalidationId`, `release: true` e resultado textual da verificação. Confirma a propriedade e o retorno, grava verificador/horário/resultado, muda para `available` e registra evento atomicamente. Não reclassifica a ocorrência, não cria tentativa nem altera o código. Somente a nova coleta cria o próximo número de tentativa, com contador zero. Chat não é um comando operacional.

`BEGIN IMMEDIATE`, atualização condicionada e índice de ciclo pendente único serializam liberações e aceite. `PRAGMA busy_timeout = 5000` permite aguardar brevemente o escritor de outra conexão, preservando a exclusão mútua do SQLite. Os testes disputam operações em conexões independentes.

### Evolução SQLite

Múltiplas conexões podem inicializar o mesmo banco SQLite. O bootstrap serializa
o bloco inicial de schema em `BEGIN IMMEDIATE`, incluindo a substituição atômica
de `financial_entry_payment_state_insert` e dos triggers financeiros de tipo
e beneficiário. Assim, versões antigas dos triggers são
substituída, em vez de ser mantida com `IF NOT EXISTS`, e não há corrida entre
`DROP TRIGGER` e `CREATE TRIGGER` de inicializações concorrentes. A contenção na
ativação de WAL tem tratamento específico e limitado ao bootstrap; isso não
representa retry de operações de domínio. Essa proteção não altera regras
financeiras.

`src/revalidation-schema.js` amplia o CHECK de tipos de ocorrência via reconstrução transacional: cria tabela temporária, copia dados mantendo IDs, remove a anterior, renomeia e recria os índices/triggers preservados. FKs ficam ligadas; `foreign_key_check` é obrigatório antes do commit. O teste usa `tests/fixtures/revalidation-legacy.sql`, snapshot relevante do schema real da PR #22, e induz falha após cópia/DROP/RENAME, prova rollback integral e repete a evolução no mesmo banco. A reconstrução só é feita para o CHECK anterior conhecido; não há backfill de ocorrências, tentativas ou revalidações.

O painel mostra a espera sem oferecer aceite/cancelamento incompatível. A revalidação externa e a resolução específica do erro do ERMES têm API, sem formulário completo. O endereço original e apresentado são preservados na ocorrência `address_problem`. O cancelamento durante a espera pelo impedimento externo é descrito abaixo; nenhum legado é convertido automaticamente.


### Fechamento de `confirmation_failed`

`terminalDeliveryEvent` em `src/official-statuses.js` resolve a evidência para
operações, consultas de Pedido e criação/pagamento idempotente. A projeção pura
reconhece `confirmation_failed` somente em `returned`. Para a evidência persistida,
`hasConfirmationFailureEvidence` exige tentativa mais recente com contador três,
ocorrência única vinculada à tentativa/motoboy, sequência das três validações e
retorno reportado. O fechamento valida essa evidência dentro da transação; a
projeção pós-fechamento exige também tentativa encerrada terminalmente e evento
empresarial de recebimento coerente. Histórico contraditório ou incompleto não
produz projeção terminal nem backfill.

O terceiro erro inicia retorno e bloqueia conclusão, mas a custódia permanece
aberta até confirmação física pela empresa. O fechamento atômico já existente
encerra a tentativa, limpa atribuição, grava `returned_at`, `returned` e
`return_confirmed`; falha no evento restaura integralmente o estado anterior.
Não cria tentativa nova, revalidação nem código novo. A classificação é separada
e não é requisito para terminalidade; `responsibility` permanece `NULL` até
classificação explícita. O fechamento não altera o ledger; os refunds do cliente
são aplicados somente na classificação válida.

A classificação de `confirmation_failed` reutiliza
`hasConfirmationFailureEvidence(db, deliveryId, true)` dentro da transação de
classificação, depois de verificar propriedade e ausência de classificação
anterior. Ciclo não fechado ou inconsistente retorna `409`; `EMPRESA` retorna
`400` especificamente para esse tipo. As opções válidas são `CLIENTE`, `MOTOBOY`,
`SISTEMA` e `INDEFINIDO`. O enum global preserva `EMPRESA` e as demais ocorrências
mantêm seu contrato temporal. UPDATE da classificação e `occurrence_classified`
continuam atômicos com os refunds do cliente, sem alteração da terminalidade.


### Consequências financeiras da classificação de `confirmation_failed`

`classifyDeliveryOccurrence` chama
`recordConfirmationFailureFinancialConsequencesInTransaction(db, occurrenceId, responsibility)`
após o UPDATE e o INSERT de `occurrence_classified`, dentro do mesmo
`BEGIN IMMEDIATE`, depois do gate operacional existente. `finance.js` não importa
`official-statuses.js`; a direção dos imports é preservada.

A função lê a classificação persistida e valida os pagamentos e refunds do
ledger por Pedido, cliente, Entrega e componente. Exige pagamento único de
produtos coerente com o snapshot e de frete quando conhecido. Em todos os casos
completa o refund acumulado de produtos. Para `CLIENTE`, preserva frete cobrado
e rejeita refund anterior positivo; para `MOTOBOY`, `SISTEMA` e `INDEFINIDO`,
completa também o refund acumulado de frete pago. Frete `NULL` sem pagamento não
gera valor; com pagamento exige reconciliação. Valores inválidos, over-refund,
pagamentos ausentes/duplicados/divergentes e distribuições incompatíveis exigem
`FINANCIAL_RECONCILIATION_REQUIRED`. Remuneração histórica de outra natureza não
é automaticamente incompatível; distribuições de `confirmation_failed` ou de
outros desfechos finais concorrentes são rejeitadas.

Chaves determinísticas: `delivery:<id>:confirmation-failed:refund-products` e
`delivery:<id>:confirmation-failed:refund-freight`. O saldo considera refunds
anteriores e exclui apenas a própria chave ao calcular seu conteúdo esperado,
permitindo repetição interna idempotente e detectando colisão semântica, inclusive
chave existente sem saldo. Não há distribuição nova nem chamada a
`splitNormalFreight()` nesse fluxo. A política de custo/distribuição interna
continua futura e não altera as regras já definidas ao cliente.

O bootstrap substitui atomicamente `financial_entry_valid_kind_insert`, ampliado
somente para refunds `confirmation_failed` com ocorrência classificada e
retorno terminal. Produtos aceitam as quatro responsabilidades válidas; frete
somente `MOTOBOY`, `SISTEMA` e `INDEFINIDO`. Distribuições desse motivo continuam
proibidas. Demais triggers, append-only, owner, limites e proteção contra
over-refund são preservados. Não há coluna nova.

Falha em products, freight ou evento reverte classificação completa, evento e
todos os refunds. Nenhuma mutação operacional é feita. Projeções mantêm a
pendência interna `freight_distribution_rule_undefined`, distinguem classificação
ainda necessária e frete indisponível, e exigem reconciliação para histórico
classificado sem refunds completos. Não foi adicionado backfill automático:
reproduzir a cadeia operacional na migração ampliaria o escopo e duplicaria o
gate canônico. Históricos anteriores exigem reconciliação explícita; o startup
preserva esses históricos sem criar refunds por inferência de `returned`.


### Correção das proteções financeiras de confirmation_failed

O trigger financeiro e a validação da função financeira exigem uma única
ocorrência `confirmation_failed` por Entrega, vinculada à tentativa terminal mais
recente, sem ocorrência terminal contraditória no ciclo. O classificador deve
ter papel `company` e pertencer à empresa do Pedido. O horário da classificação
precisa ser canônico, posterior ou igual ao relato e ao retorno e não futuro.
Históricos ambíguos exigem reconciliação, inclusive na projeção financeira.

O bootstrap remove o trigger dependente, reconstrói ocorrências quando necessário
e instala a única definição final do trigger dentro do mesmo `BEGIN IMMEDIATE`.
A evolução de revalidação participa da transação externa nesse caminho e mantém
sua própria transação quando chamada isoladamente. Falhas restauram schema,
dados e trigger anteriores; não há janela de escrita sem proteção nem backfill
financeiro novo. Testes executam o bootstrap completo sobre o fixture legado,
induzem falha após DROP/RENAME e repetem a inicialização preservando o histórico.


## Cancelamento pré-coleta: financeiro atômico

O ramo `BEFORE_PICKUP` de `cancelClientDelivery` chama
`recordClientCancellationBeforePickupInTransaction` após atualizar a Entrega e
registrar `client_cancelled_before_pickup`, no mesmo `BEGIN IMMEDIATE`. A função
não abre transação nem altera tentativas. Falhas desfazem inclusive atribuição,
`cancelled_at`, evento e refund de products quando a inserção de freight falha.
A serialização e a validação de estado preservam a rejeição HTTP da repetição.

A evidência SQL compartilhada entre função financeira, projeção e
`financial_entry_valid_kind_insert` exige cancelamento registrado pelo cliente
proprietário, horário canônico, ausência de custódia, coleta, tentativa ou causa
terminal concorrente. Falhas mecânicas anteriores à coleta são compatíveis;
tentativa recuperável anterior requer reconciliação explícita. O estado atual
`available` e `collected_at = NULL` não demonstram ausência de coleta histórica.

O plano verifica pagamentos únicos efetivos, proprietário, vínculos, inteiros
seguros, snapshots e refunds acumulados por componente. Inclui lançamentos que
apontem para a Entrega com Pedido divergente. Créditos históricos coerentes e sem
motivo terminal concorrente reduzem o saldo; refunds de outros desfechos,
distribuições, over-refund ou chaves incompatíveis abortam. O ledger permanece
append-only. Chaves: `delivery:<id>:client-cancelled-before-pickup:refund-products`
e `delivery:<id>:client-cancelled-before-pickup:refund-freight`. A própria chave é
reconhecida para repetição interna sem duplicar o lançamento.

Pedido pendente sem pagamentos não gera refund; pedido pago preserva `paid` e
reembolsa integralmente os componentes persistidos. Frete zero é conhecido;
frete `NULL` sem payment não cria valor, e com payment exige reconciliação.
Não há distribuição, remuneração ao motoboy ou sanção temporal. Projeções oficiais
e cancelamento pós-coleta permanecem inalterados.

O trigger autoriza somente refunds do novo motivo com evidência operacional;
proteções existentes de owner, vínculo Pedido/Entrega, valores, limites e
append-only permanecem. Nenhuma tabela/coluna é adicionada. A instalação segue
o bootstrap atômico após a evolução do schema de ocorrências, preservando bancos
legados. Não há backfill novo. Projeções de cancelamentos comprovados verificam
refunds completos e retiram a antiga pendência apenas quando reconciliados;
Pedido pago com frete desconhecido mantém `freight_amount_unavailable`. Histórico sem causa
continua pendente, e cancelamento histórico sem refunds exige reconciliação explícita.

## Cancelamento após impedimento externo: refund integral atômico

O ramo `awaiting_revalidation` de `cancelClientDelivery` verifica Entrega,
Pedido, retorno físico, última tentativa recuperável, ocorrência externa e ciclo
único pendente antes da transição. `BEGIN IMMEDIATE` serializa a disputa com
`revalidateDelivery`: um dos comandos consome o estado, e o outro falha. Se a
revalidação venceu, o estado `available` com ciclo anterior não é tratado como
cancelamento pré-coleta; a política pós-revalidação segue pendente.

Na mesma transação, a Entrega passa a `cancelled`, registra o evento específico
do cliente e chama `recordClientCancellationAfterExternalObstructionInTransaction`.
A função valida o estado terminal, pagamentos e snapshots do Pedido, lançamentos
anteriores e limites de refund; completa apenas o saldo de products/freight.
`pending` no estágio pós-coleta, inclusive sem pagamentos, exige reconciliação.
Uma falha em qualquer refund reverte também estado, horário e evento. A tentativa
e o ciclo ficam históricos, sem preencher os campos de verificação.

`financial_entry_valid_kind_insert` permite apenas refund do novo motivo com
evidência operacional, temporal e evento de cancelamento coerentes; não autoriza
distribution. A instalação do trigger continua no bootstrap transacional para
bancos novos e existentes. Nenhuma tabela é reconstruída para este incremento,
e não há backfill de refunds de cancelamentos legados. `financial.pending` usa
`freight_distribution_rule_undefined` apenas para a política interna futura da
tentativa malsucedida. Durante a espera não há refund devido; após cancelamento
e reembolso integral, não há pendência de valor ao cliente. A tentativa não
gera outra cobrança de frete nem remuneração automática.

## Erro de apresentação do endereço atribuído ao ERMES

Foi escolhida persistência dedicada, sem generalizar `delivery_revalidations`:
`system_address_resolutions` registra tentativa, ocorrência, recebimento físico,
responsabilidade, resolução, atores, horários, verificação e disponibilidade do
cliente; `system_address_blocks` registra o endereço canônico bloqueado e vincula
o impedimento ao incidente persistente. Essa separação mantém inalteradas as
invariantes de `temporary_external_obstruction` e evita cruzamento de ciclos.

`systemAddressEvidence` valida a tentativa mais recente e a cadeia coleta →
chegada → ocorrência → classificação SISTEMA → início do retorno → relato →
recebimento → resolução. A mesma definição sustenta operações, projeções e a
consulta SQL do trigger financeiro. O helper `clientAddressEvidence` permanece
específico de CLIENTE. A classificação SISTEMA deixa a tentativa ativa para
permitir confirmação normal; o retorno só começa pela ação explícita do motoboy.
No recebimento físico, a tentativa fecha como recuperável e não é reescrita se a
resolução posterior for persistente.

`corrected` consome atomicamente o ciclo pendente e redisponibiliza a mesma
Entrega, sem nova tentativa, novo código ou financeiro. `persistent` registra o
evento terminal, muda a Entrega para `returned`, cria o bloqueio canônico e
completa os refunds acumulados de products/freight na mesma transação. Uma falha
no segundo refund desfaz também primeiro refund, bloco, evento, estado e resolução.
O trigger permite somente refund ao cliente com cadeia completa e proíbe toda
distribution de `system_address_persistent`.

A chave de bloqueio tem escopo global no ERMES e igualdade estrutural dos sete
campos normalizados já suportados, sem geocodificação ou equivalência semântica.
Confirmação comercial, pagamento e criação da Entrega validam novamente o bloco;
portanto draft anterior não o contorna. Não há endpoint de desbloqueio neste
incremento. O bootstrap cria estruturas e triggers de modo repetível, sem inferir
responsabilidade, resolução, refunds ou bloqueios para históricos.

### Ajuste excepcional de Pedido antes da coleta

`order_adjustments` preserva o Pedido, a Entrega, a empresa, o proponente,
a versão comercial e as composições completa original e proposta. Os snapshots
guardam preço e peso unitários, quantidade, subtotal, peso total e frete. O
estado e os timestamps registram a decisão única do cliente, a confirmação
simulada do acréscimo e a aplicação. O índice parcial permite uma única proposta
aberta por Entrega. O cancelamento voluntário grava `cancelled_at` e evento
próprio na mesma transação do cancelamento e reembolso, preservando o estado
da decisão comercial já tomada. A transação `BEGIN IMMEDIATE` serializa propostas, decisões,
coleta e encerramento. A coleta usa a versão comercial após aplicação para
recusar comandos montados antes do ajuste.

Na criação, a aplicação valida produtos e snapshots contra o catálogo e grava
`order_adjustment_validations` na mesma transação. A linha imutável conserva a
composição e os totais, vinculados ao ajuste, Pedido e empresa por um selo HMAC
com a chave local persistida dos códigos de confirmação e domínio separado.
Aceite e pagamento exigem selo íntegro e recalculam subtotal e peso a partir dos
snapshots, sem consultar preços, pesos ou disponibilidade atuais do catálogo.
Linhas históricas sem selo permanecem fechadas para aplicação; a inicialização
não inventa evidência retroativa.
O banco e a chave local precisam ser preservados juntos. Antes das migrações, o
bootstrap verifica códigos de confirmação cifrados e evidências HMAC de qualquer
estado. Se a chave estiver ausente e houver algum desses dados, a inicialização
falha explicitamente para restauração ou reconciliação; não cria outra chave nem
regrava selos. Banco novo ou existente sem dados dependentes pode gerar uma chave
no primeiro uso criptográfico.

A aplicação troca os itens e incrementa a versão do Pedido, preservando o
destino, o destinatário, a Entrega e o código. O cálculo decimal do peso usa
a mesma regra dos rascunhos. Frete conhecido com mudança de peso exige
reconciliação até que exista entrada operacional autoritativa. A operação
preserva frete `NULL` e frete conhecido quando o peso permanece idêntico.

O ledger append-only preserva o pagamento original. Para delta não nulo,
`order-adjustment:<id>:payment-products` ou
`order-adjustment:<id>:refund-products` vincula o lançamento ao ajuste
aplicado. O leitor verifica a sequência de versões e os eventos de aceite,
pagamento e aplicação pertinentes. Para reconciliar o subtotal comercial,
subtrai os refunds de ajuste do total bruto pago em produtos. Para reembolso
terminal, subtrai todos os refunds anteriores do total pago por componente.
Falhas no ledger revertem também os itens, a decisão e os eventos da mesma
transação. O bootstrap mantém os lançamentos de ajustes e não recalcula o
pagamento original a partir da composição nova. O acréscimo é validado
contra o total bruto seguro antes do aceite e novamente antes do pagamento.
A repetição do pagamento de Pedido terminal e o bootstrap de encerramentos
com decisão financeira própria preservam o ledger existente. O backfill
legado continua aplicável aos fluxos com evidência reconhecida.

`product_unavailability_closures` registra causa e responsabilidade
`EMPRESA`, ator, timestamp e origem do encerramento. Uma rejeição referencia
a proposta decidida. A marcação empresarial sem proposta tem registro próprio.
A projeção distingue `ENCERRADO` do cancelamento voluntário `CANCELADO`.
O encerramento libera o motoboy e só é válido sem tentativa e sem evidência
de coleta. O bootstrap mantém ocorrências legadas de produto indisponível
como histórico.
