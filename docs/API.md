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

## Empresa autenticada

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET/POST | `/company/products` | Listar ou cadastrar produtos |
| PATCH | `/company/products/:id` | Alterar disponibilidade do produto |
| GET/POST | `/company/couriers` | Listar ou vincular motoboys |
| POST | `/freight/quote` | Exercitar fórmula com dados produzidos por rota |

## Motoboy autenticado

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET/PATCH | `/courier/availability` | Consultar ou alterar online/offline |

## Observação sobre frete

`distanceKm` e `estimatedMinutes` são parâmetros técnicos do serviço. No fluxo definitivo, devem ser produzidos pela integração de rotas a partir do estabelecimento e do destino confirmado. Não devem ser digitados pelo cliente.
