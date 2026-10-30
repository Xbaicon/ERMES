# ERMES — projeto em transição para a Baseline 0.2

A implementação estável da **Baseline 0.1** está congelada na tag
`baseline-0.1`. A **Baseline 0.2** é a baseline ativa de desenvolvimento; o
código permanece no estado 0.1 até a auditoria técnica de migração e as etapas
de implementação posteriores.

O objetivo deste repositório é oferecer uma base segura para a equipe continuar o desenvolvimento com o Codex sem transformar especificações ainda não implementadas ou pendências de negócio em decisões automáticas.

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
│   ├── ERMES_Baseline_0.2.md
│   ├── ERMES_Changelog_0.1_para_0.2.md
│   ├── ERMES_Especificacao_Consolidada_Baseline_0.2.docx
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

O Codex localizará `AGENTS.md`, que o direcionará à baseline ativa, ao delta
0.1 → 0.2 e ao estado efetivamente implementado.

## Importante

Esta versão é uma **fundação de desenvolvimento**, não um sistema pronto para
produção. O estado efetivo do código está em `docs/IMPLEMENTATION_STATUS.md`.
Use `docs/ERMES_Baseline_0.2.md` como referência funcional ativa e
`docs/ERMES_Changelog_0.1_para_0.2.md` para o delta; preserve os documentos da
0.1 como histórico e referência para comportamentos não alterados.
