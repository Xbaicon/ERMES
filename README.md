# ERMES — fundação executável

Versão inicial do ERMES preparada a partir da **Baseline 0.1**, do protótipo HTML/CSS/JavaScript recebido e das decisões consolidadas em 13 de setembro de 2026.

O objetivo deste pacote é oferecer uma base segura para a equipe continuar o desenvolvimento com o Codex sem transformar pendências de negócio em decisões automáticas.

## Requisitos

- Node.js 22.13 ou superior.
- VS Code recomendado.
- Extensão do Codex opcional para desenvolvimento em equipe.

O projeto não possui dependências externas. Não é necessário executar `npm install`.

## Executar

Abra o terminal na pasta do projeto e execute:

```bash
npm start
```

Depois acesse:

```text
http://localhost:3000
```

Para reinício automático durante o desenvolvimento:

```bash
npm run dev
```

## Acesso demonstrativo

Ao executar em modo de desenvolvimento, o banco recebe uma empresa de demonstração:

```text
E-mail: empresa@ermes.local
Senha: Ermes123!
```

## Verificação

```bash
npm run check
npm test
```

## Estrutura

```text
ERMES/
├── AGENTS.md
├── docs/
│   ├── ERMES_Baseline_0.1.md
│   ├── ERMES_Especificacao_Consolidada_Baseline_0.1.docx
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── IMPLEMENTATION_STATUS.md
├── public/
│   ├── assets/
│   ├── css/
│   ├── js/
│   ├── pages/
│   └── index.html
├── src/
│   ├── database.js
│   ├── freight.js
│   ├── security.js
│   ├── server.js
│   └── validation.js
├── tests/
└── data/
```

## Uso com o Codex

1. Abra esta pasta inteira no VS Code.
2. Instale e abra a extensão do Codex.
3. Inicie uma nova conversa dentro do repositório.
4. Peça: `Resuma as instruções e o estado atual do ERMES antes de alterar qualquer arquivo.`

O Codex localizará `AGENTS.md`, que o direcionará à baseline e ao estado de implementação.

## Importante

Esta versão é uma **fundação de desenvolvimento**, não um sistema pronto para produção. Pagamentos reais, geocodificação/rotas, pedidos completos, rastreamento e os fluxos finais de entrega ainda exigem implementação e decisões registradas em `docs/IMPLEMENTATION_STATUS.md`.
