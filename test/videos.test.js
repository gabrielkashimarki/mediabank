const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { sincronizar, registrarVideo } = require('../src/sync');

const video = (id, extra = {}) => ({
  id, name: `${id}.mp4`, mimeType: 'video/mp4', md5Checksum: `m${id}`, size: '1000', parents: ['P1'], createdTime: '2026-08-27T20:00:00Z',
  videoMediaMetadata: { width: 2160, height: 3840, durationMillis: '12500' }, ...extra,
});

function driveFalso({ videos = [], mudancas = [] } = {}) {
  const baixados = [];
  return {
    baixados,
    async *imagens() {},
    async *videos() { yield* videos; },
    async tokenInicial() { return 't1'; },
    async mudancas(desde) { return { arquivos: mudancas, novoToken: desde + '+' }; },
    async baixar(id) { baixados.push(id); throw new Error('não deveria baixar vídeo'); },
  };
}

test('vídeo entra como registro, sem download, com duração, orientação e pasta do Drive', () => {
  const db = abrirBanco(':memory:');
  assert.equal(registrarVideo(db, video('V1')), 'novo');
  const a = db.prepare("SELECT * FROM assets WHERE drive_id = 'V1'").get();
  assert.equal(a.tipo_midia, 'video');
  assert.equal(a.cliente_id, 'exemplo');
  assert.equal(a.duracao, 12.5);
  assert.equal(a.orientacao, 'vertical');
  assert.equal(a.pasta_id, 'P1');
  assert.equal(a.st_video, 'pendente');
  assert.equal(a.st_tecnica, 'pendente');
  assert.equal(registrarVideo(db, video('V1')), 'repetido');
  assert.equal(registrarVideo(db, video('V2', { md5Checksum: 'mV1' })), 'repetido'); // cópia do mesmo arquivo
  assert.equal(registrarVideo(db, video('V3', { size: '0' })), 'ignorado'); // upload que falhou
  assert.equal(db.prepare('SELECT count(*) n FROM assets').get().n, 1);
});

test('sem SYNC_VIDEO o sync ignora vídeo; com ele, carga única dos antigos e depois só as mudanças', async () => {
  const db = abrirBanco(':memory:');
  const drive = driveFalso({ videos: [video('A'), video('B')], mudancas: [video('C'), video('X', { trashed: true })] });
  const r0 = await sincronizar(db, drive, {});
  assert.equal(r0.videos, undefined);
  assert.equal(db.prepare("SELECT count(*) n FROM assets WHERE tipo_midia = 'video'").get().n, 0);

  const r1 = await sincronizar(db, drive, { videos: true }); // agora em modo mudanças, com a carga dos antigos
  assert.equal(r1.modo, 'mudancas');
  assert.deepEqual(r1.videos, { novo: 3, repetido: 0, ignorado: 0 });
  const r2 = await sincronizar(db, drive, { videos: true });
  assert.deepEqual(r2.videos, { novo: 0, repetido: 1, ignorado: 0 }); // carga não repete; C volta nas mudanças
  assert.deepEqual(db.prepare("SELECT drive_id FROM assets WHERE tipo_midia = 'video' ORDER BY drive_id").all().map(a => a.drive_id), ['A', 'B', 'C']);
  assert.deepEqual(drive.baixados, []);
});

test('vídeo não entra nas etapas de foto: técnica, IA e curadoria', async () => {
  const { etapaTecnica } = require('../src/pipeline');
  const { recalcular } = require('../src/curadoria');
  const db = abrirBanco(':memory:');
  registrarVideo(db, video('V'));
  db.prepare("UPDATE assets SET st_tecnica = 'ok', st_ia = 'ok'").run();
  assert.equal(await etapaTecnica(db, { dirDados: '/nao/existe' }), 0);
  recalcular(db);
  assert.equal(db.prepare('SELECT count(*) n FROM pontuacao').get().n, 0);
});

// ---- API do trabalhador ----
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');

// quadro com textura (nítido) ou liso (reprovado na nitidez)
const quadro = async (liso = false) => {
  const w = 320, h = 568, px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = liso ? 120 : ((i * 7919) % 251);
  return (await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer()).toString('base64');
};

async function subirLote(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-video-'));
  const db = abrirBanco(':memory:');
  registrarVideo(db, video('V'));
  const id = db.prepare("SELECT id FROM assets WHERE drive_id = 'V'").get().id;
  const chave = criarChave(db, 'lote');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/lote`;
  const req = (rota, { metodo = 'GET', corpo, cru } = {}) => fetch(base + rota, {
    method: metodo, headers: { 'X-API-Key': chave, ...(corpo && { 'Content-Type': 'application/json' }), ...(cru && { 'Content-Type': 'video/mp4' }) },
    body: corpo ? JSON.stringify(corpo) : cru,
  });
  return { db, dir, id, req };
}

test('trabalhador: pega o pendente, entrega cenas e prévia; cena lisa ou tremida reprova', async (t) => {
  const { db, dir, id, req } = await subirLote(t);
  assert.deepEqual((await (await req('/videos/pendentes')).json()).map(v => v.drive_id), ['V']);
  const [ok, liso] = [await quadro(), await quadro(true)];
  const r = await req(`/videos/${id}`, { metodo: 'POST', corpo: {
    meta: { duracao: 12.5, fps: 30, codec: 'hevc', tem_audio: true, largura: 2160, altura: 3840 }, poster: ok, tira: ok,
    cenas: [{ ini: 0, fim: 4, quadro: ok, tremido: 0.4, estetica: 6.1 }, { ini: 4, fim: 8, quadro: liso, tremido: 0.2 }, { ini: 8, fim: 12.5, quadro: ok, tremido: 9 }],
    transcricao: { texto: 'olá deck', segmentos: [{ ini: 1, fim: 2, texto: 'olá' }, { ini: 9, fim: 10, texto: 'deck' }] },
  } });
  assert.deepEqual(await r.json(), { ok: true, cenas: 3, reprovadas: 2 });
  const cenas = db.prepare('SELECT ordem, st_tecnica, transcricao, nota_estetica FROM cenas WHERE asset_id = ? ORDER BY ordem').all(id);
  assert.deepEqual(cenas.map(c => c.st_tecnica), ['ok', 'reprovada', 'reprovada']);
  assert.deepEqual(cenas.map(c => c.transcricao), ['olá', null, 'deck']);
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  assert.equal(a.st_video, 'ok');
  assert.equal(a.st_tecnica, 'ok');
  assert.equal(a.st_ia, 'pendente');
  assert.equal(a.codec, 'hevc');
  assert.equal(a.nota_estetica, 6.1);
  for (const f of ['thumb', 'preview', 'tira']) assert.ok(fs.existsSync(path.join(dir, 'midia', f, `${id}.jpg`)), f);
  assert.ok(fs.existsSync(path.join(dir, 'midia', 'cena', `${id}-002.jpg`)));
  assert.deepEqual(await (await req('/videos/pendentes')).json(), []);

  assert.equal((await req(`/videos/${id}/previa`, { metodo: 'PUT', cru: Buffer.from('mp4 de mentira') })).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'midia', 'previa', `${id}.mp4`), 'utf8'), 'mp4 de mentira');
  assert.equal(db.prepare('SELECT previa FROM assets WHERE id = ?').get(id).previa, 1);
});

test('trabalhador: entrega sem cena é recusada; erro marca o vídeo', async (t) => {
  const { db, id, req } = await subirLote(t);
  assert.equal((await req(`/videos/${id}`, { metodo: 'POST', corpo: { poster: await quadro(), tira: await quadro(), cenas: [] } })).status, 400);
  assert.equal((await req(`/videos/${id}/erro`, { metodo: 'POST', corpo: { erro: 'ffprobe falhou' } })).status, 200);
  assert.equal(db.prepare('SELECT st_video, erro FROM assets WHERE id = ?').get(id).erro, 'video: ffprobe falhou');
});

test('tarefa de trecho: pendente vira andando, o arquivo volta e ela fica pronta', async (t) => {
  const { db, dir, id, req } = await subirLote(t);
  const tid = db.prepare(`INSERT INTO tarefas (cliente_id, tipo, asset_id, parametros, criado_por) VALUES ('exemplo', 'trecho', ?, '{"ini":1,"fim":3}', 'usuario:1')`).run(id).lastInsertRowid;
  const fila = await (await req('/tarefas/pendentes')).json();
  assert.deepEqual(fila.map(f => [f.id, f.drive_id, f.parametros.fim]), [[tid, 'V', 3]]);
  assert.deepEqual(await (await req('/tarefas/pendentes')).json(), []); // já está andando
  assert.equal((await req(`/tarefas/${tid}/arquivo`, { metodo: 'PUT', cru: Buffer.from('trecho') })).status, 200);
  const tarefa = db.prepare('SELECT estado, arquivo FROM tarefas WHERE id = ?').get(tid);
  assert.equal(tarefa.estado, 'pronta');
  assert.equal(fs.readFileSync(path.join(dir, 'midia', tarefa.arquivo), 'utf8'), 'trecho');
});

// ---- IA por grade, embeddings de texto e de imagem ----
const video_ = require('../src/video');

const analiseBoa = n => ({
  titulo: 'Brinde no deck', descricao: 'x'.repeat(250), legenda: 'Brinde.', alt: 'Convidados brindando no deck', espaco: 'Deck',
  tipo_evento: 'Casamento', tipo: 'Pessoas', luz_tipo: 'Noturna', luz_direcao: 'Frontal', plano: 'Médio', altura_camera: 'Olho',
  composicao: 'Centralizada', ponto_vista: 'Frontal', profundidade: 'Média', posicao_assunto: 'Centro', sazonal: 'Nenhum', tratamento: 'Quente',
  tem_crianca: false, qtd_rostos: 4, rostos_identificaveis: true, marca_terceiro: false, tem_texto: false, indesejados: [],
  capacidade_estimada: null, perguntas_que_responde: ['Como é a festa no deck?'], espaco_para_texto: false,
  decoracao: { estilo: 'rústico', cores: [], flores: true, iluminacao_cenica: true },
  qualidade: { assunto: 7, enquadramento: 7, composicao: 7, luz: 6, limpeza: 6, momento: 8 }, problemas: [], veredito: 'bom para social', destinos_sugeridos: ['social'],
  cenas: Array.from({ length: n }, (_, i) => ({ n: i + 1, descricao: `cena ${i + 1}`, qualidade: { assunto: 8, enquadramento: 6, composicao: 7, luz: 7, limpeza: 7, momento: 9 } })),
});

async function videoProcessado(n, { reprovadas = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-video-ia-'));
  fs.mkdirSync(path.join(dir, 'midia', 'cena'), { recursive: true });
  const db = abrirBanco(':memory:');
  registrarVideo(db, video('V'));
  const id = db.prepare("SELECT id FROM assets WHERE drive_id = 'V'").get().id;
  db.prepare("UPDATE assets SET st_video = 'ok', st_tecnica = 'ok', st_ia = 'pendente', st_embedding = 'pendente', st_quadros = 'pendente', transcricao = 'saúde!' WHERE id = ?").run(id);
  const jpg = Buffer.from(await quadro(), 'base64');
  for (let i = 0; i < n; i++) {
    const cid = `${id}-${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(dir, 'midia', 'cena', `${cid}.jpg`), jpg);
    db.prepare('INSERT INTO cenas (id, asset_id, cliente_id, ordem, ini, fim, st_tecnica) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cid, id, 'exemplo', i, i, i + 1, reprovadas.includes(i) ? 'reprovada' : 'ok');
  }
  return { db, dir, id };
}

test('grade numera os quadros e cabe em células de 384 px', async () => {
  const jpg = Buffer.from(await quadro(), 'base64');
  const meta = await sharp(await video_.montarGrade(Array(5).fill(jpg))).metadata();
  assert.deepEqual([meta.width, meta.height], [3 * 384, 2 * 384]);
  assert.match(video_.montarPromptVideo(5, 'olá'), /GRADE com 5 quadros[\s\S]*olá[\s\S]*- cenas: lista com 5/);
});

test('cena que a IA esqueceu ou com nota inválida fica sem rubrica, sem derrubar o vídeo', () => {
  const r = video_.validarCenas([{ n: 1, descricao: 'a', qualidade: { assunto: 8, enquadramento: 8, composicao: 8, luz: 8, limpeza: 8, momento: 8 } }, { n: 3, qualidade: { assunto: 11 } }], 3);
  assert.deepEqual(r.map(c => c.nota_rubrica), [8, null, null]);
  assert.equal(r[0].descricao, 'a');
});

test('IA do vídeo: uma grade até 16 cenas, mais grades só de cenas; reprovada no portão fica fora', async () => {
  const { db, dir, id } = await videoProcessado(21, { reprovadas: [0] }); // 20 cenas ok: grades de 16 e 4
  const pedidos = [];
  const cliente = {
    async chat(modelo, msgs) {
      const texto = msgs[0].content[1].text;
      pedidos.push(texto);
      const n = Number(texto.match(/GRADE com (\d+) quadros/)[1]);
      return JSON.stringify(pedidos.length === 1 ? analiseBoa(n) : { cenas: analiseBoa(n).cenas });
    },
  };
  assert.deepEqual(await video_.etapaIaVideo(db, { dirDados: dir, cliente, modelo: 'm' }), { ok: 1, erro: 0 });
  assert.equal(pedidos.length, 2);
  assert.match(pedidos[0], /Fala transcrita do vídeo: """saúde!"""/);
  assert.match(pedidos[1], /as cenas 17 a 20/);
  const a = db.prepare('SELECT titulo, espaco, local, st_ia, tem_crianca FROM assets WHERE id = ?').get(id);
  assert.deepEqual({ ...a }, { titulo: 'Brinde no deck', espaco: 'Deck', local: 'Casa Exemplo', st_ia: 'ok', tem_crianca: 0 });
  const cenas = db.prepare('SELECT ordem, descricao, nota_rubrica FROM cenas WHERE asset_id = ? ORDER BY ordem').all(id);
  assert.equal(cenas[0].descricao, null); // reprovada no portão: nem foi para a IA
  assert.equal(cenas[1].descricao, 'cena 1');
  assert.equal(cenas[17].descricao, 'cena 1'); // primeira da segunda grade
  assert.equal(cenas[1].nota_rubrica, 7.3); // (25·8 + 20·6 + 15·7 + 15·7 + 15·7 + 10·9) / 100 = 7,25
});

test('embedding: um vetor de texto do vídeo e um por cena; vetor de imagem por quadro, cortado na dimensão pedida', async () => {
  const { db, dir, id } = await videoProcessado(3);
  db.prepare("UPDATE assets SET st_ia = 'ok', titulo = 'Brinde' WHERE id = ?").run(id);
  db.prepare("UPDATE cenas SET descricao = 'brinde ' || ordem").run();
  const textos = [];
  const um = (k, dim) => { const v = new Float32Array(dim); v[k % dim] = 3; v[(k + 1) % dim] = 4; return v; };
  const cliente = {
    async embed(modelo, entradas, extra = {}) {
      if (modelo === 'texto') { textos.push(...entradas); return entradas.map((_, k) => um(k, 1536)); }
      assert.equal(extra.dimensions, 768);
      return entradas.map((e, k) => { assert.equal(e.content[0].type, 'image_url'); return um(k, 3072); }); // API ignorou dimensions
    },
  };
  assert.equal(await video_.etapaEmbeddingVideo(db, { cliente, modelo: 'texto' }), 1);
  assert.equal(textos.length, 4);
  assert.match(textos[1], /^brinde 0\nBrinde/);
  assert.equal(db.prepare('SELECT count(*) n FROM vec_cena').get().n, 3);
  assert.equal(db.prepare("SELECT st_embedding FROM assets WHERE id = ?").get(id).st_embedding, 'ok');

  assert.deepEqual(await video_.etapaQuadros(db, { dirDados: dir, cliente, modelo: 'imagem', dim: 768 }), { ok: 1, erro: 0 });
  const v = new Float32Array(db.prepare('SELECT vetor FROM emb_quadro ORDER BY cena_id LIMIT 1').get().vetor.buffer.slice(0));
  assert.equal(v.length, 768);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6); // renormalizado
});

// ---- nota de take e grupos ----
const { recalcularTakes } = require('../src/takes');

test('nota de take: melhor estética, rubrica e técnica sobe; take repetido da mesma pasta vira grupo', () => {
  const db = abrirBanco(':memory:');
  const vet = (k, ruido = 0) => { const v = new Float32Array(768); v[k] = 1; v[k + 1] = ruido; let n = Math.hypot(1, ruido); return Buffer.from(v.map(x => x / n).buffer); };
  const add = (id, quando, cenas) => {
    registrarVideo(db, video(id, { createdTime: quando }));
    const aid = db.prepare('SELECT id FROM assets WHERE drive_id = ?').get(id).id;
    db.prepare("UPDATE assets SET st_video = 'ok', st_tecnica = 'ok', st_ia = 'ok', data_foto = ? WHERE id = ?").run(quando, aid);
    cenas.forEach((c, i) => {
      const cid = `${id}-${i}`;
      db.prepare(`INSERT INTO cenas (id, asset_id, cliente_id, ordem, ini, fim, phash, nota_nitidez, nota_exposicao, nota_tremido, nota_estetica, nota_rubrica, st_tecnica)
        VALUES (?, ?, 'exemplo', ?, 0, 1, ?, ?, 128, ?, ?, ?, ?)`).run(cid, aid, i, c.phash, c.nit, c.tre, c.est, c.rub, c.st || 'ok');
      if (c.v) db.prepare('INSERT INTO emb_quadro VALUES (?, ?)').run(cid, c.v);
    });
  };
  // A e B: o mesmo plano gravado duas vezes, com 2 min de diferença; B saiu melhor
  add('A', '2026-08-27T20:00:00Z', [{ phash: 'ff00ff00ff00ff00', nit: 100, tre: 1.0, est: 5, rub: 5, v: vet(0, 0.1) }]);
  add('B', '2026-08-27T20:02:00Z', [{ phash: 'ff00ff00ff00ff01', nit: 300, tre: 0.2, est: 7, rub: 8, v: vet(0, 0.2) }]);
  // C: mesma pasta, mesmo horário, outro plano (quadro diferente); D: plano igual, mas uma hora depois
  add('C', '2026-08-27T20:03:00Z', [{ phash: '00ff00ff00ff00ff', nit: 200, tre: 0.5, est: 6, rub: 6, v: vet(10) }]);
  add('D', '2026-08-27T21:30:00Z', [{ phash: 'ff00ff00ff00ff00', nit: 50, tre: 0.1, est: 4, rub: 4, v: vet(0, 0.1) }, { phash: '0', nit: 1, tre: 9, est: 1, rub: 1, st: 'reprovada' }]);
  assert.deepEqual(recalcularTakes(db), { cenas: 4, grupos: 1 });
  const c = Object.fromEntries(db.prepare('SELECT id, nota_take, take_grupo FROM cenas').all().map(x => [x.id, x]));
  assert.ok(c['B-0'].nota_take > c['C-0'].nota_take && c['C-0'].nota_take > c['A-0'].nota_take && c['A-0'].nota_take > c['D-0'].nota_take);
  assert.equal(c['B-0'].nota_take, 10);
  assert.equal(c['A-0'].take_grupo, c['B-0'].take_grupo);
  assert.ok(c['A-0'].take_grupo);
  assert.equal(c['C-0'].take_grupo, null);
  assert.equal(c['D-0'].take_grupo, null);
  assert.equal(c['D-1'].nota_take, null); // reprovada no portão
});

// ---- busca de vídeo, API v2, painel e MCP ----
const { criarUsuario } = require('../src/auth');
const um = (k, dim) => { const v = new Float32Array(dim); v[k] = 1; return v; };

async function subirBusca(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-vbusca-'));
  for (const d of ['thumb', 'tira', 'cena', 'previa']) fs.mkdirSync(path.join(dir, 'midia', d), { recursive: true });
  const db = abrirBanco(':memory:');
  const jpg = Buffer.from(await quadro(), 'base64');
  // V1: brinde (cena 0) e bolo (cena 1); V2: só bolo, take repetido da cena 1 de V1, com nota menor
  const add = (drive, cenas, campos = {}) => {
    registrarVideo(db, video(drive));
    const id = db.prepare('SELECT id FROM assets WHERE drive_id = ?').get(drive).id;
    db.prepare(`UPDATE assets SET st_video = 'ok', st_tecnica = 'ok', st_ia = 'ok', titulo = ?, espaco = 'Deck', tem_crianca = 0, previa = 1, aprovacao = ?, duracao = 12.5 WHERE id = ?`)
      .run(`vídeo ${drive}`, campos.aprovacao || 'pendente', id);
    for (const f of ['thumb', 'tira']) fs.writeFileSync(path.join(dir, 'midia', f, `${id}.jpg`), jpg);
    fs.writeFileSync(path.join(dir, 'midia', 'previa', `${id}.mp4`), Buffer.alloc(1000, 7));
    cenas.forEach((c, i) => {
      const cid = `${id}-00${i}`;
      db.prepare(`INSERT INTO cenas (id, asset_id, cliente_id, ordem, ini, fim, descricao, nota_take, take_grupo) VALUES (?, ?, 'exemplo', ?, ?, ?, ?, ?, ?)`)
        .run(cid, id, i, i * 4, i * 4 + 4, c.desc, c.nota, c.grupo || null);
      db.prepare('INSERT INTO vec_cena VALUES (?, ?)').run(cid, um(c.eixo, 1536));
      db.prepare('INSERT INTO emb_quadro VALUES (?, ?)').run(cid, Buffer.from(um(c.eixo, 768).buffer));
      fs.writeFileSync(path.join(dir, 'midia', 'cena', `${cid}.jpg`), jpg);
    });
    return id;
  };
  const v1 = add('V1', [{ desc: 'brinde', eixo: 0, nota: 7 }, { desc: 'bolo', eixo: 1, nota: 9, grupo: 'g:x' }]);
  const v2 = add('V2', [{ desc: 'bolo', eixo: 1, nota: 6, grupo: 'g:x' }], { aprovacao: 'aprovada' });
  const embedQuery = async q => um(q.includes('brinde') ? 0 : 1, 1536);
  const embedQuadroQuery = async q => um(q.includes('brinde') ? 0 : 1, 768);
  const chaveV2 = criarChave(db, 'render', { escopo: 'v2' });
  const chaveV1 = criarChave(db, 'site');
  criarUsuario(db, { email: 'e@x.com', nome: 'E', senha: 'senha-longa-1' });
  const srv = criarApp({ db, dirDados: dir, embedQuery, embedQuadroQuery }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = await fetch(`${base}/api/painel/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e@x.com', senha: 'senha-longa-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const painel = (rota, opts = {}) => fetch(`${base}/api/painel${rota}`, { ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...opts.headers } });
  const v2api = (rota, chave = chaveV2, opts = {}) => fetch(`${base}/api/v2${rota}`, { ...opts, headers: { 'X-API-Key': chave, 'Content-Type': 'application/json', ...opts.headers } });
  const rpc = (method, params) => fetch(`${base}/mcp/${chaveV1}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { db, v1, v2, painel, v2api, rpc, chaveV1, base };
}

test('busca de vídeo por cena: a frase acha o trecho certo; do take repetido só vem o melhor', async (t) => {
  const { v1, v2, painel } = await subirBusca(t);
  // tipo=video não vira a faceta tipo das fotos (antes vinha vazio); V2 some porque o único take dele perde no grupo
  assert.equal((await (await painel('/midias?tipo=video')).json()).midias.length, 1);
  const brinde = (await (await painel('/midias?q=brinde&tipo=video')).json()).midias;
  assert.equal(brinde[0].id, v1);
  assert.equal(brinde[0].cenas[0].descricao, 'brinde');
  assert.equal(brinde[0].cenas[0].ini, 0);
  assert.match(brinde[0].cenas[0].quadro_url, /^\/api\/painel\/cenas\/.+\.jpg$/);
  const bolo = (await (await painel('/midias?q=bolo')).json()).midias;
  assert.equal(bolo[0].id, v1); // o bolo de V1 (nota 9) ganha; o de V2 (nota 6, mesmo grupo) some
  assert.deepEqual(bolo.find(v => v.id === v2), undefined);
  const takes = (await (await painel('/takes/g:x')).json()).takes;
  assert.deepEqual(takes.map(c => c.nota_take), [9, 6]);
  const semFrase = (await (await painel('/midias')).json()).midias;
  assert.equal(semFrase[0].cenas[0].nota_take, 9); // sem frase: pelos melhores takes
  const det = await (await painel(`/midias/${v1}`)).json();
  assert.equal(det.cenas.length, 2);
  assert.equal(det.previa_url, `/api/painel/midias/${v1}/previa.mp4`);
});

test('prévia responde Range; quadro e tira só do cliente', async (t) => {
  const { v1, painel } = await subirBusca(t);
  const r = await painel(`/midias/${v1}/previa.mp4`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  assert.equal((await painel(`/midias/${v1}/tira.jpg`)).status, 200);
  assert.equal((await painel(`/cenas/${v1}-000.jpg`)).status, 200);
  assert.equal((await painel('/cenas/x-000.jpg')).status, 404);
  assert.equal((await painel(`/midias/${v1}/../../etc.jpg`)).status, 404);
});

test('API v2: só chave com escopo v2; só vídeo aprovado e liberado; trecho vira tarefa', async (t) => {
  const { v1, v2, v2api, chaveV1, db } = await subirBusca(t);
  assert.equal((await v2api('/midias', chaveV1)).status, 401);
  const lista = (await (await v2api('/midias?q=bolo')).json()).midias;
  assert.deepEqual(lista.map(v => v.id), [v2]); // V1 não está aprovado; com ele fora, o take de V2 é o melhor do grupo que sobra
  assert.equal((await v2api(`/midias/${v1}`)).status, 404);
  // chave da própria equipe (escopo acervo): vê também o que ainda não foi aprovado
  const chaveAcervo = criarChave(db, 'getbrolls', { escopo: 'v2 acervo' });
  assert.equal((await v2api(`/midias/${v1}`, chaveAcervo)).status, 200);
  const ruim = await v2api(`/midias/${v2}/trecho`, undefined, { method: 'POST', body: JSON.stringify({ ini: 5, fim: 2 }) });
  assert.equal(ruim.status, 400);
  const r = await v2api(`/midias/${v2}/trecho`, undefined, { method: 'POST', body: JSON.stringify({ ini: 1, fim: 30, formato: '1080p', vertical: true }) });
  assert.equal(r.status, 202);
  const { tarefa, url } = await r.json();
  const est = await (await v2api(url.replace('/api/v2', ''))).json();
  assert.equal(est.estado, 'pendente');
  assert.deepEqual(est.parametros, { ini: 1, fim: 12.5, formato: '1080p', vertical: true }); // fim cortado na duração
  assert.equal(db.prepare('SELECT criado_por FROM tarefas WHERE id = ?').get(tarefa).criado_por, 'chave:render');
  assert.equal((await v2api(`/tarefas/${tarefa}/arquivo`)).status, 404); // ainda não pronta
});

test('MCP: buscar_videos traz as cenas com quadro; ver_video; pedir_trecho cria a tarefa', async (t) => {
  const { v1, rpc, base, chaveV1 } = await subirBusca(t);
  const busca = (await (await rpc('tools/call', { name: 'buscar_videos', arguments: { consulta: 'brinde' } })).json()).result.content;
  const lista = JSON.parse(busca[0].text);
  assert.equal(lista[0].id, v1); // acervo: pendente de aprovação entra
  assert.equal(lista[0].cenas[0].descricao, 'brinde');
  assert.ok(busca.some(c => c.type === 'image'));
  const ver = (await (await rpc('tools/call', { name: 'ver_video', arguments: { id: v1 } })).json()).result.content;
  assert.equal(JSON.parse(ver[0].text).cenas.length, 2);
  assert.equal(ver[1].type, 'image');
  const pedido = (await (await rpc('tools/call', { name: 'pedir_trecho', arguments: { id: v1, ini: 0, fim: 4 } })).json()).result.content[0].text;
  const link = pedido.match(/(http\S+\/trecho\/\d+)/)[1];
  assert.equal((await fetch(link)).status, 202);
  assert.equal((await fetch(`${base}/mcp/${chaveV1}/trecho/999`)).status, 404);
});

test('coleção automática de evento não puxa vídeo registrado pelo sync', () => {
  const { sincronizarColecoesDeEvento } = require('../src/pastas');
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO pastas (id, nome, caminho, evento, evento_fixo) VALUES ('P1', 'Casamento Ana', 'Casamento Ana', 1, 1)").run();
  db.prepare("INSERT INTO assets (id, origem, md5, phash, pasta_id) VALUES ('foto1', 'drive', 'm1', '0', 'P1')").run();
  registrarVideo(db, video('V9'));
  sincronizarColecoesDeEvento(db);
  assert.deepEqual(db.prepare('SELECT asset_id FROM colecao_fotos').all().map(r => r.asset_id), ['foto1']);
});

test('classificação feita fora (assinatura ou importação): por-drive lista as cenas e analise grava como a IA', async (t) => {
  const { db, dir, id } = await videoProcessado(2);
  const chave = criarChave(db, 'lote');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/lote`;
  const req = (rota, corpo) => fetch(base + rota, { method: corpo ? 'POST' : 'GET', headers: { 'X-API-Key': chave, 'Content-Type': 'application/json' }, body: corpo && JSON.stringify(corpo) });
  const [v] = await (await req('/videos/por-drive?ids=V,naoexiste')).json();
  assert.deepEqual([v.id, v.cenas.length, v.cenas[1].ini], [id, 2, 1]);
  const q = { assunto: 8, enquadramento: 8, composicao: 7, luz: 8, limpeza: 7, momento: 6 };
  const analise = {
    titulo: 'Drink no bar', descricao: 'x'.repeat(250), espaco: 'Bar', tipo_evento: null, tipo: 'Bar', luz_tipo: 'Noturna', luz_direcao: 'Lateral',
    plano: 'Detalhe', altura_camera: 'Olho', composicao: 'Centralizada', ponto_vista: 'Frontal', profundidade: 'Rasa', posicao_assunto: 'Centro',
    sazonal: 'Nenhum', tratamento: 'Quente', tem_crianca: false, qualidade: q, cenas: [{ n: 1, descricao: 'bartender mexe o drink', qualidade: q }],
  };
  assert.equal((await req(`/videos/${id}/analise`, { ...analise, espaco: 'Varanda' })).status, 400);
  assert.equal((await req(`/videos/${id}/analise`, analise)).status, 200);
  const a = db.prepare('SELECT st_ia, st_embedding, titulo, tipo FROM assets WHERE id = ?').get(id);
  assert.deepEqual(a, { st_ia: 'ok', st_embedding: 'pendente', titulo: 'Drink no bar', tipo: 'Bar' });
  assert.deepEqual(db.prepare('SELECT descricao, nota_rubrica FROM cenas WHERE asset_id = ? ORDER BY ordem').all(id).map(c => c.descricao), ['bartender mexe o drink', null]);
});
