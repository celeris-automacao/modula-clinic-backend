# Modula Clinic — Backend (API)

API do Modula Clinic ("Smart Treatment Journey"): Express 5 + PostgreSQL
(Drizzle ORM), com Adherence Engine determinístico e insights de IA.

## Requisitos

- Node.js 24+
- pnpm 10+
- PostgreSQL

## Setup

```bash
pnpm install
cp .env.example .env   # preencha os valores
# As variáveis precisam estar no ambiente ao rodar (ex.: use direnv,
# `env $(cat .env | xargs) <comando>` ou seu gerenciador de processos).
pnpm --filter @workspace/db run push   # cria/atualiza as tabelas
pnpm --filter @workspace/api-server run dev
```

A API sobe em `http://localhost:$PORT` com rotas sob `/api`
(ex.: `GET /api/healthz`).

## Scripts

- `pnpm --filter @workspace/api-server run dev` — build (esbuild) + start
- `pnpm run typecheck` — typecheck de todos os pacotes
- `pnpm --filter @workspace/api-spec run codegen` — regenera schemas Zod a partir do OpenAPI
- `pnpm --filter @workspace/db run push` — aplica o schema Drizzle no banco

## Estrutura

- `artifacts/api-server` — servidor Express (rotas em `src/routes`, engine em `src/lib/adherence.ts`)
- `lib/api-spec` — contrato OpenAPI (fonte da verdade) + codegen
- `lib/api-zod` — schemas Zod gerados a partir do OpenAPI (validação de request/response)
- `lib/db` — schema Drizzle ORM e cliente Postgres
- `lib/integrations-openai-ai-server` — cliente OpenAI server-side (usado pelos insights de IA)

## Variáveis de ambiente

Veja `.env.example`. Os insights de IA usam um endpoint compatível com a API
da OpenAI: fora do Replit, aponte `AI_INTEGRATIONS_OPENAI_BASE_URL` para
`https://api.openai.com/v1` e use sua própria chave em
`AI_INTEGRATIONS_OPENAI_API_KEY`.

## Sincronizando o contrato OpenAPI entre os repositórios

O arquivo `lib/api-spec/openapi.yaml` é a fonte da verdade do contrato da API
e existe nos dois repositórios (backend e frontend). Após a separação:

1. Toda mudança de contrato deve ser feita primeiro no backend (openapi.yaml).
2. Copie o `openapi.yaml` atualizado para o repositório do frontend.
3. Em cada repositório, rode `pnpm --filter @workspace/api-spec run codegen`
   para regenerar os schemas Zod (backend) e os hooks React Query (frontend).
4. Faça commit do spec e do código gerado juntos.

Dica: mantenha a versão do contrato em `info.version` do openapi.yaml e trate
mudanças incompatíveis como breaking changes coordenadas entre os dois repos.
