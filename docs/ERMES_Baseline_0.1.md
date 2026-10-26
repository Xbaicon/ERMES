# ERMES — Especificação Consolidada de Requisitos e Regras de Negócio

**Baseline 0.1 — 13 de setembro de 2026**  
**Status do documento:** documento de handoff e fonte de verdade provisória. Não é ainda a documentação final do projeto.  
**Objetivo:** permitir que outra conversa, outro membro da equipe ou uma ferramenta de desenvolvimento como o Codex compreenda o ERMES sem precisar reconstruir as decisões desta conversa.

## Como usar este documento

Este documento consolida somente a versão mais recente das decisões tomadas. Quando uma regra antiga foi corrigida ou removida, a versão antiga não deve ser considerada válida.

Classificação das decisões:

- **DEFINIDO:** deve ser respeitado pela implementação e pela documentação subsequente.
- **PENDENTE:** foi identificado, mas ainda precisa de decisão; não deve ser inventado por desenvolvedor ou IA.
- **FORA DO ESCOPO:** não deve ser implementado na primeira versão sem nova decisão explícita.
- **OPCIONAL / SE HOUVER TEMPO:** pode ser implementado sem comprometer o núcleo obrigatório, desde que não altere regras definidas.
- **EVOLUÇÃO FUTURA:** ideia válida para versões posteriores, não obrigatória agora.

### Regra de autoridade

Em caso de conflito entre uma implementação existente e este documento, a implementação não deve alterar silenciosamente a regra de negócio. O conflito deve ser identificado e a implementação deve ser ajustada à especificação vigente, salvo instrução posterior em contrário.

Em caso de conflito interno neste documento, prevalece a decisão mais específica e mais recente descrita na seção temática correspondente.

---

# Visão do produto

## Contexto

O ERMES é um sistema voltado a pequenos comércios locais que realizam vendas e entregas com motoboys próprios. O projeto surgiu de uma demanda preexistente, assumida pelo grupo para desenvolvimento acadêmico no SENAI.

A primeira versão será uma **aplicação web responsiva**, utilizável tanto em computadores quanto em navegadores de celulares. Não haverá aplicativo móvel nativo nesta versão.

## Problema de negócio

Pequenos comércios locais que realizam entregas por meio de motoboys podem depender de processos manuais para receber pedidos e organizar entregas. O atendimento por ligação gera lentidão, retrabalho e dificuldade de organização. O cálculo de frete também pode ser realizado por estimativa, sem critérios objetivos e automatizados.

Além disso, há necessidade de distribuir entregas entre motoboys vinculados ao estabelecimento, acompanhar o andamento da operação, informar o cliente sobre o progresso da entrega, tratar cancelamentos e falhas e fornecer um mecanismo confiável de confirmação do recebimento.

## Objetivo geral

Facilitar e agilizar o processo de comercialização e entrega de mercadorias por pequenos comércios locais que utilizam motoboys, centralizando pedidos, cálculo de frete, gerenciamento das entregas, acompanhamento da operação e confirmação do recebimento em uma plataforma web.

## Objetivos específicos

- Reduzir a dependência de pedidos e solicitações de entrega realizados por ligação.
- Permitir que clientes solicitem produtos diretamente aos estabelecimentos participantes.
- Automatizar o cálculo do frete com base em peso, distância e tempo estimado da rota.
- Permitir que cada empresa configure seus parâmetros tarifários de frete.
- Organizar a disponibilização e aceitação de entregas pelos motoboys da empresa.
- Permitir o acompanhamento da execução da entrega.
- Aumentar a segurança da confirmação do recebimento por meio de código de verificação.
- Registrar estados, eventos, cancelamentos, devoluções e falhas da operação.
- Preservar histórico suficiente para suporte, auditoria e aplicação das regras financeiras.

---

# Escopo da primeira versão

## Dentro do escopo — DEFINIDO

- Cadastro e autenticação de usuários que interagem diretamente com o sistema.
- Cadastro de empresas participantes.
- Cadastro de motoboys vinculados a empresas.
- Cadastro e disponibilização de produtos pela empresa.
- Cadastro do peso unitário do produto.
- Marcação de produto como disponível ou indisponível para venda.
- Consulta de produtos pelo cliente.
- Pedidos contendo um ou vários produtos e quantidades.
- Alteração de itens do pedido antes da confirmação da venda pela empresa.
- Comunicação entre cliente e empresa por chat.
- Mensagens predefinidas no chat para agilizar o atendimento.
- Cadastro de um endereço padrão para o cliente, substituível posteriormente.
- Informação manual de outro endereço de entrega.
- Uso da localização atual do cliente como destino, mediante permissão do navegador.
- Possibilidade de o destinatário ser diferente do solicitante.
- Preservação do endereço efetivamente utilizado na operação.
- Cálculo automático do frete.
- Integração com serviço externo de geocodificação/rotas para distância e tempo estimado.
- Configuração, por empresa, dos parâmetros tarifários relacionados a peso, distância e tempo.
- Limite máximo de 12 kg por pedido elegível para venda/entrega no ERMES.
- Controle de disponibilidade do motoboy por status online/offline.
- Aceitação remota de entregas por motoboy autenticado.
- Restrição a uma entrega ativa por motoboy.
- Prevenção da aceitação simultânea da mesma entrega por mais de um motoboy.
- Rastreamento da localização do motoboy durante a execução da entrega, dentro das limitações de uma aplicação web.
- Visualização da localização atual ou última localização conhecida pelo cliente responsável pela entrega.
- Compartilhamento controlado de informações entre cliente e motoboy necessárias à operação.
- Estados e histórico da entrega.
- Registro de chegada ao ponto de coleta, coleta, chegada ao destino e demais eventos relevantes.
- Tratamento de cancelamentos, falhas, não realização e retorno da mercadoria.
- Confirmação dupla do retorno de mercadoria entre motoboy e empresa.
- Código de confirmação da entrega com limite de três tentativas.
- Pagamento, situação do pagamento, reembolso e distribuição financeira como conceitos do sistema.
- Regra de divisão normal do frete: 70% motoboy, 25% empresa e 5% ERMES.
- Restrição temporária de 2 horas para novos pedidos após cancelamento tardio do cliente, conforme regra de tolerância pós-coleta.

## Fora do escopo — DEFINIDO

- Aplicativo móvel nativo Android ou iOS.
- Motoboy autônomo ou motoboy independente de empresa.
- Entregas agendadas para horário futuro.
- Reserva antecipada de motoboy.
- Mais de uma entrega ativa simultaneamente para o mesmo motoboy.
- Transferência direta de mercadoria entre motoboys durante uma entrega.
- Controle completo de estoque, inventário, entrada e saída, reposição, fornecedores e lotes.
- Rastreamento permanente do motoboy quando ele não estiver em uma entrega ativa.
- Garantia de rastreamento contínuo quando navegador/dispositivo estiver suspenso, bloqueado ou incapaz de fornecer geolocalização.
- Jornada de trabalho completa ou controle de ponto do motoboy.
- Sistema cumulativo de sanções na primeira versão.
- Método alternativo de confirmação caso as três tentativas de código falhem.

## Opcional / se houver tempo

- Aplicação PWA.
- Notificações Web Push para avisar motoboys sobre novas entregas.
- Integração real com meio de pagamento/gateway. Se não houver tempo, o sistema deve manter o modelo de pagamento e pode simular a confirmação da transação.
- Promoções por quantidade ou regras promocionais simples, desde que o cronograma permita e sem transformar o ERMES em um sistema completo de e-commerce.

## Evolução futura

- Sanções cumulativas por cancelamentos tardios, com aumento progressivo do tempo de restrição e possibilidade de bloqueio.
- Eventuais métodos alternativos de confirmação de entrega.
- Evoluções de PWA/notificações e integrações de pagamento.

---

# Stakeholders e atores — levantamento preliminar

Esta seção ainda será refinada antes da modelagem de casos de uso.

## Stakeholders identificados

- Cliente/solicitante.
- Empresa/comércio local.
- Motoboy.
- Destinatário da mercadoria, mesmo quando não possui conta.
- Administração/gestão do ERMES.
- Equipe responsável pela manutenção do ERMES.
- Responsáveis pelo negócio do estabelecimento, ainda que não utilizem o sistema diretamente.

## Atores humanos identificados

- Cliente.
- Usuário responsável pela empresa — estrutura exata de usuários da empresa ainda está PENDENTE.
- Motoboy.
- Administrador do ERMES — funcionalidades administrativas específicas ainda estão PENDENTES.

## Atores externos/sistemas externos

- Serviço de geocodificação/rotas.
- Gateway/meio de pagamento, somente se houver integração real.

## Observação importante

Destinatário não é necessariamente usuário do ERMES. Uma pessoa pode receber uma mercadoria e fornecer o código de confirmação sem possuir cadastro próprio.

---

# Identidade, cadastro e autenticação

## DEFINIDO

- Todo usuário que interagir diretamente com as funcionalidades do ERMES deverá possuir cadastro e autenticar-se.
- O destinatário que apenas recebe uma mercadoria não precisa possuir conta.
- Cliente, empresa, motoboy e administrador representam papéis distintos no domínio.
- Uma empresa é uma entidade de negócio; a pessoa que acessa o sistema em nome dela é um usuário associado à empresa.
- O modelo exato de quantidade de usuários por empresa ainda não foi decidido.

## Motoboy

- Todo motoboy da primeira versão deve estar vinculado a uma empresa.
- Não haverá atuação autônoma.
- O cadastro deve conter os dados necessários à identificação e à operação, inclusive os dados de veículo que serão compartilhados com o cliente quando apropriado, como identificação do veículo e placa.
- CPF deve representar a identidade do motoboy de forma única no sistema, porém recomenda-se que o banco use um identificador interno como chave técnica e mantenha o CPF com restrição de unicidade.

---

# Produtos, pedidos e ItemPedido

## Produto

- A empresa cadastra os produtos comercializados no ERMES.
- O produto deve possuir peso unitário cadastrado para que possa participar do cálculo de frete.
- Produto sem peso necessário ao cálculo não deve ficar disponível para venda no ERMES.
- A empresa é responsável por informar o peso real do produto.
- A empresa pode marcar um produto como disponível ou indisponível.
- O ERMES não controla o estoque físico da empresa.
- A empresa é responsável, por seus próprios meios, por saber se dispõe do produto antes de mantê-lo disponível para venda.

## Pedido

- Um pedido deve conter pelo menos um produto e pode conter vários produtos.
- Um cliente pode solicitar diferentes produtos e diferentes quantidades no mesmo pedido.
- Pedido representa a negociação/comercialização; Entrega representa a operação logística. São conceitos distintos.
- A entrega somente deve ser criada quando o pedido estiver suficientemente confirmado para dar início à operação logística.

## ItemPedido

ItemPedido é uma entidade associativa entre Pedido e Produto. Ela existe porque a relação Pedido–Produto possui dados próprios.

Dados conceituais já identificados para ItemPedido:

- Produto referenciado.
- Quantidade.
- Preço unitário praticado no momento do pedido.

O preço do produto no ItemPedido deve preservar o valor histórico. Se o preço atual do produto mudar futuramente, pedidos anteriores não devem mudar retroativamente.

Relação conceitual preliminar:

Pedido 1 → 1..* ItemPedido  
Produto 1 → 0..* ItemPedido

## Alterações do pedido

- Antes da confirmação da empresa, o cliente pode adicionar produtos, remover produtos e alterar quantidades.
- Após a confirmação, os itens do pedido não podem ser modificados diretamente.
- Se houver alteração após o envio para análise e antes da confirmação, a empresa deve analisar a versão atualizada; a modelagem final do estado “alterado após envio” ainda poderá ser refinada.
- Alterar itens ou quantidades deve disparar novo cálculo do peso total e, quando aplicável, novo cálculo do frete.

## Chat — DEFINIDO

- Cada Pedido pode possuir uma conversa própria entre o cliente proprietário e a empresa proprietária.
- Não existe chat geral desvinculado de Pedido na Baseline 0.1.
- A conversa pode ser materializada somente na primeira mensagem; não é obrigatório criar registro vazio quando o Pedido nasce.
- Somente cliente e empresa participam. Motoboy e Administrador do ERMES não possuem caso de uso de chat nesta baseline.
- O chat fica disponível desde o estado `draft` e permanece gravável enquanto o Pedido não estiver encerrado. Quando a operação vinculada alcançar um estado terminal já existente, o histórico continua consultável, mas novas mensagens são rejeitadas.
- Mensagens são textos livres persistentes e imutáveis, identificados pelo Pedido, remetente, papel/origem e momento do envio.
- A tecnologia da Baseline 0.1 é HTTP normal com polling periódico. WebSocket, Server-Sent Events, broker e mensageria externa não pertencem a este fluxo.
- Mensagens predefinidas são listas fixas no código, sem tabela, CRUD, categorias, favoritos, personalização, variáveis ou atalhos por empresa.
- Sugestões do cliente:
  - "Olá, gostaria de tirar uma dúvida sobre o pedido."
  - "Gostaria de confirmar a disponibilidade dos produtos."
  - "Preciso informar algo sobre a entrega."
- Sugestões da empresa:
  - "Olá! Como podemos ajudar?"
  - "Seu pedido está sendo analisado."
  - "Precisamos confirmar uma informação do seu pedido."
  - "O produto solicitado está indisponível."
- Não pertencem ao chat 0.1: anexos, imagem, áudio, vídeo, localização, chamadas, reações, edição, exclusão, respostas encadeadas, menções, grupos, busca, arquivamento, presença, “digitando”, confirmação de leitura, contagem sofisticada de não lidas, push e chat com motoboy.
- O chat pode apoiar confirmação e negociação, sem transformar o ERMES em uma plataforma completa de marketplace.

---

# Cliente, destinatário e endereço

## Cliente e destinatário

- Cliente/solicitante é quem realiza o pedido.
- Destinatário é quem recebe fisicamente a mercadoria.
- Cliente e destinatário podem ser a mesma pessoa ou pessoas diferentes.
- O cliente deve poder informar, antes da entrega, se ele próprio ou outra pessoa receberá a mercadoria.
- Quando houver outro destinatário, o sistema deve permitir informar os dados necessários à entrega, como nome e, se requerido no refinamento, telefone/contato.
- Uma pessoa autorizada pelo cliente pode receber a mercadoria desde que possua o código válido da entrega; isso permite recebimento por familiar, porteiro ou outra pessoa autorizada.

## Endereço padrão

- O cliente pode manter um endereço padrão cadastrado.
- A primeira versão não exige múltiplos endereços salvos.
- Se o cliente mudar de endereço, ele pode substituir o endereço padrão anterior.
- Alterar o cadastro atual não pode alterar o endereço histórico de entregas anteriores.

## Destino da entrega

O cliente deve poder escolher entre:

- Usar o endereço padrão cadastrado.
- Usar a localização atual do dispositivo, mediante permissão.
- Informar manualmente outro endereço.

Se a entrega for para outra pessoa, o endereço efetivo daquela entrega é o que deve ser usado no cálculo do frete, independentemente do endereço cadastrado do solicitante.

## Geocodificação e confirmação do endereço

- O endereço fornecido deve ser convertido/localizado por serviço de geocodificação.
- Antes da confirmação final, o ERMES deve apresentar ao cliente o endereço interpretado e, idealmente, sua posição no mapa, solicitando confirmação ou correção.
- Para suporte/auditoria, devem ser preservados, quando aplicável: endereço digitado, endereço interpretado, coordenadas utilizadas, endereço confirmado e dados relevantes da rota usada no cálculo.
- Se o cliente confirmar um endereço/local incorreto fornecido por ele, a responsabilidade pela falha é do lado do cliente.
- Se houver erro interno comprovável do ERMES que utilize endereço/coordenadas diferentes do que foi confirmado, o caso é tratado como falha do sistema e não deve ser atribuído ao cliente.

---

# Cálculo do frete

## Fórmula — DEFINIDO

Frete = TaxaPeso + (ValorPorKm × DistânciaKm) + (ValorPorMinuto × TempoEstimadoMin)

Valores atualmente fornecidos pela demanda de referência:

- Peso < 1 kg → R$ 3,00.
- 1 kg ≤ peso < 3 kg → R$ 5,00.
- 3 kg ≤ peso < 8 kg → R$ 9,00.
- 8 kg ≤ peso ≤ 12 kg → R$ 12,00.
- Distância → R$ 0,50 por km.
- Tempo → R$ 0,30 por minuto estimado.

## Configuração por empresa

- Os parâmetros tarifários referentes a peso, distância e tempo devem poder ser editados pela própria empresa quando necessário.
- Administradores do ERMES não precisam definir esses valores para cada empresa.
- Uma empresa só pode alterar sua própria configuração.
- Distância e tempo calculados para uma rota não são valores que a empresa edita manualmente; a empresa configura os valores monetários aplicados a esses componentes.
- O limite máximo de 12 kg permanece, no estado atual da especificação, uma regra do negócio.

## Peso total

PesoTotal = soma de (pesoUnitárioProduto × quantidadeItem)

- O sistema deve recalcular o peso quando itens ou quantidades forem alterados.
- Se PesoTotal > 12 kg, a venda não pode ser concluída no ERMES.
- O cliente deve ser informado de que precisa reduzir/remover itens para prosseguir.
- A validação de peso deve ocorrer antes de consumir desnecessariamente o serviço externo de rotas.

## Distância e tempo estimado

- Origem da rota: endereço/ponto do estabelecimento.
- Destino da rota: endereço efetivo da entrega.
- O cliente não informa manualmente quilômetros nem minutos.
- O serviço de rotas deve fornecer distância viária e tempo estimado.
- O tempo usado no cálculo do frete é o tempo estimado no momento do cálculo, não o tempo real posteriormente gasto pelo motoboy.
- Mudanças de trânsito após a confirmação não alteram retroativamente o preço aceito.

## Frações e arredondamento

- Distância e tempo podem ser usados com suas frações, sem arredondamento prévio para km/min inteiros.
- O cálculo deve usar a precisão necessária internamente.
- O valor monetário final deve ser arredondado para duas casas decimais.

## Recálculo

- Alteração de produto/quantidade → recalcular peso e frete.
- Alteração do endereço/destino → recalcular distância, tempo e frete.
- Alteração apenas de nome/telefone do destinatário, sem mudança de destino, não exige novo frete.
- Antes da confirmação final da venda, o sistema deve validar que o frete corresponde à versão atual do pedido e do destino.

## Falha de endereço/rota

- Se o endereço estiver inválido ou incompleto e não puder ser localizado, solicitar correção/complementação.
- Se o serviço externo de rotas estiver indisponível, não estimar o frete manualmente “no chute”.
- Sem cálculo confiável de frete, a venda não deve ser confirmada naquele momento.

## Preservação histórica

Devem ser preservados os dados suficientes para reproduzir/explicar o cálculo original, incluindo, quando aplicável:

- Peso total usado.
- Faixa/taxa de peso utilizada.
- Distância calculada.
- Tempo estimado utilizado.
- Valor por km utilizado.
- Valor por minuto utilizado.
- Valor final do frete.

Alterações posteriores na configuração da empresa não podem modificar fretes antigos.

---

# Motoboy: disponibilidade, aceite e rastreamento

## Disponibilidade

O motoboy controla seu estado profissional por um comando simples online/offline.

Regra de aptidão:

online = verdadeiro E não possui entrega ativa → apto a aceitar entrega.

Se qualquer uma dessas condições não for satisfeita, o motoboy não pode aceitar nova entrega.

- Um motoboy offline pode continuar acessando funções como histórico e conta, mas não pode aceitar novas entregas.
- Um motoboy com entrega ativa pode visualizar novas entregas disponíveis, mas o aceite deve ficar bloqueado.

## Aceite remoto

- O motoboy não precisa estar fisicamente no estabelecimento para visualizar ou aceitar uma entrega.
- Ele deve estar autenticado, vinculado à empresa, online e sem entrega ativa.
- O sistema deve permitir aceite por navegador móvel.

## Concorrência

Uma entrega disponível só pode ser aceita por um motoboy.

A garantia deve ocorrer no servidor/banco, não apenas na interface. Se dois motoboys tentarem aceitar simultaneamente, somente a primeira operação válida deve atribuir a entrega; o outro deve receber informação de que a entrega já foi aceita.

## Início da execução

- A execução da entrega começa quando o motoboy aceita a solicitação.
- Aceitar não significa que a mercadoria já está a caminho do destinatário.
- Após o aceite, o motoboy passa a ser considerado ocupado.
- A entrega deixa de ficar disponível para outros motoboys.
- O sistema registra motoboy e data/hora do aceite.

## Rastreamento

- Para o cliente, localização pontual pode ser suficiente para definir destino.
- Para o motoboy, durante uma entrega ativa, o ERMES deve acompanhar periodicamente a posição quando o navegador/dispositivo puder fornecê-la.
- O rastreamento pode iniciar após o aceite e deve ser encerrado quando a operação terminar ou for cancelada.
- Não rastrear continuamente o motoboy fora de uma entrega ativa.
- O cliente só deve visualizar a localização do motoboy vinculado à sua própria entrega.
- Se não houver atualização recente, apresentar a posição como “última localização conhecida” e informar quando foi atualizada.
- A primeira versão web não pode prometer rastreamento contínuo em segundo plano quando o navegador estiver suspenso/bloqueado.

## PWA e notificações

- PWA e Web Push são opcionais se houver tempo.
- O núcleo do sistema deve funcionar sem essas tecnologias.
- Sem Push, novas entregas devem aparecer no painel do motoboy enquanto ele utiliza o sistema.

---

# Ciclo normal da entrega

Os nomes abaixo estão aceitos para a versão atual; poderão ser refinados semanticamente na modelagem final sem mudar o comportamento.

Fluxo normal:

DISPONÍVEL  
→ EM DESLOCAMENTO PARA COLETA  
→ AGUARDANDO COLETA  
→ EM TRANSPORTE  
→ AGUARDANDO CONFIRMAÇÃO  
→ FINALIZADA

“Em andamento” pode ser usado como conceito amplo para uma entrega que já foi aceita e ainda não foi encerrada.

## Ações e marcos

### Aceite

- Marca o início da execução.
- Registra data/hora.
- Torna o motoboy ocupado.

### Cheguei ao ponto de coleta

- O motoboy aciona um comando ao chegar ao estabelecimento.
- Registra a chegada, mas ainda não significa posse da mercadoria.

### Pedido coletado / iniciar entrega

- Acionado quando o motoboy efetivamente recebe a mercadoria.
- O servidor registra automaticamente a data/hora exata da coleta.
- Marca a transição para EM TRANSPORTE.
- Inicia a contagem da tolerância de cancelamento pós-coleta.
- A partir da coleta, a mercadoria passa a estar sob responsabilidade operacional do motoboy.

### Cheguei ao destino

- O motoboy aciona um comando ao chegar ao endereço da entrega.
- O sistema registra data/hora.
- A entrega passa para AGUARDANDO CONFIRMAÇÃO.

### Finalização

- Só ocorre após validação correta do código de confirmação pelo ERMES.
- Não deve existir um botão comum que permita ao motoboy “forçar” a conclusão sem código válido.

## Histórico de eventos

O ERMES deve preservar histórico dos eventos relevantes, por exemplo:

- criação da entrega;
- aceite e motoboy responsável;
- chegada ao estabelecimento;
- coleta;
- início do transporte;
- chegada ao destino;
- tentativas de código;
- cancelamentos/ocorrências;
- retorno da mercadoria;
- confirmação da empresa;
- encerramento.

Não basta manter somente o status atual.

---

# Cancelamentos, falhas e exceções

A coleta divide o ciclo em dois momentos críticos. Ocorrências antes e depois da coleta podem ter consequências diferentes para logística, reembolso e remuneração.

## Falha do motoboy antes da coleta — DEFINIDO

- Motoboy informa que não pode continuar.
- Motivo é registrado.
- Motoboy é desvinculado da entrega.
- A mesma entrega volta a ficar DISPONÍVEL para outro motoboy.
- Histórico do primeiro motoboy permanece registrado.
- Não há compensação financeira especial ao motoboy.
- Cliente não precisa criar/pagar uma nova operação.

## Falha do motoboy depois da coleta — DEFINIDO

- A entrega não volta imediatamente a DISPONÍVEL porque a mercadoria está fisicamente com o motoboy.
- O motoboy deve retornar a mercadoria ao estabelecimento.
- Não haverá transferência direta entre motoboys na primeira versão.
- O retorno deve ser confirmado por verificação dupla entre motoboy e empresa.
- Somente após a confirmação do retorno a entrega poderá ser redisponibilizada para outro motoboy.
- O motoboy que falhou não recebe remuneração daquela entrega.

## Cancelamento pelo cliente antes da coleta — DEFINIDO

- Pode ocorrer a qualquer momento antes da coleta.
- Não existe mais a regra antiga de pagamento de 25% do frete ao motoboy; essa regra foi revogada.
- Não há remuneração de frete ao motoboy por esse cancelamento.
- A mercadoria permanece no estabelecimento.
- Não há restrição de 2 horas, pois a tolerância se aplica somente após a coleta.

## Cancelamento pelo cliente depois da coleta — DEFINIDO

- A mercadoria deve retornar ao estabelecimento.
- O cliente recebe reembolso integral do valor dos produtos.
- O cliente recebe reembolso de 50% do valor do frete.
- O motoboy recebe 50% do valor total do frete.
- Neste cenário, a parcela de empresa/ERMES sobre o frete não foi definida como devida; a interpretação vigente é que os 50% não reembolsados correspondem à remuneração do motoboy.

### Tolerância

- A partir da confirmação “Pedido coletado”, começa um período de tolerância de 3 minutos.
- Dentro dos 3 minutos, o cliente pode cancelar sem sanção adicional na conta, mantendo as consequências financeiras acima.
- Após os 3 minutos, o cliente ainda pode cancelar, mantendo as mesmas consequências financeiras, mas fica impedido de realizar novos pedidos por 2 horas.
- O valor de 3 minutos pode ser alterado futuramente.
- Sanções cumulativas são evolução futura e não pertencem à primeira versão.

## Destinatário ausente — DEFINIDO

- Motoboy chega corretamente ao endereço informado/confirmado.
- Deve haver tentativa de contato conforme interface a ser detalhada.
- Se a entrega não puder ser concluída, registrar ocorrência de destinatário ausente / entrega não realizada.
- Não há reembolso do produto.
- Não há reembolso do frete.
- A mercadoria retorna ao estabelecimento.
- A distribuição interna do frete entre motoboy, empresa e ERMES neste tipo de falha ainda é PENDENTE; somente a ausência de reembolso ao cliente está definida.

## Destinatário recusa a mercadoria — DEFINIDO

Aplica-se quando produto, coleta, transporte e endereço estão corretos e o destinatário simplesmente se recusa a receber.

- Registrar recusa do destinatário.
- Mercadoria retorna ao estabelecimento.
- Não há reembolso do produto.
- Não há reembolso do frete.
- A distribuição interna do frete neste cenário ainda é PENDENTE.

## Endereço incorreto/inacessível por responsabilidade do cliente — DEFINIDO

- O endereço interpretado deve ser confirmado previamente pelo cliente.
- Se ele confirmar uma localização incorreta e a falha só for percebida durante a entrega, a ocorrência é atribuída ao lado do cliente.
- Mercadoria retorna ao estabelecimento quando não puder ser entregue.
- Não há reembolso do produto.
- Não há reembolso do frete.
- A distribuição interna do frete neste cenário ainda é PENDENTE.

## Erro comprovável do sistema no endereço/rota — DEFINIDO EM PRINCÍPIO, FINANCEIRO PENDENTE

- Não atribuir ao cliente uma falha causada por uso incorreto, pelo ERMES, de endereço/coordenadas diferentes do que foi confirmado.
- O sistema deve manter dados de rastreabilidade para investigar a origem da falha.
- Deve haver tratamento de reembolso adequado, mas os valores exatos ainda são PENDENTES.

## Produto indisponível por responsabilidade da empresa — DEFINIDO

- ERMES não controla estoque físico.
- Empresa deve marcar produto indisponível quando não puder vendê-lo.
- Se a empresa permitir a venda e depois não conseguir disponibilizar a mercadoria, a falha é atribuída à empresa.
- A entrega não volta a DISPONÍVEL para outro motoboy, pois trocar de entregador não resolve falta de produto.
- Cliente recebe de volta todo valor efetivamente pago naquela operação; componente ainda não pago não gera cobrança nem reembolso fictício.
- A apuração usa exclusivamente a evidência financeira histórica persistida, sem reconstruir valores por configuração atual e sem converter frete desconhecido em zero.
- Motoboy não recebe compensação especial e fica livre para aceitar outra entrega disponível.

## Regra geral de retorno da mercadoria — DEFINIDO

Sempre que uma mercadoria já coletada não for entregue ao destinatário e continuar em condições de retorno, deve retornar ao estabelecimento antes do encerramento definitivo da operação ou da redisponibilização da entrega.

### Verificação dupla de devolução

- Motoboy informa que devolveu a mercadoria.
- Empresa confirma que recebeu a mercadoria.
- O sistema registra data/hora.
- Só depois disso a operação pode ser encerrada ou a entrega redisponibilizada, conforme o motivo.

---

# Confirmação da entrega por código

## Geração e acesso

- Cada entrega deve possuir um código próprio de confirmação.
- O código é gerado automaticamente pelo ERMES.
- O código deve ficar disponível ao cliente/solicitante.
- O motoboy não pode visualizar antecipadamente o código correto.
- Se o destinatário for outra pessoa, o cliente é responsável por repassar o código à pessoa autorizada.
- O código funciona como autorização de recebimento; a pessoa fisicamente presente não precisa ser necessariamente o destinatário originalmente nomeado, desde que esteja autorizada e possua o código.

## Validade

- O código é válido apenas para aquela entrega.
- Deve ser utilizável enquanto a entrega estiver aguardando confirmação.
- Após finalização/cancelamento/não realização, deixa de ter utilidade.

## Validação

- Motoboy chega ao destino e registra a chegada.
- Destinatário informa o código ao motoboy.
- Motoboy digita o código no ERMES.
- Código válido → entrega FINALIZADA.
- Código inválido → mostrar “Código inválido”.

## Limite de tentativas

- Máximo de três tentativas inválidas.
- Registrar a ocorrência e data/hora das tentativas; não é necessário preservar o código incorreto digitado.
- Após a terceira tentativa inválida, a venda/entrega não pode ser concluída.
- Não haverá método alternativo na primeira versão.
- Não há reembolso do valor dos produtos.
- Não há reembolso do frete.
- Mercadoria retorna ao estabelecimento e segue a verificação dupla de devolução.
- A distribuição interna do frete nesse cenário ainda é PENDENTE.

---

# Informações visíveis entre cliente e motoboy

## Princípio — DEFINIDO

Cada parte deve visualizar somente informações necessárias para identificação, contato e execução segura da entrega. Dados sensíveis ou desnecessários não devem ser expostos.

## Cliente pode visualizar, durante a operação

- Nome do motoboy.
- Foto, se implementada no cadastro.
- Informações do veículo relevantes à identificação.
- Placa do veículo.
- Status da entrega.
- Localização atual ou última posição conhecida do motoboy durante a operação.
- Forma de contato necessária, conforme definição final de interface.

## Motoboy pode visualizar, durante a operação

- Nome do solicitante.
- Nome do destinatário, quando diferente.
- Endereço efetivo da entrega.
- Dados de contato necessários à execução.
- Informações do pedido/entrega necessárias ao transporte.

## Não expor sem necessidade

- Senhas.
- Dados completos de pagamento.
- CPF/CNH completos ao outro usuário apenas para identificação visual.
- Dados que não tenham relação com a execução da entrega.

A visibilidade deve estar relacionada ao contexto da operação; rastreamento e dados operacionais não devem ficar disponíveis indefinidamente após o encerramento.

---

# Pagamento, reembolso e distribuição financeira

## Pagamento — DEFINIDO CONCEITUALMENTE

- O cliente paga antes da entrega.
- O sistema deve representar situação do pagamento, valores, reembolsos e distribuição financeira.
- A integração real com Pix/cartão/gateway é OPCIONAL / SE HOUVER TEMPO.
- Se a integração real não for implementada, o fluxo pode ser simulado no projeto acadêmico sem remover as regras de negócio.

## Frete normal — DEFINIDO

Em entrega concluída normalmente:

- Motoboy: 70% do valor do frete.
- Empresa: 25% do valor do frete.
- ERMES: 5% do valor do frete.

A divisão usa somente aritmética inteira. Cada parcela percentual é truncada em
centavos; os centavos restantes são atribuídos pelas maiores frações residuais.
Empates seguem a prioridade motoboy, empresa e ERMES, nessa ordem. As três
parcelas devem somar exatamente o frete preservado.

Exemplo: frete de R$ 20,00 → R$ 14,00 motoboy, R$ 5,00 empresa, R$ 1,00 ERMES.

A distribuição utilizada deve ser preservada no histórico da operação.

## Cancelamento pós-coleta pelo cliente — DEFINIDO

- Produtos: reembolso integral ao cliente.
- Frete: reembolso de 50% ao cliente.
- Motoboy: recebe 50% do frete.
- Em frete com quantidade ímpar de centavos, o cliente recebe o centavo indivisível: reembolso `ceil(frete / 2)` e remuneração do motoboy `floor(frete / 2)`.
- Após tolerância de 3 minutos: mesma regra financeira + restrição de 2 horas para novos pedidos.

## Estado e histórico financeiro — DEFINIDO

- `payment_status` representa somente o pagamento original e admite `pending` ou `paid`; um reembolso não apaga nem renomeia o pagamento histórico.
- A situação de reembolso é um eixo separado, derivado do livro-razão: `none`, `partial` ou `full` conforme o total efetivamente pago e o total reembolsado.
- O total reembolsado nunca pode superar o total efetivamente pago.
- O livro-razão é append-only: lançamentos não são atualizados nem apagados. Correções futuras devem usar lançamentos compensatórios.
- Recomposição de histórico legado só ocorre com evidência confiável e coerente de pagamento, horário, snapshots e relações. Casos incompletos ou ambíguos permanecem para reconciliação, sem valores inventados nem alteração de estado.

## Outras falhas

Os valores de reembolso ao cliente já definidos nas seções de exceção prevalecem. A distribuição interna do frete em cenários de destinatário ausente, recusa, endereço incorreto confirmado pelo cliente e três códigos inválidos ainda está PENDENTE.

---

# Administrador do ERMES

## DEFINIDO

- Existe o papel de Administrador do ERMES.
- Administradores representam a gestão da própria plataforma, não a gestão operacional de cada comércio.
- Parâmetros de frete de uma empresa devem ser administrados pela própria empresa, não pelo administrador do ERMES como atividade normal.

## PENDENTE

Ainda precisam ser definidos os casos de uso do Administrador do ERMES, por exemplo:

- gestão de empresas;
- gestão/bloqueio de usuários;
- suporte;
- consulta de operações;
- configuração global;
- tratamento de disputas;
- relatórios administrativos.

Nenhuma dessas funções deve ser assumida automaticamente como requisito obrigatório antes de decisão explícita.

---

# Promoções

## OPCIONAL / SE HOUVER TEMPO

A empresa poderá futuramente declarar promoções simples, como descontos a partir de determinada quantidade de produtos, se houver tempo de implementação.

Isto não transforma o ERMES em sistema de estoque, fidelidade ou e-commerce completo. Regras promocionais ainda não foram detalhadas e não devem ser inventadas antes de nova decisão.

---

# Modelo conceitual preliminar

Esta seção serve como orientação para futura UML/DER. Não é ainda o modelo final.

Entidades/conceitos já identificados:

- Usuário.
- Cliente.
- Empresa.
- Usuário responsável pela empresa — cardinalidade PENDENTE.
- Motoboy.
- Veículo / dados de veículo.
- Produto.
- Pedido.
- ItemPedido.
- Conversa/Chat.
- Mensagem.
- Endereço do cliente.
- Snapshot/endereço da entrega.
- Entrega.
- HistóricoEventoEntrega.
- ConfiguraçãoFreteEmpresa.
- Dados/SnapshotRota.
- CódigoConfirmação.
- Pagamento.
- Reembolso.
- DistribuiçãoFinanceira.

Relações conceituais já sustentadas pelas regras:

- Empresa cadastra produtos.
- Empresa possui/vincula motoboys.
- Cliente realiza pedidos.
- Pedido possui um ou vários ItemPedido.
- ItemPedido referencia um produto e preserva quantidade/preço do momento.
- Pedido confirmado dá origem a uma entrega quando condições necessárias estiverem satisfeitas.
- Entrega possui um endereço efetivo preservado.
- Entrega pode ser atribuída a um motoboy por vez.
- Entrega possui histórico de eventos.
- Empresa possui configuração própria de frete.

Não criar entidades de estoque, fornecedor, lote de estoque ou entrega agendada apenas porque seriam comuns em outros sistemas; estão fora do escopo atual.

---

# Requisitos funcionais consolidados — sem numeração oficial

A lista abaixo não utiliza RF01/RF02 porque a equipe ainda está organizando etapas que antecedem a numeração formal.

## Contas e acesso

- Permitir cadastro dos usuários que interagem diretamente com o ERMES.
- Permitir autenticação desses usuários.
- Restringir funcionalidades conforme o papel do usuário.

## Empresa e produtos

- Permitir cadastro de empresa.
- Permitir cadastro de produto pela empresa.
- Exigir peso unitário necessário ao cálculo de frete para disponibilização do produto.
- Permitir que a empresa altere a disponibilidade comercial do produto.
- Permitir que a empresa configure seus parâmetros tarifários de frete.

## Cliente e pedido

- Permitir consulta aos produtos disponíveis de uma empresa.
- Permitir criação de pedido com um ou vários produtos e quantidades.
- Permitir adicionar, remover e alterar itens antes da confirmação da empresa.
- Impedir alteração direta dos itens após confirmação.
- Preservar preço unitário praticado no pedido.
- Permitir comunicação por chat entre cliente e empresa.
- Disponibilizar mensagens predefinidas no chat.

## Endereço e destinatário

- Permitir cadastro de um endereço padrão do cliente.
- Permitir substituição do endereço padrão.
- Permitir uso do endereço padrão como destino.
- Permitir uso da localização atual como destino, mediante permissão.
- Permitir informar manualmente outro endereço.
- Permitir indicar destinatário diferente do solicitante.
- Permitir registrar dados necessários do destinatário.
- Apresentar ao cliente o endereço/local interpretado para confirmação/correção.
- Preservar o endereço utilizado em cada entrega independentemente de alterações futuras no cadastro.

## Frete

- Calcular peso total do pedido.
- Bloquear a conclusão da venda se o peso total exceder 12 kg.
- Obter distância e tempo estimado por serviço externo de rotas.
- Calcular frete pela fórmula definida.
- Recalcular frete quando itens/quantidades/endereço relevante mudarem.
- Utilizar frações de distância/tempo e arredondar o valor monetário final para duas casas.
- Impedir confirmação da venda quando não for possível obter cálculo confiável do frete.
- Preservar os parâmetros e valores utilizados no cálculo histórico.

## Motoboy

- Permitir cadastro/vínculo de motoboy com empresa.
- Permitir alternância online/offline.
- Permitir visualização de entregas disponíveis da empresa.
- Permitir aceite somente se online e sem entrega ativa.
- Permitir que motoboy ocupado visualize entregas, mas impeça novo aceite.
- Garantir que uma entrega seja aceita por apenas um motoboy.
- Informar tentativa de aceite de entrega já atribuída.

## Execução e rastreamento

- Iniciar execução da entrega no aceite.
- Registrar data/hora do aceite.
- Permitir registrar chegada ao ponto de coleta.
- Permitir registrar coleta/início do transporte e data/hora automática.
- Iniciar contagem de tolerância pós-coleta no momento da coleta.
- Acompanhar localização do motoboy durante entrega ativa quando tecnicamente possível.
- Permitir ao cliente visualizar posição atual/última conhecida do motoboy da sua entrega.
- Informar horário da última atualização quando a posição não for recente.
- Permitir registrar chegada ao destino.
- Manter histórico de eventos/estados.

## Cancelamentos e falhas

- Permitir cancelamento pelo cliente antes da coleta sem remuneração de frete ao motoboy.
- Permitir cancelamento pelo cliente depois da coleta, aplicando regras de reembolso e retorno.
- Aplicar tolerância de 3 minutos pós-coleta para cancelamento sem sanção adicional.
- Aplicar restrição de 2 horas a novos pedidos em cancelamento realizado após a tolerância.
- Permitir registrar impossibilidade do motoboy antes da coleta e redisponibilizar a entrega.
- Permitir registrar impossibilidade do motoboy depois da coleta e exigir retorno ao estabelecimento.
- Registrar destinatário ausente.
- Registrar recusa do destinatário.
- Registrar falha por endereço incorreto/inacessível.
- Registrar falha por produto indisponível da empresa.
- Permitir registrar retorno da mercadoria.
- Exigir confirmação da empresa sobre o recebimento da devolução.
- Redisponibilizar uma entrega após retorno confirmado quando o motivo permitir nova tentativa.

## Confirmação

- Gerar código único por entrega.
- Exibir o código ao cliente e não ao motoboy.
- Permitir que o cliente repasse o código ao destinatário autorizado.
- Permitir ao motoboy inserir o código informado no destino.
- Finalizar a entrega somente após código válido.
- Exibir mensagem de código inválido.
- Limitar a três tentativas inválidas.
- Bloquear conclusão após três tentativas inválidas.
- Encaminhar mercadoria ao fluxo de retorno quando a confirmação falhar definitivamente.

## Informações compartilhadas

- Permitir ao cliente visualizar informações necessárias do motoboy/veículo e andamento da entrega.
- Permitir ao motoboy visualizar informações necessárias do solicitante, destinatário e destino.
- Restringir dados desnecessários/sensíveis.

## Pagamento e financeiro

- Registrar pagamento antes da entrega.
- Registrar situação do pagamento.
- Registrar reembolsos conforme regras definidas.
- Registrar divisão financeira do frete.
- Aplicar divisão normal de 70% motoboy, 25% empresa e 5% ERMES em entrega concluída normalmente.
- Aplicar regra de 50% do frete ao motoboy em cancelamento pelo cliente após a coleta.
- Permitir integração real com gateway se houver tempo, sem torná-la obrigatória ao núcleo.

---

# Requisitos não funcionais e restrições implícitas a formalizar

Estes pontos surgiram das decisões, mas ainda não passaram pela etapa formal de RNF e não recebem numeração oficial.

- **Responsividade:** aplicação web deve ser utilizável em celular e computador.
- **Segurança de acesso:** funcionalidades e dados devem respeitar autenticação e papel do usuário.
- **Privacidade:** localização do motoboy só deve ser compartilhada no contexto da entrega ativa e com o cliente associado.
- **Minimização de dados:** usuários devem ver somente dados pessoais necessários à operação.
- **Consistência/concor­rência:** duas aceitações simultâneas não podem atribuir a mesma entrega a dois motoboys.
- **Integridade histórica:** alterações de cadastro/configurações atuais não podem reescrever pedidos, endereços, fretes ou distribuições financeiras antigas.
- **Auditabilidade:** estados, eventos e horários críticos devem ser preservados.
- **Precisão monetária:** cálculos devem preservar precisão interna e arredondar o total monetário final para duas casas decimais.
- **Dependência externa:** falha no serviço de rotas não deve produzir valor de frete inventado.
- **Limitação web de geolocalização:** não prometer rastreamento contínuo quando o navegador não puder executar/fornecer posição.
- **Transporte seguro:** comunicação com APIs de geolocalização requer ambiente web seguro quando aplicável.

---

# Decisões pendentes

Estas decisões NÃO devem ser inventadas por outra conversa, Codex ou desenvolvedor.

- Quantos usuários uma empresa pode possuir na primeira versão: apenas um responsável ou múltiplos usuários.
- Casos de uso e permissões específicas do Administrador do ERMES.
- Distribuição interna do frete nos casos em que o cliente não recebe reembolso por destinatário ausente, recusa, endereço incorreto confirmado pelo cliente ou três códigos inválidos.
- Valores e política exata de reembolso quando a falha for comprovadamente causada pelo ERMES/serviço interno de endereço/rota.
- Detalhamento da interface de tentativa de contato quando destinatário está ausente ou endereço apresenta problema.
- Campos definitivos obrigatórios do destinatário além do nome/endereço, como telefone.
- Regras detalhadas de promoção, caso a funcionalidade opcional seja implementada.
- Integração real de pagamento: provedor, meios aceitos e fluxo técnico.
- Refinamento final dos nomes de estados e dos estados terminais na UML.

---

# Guardrails de implementação

Outra conversa, IA ou Codex deve obedecer às seguintes restrições:

- Não criar motoboy autônomo.
- Não criar entrega agendada.
- Não permitir mais de uma entrega ativa por motoboy.
- Não criar sistema completo de estoque.
- Não alterar retroativamente pedidos/fretes antigos quando configuração atual mudar.
- Não usar localização do motoboy para determinar o valor do frete; o frete usa rota estabelecimento → destino.
- Não usar tempo real gasto pelo motoboy para recalcular preço já aceito.
- Não permitir venda com peso total acima de 12 kg.
- Não finalizar entrega sem código válido.
- Não oferecer método alternativo de confirmação sem nova decisão.
- Não esconder conflitos entre código existente e esta especificação; reportar e corrigir conforme a baseline.
- Não inventar decisões marcadas como PENDENTE.
- Funcionalidades OPCIONAIS não podem se tornar dependências do núcleo obrigatório.
- Não remover requisitos “óbvios” sem análise de impacto sobre regras, estados, fluxos, entidades e testes dependentes.
- Toda alteração de requisito deve considerar rastreabilidade e consequências sobre requisitos derivados.

---

# Instruções de handoff para outra conversa / Codex

Use este documento como fonte de verdade provisória do projeto ERMES.

Ao receber uma solicitação de implementação:

1. Identifique quais regras desta baseline são afetadas.
2. Preserve as decisões marcadas como DEFINIDO.
3. Não implemente automaticamente o que está PENDENTE, FORA DO ESCOPO ou apenas OPCIONAL.
4. Se o código atual contrariar a baseline, explique o conflito e adapte o código à regra vigente, salvo instrução posterior do responsável pelo projeto.
5. Se uma mudança solicitada exigir alterar uma regra existente, faça análise de impacto antes de remover ou substituir requisitos derivados.
6. Preserve histórico operacional e financeiro quando dados atuais mudarem.
7. Mantenha as decisões de domínio separadas das escolhas tecnológicas: por exemplo, “calcular rota” é requisito; Google Maps é apenas uma possível implementação.
8. Antes de criar novas entidades/funcionalidades, verifique se pertencem ao escopo do ERMES.
9. Quando houver decisão não coberta por este documento, marque-a como lacuna e solicite definição ao responsável em vez de inventar uma regra de negócio.

Prompt curto recomendado para anexar a esta baseline em outra conversa:

> Este documento é a baseline vigente do projeto ERMES. Trate-o como fonte de verdade para regras de negócio, escopo e requisitos já decididos. Não invente decisões marcadas como pendentes e não implemente funcionalidades fora do escopo sem autorização. Ao alterar código existente, faça análise de impacto e preserve as regras históricas e financeiras descritas aqui.

---

# Próximas etapas da documentação

O levantamento de negócio avançou bastante, mas a documentação final ainda precisa continuar na seguinte direção:

- Refinar stakeholders e atores.
- Definir o modelo de usuários da empresa.
- Definir funções do Administrador do ERMES.
- Formalizar e numerar regras de negócio.
- Formalizar e numerar requisitos funcionais.
- Levantar e formalizar requisitos não funcionais.
- Criar casos de uso.
- Elaborar diagramas UML adequados: casos de uso, atividades, estados, classes, sequência e outros que se mostrarem necessários.
- Modelar banco de dados: conceitual, lógico e físico.
- Definir arquitetura da aplicação e tecnologias.
- Especificar APIs e integrações externas.
- Planejar casos de teste e rastreabilidade requisito → caso de uso → modelo → teste.

---

# Registro da baseline

**Versão:** 0.1  
**Data:** 13/09/2026  
**Natureza:** consolidação de levantamento e decisões; ainda não representa a versão 1.0 da documentação.  
**Regra de manutenção:** futuras decisões devem atualizar esta baseline, substituindo explicitamente regras antigas e registrando impacto sobre requisitos dependentes.
