// Guias do cliente (brandbook, playbook de edição): a equipe lê e edita no painel, o Claude lê pelo MCP e a API v2 sincroniza.
// Toda gravação vira versão nova; a anterior fica em guias_versoes e pode ser restaurada.
const express = require('express');

const TIPOS = ['brandbook', 'playbook', 'outro'];
const FORMATOS = ['markdown', 'html'];
const LIMITE = 2 * 1024 * 1024;

const listar = (db, cliente) => db.prepare(`SELECT slug, titulo, tipo, formato, versao, atualizado_por, atualizado_em, length(conteudo) AS tamanho
  FROM guias WHERE cliente_id = ? ORDER BY CASE tipo WHEN 'brandbook' THEN 0 WHEN 'playbook' THEN 1 ELSE 2 END, titulo`).all(cliente);
const ler = (db, cliente, slug) => db.prepare('SELECT * FROM guias WHERE cliente_id = ? AND slug = ?').get(cliente, slug);

function gravar(db, cliente, slug, { titulo, tipo, formato, conteudo }, por) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error('slug: letras minúsculas, números e hífen');
  const atual = ler(db, cliente, slug);
  const g = { titulo: titulo ?? atual?.titulo, tipo: tipo ?? atual?.tipo ?? 'outro', formato: formato ?? atual?.formato ?? 'markdown', conteudo };
  if (typeof g.titulo !== 'string' || !g.titulo.trim() || g.titulo.length > 120) throw new Error('titulo obrigatório (até 120)');
  if (!TIPOS.includes(g.tipo)) throw new Error(`tipo: ${TIPOS.join(' | ')}`);
  if (!FORMATOS.includes(g.formato)) throw new Error(`formato: ${FORMATOS.join(' | ')}`);
  if (typeof conteudo !== 'string' || !conteudo.trim() || Buffer.byteLength(conteudo) > LIMITE) throw new Error('conteudo obrigatório (até 2 MB)');
  db.transaction(() => {
    if (atual) {
      db.prepare('INSERT OR IGNORE INTO guias_versoes (cliente_id, slug, versao, titulo, formato, conteudo, por, em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(cliente, slug, atual.versao, atual.titulo, atual.formato, atual.conteudo, atual.atualizado_por, atual.atualizado_em);
      db.prepare(`UPDATE guias SET titulo = ?, tipo = ?, formato = ?, conteudo = ?, versao = versao + 1, atualizado_por = ?, atualizado_em = datetime('now')
        WHERE cliente_id = ? AND slug = ?`).run(g.titulo.trim(), g.tipo, g.formato, conteudo, por, cliente, slug);
    } else {
      db.prepare('INSERT INTO guias (cliente_id, slug, titulo, tipo, formato, conteudo, atualizado_por) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(cliente, slug, g.titulo.trim(), g.tipo, g.formato, conteudo, por);
    }
  })();
  return ler(db, cliente, slug);
}

function rotasGuias(r, { db, contexto }) {
  r.get('/guias', (req, res) => res.json({ guias: listar(db, contexto(req).cliente) }));
  r.get('/guias/:slug', (req, res) => {
    const g = ler(db, contexto(req).cliente, req.params.slug);
    g ? res.json(g) : res.status(404).json({ erro: 'guia não encontrado' });
  });
  r.get('/guias/:slug/versoes', (req, res) => {
    res.json({ versoes: db.prepare('SELECT versao, titulo, por, em, length(conteudo) AS tamanho FROM guias_versoes WHERE cliente_id = ? AND slug = ? ORDER BY versao DESC')
      .all(contexto(req).cliente, req.params.slug) });
  });
  r.get('/guias/:slug/versoes/:versao', (req, res) => {
    const v = db.prepare('SELECT * FROM guias_versoes WHERE cliente_id = ? AND slug = ? AND versao = ?').get(contexto(req).cliente, req.params.slug, Number(req.params.versao));
    v ? res.json(v) : res.status(404).json({ erro: 'versão não encontrada' });
  });
  r.put('/guias/:slug', express.json({ limit: '3mb' }), (req, res) => {
    const { cliente, quem } = contexto(req);
    try { res.json(gravar(db, cliente, req.params.slug, req.body || {}, quem)); }
    catch (e) { res.status(400).json({ erros: [e.message] }); }
  });
  // restaurar = gravar de novo o conteúdo antigo (vira a versão seguinte; nada se perde)
  r.post('/guias/:slug/versoes/:versao/restaurar', (req, res) => {
    const { cliente, quem } = contexto(req);
    const v = db.prepare('SELECT * FROM guias_versoes WHERE cliente_id = ? AND slug = ? AND versao = ?').get(cliente, req.params.slug, Number(req.params.versao));
    if (!v) return res.status(404).json({ erro: 'versão não encontrada' });
    res.json(gravar(db, cliente, req.params.slug, { titulo: v.titulo, formato: v.formato, conteudo: v.conteudo }, quem));
  });
}

module.exports = { rotasGuias, listar, ler, gravar };
