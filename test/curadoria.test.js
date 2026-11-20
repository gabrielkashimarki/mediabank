const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { recalcular, percentis, rajadas } = require('../src/curadoria');

const vetor = eixo => { const v = new Float32Array(768); v[eixo] = 1; return Buffer.from(v.buffer); };

function montar() {
  const db = abrirBanco(':memory:');
  const add = (id, c = {}, eixo) => {
    const base = { id, origem: 'local', md5: id, phash: '0'.repeat(16), st_tecnica: 'ok', st_ia: 'ok', largura: 1600, altura: 1000,
      tem_texto: 0, marca_terceiro: 0, espaco_para_texto: 1, ...c };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(k => '@' + k)})`).run(base);
    if (eixo != null) db.prepare('INSERT INTO emb_imagem VALUES (?, ?)').run(id, vetor(eixo));
  };
  return { db, add, ler: id => db.prepare('SELECT * FROM assets WHERE id = ?').get(id) };
}

test('percentil vai de 0 a 100, empate divide a posição, nulo fica nulo', () => {
  assert.deepEqual(percentis([10, null, 30, 20]), [0, null, 100, 50]);
  assert.deepEqual(percentis([5, 5, 9]), [25, 25, 100]);
  assert.deepEqual(percentis([7]), [100]);
});

test('rajada junta sequência parecida em até 10 minutos e deixa só a mais forte', () => {
  const f = (id, data, phash, forca) => ({ id, data_foto: data, phash, forca });
  const r = rajadas([
    f('a', '2025-06-14T20:00:00Z', 'ffff000000000000', 50), f('b', '2025-06-14T20:03:00Z', 'ffff000000000001', 80),
    f('c', '2025-06-14T20:30:00Z', 'ffff000000000000', 90), f('d', '2025-06-14T20:31:00Z', '0000ffffffff0000', 10),
    f('e', null, 'ffff000000000000', 1),
  ]);
  assert.deepEqual([...r.variacoes], ['a']);
  assert.equal(r.rajadaDe.get('b'), 'a');
  assert.equal(r.rajadaDe.has('c'), false);
});

test('nota por destino respeita pré-requisito e tier sai da nota', () => {
  const { db, add, ler } = montar();
  add('boa', { nota_estetica: 9, nota_rubrica: 9 }, 0);
  add('media', { nota_estetica: 5, nota_rubrica: 5 }, 1);
  add('fraca', { nota_estetica: 1, nota_rubrica: 1 }, 2);
  add('retrato', { nota_estetica: 9.5, nota_rubrica: 9.5, largura: 800, altura: 1200 }, 3);
  add('texto', { nota_estetica: 9.9, nota_rubrica: 9.9, tem_texto: 1 }, 4);
  const r = recalcular(db);
  assert.equal(r.fotos, 5);
  const p = (id, d) => db.prepare('SELECT * FROM pontuacao WHERE asset_id = ? AND destino = ?').get(id, d);
  assert.equal(p('retrato', 'site').elegivel, 0);
  assert.equal(p('retrato', 'prop').elegivel, 1);
  assert.equal(p('texto', 'social').percentil, null);
  assert.equal(p('texto', 'prop').elegivel, 1);
  assert.equal(ler('fraca').tier, 'arquivo');
  assert.equal(ler('boa').tier, 'hero'); // p100 no site
  // no site o retrato não entra, então a boa lidera; em social o retrato passa na frente
  assert.deepEqual(JSON.parse(ler('boa').destinos), ['site']);
  assert.deepEqual(JSON.parse(ler('retrato').destinos), ['prop', 'social']);
  assert.deepEqual(JSON.parse(ler('texto').destinos), ['prop']);
  assert.equal(ler('boa').nota_final, 10);
});

test('hero vem do percentil do score >= 90; tier escolhido pela equipe não muda no recálculo', () => {
  const { db, add, ler } = montar();
  for (let i = 0; i < 5; i++) add('f' + i, { nota_estetica: i + 5, nota_rubrica: i + 5 }, i);
  recalcular(db);
  assert.equal(ler('f4').tier, 'hero'); // p100
  assert.equal(ler('f3').tier, 'social'); // p75
  db.prepare("UPDATE assets SET tier = 'arquivo', tier_fixo = 1 WHERE id = 'f4'").run();
  recalcular(db);
  assert.equal(ler('f4').tier, 'arquivo');
});

test('moodboard entra como sinal quando há referência do destino', () => {
  const { db, add } = montar();
  add('perto', { nota_estetica: 5, nota_rubrica: 5 }, 0);
  add('longe', { nota_estetica: 5, nota_rubrica: 5 }, 1);
  db.prepare("INSERT INTO moodboard VALUES ('site', ?, 3)").run(vetor(0));
  const r = recalcular(db);
  assert.equal(r.destinos.site.moodboard, true);
  const sc = id => db.prepare("SELECT score FROM pontuacao WHERE asset_id = ? AND destino = 'site'").get(id).score;
  assert.ok(sc('perto') > sc('longe'));
});

test('foto descartada aprovada fica descartar e inelegível após recalcular', () => {
  const { db, add } = montar();
  add('ok', { nota_estetica: 9, nota_rubrica: 9 }, 0);
  add('desc', { nota_estetica: 9, nota_rubrica: 9, tier: 'descartar', aprovacao: 'aprovada', tier_fixo: 0 }, 1);
  recalcular(db);
  const foto = db.prepare("SELECT tier FROM assets WHERE id = 'desc'").get();
  assert.equal(foto.tier, 'descartar');
  const pontos = db.prepare("SELECT elegivel FROM pontuacao WHERE asset_id = 'desc'").all();
  for (const p of pontos) assert.equal(p.elegivel, 0);
});
