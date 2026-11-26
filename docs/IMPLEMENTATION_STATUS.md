# Estado de implementação — ERMES

Atualize este documento sempre que uma funcionalidade mudar de estado.

## Estado das baselines

| Marco | Estado | Observação |
| --- | --- | --- |
| Baseline 0.1 | Encerrada e congelada | Checkpoint oficial na tag `baseline-0.1`; código, testes e contratos abaixo descrevem esse checkpoint |
| Baseline 0.2 | Em implementação incremental | Incrementos funcionais implementados, incluindo submissão/recusa comercial e fechamento financeiro pós-retorno; aguardando revisão independente, sem checkpoint ou tag de fechamento |
| Auditoria técnica 0.1 → 0.2 | Concluída | A análise técnica antecedeu a decisão de manter SQLite durante a implementação funcional |
| Incremento atual | Fechamento funcional — aguardando revisão | Submissão versionada, recusa comercial, financeiro pós-retorno e cancelamento após revalidação liberada |
| Próximo passo técnico | Revisão independente | Revisar o incremento final antes de qualquer commit ou fechamento oficial |
| Persistência da 0.2 | SQLite ativo | Desenvolvimento e testes funcionais da 0.2 prosseguem sobre SQLite após auditoria; MySQL não é gate |
| Persistência futura | Etapa técnica posterior | Migrar SQLite → MySQL isoladamente, em ambiente apropriado, após regressão funcional da 0.2; repetir regressão automatizada e smoke completo |

## Incrementos funcionais da Baseline 0.2

| Regra | Estado | Observação |
| --- | --- | --- |
| RF-001 | IMPLEMENTADO | Múltiplos UsuarioEmpresa por empresa; RESPONSAVEL administra cadastros e tarifas, ATENDENTE opera pedidos, chat e Entregas; perfil separado do papel técnico e protegido no SQLite |
| RF-002 | IMPLEMENTADO | Confirmação comercial e administração de usuários, catálogo, motoboys e tarifas registram o ator exato em auditoria append-only e transacional; ações operacionais preservam seus atores nos registros de domínio |
| RN-021 / RF-023 / RF-024 | IMPLEMENTADO | Empresa propõe composição completa e cliente decide explicitamente; o ajuste preserva snapshots históricos, Entrega e código |
| RN-022 / RF-026 | IMPLEMENTADO | Diferença a maior exige pagamento explícito e a menor gera refund. O total bruto pago é validado antes do aceite e do pagamento adicional |
| RF-025 / RF-0.2-25 | IMPLEMENTADO no escopo operacional disponível; `LIMITACAO_FUTURA_PERMITIDA` para distância/tempo | Subtotal dos produtos e peso são recalculados. Frete `NULL` permanece `NULL`. Frete conhecido é preservado com parâmetros relevantes iguais. Mudança de peso com frete conhecido exige reconciliação enquanto faltarem dados autoritativos. A fonte de distância/tempo é limitação futura permitida, não gap bloqueante da Baseline Normalizada |
| RN-023 | IMPLEMENTADO | Sem acordo, Entrega CANCELADA, Pedido ENCERRADO, responsabilidade EMPRESA, devolução do saldo pago e motoboy liberado sem tentativa ou distribuição |
| Entidade persistente `TentativaEntrega` | IMPLEMENTADO | `delivery_attempts` preserva identidade, sequência por Entrega, motoboy, status, início e dados de encerramento |
| Fronteira da coleta | IMPLEMENTADO | Aceite, deslocamento, chegada à coleta e falha pré-coleta não criam tentativa; a confirmação da coleta cria a tentativa na mesma transação da Entrega e do histórico |
| Numeração e tentativa aberta | IMPLEMENTADO | A numeração usa `MAX(attempt_number) + 1` dentro de `BEGIN IMMEDIATE`; unicidade por Entrega e índice de tentativa aberta protegem concorrência e repetição |
| Conclusão normal | IMPLEMENTADO | Código válido conclui a tentativa ativa na mesma transação da Entrega, do evento e dos lançamentos financeiros já existentes |
| Projeção da Entrega | IMPLEMENTADO | Consultas de detalhe incluem `attempts` de modo aditivo; não foi criado endpoint ou interface visual |
| Retornos da tentativa | IMPLEMENTADO | Falha mecânica é recuperável; ausência, recusa, três códigos inválidos e cancelamento são terminais, sempre após confirmação física do retorno. Endereço exige classificação explícita CLIENTE/SISTEMA; impedimento externo usa retorno recuperável e revalidação explícita |
| Ocorrências e classificação 0.2 | IMPLEMENTADO | `delivery_occurrences` preserva falhas do motoboy antes/depois da coleta, ausência, recusa e três códigos inválidos. A empresa consulta e classifica uma única vez como `CLIENTE`, `EMPRESA`, `MOTOBOY`, `SISTEMA` ou `INDEFINIDO`; somente `confirmation_failed` aplica os refunds do cliente na classificação |
| Revalidação por impedimento externo | IMPLEMENTADO | Ocorrência `temporary_external_obstruction`, retorno físico, tentativa encerrada recuperável, `awaiting_revalidation` persistido e liberação explícita/auditada pela empresa; nova tentativa somente na nova coleta |
| Cancelamento durante revalidação externa | IMPLEMENTADO | Cliente proprietário cancela somente após retorno físico confirmado, com evento próprio e refund integral acumulado de payments coerentes; ciclo e tentativa ficam históricos, sem distribution, nova tentativa, retorno ou sanção |
| Ausência e recusa do destinatário | OPERACIONAL E FINANCEIRO IMPLEMENTADOS | Retorno confirmado fecha tentativa terminal, projeta `NAO_REALIZADA/ENCERRADO`, completa reembolso de produtos pagos e distribui frete pago 70/25/5; sem presunção de responsabilidade, nova tentativa ou revalidação |
| Fechamento terminal de `confirmation_failed` | OPERACIONAL IMPLEMENTADO | Terceiro erro cria ocorrência não classificada e inicia retorno; confirmação empresarial fecha tentativa terminal e projeta `NAO_REALIZADA/ENCERRADO`, sem financeiro. Tentativa, contador, ocorrência e histórico inconsistentes exigem reconciliação, sem backfill |
| Cancelamento pré-coleta | IMPLEMENTADO | Estados available/heading_to_pickup/awaiting_pickup; pending sem refund, paid com refund integral acumulado; liberação do motoboy e projeções CANCELADA/CANCELADO; coleta/tentativa anterior exige reconciliação |
| Financeiro do cliente em `confirmation_failed` | IMPLEMENTADO | Refund acumulado de produtos nas quatro responsabilidades; frete reembolsado em MOTOBOY/SISTEMA/INDEFINIDO e preservado em CLIENTE; gatilho atômico na classificação, sem distribuição interna |
| Endereço incorreto do cliente / erro do ERMES | OPERACIONAL E FINANCEIRO IMPLEMENTADOS | `address_problem` preserva endereço original/apresentado sem inferir culpa. CLIENTE mantém retorno terminal, products refund e freight 70/25/5. SISTEMA permite conclusão normal ou retorno recuperável; corrected redisponibiliza e persistent projeta `NAO_REALIZADA/ENCERRADO`, reembolsa products+freight e bloqueia o endereço canônico |
| Produto indisponível e ajuste excepcional do Pedido na 0.2 | IMPLEMENTADO | Antes da coleta, a empresa pode propor composição completa e o cliente decide explicitamente; diferença a maior exige pagamento, diferença a menor gera refund e ausência de acordo encerra a operação por responsabilidade EMPRESA. RF-0.2-25 tem subtotal/peso e ajuste implementados; distância/tempo autoritativos são limitação futura permitida, sem valor substituto inventado |
| Estados completos de Pedido e Entrega da 0.2 | IMPLEMENTADO, aguardando revisão | `officialStatus` é projeção derivada, sem coluna duplicada. `awaiting_revalidation` é novo estado operacional; `returned` com ausência/recusa explícita projeta `NAO_REALIZADA/ENCERRADO`, enquanto retorno ambíguo continua `null`. Todos os sete estados comerciais têm projeção; submissão vigente e recusa possuem evidência persistida. As políticas financeiras obrigatórias estão implementadas; custos internos explicitamente futuros não são presumidos |
| Contador de códigos inválidos por tentativa | IMPLEMENTADO | `delivery_attempts.invalid_code_attempts` é a única fonte operacional, inicia em zero e aceita de zero a três. A coluna da Entrega é legado físico não sincronizado |
| Sanção temporal de cancelamento | REMOVIDA | A 0.2 não aplica tolerância fixa de três minutos nem bloqueio automático de duas horas; `order_blocked_until` é legado físico não autoritativo |
| Bancos SQLite existentes | IMPLEMENTADO COM LIMITAÇÃO | A evolução preserva os dados e reconstrói somente o CHECK de tipos de ocorrência quando necessário. Não há backfill de tentativas nem ocorrências; o contador legado só migra com tentativa única e eventos inequívocos, e Entregas em andamento sem tentativa exigem reconciliação |

## Incremento final — aguardando revisão independente

Autoridade funcional: `ERMES_Baseline_0.2_Normalizada.docx` externa, fornecida
pelo responsável pelo projeto. Documento externo e Baselines históricas não
foram modificados nem copiados para o repositório.

- Submissão por versão distingue montagem e espera empresarial. Edição material
  preserva evidência anterior e exige novo envio; fila e confirmação exigem envio vigente.
- Recusa empresarial pelos dois perfis projeta RECUSADO, audita autor/motivo e
  horário imutáveis, bloqueia edição/confirmação e torna chat somente leitura.
- Cancelamento pós-coleta registra intenção e retorno sem financeiro prematuro;
  recebimento empresarial consolida atomicamente terminalidade e produtos + 50/50.
- Cancelamento após revalidação externa liberada e antes de nova coleta devolve
  integralmente componentes pagos, sem nova tentativa, retorno ou distribuição.
  Nova coleta volta a exigir retorno confirmado e 50/50.
- Suíte cobre decisões concorrentes, idempotência, SQL direto, rollback financeiro,
  migração aditiva e bootstrap repetido, além das regressões anteriores.
- Metadados do pacote e `/api/health` foram preservados para avaliação no
  fechamento posterior; não representam declaração de checkpoint 0.2 nesta branch.
- Nenhuma tag ou declaração de fechamento oficial da Baseline 0.2 neste incremento.

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
| Reembolsos e exceções financeiras | Implementado para regras definidas da 0.1 | Cancelamento pós-coleta usa `ceil/floor` no 50/50, favorecendo o cliente no centavo ímpar; indisponibilidade pré-coleta devolve o saldo de cada componente efetivamente pago; regras pendentes não recebem distribuição inferida |
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

No checkpoint congelado da 0.1, a infraestrutura financeira e as consequências
então expressamente definidas estavam persistidas. As limitações históricas abaixo
não substituem os incrementos da 0.2 descritos neste documento. Naquele checkpoint, destinatário ausente, recusa,
endereço CLIENTE, três códigos inválidos, cancelamento pré-coleta e erro do sistema
ainda não possuíam todas as regras financeiras posteriormente implementadas na 0.2. A interface de tentativa de contato também
permanece pendente.

## Incremento de estados e revalidação

- `orders.status` usa `draft|confirmed|rejected`; `deliveries.status` mantém os valores legados e adiciona `awaiting_revalidation`. Não houve migração global ou inferência de causa para terminais históricos.
- Projeções oficiais: `draft -> EM_MONTAGEM`, `confirmed -> CONFIRMADO`, conclusão comprovada pela Entrega `completed -> CONCLUIDO/FINALIZADA`. Cancelamento exige evento explícito do cliente. Após retorno físico confirmado, `recipient_absent` ou `recipient_refused` projetam `ENCERRADO/NAO_REALIZADA`; `returned` sem causa suficiente continua `null`. Submissão da versão vigente projeta `AGUARDANDO_CONFIRMACAO`; recusa comercial auditada projeta `RECUSADO`.
- `delivery_revalidations` preserva ocorrência, tentativa encerrada, recebedor/horário e verificador/horário/resultado. O banco protege o mesmo ciclo operacional e o papel `company` da empresa proprietária.
- A empresa consulta o ciclo no detalhe da Entrega. Registro do impedimento e liberação estão disponíveis pela API, sem interface completa neste incremento; os painéis mostram o estado e não oferecem ações incompatíveis.
- Chat permanece aberto, mas nenhuma mensagem autoriza liberação. Falta de tentativa, ocorrência inequívoca ou retorno comprovado exige reconciliação explícita, sem backfill.
- O fechamento por ausência/recusa não cria nova tentativa ou revalidação nem presume responsabilidade. Completa o reembolso acumulado de produtos efetivamente pagos, preserva a cobrança de frete e divide frete reconciliado 70/25/5 pelo maior resto. Refund anterior parcial reduz o saldo; integral não duplica; over-refund é bloqueado. O motoboy vem da TentativaEntrega terminal, confrontada com coleta, ocorrência e retorno do ciclo; identidade contraditória exige reconciliação. Refund anterior positivo de frete também exige reconciliação. Chaves idempotentes, ledger append-only e transação única garantem rollback do fechamento em falha financeira.
- Frete `NULL` sem pagamento de frete gera `freight_amount_unavailable` sem distribuição; frete conhecido sem pagamento coerente ou frete `NULL` com pagamento exige `FINANCIAL_RECONCILIATION_REQUIRED`. Não há backfill automático heurístico de consequências de retornos históricos.
- Cancelamento durante a revalidação após impedimento externo está implementado; após liberação e antes de nova coleta, o ciclo externo comprovado também autoriza refund integral sem nova tentativa. Endereço classificado `CLIENTE` possui fechamento terminal e `SISTEMA` possui conclusão segura ou resolução corrigível/persistente após retorno. Produto indisponível/ajuste 0.2 e perfis RESPONSAVEL/ATENDENTE estão implementados. As consequências financeiras do cliente em `confirmation_failed` estão implementadas na classificação; distribuição/custo interno continua futuro.


## Incremento terminal de três códigos inválidos

- Contadores 1 e 2 mantêm a operação; o terceiro erro mantém contador 3, cria uma única ocorrência `confirmation_failed` com responsabilidade `NULL` e inicia retorno obrigatório.
- Durante retorno e espera de recebimento: `RETORNO_AO_ESTABELECIMENTO/CONFIRMADO`, tentativa `returning`, sem encerramento definitivo.
- Após confirmação empresarial: tentativa `closed_unsuccessfully/terminal/confirmation_failed`, Entrega legada `returned`, projeções `NAO_REALIZADA/ENCERRADO`, sem nova tentativa, aceite, coleta, confirmação ou revalidação.
- Classificação explícita de `confirmation_failed` exige retorno físico confirmado e evidência terminal coerente; antes disso ou com histórico inconsistente retorna `409`. Aceita somente `CLIENTE`, `MOTOBOY`, `SISTEMA` e `INDEFINIDO`; `EMPRESA` retorna `400` nesse cenário e permanece disponível globalmente para outras ocorrências. Não altera estados, contador nem código; aplica os refunds do cliente atomicamente com a classificação. Não há presunção de culpa do cliente.
- Operações, Pedido e pagamento idempotente compartilham validação de evidência. Dados legados ambíguos não recebem inferência; inconsistências no fechamento exigem reconciliação. Não há migração nem backfill.
- Repetições não duplicam ocorrência/eventos. Falha induzida no evento final faz rollback integral. Lançamentos anteriores permanecem imutáveis; consequências financeiras do cliente são aplicadas na classificação. Custo/distribuição interna continua futuro.


## Incremento financeiro do cliente após três códigos inválidos

- Gatilho exclusivo: classificação válida de `confirmation_failed` após retorno
  confirmado e evidência terminal coerente. Terceiro erro e `confirm-return`
  continuam sem refund ou distribution desse motivo.
- `CLIENTE`: produtos integralmente reembolsados; frete permanece integralmente
  cobrado. Refund anterior positivo de frete exige reconciliação.
- `MOTOBOY`, `SISTEMA` e `INDEFINIDO`: produtos e frete efetivamente pagos
  integralmente reembolsados. Nenhuma responsabilidade adicional é inferida.
- Refunds parciais anteriores reduzem o saldo; integrais não duplicam.
  Over-refund, pagamentos ausentes/duplicados/inválidos/divergentes, frete conhecido
  sem pagamento coerente e frete `NULL` com pagamento exigem reconciliação.
  Frete `NULL` sem pagamento não gera valor inventado.
- Classificação completa, evento e ambos os refunds são atômicos. Falha em
  qualquer INSERT reverte tudo e permite classificação após reconciliação.
  `EMPRESA` continua inválida (`400`), segunda classificação retorna `409` e
  autorização permanece inalterada. Estado, tentativa, contador e código são preservados.
- Nenhuma distribution interna é criada, nem regra 70/25/5 aplicada a esse fluxo.
  Custo operacional/distribuição interna continua futuro. Distribuições de
  desfechos incompatíveis exigem reconciliação; remuneração histórica de outra
  natureza não é automaticamente corrupção.
- `financial.pending` distingue `confirmation_failure_classification_required`,
  `freight_amount_unavailable` e a pendência exclusivamente interna
  `freight_distribution_rule_undefined`. `refundStatus` continua derivado do ledger.
- Sem backfill automático dos refunds de históricos já classificados: exigem
  reconciliação explícita. Startup não inventa esses valores; projeções financeiras
  rejeitam históricos classificados com refunds incompletos.
- Ausência/recusa (incluindo 70/25/5), cancelamento pós-coleta, conclusão normal,
  produto indisponível legado e revalidação preservam suas regras. Este incremento
  não declara o financeiro completo da Baseline 0.2.

- Correções da auditoria de `confirmation_failed`: SQL direto e função financeira
  rejeitam ocorrências contraditórias e classificadores de outro papel/empresa.
  Bootstrap completo do schema legado instala o trigger após reconstruir
  ocorrências, na mesma transação, com rollback e repetição verificados.


## Financeiro do cancelamento pré-coleta — incremento anterior

- `recordClientCancellationBeforePickupInTransaction` integra o ramo existente,
  sem mudar a máquina de estados. Cancelamento, evento e refunds são atômicos;
  falhas de products ou freight revertem também atribuição e timestamps.
- Pagamento pendente sem ledger não cria valores. Pagamento efetivo coerente
  reembolsa integralmente produtos e frete, descontando refunds anteriores.
  Over-refund, duplicação, snapshots/vínculos divergentes, distribuição e refund
  terminal incompatível exigem reconciliação; chaves determinísticas são idempotentes.
- Frete conhecido exige pagamento correspondente; zero não é NULL. Frete NULL
  sem payment não gera refund de frete e mantém `freight_amount_unavailable`;
  com payment exige reconciliação. Nenhum motoboy recebe remuneração especial.
- Aceite e chegada são preservados, atribuição é liberada e nenhuma tentativa é
  criada/modificada. Tentativa recuperável anterior permanece fora deste fechamento
  automático: mesmo após retorno e redisponibilização, exige reconciliação explícita.
- O marcador de regra pré-coleta indefinida sai apenas dos casos comprovados e
  reconciliados. Histórico sem causa mantém pendência; cancelamento comprovado
  com refund faltante exige reconciliação. Startup não infere refunds históricos.
- Trigger compartilha a evidência operacional com função e projeção; mantém
  append-only e demais proteções. Bootstrap legado continua coberto. Autorização,
  concorrência, pós-coleta 50/50 e `confirmation_failed` permanecem preservados.
- Este incremento anterior não concluiu a Baseline 0.2; o fluxo de erro do ERMES
  e produto indisponível/ajuste 0.2 foram implementados em incrementos posteriores.
  MySQL permanece fora do escopo funcional atual.

## Cancelamento após impedimento externo — incremento atual

- O registro de `temporary_external_obstruction`, `report-return`, confirmação
  física e espera em `awaiting_revalidation` não alteram o ledger. Não há frete
  por tentativa nem refund parcial enquanto o Pedido permanece aberto.
- Apenas o cliente proprietário cancela a Entrega em `awaiting_revalidation`
  mediante ciclo único pendente, tentativa mais recente encerrada recuperável,
  ocorrência correspondente, retorno físico e Pedido confirmado. O evento
  `client_cancelled_after_external_obstruction` projeta `CANCELADA/CANCELADO`.
  Tentativa, ocorrência, código e revalidação não verificada permanecem históricos.
- Pedido `paid` exige pagamentos coerentes com products/freight e snapshots;
  refunds acumulados compatíveis reduzem o saldo. Frete `NULL` sem payment não
  inventa valor, com payment exige reconciliação. Over-refund e desfecho
  conflitante exigem reconciliação. Pedido pós-coleta `pending`, com ou sem
  payments, não é normalizado para cancelamento sem dinheiro.
- Cancelamento, evento e refunds são atômicos; falha de products ou freight
  reverte tudo. Não há distribution, remuneração ao motoboy, retorno extra ou
  sanção. `financial.pending` indica somente a política interna futura de custo
  da tentativa; o refund integral deixa o cliente financeiramente resolvido.
  Não há backfill automático nem alteração de MySQL. O incremento final estende este cancelamento à revalidação liberada, antes de nova coleta, mediante evidência do mesmo ciclo.

## Erro de apresentação do endereço pelo ERMES — incremento atual

- `address_problem` mantém endereço original e apresentado imutáveis e não
  presume culpa. A empresa classifica explicitamente `SISTEMA`; a tentativa
  permanece ativa e pode concluir normalmente com o mesmo código e financeiro.
- Quando necessário, o motoboy inicia retorno por ação específica. `report-return`
  e recebimento físico são obrigatórios; a tentativa fecha recuperável e a
  Entrega entra em `awaiting_revalidation`, sem refund, distribution ou nova tentativa.
- `system_address_resolutions` audita recebimento e decisão. `corrected` exige
  `clientAvailable === true`, preserva Pedido/Entrega/código e volta a `available`;
  tentativa #2 nasce somente na coleta, com contador zero.
- `persistent` projeta `NAO_REALIZADA/ENCERRADO`, completa refunds acumulados de
  products e freight efetivamente pagos e não cria distribution. Frete `NULL`
  sem payment não inventa valor; divergências e over-refund exigem reconciliação.
- Resolução, evento terminal, estado, bloqueio canônico e refunds são atômicos.
  O trigger SQL exige a cadeia completa e rejeita responsabilidades, ciclos,
  atores, estados ou eventos incoerentes, além de toda distribution do motivo.
- `system_address_blocks` usa igualdade global dos sete campos normalizados,
  sem geocodificação. Draft antigo, pagamento e criação da Entrega não contornam
  o bloqueio; endereço diferente continua permitido. Não há endpoint de desbloqueio.
- Bootstrap novo/existente/repetido não infere responsabilidade, ciclos, refunds
  ou bloqueios. CLIENTE, impedimento externo, cancelamentos, ausência/recusa,
  `confirmation_failed`, conclusão normal e ledger append-only permanecem cobertos.
