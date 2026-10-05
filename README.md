# Atlas Catalog

Mini SaaS multi-tenant de protocolos clínicos com um agente de IA que responde perguntas de clientes consultando o catálogo real de cada empresa no MongoDB. A demo usa duas clínicas fictícias (Clínica Aurora e Instituto Horizonte), cada uma com 11 protocolos próprios (emagrecimento, saúde hormonal, nutrição, longevidade, performance). Backend em Express + TypeScript + MongoDB, frontend em React + TypeScript.

## Setup local (sem Docker) — até 5 minutos

Pré-requisitos: Node.js 20+ e um MongoDB rodando em `localhost:27017` (local ou Atlas).

```bash
npm run install:all
cp server/.env.example server/.env
```

Edite `server/.env` e preencha `GEMINI_API_KEY` com uma chave da Google Gemini — gere uma gratuitamente em https://aistudio.google.com/apikey (necessária só para o chat funcionar — ver seção abaixo). Depois:

```bash
npm run seed
npm run dev
```

Abra `http://localhost:5173`.

## Setup com Docker Compose — recomendado

Com Docker instalado, este caminho sobe **Mongo + API + frontend** com um único comando, sem precisar instalar Node ou Mongo na sua máquina.

**1. Configure as variáveis de ambiente da stack** (usadas pelo `docker-compose.yml`, raiz do projeto):

```bash
cp docker-compose.env.example .env
```

Abra o `.env` criado e preencha `GEMINI_API_KEY` — gere uma gratuitamente em https://aistudio.google.com/apikey (necessária só para o chat funcionar — veja abaixo). `JWT_SECRET` pode ficar com o valor padrão em ambiente local.

**2. Suba os três serviços:**

```bash
docker compose up --build -d
```

Isso builda duas imagens (`server` e `client`, a partir dos `Dockerfile` de cada pasta) e sobe um terceiro serviço `mongo` com a imagem oficial `mongo:7`. O compose cria uma rede interna onde os contêineres se enxergam pelo nome do serviço (`mongo`, `server`), e expõe para sua máquina:

| Serviço | Porta no host | Para que serve |
|---|---|---|
| `client` | `http://localhost:5174` | Frontend (build de produção servido via `vite preview`) |
| `server` | `http://localhost:4000` | API Express |
| `mongo` | `27017` | MongoDB (acessível também fora do Docker, se quiser inspecionar com Compass/`mongosh`) |

**3. Popule o banco com as duas empresas de demonstração:**

```bash
docker compose exec server npm run seed
```

Esse comando roda `tsx src/seed.ts` **dentro do contêiner** `server`, então ele usa a mesma `MONGODB_URI` que a API já está usando (não precisa de Mongo local).

**4. Abra `http://localhost:5174`.**

### Comandos úteis do dia a dia

```bash
docker compose logs -f server      # acompanhar logs da API em tempo real
docker compose up --build -d       # reconstruir as imagens após alterar código e subir de novo
docker compose restart server      # só reiniciar a API (ex: depois de editar o .env)
docker compose down                # parar os três serviços (mantém os dados do Mongo)
docker compose down -v             # parar e apagar também o volume do Mongo (reseed do zero)
```

O Mongo persiste os dados no volume nomeado `mongo_data`, então os produtos cadastrados sobrevivem a `docker compose down` / `up`. Só use `-v` quando quiser recomeçar do zero.

### Contas de demonstração (após rodar o seed, local ou Docker)

| Empresa | Papel | E-mail | Senha |
|---|---|---|---|
| Clínica Aurora | admin | `admin@aurora.test` | `123456` |
| Clínica Aurora | user | `user1@demo.test` | `123456` |
| Instituto Horizonte | admin | `admin@horizonte.test` | `123456` |
| Instituto Horizonte | user | `user2@demo.test` | `123456` |

Administradores criam/editam/removem protocolos; usuários comuns só visualizam o catálogo e usam o chat. Também é possível criar uma empresa nova pela tela de registro — ela nasce vazia e isolada das demais.

## O agente de IA (`POST /chat`)

O chat usa a API da Google Gemini com **tool calling** real, não um wrapper que só repassa a mensagem:

1. A mensagem do usuário é enviada ao modelo (`gemini-3.8-flash` por padrão, configurável via `GEMINI_MODEL`) junto com a declaração da ferramenta `search_products`.
2. Se o modelo decidir chamar a ferramenta (`response.functionCalls`), o servidor executa `search_products` consultando o MongoDB — **sempre filtrando por `company_id` extraído do JWT do usuário autenticado, nunca por um valor vindo do modelo**. O modelo só pode enviar `query`, `category`, `max_price`, `sort` e `quantity`; o isolamento por empresa é aplicado no servidor, fora do alcance do LLM.
3. O resultado da consulta é devolvido ao modelo como uma `functionResponse`, numa segunda chamada que formula a resposta final em português com base nos dados reais retornados.

Sem uma `GEMINI_API_KEY` configurada, `POST /chat` responde `503` com uma mensagem clara em vez de falhar silenciosamente ou simular uma resposta — a aplicação continua funcionando normalmente (login, CRUD de produtos) mesmo sem chave de IA. O motivo de escolher Gemini em vez de OpenAI/Claude foi puramente prático: a conta de testes tinha cota gratuita disponível; a troca de provedor afeta só a inicialização do client e o formato da chamada de tool calling — o contrato do endpoint (`{ message } → { reply, source }`) e a lógica de isolamento por `company_id` são os mesmos independentemente do LLM escolhido.

**Sobre o tier gratuito do Gemini:** o plano free tem limites baixos por modelo — na conta usada nos testes, 5 requisições/minuto e 20/dia para `gemini-3.8-flash` — e o modelo ocasionalmente retorna `503 UNAVAILABLE` por alta demanda ou `429 RESOURCE_EXHAUSTED` ao bater nesses limites. Por isso o servidor tenta novamente até 3 vezes com backoff curto antes de desistir — comportamento confirmado em teste manual, em que a primeira tentativa falhou por alta demanda e a segunda teve sucesso. O limite diário é baixo o bastante para esgotar durante uma sessão de testes manuais mais longa (aconteceu durante o desenvolvimento); se `POST /chat` começar a retornar erro mesmo com a chave configurada, é provável que seja isso — vale trocar `GEMINI_MODEL` por outro modelo (ex: `gemini-flash-lite-latest`, que tem cota própria) ou aguardar o reset. Isso é uma característica do tier gratuito, não um bug da integração.

## Decisões arquiteturais

- **Monorepo simples:** separa os ciclos de build do cliente e da API, mantendo o setup curto para um desafio de escopo fechado.
- **Multi-tenancy pelo contexto de autenticação:** `company_id` é assinado no JWT no login/registro e toda query de produto (`GET`, `POST`, `PUT`, `DELETE`, e a tool do chat) filtra por esse valor extraído do token — nunca por um campo enviado no corpo da requisição ou pelo LLM. Isso é o que garante que a Empresa A nunca acesse dados da Empresa B, inclusive tentando editar/deletar pelo `_id` de um produto de outra empresa (testado manualmente: retorna 404, como se o produto não existisse).
- **Tool calling real, não um prompt disfarçado:** a ferramenta `search_products` é a única via pela qual o agente acessa dados; o modelo nunca recebe o catálogo inteiro no prompt nem pode especificar `company_id`.
- **Domínio clínico responsável:** os itens são protocolos/serviços, com objetivo, profissional responsável e duração. O prompt do sistema instrui o agente a responder apenas com base no retorno da ferramenta (sem inventar produto, preço ou disponibilidade) e a não fazer diagnóstico — para decisões individuais, o usuário é direcionado a uma avaliação profissional.
- **Mongoose + Zod:** schema de persistência e validação de entrada ficam explícitos e próximos da rota, para o código do desafio permanecer fácil de ler em um único arquivo por domínio.
- **Preço com moeda (BRL/USD/EUR):** cada produto tem um campo `currency` (padrão `BRL`), validado por `zod` e persistido no Mongo. O frontend formata o preço com `Intl.NumberFormat` por moeda, e o prompt do agente de IA instrui o modelo a sempre citar o símbolo correto do item retornado pela ferramenta — nunca assumir reais por padrão.

## O que eu faria diferente em produção

- **Segurança:** refresh tokens rotativos em cookie HttpOnly (hoje o JWT vive 7 dias em localStorage), rate limiting (em especial no `/chat`, por causa do custo/cota de cada chamada ao LLM), validação de upload de imagem se isso virasse upload de arquivo em vez de URL.
- **Multi-tenant em escala:** índice composto `{ company_id, createdAt }` (e outros por padrão de consulta) em vez de índice simples; considerar banco/schema por tenant se o número de empresas grandes crescer muito.
- **Observabilidade:** logs estruturados com correlação por request, tracing, métricas de latência/custo por chamada ao LLM (tokens, tempo de resposta, taxa de fallback para o 503).
- **Confiabilidade do agente:** já existe retry com backoff para erros transitórios (503 por alta demanda, 429 por limite de taxa — ver seção abaixo); eu evoluiria isso para fila com dead-letter, cache de respostas para perguntas repetidas e limite de histórico de conversa (hoje cada chamada é stateless, sem memória entre mensagens).
- **Dados:** paginação em `/products`, soft delete em vez de remoção definitiva, política de retenção para histórico de chat.

## Estrutura

- `server/src/index.ts`: API — autenticação JWT, autorização por papel, CRUD de produtos e o agente de chat com tool calling.
- `server/src/seed.ts`: popula duas clínicas fictícias isoladas, cada uma com 11 protocolos.
- `client/src`: dashboard responsivo (listagem/CRUD de produtos) e tela de chat.
- `docker-compose.yml`: orquestra `mongo` + `server` + `client` para rodar tudo com um comando.
