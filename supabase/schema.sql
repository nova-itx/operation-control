-- Gestão de Prestadores Nova ITX: estrutura do banco no Supabase.
-- Rode este arquivo inteiro uma vez, no Supabase: SQL Editor > New query > colar > Run.

-- 1. Tabela única de documentos (mesmo formato do sistema original: coleção + id + dados)
create table if not exists public.docs (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.docs replica identity full;

create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.docs_touch();

-- 2. Usuários (nome e e-mail de quem já entrou, para a tela de Acessos)
create table if not exists public.usuarios (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nome text,
  atualizado_em timestamptz default now()
);

-- 3. Acessos pré-cadastrados por e-mail (liberados no primeiro login)
create table if not exists public.pre_acessos (
  email text primary key,
  perfil text not null check (perfil in ('admin','diretoria','financeiro','operador')),
  dono boolean not null default false
);

insert into public.pre_acessos (email, perfil, dono) values
  ('vanessa@novaitx.com.br', 'admin', true),
  ('claudia.miranda@novaitx.com.br', 'operador', false),
  ('fernanda.sales@novaitx.com.br', 'financeiro', false),
  ('marcos.miranda@novaitx.com.br', 'diretoria', false)
on conflict (email) do update set perfil = excluded.perfil, dono = excluded.dono;

-- 4. Funções de permissão
create or replace function public.meu_perfil() returns text
language sql stable security definer set search_path = public as $$
  select data->>'perfil' from public.docs
  where collection = 'acessos' and id = auth.uid()::text
$$;

create or replace function public.pode_ler(c text, i text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when c = 'acessos' and i = auth.uid()::text then true
    when c = 'solicitacoes' then i = auth.uid()::text or public.meu_perfil() = 'admin'
    when c = 'convites' then public.meu_perfil() = 'admin'
    else public.meu_perfil() is not null
  end
$$;

create or replace function public.pode_escrever(c text, i text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when c in ('acessos','perfis','convites') then public.meu_perfil() = 'admin'
    when c = 'solicitacoes' then i = auth.uid()::text or public.meu_perfil() = 'admin'
    when c = 'mercado' or (c = 'config' and i = 'mercado') then public.meu_perfil() = 'admin'
    else public.meu_perfil() in ('admin','financeiro','operador')
  end
$$;

-- 5. Regras de acesso (RLS)
alter table public.docs enable row level security;
drop policy if exists docs_ler on public.docs;
drop policy if exists docs_inserir on public.docs;
drop policy if exists docs_alterar on public.docs;
drop policy if exists docs_excluir on public.docs;
create policy docs_ler on public.docs for select to authenticated using (public.pode_ler(collection, id));
create policy docs_inserir on public.docs for insert to authenticated with check (public.pode_escrever(collection, id));
create policy docs_alterar on public.docs for update to authenticated using (public.pode_escrever(collection, id)) with check (public.pode_escrever(collection, id));
create policy docs_excluir on public.docs for delete to authenticated using (public.pode_escrever(collection, id));

alter table public.usuarios enable row level security;
drop policy if exists usuarios_ler on public.usuarios;
create policy usuarios_ler on public.usuarios for select to authenticated using (id = auth.uid() or public.meu_perfil() is not null);

alter table public.pre_acessos enable row level security;

-- Permissões de tabela (as regras RLS acima decidem linha a linha)
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.docs to authenticated;
grant select on table public.usuarios to authenticated;
revoke all on table public.docs from anon;
revoke all on table public.usuarios from anon;
revoke all on table public.pre_acessos from anon, authenticated; -- sem políticas: só o servidor lê

-- 6. Chamado pelo sistema a cada login: registra o usuário e libera o acesso pré-cadastrado
create or replace function public.entrar() returns json
language plpgsql security definer set search_path = public as $$
declare u record; p record; c record;
begin
  select id, lower(email) as email,
         coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '') as nome
    into u from auth.users where id = auth.uid();
  if u.id is null then return json_build_object('ok', false); end if;
  insert into public.usuarios (id, email, nome, atualizado_em) values (u.id, u.email, u.nome, now())
    on conflict (id) do update set email = excluded.email, nome = excluded.nome, atualizado_em = now();
  select * into p from public.pre_acessos where lower(email) = u.email;
  if p.email is not null and not exists (select 1 from public.docs where collection = 'acessos' and id = u.id::text) then
    insert into public.docs (collection, id, data) values ('acessos', u.id::text,
      jsonb_build_object('perfil', p.perfil, 'desde', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'convite', p.email)
      || case when p.dono then '{"dono": true}'::jsonb else '{}'::jsonb end);
  end if;
  -- Convites feitos pela tela Acessos > Convidar por e-mail
  if not exists (select 1 from public.docs where collection = 'acessos' and id = u.id::text) then
    select id, data into c from public.docs
      where collection = 'convites' and lower(data->>'email') = u.email and data->>'aceitoEm' is null
        and data->>'perfil' in ('admin','diretoria','financeiro','operador')
      limit 1;
    if c.id is not null then
      insert into public.docs (collection, id, data) values ('acessos', u.id::text,
        jsonb_build_object('perfil', c.data->>'perfil', 'desde', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'convite', u.email, 'por', c.data->>'por'));
      update public.docs set data = data || jsonb_build_object('aceitoEm', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'usuario', u.id::text)
        where collection = 'convites' and id = c.id;
      delete from public.docs where collection = 'solicitacoes' and id = u.id::text;
    end if;
  end if;
  return json_build_object('ok', true, 'perfil', public.meu_perfil());
end $$;
revoke execute on function public.entrar() from public, anon;
grant execute on function public.entrar() to authenticated;
revoke execute on function public.meu_perfil() from public, anon;
revoke execute on function public.pode_ler(text, text) from public, anon;
revoke execute on function public.pode_escrever(text, text) from public, anon;
grant execute on function public.meu_perfil() to authenticated;
grant execute on function public.pode_ler(text, text) to authenticated;
grant execute on function public.pode_escrever(text, text) to authenticated;

-- 7. Atualização em tempo real
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

create index if not exists docs_collection on public.docs (collection);
