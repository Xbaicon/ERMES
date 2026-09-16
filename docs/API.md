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
| GET | `/companies` | Listar empresas ativas |
| GET | `/companies/:id/products` | Listar produtos disponíveis |

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

## Motoboy autenticado

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET/PATCH | `/courier/availability` | Consultar ou alterar online/offline |

## Observação sobre frete

`distanceKm` e `estimatedMinutes` são parâmetros técnicos do serviço. No fluxo definitivo, devem ser produzidos pela integração de rotas a partir do estabelecimento e do destino confirmado. Não devem ser digitados pelo cliente.

O objeto `quote` devolve `weightKg`, `distanceKm` e `estimatedMinutes`; a taxa de peso aplicada em `weightCents`; as tarifas `perKmCents` e `perMinuteCents`; as parcelas com frações de centavo em `distanceUnroundedCents` e `timeUnroundedCents`; e o valor final, arredondado uma única vez, em `totalCents`. Os antigos campos `distanceCents` e `timeCents`, que arredondavam cada parcela, foram substituídos para deixar explícito que essas parcelas ainda não são valores monetários finais. O objeto `split` usa `totalCents`.
