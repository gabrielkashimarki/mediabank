const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');

async function subir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mcp-'));
  for (const t of ['thumb', 'preview']) fs.mkdirSync(path.join(dir, 'midia', t), { recursive: true });
  const db = abrirBanco(':memory:');
  const add = (id, campos) => {
    const base = { id, origem: 'local', md5: id, phash: '0', espaco: 'Deck', ...campos };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
    for (const t of ['thumb', 'preview']) fs.writeFileSync(path.join(dir, 'midia', t, `${id}.jpg`), 'jpg');
  };
  add('liberada', { aprovacao: 'aprovada', tem_crianca: 0, tem_pessoa: 0, titulo: 'Deck à noite' });
  add('crianca', { aprovacao: 'aprovada', tem_crianca: 1, tem_pessoa: 1 });
  add('pendente', { aprovacao: 'pendente', tem_crianca: 0, tem_pessoa: 0 });
  add('descartada', { aprovacao: 'aprovada', tem_crianca: 0, tem_pessoa: 0, tier: 'descartar' });
  const chave = criarChave(db, 'mcp-teste');
  const lote = criarChave(db, 'lote');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/mcp`;
  const rpc = (method, params, k = chave) => fetch(`${base}/${k}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { srv, rpc, base, chave, lote };
}

test('chave errada ou do trabalhador devolve 401', async () => {
  const { srv, rpc, lote } = await subir();
  assert.equal((await rpc('tools/list', {}, 'mb_errada')).status, 401);
  assert.equal((await rpc('tools/list', {}, lote)).status, 401);
  srv.close();
});

test('initialize e tools/list respondem no formato do MCP', async () => {
  const { srv, rpc } = await subir();
  const ini = await (await rpc('initialize', { protocolVersion: '2025-06-18' })).json();
  assert.equal(ini.result.protocolVersion, '2025-06-18');
  assert.ok(ini.result.capabilities.tools);
  const lista = await (await rpc('tools/list', {})).json();
  // fase 2: as de vídeo entram depois das de foto, que não mudaram
  assert.deepEqual(lista.result.tools.map(t => t.name), ['buscar_fotos', 'ver_foto', 'buscar_videos', 'ver_video', 'ler_guia', 'pedir_trecho']);
  srv.close();
});

test('acervo do dono: pendente aparece; criança e descartada nunca', async () => {
  const { srv, rpc, base, chave } = await subir();
  const busca = await (await rpc('tools/call', { name: 'buscar_fotos', arguments: { consulta: 'deck', sem_pessoas: false } })).json();
  const [texto, ...resto] = busca.result.content;
  assert.deepEqual(JSON.parse(texto.text).map(f => f.id).sort(), ['liberada', 'pendente']);
  assert.ok(resto.some(c => c.type === 'image'));
  const ver = await (await rpc('tools/call', { name: 'ver_foto', arguments: { id: 'crianca' } })).json();
  assert.equal(ver.result.isError, true);
  assert.equal((await fetch(`${base}/${chave}/original/crianca`)).status, 404);
  srv.close();
});

test('notificação devolve 202 e GET devolve 405', async () => {
  const { srv, base, chave } = await subir();
  const notif = await fetch(`${base}/${chave}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notif.status, 202);
  assert.equal((await fetch(`${base}/${chave}`)).status, 405);
  srv.close();
});
