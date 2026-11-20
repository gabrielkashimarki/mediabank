// Nenhuma rota devolve mídia, coleção ou contagem de outro cliente, e a API v1 e o MCP de fotos não mostram vídeo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');
const { criarUsuario } = require('../src/auth');
const clientes = require('../src/clientes');
const col = require('../src/colecoes');

const vetor = () => { const v = new Float32Array(1536); v[0] = 1; return v; };

async function subir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-iso-'));
  fs.mkdirSync(path.join(dir, 'midia/thumb'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'midia/preview'), { recursive: true });
  const db = abrirBanco(':memory:');
  clientes.registrar(db, { ...clientes.vocabularioDe('exemplo'), id: 'outro', nome: 'Outro',
    MCP: { ...clientes.vocabularioDe('exemplo').MCP, nome: 'mediabank-outro' } });
  const add = (id, cliente, campos = {}) => {
    const base = { id, cliente_id: cliente, origem: 'local', md5: id, phash: '0', espaco: 'Deck', titulo: id, descricao: 'deck',
      aprovacao: 'aprovada', tem_crianca: 0, st_tecnica: 'ok', st_ia: 'ok', ...campos };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
    db.prepare('INSERT INTO vec_texto VALUES (?, ?)').run(id, vetor());
    for (const t of ['thumb', 'preview']) fs.writeFileSync(path.join(dir, 'midia', t, `${id}.jpg`), 'jpg');
  };
  add('ex', 'exemplo');
  add('ex_video', 'exemplo', { tipo_midia: 'video' });
  add('ou', 'outro');
  add('ou2', 'outro', { espaco: 'Bar' });

  const chaveEx = criarChave(db, 'site');
  const chaveOu = criarChave(db, 'outro-app', { cliente: 'outro', escopo: 'v1 mcp' });
  const chaveLote = criarChave(db, 'lote');
  criarUsuario(db, { email: 'ex@x.com', nome: 'EX', senha: 'senha-longa-1' });
  const uOu = criarUsuario(db, { email: 'ou@x.com', nome: 'OU', senha: 'senha-longa-1' });
  const uLeitor = criarUsuario(db, { email: 'leitor@x.com', nome: 'L', senha: 'senha-longa-1' });
  clientes.vincular(db, uOu, 'outro', 'editor');
  clientes.vincular(db, uLeitor, 'outro', 'leitor');
  const adm = criarUsuario(db, { email: 'admin@x.com', nome: 'Admin', senha: 'senha-longa-1', admin: true });
  criarUsuario(db, { email: 'admin-ex@x.com', nome: 'Admin EX', senha: 'senha-longa-1', admin: true }); // admin antigo, sem vínculo
  clientes.vincular(db, adm, 'exemplo', 'admin');
  clientes.vincular(db, adm, 'outro', 'admin');

  const colEx = col.criar(db, { nome: 'Coleção EX' }, { id: 1 }, 'exemplo');
  col.adicionar(db, colEx, ['ex']);
  const colOu = col.criar(db, { nome: 'Coleção OU' }, { id: 1 }, 'outro');
  col.adicionar(db, colOu, ['ou', 'ex']); // ex é de outro cliente: não entra
  const slugOu = col.publicar(db, colOu);

  const srv = criarApp({ db, dirDados: dir, embedQuery: async () => vetor() }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (rota, { cookie, chave, metodo = 'GET', corpo } = {}) => fetch(base + rota, {
    method: metodo,
    headers: { ...(cookie && { Cookie: cookie }), ...(chave && { 'X-API-Key': chave }), ...(corpo !== undefined && { 'Content-Type': 'application/json' }) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const logar = async email => (await req('/api/painel/login', { metodo: 'POST', corpo: { email, senha: 'senha-longa-1' } })).headers.get('set-cookie').split(';')[0];
  const rpc = (chave, method, params) => req(`/mcp/${chave}`, { metodo: 'POST', corpo: { jsonrpc: '2.0', id: 1, method, params } });
  return { db, req, logar, rpc, chaveEx, chaveOu, chaveLote, colEx, colOu, slugOu };
}

const ids = fotos => fotos.map(f => f.id).sort();

test('API v1: cada chave vê só o próprio cliente, e só imagem', async (t) => {
  const { req, chaveEx, chaveOu } = await subir(t);
  assert.deepEqual(ids((await (await req('/api/v1/fotos', { chave: chaveEx })).json()).fotos), ['ex']);
  assert.deepEqual(ids((await (await req('/api/v1/fotos?q=deck', { chave: chaveEx })).json()).fotos), ['ex']);
  assert.deepEqual(ids((await (await req('/api/v1/fotos', { chave: chaveOu })).json()).fotos), ['ou', 'ou2']);
  assert.equal((await req('/api/v1/fotos/ex', { chave: chaveOu })).status, 404);
  assert.equal((await req('/api/v1/fotos/ex_video', { chave: chaveEx })).status, 404);
  assert.equal((await req('/api/v1/midia/thumb/ex.jpg', { chave: chaveOu })).status, 404);
  assert.equal((await req('/api/v1/midia/thumb/ou.jpg', { chave: chaveOu })).status, 200);
  const sug = await (await req('/api/v1/fotos/sugerir', { chave: chaveOu, metodo: 'POST', corpo: { conversa: 'quero ver o deck' } })).json();
  assert.deepEqual(ids(sug.fotos), ['ou', 'ou2']);
});

test('escopo: chave lote não lê a v1 nem o MCP; chave de cliente não entra no lote', async (t) => {
  const { req, rpc, chaveEx, chaveLote } = await subir(t);
  assert.equal((await req('/api/v1/fotos', { chave: chaveLote })).status, 401);
  assert.equal((await rpc(chaveLote, 'tools/list', {})).status, 401);
  assert.equal((await req('/api/lote/pendentes', { chave: chaveEx })).status, 401);
  assert.equal((await req('/api/lote/pendentes', { chave: chaveLote })).status, 200);
});

test('MCP: busca e ver_foto ficam no cliente da chave e só em imagem', async (t) => {
  const { rpc, chaveEx, chaveOu } = await subir(t);
  const busca = async chave => JSON.parse((await (await rpc(chave, 'tools/call', { name: 'buscar_fotos', arguments: { consulta: 'deck', sem_pessoas: false } })).json()).result.content[0].text);
  assert.deepEqual(ids(await busca(chaveEx)), ['ex']);
  assert.deepEqual(ids(await busca(chaveOu)), ['ou', 'ou2']);
  const ver = await (await rpc(chaveOu, 'tools/call', { name: 'ver_foto', arguments: { id: 'ex' } })).json();
  assert.equal(ver.result.isError, true);
  const ini = await (await rpc(chaveOu, 'initialize', {})).json();
  assert.equal(ini.result.serverInfo.name, 'mediabank-outro');
  const iniEx = await (await rpc(chaveEx, 'initialize', {})).json();
  assert.equal(iniEx.result.serverInfo.name, 'mediabank-exemplo');
});

test('painel: usuário de um cliente não lê nem altera o outro', async (t) => {
  const { req, logar, colEx, colOu } = await subir(t);
  const ou = await logar('ou@x.com');
  const eu = await (await req('/api/painel/eu', { cookie: ou })).json();
  assert.equal(eu.cliente, 'outro');
  assert.deepEqual(eu.clientes.map(c => c.id), ['outro']);
  assert.deepEqual(ids((await (await req('/api/painel/fotos', { cookie: ou })).json()).fotos), ['ou', 'ou2']);
  assert.deepEqual((await (await req('/api/painel/facetas', { cookie: ou })).json()).espaco, { Bar: 1, Deck: 1 });
  assert.equal((await req('/api/painel/fotos/ex', { cookie: ou })).status, 404);
  assert.equal((await req('/api/painel/midia/thumb/ex.jpg', { cookie: ou })).status, 404);
  assert.equal((await req('/api/painel/fotos/ex', { cookie: ou, metodo: 'PATCH', corpo: { titulo: 'x' } })).status, 404);
  assert.deepEqual(await (await req('/api/painel/fotos/lote', { cookie: ou, metodo: 'POST', corpo: { ids: ['ex'], campos: { titulo: 'x' } } })).json(), { n: 0 });
  assert.deepEqual((await (await req('/api/painel/colecoes', { cookie: ou })).json()).map(c => c.id), [colOu]);
  assert.equal((await req(`/api/painel/colecoes/${colEx}`, { cookie: ou })).status, 404);
  assert.equal((await req(`/api/painel/colecoes/${colEx}`, { cookie: ou, metodo: 'DELETE' })).status, 404);
  assert.equal((await req(`/api/painel/colecoes/${colEx}/publicar`, { cookie: ou, metodo: 'POST', corpo: {} })).status, 404);
  assert.deepEqual(await (await req(`/api/painel/colecoes/${colOu}/fotos`, { cookie: ou, metodo: 'POST', corpo: { ids: ['ex'] } })).json(), { n: 0 });
  assert.deepEqual(ids((await (await req(`/api/painel/colecoes/${colOu}`, { cookie: ou })).json()).fotos), ['ou']);
  assert.equal((await req('/api/painel/cliente', { cookie: ou, metodo: 'POST', corpo: { id: 'exemplo' } })).status, 403);
});

test('painel: usuário antigo (sem vínculo) fica na Casa Exemplo, mesmo admin; admin com vínculo troca de cliente', async (t) => {
  const { req, logar } = await subir(t);
  const ex = await logar('ex@x.com');
  assert.deepEqual(ids((await (await req('/api/painel/fotos', { cookie: ex })).json()).fotos), ['ex', 'ex_video']);
  const admEx = await logar('admin-ex@x.com');
  assert.deepEqual((await (await req('/api/painel/eu', { cookie: admEx })).json()).clientes.map(c => [c.id, c.papel]), [['exemplo', 'admin']]);
  assert.equal((await req('/api/painel/cliente', { cookie: admEx, metodo: 'POST', corpo: { id: 'outro' } })).status, 403);
  const adm = await logar('admin@x.com');
  assert.equal((await (await req('/api/painel/eu', { cookie: adm })).json()).cliente, 'exemplo');
  assert.equal((await req('/api/painel/cliente', { cookie: adm, metodo: 'POST', corpo: { id: 'outro' } })).status, 200);
  assert.deepEqual(ids((await (await req('/api/painel/fotos', { cookie: adm })).json()).fotos), ['ou', 'ou2']);
});

test('painel: leitor só lê', async (t) => {
  const { req, logar } = await subir(t);
  const l = await logar('leitor@x.com');
  assert.equal((await req('/api/painel/fotos', { cookie: l })).status, 200);
  assert.equal((await req('/api/painel/fotos/ou', { cookie: l, metodo: 'PATCH', corpo: { titulo: 'x' } })).status, 403);
  assert.equal((await req('/api/painel/colecoes', { cookie: l, metodo: 'POST', corpo: { nome: 'x' } })).status, 403);
});

test('link público usa a regra do cliente dono da coleção e não mostra foto de outro', async (t) => {
  const { req, slugOu } = await subir(t);
  assert.deepEqual(ids((await (await req(`/c/${slugOu}/dados`)).json()).fotos), ['ou']);
  assert.equal((await req(`/c/${slugOu}/midia/thumb/ex.jpg`)).status, 404);
  assert.equal((await req(`/c/${slugOu}/midia/thumb/ou.jpg`)).status, 200);
});
