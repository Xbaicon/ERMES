# API inicial

> **Estado documental:** este contrato parte do checkpoint `baseline-0.1` e
> inclui os incrementos funcionais da Baseline 0.2 para `TentativaEntrega` e a
> fundação persistente de `OcorrenciaEntrega`/classificação de responsabilidade,
> impedimento externo/revalidação, erro de apresentação de endereço atribuído ao
> ERMES e fechamento operacional terminal por ausência ou recusa do destinatário
> e três validações inválidas do código.

Base local: `http://localhost:3000/api`

## Pública

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET | `/health` | Verificar servidor e baseline |
| POST | `/auth/register/client` | Cadastrar cliente |
| POST | `/auth/register/company` | Cadastrar empresa e responsável inicial |
| POST | `/auth/login` | Criar sessão |
| POST | `/auth/logout` | Encerrar sessão |
| GET | `/auth/me` | Consultar sessão atual |

O e-mail de acesso é normalizado e único em `users.email`, independentemente do papel. Se já existir, os dois cadastros retornam HTTP `409 Conflict` com `{ "error": "Este e-mail já está cadastrado. Use outro e-mail ou faça login." }`. No cadastro de empresa, essa regra se aplica a `accessEmail`; `companyEmail` é o contato da empresa.

## Empresa autenticada

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET/POST | `/company/products` | Listar ou cadastrar produtos |
| PATCH | `/company/products/:id` | Alterar disponibilidade do produto |
| GET/POST | `/company/couriers` | Listar ou vincular motoboys |
| GET | `/company/freight-config` | Consultar os parâmetros tarifários da própria empresa |
| PATCH | `/company/freight-config` | Alterar os parâmetros tarifários da própria empresa |
| GET | `/company/orders/drafts` | Listar os pedidos `draft` da própria empresa |
| GET | `/company/orders/:orderId` | Consultar o detalhe de um pedido `draft` da própria empresa |
| POST | `/company/orders/:orderId/confirm` | Confirmar comercialmente um `draft` da própria empresa |
| GET | `/company/order-chats` | Listar os Pedidos da empresa disponíveis no painel de chat |
| GET/POST | `/company/orders/:orderId/chat` | Consultar o histórico ou enviar mensagem no chat do Pedido |
| GET | `/company/deliveries` | Listar Entregas da própria empresa |
| GET | `/company/deliveries/:deliveryId` | Consultar Entrega e histórico da própria empresa |
| GET | `/company/delivery-occurrences` | Listar ocorrências das Entregas da própria empresa |
| POST | `/company/delivery-occurrences/:occurrenceId/classify` | Classificar definitivamente a responsabilidade de uma ocorrência |
| GET/POST | `/company/deliveries/:deliveryId/adjustment` | Consultar ou propor um ajuste excepcional da composição antes da coleta |
| POST | `/company/deliveries/:deliveryId/product-unavailable` | Encerrar antes da coleta quando não há ajuste viável |
| POST | `/company/deliveries/:deliveryId/confirm-return` | Confirmar recebimento físico do retorno |
| POST | `/company/deliveries/:deliveryId/system-address-resolution` | Resolver erro de apresentação do endereço atribuído ao ERMES |
| POST | `/freight/quote` | Exercitar tecnicamente a fórmula com entradas de teste |

### Ajuste excepcional por indisponibilidade antes da coleta

As rotas usam a Entrega e a sessão para localizar o Pedido e validar seu proprietário. Uma tentativa anterior, coleta ou histórico operacional incompatível bloqueia o fluxo. A proposta exige Pedido confirmado e pagamento original registrado.

| Método | Rota do cliente | Finalidade |
| --- | --- | --- |
| GET | `/client/deliveries/:deliveryId/adjustment` | Consultar a proposta mais recente |
| POST | `/client/deliveries/:deliveryId/adjustment/:adjustmentId/accept` | Registrar aceite explícito |
| POST | `/client/deliveries/:deliveryId/adjustment/:adjustmentId/reject` | Rejeitar proposta pendente e encerrar |
| POST | `/client/deliveries/:deliveryId/adjustment/:adjustmentId/pay` | Confirmar pagamento simulado da diferença aceita |

A empresa lê `orderVersion` e `currentItems` em `GET .../adjustment`. Para propor,
envia `{"version":4,"items":[{"productId":8,"quantity":2}]}`. A lista representa a
composição final, sem IDs duplicados. A omissão de um item o remove. Produtos
introduzidos devem estar disponíveis no catálogo da mesma empresa. Itens
preservados mantêm preço e peso históricos. O servidor valida o limite de 12 kg
e os limites de valores inteiros. Frete `null` permanece `null`. Frete conhecido
com mudança de peso exige reconciliação enquanto faltarem dados autoritativos
para recálculo. Após a proposta ser validada, seus snapshots persistidos são
preservados: mudanças posteriores de preço, peso ou disponibilidade no catálogo
não alteram o valor aceito nem o pagamento adicional.
O banco e a chave criptográfica local devem ser preservados juntos: se houver
código de confirmação cifrado ou evidência de ajuste e a chave faltar, a
inicialização exige restauração ou reconciliação, sem gerar chave substituta.

As ações do cliente recebem `{}`. A proposta contém `id`, `baseVersion`,
`state`, `original`, `proposed`, `differenceCents`, `requiresPayment`, `decision`
e timestamps de criação, decisão, pagamento, aplicação e cancelamento voluntário. Cada composição
contém itens, subtotal, peso e frete. O aceite leva a `applied` ou, quando há
acréscimo, a `awaiting_payment`. O estado inicial é `pending`. Ambos os
estados abertos bloqueiam a logística e preservam o motoboy atribuído. A
rejeição de `pending` leva a `rejected` e encerra a operação. Uma decisão já
registrada permite repetição do mesmo comando sem repetir seus efeitos enquanto
o Pedido não tiver sido cancelado voluntariamente. Antes do aceite com acréscimo
e no pagamento da diferença, a API valida a coerência do ledger e o limite
seguro do total bruto. Uma diferença inviável retorna `409` sem alterar a proposta.

O cliente ainda pode usar `POST /client/deliveries/:deliveryId/cancel` antes da
primeira coleta, inclusive com ajuste aberto. A transação encerra o ajuste
(`state: "cancelled"`, `cancelledAt`) e preserva a decisão anterior em
`decision`. O Pedido projeta `CANCELADO`, com reembolso do saldo pago e sem
registro de indisponibilidade ou atribuição de responsabilidade à empresa.


A empresa pode enviar `{}` a `product-unavailable` quando não há ajuste aberto.
Se a Entrega já passou por um ajuste aplicado, deve enviar a versão comercial
vigente, como `{"version":5}`. A versão evita que um encerramento solicitado
sobre uma composição antiga avance após o aceite. A repetição do
encerramento retorna `409` sem duplicar efeitos. Sem acordo, a resposta projeta
Entrega `CANCELADA` e Pedido `ENCERRADO`, com `unavailability` indicando motivo
`PRODUTO_INDISPONIVEL`, responsabilidade `EMPRESA` e origem `company_no_adjustment`
ou `client_rejected`. Os valores efetivamente pagos ainda em saldo são
devolvidos. Pedido pago com frete conhecido e pagamento de frete ausente ou
divergente exige reconciliação antes do encerramento. A atribuição termina
sem nova tentativa ou distribuição.

A consulta da empresa indica `canPropose` e `canCloseUnavailable` com as
mesmas evidências pré-coleta usadas nas operações de escrita. Uma Entrega
redisponibilizada após tentativa anterior permanece inelegível.

O detalhe da Entrega disponibiliza `adjustment`, `unavailability` e
`collectionBlocked` aos titulares. O detalhe do Pedido confirmado do cliente
também inclui `adjustment`. Ao motoboy a API expõe o bloqueio operacional e a
`pickupVersion` no detalhe. Após ajuste aplicado, envie
`{"pickupVersion":5}` no comando `collect`, usando o valor recém-consultado.
Entregas sem ajuste aplicado continuam usando `{}`.

Recursos de outro titular retornam `404`. Validação de entrada retorna `400`.
Versão obsoleta, estado incompatível e bloqueio operacional retornam `409`.
Inconsistência financeira exige reconciliação com reversão integral da
transação.

### Valores numéricos dos produtos

`POST /company/products` exige `priceCents` como número inteiro não negativo até
`Number.MAX_SAFE_INTEGER` e `unitWeightKg` como número finito positivo.
Strings, valores não finitos, preço fracionário ou fora do intervalo seguro e
peso não positivo retornam `400` antes de persistir. Não há novo limite comercial
de preço. O PATCH existente altera somente disponibilidade, não preço ou peso.

### Parâmetros tarifários

As duas rotas de parâmetros tarifários exigem sessão com papel `company`. A empresa é identificada exclusivamente pelo `companyId` da sessão armazenada no servidor; a API não aceita identificadores de empresa ou usuário no corpo ou na URL.

`GET /company/freight-config` retorna HTTP `200` com os seis valores monetários em reais, representados por strings decimais com duas casas:

```json
{
  "freightConfig": {
    "under1Kg": "3.00",
    "from1To3Kg": "5.00",
    "from3To8Kg": "9.00",
    "from8To12Kg": "12.00",
    "perKm": "0.50",
    "perMinute": "0.30"
  }
}
```

`PATCH /company/freight-config` recebe ao menos um desses mesmos campos. Cada valor deve ser um decimal não negativo em reais, com no máximo duas casas; a API converte e persiste o valor como centavos inteiros. Campos fora dessa lista, incluindo `companyId`, `userId`, `maxWeightKg` e `max_weight_kg`, retornam HTTP `400`. Valores negativos, malformados, com mais de duas casas ou acima do limite seguro para conversão também retornam `400`. Ausência de sessão retorna `401`, e qualquer papel diferente de `company` retorna `403`.

O limite máximo por pedido é uma regra fixa de 12 kg. Ele não é retornado nem editável nessas rotas, e a cotação aplica esse limite independentemente da coluna legada `max_weight_kg`.

### Consulta de pedidos draft

As rotas de consulta exigem sessão com papel `company`. A empresa é
identificada exclusivamente pelo `companyId` da sessão no servidor; nenhum
identificador de empresa ou cliente é recebido do navegador.

`GET /company/orders/drafts` retorna HTTP `200` com os resumos dos pedidos
em estado `draft` cujo `company_id` pertence à sessão. A resposta é
`{ "drafts": [] }` quando não existem pedidos para análise.

`GET /company/orders/:orderId` exige identificador decimal inteiro, positivo e
seguro. Em sucesso, retorna HTTP `200` com `id`, `status`, itens e seus
snapshots de preço/peso, subtotal, peso total, `destinationSnapshot` e
`recipientSnapshot` preservados. O destinatário expõe somente `type` (`self`
ou `other`) e `name`, necessários à análise e à operação; a projeção não inclui
conta do cliente, e-mail, sessão, senha, pagamento, frete, rota ou entrega.

Pedido inexistente ou pertencente a outra empresa retorna `404`, sem revelar
sua existência. Pedido da própria empresa que não esteja mais em `draft`
retorna `409`; identificador inválido retorna `400`. Ausência de sessão
retorna `401`, e papéis diferentes de `company` retornam `403`. As rotas
são exclusivamente de leitura: não confirmam, cancelam, excluem ou alteram
pedidos.

### Confirmação comercial do pedido

Os resumos e o detalhe retornados pelas duas rotas GET incluem `version`,
que identifica a versão comercial persistida do `draft`.

`POST /company/orders/:orderId/confirm` exige sessão `company`, valida o
`orderId` e identifica a empresa exclusivamente pela sessão. O corpo aceita
somente a versão inteira positiva que a empresa analisou:

```json
{ "version": 2 }
```

A operação compara essa versão com `orders.version` dentro de uma
transação. Cada alteração efetiva dos itens de um `draft` incrementa
a versão; um salvamento sem mudança comercial não a incrementa. Divergência
retorna `409` sem alteração parcial, para que a empresa recarregue e analise
a versão atual.

Em sucesso, a transição é `draft -> confirmed`, o servidor grava
`confirmed_at` e retorna HTTP `200` com o pedido confirmado, incluindo
`version` e `confirmedAt`. Se o pedido já estiver confirmado, a repetição
somente é idempotente quando a `version` enviada for igual à versão confirmada:
nesse caso, retorna `200` com a mesma representação, sem mudar novamente o
timestamp ou produzir qualquer outro efeito. Uma versão diferente retorna
`409`, pois a versão analisada não corresponde à versão confirmada.

Pedido inexistente ou de outra empresa retorna `404`; versão desatualizada
ou estado incompatível retorna `409`; identificador ou corpo inválido retorna
`400`; ausência de sessão retorna `401`; e papel diferente de `company`
retorna `403`.

A confirmação recalcula e valida os itens persistidos, o subtotal, o peso
máximo de 12 kg, o destino e o destinatário preservados. Ela usa os snapshots do pedido e não
passa a depender da disponibilidade atual do produto. Esta operação não
cria entrega, pagamento, frete ou rota, não altera `payment_status`,
`freight_total_cents` ou `route_snapshot_json` e não exige geocodificação,
mapa, GPS, distância ou tempo operacional.

## Cliente autenticado

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET | `/client/companies` | Listar empresas ativas disponíveis para consulta |
| GET | `/client/companies/:companyId/products` | Listar produtos disponíveis da empresa escolhida |
| GET | `/client/default-address` | Consultar o endereço padrão do próprio cliente |
| PUT | `/client/default-address` | Cadastrar ou substituir integralmente o endereço padrão do próprio cliente |
| POST | `/client/orders` | Criar pedido em estado `draft` a partir do carrinho |
| GET | `/client/orders/drafts` | Listar os pedidos `draft` do próprio cliente |
| GET | `/client/orders/confirmed` | Listar os pedidos `confirmed` do próprio cliente para consulta de pagamento |
| GET | `/client/orders/confirmed/:orderId` | Consultar um pedido `confirmed` do próprio cliente |
| GET | `/client/orders/:orderId` | Consultar um pedido `draft` do próprio cliente |
| PUT | `/client/orders/:orderId/items` | Substituir integralmente os itens de um pedido `draft` próprio |
| POST | `/client/orders/:orderId/pay` | Confirmar de forma simulada o pagamento de um pedido `confirmed` próprio |
| GET | `/client/order-chats` | Listar os próprios Pedidos disponíveis no painel de chat |
| GET/POST | `/client/orders/:orderId/chat` | Consultar o histórico ou enviar mensagem no chat do Pedido |
| GET | `/client/deliveries` | Listar as próprias Entregas |
| GET | `/client/deliveries/:deliveryId` | Consultar estado e histórico de Entrega própria |
| POST | `/client/deliveries/:deliveryId/cancel` | Cancelar Entrega própria quando permitido |

Todas as rotas desta seção exigem sessão com papel `client`. Ausência de sessão retorna `401`, e papéis diferentes de `client` retornam `403`.

### Consulta do catálogo

`GET /client/companies` retorna apenas `id` e `name` das empresas com estado `active`, ordenadas por nome. Quando não existe nenhuma, a resposta continua sendo HTTP `200` e contém uma lista vazia:

```json
{
  "companies": []
}
```

`GET /client/companies/:companyId/products` exige um identificador decimal inteiro, positivo e seguro. Um identificador malformado retorna `400`; uma empresa inexistente ou que não esteja ativa retorna `404`. A resposta contém a empresa selecionada e somente os produtos que pertencem simultaneamente a ela e têm `is_available = 1`:

```json
{
  "company": {
    "id": 1,
    "name": "Empresa Demonstrativa"
  },
  "products": [
    {
      "id": 1,
      "name": "Produto demonstrativo",
      "description": "Item cadastrado para validar o fluxo inicial.",
      "priceCents": 1990,
      "unitWeightKg": 0.5
    }
  ]
}
```

Uma empresa ativa sem produtos disponíveis retorna HTTP `200` com `products: []`. A API não recebe disponibilidade nem propriedade do navegador: os dois critérios são aplicados na consulta ao banco. Os dados retornados são uma projeção mínima para consulta; não incluem CNPJ, e-mail, telefone, endereço, estado interno da empresa ou o campo interno de disponibilidade.

### Endereço padrão

O proprietário do endereço é identificado exclusivamente pelo `id` da sessão no servidor; a API não aceita `clientId`, `userId` nem qualquer outro identificador externo no corpo ou na URL.

`GET /client/default-address` retorna HTTP `200`. Quando o cliente ainda não possui endereço, a resposta é:

```json
{
  "defaultAddress": null
}
```

`PUT /client/default-address` recebe a representação completa do endereço com `postalCode`, `state`, `city`, `neighborhood`, `street`, `number` e, opcionalmente, `complement`. O CEP é normalizado para oito dígitos, a UF para duas letras maiúsculas e os textos têm espaços externos removidos. O mesmo contrato é usado tanto no primeiro cadastro quanto na substituição:

```json
{
  "postalCode": "01001000",
  "state": "SP",
  "city": "São Paulo",
  "neighborhood": "Sé",
  "street": "Praça da Sé",
  "number": "10",
  "complement": "Apto 2"
}
```

Campos obrigatórios ausentes ou vazios, formatos inválidos e campos inesperados retornam HTTP `400`.

O endereço padrão é um cadastro atual em `client_default_addresses`. Substituí-lo não atualiza nem relaciona automaticamente `orders.destination_snapshot_json`, que permanece como registro histórico independente do destino usado em cada pedido.

### Criação de pedido draft

`POST /client/orders` recebe `companyId`, `items` e, opcionalmente, as escolhas
`destination` e `recipient`; cada item recebe somente `productId` e `quantity`.
Omissão das duas escolhas preserva o contrato anterior: endereço padrão e o
próprio cliente como destinatário.

```json
{
  "companyId": 1,
  "items": [
    { "productId": 10, "quantity": 2 }
  ],
  "destination": {
    "type": "manual",
    "address": {
      "postalCode": "20040002",
      "state": "RJ",
      "city": "Rio de Janeiro",
      "neighborhood": "Centro",
      "street": "Rua da Assembleia",
      "number": "25",
      "complement": "Portaria B"
    }
  },
  "recipient": { "type": "other", "name": "Pessoa Autorizada" }
}
```

`destination` aceita exclusivamente `{ "type": "default" }` ou
`{ "type": "manual", "address": { ... } }`. O endereço manual usa os mesmos
sete campos e a mesma normalização do endereço padrão; `complement` é opcional.
Ele pertence somente ao Pedido e não altera `client_default_addresses`.

`recipient` aceita exclusivamente `{ "type": "self" }` ou
`{ "type": "other", "name": "..." }`. Para `self`, o servidor captura o nome
do cliente autenticado; para `other`, `name` é obrigatório e normalizado pela
remoção de espaços externos. Telefone não é obrigatório e não é aceito neste
contrato, pois os campos adicionais definitivos do destinatário continuam
PENDENTES na Baseline 0.1. O destinatário não ganha conta no ERMES.

Identificadores e quantidades devem ser números inteiros positivos dentro do intervalo seguro do JavaScript. O pedido exige ao menos um item e não aceita o mesmo produto duas vezes; aumente a quantidade do item existente. Campos inesperados em qualquer nível são rejeitados com `400`, inclusive identificadores de cliente, preços, pesos, status, frete, rota e snapshots arbitrários enviados pelo navegador.

O cliente é identificado exclusivamente pela sessão. A empresa precisa estar ativa e cada produto deve existir, pertencer a ela e estar disponível. Um endereço padrão cadastrado é necessário somente quando `destination.type = default`; o endereço manual permite criar o Pedido sem cadastro padrão. O servidor lê preço e peso atuais dos produtos, calcula `itemsTotalCents` em centavos inteiros e `weightKg` com comparação decimal exata ao limite de 12 kg, e copia o endereço efetivo e o destinatário para snapshots do pedido. O subtotal deve caber em inteiro seguro. Erros de validação retornam `400`; ausência do endereço padrão escolhido, produto indisponível ou de outra empresa retorna `409`; empresa ou produto inexistente retorna `404`. Ausência de sessão retorna `401`, e outro papel retorna `403`.

Em sucesso, retorna `201`:

```json
{
  "order": {
    "id": 1,
    "status": "draft",
    "company": { "id": 1, "name": "Empresa Demonstrativa" },
    "items": [
      { "productId": 10, "name": "Produto demonstrativo", "quantity": 2,
        "unitPriceCents": 1990, "unitWeightKg": 0.5 }
    ],
    "itemsTotalCents": 3980,
    "weightKg": 1,
    "destinationSnapshot": {
      "postalCode": "01001000", "state": "SP", "city": "São Paulo",
      "neighborhood": "Sé", "street": "Praça da Sé", "number": "10", "complement": "Apto 2"
    },
    "recipientSnapshot": { "type": "self", "name": "Cliente Demonstrativo" }
  }
}
```

Pedido, subtotal, endereço, destinatário e snapshots unitários dos itens são gravados numa única transação. `route_snapshot_json` e `freight_total_cents` permanecem `NULL`; nenhuma entrega é criada. O carrinho no painel existe apenas na memória da página, portanto desaparece ao recarregá-la. A prévia de subtotal e peso no navegador não é autoritativa e pode diferir se o produto mudar antes do envio. A criação não confirma o pedido nem inicia pagamento ou entrega.

### Consulta e edição de pedidos draft

`GET /client/orders/drafts` retorna somente pedidos com estado `draft` cujo `client_id` corresponde ao usuário da sessão. A listagem contém dados resumidos para seleção:

```json
{
  "drafts": [
    {
      "id": 1,
      "status": "draft",
      "company": { "id": 1, "name": "Empresa Demonstrativa" },
      "itemCount": 2,
      "itemsTotalCents": 8570,
      "weightKg": 1.75,
      "createdAt": "2026-09-28 14:00:00",
      "updatedAt": "2026-09-28 14:05:00"
    }
  ]
}
```

Quando não há rascunhos, a resposta é HTTP `200` com `drafts: []`.

`GET /client/orders/:orderId` devolve a mesma representação completa documentada na criação: empresa, itens com preço e peso unitários preservados, subtotal, peso total e snapshots de destino e destinatário. O identificador deve ser um inteiro decimal positivo e seguro, sem sinal, fração, notação exponencial ou zeros à esquerda.

`PUT /client/orders/:orderId/items` representa a lista completa que deve permanecer no pedido:

```json
{
  "items": [
    { "productId": 10, "quantity": 3 },
    { "productId": 12, "quantity": 1 }
  ]
}
```

O corpo aceita somente `items`, e cada item aceita somente `productId` e `quantity`. A lista não pode ser vazia, produtos não podem se repetir e todos os identificadores e quantidades devem ser inteiros positivos seguros. Campos de proprietário, empresa, preço, peso, status, endereço, subtotal, frete, rota ou snapshots são rejeitados com `400`.

O cliente e a empresa do pedido não são recebidos do navegador. As consultas combinam o `orderId` com o `client_id` da sessão. Pedido inexistente ou pertencente a outro cliente retorna `404`, sem revelar a existência do recurso alheio. Pedido próprio que não está mais em `draft` retorna `409`. Ausência de sessão retorna `401`, e empresa, motoboy ou administrador recebem `403`.

Na atualização, itens que já estavam persistidos no draft mantêm seus `unit_price_cents` e `unit_weight_kg`, mesmo que o cadastro atual do produto tenha mudado; alterar sua quantidade recalcula os totais com esses snapshots. Um produto realmente novo precisa existir, pertencer à empresa imutável do pedido e estar disponível, e recebe preço e peso atuais do banco como novos snapshots. Se um item foi removido e salvo, uma inclusão posterior é uma nova adição e captura os valores vigentes naquele momento.

O servidor recalcula subtotal e peso a partir da versão resultante, aceita exatamente 12 kg e rejeita peso superior ou subtotal acima do inteiro seguro. A substituição de `order_items` e a atualização de `orders.items_total_cents` ocorrem numa única transação. Qualquer falha restaura integralmente a versão anterior. `destination_snapshot_json` e `recipient_snapshot_json` não são atualizados nem reconstruídos a partir dos cadastros atuais; rota, frete, pagamento, status e entregas também não são modificados. A Baseline 0.1 não define com segurança uma operação posterior para trocar destino ou destinatário do draft, portanto esta API preserva a escolha da criação e mantém o `PUT` restrito aos itens. Em sucesso, o `PUT` retorna HTTP `200` com `{ "order": ... }` normalizado pelo servidor.

Cada alteração efetiva da composição ou quantidade dos itens
incrementa `orders.version`; reenviar a mesma composição não incrementa.
Depois da confirmação comercial, tanto a consulta de `draft` quanto o `PUT`
de itens retornam `409`, e a interface informa que o pedido não está mais
disponível para edição direta.

### Consulta e pagamento simulado de pedidos confirmados

`GET /client/orders/confirmed` lista somente pedidos com `status = confirmed`
cujo `client_id` corresponde à sessão. A lista inclui pedidos com pagamento
`pending` ou `paid`, a empresa, quantidade de itens, subtotal preservado,
`freightTotalCents`, situação e datas do pagamento e da confirmação comercial.
Quando houver lançamentos, `refundStatus` é derivado separadamente como `none`,
`partial` ou `full`, e `refundedTotalCents` informa o total restituído.
Quando o frete ainda não foi definido, `freightTotalCents` é `null`; ele não é
convertido para zero nem apresentado como frete grátis.

`GET /client/orders/confirmed/:orderId` retorna a representação completa e
somente leitura do pedido confirmado próprio, incluindo itens e seus snapshots,
subtotal, peso, destino e destinatário preservados, `paymentStatus`, `paymentPaidAt`,
`confirmedAt` e `freightTotalCents`. Pedido inexistente ou de outro cliente
retorna `404` sem revelar sua existência. Pedido próprio que não esteja
`confirmed` retorna `409`.

`GET /client/deliveries/:deliveryId` inclui `confirmationCode` somente nos estados
`available`, `heading_to_pickup`, `awaiting_pickup`, `in_transit` e
`awaiting_confirmation`, permitindo reconsultá-lo após reabrir o painel. Nos
demais estados o campo é omitido, inclusive durante retorno recuperável e
`awaiting_revalidation` (`AGUARDANDO_REVALIDACAO`). O código pertence à mesma
Entrega e permanece preservado no banco entre tentativas; ocultá-lo na resposta
não o remove nem o substitui. Listagens, empresa e motoboy nunca recebem o código
nem seus dados internos.

`POST /client/orders/:orderId/pay` confirma o passo de pagamento simulado do
protótipo acadêmico. O corpo deve ser um objeto vazio (`{}`); valores de itens,
frete, total, situação ou data de pagamento enviados pelo navegador são
rejeitados. O servidor exige ownership, `status = confirmed`, dados comerciais
persistidos íntegros e `payment_status = pending`; `paid` é aceito somente como
repetição idempotente da operação já consolidada.

Na primeira confirmação válida, a transição atômica é:

```text
payment_status: pending -> paid
status: confirmed -> confirmed
payment_paid_at: null -> horário do servidor
```

A transação atualiza somente uma linha elegível e garante uma Entrega
`available` com `delivery_created`. Pedido, Entrega, hash do código, evento
inicial e lançamentos conhecidos do pagamento são atômicos. A primeira resposta inclui `order`, `delivery`,
`created: true` e `confirmationCode`. O banco mantém hash `scrypt` para validar
e uma representação cifrada para que somente a consulta autenticada do cliente
possa recuperar o mesmo código durante a operação. Requisições simultâneas
produzem uma única Entrega e um único evento. Repetições preservam
identificadores, timestamps, estado e código, retornando `created: false`.

A resposta de `POST /api/client/orders/:orderId/pay` inclui `status` e
`officialStatus` no objeto `delivery`, mas não inclui `orderOfficialStatus`.
Os dois casos abaixo retornam `200`:

| Contexto | `delivery.status` | `delivery.officialStatus` | `created` | `confirmationCode` |
| --- | --- | --- | --- | --- |
| Primeiro pagamento válido | `available` | `DISPONIVEL` | `true` | Código de seis dígitos |
| Repetição idempotente com a mesma Entrega aguardando revalidação | `awaiting_revalidation` | `AGUARDANDO_REVALIDACAO` | `false` | `null` |

Na repetição durante revalidação, a Entrega existente e seu estado são
preservados: não há novo pagamento, Entrega, tentativa ou lançamento financeiro,
nem liberação automática. O código continua armazenado na mesma Entrega, mas
fica oculto nessa resposta. Nas repetições, o pagamento só retorna o código nos
mesmos cinco estados permitidos para sua consulta pelo cliente; nos demais,
retorna `confirmationCode: null`, enquanto o GET omite o campo.

O significado inicial de `paid` é exclusivamente a confirmação simulada do
passo acadêmico: não há Pix, cartão, gateway, banco, cobrança real, webhook ou
comprovante. A operação não calcula nem altera frete e não soma um total fictício
quando o frete está ausente. Ela persiste em `financial_entries` o componente de
produtos e, somente se `freight_total_cents` já possuir valor válido, o componente
de frete. Cada componente tem chave idempotente, referência ao Pedido e à Entrega,
valor em centavos e o mesmo horário preservado do pagamento. Repetições não criam
outro lançamento. `paymentStatus` continua `paid` após qualquer reembolso; a API
expõe `refundStatus` separadamente, derivado dos lançamentos como `none`, `partial`
ou `full`.

Identificador ou corpo inválido retorna `400`; ausência de sessão retorna `401`;
empresa, motoboy e administrador recebem `403`; recurso alheio ou inexistente
retorna `404`; e estado comercial, financeiro ou dados persistidos
incompatíveis retornam `409`.

### Chat por Pedido

O chat usa as rotas equivalentes de cliente e empresa. O servidor deriva o
remetente e o proprietário exclusivamente da sessão; não recebe `clientId`,
`companyId`, papel ou identificador de remetente do navegador. Pedido inexistente
ou alheio retorna `404`, sem revelar sua existência. Motoboy, administrador e
qualquer papel diferente do prefixo autenticado recebem `403`.

`GET /client/order-chats` e `GET /company/order-chats` retornam `{ "orders": [] }`
quando não existem Pedidos. Cada item contém somente `orderId`, `orderStatus`,
`deliveryStatus`, `readOnly`, `hasMessages`, `createdAt` e `updatedAt`. A listagem
abrange drafts e pedidos confirmados, mesmo antes de pagamento ou Entrega.

`GET /{role}/orders/:orderId/chat` retorna:

```json
{
  "chat": {
    "orderId": 12,
    "orderStatus": "draft",
    "deliveryStatus": null,
    "readOnly": false,
    "messages": [
      {
        "id": 31,
        "senderRole": "client",
        "message": "Olá, gostaria de tirar uma dúvida sobre o pedido.",
        "sentAt": "2026-10-20 14:30:00"
      }
    ]
  }
}
```

O histórico é ordenado por ID crescente, que também desempata mensagens com o
mesmo segundo. IDs de usuário, sessão e dados cadastrais dos participantes não
são expostos. Uma conversa sem mensagens retorna `messages: []` e não cria
registro vazio no banco.

`POST /{role}/orders/:orderId/chat` recebe exclusivamente:

```json
{ "message": "Texto da mensagem" }
```

O texto tem espaços externos removidos, deve continuar não vazio e possui limite
técnico de 2.000 caracteres. Corpo nulo, lista, tipo não textual, campo ausente,
somente espaços ou campos adicionais retornam `400`. Cada envio válido retorna
HTTP `201` com a mensagem persistida. Textos idênticos não são deduplicados.

Os únicos estados de Pedido atualmente graváveis são `draft` e `confirmed`.
Quando a Entrega vinculada está `completed`, `cancelled` ou `returned`, o GET
continua disponível com `readOnly: true` e o POST retorna `409`. Estados de
Pedido desconhecidos também são tratados com segurança como somente leitura.
Mensagens não possuem endpoints de edição ou exclusão, e o banco rejeita UPDATE
e DELETE. A interface oferece as listas fixas aprovadas na Baseline 0.1 e atualiza
a conversa selecionada por polling HTTP a cada cinco segundos.

## Motoboy autenticado

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET/PATCH | `/courier/availability` | Consultar ou alterar online/offline |
| GET | `/courier/deliveries/available` | Listar Entregas disponíveis da empresa do motoboy |
| GET | `/courier/deliveries/current` | Consultar a Entrega ativa atribuída e seu histórico |
| GET | `/courier/financial-entries` | Listar somente as remunerações de frete do motoboy autenticado |
| POST | `/courier/deliveries/:id/accept` | Aceitar Entrega disponível |
| POST | `/courier/deliveries/:id/arrive-pickup` | Registrar chegada ao estabelecimento |
| POST | `/courier/deliveries/:id/collect` | Registrar coleta |
| POST | `/courier/deliveries/:id/arrive-destination` | Registrar chegada ao destino |
| POST | `/courier/deliveries/:id/confirm` | Validar código e concluir |
| POST | `/courier/deliveries/:id/fail` | Registrar falha com motivo |
| POST | `/courier/deliveries/:id/occurrences` | Registrar ausência, recusa ou problema de endereço no destino |
| POST | `/courier/deliveries/:id/system-address-return` | Iniciar retorno explícito após `address_problem/SISTEMA` |
| POST | `/courier/deliveries/:id/report-return` | Registrar devolução física à empresa |

### Operação e autorização de Entregas

Os detalhes de Entrega consultados por cliente, empresa e motoboy usam
`orders.destination_snapshot_json` e `orders.recipient_snapshot_json`, nunca o
endereço ou nome atuais do cadastro. O motoboy recebe somente o destino efetivo,
o tipo e o nome do destinatário necessários à execução; nenhum cadastro ou
telefone adicional do destinatário é criado ou exposto.

Identificadores de cliente, empresa e motoboy vêm da sessão e das relações no
banco. Recursos de outra empresa ou cliente retornam `404`. Aceite exige
motoboy online, da mesma empresa e sem outra Entrega ativa. A Entrega aceita
passa para `heading_to_pickup` e grava `accepted_at`; coleta grava
`collected_at` e cria exatamente uma tentativa ativa; conclusão grava
`completed_at`. Aceite, deslocamento, chegada ao estabelecimento e falha antes
da coleta não criam tentativa. Atalhos, retrocessos e ator incorreto retornam
conflito ou recurso não encontrado.

As consultas de detalhe de Entrega para cliente, empresa e motoboy incluem
`attempts`, ordenado por `attemptNumber`. A inclusão é aditiva; as listagens
resumidas permanecem inalteradas. Cada item tem a forma:

```json
{
  "id": 7,
  "attemptNumber": 1,
  "status": "active",
  "invalidCodeAttempts": 0,
  "startedAt": "2026-11-04 14:30:00",
  "endedAt": null,
  "endReason": null,
  "endNature": null,
  "courier": { "fullName": "Motoboy Exemplo" }
}
```

Os status expostos neste incremento são `active`, `returning`, `completed` e
`closed_unsuccessfully`. `endNature` é `recoverable`, `terminal` ou `null`. O
código de confirmação não faz parte da tentativa e continua na Entrega; somente
o cliente autorizado o recebe durante os estados já documentados.

`POST .../confirm` recebe somente `{ "code": "123456" }`. Código correto em
`awaiting_confirmation` conclui a Entrega e a tentativa ativa na mesma
transação. Cada erro incrementa `delivery_attempts.invalid_code_attempts` da
tentativa ativa e grava apenas número e horário da validação; a resposta usa HTTP `422` com
`{ "error": "Código inválido." }`. No terceiro erro, a Entrega passa
para `returning` e a tentativa deixa de aceitar confirmação; ela somente é
encerrada como terminal depois que o motoboy registra o retorno e a empresa
confirma o recebimento. A falha não presume responsabilidade do cliente e não há
método alternativo de conclusão. Hashes, códigos digitados, sessão e dados
cadastrais sensíveis não aparecem nas respostas.

`invalidCodeAttempts` no objeto da Entrega é uma projeção derivada da tentativa
mais recente; cada item de `attempts` expõe seu próprio contador. A coluna
homônima em `deliveries` permanece fisicamente apenas por compatibilidade com o
schema legado: não é incrementada nem consultada pelo fluxo operacional.

### Ocorrências e classificação de responsabilidade

Falha do motoboy antes da coleta, falha após a coleta, destinatário ausente,
recusa do destinatário e a terceira validação inválida criam uma
`OcorrenciaEntrega` na mesma transação da transição e do evento operacional já
existente. Antes da coleta, a ocorrência não possui tentativa. Depois da coleta,
ela referencia a `TentativaEntrega` aberta. Repetir ou falhar a operação não
deixa ocorrência, estado ou evento parcial.

`GET /company/delivery-occurrences` exige papel `company`, deriva a empresa da
sessão e retorna somente ocorrências de suas Entregas, em ordem cronológica
estável. Cada item contém `id`, `deliveryId`, `deliveryAttemptId`, `type`,
`description`, `reportedAt`, relator reduzido a nome/papel, estado da
classificação, `responsibility`, `classifiedAt`, classificador reduzido a
nome/papel e `analysisResult`. `address_problem` acrescenta `addressEvidence`
com `originalAddress` e `presentedAddress` normalizados. Evidências internas brutas, IDs dos usuários, dados de
sessão e informações sensíveis não são expostos.

`POST /company/delivery-occurrences/:occurrenceId/classify` aceita somente:

```json
{
  "responsibility": "MOTOBOY",
  "analysisResult": "Resultado opcional da análise"
}
```

`responsibility` é obrigatório e deve ser exatamente `CLIENTE`, `EMPRESA`,
`MOTOBOY`, `SISTEMA` ou `INDEFINIDO`. `NULL` significa que ainda não houve
classificação; `INDEFINIDO` é uma decisão registrada e final. `analysisResult`
é opcional, textual e limitado a 2000 caracteres. A primeira classificação
grava classificador, horário e `occurrence_classified` atomicamente. Uma segunda
classificação retorna `409`. Ocorrência inexistente ou de outra empresa retorna
`404`; cliente e motoboy recebem `403`.

Para `confirmation_failed`, somente `CLIENTE`, `MOTOBOY`, `SISTEMA` e
`INDEFINIDO` são aceitas. `EMPRESA` retorna `400` nesse cenário, mas continua
válida no enum global para outras ocorrências. A classificação exige retorno
físico confirmado e evidência terminal coerente: durante `returning`, durante
`awaiting_return_confirmation` ou com ciclo inconsistente retorna `409`, sem
mutação. A restrição temporal é exclusiva de `confirmation_failed`.

A classificação genérica não altera o estado da Entrega nem o ciclo da tentativa.
Para `address_problem`, `CLIENTE` inicia o retorno após validar a evidência, na
mesma transação do evento. `SISTEMA` apenas registra a classificação nesse ponto:
a tentativa continua ativa para conclusão segura ou para a ação explícita de
retorno documentada abaixo. `EMPRESA`, `MOTOBOY` e `INDEFINIDO` continuam sem
desfecho operacional inventado.
Exclusivamente para `confirmation_failed`, aplica as consequências financeiras
do cliente na mesma transação, conforme a seção financeira abaixo. As demais
ocorrências mantêm a classificação sem efeitos financeiros. Não há nova interface visual.
A autorização usa somente o papel técnico atual `company`;
`RESPONSAVEL` e `ATENDENTE` ainda não foram implementados.

### Projeções financeiras

O detalhe da Entrega inclui uma projeção `financial` própria do papel. O cliente
recebe `paymentStatus`, `refundStatus`, componentes pagos conhecidos, reembolsos e total
reembolsado; não recebe a distribuição destinada à empresa, ao motoboy ou ao
ERMES. A empresa recebe somente parcelas destinadas à própria empresa. O motoboy
recebe somente parcelas destinadas a ele. Identificadores internos das partes e
chaves idempotentes não são expostos.

`GET /courier/financial-entries` exige papel `courier` e usa exclusivamente o
usuário e a empresa da sessão. Retorna `{ "entries": [], "totalReceivedCents": 0 }`
quando não há remuneração. Cada item contém apenas `deliveryId`, `orderId`,
`component`, `amountCents`, `reason` e `occurredAt`. Um motoboy não consegue
consultar remunerações de outro.

Na conclusão normal, a mesma transação que grava `delivery_completed` persiste
70% do frete para o motoboy, 25% para a empresa e 5% para o ERMES. A soma das
parcelas sempre coincide com o frete preservado. O cálculo usa aritmética inteira,
trunca as três parcelas e distribui resíduos pela maior fração, com desempate na
ordem motoboy, empresa e ERMES. No cancelamento do cliente após
a coleta, a mesma transação registra reembolso integral dos produtos, metade do
frete ao cliente e o restante do frete ao motoboy; em frete ímpar, a metade do
cliente é arredondada para o centavo superior e o motoboy recebe o restante.
Produto indisponível registra reembolso integral somente dos componentes
efetivamente pagos e persistidos; componente não pago não gera lançamento.

`financial_entries` é append-only no banco. Chaves idempotentes repetidas somente
são aceitas quando Pedido, Entrega, tipo, componente, parte, valor e motivo são
semanticamente iguais; colisão divergente aborta para reconciliação. Timestamps e
IDs internos não alteram essa equivalência. UPDATE e DELETE são rejeitados.

Quando `freight_total_cents` é `NULL`, nenhum valor de frete é criado: os efeitos
sobre o frete ficam indicados em `financial.pending`. O fechamento operacional
por destinatário ausente ou recusa aplica o reembolso acumulado de produtos
e a divisão do frete 70/25/5 descritos abaixo. Endereço incorreto e três códigos
inválidos não recebem distribuição interna nova nesta etapa. Cancelamento pré-coleta
com evidência coerente aplica reembolso integral, conforme a seção abaixo.
Se o frete estiver preservado, mas faltar o lançamento de pagamento correspondente,
a conclusão aborta com reconciliação financeira e não mantém estado, evento ou
distribuição parciais; esse caso não é apresentado como frete indisponível.
Ausência de sessão retorna `401`; papel diferente retorna `403`; os detalhes de
Entrega de outro cliente ou empresa continuam retornando `404`.

Falha do motoboy antes da coleta redisponibiliza a mesma Entrega; depois da
coleta exige retorno e, após a dupla verificação, permite redisponibilização.
Cancelamento do cliente antes da coleta encerra como `cancelled`; depois da
coleta exige retorno, sem tolerância fixa ou bloqueio temporal. Ausência e recusa
iniciam retorno e só encerram a tentativa depois da confirmação física pela
empresa. `address_problem` aceita `type`, `presentedAddress` obrigatório conforme
o contrato de endereço e `description` opcional, textual e de até 500 caracteres.
O endereço original vem de `orders.destination_snapshot_json`; ambos ficam na
ocorrência imutável. O evento contém apenas `occurrenceId`. Registro isolado
mantém Entrega em `awaiting_confirmation`, tentativa `active`, responsabilidade
`null` e ledger inalterado. Duplicidade, causa terminal conflitante e confirmação
por código enquanto o problema aguarda decisão retornam `409`. Classificação
explícita `CLIENTE` inicia retorno; `report-return` e `confirm-return` continuam
obrigatórios. No recebimento físico, a tentativa encerra terminalmente, Entrega
projeta `NAO_REALIZADA` e Pedido `ENCERRADO`. Products pagos são reembolsados e
freight pago permanece cobrado, dividido 70/25/5. Frete `NULL` sem pagamento
não gera distribuição e indica `freight_amount_unavailable`. Endereço corrigido
exige novo Pedido; o snapshot original não é editado. Os corpos de transições
sem parâmetros devem ser `{}`.

Bancos atualizados a partir da primeira implementação de `TentativaEntrega`
recebem o contador novo com zero. A migração só transfere o contador legado
quando existe uma única tentativa e os eventos de validação formam evidência
inequívoca. Entregas pós-coleta sem tentativa e históricos ambíguos continuam
exigindo reconciliação explícita; nenhuma tentativa é criada por inferência do
estado atual.

Não há dependência de GPS, mapa, geocodificação, rota, distância ou tempo.

## Erro do ERMES na apresentação do endereço (0.2)

`address_problem` continua preservando `originalAddress` e `presentedAddress` e
nasce com responsabilidade `null`. A classificação explícita `SISTEMA` pela
empresa não muda estado, tentativa ou ledger. Enquanto a tentativa atual está
ativa em `awaiting_confirmation`, o código válido pode concluir normalmente a
mesma Entrega; nesse caminho há somente o financeiro normal, sem retorno,
revalidação ou refund especial. Três códigos inválidos substituem esse caminho
pela causa terminal `confirmation_failed`, sem duplo fechamento.

Quando a entrega segura não é possível, o motoboy atribuído usa
`POST /api/courier/deliveries/:id/system-address-return` com `{}`. A ação exige
a ocorrência da tentativa atual classificada como `SISTEMA`, registra
`system_address_return_started` e muda tentativa/Entrega para retorno. Repetição
retorna `409`. Em seguida, `report-return` e `confirm-return` existentes comprovam
o retorno físico. A tentativa encerra como recuperável, o motoboy é liberado e a
Entrega entra em `awaiting_revalidation`/`AGUARDANDO_REVALIDACAO`, sem lançamento
financeiro ou nova tentativa.

`POST /api/company/deliveries/:id/system-address-resolution` aceita corpo estrito.
Para correção:

```json
{
  "resolution": "corrected",
  "clientAvailable": true,
  "verificationResult": "A apresentação foi corrigida e o cliente está disponível."
}
```

`clientAvailable` deve ser literalmente `true`. A resolução auditada volta a
mesma Entrega para `available`, preserva Pedido, snapshots e código e não cria
refund. A tentativa seguinte nasce somente na próxima coleta, numerada em
sequência e com contador de códigos inválidos igual a zero.

Para persistência:

```json
{
  "resolution": "persistent",
  "verificationResult": "Não existe correção confiável em prazo previsível."
}
```

A operação atômica projeta Entrega `NAO_REALIZADA` e Pedido `ENCERRADO`, completa
os refunds acumulados de products e freight efetivamente pagos e não cria
distribution. Frete `NULL` sem payment não inventa valor; pagamentos, refunds ou
distribuições incompatíveis exigem reconciliação. As chaves são
`delivery:<id>:system-address-persistent:refund-products` e
`delivery:<id>:system-address-persistent:refund-freight`.

O endereço de sete campos do snapshot é normalizado e bloqueado globalmente
enquanto ativo em `system_address_blocks`, vinculado à resolução persistente.
Drafts antigos com o mesmo endereço não podem ser confirmados nem pagos, e a
criação de Entrega repete a defesa. Endereços diferentes continuam permitidos.
Não há endpoint público de desbloqueio, geocodificação, sanção ao cliente ou
remuneração interna inventada. O detalhe empresarial inclui o histórico
estruturado em `systemAddressResolutions`.

## Observação sobre frete

Total arredondado acima do intervalo de centavos inteiros seguros é rejeitado
antes da conversão para `Number`; a cotação retorna `400`, sem persistência ou
lançamento financeiro. O texto `note` informa que a fonte operacional de
distância e tempo permanece pendente de definição na Baseline 0.1.

`distanceKm` e `estimatedMinutes` são parâmetros técnicos do serviço para
exercitar a fórmula; eles não constituem contrato de entrada do cliente nem
definem uma fonte operacional. A fonte de distância e tempo do frete operacional
final está pendente de clarificação explícita. Não selecionar, inventar ou
implementar provedor de rotas, geocodificação, valor fixo, entrada manual ou
simulação como substituto. Geocodificação, rotas externas e seus snapshots não
são requisitos bloqueadores da Baseline 0.1; consulte
`BASELINE_0.1_SCOPE_CORRECTION.md`.

O objeto `quote` devolve `weightKg`, `distanceKm` e `estimatedMinutes`; a taxa de peso aplicada em `weightCents`; as tarifas `perKmCents` e `perMinuteCents`; as parcelas com frações de centavo em `distanceUnroundedCents` e `timeUnroundedCents`; e o valor final, arredondado uma única vez, em `totalCents`. Os antigos campos `distanceCents` e `timeCents`, que arredondavam cada parcela, foram substituídos para deixar explícito que essas parcelas ainda não são valores monetários finais. O objeto `split` usa `totalCents`.

## Incremento de impedimento externo e revalidação (0.2)

Os campos `status` existentes foram preservados. Pedidos e Entregas incluem `officialStatus` derivado. As projeções operacionais de Entrega incluem também `orderOfficialStatus`; o objeto `delivery` da resposta de pagamento segue o contrato específico acima e não inclui esse campo. O novo estado persistido é `awaiting_revalidation`, projetado como `AGUARDANDO_REVALIDACAO`. Não há coluna duplicada nem migração global de estados. `returned` sem semântica inequívoca permanece sem tradução oficial (`null`); o evento explícito `client_cancelled_after_pickup` projeta Pedido `CANCELADO` e Entrega `CANCELADA` após retorno confirmado. Os eventos `recipient_absent` e `recipient_refused` projetam, somente quando o estado persistido já é `returned`, Pedido `ENCERRADO` e Entrega `NAO_REALIZADA`. Conclusão normal projeta `CONCLUIDO/FINALIZADA`. Isso não declara implementados estados ou financeiro completos da 0.2.

### Registrar impedimento no destino

`POST /api/courier/deliveries/:id/external-obstruction` exige sessão `courier`, atribuição à Entrega e estado `awaiting_confirmation` com tentativa ativa coerente. Corpo estrito:

```json
{ "description": "Rua temporariamente interditada, sem alternativa segura disponível." }
```

Descrição textual não vazia, até 500 caracteres. Não aceita evidência arbitrária, responsabilidade, IDs de tentativa ou declarações automáticas de contato/rota. A ação é o registro explícito do motoboy após avaliar a viabilidade; não faz verificação geográfica. Retorna `200` com `{ "delivery": ... }`; cria ocorrência `temporary_external_obstruction` não classificada e inicia retorno na mesma transação do evento. Repetição retorna `409` sem mutação. `address_problem` segue seu fluxo próprio de evidência e classificação.

### Receber e consultar

O motoboy usa o endpoint existente `report-return`; a empresa usa `confirm-return` com `{}`. Para impedimento externo, somente após esta confirmação física a tentativa termina como `closed_unsuccessfully/recoverable` e a Entrega entra em `awaiting_revalidation`, sem motoboy nem tentativa aberta. Pedido e código são preservados. Não aparecem opções de aceite no catálogo.

`GET /api/company/deliveries/:id` inclui `revalidations` ordenadas por ID: `id`, `deliveryAttemptId`, `occurrenceId`, `type`, `description`, `receivedAt`, `receiverName`, `verifiedAt`, `verifierName`, `verificationResult`. Os três campos de verificação são `null` enquanto pendentes. O detalhe já permite consultar a ocorrência e a verificação do ciclo; a classificação continua disponível no endpoint existente. Não expõe código, credencial, sessão ou evidências internas.

### Autorizar nova disponibilização

`POST /api/company/deliveries/:id/revalidate` exige usuário técnico `company` ativo da empresa proprietária. Corpo estrito:

```json
{
  "revalidationId": 1,
  "release": true,
  "verificationResult": "A empresa verificou que o acesso está viável novamente."
}
```

`revalidationId` é inteiro positivo seguro; `release` deve ser literalmente `true`; resultado textual não vazio, até 2000 caracteres. Não há liberação sem verificação explícita, nem endpoint genérico de status. Exige ciclo correspondente à mesma Entrega/tentativa/ocorrência recuperável, retorno físico confirmado, nenhuma tentativa aberta e Pedido aberto. Retorna `200` com `{ "delivery": ... }`, registra usuário/horário/resultado e `delivery_revalidated`, e muda para `available`. Tudo é atômico; repetição retorna `409`. ID de ciclo de outra Entrega retorna `404` sem mutação.

As novas rotas usam `400` para corpo/ID inválido, `401` sem sessão, `403` para papel incorreto, `404` para recurso alheio e `409` para transição/dados legados incompatíveis. Cliente e motoboy não liberam a Entrega. Mensagem de chat não altera estado. Duas liberações concorrentes geram uma única transição; aceite que disputa cedo demais é rejeitado.

A revalidação não altera classificação, financeiro ou código e não cria tentativa. Nova coleta cria a próxima tentativa com contador zero. Painéis mostram o novo estado e bloqueiam ações incompatíveis; os comandos novos estão disponíveis somente via API neste incremento. O cancelamento pelo cliente enquanto aguarda revalidação está descrito abaixo. Erro do ERMES e estados terminais completos permanecem para incrementos próprios.

## Fechamento terminal por ausência ou recusa (0.2)

`recipient_absent` e `recipient_refused` continuam sendo registrados pelo
motoboy no destino pelo endpoint de ocorrências existente. O registro inicia o
retorno, mas ainda projeta `RETORNO_AO_ESTABELECIMENTO/CONFIRMADO`: a causa ser
terminal não encerra a operação antes da devolução física.

Depois de `report-return`, `POST /api/company/deliveries/:id/confirm-return`
fecha a tentativa como `closed_unsuccessfully`, com `endNature: "terminal"` e
`endReason` igual ao tipo da ocorrência, remove a atribuição do motoboy, grava
`returned_at`, mantém o estado legado `returned` e registra `return_confirmed`.
Nesse ponto, e somente com o evento inequívoco de ausência ou recusa no
histórico, as projeções passam a `delivery.officialStatus = "NAO_REALIZADA"` e
`delivery.orderOfficialStatus = "ENCERRADO"`. Detalhes e listagens de cliente e
empresa, respostas operacionais e o pagamento idempotente usam a mesma resolução
centralizada. `returned` sem uma das causas reconhecidas continua `null`.

A ocorrência permanece com `responsibility: null` até classificação explícita
pela empresa; o fechamento não depende dessa classificação. A Entrega terminal
não pode ser aceita, coletada, confirmada por código ou revalidada, não cria
outra tentativa nem ciclo de revalidação e mantém o chat somente para leitura
pelo comportamento já associado a `returned`. Repetições são rejeitadas sem
duplicar ocorrência, evento ou encerramento. Na mesma transação do fechamento,
o ledger completa o reembolso acumulado de `products` até o valor efetivamente
pago, descontando refunds anteriores; não reembolsa `freight`. Se o frete estiver
pago e corresponder ao snapshot, distribui o valor integral pelo
`splitNormalFreight()` (70% motoboy da tentativa encerrada, 25% empresa, 5% ERMES,
com maior resto). As chaves são específicas de Entrega, motivo, componente e
beneficiário; falha em qualquer lançamento reverte o fechamento inteiro.
O motoboy da tentativa terminal deve coincidir com o ator da coleta, da
ocorrência e do retorno reportado; divergências exigem reconciliação. Qualquer
refund anterior positivo de `freight` também impede o fechamento financeiro,
pois o frete já não estaria integralmente cobrado.
Pagamento de produtos ausente/divergente ou frete conhecido sem pagamento
coerente exige `FINANCIAL_RECONCILIATION_REQUIRED` internamente (a API responde
`500` com erro genérico). Com
`freight_total_cents = NULL` e sem pagamento de frete, o refund dos produtos
prossegue sem distribuição e `financial.pending` contém
`freight_amount_unavailable`. Se há pagamento de frete com snapshot `NULL`,
exige reconciliação. Classificação posterior não altera o ledger.
Em retorno terminal histórico com lançamentos incompletos, a projeção
financeira exige reconciliação em vez de informar distribuição concluída.

Produto indisponível e ajuste excepcional no modelo 0.2 estão implementados
conforme as rotas descritas acima; RF-025 permanece parcial enquanto faltam
distância e tempo operacionais autoritativos para recálculo do frete. Endereço
incorreto do cliente e erro do ERMES seguem os fluxos documentados. As consequências financeiras do cliente
em `confirmation_failed` são aplicadas na classificação, conforme seção abaixo;
a distribuição interna/custo operacional continua futura.

## Fechamento terminal após três códigos inválidos (0.2)

O terceiro erro mantém o contador da tentativa em `3`, cria exatamente uma
ocorrência `confirmation_failed` vinculada à tentativa, com `responsibility: null`,
e inicia retorno. Não aceita nova validação. Durante `returning` e
`awaiting_return_confirmation`, a projeção permanece
`RETORNO_AO_ESTABELECIMENTO/CONFIRMADO`; `report-return` não encerra a tentativa.

Somente `POST /api/company/deliveries/:id/confirm-return`, após retorno reportado,
encerra a tentativa em `closed_unsuccessfully/terminal/confirmation_failed`,
grava `returned_at`, remove a atribuição, persiste `returned` e registra
`return_confirmed`, atomicamente. A resposta e as consultas passam a projetar
`NAO_REALIZADA/ENCERRADO`, nunca `RECUSADO`. Falha no evento desfaz todo o fechamento.

O fechamento exige tentativa em retorno, contador `3`, ocorrência única vinculada
a essa tentativa e ao motoboy, histórico coerente das três validações e retorno
reportado. Inconsistências retornam `409` para reconciliação sem mutação.
Nas projeções legadas, também se exige encerramento terminal e evento empresarial
de recebimento coerentes: um evento isolado, tentativa ausente, contador divergente
ou causas contraditórias não autoriza inferência (`null` para `returned`). Não há
backfill nem coluna nova. Pedido, Entrega, listagens e pagamento idempotente usam
a mesma resolução de evidência; o pagamento repetido oculta o código.

A responsabilidade permanece `null` até decisão explícita após retorno físico
confirmado e evidência terminal íntegra. A classificação aceita exclusivamente
`CLIENTE`, `MOTOBOY`, `SISTEMA` e `INDEFINIDO`; `EMPRESA` retorna `400` e segunda
classificação retorna `409`. Classificar não altera estados,
código, contador ou tentativa. O fechamento independe da classificação;
os refunds do cliente nascem somente na classificação válida.

A Entrega terminal não pode ser aceita, coletada, confirmada ou revalidada;
não volta a disponível, não cria tentativa #2 nem ciclo de revalidação. Código e
histórico permanecem no banco. Repetições não duplicam ocorrência, encerramento
ou evento. Terceiro erro, retorno reportado e retorno confirmado não criam
refund nem distribution de `confirmation_failed`. Ausência, recusa e
cancelamento pós-coleta mantêm seus comportamentos anteriores.


## Financeiro do cliente na classificação de `confirmation_failed` (0.2)

O POST de classificação existente mantém o gate de retorno físico confirmado e
`hasConfirmationFailureEvidence(db, deliveryId, true)`. Na mesma transação,
persiste responsabilidade, classificador, horário e análise, registra
`occurrence_classified` e aplica os refunds. Qualquer falha, inclusive no segundo
refund, reverte todos esses efeitos; a ocorrência pode ser classificada após
reconciliação. A segunda classificação continua retornando `409`.

| Responsabilidade | Produtos efetivamente pagos | Frete efetivamente pago | Distribuição interna nova |
| --- | --- | --- | --- |
| `CLIENTE` | Reembolso integral acumulado | Permanece integralmente cobrado | Nenhuma |
| `MOTOBOY` | Reembolso integral acumulado | Reembolso integral acumulado | Nenhuma |
| `SISTEMA` | Reembolso integral acumulado | Reembolso integral acumulado | Nenhuma |
| `INDEFINIDO` | Reembolso integral acumulado | Reembolso integral acumulado | Nenhuma |

`EMPRESA` continua retornando `400`. Sem sessão retorna `401`; cliente e motoboy,
`403`; empresa alheia, `404`. Rejeições não alteram classificação, evento ou ledger.
Não há inferência de culpado nem aplicação de 70/25/5 a esse fluxo.

Cada refund completa somente o saldo entre o pagamento persistido e os refunds
anteriores do componente. Refund integral anterior não é duplicado. Over-refund,
pagamento de produtos ausente/duplicado/inválido/divergente, frete conhecido sem
pagamento único coerente ou frete `NULL` com pagamento exigem
`FINANCIAL_RECONCILIATION_REQUIRED` internamente (`500` com erro genérico na API).
Em `CLIENTE`, qualquer refund anterior positivo de frete também exige reconciliação,
sem recobrança nem compensação. Distribuições atribuídas a `confirmation_failed`
ou a desfechos finais incompatíveis exigem reconciliação; a simples presença de
remuneração histórica de outra natureza não é tratada como corrupção automática.
Nada é apagado ou atualizado no ledger.

Com frete `NULL` sem pagamento, os produtos são reembolsados sem inventar frete.
`financial.pending` inclui `freight_amount_unavailable`. Antes da classificação,
inclui `confirmation_failure_classification_required`; após a classificação
coerente, esse item desaparece. `freight_distribution_rule_undefined` representa
somente a distribuição interna/custo operacional futuro, inclusive a regra não
presumida de `CLIENTE`; não indica dúvida sobre o frete devido pelo cliente.
`refundStatus` continua derivado do ledger: com produtos 2000 e frete 101 pagos,
`CLIENTE` recebe 2000 (`partial`), e os outros três recebem 2101 (`full`).

Não há backfill automático dos refunds de históricos anteriormente classificados.
Esses históricos exigem reconciliação explícita; a projeção financeira rejeita
refunds incompletos em vez de declarar o financeiro concluído. O startup não
infere esses refunds. Estados `returned/NAO_REALIZADA/ENCERRADO`, tentativa,
contador, código e marcos operacionais permanecem inalterados.


### Financeiro do cancelamento do cliente antes da coleta — Baseline 0.2

`POST /api/client/deliveries/:id/cancel`, com corpo `{}`, completa o financeiro
nos estados `available`, `heading_to_pickup` e `awaiting_pickup`. A transação
cancela a Entrega, limpa `courier_id`, grava `client_cancelled_before_pickup` e
reembolsa os saldos pagos de produtos e frete. Não cria tentativa, distribuição,
remuneração especial ao motoboy, taxa ou sanção. Aceite e chegada permanecem no
histórico; o motoboy fica livre para outra Entrega. A projeção permanece
`cancelled` / `CANCELADA` / Pedido `CANCELADO`, com `orders.status = confirmed`.

- `pending` sem ledger: nenhum refund, `refundStatus = none`, pagamento permanece
  pendente. Pagamento persistido inesperado exige reconciliação.
- `paid`: pagamentos únicos e coerentes com cliente, Pedido, Entrega e snapshots
  são obrigatórios. Para cada componente, completa apenas `pagamento - refunds
  anteriores`; saldo zero não gera lançamento. `paymentStatus` permanece `paid`.
- Frete conhecido, inclusive zero, exige payment correspondente. Frete `NULL`
  sem payment reembolsa somente produtos e informa `freight_amount_unavailable`;
  frete `NULL` com payment é incompatível.
- Over-refund, distribuição, refund de outro desfecho terminal, colisão semântica
  de chave, vínculo divergente ou histórico com coleta/tentativa anterior exigem
  `FINANCIAL_RECONCILIATION_REQUIRED` internamente (HTTP `500`, mensagem pública
  genérica existente). Inclui tentativa recuperável já encerrada, mesmo após
  redisponibilização e limpeza de `collected_at`; esse cenário exige reconciliação
  explícita, sem presumir compensação. O cancelamento específico durante
  `awaiting_revalidation` após impedimento externo segue a regra abaixo.

Falha em evento, validação ou refund desfaz estado, atribuição, timestamps e
lançamentos da transação. Repetição HTTP mantém `409`, sem duplicação; sem sessão
retorna `401`, outro papel `403`, outro cliente `404`, corpo extra `400`.
O cancelamento pós-coleta mantém integralmente a política anterior de 50/50.

Cancelamentos pré-coleta comprovados e reconciliados deixam de apresentar
`client_cancellation_before_pickup_refund_rule_undefined`. Histórico sem causa
comprovada mantém a pendência; evidência de cancelamento com refunds faltantes
ou conflitantes exige reconciliação. Produto indisponível mantém seu contrato.
O startup não fabrica refunds para cancelamentos antigos: estado `cancelled`
isolado não é prova suficiente e o incremento não adiciona backfill financeiro.

### Cancelamento após impedimento externo confirmado — Baseline 0.2

`POST /api/client/deliveries/:id/cancel` com `{}` aceita o cliente proprietário
somente em `awaiting_revalidation`, após `temporary_external_obstruction`,
`report-return` e recebimento físico confirmado pela empresa. Exige Pedido
`confirmed`, tentativa mais recente `closed_unsuccessfully/recoverable`, ocorrência
externa correspondente, ciclo único pendente e nenhuma tentativa aberta. Antes do
retorno confirmado retorna `409`. Sem sessão retorna `401`, outro papel `403`,
outro cliente `404`; repetição após cancelamento retorna `409`. Após a empresa
revalidar, o cancelamento especial deixa de estar disponível; a política para
esse estado posterior permanece pendente.

O cancelamento grava `cancelled`, `cancelled_at` e evento
`client_cancelled_after_external_obstruction` com `revalidationId` e
`occurrenceId`. Projeta Entrega `CANCELADA` e Pedido `CANCELADO`, mantendo
`orders.status = confirmed`. O retorno, a tentativa recuperável, a ocorrência,
o código e o ciclo de revalidação permanecem históricos; os campos de verificação
do ciclo continuam `null`. Uma chamada posterior a `revalidate` retorna `409`.
Não inicia outro retorno, não cria tentativa nem aplica sanção temporal.

O registro do impedimento, `report-return`, `confirm-return` e a espera pela
empresa não criam refund, cobrança adicional de frete ou distribuição. Se o
cliente cancelar, o Pedido `paid` exige pagamentos únicos e coerentes com
snapshots e vínculos. A transação completa apenas o saldo acumulado dos refunds
de `products` e `freight`, até 100% de cada pagamento efetivo. Frete `NULL` sem
payment não gera valor fictício; frete `NULL` com payment, frete conhecido sem
payment, over-refund e histórico terminal conflitante exigem
`FINANCIAL_RECONCILIATION_REQUIRED`. `payment_status = pending`, com ou sem
payments, é inconsistente nesse estágio pós-coleta e causa rollback. Falha de
qualquer refund desfaz também status, horário e evento. O ledger é append-only;
as chaves são `delivery:<id>:client-cancelled-after-external-obstruction:refund-products`
e `delivery:<id>:client-cancelled-after-external-obstruction:refund-freight`.

O resultado pago e integralmente devolvido tem `refundStatus = full`, sem nova
`distribution` para motoboy, empresa ou ERMES. O frete da tentativa malsucedida
não é cobrado separadamente. `financial.pending = ["freight_distribution_rule_undefined"]`
nesse ciclo indica apenas política interna futura de custo/remuneração da tentativa;
não há valor pendente de devolução ao cliente depois do cancelamento. Não há
backfill automático de casos legados. O cancelamento pós-coleta comum segue a
regra 50/50 já documentada.
