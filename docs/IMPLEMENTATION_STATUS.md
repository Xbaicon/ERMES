# Estado de implementação — ERMES 0.1

Atualize este documento sempre que uma funcionalidade mudar de estado.

| Área | Estado | Observação |
| --- | --- | --- |
| Página inicial responsiva | Implementado | Referências a entrega agendada removidas |
| Cadastro de cliente | Implementado inicialmente | Persistência no banco e senha com hash |
| Cadastro de empresa | Implementado inicialmente | Cria empresa e primeiro usuário responsável |
| Endereço de origem da empresa | Implementado inicialmente | Persistido como snapshot cadastral; geocodificação ainda pendente |
| Login e sessão | Implementado inicialmente | Cookie `HttpOnly`; sem autorização por token no navegador |
| Recuperação de senha | Bloqueado | Serviço de e-mail e fluxo seguro ainda não definidos |
| Produtos da empresa | Implementado inicialmente | Cadastro, peso, preço e disponibilidade |
| Motoboy vinculado à empresa | Implementado inicialmente | Criado pela área da empresa; não autônomo |
| Online/offline do motoboy | Implementado inicialmente | Persistido no banco |
| Estrutura de pedidos | Banco preparado | Interface e API completas ainda não implementadas |
| Endereço padrão do cliente | Implementado inicialmente | Consulta, cadastro e substituição isolados por sessão; sem geocodificação; snapshots de pedidos permanecem independentes |
| Itens e snapshots históricos | Banco preparado | Regras completas aguardam fluxo de pedido |
| Cálculo do frete | Regra e testes implementados | Integração com rota ainda não implementada |
| Parâmetros tarifários da empresa | Implementado inicialmente | Consulta e edição isoladas por sessão; seis tarifas monetárias persistidas em centavos; limite de 12 kg permanece fixo na aplicação |
| Geocodificação e rotas | Não implementado | Não calcular valor real sem provedor confiável |
| Pagamento | Não implementado | Integração real é opcional; simulação ainda não criada |
| Divisão 70/25/5 | Regra e testes implementados | Persistência financeira será ligada ao fluxo da entrega |
| Aceite concorrente da entrega | Banco parcialmente preparado | Índices existem; endpoint transacional ainda necessário |
| Ciclo completo da entrega | Banco preparado | Estados finais precisam de refinamento UML |
| Código de confirmação | Banco preparado | Geração, hash e limite de tentativas ainda necessários |
| Rastreamento | Não implementado | Deve respeitar entrega ativa e limitações web |
| Chat | Não implementado | Forma exata permanece pendente |
| Administrador do ERMES | Não implementado | Casos de uso e permissões permanecem pendentes |
| Promoções | Não implementado | Opcional e ainda não detalhado |

## Conflitos corrigidos no protótipo recebido

- Removidas referências visuais a entrega agendada.
- Removido o cadastro público de motoboy autônomo.
- Separado o usuário da empresa do futuro Administrador do ERMES.
- Substituída autenticação em `localStorage` por sessão no servidor.
- Descartado o `admin.js` recebido, que continha erro de sintaxe e blocos duplicados.

## Pendências que bloqueiam decisões automáticas

Consulte a seção **Decisões pendentes** da baseline antes de implementar qualquer item novo. Em especial, não presumir:

- quantidade final de usuários por empresa;
- poderes do Administrador do ERMES;
- distribuição de frete nas exceções ainda não definidas;
- política de erro interno de endereço/rota;
- interface de tentativa de contato;
- campos definitivos do destinatário;
- tecnologia do chat;
- provedor e fluxo técnico de pagamento;
- nomenclatura final dos estados UML.
