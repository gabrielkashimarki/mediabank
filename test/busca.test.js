const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { buscar } = require('../src/busca');

const exposta = { aprovacao: 'aprovada', tem_crianca: 0, tier: 'social' };

function montar() {
  const db = abrirBanco(':memory:');
  const add = (id, campos, eixo) => {
    const base = { id, origem: 'local', md5: id, phash: '0', ...exposta, ...campos };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
    if (eixo != null) { const v = new Float32Array(1536); v[eixo] = 1; db.prepare('INSERT INTO vec_texto VALUES (?, ?)').run(id, v); }
  };
  add('deck', { espaco: 'Deck', local: 'Casa Exemplo', tipo_evento: 'Casamento', destinos: '["social"]', nota_final: 8 }, 0);
  add('palco', { espaco: 'Interior do teatro', local: 'Teatro Exemplo', tipo_evento: 'Palestra', nota_final: 9 }, 1);
  add('aerea', { espaco: 'Vista aérea do complexo', nota_final: 5 }, 2);
  add('crianca', { espaco: 'Deck', tem_crianca: 1, nota_final: 10 }, 0);
  return db;
}

const ids = linhas => linhas.map(l => l.id);

test('externo esconde o que não passa na regra de exposição e ordena pela nota', async () => {
  assert.deepEqual(ids(await buscar(montar(), {})), ['palco', 'deck', 'aerea']);
  assert.deepEqual(ids(await buscar(montar(), { externo: false })), ['crianca', 'palco', 'deck', 'aerea']);
});

test('filtro de local traz a vista aérea; tipo pai traz o filho', async () => {
  assert.deepEqual(ids(await buscar(montar(), { local: 'Casa Exemplo' })), ['deck', 'aerea']);
  assert.deepEqual(ids(await buscar(montar(), { tipo_evento: 'Corporativo' })), ['palco']);
  assert.deepEqual(ids(await buscar(montar(), { destino: 'social' })), ['deck']);
  assert.deepEqual(ids(await buscar(montar(), { local: 'Inexistente' })), []);
});

test('q ordena por similaridade', async () => {
  const embedQuery = async () => { const v = new Float32Array(1536); v[1] = 1; v[2] = 0.5; return v; };
  assert.deepEqual(ids(await buscar(montar(), { q: 'palco' }, { embedQuery })), ['palco', 'aerea', 'deck']);
});

test('limite fica entre 1 e 200 mesmo com valor negativo ou quebrado', async () => {
  assert.equal((await buscar(montar(), { limite: '-1' })).length, 1);
  assert.equal((await buscar(montar(), { limite: '2' })).length, 2);
  assert.equal((await buscar(montar(), { limite: 'abc' })).length, 3);
});

test('filtro com q acha a foto certa mesmo fora das 500 mais parecidas', async () => {
  const db = montar();
  const ins = db.prepare("INSERT INTO assets (id, origem, md5, phash, espaco, aprovacao, tem_crianca, tier) VALUES (?, 'local', ?, '0', 'Bar', 'aprovada', 0, 'social')");
  const vec = db.prepare('INSERT INTO vec_texto VALUES (?, ?)');
  const perto = new Float32Array(1536); perto[3] = 1;
  db.transaction(() => { for (let i = 0; i < 600; i++) { ins.run('bar' + i, 'bar' + i); vec.run('bar' + i, perto); } })();
  const embedQuery = async () => perto;
  assert.deepEqual(ids(await buscar(db, { q: 'x', espaco: 'Deck' }, { embedQuery })), ['deck']);
});

test('faceta com vários valores é OU e parâmetro repetido não quebra', async () => {
  assert.deepEqual(ids(await buscar(montar(), { tipo_evento: ['Casamento', 'Corporativo'] })), ['palco', 'deck']);
  assert.deepEqual(ids(await buscar(montar(), { local: ['Casa Exemplo', 'x'] })), []);
});

test('uso separa liberada de só interno', async () => {
  assert.deepEqual(ids(await buscar(montar(), { externo: false, uso: 'interno' })), ['crianca']);
  assert.deepEqual(ids(await buscar(montar(), { externo: false, uso: ['liberada', 'interno'] })).length, 4);
});

test('facetas contam sem a própria faceta e o pai soma os filhos', () => {
  const { facetas, contar } = require('../src/busca');
  const f = facetas(montar(), { externo: false, tipo_evento: 'Casamento' });
  assert.deepEqual(f.tipo_evento, { Casamento: 1, Palestra: 1, Corporativo: 1 });
  assert.deepEqual(f.uso, { liberada: 1 });
  assert.deepEqual(f.destino, { social: 1 });
  assert.equal(f.espaco.Deck, 2);
  assert.equal(contar(montar(), { externo: false }), 4);
});


test('offset pagina a lista na mesma ordem', async () => {
  const db = montar();
  assert.deepEqual(ids(await buscar(db, { externo: false, limite: 2 })), ['crianca', 'palco']);
  assert.deepEqual(ids(await buscar(db, { externo: false, limite: 2, offset: 2 })), ['deck', 'aerea']);
});

test('nota_min filtra pela nota da IA e ordem ia ordena por ela', async () => {
  const db = montar();
  db.prepare("UPDATE assets SET nota_rubrica = CASE id WHEN 'deck' THEN 8.5 WHEN 'palco' THEN 6 WHEN 'aerea' THEN 9 ELSE NULL END").run();
  assert.deepEqual(ids(await buscar(db, { externo: false, nota_min: 7 })).sort(), ['aerea', 'deck']);
  assert.deepEqual(ids(await buscar(db, { externo: false, ordem: 'ia' })), ['aerea', 'deck', 'palco', 'crianca']);
});

test('pessoas=sem traz só foto sem rosto; com traz só com rosto', async () => {
  const db = montar();
  db.prepare("UPDATE assets SET qtd_rostos = CASE id WHEN 'deck' THEN 0 WHEN 'palco' THEN 12 WHEN 'aerea' THEN 0 ELSE NULL END").run();
  assert.deepEqual(ids(await buscar(db, { externo: false, pessoas: 'sem' })).sort(), ['aerea', 'deck']);
  assert.deepEqual(ids(await buscar(db, { externo: false, pessoas: 'com' })), ['palco']);
});

test('tem_pessoa manda no filtro de pessoas; sem ele, vale a contagem de rostos', async () => {
  const db = montar();
  db.prepare("UPDATE assets SET qtd_rostos = 0, tem_pessoa = CASE id WHEN 'deck' THEN 1 WHEN 'palco' THEN 0 ELSE NULL END").run();
  assert.deepEqual(ids(await buscar(db, { externo: false, pessoas: 'sem' })).sort(), ['aerea', 'crianca', 'palco']);
  assert.deepEqual(ids(await buscar(db, { externo: false, pessoas: 'com' })), ['deck']);
});

test('variação de rajada some da lista, a não ser que o filtro de tier peça', async () => {
  const db = montar();
  db.prepare("UPDATE assets SET tier = 'variacao' WHERE id = 'palco'").run();
  assert.ok(!ids(await buscar(db, { externo: false })).includes('palco'));
  assert.deepEqual(ids(await buscar(db, { externo: false, tier: 'variacao' })), ['palco']);
});

test('Jev reordena a primeira página da busca por frase; falha do Jev mantém a ordem do vetor', async () => {
  const db = montar();
  const embedQuery = async () => { const v = new Float32Array(1536); v[0] = 1; return v; };
  const porVetor = ids(await buscar(db, { externo: false, q: 'deck', limite: 60 }, { embedQuery }));
  // Jev falso: a última do vetor é a mais relevante
  const jev = async corpo => ({ answers: Object.fromEntries(Object.keys(corpo.questions).map((k, i, xs) => [k, { noul: i === xs.length - 1 ? 0.99 : 0.1 }])) });
  const reordenada = ids(await buscar(db, { externo: false, q: 'deck', limite: 60 }, { embedQuery, jev }));
  assert.equal(reordenada[0], porVetor.at(-1));
  const quebrado = async () => { throw new Error('fora do ar'); };
  assert.deepEqual(ids(await buscar(db, { externo: false, q: 'deck', limite: 60 }, { embedQuery, jev: quebrado })), porVetor);
});
