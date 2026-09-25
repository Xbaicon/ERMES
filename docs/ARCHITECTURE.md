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

- `Pedido` e `Entrega` são entidades distintas.
- Produto, preço e peso são preservados em `order_items` para impedir alterações retroativas.
- Endereço e rota possuem espaço para snapshots históricos no pedido.
- O endereço padrão atual do cliente fica em `client_default_addresses`, com uma linha por usuário; pedidos preservam cópias independentes em `orders.destination_snapshot_json`.
- O contrato puro de validação e normalização de endereços fica em `src/address.js`; transporte HTTP e persistência continuam centralizados nas camadas existentes.
- O catálogo de consulta fica sob `/api/client`: a sessão limita o acesso ao papel `client`, empresas bloqueadas não são elegíveis e a consulta de produtos combina `company_id` com `is_available = 1`; as antigas rotas públicas de catálogo não fazem parte do contrato.
- `src/orders.js` concentra validação, recálculo decimal do peso, subtotal seguro e criação transacional do pedido `draft`; `src/server.js` mantém a autorização e o contrato HTTP. O carrinho e a interação do catálogo ficam em `public/js/client-cart.js`, sem persistência no navegador. As tabelas existentes `orders` e `order_items` já armazenam os snapshots exigidos, sem migração nesta etapa.
- Existe índice parcial no banco para impedir mais de uma entrega ativa por motoboy.
- Dinheiro é representado em centavos inteiros.
- Empresa e usuário responsável são entidades distintas.
- O papel `platform_admin` existe no esquema, mas não possui casos de uso implementados porque suas permissões estão pendentes.
- Motoboys são criados já vinculados a uma empresa; não existe cadastro autônomo.

## Limites deliberados da fundação

- A API de cotação aceita distância e tempo apenas como entrada técnica para testar a fórmula. A interface do cliente não deve solicitar esses valores. No fluxo real, eles deverão vir de um provedor de rotas.
- O cadastro atual cria um usuário responsável inicial para a empresa, sem declarar que a versão final terá apenas um usuário.
- Recuperação de senha não foi simulada de forma insegura.
- O SQLite atende ao desenvolvimento e demonstração local. Uma futura mudança de banco exigirá migrações e testes de concorrência equivalentes.

## Próximas integrações técnicas

1. Provedor de geocodificação e rotas.
2. Fluxo completo de pedido e confirmação pela empresa.
3. Pagamento simulado ou gateway definido.
4. Estados e eventos completos da entrega.
5. Rastreamento limitado às capacidades do navegador.
6. Chat entre cliente e empresa.
