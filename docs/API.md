# API inicial

> **Estado documental:** este arquivo descreve a API efetivamente implementada
> e congelada no checkpoint `baseline-0.1`. A Baseline 0.2 é a referência
> funcional ativa, mas nenhuma rota ou regra 0.2 deve ser considerada
> implementada até a auditoria e as alterações técnicas correspondentes.

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
| POST | `/company/deliveries/:deliveryId/product-unavailable` | Cancelar antes da coleta por produto indisponível |
| POST | `/company/deliveries/:deliveryId/confirm-return` | Confirmar recebimento físico do retorno |
| POST | `/freight/quote` | Exercitar tecnicamente a fórmula com entradas de teste |

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

`GET /client/deliveries/:deliveryId` inclui `confirmationCode` enquanto a
Entrega ainda pode chegar à etapa de confirmação. Isso permite ao cliente
reconsultar o código após recarregar ou reabrir o painel. O campo deixa de ser
retornado após conclusão, cancelamento ou encaminhamento definitivo ao retorno.
Listagens, empresa e motoboy nunca recebem o código nem seus dados internos.

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
| POST | `/courier/deliveries/:id/occurrences` | Registrar ausência, recusa ou endereço incorreto |
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
`collected_at`; conclusão grava `completed_at`. Atalhos, retrocessos e ator
incorreto retornam conflito ou recurso não encontrado.

`POST .../confirm` recebe somente `{ "code": "123456" }`. Código correto em
`awaiting_confirmation` conclui a Entrega. Cada erro incrementa o contador e
grava apenas número e horário da tentativa; a resposta usa HTTP `422` com
`{ "error": "Código inválido." }`. No terceiro erro, a Entrega passa
para `returning`; não há método alternativo de conclusão. O motoboy registra o
retorno e a empresa confirma o recebimento. Hashes, códigos digitados, sessão e
dados cadastrais sensíveis não aparecem nas respostas.

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
sobre o frete ficam indicados em `financial.pending`. Destinatário ausente,
recusa, endereço incorreto atribuído ao cliente e três códigos inválidos não
recebem distribuição interna, porque a Baseline 0.1 ainda não a definiu. O mesmo
vale para o reembolso de cancelamento antes da coleta, que não é inferido pela API.
Se o frete estiver preservado, mas faltar o lançamento de pagamento correspondente,
a conclusão aborta com reconciliação financeira e não mantém estado, evento ou
distribuição parciais; esse caso não é apresentado como frete indisponível.
Ausência de sessão retorna `401`; papel diferente retorna `403`; os detalhes de
Entrega de outro cliente ou empresa continuam retornando `404`.

Falha do motoboy antes da coleta redisponibiliza a mesma Entrega; depois da
coleta exige retorno e, após a dupla verificação, permite redisponibilização.
Cancelamento do cliente antes da coleta encerra como `cancelled`; depois da
coleta exige retorno. Cancelamento ocorrido mais de três minutos após a coleta
bloqueia novos pedidos por duas horas. Ausência, recusa e endereço incorreto
também exigem retorno. Os corpos de transições sem parâmetros devem ser `{}`.
Não há dependência de GPS, mapa, geocodificação, rota, distância ou tempo.

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
