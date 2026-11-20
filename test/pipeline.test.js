const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { abrirBanco } = require('../src/db');
const { ingerirArquivo } = require('../src/ingestao');
const { processar, textoParaEmbedding } = require('../src/pipeline');

const analise = {
  titulo: 'Deck', descricao: 'd'.repeat(250), legenda: 'l', alt: 'a', espaco: 'Deck', tipo_evento: null,
  tipo: 'Espaço', luz_tipo: 'Natural', luz_direcao: 'Frontal', plano: 'Aberto', altura_camera: 'Olho',
  composicao: 'Centralizada', ponto_vista: 'Frontal', profundidade: 'Total', posicao_assunto: 'Centro',
  sazonal: 'Nenhum', tratamento: 'Natural', tem_crianca: false, qtd_rostos: 0, rostos_identificaveis: false,
  marca_terceiro: false, tem_texto: false, indesejados: [], capacidade_estimada: null,
  perguntas_que_responde: ['Como é o deck?'], espaco_para_texto: false, decoracao: {},
  qualidade: { assunto: 6, enquadramento: 6, composicao: 6, luz: 6, limpeza: 6, momento: 6 }, problemas: [], veredito: 'x',
  destinos_sugeridos: [],
};

async function preparar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-pipe-'));
  const db = abrirBanco(':memory:');
  const criar = async (nome, blur) => {
    let img = sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#777', noise: { type: 'gaussian', mean: 128, sigma: 40 } } });
    if (blur) img = sharp(await img.png().toBuffer()).blur(30);
    const p = path.join(dir, nome);
    await img.jpeg().toFile(p);
    return (await ingerirArquivo(db, p, { dirDados: dir })).id;
  };
  return { db, dir, nitida: await criar('n.jpg', false), borrada: await criar('b.jpg', true) };
}

test('pipeline reprova no portão sem chamar a IA e indexa a aprovada', async () => {
  const { db, dir, nitida, borrada } = await preparar();
  let chamadas = 0;
  const cliente = {
    chat: async () => { chamadas++; return JSON.stringify(analise); },
    embed: async (m, textos) => textos.map(() => { const v = new Float32Array(1536); v[0] = 1; return v; }),
  };
  const r = await processar(db, { dirDados: dir, cliente, modeloDescricao: 'g', modeloEmbedding: 'e' });
  assert.deepEqual(r, { tecnica: 2, ia: { ok: 1, erro: 0 }, embedding: 1 });
  assert.equal(chamadas, 1);
  const b = db.prepare('SELECT st_tecnica, st_ia, tier FROM assets WHERE id = ?').get(borrada);
  assert.deepEqual({ ...b }, { st_tecnica: 'reprovada', st_ia: 'pendente', tier: 'descartar' });
  const n = db.prepare('SELECT st_ia, st_embedding, espaco, local FROM assets WHERE id = ?').get(nitida);
  assert.deepEqual({ ...n }, { st_ia: 'ok', st_embedding: 'ok', espaco: 'Deck', local: 'Casa Exemplo' });
  assert.equal(db.prepare('SELECT count(*) c FROM vec_texto').get().c, 1);
});

test('erro da IA fica registrado e é retomado com refazerErros', async () => {
  const { db, dir, nitida } = await preparar();
  const falha = { chat: async () => { throw new Error('OpenRouter 402: sem crédito'); }, embed: async () => [] };
  await processar(db, { dirDados: dir, cliente: falha, modeloDescricao: 'g', modeloEmbedding: 'e' });
  assert.deepEqual({ ...db.prepare('SELECT st_ia, erro FROM assets WHERE id = ?').get(nitida) }, { st_ia: 'erro', erro: 'OpenRouter 402: sem crédito' });

  const ok = { chat: async () => JSON.stringify(analise), embed: async (m, t) => t.map(() => new Float32Array(1536)) };
  const r = await processar(db, { dirDados: dir, cliente: ok, modeloDescricao: 'g', modeloEmbedding: 'e', refazerErros: true });
  assert.deepEqual(r.ia, { ok: 1, erro: 0 });
});

test('limite corta quantas fotos vão para a IA', async () => {
  const { db, dir } = await preparar();
  db.prepare("UPDATE assets SET st_tecnica = 'ok'").run();
  const cliente = { chat: async () => JSON.stringify(analise), embed: async (m, t) => t.map(() => new Float32Array(1536)) };
  const r = await processar(db, { dirDados: dir, cliente, modeloDescricao: 'g', modeloEmbedding: 'e', limite: 1 });
  assert.deepEqual(r.ia, { ok: 1, erro: 0 });
});

test('texto do embedding leva o nome do evento e o caminho da pasta', () => {
  const t = textoParaEmbedding({ titulo: 'Mesa posta', evento_pasta: 'CLARA E BRUNO / 2026', caminho_pasta: 'CASAMENTOS/2. CASAMENTOS/CLARA E BRUNO / 2026/P&B' });
  assert.match(t, /CLARA E BRUNO/);
  assert.match(t, /CASAMENTOS\/2\. CASAMENTOS/);
});
