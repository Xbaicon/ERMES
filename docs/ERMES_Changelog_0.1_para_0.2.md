# ERMES — Changelog da Baseline 0.1 para a Baseline 0.2

**Data:** 24/09/2026  
**Objetivo:** registrar somente diferenças relevantes para implementação, testes e documentação.

## 1. Resumo executivo

A Baseline 0.2 refina principalmente o ciclo logístico do ERMES. O maior acréscimo conceitual é `TentativaEntrega`, que passa a existir somente após a coleta. A coleta torna-se a fronteira formal entre mera atribuição do motoboy e execução logística com custódia da mercadoria.

A 0.2 também consolida classificação de ocorrências, retorno da mercadoria, revalidação, regras de endereço, falhas do sistema, indisponibilidade de produto, novos estados de Pedido e revisão de consequências financeiras.

## 2. ADICIONADO

- `TentativaEntrega` como conceito separado de `Entrega`.
- Regra de criação da tentativa somente na coleta.
- Numeração de tentativas por novas coletas da mesma Entrega após falha recuperável.
- `OcorrenciaEntrega` com classificação de responsabilidade.
- Responsabilidades: CLIENTE, EMPRESA, MOTOBOY, SISTEMA e INDEFINIDO.
- Estado `AGUARDANDO_REVALIDACAO` em Entrega.
- Estados `CONCLUIDO` e `ENCERRADO` em Pedido.
- Distinção formal entre status global de Entrega e status/resultado de TentativaEntrega.
- Fluxo de impedimento externo com revalidação pela empresa.
- Fluxo de erro do ERMES no endereço, distinguindo erro pontual corrigível de erro persistente/incerto.
- Ajuste excepcional por produto/serviço indisponível proposto pela empresa e condicionado ao aceite do cliente.
- Regra de diferença de preço em substituição.
- Múltiplos usuários internos por empresa, com perfis iniciais RESPONSAVEL e ATENDENTE.

## 3. ALTERADO

### 3.1 Falha mecânica antes da coleta

**Antes:** tratada como falha da execução, com histórico do motoboy.  
**Agora:** não cria TentativaEntrega; desfaz atribuição e redisponibiliza a mesma Entrega.

### 3.2 Falha mecânica depois da coleta

**Agora:** a tentativa fica interrompida; o retorno da mercadoria é responsabilidade operacional da empresa nesta baseline; somente após retorno confirmado a tentativa é encerrada e a Entrega pode ser redisponibilizada.

### 3.3 Código de confirmação

**Agora:** o código pertence à Entrega e permanece em novas tentativas da mesma Entrega. O contador de validações inválidas pertence à TentativaEntrega e zera em nova tentativa.

### 3.4 Três validações inválidas

**Antes:** consequência financeira era tratada de forma uniforme e podia implicar culpa do cliente.  
**Agora:** não se presume responsabilidade do cliente. Classificar CLIENTE, MOTOBOY, SISTEMA ou INDEFINIDO. Produtos são reembolsados em todos os casos; frete só é cobrado do cliente quando a classificação for CLIENTE.

### 3.5 Destinatário ausente e recusa

**Antes:** havia regra de ausência de reembolso dos produtos.  
**Agora:** produtos são reembolsados integralmente; frete permanece cobrado e segue divisão 70/25/5.

### 3.6 Endereço incorreto do cliente

**Agora:** é ocorrência terminal; produtos reembolsados; frete mantido em 70/25/5; não há nova tentativa na mesma Entrega; endereço corrigido exige novo Pedido.

### 3.7 Cancelamento pós-coleta

Mantém-se a regra financeira de produtos 100% reembolsados + 50% do frete devolvido ao cliente + 50% do frete ao motoboy. A regra temporal de 3 minutos e a suspensão de 2 horas deixam de ser aplicadas nesta baseline.

### 3.8 Produto indisponível

Agora a empresa pode propor ajuste antes da coleta. O cliente deve aceitar explicitamente. Se não aceitar, Entrega CANCELADA, Pedido ENCERRADO, responsabilidade EMPRESA e reembolso integral.

## 4. REMOVIDO / ADIADO DA 0.2

- Tolerância fixa de 3 minutos para cancelamento pós-coleta.
- Suspensão automática de 2 horas baseada no momento do cancelamento.
- Regra proporcional de 30% do tempo estimado, que foi discutida e deliberadamente adiada.
- Operação de recuperação por outro motoboy dentro do ERMES.
- Alteração voluntária de pedido confirmado iniciada pelo cliente.
- Avaliações/comentários de empresa.

## 5. CORREÇÃO DE ESCOPO HERDADO DA DOCUMENTAÇÃO 0.1

A documentação 0.1 anterior descrevia geocodificação, integração real de rotas e obtenção automática de distância/tempo como parte obrigatória da primeira versão. O entendimento posterior consolidado é que essas capacidades são evolução futura e **não devem ser introduzidas como requisito obrigatório da implementação atual apenas por estarem descritas no documento antigo**.

A fórmula/ideia de frete pode preservar seus parâmetros de negócio, mas a escolha e integração de provedor real de mapas/rotas permanece fora da 0.2 até decisão específica.

## 6. IMPACTO ESPERADO NO MODELO

Possíveis novos/alterados elementos:

- Entidade `TentativaEntrega`.
- Entidade/conceito `OcorrenciaEntrega`.
- Novos enums/status de Pedido, Entrega e Tentativa.
- Campos de motivo/natureza/classificação de encerramento.
- Associação Entrega 1 → 0..* TentativaEntrega.
- Associação Motoboy 1 → 0..* TentativaEntrega.
- Código mantido em Entrega.
- Contador de validações inválidas em TentativaEntrega.
- Preservação de dados de endereço em ocorrências de falha do sistema.

A estrutura exata do banco deve ser definida após auditoria do modelo existente; não criar migrações cegamente sem verificar entidades/tabelas atuais.

## 7. IMPACTO ESPERADO NOS TESTES

Adicionar/ajustar testes para, no mínimo:

- aceite pré-coleta sem criação de tentativa;
- criação da primeira tentativa na coleta;
- falha pré-coleta e redisponibilização;
- falha pós-coleta, retorno e segunda tentativa;
- código persistente entre tentativas;
- contador de códigos zerado em nova tentativa;
- 3 códigos inválidos por classificação de responsabilidade;
- ausência/recusa com reembolso de produtos e retenção do frete;
- endereço incorreto terminal;
- impedimento externo + AGUARDANDO_REVALIDACAO;
- erro do sistema corrigível e persistente;
- ajuste de produto indisponível com e sem aceite;
- novos estados CONCLUIDO/ENCERRADO/CANCELADO.
