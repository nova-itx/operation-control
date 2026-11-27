// Atualização da tabela de salários de mercado (PJ).
// Roda todo dia pela rotina da Vercel (vercel.json, 7h de Brasília) e também pelo botão "Atualizar Dados".
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

const admin = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // data de Brasília
const slug = s => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function autorizado(req, sb) {
  const h = req.headers.authorization || '';
  if (process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`) return true;
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return false;
  const { data } = await sb.from('docs').select('data').eq('collection', 'acessos').eq('id', user.id).maybeSingle();
  return !!(data && data.data && (data.data.dono || data.data.perfil === 'admin'));
}

async function getDoc(sb, col, id) {
  const { data } = await sb.from('docs').select('data').eq('collection', col).eq('id', id).maybeSingle();
  return data ? data.data : null;
}

async function perguntarAoClaude(prompt) {
  const messages = [{ role: 'user', content: prompt }];
  for (let rodada = 0; rodada < 6; rodada++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 16000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
        messages
      })
    });
    if (!r.ok) throw new Error('API da Anthropic: ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const resp = await r.json();
    if (resp.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: resp.content }); continue; }
    const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = texto.match(/```json\s*([\s\S]*?)```/) || texto.match(/(\{[\s\S]*\})/);
    if (!m) throw new Error('A resposta não trouxe o JSON esperado.');
    return JSON.parse(m[1]);
  }
  throw new Error('A pesquisa não terminou.');
}

async function atualizar(sb) {
  const listas = await getDoc(sb, 'config', 'listas') || {};
  const info = await getDoc(sb, 'config', 'mercado') || {};
  const { data: linhas } = await sb.from('docs').select('id,data').eq('collection', 'mercado');
  const atuais = (linhas || []).map(r => ({ id: r.id, ...r.data }));
  const cargos = listas.cargos || atuais.map(x => x.cargo);
  const sens = listas.senioridades || ['Estagiário', 'Trainee', 'Júnior', 'Pleno', 'Sênior', 'Especialista'];

  const prompt = `Você mantém a tabela de salários de mercado PJ (mensal, em reais) usada por uma consultoria de software brasileira (${info.perfil || 'consultoria de software, remoto, projetos nacionais'}).
Hoje é ${hoje()}. Pesquise na web as fontes públicas mais recentes e atualize as faixas.

Metodologia (siga exatamente):
${info.metodologia || ''}

Cargos: ${JSON.stringify(cargos)}
Senioridades: ${JSON.stringify(sens)}
Áreas válidas: ${JSON.stringify(listas.areas || [])}
Tabela atual: ${JSON.stringify(atuais.map(x => ({ cargo: x.cargo, area: x.area, faixas: x.faixas, fonte: x.fonte })))}

Responda SOMENTE com um bloco \`\`\`json no formato:
{"resumo":"o que mudou desde a tabela atual, em 1 a 3 frases, em português, sem travessões",
 "fontes":[{"nome":"...","url":"https://...","data":"consultada em DD/MM/AAAA"}],
 "linhas":[{"cargo":"...","area":"...","fonte":"...","links":[{"nome":"...","url":"https://..."}],"faixas":{"Júnior":{"min":0,"max":0}}}]}
Inclua todos os cargos. Omita senioridades que não se aplicam ao cargo. Valores arredondados para centenas. Se nada mudou nas fontes, repita os valores atuais e diga isso no resumo.`;

  const res = await perguntarAoClaude(prompt);
  if (!Array.isArray(res.linhas) || !res.linhas.length) throw new Error('Nenhuma linha recebida.');
  const dia = hoje();
  const manuais = new Set(atuais.filter(x => x.origem === 'manual').map(x => x.cargo));
  const ups = [];
  for (const l of res.linhas) {
    if (!l || !l.cargo || manuais.has(l.cargo)) continue;
    const faixas = {};
    for (const [s, f] of Object.entries(l.faixas || {})) {
      const min = Math.round(+f.min), max = Math.round(+f.max);
      if (sens.includes(s) && min > 0 && max >= min) faixas[s] = { min, max };
    }
    if (!Object.keys(faixas).length) continue;
    const links = (l.links || []).filter(x => x && /^https:\/\//.test(x.url)).slice(0, 4);
    const ex = atuais.find(x => x.cargo === l.cargo);
    ups.push({ collection: 'mercado', id: ex ? ex.id : 'mk-' + slug(l.cargo), data: { area: l.area || (ex && ex.area) || '', cargo: l.cargo, faixas, fonte: String(l.fonte || '').slice(0, 200), links, origem: 'pesquisa', atualizado: dia } });
  }
  if (ups.length) { const { error } = await sb.from('docs').upsert(ups); if (error) throw error; }
  const novoInfo = Object.assign({}, info, {
    atualizadoEm: dia, concluidoEm: new Date().toISOString(),
    fontes: (res.fontes || []).filter(x => x && /^https:\/\//.test(x.url)).slice(0, 12),
    resumo: String(res.resumo || '').slice(0, 800),
    proxima: 'todos os dias às 7h (horário de Brasília)'
  });
  await sb.from('docs').upsert({ collection: 'config', id: 'mercado', data: novoInfo });
  return ups.length;
}

export default async function handler(req, res) {
  const sb = admin();
  if (!(await autorizado(req, sb))) return res.status(401).send('Não autorizado.');
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).send('ANTHROPIC_API_KEY não configurada na Vercel.');
  const info = await getDoc(sb, 'config', 'mercado') || {};
  await sb.from('docs').upsert({ collection: 'config', id: 'mercado', data: Object.assign({}, info, { solicitadoEm: new Date().toISOString() }) });
  const tarefa = atualizar(sb).catch(async e => {
    console.error(e);
    const i2 = await getDoc(sb, 'config', 'mercado') || {};
    await sb.from('docs').upsert({ collection: 'config', id: 'mercado', data: Object.assign({}, i2, { concluidoEm: new Date().toISOString(), resumo: 'A última atualização falhou: ' + String(e.message || e).slice(0, 200) }) });
  });
  if (req.method === 'POST') { waitUntil(tarefa); return res.status(202).json({ iniciado: true }); }
  await tarefa;
  return res.status(200).json({ ok: true });
}
