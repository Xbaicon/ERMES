# Estado de implementação — ERMES

Atualize este documento sempre que uma funcionalidade mudar de estado.

## Estado das baselines

| Marco | Estado | Observação |
| --- | --- | --- |
| Baseline 0.1 | Encerrada e congelada | Checkpoint oficial na tag `baseline-0.1`; código, testes e contratos abaixo descrevem esse checkpoint |
| Baseline 0.2 | Em implementação incremental | `TentativaEntrega`, `OcorrenciaEntrega`/responsabilidade, impedimento externo/revalidação e fechamento operacional por ausência/recusa possuem incrementos funcionais; demais cenários e financeiro completo continuam pendentes |
| Auditoria técnica 0.1 → 0.2 | Concluída | A análise técnica antecedeu a decisão de manter SQLite durante a implementação funcional |
| Incremento atual | Três códigos inválidos — OPERACIONAL IMPLEMENTADO | `confirmation_failed` projeta `NAO_REALIZADA/ENCERRADO` somente após retorno físico confirmado com evidência coerente; classificação separada, sem presunção de responsabilidade, nova tentativa ou efeito financeiro |
| Próximo passo técnico | Implementação incremental | Continuar os incrementos funcionais da Baseline 0.2 sobre SQLite, preservando as pendências registradas abaixo |
| Persistência da 0.2 | SQLite ativo | Desenvolvimento e testes funcionais da 0.2 prosseguem sobre SQLite após auditoria; MySQL não é gate |
| Persistência futura | Etapa técnica posterior | Migrar SQLite → MySQL isoladamente, em ambiente apropriado, após regressão funcional da 0.2; repetir regressão automatizada e smoke completo |

## Incrementos funcionais da Baseline 0.2

| Regra | Estado | Observação |
| --- | --- | --- |
| Entidade persistente `TentativaEntrega` | PARCIAL | `delivery_attempts` preserva identidade, sequência por Entrega, motoboy, status, início e dados de encerramento |
| Fronteira da coleta | IMPLEMENTADO | Aceite, deslocamento, chegada à coleta e falha pré-coleta não criam tentativa; a confirmação da coleta cria a tentativa na mesma transação da Entrega e do histórico |
| Numeração e tentativa aberta | IMPLEMENTADO | A numeração usa `MAX(attempt_number) + 1` dentro de `BEGIN IMMEDIATE`; unicidade por Entrega e índice de tentativa aberta protegem concorrência e repetição |
| Conclusão normal | IMPLEMENTADO | Código válido conclui a tentativa ativa na mesma transação da Entrega, do evento e dos lançamentos financeiros já existentes |
| Projeção da Entrega | IMPLEMENTADO | Consultas de detalhe incluem `attempts` de modo aditivo; não foi criado endpoint ou interface visual |
| Retornos da tentativa | PARCIAL | Falha mecânica é recuperável; ausência, recusa, três códigos inválidos e cancelamento são terminais, sempre após confirmação física do retorno. A classificação registrada ainda não altera esse comportamento; impedimento externo usa retorno recuperável e revalidação explícita |
| Ocorrências e classificação 0.2 | PARCIAL | `delivery_occurrences` preserva falhas do motoboy antes/depois da coleta, ausência, recusa e três códigos inválidos. A empresa consulta e classifica uma única vez como `CLIENTE`, `EMPRESA`, `MOTOBOY`, `SISTEMA` ou `INDEFINIDO`, sem efeitos automáticos |
| Revalidação por impedimento externo | IMPLEMENTADO | Ocorrência `temporary_external_obstruction`, retorno físico, tentativa encerrada recuperável, `awaiting_revalidation` persistido e liberação explícita/auditada pela empresa; nova tentativa somente na nova coleta |
| Ausência e recusa do destinatário | OPERACIONAL IMPLEMENTADO | `recipient_absent` e `recipient_refused` exigem retorno físico confirmado, encerram a tentativa como terminal e projetam `NAO_REALIZADA/ENCERRADO`; responsabilidade continua sem presunção, não há nova tentativa/revalidação e os efeitos financeiros 0.2 permanecem pendentes |
| Fechamento terminal de `confirmation_failed` | OPERACIONAL IMPLEMENTADO | Terceiro erro cria ocorrência não classificada e inicia retorno; confirmação empresarial fecha tentativa terminal e projeta `NAO_REALIZADA/ENCERRADO`, sem financeiro. Tentativa, contador, ocorrência e histórico inconsistentes exigem reconciliação, sem backfill |
| Endereço incorreto e erro do ERMES | NÃO IMPLEMENTADO | `address_problem` continua bloqueado; faltam evidências específicas, comparação de endereço original/apresentado, correção e confirmação da disponibilidade do cliente |
| Produto indisponível e ajuste excepcional do Pedido na 0.2 | PENDENTE | Falta o fluxo de produto/serviço indisponível com proposta de ajuste excepcional, concordância explícita do cliente, acerto da diferença de preço e efeitos financeiros correspondentes quando aplicáveis. O cancelamento legado, o reembolso já existente e o financeiro implementado da 0.1 não representam a conclusão desse fluxo da 0.2 |
| Estados completos de Pedido e Entrega da 0.2 | PARCIAL | `officialStatus` é projeção derivada, sem coluna duplicada. `awaiting_revalidation` é novo estado operacional; `returned` com ausência/recusa explícita projeta `NAO_REALIZADA/ENCERRADO`, enquanto retorno ambíguo continua `null`. Demais regras terminais e financeiro completo continuam pendentes |
| Contador de códigos inválidos por tentativa | IMPLEMENTADO | `delivery_attempts.invalid_code_attempts` é a única fonte operacional, inicia em zero e aceita de zero a três. A coluna da Entrega é legado físico não sincronizado |
| Sanção temporal de cancelamento | REMOVIDA | A 0.2 não aplica tolerância fixa de três minutos nem bloqueio automático de duas horas; `order_blocked_until` é legado físico não autoritativo |
| Bancos SQLite existentes | IMPLEMENTADO COM LIMITAÇÃO | A evolução preserva os dados e reconstrói somente o CHECK de tipos de ocorrência quando necessário. Não há backfill de tentativas nem ocorrências; o contador legado só migra com tentativa única e eventos inequívocos, e Entregas em andamento sem tentativa exigem reconciliação |

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

## Incremento de estados e revalidação

- `orders.status` permanece `draft|confirmed`; `deliveries.status` mantém os valores legados e adiciona `awaiting_revalidation`. Não houve migração global ou inferência de causa para terminais históricos.
- Projeções oficiais: `draft -> EM_MONTAGEM`, `confirmed -> CONFIRMADO`, conclusão comprovada pela Entrega `completed -> CONCLUIDO/FINALIZADA`. Cancelamento exige evento explícito do cliente. Após retorno físico confirmado, `recipient_absent` ou `recipient_refused` projetam `ENCERRADO/NAO_REALIZADA`; `returned` sem causa suficiente continua `null`. Os demais nomes oficiais são reservados para incrementos posteriores.
- `delivery_revalidations` preserva ocorrência, tentativa encerrada, recebedor/horário e verificador/horário/resultado. O banco protege o mesmo ciclo operacional e o papel `company` da empresa proprietária.
- A empresa consulta o ciclo no detalhe da Entrega. Registro do impedimento e liberação estão disponíveis pela API, sem interface completa neste incremento; os painéis mostram o estado e não oferecem ações incompatíveis.
- Chat permanece aberto, mas nenhuma mensagem autoriza liberação. Falta de tentativa, ocorrência inequívoca ou retorno comprovado exige reconciliação explícita, sem backfill.
- O fechamento por ausência/recusa não cria nova tentativa, revalidação ou efeito financeiro e não presume responsabilidade. Reembolso de produtos e distribuição 70/25/5 desses casos permanecem para incremento próprio.
- Financeiro, cancelamento posterior ao impedimento, erro corrigível/persistente do ERMES, endereço incorreto, financeiro de `confirmation_failed` por classificação, produto indisponível/ajuste 0.2 e perfis RESPONSAVEL/ATENDENTE permanecem para incrementos próprios. Não há cobrança, reembolso ou remuneração nova no fluxo de revalidação.


## Incremento terminal de três códigos inválidos

- Contadores 1 e 2 mantêm a operação; o terceiro erro mantém contador 3, cria uma única ocorrência `confirmation_failed` com responsabilidade `NULL` e inicia retorno obrigatório.
- Durante retorno e espera de recebimento: `RETORNO_AO_ESTABELECIMENTO/CONFIRMADO`, tentativa `returning`, sem encerramento definitivo.
- Após confirmação empresarial: tentativa `closed_unsuccessfully/terminal/confirmation_failed`, Entrega legada `returned`, projeções `NAO_REALIZADA/ENCERRADO`, sem nova tentativa, aceite, coleta, confirmação ou revalidação.
- Classificação explícita continua disponível e separada; não altera estados, contador, código nem financeiro. Não há presunção de culpa do cliente.
- Operações, Pedido e pagamento idempotente compartilham validação de evidência. Dados legados ambíguos não recebem inferência; inconsistências no fechamento exigem reconciliação. Não há migração nem backfill.
- Repetições não duplicam ocorrência/eventos. Falha induzida no evento final faz rollback integral. O ledger completo é preservado; consequências financeiras de três códigos inválidos continuam pendentes para incremento separado.
