# Correção vigente de escopo — Baseline 0.1

**Status:** decisão canônica vigente para interpretação de escopo.  
**Data:** 29/09/2026.

## Autoridade e preservação histórica

Este documento corrige a interpretação vigente de escopo da Baseline 0.1. Ele prevalece quando entrar em conflito com trechos históricos de `ERMES_Baseline_0.1.md` ou de `ERMES_Especificacao_Consolidada_Baseline_0.1.docx` sobre geocodificação, rotas, localização e rastreamento geográfico.

Os dois documentos históricos não são reescritos: permanecem como registro do levantamento de 13/09/2026. Em especial, continuam neles referências a uso de localização atual, serviço de geocodificação/rotas, confirmação visual do endereço, posição do motoboy e serviço de rotas. Essas referências não definem mais requisitos bloqueadores da Baseline 0.1.

## Acompanhamento operacional da entrega — obrigatório

O acompanhamento operacional permanece dentro do escopo obrigatório da Baseline 0.1. Ele abrange os estados e eventos da entrega, aceite, chegada ao ponto de coleta, coleta, transporte, chegada ao destino, confirmação de recebimento, cancelamentos, retornos e demais ocorrências operacionais.

Esse acompanhamento registra a evolução da operação e seu histórico; ele não depende de GPS, coordenadas ou mapa para existir.

## Rastreamento geográfico — opcional/futuro e não bloqueador

GPS, coordenadas, posição atual, última posição conhecida, histórico de posições, mapa em tempo real e snapshots originados de um provedor externo de rota são **OPCIONAL/FUTURO**. Eles não bloqueiam a implementação nem a conclusão da Baseline 0.1.

Pela mesma razão, não são pré-requisitos bloqueadores da Baseline 0.1:

- geocodificação;
- provedor real de rotas;
- mapas ou confirmação visual do endereço;
- localização atual do navegador como destino; e
- coordenadas atuais ou históricas do motoboy ou do cliente.

## Frete operacional final — parcial e pendente de clarificação

A fórmula tarifária, as faixas de peso, os valores por quilômetro e por minuto, os valores em centavos, o limite de 12 kg e os snapshots comerciais/históricos continuam pertencendo ao domínio da Baseline 0.1.

Porém, a fonte operacional de distância e tempo ainda não foi definida. Assim, o frete operacional final está **PARCIAL / PENDENTE DE CLARIFICAÇÃO**. Essa lacuna não autoriza escolher, inventar ou implementar um provedor externo, API de rotas, geocodificação, distância fixa, tempo fixo, entrada manual, simulação ou qualquer solução substituta.

Entradas técnicas existentes para exercitar a fórmula não definem uma fonte operacional e não podem ser promovidas a fluxo de cliente. A ausência dessa fonte deve ser registrada como pendência de decisão explícita, não como motivo para antecipar integração geográfica ou bloquear os demais fluxos da Baseline.

## Pagamento e financeiro

Pagamento como conceito, estados financeiros, reembolsos, distribuição financeira e seus snapshots permanecem no escopo da Baseline 0.1. A integração real com gateway continua **OPCIONAL/FUTURA**; sua ausência não elimina as regras de domínio financeiro.

## Aplicação nos documentos operacionais

`AGENTS.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_STATUS.md` e `API.md` devem referenciar esta correção ao descrever limites, pendências e contratos técnicos. Eles não devem reintroduzir geocodificação, rotas reais ou rastreamento geográfico como dependências obrigatórias.
