# Estado de implementação — ERMES

Atualize este documento sempre que uma funcionalidade mudar de estado.

## Estado das baselines

| Marco | Estado | Observação |
| --- | --- | --- |
| Baseline 0.1 | Encerrada e congelada | Checkpoint oficial na tag `baseline-0.1`; código, testes e contratos abaixo descrevem esse checkpoint |
| Baseline 0.2 | Iniciada documentalmente | É a baseline ativa de desenvolvimento, mas nenhuma funcionalidade específica da 0.2 deve ser considerada implementada apenas por constar na especificação |
| Próximo passo técnico | Auditoria somente leitura | Auditar a migração Baseline 0.1 → Baseline 0.2 antes de alterar código, banco, API ou regras de negócio |
| Persistência futura | Etapa técnica separada | Planejar e executar a migração SQLite → MySQL separadamente, antes das grandes alterações funcionais da 0.2 |

## Implementação existente no checkpoint da Baseline 0.1

| Área | Estado | Observação |
| --- | --- | --- |
| Página inicial responsiva | Implementado | Referências a entrega agendada removidas |
| Cadastro de cliente | Implementado inicialmente | Persistência no banco e senha com hash |
| Cadastro de empresa | Implementado inicialmente | Cria empresa e primeiro usuário responsável |
| Endereço de origem da empresa | Implementado inicialmente | Persistido como snapshot cadastral; geocodificação não é requisito bloqueador |
| Login e sessão | Implementado inicialmente | Cookie `HttpOnly`; sem autorização por token no navegador |
| Recuperação de senha | Bloqueado | Serviço de e-mail e fluxo seguro ainda não definidos |
| Produtos da empresa | Implementado inicialmente | Cadastro, peso, preço e disponibilidade |
| Consulta do catálogo pelo cliente | Implementado inicialmente | Lista empresas ativas e, por empresa, somente produtos disponíveis; acesso exclusivo do papel `client` |
| Carrinho e pedidos draft do cliente | Implementado inicialmente | Carrinho em memória cria drafts com escolha de destino padrão/manual e destinatário próprio/outra pessoa; cliente lista, consulta e substitui itens dos próprios drafts com recálculo e snapshots preservados; não cria entrega ou frete |
| Motoboy vinculado à empresa | Implementado inicialmente | Criado pela área da empresa; não autônomo |
| Online/offline do motoboy | Implementado inicialmente | Persistido no banco |
| Estrutura de pedidos | Implementado para regras definidas da 0.1 | Pedido possui criação, consulta e edição de `draft` e confirmação comercial para `confirmed`, sem edição direta posterior; a Entrega distinta concentra cancelamentos, ocorrências, falhas, retorno e conclusão implementados. Consequências financeiras não definidas continuam pendentes |
| Consulta e confirmação de drafts pela empresa | Implementado inicialmente | Lista, detalhe e confirmação `draft -> confirmed` isolados por `company_id`; usa versão otimista, `confirmed_at` e idempotência, sem criar entrega, pagamento ou frete |
| Endereço padrão do cliente | Implementado inicialmente | Consulta, cadastro e substituição isolados por sessão; geocodificação não bloqueia; snapshots de pedidos permanecem independentes |
| Destino e destinatário do Pedido | Implementado | Criação aceita endereço padrão ou manual exclusivo do Pedido e destinatário `self` ou `other`; preserva endereço e nome em snapshots históricos, sem múltiplos endereços salvos ou usuário para destinatário |
| Itens e snapshots históricos | Implementado parcialmente | Draft preserva preço e peso unitários, subtotal, destino e destinatário; lançamentos preservam valores financeiros conhecidos; somente a fonte do frete operacional final continua pendente |
| Cálculo tarifário de frete | Regra e testes implementados | Fórmula, faixas, valores por km/minuto, centavos, limite de 12 kg e entradas técnicas para exercício da fórmula |
| Frete operacional final | Parcial / pendente de clarificação | Falta somente decisão explícita sobre a fonte operacional de distância e tempo; não autoriza provedor externo, API de rotas, geocodificação, valor fixo, entrada manual ou simulação |
| Parâmetros tarifários da empresa | Implementado inicialmente | Consulta e edição isoladas por sessão; seis tarifas monetárias persistidas em centavos; limite de 12 kg permanece fixo na aplicação |
| Geocodificação, rotas e mapas | Opcional/futuro — não bloqueador | Não selecionar nem implementar provedor externo, API de rotas ou solução substituta sem decisão explícita |
| Pagamento e financeiro | Implementado para regras definidas da 0.1 | Pagamento simulado garante atomicamente a Entrega e lançamentos dos componentes conhecidos; `payment_status` permanece `pending|paid`, `refundStatus` é derivado e o livro-razão append-only protege idempotência semântica, valores seguros e over-refund |
| Divisão 70/25/5 | Implementado | Conclusão normal usa aritmética inteira e maior resto, com desempate motoboy → empresa → ERMES e soma exata |
| Reembolsos e exceções financeiras | Implementado para regras definidas da 0.1 | Cancelamento pós-coleta usa `ceil/floor` no 50/50, favorecendo o cliente no centavo ímpar; produto indisponível devolve somente componentes efetivamente pagos; regras pendentes não recebem distribuição inferida |
| Aceite concorrente da entrega | Implementado | Mesmo estabelecimento, motoboy online, uma entrega ativa por motoboy e aceite único protegidos por transação e índices |
| Acompanhamento operacional da entrega | Implementado para regras definidas da 0.1 | Nascimento, fluxo normal, histórico, consultas isoladas, falhas, cancelamentos, ocorrências e retorno com dupla verificação; sem GPS ou mapa |
| Código de confirmação | Implementado | Código de seis dígitos disponível ao cliente durante a operação, validado por hash `scrypt`, cifrado para recuperação autorizada, oculto do motoboy e limitado a três erros |
| Rastreamento geográfico | Opcional/futuro — não bloqueador | GPS, coordenadas, posição atual/última conhecida, histórico de posições e mapa em tempo real não são pré-requisitos |
| Chat cliente ↔ empresa | Implementado | Uma conversa por Pedido, texto livre e sugestões fixas; histórico append-only, autorização por sessão, somente leitura após terminalidade e atualização por polling HTTP |
| Administrador do ERMES | Não implementado | Casos de uso e permissões permanecem pendentes |
| Promoções | Não implementado | Opcional e ainda não detalhado |

## Conflitos corrigidos no protótipo recebido

- Removidas referências visuais a entrega agendada.
- Removido o cadastro público de motoboy autônomo.
- Separado o usuário da empresa do futuro Administrador do ERMES.
- Substituída autenticação em `localStorage` por sessão no servidor.
- Descartado o `admin.js` recebido, que continha erro de sintaxe e blocos duplicados.

## Pendências registradas no checkpoint da Baseline 0.1

Estas pendências registram o estado congelado da 0.1. A Baseline 0.2 e seu
changelog devem ser consultados para identificar quais foram explicitamente
alteradas, sem presumir que a nova regra já esteja implementada. No checkpoint
0.1, não presumir:

- quantidade final de usuários por empresa;
- poderes do Administrador do ERMES;
- distribuição de frete nas exceções ainda não definidas;
- fonte operacional e política de falha para distância/tempo do frete;
- interface de tentativa de contato;
- campos definitivos do destinatário;
- provedor e fluxo técnico de pagamento;
- nomenclatura final dos estados UML.

A infraestrutura financeira e as consequências expressamente definidas estão
persistidas. Continuam sem distribuição interna destinatário ausente, recusa,
endereço incorreto confirmado pelo cliente e falha após três códigos; também não
foi inferido reembolso para cancelamento antes da coleta. Erro comprovável do
sistema continua sem valores exatos. A interface de tentativa de contato também
permanece pendente.
