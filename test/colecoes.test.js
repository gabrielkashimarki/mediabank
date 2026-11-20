const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const c = require('../src/colecoes');

function montar() {
  const db = abrirBanco(':memory:');
  const add = (id, campos = {}) => {
    const base = { id, origem: 'local', md5: id, phash: '0', ...campos };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(k => '@' + k)})`).run(base);
  };
  add('liberada', { aprovacao: 'aprovada', tem_crianca: 0 });
  add('crianca', { aprovacao: 'aprovada', tem_crianca: 1 });
  const id = c.criar(db, { nome: 'Casamento Ana & Pedro' }, { id: null });
  return { db, id };
}

test('slug sem acento, com sufixo aleatório', () => {
  assert.match(c.slug('Casamento Ana & Pedro, março'), /^casamento-ana-pedro-marco-[0-9a-f]{16}$/);
  assert.notEqual(c.slug('x'), c.slug('x'));
});

test('adicionar ignora repetida e id inexistente, mantém a ordem', () => {
  const { db, id } = montar();
  assert.equal(c.adicionar(db, id, ['crianca', 'liberada', 'crianca', 'fantasma']), 2);
  assert.deepEqual(c.fotosDaColecao(db, id).map(f => [f.id, f.exposta]), [['crianca', 0], ['liberada', 1]]);
  assert.equal(c.listar(db)[0].n, 2);
  assert.equal(c.listar(db)[0].capa, 'crianca');
});

test('link público só mostra o que passa na regra de exposição', () => {
  const { db, id } = montar();
  c.adicionar(db, id, ['crianca', 'liberada']);
  assert.equal(c.colecaoPublica(db, 'qualquer'), null);
  const s = c.publicar(db, id);
  assert.equal(c.publicar(db, id), s);
  assert.deepEqual(c.colecaoPublica(db, s).fotos.map(f => f.id), ['liberada']);
  assert.equal(c.fotoPublica(db, s, 'liberada'), true);
  assert.equal(c.fotoPublica(db, s, 'crianca'), false);
  c.despublicar(db, id);
  assert.equal(c.colecaoPublica(db, s), null);
});

test('excluir coleção leva as ligações junto', () => {
  const { db, id } = montar();
  c.adicionar(db, id, ['liberada']);
  c.excluir(db, id);
  assert.equal(db.prepare('SELECT count(*) n FROM colecao_fotos').get().n, 0);
});
