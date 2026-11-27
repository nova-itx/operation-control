// Importa a cópia dos dados exportada do claude.ai para o Supabase.
// Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/importar.mjs caminho/dados-novaitx-AAAA-MM-DD.json
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const arq = process.argv[2];
if (!arq) { console.error('Informe o arquivo JSON exportado.'); process.exit(1); }
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { colecoes } = JSON.parse(readFileSync(arq, 'utf8'));

// Acessos e pedidos usam os códigos de usuário do claude.ai, que não valem aqui.
// Os acessos novos vêm da tabela pre_acessos (supabase/schema.sql) no primeiro login de cada pessoa.
const PULAR = new Set(['acessos', 'solicitacoes']);
let total = 0;
for (const [col, docs] of Object.entries(colecoes)) {
  if (PULAR.has(col) || !docs || docs._erro) continue;
  const linhas = Object.entries(docs).map(([id, data]) => ({ collection: col, id, data }));
  for (let i = 0; i < linhas.length; i += 200) {
    const { error } = await sb.from('docs').upsert(linhas.slice(i, i + 200));
    if (error) { console.error(`Erro em ${col}:`, error.message); process.exit(1); }
  }
  total += linhas.length;
  console.log(`${col}: ${linhas.length}`);
}
console.log(`Pronto: ${total} registros importados.`);
