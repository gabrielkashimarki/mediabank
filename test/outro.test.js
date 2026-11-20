// Segundo cliente fictício (outro, Marca Exemplo): importação, vocabulário, usos e revisão de peça
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');

const md5 = n => n.toString(16).padStart(32, '0');
const item = (chave, n, extra = {}) => ({ chave, md5: md5(n), fonte: 'pexels', fonte_id: String(1000 + n), fonte_url: `https://www.pexels.com/video/x-${1000 + n}/`,
  licenca: 'pexels', etiquetas: { tema: 'cha', marca: false }, aprovacao: 'ok', ...extra });

async function subir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-outro-'));
  const db = abrirBanco(':memory:');
  const lote = criarChave(db, 'lote');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (rota, { metodo = 'GET', corpo, cru, chave = lote } = {}) => fetch(base + rota, {
    method: metodo, headers: { 'X-API-Key': chave, ...(corpo && { 'Content-Type': 'application/json' }), ...(cru && { 'Content-Type': 'video/mp4' }) },
    body: corpo ? JSON.stringify(corpo) : cru,
  });
  return { db, dir, req, base };
}

test('importação: cria o cliente, guarda origem, licença, tema e status da curadoria; arquivo sobe e o trabalhador baixa', async (t) => {
  const { db, dir, req } = await subir(t);
  const r = await (await req('/api/lote/importar', { metodo: 'POST', corpo: { cliente: 'outro', itens: [
    item('clips2/cha', 1),
    item('clips2/abertura_bact', 2, { etiquetas: { tema: 'abertura' }, aprovacao: 'reprovada', motivo: 'curadoria: figura recortada' }),
    item('v10/clips/d001', 3, { fonte: 'propria', fonte_id: null, fonte_url: null, licenca: 'propria', etiquetas: { tema: 'marca', marca: true } }),
  ] } })).json();
  assert.deepEqual(r.erros, []);
  assert.equal(db.prepare("SELECT nome FROM clientes WHERE id = 'outro'").get().nome, 'Marca Exemplo');
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(r.itens['clips2/abertura_bact'].id);
  assert.deepEqual({ c: a.cliente_id, t: a.tipo_midia, ap: a.aprovacao, m: a.aprovacao_motivo, g: a.origem_grupo, l: a.licenca, e: JSON.parse(a.etiquetas).tema },
    { c: 'outro', t: 'video', ap: 'reprovada', m: 'curadoria: figura recortada', g: 'pexels:1002', l: 'pexels', e: 'abertura' });
  assert.equal(db.prepare('SELECT origem_grupo FROM assets WHERE id = ?').get(r.itens['v10/clips/d001'].id).origem_grupo, 'outro:v10/clips/d001');
  assert.deepEqual(await (await req('/api/lote/videos/pendentes')).json(), []); // sem arquivo ainda

  const id = r.itens['clips2/cha'].id;
  assert.equal((await req(`/api/lote/originais/${id}`, { metodo: 'PUT', cru: Buffer.from('mp4 do chá') })).status, 200);
  // em partes (o Traefik corta requisição de mais de 60 s): só fica completo com fim=1
  const id2 = r.itens['v10/clips/d001'].id;
  assert.equal((await req(`/api/lote/originais/${id2}?parte=1`, { metodo: 'PUT', cru: Buffer.from('x') })).status, 400); // fora de ordem
  assert.deepEqual(await (await req(`/api/lote/originais/${id2}?parte=0`, { metodo: 'PUT', cru: Buffer.from('take ') })).json(), { ok: true, parcial: true });
  assert.deepEqual(await (await req(`/api/lote/originais/${id2}?parte=1&fim=1`, { metodo: 'PUT', cru: Buffer.from('da marca') })).json(), { ok: true });
  assert.equal(await (await req(`/api/lote/videos/${id2}/original`)).text(), 'take da marca');
  assert.deepEqual((await (await req('/api/lote/videos/pendentes?cliente=exemplo')).json()), []); // filtro por cliente
  const pend = (await (await req('/api/lote/videos/pendentes?cliente=outro')).json()).filter(v => v.id === id);
  assert.deepEqual(pend.map(v => [v.id, v.arquivo, v.drive_id]), [[id, true, null]]);
  assert.equal(await (await req(`/api/lote/videos/${id}/original`)).text(), 'mp4 do chá');
  assert.ok(fs.existsSync(path.join(dir, 'originais', 'outro', `${id}.mp4`)));

  // de novo: atualiza status e motivo, não duplica, só pede o arquivo que falta
  const r2 = await (await req('/api/lote/importar', { metodo: 'POST', corpo: { cliente: 'outro', itens: [item('clips2/cha', 1, { aprovacao: 'evitar', motivo: 'muito usado' }), item('outro/igual', 1)] } })).json();
  assert.deepEqual(r2.itens['clips2/cha'], { id, precisa_arquivo: false });
  assert.deepEqual(r2.itens['outro/igual'], { id, precisa_arquivo: false, apelido: true }); // mesmo arquivo, outro nome: apelido
  assert.equal(require('../src/usos').resolverMidia(db, 'outro', 'outro/igual').id, id);
  assert.equal(db.prepare('SELECT aprovacao FROM assets WHERE id = ?').get(id).aprovacao, 'evitar');
  assert.equal(db.prepare("SELECT count(*) n FROM assets WHERE cliente_id = 'outro'").get().n, 3);
});

test('importação recusa cliente desconhecido e chave sem escopo lote', async (t) => {
  const { db, req } = await subir(t);
  assert.equal((await req('/api/lote/importar', { metodo: 'POST', corpo: { cliente: 'nada', itens: [item('a', 1)] } })).status, 400);
  const outra = criarChave(db, 'render', { escopo: 'v2' });
  assert.equal((await req('/api/lote/importar', { metodo: 'POST', chave: outra, corpo: { cliente: 'outro', itens: [item('a', 1)] } })).status, 401);
});

test('IA do outro cliente usa o prompt e as listas dela; tema da curadoria vale mais que o da IA', async () => {
  const video = require('../src/video');
  const sharp = require('sharp');
  const db = abrirBanco(':memory:');
  require('../src/clientes').registrar(db, require('../src/vocabularios/outro'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-outro-ia-'));
  fs.mkdirSync(path.join(dir, 'midia', 'cena'), { recursive: true });
  db.prepare(`INSERT INTO assets (id, cliente_id, tipo_midia, origem, md5, phash, st_video, st_tecnica, st_ia, etiquetas)
    VALUES ('g1', 'outro', 'video', 'importacao', ?, '', 'ok', 'ok', 'pendente', '{"tema":"abertura","marca":false}')`).run(md5(9));
  db.prepare("INSERT INTO cenas (id, asset_id, cliente_id, ordem, ini, fim) VALUES ('g1-000', 'g1', 'outro', 0, 0, 4)").run();
  await sharp({ create: { width: 90, height: 160, channels: 3, background: '#a33' } }).jpeg().toFile(path.join(dir, 'midia', 'cena', 'g1-000.jpg'));
  let prompt;
  const cliente = { async chat(m, msgs) { prompt = msgs[0].content[1].text; return JSON.stringify({
    titulo: 'Modelo anatômico', descricao: 'x'.repeat(100), alt: 'alt', tema: 'laboratorio', emocao: 'neutro', pessoas: 'nenhuma', plano: 'detalhe',
    foto_parada: false, tem_crianca: false, tem_pessoa: false, qtd_rostos: 0, rostos_identificaveis: false, tem_texto: false, marca_terceiro: false,
    qualidade: { assunto: 8, enquadramento: 8, composicao: 8, luz: 8, limpeza: 8, momento: 8 }, cenas: [{ n: 1, descricao: 'modelo girando', qualidade: { assunto: 8, enquadramento: 8, composicao: 8, luz: 8, limpeza: 8, momento: 8 } }],
  }); } };
  assert.deepEqual(await video.etapaIaVideo(db, { dirDados: dir, cliente, modelo: 'm' }), { ok: 1, erro: 0 });
  assert.match(prompt, /Marca Exemplo/);
  assert.doesNotMatch(prompt, /Casa Exemplo/);
  const a = db.prepare("SELECT titulo, tem_crianca, nota_rubrica, etiquetas FROM assets WHERE id = 'g1'").get();
  assert.equal(a.titulo, 'Modelo anatômico');
  assert.equal(a.nota_rubrica, 8);
  assert.deepEqual(JSON.parse(a.etiquetas), { tema: 'abertura', emocao: 'neutro', pessoas: 'nenhuma', plano: 'detalhe', foto_parada: false, marca: false });
});

// ---- usos, regra de não repetir e revisão de peça ----
const { criarUsuario } = require('../src/auth');
const { vincular } = require('../src/clientes');

async function subirRevisao(t) {
  const ctx = await subir(t);
  const { db, req } = ctx;
  const itens = [
    item('clips3/abertura_01', 11, { etiquetas: { tema: 'abertura' } }),
    item('clips3/abertura_02', 12, { etiquetas: { tema: 'abertura' } }),
    item('clips2/cha', 13),
    item('clips2/cha_lento', 14, { fonte_id: '1013' }), // mesma origem que clips2/cha (pexels 1013)
    item('clips2/bolo', 15, { etiquetas: { tema: 'festa' } }),
    item('clips2/bolo2', 16, { etiquetas: { tema: 'festa' } }),
    item('v10/clips/d001', 17, { fonte: 'propria', fonte_id: null, licenca: 'propria', etiquetas: { tema: 'marca', marca: true } }),
    item('clips2/feia', 18, { etiquetas: { tema: 'festa' }, aprovacao: 'reprovada', motivo: 'curadoria: não lê como festa' }),
  ];
  const ids = (await (await req('/api/lote/importar', { metodo: 'POST', corpo: { cliente: 'outro', itens } })).json()).itens;
  const render = criarChave(db, 'render', { cliente: 'outro', escopo: 'v2' });
  const ana = criarUsuario(db, { email: 'ana@x.com', nome: 'Ana', senha: 'senha-longa-1' });
  vincular(db, ana, 'outro', 'editor');
  const login = await fetch(`${ctx.base}/api/painel/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@x.com', senha: 'senha-longa-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const v2 = (rota, opts = {}) => req('/api/v2' + rota, { ...opts, chave: render });
  const painel = (rota, { metodo = 'GET', corpo } = {}) => fetch(`${ctx.base}/api/painel${rota}`, { method: metodo, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: corpo && JSON.stringify(corpo) });
  return { ...ctx, ids, v2, painel };
}

const planos = (...chaves) => chaves.map((midia, plano) => ({ plano, midia, ancora: `palavra${plano}`, ini: plano * 3, fim: plano * 3 + 3 }));

test('regra do outro cliente: abertura só numa peça; o resto até 3; marca livre; mesma origem conta junto; repetir na peça não pode', async (t) => {
  const { v2 } = await subirRevisao(t);
  const put = async (peca, ...ch) => (await v2(`/pecas/${peca}`, { metodo: 'PUT', corpo: { titulo: peca, planos: planos(...ch) } })).json();
  assert.deepEqual((await put('e01', 'clips3/abertura_01', 'clips2/cha', 'v10/clips/d001')).conflitos, []);
  await put('e02', 'clips2/cha', 'v10/clips/d001');
  await put('e03', 'clips2/cha_lento', 'v10/clips/d001'); // mesma origem que clips2/cha: terceira peça, ainda pode
  const r = await put('e04', 'clips3/abertura_01', 'clips2/cha', 'v10/clips/d001', 'clips2/bolo', 'clips2/bolo', 'clips2/feia', 'nao/existe', 'clips2/bolo2', 'v10/clips/d001', 'clips2/feia2', 'clips2/feia3', 'clips2/bolo2');
  assert.deepEqual(r.desconhecidas.map(d => d.plano), [6, 9, 10]);
  assert.deepEqual(r.conflitos.map(c => [c.plano, c.motivo]), [
    [0, 'abertura não repete entre peças: já está em e01'],
    [1, 'já está em 3 peças (máximo 3): e01, e02, e03'],
    [3, 'repete na mesma peça (plano 5)'], // seguidos: parece loop (planos contados a partir de 1)
    [4, 'repete na mesma peça (plano 4)'],
    [5, 'reprovada: curadoria: não lê como festa'],
  ]);
  const conf = await (await v2('/usos/conferir', { metodo: 'POST', corpo: { peca: 'e05', planos: [{ plano: 0, midia: 'clips3/abertura_02' }, { plano: 1, midia: 'clips2/cha' }] } })).json();
  assert.deepEqual(conf.conflitos.map(c => c.plano), [1]);
});

test('revisão: render abre a versão; Ana aprova, reprova marcando no banco e troca respeitando a regra; o projeto puxa as trocas', async (t) => {
  const { db, v2, painel, req, ids } = await subirRevisao(t);
  await v2('/pecas/e01', { metodo: 'PUT', corpo: { planos: planos('clips3/abertura_01', 'clips2/cha', 'clips2/bolo') } });
  await v2('/pecas/e09', { metodo: 'PUT', corpo: { planos: planos('clips3/abertura_02') } });
  const rend = await (await v2('/pecas/e01/render', { metodo: 'PUT', cru: Buffer.from('render v1') })).json();
  assert.equal(rend.versao, 1);
  assert.equal((await (await painel('/pecas')).json()).pecas.find(p => p.id === 'e01').situacao, 'em_revisao');
  assert.equal((await painel('/pecas/e01/render.mp4')).status, 200);

  assert.equal((await painel('/pecas/e01/planos/0/revisao', { metodo: 'POST', corpo: { estado: 'aprovado' } })).status, 200);
  assert.equal((await painel('/pecas/e01/planos/2/revisao', { metodo: 'POST', corpo: { estado: 'reprovado' } })).status, 400); // sem motivo
  await painel('/pecas/e01/planos/2/revisao', { metodo: 'POST', corpo: { estado: 'reprovado', motivo: 'bolo não combina com abertura', marcar: 'evitar' } });
  assert.deepEqual({ ...db.prepare('SELECT aprovacao, aprovacao_motivo FROM assets WHERE id = ?').get(ids['clips2/bolo'].id) },
    { aprovacao: 'evitar', aprovacao_motivo: 'bolo não combina com abertura' });

  // trocar o chá pelo abertura_02 quebra a regra (já está na e09); pelo bolo2 pode
  const ruim = await painel('/pecas/e01/planos/1/revisao', { metodo: 'POST', corpo: { estado: 'trocar', troca: 'clips3/abertura_02' } });
  assert.equal(ruim.status, 409);
  assert.match((await ruim.json()).erro, /abertura não repete entre peças: já está em e09/);
  assert.equal((await painel('/pecas/e01/planos/1/revisao', { metodo: 'POST', corpo: { estado: 'trocar', troca: 'clips2/bolo2' } })).status, 200);
  let p = await (await painel('/pecas/e01')).json();
  assert.equal(p.situacao, 'em_revisao'); // o plano 2 segue reprovado sem troca
  await painel('/pecas/e01/planos/2/revisao', { metodo: 'POST', corpo: { estado: 'trocar', troca: 'v10/clips/d001' } });
  p = await (await painel('/pecas/e01')).json();
  assert.equal(p.situacao, 'aprovada');
  assert.deepEqual(p.planos.map(x => x.decisao.estado), ['aprovado', 'trocar', 'trocar']);

  const trocas = await (await v2('/pecas/e01/trocas')).json();
  assert.deepEqual(trocas.trocas.map(x => [x.plano, x.de, x.para]), [[1, 'clips2/cha', 'clips2/bolo2'], [2, 'clips2/bolo', 'v10/clips/d001']]);
  // render novo: versão 2, revisão recomeça
  assert.equal((await (await v2('/pecas/e01/render', { metodo: 'PUT', cru: Buffer.from('render v2') })).json()).versao, 2);
  assert.ok((await (await painel('/pecas/e01')).json()).planos.every(x => !x.decisao));
  // o original da troca, para o projeto baixar
  await req(`/api/lote/originais/${ids['clips2/bolo2'].id}`, { metodo: 'PUT', cru: Buffer.from('mp4 bolo2') });
  assert.equal(await (await v2(`/midias/${ids['clips2/bolo2'].id}/original`)).text(), 'mp4 bolo2');
});

test('revisão é por cliente: usuário da Casa Exemplo não vê nem decide peça do outro cliente', async (t) => {
  const { db, v2, base } = await subirRevisao(t);
  await v2('/pecas/e01', { metodo: 'PUT', corpo: { planos: planos('clips2/cha') } });
  criarUsuario(db, { email: 'ex@x.com', nome: 'EX', senha: 'senha-longa-1' });
  const login = await fetch(`${base}/api/painel/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ex@x.com', senha: 'senha-longa-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = (rota, opts = {}) => fetch(`${base}/api/painel${rota}`, { ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  assert.deepEqual((await (await r('/pecas')).json()).pecas, []);
  assert.equal((await r('/pecas/e01')).status, 404);
  assert.equal((await r('/pecas/e01/planos/0/revisao', { method: 'POST', body: JSON.stringify({ estado: 'aprovado' }) })).status, 404);
});

// ---- guias (brandbook e playbook) ----
test('guias: editar guarda a versão anterior, restaurar não apaga nada; leitor só lê; MCP lê; outro cliente não vê', async (t) => {
  const { db, painel, v2, base } = await subirRevisao(t);
  const put = (corpo) => painel('/guias/playbook-edicao', { metodo: 'PUT', corpo });
  assert.equal((await put({ titulo: 'Playbook de edição', tipo: 'playbook', conteudo: '# Regras\n- som com propósito' })).status, 200);
  assert.equal((await put({ conteudo: '# Regras\n- som com propósito\n- pausa reflexiva numa pergunta' })).status, 200);
  const g = await (await painel('/guias/playbook-edicao')).json();
  assert.equal(g.versao, 2);
  assert.equal(g.atualizado_por, 'Ana');
  assert.deepEqual((await (await painel('/guias/playbook-edicao/versoes')).json()).versoes.map(v => v.versao), [1]);
  const rest = await (await painel('/guias/playbook-edicao/versoes/1/restaurar', { metodo: 'POST', corpo: {} })).json();
  assert.equal(rest.versao, 3);
  assert.equal(rest.conteudo, '# Regras\n- som com propósito');
  assert.deepEqual((await (await painel('/guias/playbook-edicao/versoes')).json()).versoes.map(v => v.versao), [2, 1]);
  assert.equal((await put({ titulo: 'x', tipo: 'manual', conteudo: 'y' })).status, 400);
  assert.equal((await painel('/guias/Nome Ruim', { metodo: 'PUT', corpo: { titulo: 'x', conteudo: 'y' } })).status, 400);

  // a API v2 do cliente lê e grava (o projeto de edição pode sincronizar o arquivo de lá)
  assert.equal((await (await v2('/guias')).json()).guias[0].slug, 'playbook-edicao');
  assert.equal((await v2('/guias/brandbook', { metodo: 'PUT', corpo: { titulo: 'Marca Exemplo em vídeo', tipo: 'brandbook', formato: 'html', conteudo: '<h1>Marca Exemplo</h1>' } })).status, 200);

  // leitor do outro cliente lê, não edita
  const leitor = criarUsuario(db, { email: 'leitor@x.com', nome: 'L', senha: 'senha-longa-1' });
  vincular(db, leitor, 'outro', 'leitor');
  const ck = (await fetch(`${base}/api/painel/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'leitor@x.com', senha: 'senha-longa-1' }) })).headers.get('set-cookie').split(';')[0];
  const comoLeitor = (rota, opts = {}) => fetch(`${base}/api/painel${rota}`, { ...opts, headers: { Cookie: ck, 'Content-Type': 'application/json' } });
  assert.equal((await comoLeitor('/guias/brandbook')).status, 200);
  assert.equal((await comoLeitor('/guias/brandbook', { method: 'PUT', body: JSON.stringify({ conteudo: 'x' }) })).status, 403);

  // MCP do outro cliente lê; o do exemplo não vê
  const mcpOutro = criarChave(db, 'claude-outro', { cliente: 'outro', escopo: 'mcp' });
  const mcpEx = criarChave(db, 'claude-ex');
  const chamar = async (k, args) => (await (await fetch(`${base}/mcp/${k}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ler_guia', arguments: args } }) })).json()).result;
  assert.match((await chamar(mcpOutro, { slug: 'playbook-edicao' })).content[0].text, /^# Playbook de edição \(versão 3, markdown\)/);
  assert.equal(JSON.parse((await chamar(mcpOutro, {})).content[0].text).length, 2);
  assert.equal((await chamar(mcpEx, {})).content[0].text, 'Este cliente ainda não tem guias.');
  assert.equal((await chamar(mcpEx, { slug: 'brandbook' })).isError, true);
});

test('nota de take é por cliente: o percentil de um não mexe no do outro', () => {
  const { recalcularTakes } = require('../src/takes');
  const db = abrirBanco(':memory:');
  require('../src/clientes').registrar(db, require('../src/vocabularios/outro'));
  const add = (id, cliente, est) => {
    db.prepare(`INSERT INTO assets (id, cliente_id, tipo_midia, origem, md5, phash, st_video, st_tecnica, st_ia) VALUES (?, ?, 'video', 'x', ?, '', 'ok', 'ok', 'ok')`).run(id, cliente, id.padStart(32, '0'));
    db.prepare(`INSERT INTO cenas (id, asset_id, cliente_id, ordem, ini, fim, nota_estetica, nota_rubrica) VALUES (?, ?, ?, 0, 0, 1, ?, ?)`).run(`${id}-0`, id, cliente, est, est);
  };
  add('a1', 'exemplo', 9); add('a2', 'exemplo', 3);
  add('b1', 'outro', 2); add('b2', 'outro', 1);
  recalcularTakes(db, 'exemplo'); recalcularTakes(db, 'outro');
  const nota = id => db.prepare('SELECT nota_take FROM cenas WHERE id = ?').get(`${id}-0`).nota_take;
  assert.equal(nota('b1'), 10); // melhor do outro cliente, mesmo pior que as da Casa Exemplo
  assert.equal(nota('a2'), 0);
});
