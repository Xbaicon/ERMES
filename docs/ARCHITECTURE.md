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
- Endereço possui snapshot histórico no pedido. O campo reservado para rota não torna geocodificação, provedor de rotas ou snapshot externo uma dependência da Baseline 0.1; consulte `BASELINE_0.1_SCOPE_CORRECTION.md`.
- O endereço padrão atual do cliente fica em `client_default_addresses`, com uma linha por usuário; pedidos preservam cópias independentes em `orders.destination_snapshot_json`.
- O contrato puro de validação e normalização de endereços fica em `src/address.js`; transporte HTTP e persistência continuam centralizados nas camadas existentes.
- O catálogo de consulta fica sob `/api/client`: a sessão limita o acesso ao papel `client`, empresas bloqueadas não são elegíveis e a consulta de produtos combina `company_id` com `is_available = 1`; as antigas rotas públicas de catálogo não fazem parte do contrato.
- `src/orders.js` concentra validação, consultas isoladas por cliente ou empresa, recálculo decimal do peso, subtotal seguro e criação/edição transacional do pedido `draft`; `src/server.js` mantém a autorização e o contrato HTTP. O carrinho efêmero e a interação do catálogo ficam em `public/js/client-cart.js`; a consulta e a edição dos drafts persistidos ficam em `public/js/client-drafts.js`. A consulta empresarial somente leitura fica em `public/js/company-drafts.js`, pois possui carregamento, seleção, detalhe e estados assíncronos próprios, sem compartilhar a edição do cliente. As tabelas existentes `orders` e `order_items` já armazenam os snapshots exigidos, sem migração nesta etapa.
- Existe índice parcial no banco para impedir mais de uma entrega ativa por motoboy.
- Dinheiro é representado em centavos inteiros.
- Empresa e usuário responsável são entidades distintas.
- O papel `platform_admin` existe no esquema, mas não possui casos de uso implementados porque suas permissões estão pendentes.
- Motoboys são criados já vinculados a uma empresa; não existe cadastro autônomo.

## Limites deliberados da fundação

- A API de cotação aceita distância e tempo apenas como entrada técnica para testar a fórmula. A interface do cliente não deve solicitar esses valores. A fonte operacional de distância e tempo permanece pendente de clarificação; não escolher nem antecipar uma solução geográfica.
- O cadastro atual cria um usuário responsável inicial para a empresa, sem declarar que a versão final terá apenas um usuário.
- Recuperação de senha não foi simulada de forma insegura.
- O SQLite atende ao desenvolvimento e demonstração local. Uma futura mudança de banco exigirá migrações e testes de concorrência equivalentes.

## Próximas integrações técnicas

1. Fluxo completo de pedido e confirmação pela empresa.
2. Pagamento, estados financeiros, reembolsos e distribuição financeira; gateway real é opcional/futuro.
3. Estados e eventos completos da entrega.
4. Chat entre cliente e empresa.

Geocodificação, provedor real de rotas, mapas e rastreamento geográfico são
opcionais/futuros e não bloqueiam esta baseline. Acompanhar a operação por
estados e eventos permanece obrigatório. A classificação completa está em
`BASELINE_0.1_SCOPE_CORRECTION.md`.
