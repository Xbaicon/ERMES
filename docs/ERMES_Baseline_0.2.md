# ERMES — Especificação Consolidada da Baseline 0.2

**Status:** REGRAS DE NEGÓCIO FECHADAS  
**Versão:** Baseline 0.2  
**Data de consolidação:** 24/09/2026  
**Natureza do documento:** fonte de verdade funcional para a evolução 0.1 → 0.2  

> Esta baseline consolida as decisões permanentes tomadas após a Baseline 0.1. Ela não autoriza implementação imediata sobre uma 0.1 ainda incompleta: a Baseline 0.1 deve primeiro ser concluída, auditada, testada e estabilizada. Só então a 0.2 deve ser aplicada.

## 1. Objetivo e regra de autoridade

A Baseline 0.2 formaliza o comportamento do ERMES para pedidos, entregas, motoboys, ocorrências, retornos de mercadoria, confirmação por código, responsabilidades e consequências financeiras. O documento preserva decisões válidas da 0.1 e explicita mudanças, correções e novas regras.

Em caso de conflito entre código existente e esta especificação, o conflito deve ser reportado e analisado. Não se deve inventar regra para “fazer o código passar”. As decisões desta baseline prevalecem para a evolução 0.2, salvo decisão posterior expressa do responsável pelo projeto.

### 1.1 Princípios estruturais da 0.2

- `Pedido`, `Entrega` e `TentativaEntrega` são conceitos distintos.
- A **coleta confirmada** é a principal fronteira operacional do fluxo logístico.
- Antes da coleta, existe atribuição/aceite do motoboy, mas **não existe `TentativaEntrega`**.
- A `TentativaEntrega` nasce somente quando a mercadoria é efetivamente coletada.
- Uma mesma `Entrega` pode possuir mais de uma `TentativaEntrega` apenas quando uma tentativa anterior falha por causa recuperável e o retorno da mercadoria é confirmado.
- Ocorrências terminais não geram nova tentativa automática para a mesma `Entrega`.
- O código de confirmação pertence à `Entrega`; o contador de validações inválidas pertence à `TentativaEntrega`.
- A mercadoria coletada que não for entregue e ainda puder ser recuperada deve ter seu destino físico resolvido antes do encerramento definitivo da operação.
- Em situações ambíguas, o ERMES não presume automaticamente culpa do cliente.

## 2. Escopo da Baseline 0.2

### 2.1 Incluído e consolidado

- Múltiplos usuários vinculados a uma empresa, inicialmente com perfis `RESPONSAVEL` e `ATENDENTE`.
- Distinção formal entre `Pedido`, `Entrega` e `TentativaEntrega`.
- Criação da `TentativaEntrega` somente no momento da coleta.
- Tratamento de falha mecânica antes e depois da coleta.
- Registro e classificação de ocorrências de entrega.
- Responsabilidades classificáveis como `CLIENTE`, `EMPRESA`, `MOTOBOY`, `SISTEMA` ou `INDEFINIDO`.
- Regras terminais e recuperáveis de entrega.
- Retorno de mercadoria e confirmação do recebimento pela empresa.
- Endereço incorreto atribuído ao cliente.
- Impedimento externo temporário de acesso com endereço correto.
- Falha do ERMES na apresentação/interpretação do endereço.
- Produto/serviço indisponível descoberto pela empresa antes da coleta.
- Ajuste excepcional de pedido proposto pela empresa, condicionado à concordância explícita do cliente.
- Código de confirmação mantido entre novas tentativas da mesma entrega.
- Contador separado de validações inválidas por `TentativaEntrega`.
- Novos estados `CONCLUIDO` e `ENCERRADO` de `StatusPedido`.
- Estado `AGUARDANDO_REVALIDACAO` para `Entrega` quando a operação continua aberta, mas depende de verificação da empresa.
- Revisão das consequências financeiras para ausência, recusa, endereço incorreto e três códigos inválidos.

### 2.2 Fora do escopo desta baseline / stand-by

- Geocodificação robusta e obrigatória de endereços.
- Escolha de provedor de mapas/rotas.
- Obtenção automática real de distância e tempo de rota como requisito obrigatório desta baseline.
- Regra temporal de suspensão por cancelamento pós-coleta, seja tolerância fixa de 3 minutos ou percentual do tempo estimado.
- Recuperação de mercadoria gerenciada pelo ERMES por um segundo motoboy.
- Transferência direta de mercadoria entre motoboys.
- Política completa de custos/remuneração de tentativas malsucedidas em cenários em que o cliente não paga frete.
- Alteração de pedido iniciada voluntariamente pelo cliente após confirmação.
- Comentários e avaliações de empresas.
- Promoções avançadas.
- Responsabilidades detalhadas do administrador global do ERMES.
- Método alternativo de confirmação após três validações inválidas.

### 2.3 Candidatos à Baseline 0.3

- Alteração de pedido iniciada pelo cliente.
- Comentários, notas e avaliações de empresas, vinculáveis a experiências reais de pedido.
- Regras de moderação, edição e resposta a avaliações.

## 3. Atores e responsabilidades

### 3.1 Cliente

- Consulta produtos.
- Realiza pedidos.
- Informa destinatário e endereço.
- Conversa com a empresa.
- Acompanha a operação conforme as informações disponibilizadas.
- Visualiza o código de confirmação da própria entrega.
- Pode cancelar conforme as regras vigentes.
- Pode comunicar à empresa mudanças de condição operacional, como liberação de acesso, sem que isso substitua a verificação da empresa.

### 3.2 Usuário da empresa

Uma `Empresa` pode possuir múltiplos `UsuarioEmpresa`.

**RESPONSAVEL** possui permissões administrativas internas da empresa, como gerenciar produtos, motoboys, atendentes/usuários, parâmetros de frete e informações sensíveis da empresa, além das funções operacionais.

**ATENDENTE** possui funções operacionais, como conversar com clientes, consultar/confirmar pedidos e acompanhar operações relacionadas, sem administrar parâmetros sensíveis ou usuários, salvo futura decisão expressa.

Ações relevantes devem registrar qual `UsuarioEmpresa` as executou quando isso for importante para auditoria.

### 3.3 Motoboy

- Deve estar vinculado a uma empresa.
- Controla seu estado online/offline.
- Só pode aceitar entrega se estiver online e sem outra operação ativa incompatível.
- Pode visualizar entregas disponíveis mesmo quando ocupado, mas o aceite deve ficar bloqueado.
- Pode aceitar remotamente.
- Registra chegada à coleta, coleta, chegada ao destino, ocorrência e retorno quando aplicável.
- Insere o código informado pelo recebedor; não visualiza antecipadamente o código correto.

### 3.4 Destinatário

O destinatário não precisa possuir conta no ERMES. Pode ser o próprio cliente ou outra pessoa autorizada. A pessoa que recebe fisicamente a mercadoria deve possuir o código válido informado pelo cliente quando aplicável.

## 4. Modelo de domínio consolidado

### 4.1 Pedido

Representa a relação comercial entre cliente e empresa. Contém `ItemPedido`, valores e estado comercial. Um pedido pertence a uma única empresa e a um único cliente.

### 4.2 ItemPedido

Entidade associativa entre `Pedido` e `Produto`. Guarda pelo menos quantidade e preço unitário praticado no momento do pedido, preservando o histórico mesmo que o preço atual do produto seja alterado.

### 4.3 Entrega

Representa a obrigação logística originada pelo pedido. Mantém identidade própria, código de confirmação, endereço efetivo da operação, frete, estado global e histórico.

### 4.4 TentativaEntrega

Representa uma execução logística concreta após a coleta física da mercadoria.

- Não nasce no aceite.
- Não nasce no deslocamento até a empresa.
- Nasce na confirmação da coleta.
- A primeira coleta da `Entrega` cria a tentativa nº 1.
- Nova tentativa só existe se a mesma `Entrega` permanecer aberta após uma falha recuperável, houver retorno confirmado e ocorrer uma nova coleta.
- O número de tentativas de entrega jamais deve ser confundido com tentativas de validação de código.

### 4.5 OcorrenciaEntrega

Conceito responsável por registrar problemas relevantes da operação. Deve permitir, conforme o caso:

- tipo da ocorrência;
- descrição;
- data/hora;
- responsável pelo registro;
- tentativa/entrega relacionada;
- evidências disponíveis;
- classificação de responsabilidade;
- resultado da análise.

A classificação de responsabilidade pode assumir: `CLIENTE`, `EMPRESA`, `MOTOBOY`, `SISTEMA` ou `INDEFINIDO`.

O motoboy registra a ocorrência; quando necessário, a empresa classifica a responsabilidade. O sistema não deve presumir automaticamente culpa do cliente em situações ambíguas.

### 4.6 HistoricoEntrega

Registra a sequência de eventos da operação: criação, aceite, chegadas, coleta, ocorrências, validações, retornos, revalidações, encerramentos e demais marcos relevantes. Não substitui `OcorrenciaEntrega`; o histórico responde “o que aconteceu e quando”, enquanto a ocorrência concentra a análise de um problema.

## 5. Fluxo normal da operação

1. Cliente cria/confirma o pedido conforme o fluxo comercial.
2. Empresa confirma o pedido quando as condições comerciais estiverem atendidas.
3. `Entrega` é criada e fica `DISPONIVEL`.
4. Motoboy elegível aceita a entrega.
5. A entrega passa para `EM_DESLOCAMENTO_PARA_COLETA`.
6. Motoboy registra chegada ao estabelecimento: `AGUARDANDO_COLETA`.
7. Motoboy confirma a coleta da mercadoria.
8. Nesse exato momento nasce `TentativaEntrega #1` e a `Entrega` passa para `EM_TRANSPORTE`.
9. Motoboy chega ao destino e registra chegada: `AGUARDANDO_CONFIRMACAO`.
10. Recebedor informa o código ao motoboy.
11. Motoboy submete o código ao sistema.
12. Código válido: `TentativaEntrega = CONCLUIDA`, `Entrega = FINALIZADA`, `Pedido = CONCLUIDO`.

## 6. Fronteira da coleta

### 6.1 Antes da coleta

- A mercadoria continua na empresa.
- Não existe `TentativaEntrega`.
- Falha do motoboy desfaz a atribuição e pode devolver a mesma `Entrega` para `DISPONIVEL`.
- Eventos de aceite/desatribuição permanecem no histórico.

### 6.2 Depois da coleta

- Existe `TentativaEntrega`.
- A mercadoria saiu da empresa.
- Ocorrências precisam considerar custódia e destino físico da mercadoria.
- Quando houver retorno, a tentativa não deve ser considerada encerrada definitivamente antes da confirmação de recebimento pela empresa, salvo regra expressa diferente.

## 7. Falhas e ocorrências

### 7.1 Falha mecânica antes da coleta — recuperável sem tentativa

Fluxo:

- Motoboy aceita a entrega.
- Sofre falha antes de coletar.
- Registra-se o evento/ocorrência no histórico.
- A atribuição ao motoboy é desfeita.
- Não é criada `TentativaEntrega`.
- A mesma `Entrega` volta a `DISPONIVEL` para outro motoboy.

### 7.2 Falha mecânica após a coleta — recuperável

- A `TentativaEntrega` atual é interrompida.
- O retorno físico da mercadoria ao ponto de coleta fica, nesta baseline, sob responsabilidade da empresa.
- O ERMES não modela nesta baseline a logística interna de recuperação por outro motoboy.
- Após a empresa confirmar o recebimento, a tentativa anterior é encerrada sem sucesso, com natureza recuperável.
- `Pedido` e `Entrega` permanecem abertos.
- A mesma `Entrega` pode voltar a `DISPONIVEL`.
- A próxima coleta cria uma nova `TentativaEntrega`.
- O cliente não paga tarifa adicional por causa da falha recuperável; a política interna de custos da tentativa malsucedida fica para baseline futura.

### 7.3 Destinatário ausente — terminal

- A ocorrência acontece após a coleta.
- Motoboy registra ausência e tentativa de contato conforme a interface disponível.
- Mercadoria retorna à empresa.
- Empresa confirma recebimento.
- `TentativaEntrega` é encerrada sem sucesso, terminal.
- `Entrega = NAO_REALIZADA`.
- `Pedido = ENCERRADO`.
- Não há nova tentativa automática.
- Cliente recebe reembolso integral dos produtos.
- Frete permanece cobrado e é distribuído em 70% motoboy, 25% empresa e 5% ERMES.

### 7.4 Recusa do destinatário — terminal

Aplica-se quando produto, endereço e operação estão adequados e o destinatário simplesmente se recusa a receber.

- Mercadoria retorna à empresa.
- Empresa confirma recebimento.
- `TentativaEntrega` encerra sem sucesso, terminal.
- `Entrega = NAO_REALIZADA`.
- `Pedido = ENCERRADO`.
- Não há nova tentativa automática.
- Cliente recebe reembolso integral dos produtos.
- Frete permanece cobrado e é distribuído em 70% motoboy, 25% empresa e 5% ERMES.

### 7.5 Endereço incorreto comprovadamente fornecido pelo cliente — terminal

- Motoboy registra a ocorrência.
- A empresa classifica a responsabilidade com base nas evidências.
- Confirmada responsabilidade do cliente, a mercadoria retorna à empresa.
- A empresa confirma o recebimento.
- `TentativaEntrega` encerra sem sucesso, terminal.
- `Entrega = NAO_REALIZADA`.
- `Pedido = ENCERRADO`.
- Cliente recebe reembolso integral dos produtos.
- Frete permanece cobrado e é distribuído em 70% motoboy, 25% empresa e 5% ERMES.
- Não existe nova tentativa para corrigir o endereço dentro da mesma `Entrega`.
- Para receber no endereço corrigido, o cliente deverá criar novo `Pedido`.

### 7.6 Endereço correto com impedimento externo temporário — recuperável

Exemplos: rua interditada, bloqueio externo comprovado ou condição equivalente.

A prioridade máxima é tentar concluir a entrega com segurança.

Antes de desistir, o motoboy deve, quando viável:

- verificar outra rota segura;
- contatar o cliente;
- avaliar ponto de encontro/retirada seguro e viável.

Se a entrega for concluída por alternativa segura, permanece a mesma `TentativaEntrega` e a confirmação normal continua sendo exigida.

Se não for possível concluir:

- motoboy registra ocorrência;
- mercadoria retorna à empresa;
- empresa confirma recebimento;
- tentativa atual é encerrada sem sucesso, recuperável;
- `Pedido` e `Entrega` permanecem abertos;
- `Entrega = AGUARDANDO_REVALIDACAO`;
- o cliente pode comunicar pelo chat que a condição melhorou, mas isso não libera a entrega automaticamente;
- a empresa verifica se a entrega voltou a ser viável;
- somente após a verificação a `Entrega` volta a `DISPONIVEL`;
- nova `TentativaEntrega` nasce apenas com a nova coleta.

Financeiro:

- cliente não paga o frete da tentativa malsucedida;
- cliente pode optar pelo cancelamento sem sanções;
- política interna de custos/remuneração dessa tentativa fica para baseline futura.

### 7.7 Falha do ERMES na apresentação/interpretação do endereço

Se o endereço fornecido pelo cliente estava correto, mas o ERMES apresentou/interpretou informação incorreta:

- motoboy registra a ocorrência;
- se cliente e motoboy estiverem próximos e puderem concluir a entrega em ponto seguro e viável, a entrega pode ser concluída com confirmação normal;
- caso contrário, mercadoria retorna à empresa;
- empresa confirma recebimento;
- preservar o endereço originalmente informado e o endereço apresentado pelo sistema;
- empresa investiga a divergência.

**Falha pontual e comprovadamente corrigida em tempo operacional viável:**

- `Entrega = AGUARDANDO_REVALIDACAO` durante a análise;
- empresa confirma disponibilidade do cliente;
- empresa autoriza nova disponibilização;
- nova tentativa nasce somente com nova coleta;
- mesmo `Pedido`, mesma `Entrega`, mesmo código de confirmação.

**Falha persistente, sem correção confiável ou com prazo incerto:**

- não oferecer ao cliente a opção de aguardar indefinidamente;
- após retorno confirmado, `TentativaEntrega` encerra;
- `Entrega = NAO_REALIZADA`;
- `Pedido = ENCERRADO`;
- reembolso integral dos produtos e do frete;
- nenhuma sanção ao cliente;
- nova compra só deve ser permitida quando o sistema puder processar corretamente aquele endereço.

A remuneração/custo interno do motoboy nesse cenário permanece pendente para baseline futura.

### 7.8 Produto/serviço indisponível antes da coleta — responsabilidade da empresa

O ERMES não é sistema de estoque; a empresa é responsável por manter a disponibilidade coerente.

Se a empresa descobrir indisponibilidade antes da coleta:

1. Pode propor substituição, remoção ou outro ajuste.
2. A alteração só ocorre com concordância explícita do cliente.
3. Se o cliente aceitar, registrar a alteração, recalcular valores, peso e frete aplicável e continuar a operação.
4. Se o substituto for mais caro, a diferença adicional deve ser cobrada/ajustada antes da continuidade.
5. Se for mais barato, a diferença deve ser devolvida/ajustada a favor do cliente.
6. Se o cliente não aceitar, `Entrega = CANCELADA`, `Pedido = ENCERRADO`, motivo `PRODUTO_INDISPONIVEL`, responsabilidade `EMPRESA`.
7. Não existe `TentativaEntrega`, pois não houve coleta.
8. Reembolso integral ao cliente.
9. Motoboy fica livre para aceitar outra entrega e não possui remuneração especial por esse pedido.

Essa regra não cria uma funcionalidade genérica de alteração voluntária de pedido pelo cliente; isso fica para a 0.3.

## 8. Cancelamentos

### 8.1 Cancelamento antes da coleta

- Não existe `TentativaEntrega`.
- Mercadoria continua com a empresa.
- Entrega é cancelada.
- Pedido é cancelado.
- Se já houver pagamento, aplicar reembolso integral.
- Não há remuneração de frete ao motoboy por esse cancelamento.
- Não existe sanção temporal ao cliente nesta baseline.

### 8.2 Cancelamento após a coleta

- Existe `TentativaEntrega`.
- Mercadoria deve retornar à empresa.
- Empresa confirma recebimento.
- Tentativa, Entrega e Pedido são encerrados por cancelamento.
- Cliente recebe reembolso integral dos produtos.
- Cliente recebe 50% do frete de volta.
- Os outros 50% do frete são destinados ao motoboy.
- Não se aplica na 0.2 tolerância fixa de 3 minutos, regra de 30% do tempo estimado nem suspensão de 2 horas baseada no momento do cancelamento.
- Política temporal de sanções fica para baseline futura, após definição de geolocalização/tempo estimado de rota.

## 9. Código de confirmação

### 9.1 Propriedade e validade

- Cada `Entrega` possui um código próprio.
- O código pertence à `Entrega`, não à `TentativaEntrega`.
- Se a mesma `Entrega` gerar uma nova tentativa após falha recuperável, o código permanece o mesmo.
- O cliente visualiza o código; o motoboy não visualiza o valor correto antecipadamente.

### 9.2 Validações inválidas

- O contador de validações inválidas pertence à `TentativaEntrega` atual.
- Nova `TentativaEntrega` começa com contador zero.
- Cada submissão do código ao sistema conta como uma validação.
- Registrar evento/data-hora; não é necessário armazenar o valor incorreto digitado.
- Código válido conclui a operação.
- A terceira validação inválida torna a tentativa terminal e envia a mercadoria para retorno.
- Depois do retorno confirmado, a ocorrência é classificada; não se presume responsabilidade do cliente.

### 9.3 Consequências após três validações inválidas

| Classificação | Produtos | Frete do cliente | Nova tentativa automática |
|---|---|---|---|
| CLIENTE | Reembolso integral | Paga integralmente | Não |
| MOTOBOY | Reembolso integral | Não paga | Não |
| SISTEMA | Reembolso integral | Não paga | Não |
| INDEFINIDO | Reembolso integral | Não paga | Não |

A distribuição interna do frete e/ou custo operacional nos cenários MOTOBOY, SISTEMA e INDEFINIDO fica para baseline futura. Mesmo quando a classificação for CLIENTE, não se deve presumir automaticamente uma regra interna além do que estiver explicitamente definido.

## 10. Estados consolidados

### 10.1 StatusPedido

- `EM_MONTAGEM`
- `AGUARDANDO_CONFIRMACAO`
- `CONFIRMADO`
- `CONCLUIDO`
- `ENCERRADO`
- `CANCELADO`
- `RECUSADO`

Significados principais:

- `CONCLUIDO`: término comercial normal após entrega bem-sucedida.
- `ENCERRADO`: término sem conclusão normal por ocorrência/falha terminal.
- `CANCELADO`: cancelamento explícito da operação.
- `RECUSADO`: empresa não aceita o pedido antes da confirmação comercial.

### 10.2 StatusEntrega

- `DISPONIVEL`
- `EM_DESLOCAMENTO_PARA_COLETA`
- `AGUARDANDO_COLETA`
- `EM_TRANSPORTE`
- `AGUARDANDO_CONFIRMACAO`
- `RETORNO_AO_ESTABELECIMENTO`
- `AGUARDANDO_REVALIDACAO`
- `FINALIZADA`
- `CANCELADA`
- `NAO_REALIZADA`

`AGUARDANDO_REVALIDACAO` significa que a `Entrega` continua aberta, mas não pode ser aceita por outro motoboy até a empresa verificar que a condição impeditiva foi resolvida.

### 10.3 Status conceitual de TentativaEntrega

Para evitar duplicação de fontes de verdade, a `TentativaEntrega` não repete todos os estados operacionais de `Entrega`. Conceitualmente pode usar:

- `ATIVA`
- `EM_RETORNO`
- `CONCLUIDA`
- `ENCERRADA_SEM_SUCESSO`

Ao encerrar sem sucesso, registrar também motivo e natureza do encerramento (`RECUPERAVEL` ou `TERMINAL`) quando aplicável.

## 11. Regras financeiras consolidadas

| Cenário | Reembolso dos produtos | Frete do cliente | Distribuição / observação |
|---|---|---|---|
| Entrega concluída | Não aplicável | 100% | 70% motoboy / 25% empresa / 5% ERMES |
| Endereço incorreto — CLIENTE | Integral | 100% | 70% / 25% / 5% |
| Destinatário ausente | Integral | 100% | 70% / 25% / 5% |
| Destinatário recusa | Integral | 100% | 70% / 25% / 5% |
| 3 códigos inválidos — CLIENTE | Integral | 100% | distribuição interna não presumida além do explicitamente definido |
| 3 códigos inválidos — MOTOBOY | Integral | 0% | custo interno futuro |
| 3 códigos inválidos — SISTEMA | Integral | 0% | custo interno futuro |
| 3 códigos inválidos — INDEFINIDO | Integral | 0% | custo interno futuro |
| Cancelamento após coleta | Integral | 50% permanece cobrado | 50% do frete para motoboy; 50% devolvido ao cliente |
| Impedimento externo — tentativa malsucedida | Sem reembolso enquanto o pedido permanece aberto; integral se o cliente cancelar | 0% nessa tentativa | custo interno futuro |
| Erro persistente do ERMES | Integral | 0% | reembolso integral do frete; custo interno futuro |
| Produto indisponível — empresa, sem ajuste aceito | Integral | 0% | reembolso integral |
| Falha mecânica recuperável | Pedido continua | sem nova cobrança pela falha | política interna futura |

## 12. Regras de negócio formais

- **RN-001 — Fronteira da coleta:** `TentativaEntrega` só passa a existir na confirmação da coleta física da mercadoria.
- **RN-002 — Aceite pré-coleta:** aceite e deslocamento antes da coleta pertencem ao histórico/atribuição da `Entrega`, não a uma tentativa.
- **RN-003 — Unicidade ativa:** uma `Entrega` não pode possuir mais de uma `TentativaEntrega` ativa simultaneamente.
- **RN-004 — Nova tentativa:** nova tentativa da mesma `Entrega` só nasce com nova coleta após retorno confirmado e causa recuperável.
- **RN-005 — Código por entrega:** código de confirmação pertence à `Entrega` e permanece entre tentativas da mesma entrega.
- **RN-006 — Contador por tentativa:** validações inválidas são contabilizadas separadamente em cada `TentativaEntrega`.
- **RN-007 — Três validações inválidas:** a terceira validação inválida torna a tentativa terminal e exige retorno antes do encerramento definitivo.
- **RN-008 — Não presumir culpa:** falhas ambíguas não podem atribuir automaticamente responsabilidade ao cliente.
- **RN-009 — Classificação de ocorrência:** responsabilidade pode ser CLIENTE, EMPRESA, MOTOBOY, SISTEMA ou INDEFINIDO.
- **RN-010 — Retorno confirmado:** quando a mercadoria coletada retornar à empresa, o recebimento deve ser confirmado antes de liberar nova tentativa ou encerrar definitivamente, conforme o cenário.
- **RN-011 — Falha pré-coleta:** falha do motoboy antes da coleta não gera tentativa; desfaz a atribuição e pode redisponibilizar a entrega.
- **RN-012 — Falha mecânica pós-coleta:** após retorno confirmado, encerra a tentativa, preserva Pedido/Entrega e permite nova tentativa.
- **RN-013 — Recuperação física em stand-by:** nesta baseline, a logística de retorno após falha mecânica é responsabilidade operacional da empresa e não é gerenciada detalhadamente pelo ERMES.
- **RN-014 — Ausência:** destinatário ausente é ocorrência terminal; produtos são reembolsados, frete permanece cobrado em 70/25/5.
- **RN-015 — Recusa:** recusa do destinatário é terminal; produtos são reembolsados, frete permanece cobrado em 70/25/5.
- **RN-016 — Endereço incorreto do cliente:** é terminal, exige novo Pedido para endereço corrigido, reembolsa produtos e mantém frete 70/25/5.
- **RN-017 — Impedimento externo:** deve-se tentar rota/alternativa segura; se houver retorno, Entrega aguarda revalidação e cliente não paga o frete da tentativa malsucedida.
- **RN-018 — Revalidação:** somente a empresa pode autorizar nova disponibilização após condição que exija revalidação; mensagem do cliente não substitui essa verificação.
- **RN-019 — Erro do sistema corrigível:** falha pontual do ERMES, comprovadamente corrigida, pode permitir nova tentativa da mesma Entrega após confirmação da disponibilidade do cliente.
- **RN-020 — Erro do sistema persistente:** falha sem correção confiável ou prazo previsível encerra a operação com reembolso integral e sem sanções.
- **RN-021 — Produto indisponível:** antes da coleta, empresa pode propor ajuste; qualquer alteração exige concordância explícita do cliente.
- **RN-022 — Diferença de preço:** substituto mais caro exige cobrança/ajuste da diferença; mais barato exige devolução/ajuste a favor do cliente.
- **RN-023 — Produto indisponível sem acordo:** Entrega CANCELADA, Pedido ENCERRADO, responsabilidade EMPRESA, reembolso integral e nenhuma tentativa criada.
- **RN-024 — Cancelamento pré-coleta:** não cria tentativa e não remunera frete ao motoboy.
- **RN-025 — Cancelamento pós-coleta:** reembolsa integralmente produtos e 50% do frete; os demais 50% do frete são do motoboy.
- **RN-026 — Sanção temporal fora da 0.2:** não aplicar regra fixa de 3 minutos, percentual de tempo ou suspensão de 2 horas nesta baseline.
- **RN-027 — Entrega bem-sucedida:** código válido leva Tentativa a CONCLUIDA, Entrega a FINALIZADA e Pedido a CONCLUIDO.
- **RN-028 — Encerramento por ocorrência:** ocorrência terminal sem cancelamento explícito leva Entrega a NAO_REALIZADA e Pedido a ENCERRADO.
- **RN-029 — Cancelamento explícito:** cancelamento leva Entrega a CANCELADA e Pedido a CANCELADO.
- **RN-030 — Alteração voluntária futura:** cliente não possui, na 0.2, funcionalidade geral de alterar pedido confirmado por desejo próprio.

## 13. Requisitos funcionais afetados pela 0.2

- **RF-001:** permitir múltiplos `UsuarioEmpresa` vinculados a uma empresa, com perfis iniciais RESPONSAVEL e ATENDENTE.
- **RF-002:** registrar qual usuário da empresa executou ações relevantes quando necessário para auditoria.
- **RF-003:** criar `TentativaEntrega` somente ao confirmar a coleta.
- **RF-004:** registrar eventos de aceite, chegada à coleta e desatribuição mesmo quando não houver tentativa criada.
- **RF-005:** impedir mais de uma tentativa ativa para a mesma entrega.
- **RF-006:** permitir redisponibilizar entrega após falha recuperável somente depois das condições de retorno/revalidação exigidas.
- **RF-007:** registrar ocorrências com tipo, descrição, data/hora, responsável pelo registro e classificação de responsabilidade.
- **RF-008:** permitir classificação de ocorrência pela empresa quando necessária.
- **RF-009:** suportar retorno da mercadoria e confirmação de recebimento pela empresa.
- **RF-010:** suportar o estado AGUARDANDO_REVALIDACAO e impedir aceite enquanto nesse estado.
- **RF-011:** permitir à empresa revalidar a viabilidade e autorizar nova disponibilização.
- **RF-012:** manter o mesmo código de confirmação entre tentativas da mesma Entrega.
- **RF-013:** zerar o contador de validações inválidas quando uma nova TentativaEntrega for criada.
- **RF-014:** bloquear conclusão após a terceira validação inválida e direcionar ao retorno.
- **RF-015:** permitir registrar responsabilidade CLIENTE, EMPRESA, MOTOBOY, SISTEMA ou INDEFINIDO.
- **RF-016:** aplicar regras financeiras por cenário e classificação sem presumir culpa do cliente.
- **RF-017:** tratar destinatário ausente e recusa como terminais após retorno confirmado.
- **RF-018:** tratar endereço incorreto atribuído ao cliente como terminal, exigindo novo pedido para endereço corrigido.
- **RF-019:** permitir registrar impedimento externo, manter Pedido/Entrega abertos e exigir revalidação antes de nova tentativa.
- **RF-020:** permitir concluir entrega em ponto alternativo seguro quando operacionalmente viável, preservando confirmação normal.
- **RF-021:** preservar endereço originalmente informado e endereço apresentado pelo sistema quando houver divergência atribuível ao ERMES.
- **RF-022:** permitir encerrar integralmente operação por erro persistente do ERMES, com reembolso integral.
- **RF-023:** permitir à empresa propor ajuste por produto/serviço indisponível antes da coleta.
- **RF-024:** exigir concordância explícita do cliente antes de aplicar ajuste excepcional.
- **RF-025:** recalcular valores, peso e frete aplicável após ajuste aceito.
- **RF-026:** registrar cobrança/devolução da diferença de preço do ajuste.
- **RF-027:** adicionar `CONCLUIDO` e `ENCERRADO` ao ciclo de `Pedido`.
- **RF-028:** manter distinção entre Pedido CONCLUIDO, ENCERRADO e CANCELADO.
- **RF-029:** não aplicar suspensão temporal baseada em momento do cancelamento nesta baseline.
- **RF-030:** não disponibilizar funcionalidade genérica de alteração voluntária de pedido confirmado pelo cliente na 0.2.

## 14. Critérios de aceitação essenciais

1. Aceitar uma entrega e falhar antes da coleta não cria `TentativaEntrega`.
2. Confirmar a primeira coleta cria exatamente `TentativaEntrega #1`.
3. Falha mecânica após a coleta não cria `TentativaEntrega #2` antes do retorno confirmado e de uma nova coleta.
4. Após retorno recuperável confirmado, nova coleta cria `TentativaEntrega #2` para a mesma `Entrega`.
5. Código de confirmação não muda entre tentativas da mesma `Entrega`.
6. Contador de códigos inválidos é zero na nova tentativa.
7. Três códigos inválidos não são confundidos com “tentativa nº 3 de entrega”.
8. Ausência e recusa reembolsam produtos e mantêm frete 70/25/5.
9. Endereço incorreto atribuído ao cliente reembolsa produtos, mantém frete 70/25/5 e exige novo Pedido para outro endereço.
10. Impedimento externo não permite nova aceitação enquanto `AGUARDANDO_REVALIDACAO`.
11. Mensagem do cliente dizendo que o acesso foi liberado não libera a entrega sem verificação da empresa.
12. Falha persistente do ERMES encerra a operação sem oferecer espera indefinida e gera reembolso integral.
13. Ajuste por produto indisponível não pode ocorrer sem aceite explícito do cliente.
14. Produto substituto mais caro exige ajuste financeiro antes da continuidade.
15. Cancelamento pós-coleta devolve produtos integralmente e 50% do frete ao cliente; 50% do frete é do motoboy.
16. Nenhuma sanção temporal de 3 minutos/30%/2 horas é aplicada na 0.2.
17. Entrega bem-sucedida resulta em `Entrega.FINALIZADA` e `Pedido.CONCLUIDO`.
18. Ocorrência terminal não voluntária resulta em `Entrega.NAO_REALIZADA` e `Pedido.ENCERRADO`.
19. Cancelamento explícito resulta em `Entrega.CANCELADA` e `Pedido.CANCELADO`.
20. Cliente não possui edição genérica de pedido confirmado na 0.2.

## 15. Guardrails de implementação

- Não implementar geocodificação, API de rotas ou provedor de mapas como requisito obrigatório da 0.2 sem nova autorização.
- Não reintroduzir a tolerância fixa de 3 minutos nem a suspensão automática de 2 horas.
- Não converter aceite pré-coleta em `TentativaEntrega`.
- Não incrementar tentativa por falha antes da coleta.
- Não usar o contador de código como número de `TentativaEntrega`.
- Não gerar novo código de confirmação quando houver nova tentativa da mesma Entrega.
- Não liberar entrega em `AGUARDANDO_REVALIDACAO` para aceite.
- Não criar transferência direta de mercadoria motoboy → motoboy.
- Não automatizar culpa do cliente em ocorrência ambígua.
- Não permitir alteração excepcional de produto sem consentimento explícito do cliente.
- Não criar, por consequência desta baseline, uma funcionalidade genérica de alteração de pedido pelo cliente.
- Não criar sistema completo de estoque.
- Não inventar política interna de custos das tentativas malsucedidas marcadas como futuras.
- Preservar histórico e evidências; não sobrescrever silenciosamente dados relevantes de endereço, estado ou ocorrência.

## 16. Itens deliberadamente pendentes para baseline futura

- Regra de sanção temporal baseada em tempo estimado de rota.
- Geolocalização, geocodificação e roteamento automáticos robustos.
- Provedor tecnológico de mapas/rotas.
- Política completa de remuneração/custos em falhas atribuíveis ao sistema, motoboy, indefinido ou impedimento externo.
- Operação de recuperação da mercadoria gerenciada pelo ERMES.
- Transferência direta entre motoboys.
- Alteração de pedido iniciada pelo cliente.
- Avaliações e comentários de empresas.
- Política de sanções cumulativas.
- Alternativa de confirmação após três códigos inválidos.
- Responsabilidades completas do administrador global.

## 17. Condição para iniciar implementação da 0.2

A Baseline 0.2 está **funcionalmente fechada como especificação**, mas sua implementação só deve começar após a conclusão da 0.1.

Antes da migração:

1. Finalizar funcionalidades da 0.1.
2. Garantir que não existam trabalhos parciais relevantes.
3. Executar testes automatizados existentes.
4. Executar smoke test manual dos fluxos centrais.
5. Auditar o código da 0.1 contra sua baseline.
6. Registrar checkpoint/commit/tag de fechamento da 0.1.
7. Só então abrir a implementação da 0.2.

## 18. Registro de fechamento

| Campo | Registro |
|---|---|
| Baseline | 0.2 |
| Status de regras de negócio | FECHADA |
| Próxima etapa | Consolidação técnica e futura implementação após fechamento estável da 0.1 |
| Novas decisões após este fechamento | Direcionar à Baseline 0.3, salvo correção comprovada de contradição ou erro documental desta baseline |
