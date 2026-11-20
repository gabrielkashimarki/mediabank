const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { abrirBanco } = require('../src/db');
const { sincronizar } = require('../src/sync');

const jpeg = cor => sharp({ create: { width: 1200, height: 900, channels: 3, background: cor } }).jpeg().toBuffer();
const md5 = b => crypto.createHash('md5').update(b).digest('hex');

// Drive falso: arquivos {id, name, mimeType, conteudo}; mudanças configuráveis; conta downloads
function driveFalso(arquivos, { mudancas = [], quebrado = new Set() } = {}) {
  const baixados = [];
  const meta = a => ({ id: a.id, name: a.name, mimeType: a.mimeType || 'image/jpeg', md5Checksum: a.conteudo && md5(a.conteudo), trashed: !!a.trashed, size: a.size ?? (a.conteudo ? String(a.conteudo.length) : '0'), parents: a.parents });
  return {
    baixados,
    async *imagens() { for (const a of arquivos) yield meta(a); },
    async tokenInicial() { return 't1'; },
    async mudancas(desde) { return { arquivos: mudancas.map(meta), novoToken: desde + '+' }; },
    async baixar(id) {
      baixados.push(id);
      if (quebrado.has(id)) return Buffer.from('nao e imagem');
      return [...arquivos, ...mudancas].find(a => a.id === id).conteudo;
    },
  };
}

async function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sync-'));
  const db = abrirBanco(':memory:');
  const a = await jpeg('#a33'), b = await jpeg('#3a3'), c = await jpeg('#33a');
  return { dir, db, a, b, c };
}

test('carga inicial importa, grava origem drive e o token; segunda passada usa mudanças', async () => {
  const { dir, db, a, b, c } = await montar();
  const drive = driveFalso([{ id: 'A', name: 'a.jpg', conteudo: a, parents: ['P1'] }, { id: 'B', name: 'b.jpg', conteudo: b }], { mudancas: [{ id: 'C', name: 'c.jpg', conteudo: c, parents: ['P2'] }, { id: 'X', name: 'x.jpg', conteudo: c, trashed: true }] });
  const r1 = await sincronizar(db, drive, { dirDados: dir });
  assert.deepEqual({ ...r1 }, { novos: 2, repetidos: 0, falhas: 0, ignorados: 0, completo: true, modo: 'inicial' });
  const linha = db.prepare("SELECT origem, drive_id, caminho_origem, pasta_id FROM assets WHERE drive_id = 'A'").get();
  assert.deepEqual({ ...linha }, { origem: 'drive', drive_id: 'A', caminho_origem: 'drive:A', pasta_id: 'P1' });
  assert.equal(db.prepare("SELECT pasta_id FROM assets WHERE drive_id = 'B'").get().pasta_id, null);
  assert.equal(db.prepare("SELECT valor FROM sync_estado WHERE chave = 'drive_token'").get().valor, 't1');
  const r2 = await sincronizar(db, drive, { dirDados: dir });
  assert.equal(r2.modo, 'mudancas');
  assert.equal(r2.novos, 1);
  assert.equal(db.prepare("SELECT valor FROM sync_estado WHERE chave = 'drive_token'").get().valor, 't1+');
});

test('md5 já conhecido não é baixado; limite segura o token até a passada terminar', async () => {
  const { dir, db, a, b, c } = await montar();
  const arquivos = [{ id: 'A', name: 'a.jpg', conteudo: a }, { id: 'A2', name: 'copia.jpg', conteudo: a }, { id: 'B', name: 'b.jpg', conteudo: b }, { id: 'C', name: 'c.jpg', conteudo: c }];
  const drive = driveFalso(arquivos);
  const r1 = await sincronizar(db, drive, { dirDados: dir, limite: 1 });
  assert.equal(r1.completo, false);
  assert.equal(db.prepare("SELECT count(*) n FROM sync_estado WHERE chave = 'drive_token'").get().n, 0);
  const r2 = await sincronizar(db, drive, { dirDados: dir });
  assert.deepEqual([r2.novos, r2.repetidos, r2.completo], [2, 2, true]);
  assert.deepEqual(drive.baixados, ['A', 'B', 'C']);
});

test('arquivo que falha 3 vezes para de ser tentado', async () => {
  const { dir, db } = await montar();
  const drive = driveFalso([{ id: 'Q', name: 'q.jpg', conteudo: Buffer.from('x') }], { quebrado: new Set(['Q']) });
  for (let i = 0; i < 3; i++) assert.equal((await sincronizar(db, drive, { dirDados: dir })).falhas, 1);
  db.prepare("DELETE FROM sync_estado WHERE chave = 'drive_token'").run();
  const r = await sincronizar(db, drive, { dirDados: dir });
  assert.deepEqual([r.falhas, r.ignorados], [0, 1]);
  // pre-counting: 3 falhas = 3 tentativas contadas antes + 0 extras no catch
  assert.equal(db.prepare("SELECT tentativas FROM sync_falhas WHERE drive_id = 'Q'").get().tentativas, 3);
});

test('arquivo com tipo não suportado é ignorado sem baixar', async () => {
  const { dir, db } = await montar();
  const drive = driveFalso([{ id: 'PSD', name: 'foto.psd', mimeType: 'image/vnd.adobe.photoshop', conteudo: Buffer.from('psd') }]);
  const r = await sincronizar(db, drive, { dirDados: dir });
  assert.deepEqual([r.ignorados, r.novos], [1, 0]);
  assert.deepEqual(drive.baixados, []);
  assert.match(db.prepare("SELECT erro FROM sync_falhas WHERE drive_id = 'PSD'").get().erro, /tipo não suportado/);
});

test('arquivo grande demais é ignorado sem baixar', async () => {
  const { dir, db, a } = await montar();
  const drive = driveFalso([{ id: 'BIG', name: 'big.jpg', conteudo: a, size: String(50 * 1024 * 1024) }]);
  const r = await sincronizar(db, drive, { dirDados: dir });
  assert.deepEqual([r.ignorados, r.novos], [1, 0]);
  assert.deepEqual(drive.baixados, []);
  assert.match(db.prepare("SELECT erro FROM sync_falhas WHERE drive_id = 'BIG'").get().erro, /grande demais/);
});

test('foto já importada ganha a pasta pela listagem, sem baixar de novo', async () => {
  const { dir, db, a } = await montar();
  const drive = driveFalso([{ id: 'A', name: 'a.jpg', conteudo: a }]);
  await sincronizar(db, drive, { dirDados: dir });
  db.prepare("UPDATE assets SET pasta_id = NULL WHERE drive_id = 'A'").run();
  db.prepare("DELETE FROM sync_estado WHERE chave = 'drive_token'").run(); // força a listagem inicial de novo
  drive.baixados.length = 0;
  const comPasta = { ...drive, async *imagens() { for await (const f of drive.imagens()) yield { ...f, parents: ['P1'] }; } };
  const r = await sincronizar(db, comPasta, { dirDados: dir });
  assert.equal(r.repetidos, 1);
  assert.deepEqual(drive.baixados, []);
  assert.equal(db.prepare("SELECT pasta_id FROM assets WHERE drive_id = 'A'").get().pasta_id, 'P1');
});
