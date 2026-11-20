const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');
const { ciclo } = require('../src/agendador');

async function subir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-lote-'));
  fs.mkdirSync(path.join(dir, 'midia/preview'), { recursive: true });
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO assets (id, origem, md5, phash, st_tecnica, aprovacao, tem_crianca, titulo, espaco) VALUES ('p', 'local', 'p', '0', 'ok', 'aprovada', 0, 'Deck à noite', 'Deck')").run();
  fs.writeFileSync(path.join(dir, 'midia/preview/p.jpg'), 'jpg');
  const lote = criarChave(db, 'lote'), site = criarChave(db, 'site');
  const embedQuery = async () => { const v = new Float32Array(1536); v[0] = 1; return v; };
  const srv = criarApp({ db, dirDados: dir, embedQuery }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (rota, chave, corpo) => fetch(base + rota, {
    method: corpo ? 'POST' : 'GET',
    headers: { 'X-API-Key': chave, ...(corpo && { 'Content-Type': 'application/json' }) },
    body: corpo && JSON.stringify(corpo),
  });
  return { db, req, lote, site };
}

const vetor = () => Buffer.from(new Float32Array(768).fill(0.036).buffer).toString('base64');

test('trabalhador recebe pendentes, baixa preview e devolve sinais; a chave dele não lê a API v1', async (t) => {
  const { db, req, lote, site } = await subir(t);
  assert.equal((await req('/api/lote/pendentes', site)).status, 401);
  assert.equal((await req('/api/v1/fotos', lote)).status, 401);
  assert.deepEqual(await (await req('/api/lote/pendentes', lote)).json(), ['p']);
  assert.equal((await req('/api/lote/preview/p.jpg', lote)).status, 200);
  assert.equal((await req('/api/lote/preview/..%2Fx.jpg', lote)).status, 404);
  assert.equal((await req('/api/lote/sinais', lote, { id: 'p', nota_estetica: 5.1, vetor: 'curto' })).status, 400);
  assert.equal((await req('/api/lote/sinais', lote, { id: 'p', nota_estetica: 5.1, vetor: vetor() })).status, 200);
  assert.deepEqual({ ...db.prepare("SELECT st_estetica, nota_estetica FROM assets WHERE id = 'p'").get() }, { st_estetica: 'ok', nota_estetica: 5.1 });
  assert.equal(db.prepare('SELECT length(vetor) n FROM emb_imagem').get().n, 3072);
  // preview de foto já processada (st_estetica = 'ok') dá 404
  assert.equal((await req('/api/lote/preview/p.jpg', lote)).status, 404);
  assert.equal((await req('/api/lote/moodboard', lote, { destino: 'site', vetor: vetor(), n: 3 })).status, 200);
  assert.equal((await req('/api/lote/moodboard', lote, { destino: 'tv', vetor: vetor(), n: 3 })).status, 400);
});

test('nota_estetica fora de 0-10 é rejeitada', async (t) => {
  const { req, lote } = await subir(t);
  assert.equal((await req('/api/lote/sinais', lote, { id: 'p', nota_estetica: 11, vetor: vetor() })).status, 400);
  assert.equal((await req('/api/lote/sinais', lote, { id: 'p', nota_estetica: -1, vetor: vetor() })).status, 400);
});

test('sugerir devolve candidatos da busca pela conversa, só o que passa na exposição', async (t) => {
  const { db, req, site } = await subir(t);
  const v = new Float32Array(1536); v[0] = 1;
  db.prepare('INSERT INTO vec_texto VALUES (?, ?)').run('p', v);
  assert.equal((await req('/api/v1/fotos/sugerir', site, { conversa: '' })).status, 400);
  const r = await (await req('/api/v1/fotos/sugerir', site, { conversa: 'quero ver o deck à noite', limite: 50 })).json();
  assert.deepEqual(r.fotos.map(f => f.id), ['p']);
  assert.equal(r.probabilidade, null);
  db.prepare("UPDATE assets SET tem_crianca = 1").run();
  assert.deepEqual((await (await req('/api/v1/fotos/sugerir', site, { conversa: 'deck' })).json()).fotos, []);
});

test('ciclo sem Drive nem IA roda só a técnica e a curadoria', async () => {
  const db = abrirBanco(':memory:');
  const r = await ciclo({ db, dirDados: os.tmpdir(), drive: null, cliente: null });
  assert.deepEqual(Object.keys(r), ['tecnica', 'curadoria']);
});
