/* Adaptador: oferece ao sistema a mesma interface que ele usava no claude.ai
   (claude.use('db' | 'user' | 'downloads' | 'mcp')), agora com Supabase e login Microsoft. */
(function () {
  'use strict';
  let sb = null, uid = null, acesso = null, authUser = null;

  const iniciais = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase() || '?';
  const corDe = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 55% 42%)`; };
  const avatar = (nome, id) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${corDe(id)}"/><text x="32" y="41" font-family="Arial" font-size="24" font-weight="bold" fill="#fff" text-anchor="middle">${iniciais(nome).replace(/[<&]/g, '')}</text></svg>`);

  function telaLogin() {
    const el = document.createElement('div');
    el.id = 'login-novaitx';
    el.setAttribute('style', 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:#0b1a4a;font-family:"IBM Plex Sans",system-ui,sans-serif');
    el.innerHTML = '<div style="background:#fff;border-radius:12px;padding:32px 28px;width:min(380px,92vw);text-align:center;box-shadow:0 20px 60px rgb(0 0 0 / .3)">' +
      '<div style="background:#0b1a4a;border-radius:8px;padding:14px;margin-bottom:20px"><img src="/brand/logo-white.png" alt="Nova ITX" style="height:24px"></div>' +
      '<h1 style="font-size:18px;margin:0 0 6px;color:#141b26">Gestão Operacional</h1>' +
      '<p style="font-size:13.5px;color:#586477;margin:0 0 20px">Entre com a sua conta Microsoft da Nova ITX.</p>' +
      '<button id="btn-ms" style="width:100%;padding:11px 14px;border-radius:8px;border:1px solid #1f4fe0;background:#1f4fe0;color:#fff;font:600 14px inherit;cursor:pointer">Entrar com Microsoft</button>' +
      '<p id="login-erro" style="font-size:12.5px;color:#b42828;margin:12px 0 0"></p></div>';
    document.body.appendChild(el);
    el.querySelector('#btn-ms').onclick = async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: 'azure', options: { scopes: 'openid profile email', redirectTo: location.origin + location.pathname } });
      if (error) el.querySelector('#login-erro').textContent = 'Não foi possível abrir o login da Microsoft. Tente de novo.';
    };
  }

  function botaoSair() {
    const row = document.querySelector('.brandbar .row');
    if (!row || document.getElementById('btn-sair')) return;
    const b = document.createElement('button');
    b.id = 'btn-sair'; b.textContent = 'Sair'; b.className = 'btn small';
    b.setAttribute('style', 'background:transparent;color:#fff;border-color:rgb(255 255 255 / .4)');
    b.onclick = async () => { await sb.auth.signOut(); location.reload(); };
    row.appendChild(b);
  }

  const pronto = (async () => {
    const cfg = await fetch('/api/config').then(r => r.json());
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { telaLogin(); return false; }
    authUser = session.user; uid = authUser.id;
    try { await sb.rpc('entrar'); } catch (e) { console.warn(e); }
    const { data } = await sb.from('docs').select('data').eq('collection', 'acessos').eq('id', uid).maybeSingle();
    acesso = data ? data.data : null;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', botaoSair); else botaoSair();
    sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') location.reload(); });
    return true;
  })().catch(e => { console.error(e); return false; });

  /* ---------- banco de dados (interface parecida com a do claude.ai) ---------- */
  const erro = e => { const x = new Error(e && e.message || 'erro'); x.code = (e && e.code === '42501') ? 'invalid_argument' : (e && e.code) || 'unknown'; return x; };
  const snapDoc = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))) });
  const snapCol = map => ({ docs: [...map.entries()].map(([id, d]) => snapDoc(id, d)) });
  const cache = new Map();        // coleção -> Map(id -> dados)
  const ouvintesCol = new Map();  // coleção -> Set(cb)
  const ouvintesDoc = new Map();  // 'col/id' -> Set(cb)
  let canal = null;
  const separa = p => { const i = p.indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };

  async function carregar(col) {
    if (cache.has(col)) return cache.get(col);
    const m = new Map(); let de = 0;
    for (;;) {
      const { data, error } = await sb.from('docs').select('id,data').eq('collection', col).order('id').range(de, de + 999);
      if (error) throw erro(error);
      data.forEach(r => m.set(r.id, r.data));
      if (data.length < 1000) break; de += 1000;
    }
    cache.set(col, m); return m;
  }
  function avisar(col, id) {
    const m = cache.get(col);
    (ouvintesCol.get(col) || []).forEach(cb => { try { cb(snapCol(m || new Map())); } catch (e) { console.error(e); } });
    (ouvintesDoc.get(col + '/' + id) || []).forEach(cb => { try { cb(snapDoc(id, m ? m.get(id) : null)); } catch (e) { console.error(e); } });
  }
  function aplicar(col, id, data) { const m = cache.get(col); if (m) { if (data == null) m.delete(id); else m.set(id, data); } avisar(col, id); }
  function tempoReal() {
    if (canal) return;
    canal = sb.channel('docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
      const r = p.eventType === 'DELETE' ? p.old : p.new;
      if (!r || !r.collection) return;
      // Perfil da própria pessoa mudou (liberado, alterado ou removido): recarrega para valer na hora
      if (r.collection === 'acessos' && r.id === uid && JSON.stringify(p.eventType === 'DELETE' ? null : r.data && r.data.perfil) !== JSON.stringify(acesso && acesso.perfil)) { location.reload(); return; }
      aplicar(r.collection, r.id, p.eventType === 'DELETE' ? null : r.data);
    }).subscribe();
  }

  function consulta(col, filtros, lim) {
    return {
      where: (f, op, v) => consulta(col, filtros.concat([[f, op, v]]), lim),
      limit: n => consulta(col, filtros, n),
      async get() {
        let q = sb.from('docs').select('id,data').eq('collection', col);
        const OP = { '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
        for (const [f, op, v] of filtros) q = q.filter('data->>' + f, OP[op] || 'eq', String(v));
        if (lim) q = q.limit(lim);
        const { data, error } = await q; if (error) throw erro(error);
        return { docs: data.map(r => snapDoc(r.id, r.data)) };
      },
      onSnapshot(cb, onErr) {
        tempoReal();
        if (!ouvintesCol.has(col)) ouvintesCol.set(col, new Set());
        ouvintesCol.get(col).add(cb);
        carregar(col).then(m => cb(snapCol(m)), e => onErr && onErr(e));
        return () => ouvintesCol.get(col).delete(cb);
      }
    };
  }
  function documento(path) {
    const [col, id] = separa(path);
    return {
      id,
      async get() { const { data, error } = await sb.from('docs').select('data').eq('collection', col).eq('id', id).maybeSingle(); if (error) throw erro(error); return snapDoc(id, data ? data.data : null); },
      async set(d) { const { error } = await sb.from('docs').upsert({ collection: col, id, data: d }); if (error) throw erro(error); aplicar(col, id, d); },
      async update(parcial) {
        const atual = await this.get(); if (!atual.exists) { const x = new Error('documento não existe'); x.code = 'not_found'; throw x; }
        const novo = Object.assign(atual.data(), parcial);
        const { error } = await sb.from('docs').update({ data: novo }).eq('collection', col).eq('id', id); if (error) throw erro(error); aplicar(col, id, novo);
      },
      async delete() { const { error } = await sb.from('docs').delete().eq('collection', col).eq('id', id); if (error) throw erro(error); aplicar(col, id, null); },
      onSnapshot(cb, onErr) {
        tempoReal();
        const k = col + '/' + id;
        if (!ouvintesDoc.has(k)) ouvintesDoc.set(k, new Set());
        ouvintesDoc.get(k).add(cb);
        carregar(col).then(m => cb(snapDoc(id, m.get(id))), e => onErr && onErr(e));
        return () => ouvintesDoc.get(k).delete(cb);
      }
    };
  }
  const db = Object.freeze({ collection: c => consulta(c, [], null), doc: documento });

  /* ---------- usuário ---------- */
  const perfil = () => acesso && acesso.perfil;
  const nomeProprio = () => (authUser.user_metadata && (authUser.user_metadata.full_name || authUser.user_metadata.name)) || authUser.email || '';
  const perfilDe = (r, id) => {
    const nome = (r && r.nome) || ''; const pid = r ? r.id : id;
    return { id: pid, name: nome, email: r ? r.email : null, avatarUrl: avatar(nome || '?', pid), color: corDe(pid), isMe: pid === uid, guest: false };
  };
  const user = Object.freeze({
    async isOwner() { return !!(acesso && acesso.dono); },
    async canEdit() { return perfil() === 'admin'; },
    async can(n) { if (n !== 'data.write') return false; return perfil() ? perfil() !== 'diretoria' : null; },
    async id() { return uid; },
    async name() { return nomeProprio(); },
    async email() { return (authUser.email || '').toLowerCase(); },
    async avatarUrl() { return avatar(nomeProprio(), uid); },
    async me() { return { id: uid, name: nomeProprio(), email: (authUser.email || '').toLowerCase(), avatarUrl: avatar(nomeProprio(), uid), color: corDe(uid), isOwner: !!(acesso && acesso.dono), canEdit: perfil() === 'admin' }; },
    async profiles(ids) {
      ids = [...new Set([].concat(ids || []))]; const out = {};
      if (!ids.length) return out;
      const { data } = await sb.from('usuarios').select('id,email,nome').in('id', ids);
      const m = new Map((data || []).map(r => [r.id, r]));
      ids.forEach(id => { out[id] = perfilDe(m.get(id), id); });
      return out;
    },
    async search(q) {
      q = String(q || '').trim();
      let r = sb.from('usuarios').select('id,email,nome').order('nome').limit(8);
      if (q) r = r.or(`nome.ilike.%${q.replace(/[%,()]/g, '')}%,email.ilike.%${q.replace(/[%,()]/g, '')}%`);
      const { data } = await r; return (data || []).filter(x => x.nome || x.email).map(x => { const p = perfilDe(x); p.name = p.name || x.email; return p; });
    }
  });

  /* ---------- downloads ---------- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(filename) ? 'application/json' : 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  });

  /* ---------- atualização da tabela de mercado (antes era o conector do Claude) ---------- */
  const mcp = Object.freeze({
    async callTool() {
      const { data: { session } } = await sb.auth.getSession();
      const r = await fetch('/api/mercado', { method: 'POST', headers: { Authorization: 'Bearer ' + (session ? session.access_token : '') } });
      if (!r.ok) { const x = new Error((await r.text()).slice(0, 200)); x.code = r.status === 401 || r.status === 403 ? 'tool_error' : 'server_unavailable'; throw x; }
      return { ok: true };
    }
  });

  const caps = { db, user, downloads, mcp };
  window.claude = Object.freeze({ use: name => pronto.then(ok => (ok && caps[name]) || null) });
})();
