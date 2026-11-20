const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');

async function subir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-api-'));
  fs.mkdirSync(path.join(dir, 'midia/thumb'), { recursive: true });
  const db = abrirBanco(':memory:');
  const add = (id, campos) => {
    const base = { id, origem: 'local', md5: id, phash: '0', espaco: 'Deck', ...campos };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
    fs.writeFileSync(path.join(dir, 'midia/thumb', `${id}.jpg`), 'jpg');
  };
  add('liberada', { aprovacao: 'aprovada', tem_crianca: 0, perguntas_que_responde: '["Como é o deck?"]' });
  add('crianca', { aprovacao: 'aprovada', tem_crianca: 1 });
  const chave = criarChave(db, 'teste');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const get = (rota, k = chave) => fetch(base + rota, { headers: k ? { 'X-API-Key': k } : {} });
  return { srv, get };
}

test('sem chave ou com chave errada devolve 401', async () => {
  const { srv, get } = await subir();
  assert.equal((await get('/fotos', null)).status, 401);
  assert.equal((await get('/fotos', 'mb_errada')).status, 401);
  srv.close();
});

test('foto com criança nunca aparece: lista, detalhe e mídia', async () => {
  const { srv, get } = await subir();
  const lista = await (await get('/fotos')).json();
  assert.deepEqual(lista.fotos.map(f => f.id), ['liberada']);
  assert.deepEqual(lista.fotos[0].perguntas_que_responde, ['Como é o deck?']);
  assert.equal(lista.fotos[0].thumb_url, '/api/v1/midia/thumb/liberada.jpg');
  assert.equal((await get('/fotos/crianca')).status, 404);
  assert.equal((await get('/midia/thumb/crianca.jpg')).status, 404);
  assert.equal((await get('/midia/thumb/liberada.jpg')).status, 200);
  assert.equal((await get('/midia/original/liberada.jpg')).status, 404);
  srv.close();
});
