const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { validarEdicao, editar, aprovar } = require('../src/edicao');
const { criarUsuario } = require('../src/auth');

function montar() {
  const db = abrirBanco(':memory:');
  const admin = { id: criarUsuario(db, { email: 'a@x.com', nome: 'A', senha: 'senha-longa-1', admin: true }), admin: true };
  const equipe = { id: criarUsuario(db, { email: 'e@x.com', nome: 'E', senha: 'senha-longa-2' }), admin: false };
  const add = (id, c = {}) => {
    const base = { id, origem: 'local', md5: id, phash: '0', espaco: 'Deck', st_embedding: 'ok', ...c };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(k => '@' + k)})`).run(base);
  };
  add('a', { aprovacao: 'aprovada', tem_crianca: 0 });
  add('b');
  const ler = id => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  return { db, admin, equipe, ler };
}

test('validação recusa campo desconhecido e valor fora do vocabulário', () => {
  assert.deepEqual(validarEdicao({ espaco: 'Varanda', md5: 'x' }).erros, ['valor inválido em espaco', 'campo não editável: md5']);
  assert.deepEqual(validarEdicao({ destinos: ['prop', 'tv'] }).erros, ['valor inválido em destinos']);
  assert.deepEqual(validarEdicao({}).erros, ['nada para editar']);
  assert.equal(validarEdicao({ tem_crianca: 0 }).ok, false);
});

test('mudar espaço deriva o local e manda reindexar', () => {
  const { db, equipe, ler } = montar();
  assert.deepEqual(editar(db, ['b'], { espaco: 'Arena', titulo: 'Show' }, equipe), { ok: true, n: 1 });
  const b = ler('b');
  assert.equal(b.local, 'Parque Exemplo');
  assert.equal(b.st_embedding, 'pendente');
});

test('equipe mexendo em proteção de foto aprovada derruba a aprovação; admin não', () => {
  const { db, admin, equipe, ler } = montar();
  editar(db, ['a'], { legenda: 'nova' }, equipe);
  assert.equal(ler('a').aprovacao, 'aprovada');
  editar(db, ['a'], { tem_crianca: false }, admin);
  assert.equal(ler('a').aprovacao, 'aprovada');
  editar(db, ['a'], { tier: 'hero' }, equipe);
  assert.equal(ler('a').aprovacao, 'pendente');
});

test('aprovar registra quem e quando; revogar limpa', () => {
  const { db, admin, ler } = montar();
  assert.equal(aprovar(db, ['b', 'nao-existe'], true, admin), 1);
  const b = ler('b');
  assert.equal(b.aprovacao, 'aprovada');
  assert.equal(b.aprovado_por, admin.id);
  assert.ok(b.aprovado_em);
  aprovar(db, ['b'], false, admin);
  assert.equal(ler('b').aprovado_por, null);
});

test('chave herdada do protótipo é recusada e lista aceita null para limpar', () => {
  assert.deepEqual(validarEdicao({ constructor: 1 }).erros, ['campo não editável: constructor']);
  assert.deepEqual(validarEdicao({ tipo_evento: 'toString' }).erros, ['valor inválido em tipo_evento']);
  assert.deepEqual(validarEdicao({ luz_tipo: null, espaco: null }).sets, { luz_tipo: null, espaco: null, local: null });
  assert.equal(validarEdicao({ tier: null }).ok, false);
});

test('tier ou destinos editados à mão ficam travados contra o recálculo', () => {
  const { db, equipe, ler } = montar();
  editar(db, ['b'], { legenda: 'x' }, equipe);
  assert.equal(ler('b').tier_fixo, 0);
  editar(db, ['b'], { destinos: ['site'] }, equipe);
  assert.equal(ler('b').tier_fixo, 1);
});
