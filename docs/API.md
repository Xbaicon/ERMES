# API inicial

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
| POST | `/freight/quote` | Exercitar fórmula com dados produzidos por rota |

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

## Cliente autenticado

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET | `/client/companies` | Listar empresas ativas disponíveis para consulta |
| GET | `/client/companies/:companyId/products` | Listar produtos disponíveis da empresa escolhida |
| GET | `/client/default-address` | Consultar o endereço padrão do próprio cliente |
| PUT | `/client/default-address` | Cadastrar ou substituir integralmente o endereço padrão do próprio cliente |
| POST | `/client/orders` | Criar pedido em estado `draft` a partir do carrinho |
| GET | `/client/orders/drafts` | Listar os pedidos `draft` do próprio cliente |
| GET | `/client/orders/:orderId` | Consultar um pedido `draft` do próprio cliente |
| PUT | `/client/orders/:orderId/items` | Substituir integralmente os itens de um pedido `draft` próprio |

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

`POST /client/orders` recebe somente `companyId` e `items`; cada item recebe somente `productId` e `quantity`:

```json
{
  "companyId": 1,
  "items": [
    { "productId": 10, "quantity": 2 }
  ]
}
```

Identificadores e quantidades devem ser números inteiros positivos dentro do intervalo seguro do JavaScript. O pedido exige ao menos um item e não aceita o mesmo produto duas vezes; aumente a quantidade do item existente. Campos inesperados em qualquer nível são rejeitados com `400`, inclusive identificadores de cliente, preços, pesos, status, frete, rota e endereços enviados pelo navegador.

O cliente é identificado exclusivamente pela sessão. A empresa precisa estar ativa e cada produto deve existir, pertencer a ela e estar disponível. É necessário um endereço padrão cadastrado. O servidor lê preço e peso atuais dos produtos, calcula `itemsTotalCents` em centavos inteiros e `weightKg` com comparação decimal exata ao limite de 12 kg, e copia o endereço atual para o snapshot do pedido. O subtotal deve caber em inteiro seguro. Erros de validação retornam `400`; ausência de endereço, produto indisponível ou de outra empresa retorna `409`; empresa ou produto inexistente retorna `404`. Ausência de sessão retorna `401`, e outro papel retorna `403`.

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
    }
  }
}
```

Pedido, subtotal, endereço e snapshots unitários dos itens são gravados numa única transação. `route_snapshot_json` e `freight_total_cents` permanecem `NULL`; nenhuma entrega é criada. O carrinho no painel existe apenas na memória da página, portanto desaparece ao recarregá-la. A prévia de subtotal e peso no navegador não é autoritativa e pode diferir se o produto mudar antes do envio. A criação não confirma o pedido nem inicia pagamento ou entrega.

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

`GET /client/orders/:orderId` devolve a mesma representação completa documentada na criação: empresa, itens com preço e peso unitários preservados, subtotal, peso total e snapshot de destino. O identificador deve ser um inteiro decimal positivo e seguro, sem sinal, fração, notação exponencial ou zeros à esquerda.

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

O servidor recalcula subtotal e peso a partir da versão resultante, aceita exatamente 12 kg e rejeita peso superior ou subtotal acima do inteiro seguro. A substituição de `order_items` e a atualização de `orders.items_total_cents` ocorrem numa única transação. Qualquer falha restaura integralmente a versão anterior. `destination_snapshot_json` não é atualizado nem reconstruído a partir do endereço padrão atual; rota, frete, pagamento, status e entregas também não são modificados. Em sucesso, o `PUT` retorna HTTP `200` com `{ "order": ... }` normalizado pelo servidor.

## Motoboy autenticado

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET/PATCH | `/courier/availability` | Consultar ou alterar online/offline |

## Observação sobre frete

`distanceKm` e `estimatedMinutes` são parâmetros técnicos do serviço. No fluxo definitivo, devem ser produzidos pela integração de rotas a partir do estabelecimento e do destino confirmado. Não devem ser digitados pelo cliente.

O objeto `quote` devolve `weightKg`, `distanceKm` e `estimatedMinutes`; a taxa de peso aplicada em `weightCents`; as tarifas `perKmCents` e `perMinuteCents`; as parcelas com frações de centavo em `distanceUnroundedCents` e `timeUnroundedCents`; e o valor final, arredondado uma única vez, em `totalCents`. Os antigos campos `distanceCents` e `timeCents`, que arredondavam cada parcela, foram substituídos para deixar explícito que essas parcelas ainda não são valores monetários finais. O objeto `split` usa `totalCents`.
