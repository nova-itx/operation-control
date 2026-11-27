# Gestão de Prestadores Nova ITX

Sistema de clientes, contratos, vagas, prestadores, Lançamento Mensal, Lançamento Fiscal, relatórios, acessos e auditoria.
Roda na **Vercel**, com banco e login no **Supabase** e entrada pela **conta Microsoft** da Nova ITX.

## Como o projeto está organizado

| Pasta / arquivo | O que é |
|---|---|
| `public/index.html` | O sistema (o mesmo do claude.ai, com os textos de acesso ajustados) |
| `public/shim.js` | Adaptador que liga o sistema ao Supabase (dados em tempo real, login, downloads) |
| `public/brand/` | Logo, ícone e capa |
| `api/config.js` | Entrega ao navegador o endereço do Supabase e a chave pública |
| `api/mercado.js` | Atualização diária da tabela de salários de mercado (rotina da Vercel + API do Claude) |
| `supabase/schema.sql` | Tabelas, regras de acesso por perfil e acessos iniciais |
| `scripts/importar.mjs` | Importa a cópia dos dados exportada do claude.ai |
| `vercel.json` | Rotina diária (7h de Brasília) e limites das funções |

## Passo a passo para colocar no ar

### 1. Supabase
1. Crie um projeto em [supabase.com](https://supabase.com) (região **South America (São Paulo)**).
2. Abra **SQL Editor > New query**, cole todo o `supabase/schema.sql` e clique em **Run**.
3. Em **Project Settings > API**, anote: **Project URL**, **anon public key** e **service_role key** (essa é secreta).

### 2. Login com Microsoft (Microsoft Entra ID)
Quem administra o Microsoft 365 da Nova ITX faz este passo:
1. Em [entra.microsoft.com](https://entra.microsoft.com): **Identity > Applications > App registrations > New registration**.
2. Nome: `Gestão de Prestadores`. Tipo de conta: **Accounts in this organizational directory only**.
3. Redirect URI (Web): `https://SEU-PROJETO.supabase.co/auth/v1/callback`.
4. Depois de criar, anote o **Application (client) ID** e o **Directory (tenant) ID**.
5. Em **Certificates & secrets > New client secret**, crie e anote o **Value**.
6. No Supabase: **Authentication > Sign In / Providers > Azure**: ative, cole Client ID e Secret, e em **Azure Tenant URL** coloque `https://login.microsoftonline.com/TENANT_ID`.
7. No Supabase: **Authentication > URL Configuration**: em **Site URL** coloque o endereço da Vercel (ex.: `https://operation-control.vercel.app`) e adicione o mesmo em **Redirect URLs**.

### 3. Vercel
1. Em [vercel.com](https://vercel.com), **Add New > Project**, importe `Nova-Itx/operation-control`. Framework: **Other**.
2. Em **Environment Variables**, cadastre (veja `.env.example`):
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ANTHROPIC_API_KEY` (crie em [console.anthropic.com](https://console.anthropic.com))
   - `ANTHROPIC_MODEL` (opcional, padrão `claude-sonnet-5-5`)
   - `CRON_SECRET` (uma senha longa qualquer; a Vercel usa para chamar a rotina diária)
3. Clique em **Deploy**.

### 4. Importar os dados atuais
Num computador com Node 20+:
```bash
npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run importar -- caminho/dados-novaitx-2026-11-27.json
```
O arquivo de dados **não vai para o GitHub** (está no `.gitignore`): tem salários e dados fiscais.

### 5. Primeiro acesso
Os acessos iniciais estão em `supabase/schema.sql` (tabela `pre_acessos`). No primeiro login com Microsoft, cada pessoa recebe o perfil cadastrado:

| E-mail | Perfil |
|---|---|
| vanessa@novaitx.com | Administrador (dona do sistema) |
| claudia.miranda@novaitx.com.br | Operador |
| fernanda.sales@novaitx.com.br | Financeiro |
| marcos.miranda@novaitx.com.br | Diretoria |

Novas pessoas: use **Acessos > Convidar por e-mail** ou libere em **Pedidos de acesso**.

## Segurança
- Só quem tem perfil lê os dados. A **Diretoria** só consulta. Só **Administradores** mudam acessos, perfis, convites e pedidos. Isso é garantido no banco (regras RLS), não só na tela.
- As demais permissões (ver valores, editar salários, fechar mês etc.) continuam controladas pela tela, como no sistema original. Próximo passo recomendado: separar salários e dados de pagamento numa tabela própria, com leitura bloqueada no banco para quem não pode ver valores.

## Atualização diária da tabela de mercado
A rotina roda todo dia às 7h (Brasília), pesquisa as fontes públicas com o Claude (API da Anthropic, com busca na web) e grava as faixas. O botão **Atualizar Dados** (Configurações > Parâmetros de contratação) dispara a mesma rotina na hora. Cargos marcados como edição manual não são sobrescritos. O custo é por uso da API da Anthropic.
