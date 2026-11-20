const crypto = require('node:crypto');
const { PADRAO, validar, exposicao, vocabularioDe } = require('./clientes');

// "Casamento Ana & Pedro" -> "casamento-ana-pedro-3f9a1c"; o sufixo aleatório impede adivinhar o link
function slug(nome) {
  const base = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${base || 'colecao'}-${crypto.randomBytes(8).toString('hex')}`;
}

function listar(db, cliente = PADRAO) {
  return db.prepare(`SELECT c.*, count(cf.asset_id) AS n,
      (SELECT asset_id FROM colecao_fotos WHERE colecao_id = c.id ORDER BY posicao LIMIT 1) AS capa
    FROM colecoes c LEFT JOIN colecao_fotos cf ON cf.colecao_id = c.id
    WHERE c.cliente_id = ? GROUP BY c.id ORDER BY c.criado_em DESC, c.id DESC`).all(validar(cliente));
}

function criar(db, { nome, descricao = null }, usuario, cliente = PADRAO) {
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 120) throw new Error('nome inválido');
  return db.prepare('INSERT INTO colecoes (nome, descricao, criado_por, cliente_id) VALUES (?, ?, ?, ?)')
    .run(nome.trim(), typeof descricao === 'string' ? descricao.slice(0, 1000) : null, usuario.id, validar(cliente)).lastInsertRowid;
}

// fotos novas entram no fim; repetida é ignorada; foto de outro cliente não entra
function adicionar(db, colecaoId, ids) {
  const ins = db.prepare(`INSERT OR IGNORE INTO colecao_fotos (colecao_id, asset_id, posicao)
    SELECT c.id, a.id, (SELECT coalesce(max(posicao), 0) + 1 FROM colecao_fotos WHERE colecao_id = c.id)
    FROM colecoes c JOIN assets a ON a.cliente_id = c.cliente_id WHERE c.id = ? AND a.id = ?`);
  let n = 0;
  db.transaction(() => { for (const id of ids) n += ins.run(colecaoId, id).changes; })();
  return n;
}

const remover = (db, colecaoId, assetId) =>
  db.prepare('DELETE FROM colecao_fotos WHERE colecao_id = ? AND asset_id = ?').run(colecaoId, assetId).changes;

const excluir = (db, id) => db.prepare('DELETE FROM colecoes WHERE id = ?').run(id).changes;

function publicar(db, id) {
  const c = db.prepare('SELECT nome, slug_publico FROM colecoes WHERE id = ?').get(id);
  if (!c) return null;
  if (c.slug_publico) return c.slug_publico;
  const s = slug(c.nome);
  db.prepare('UPDATE colecoes SET slug_publico = ? WHERE id = ?').run(s, id);
  return s;
}

const despublicar = (db, id) => db.prepare('UPDATE colecoes SET slug_publico = NULL WHERE id = ?').run(id).changes;

// visão da equipe: todas as fotos, com a marca de quais o cliente vai ver
function fotosDaColecao(db, id) {
  const c = db.prepare('SELECT cliente_id FROM colecoes WHERE id = ?').get(id);
  if (!c) return [];
  return db.prepare(`SELECT a.*, (${vocabularioDe(c.cliente_id).EXPOSICAO.externa}) AS exposta FROM colecao_fotos cf JOIN assets a ON a.id = cf.asset_id
    WHERE cf.colecao_id = ? AND a.cliente_id = ? ORDER BY cf.posicao`).all(id, c.cliente_id);
}

// visão do cliente: só o que passa na regra de exposição do cliente dono da coleção
function colecaoPublica(db, slugPublico) {
  const c = db.prepare('SELECT id, nome, descricao, cliente_id FROM colecoes WHERE slug_publico = ?').get(slugPublico);
  if (!c) return null;
  const fotos = db.prepare(`SELECT a.id, a.titulo, a.alt, a.largura, a.altura FROM colecao_fotos cf JOIN assets a ON a.id = cf.asset_id
    WHERE cf.colecao_id = ? AND ${exposicao(c.cliente_id)} ORDER BY cf.posicao`).all(c.id);
  return { nome: c.nome, descricao: c.descricao, fotos };
}

function fotoPublica(db, slugPublico, assetId) {
  const c = db.prepare('SELECT id, cliente_id FROM colecoes WHERE slug_publico = ?').get(slugPublico);
  return !!c && !!db.prepare(`SELECT 1 FROM colecao_fotos cf JOIN assets a ON a.id = cf.asset_id
    WHERE cf.colecao_id = ? AND a.id = ? AND ${exposicao(c.cliente_id)}`).get(c.id, assetId);
}

module.exports = { slug, listar, criar, adicionar, remover, excluir, publicar, despublicar, fotosDaColecao, colecaoPublica, fotoPublica };
