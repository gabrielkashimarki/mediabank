const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { abrirBanco } = require('../src/db');
const { ingerirArquivo, phash, hamming } = require('../src/ingestao');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));

async function foto(nome, opcoes = {}) {
  const p = path.join(tmp, nome);
  await sharp({ create: { width: 2000, height: 1200, channels: 3, background: '#806040', noise: { type: 'gaussian', mean: 120, sigma: 40 } } })
    .jpeg(opcoes).toFile(p);
  return p;
}

test('ingere foto, gera thumb e preview e ignora duplicata', async () => {
  const db = abrirBanco(':memory:');
  const p = await foto('a.jpg');
  const r1 = await ingerirArquivo(db, p, { dirDados: tmp });
  assert.equal(r1.novo, true);
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(r1.id);
  assert.equal(a.largura, 2000);
  assert.equal(a.st_tecnica, 'pendente');
  assert.equal(a.tem_crianca, 1);
  const thumb = await sharp(path.join(tmp, 'midia/thumb', `${r1.id}.jpg`)).metadata();
  assert.equal(thumb.width, 600);
  const prev = await sharp(path.join(tmp, 'midia/preview', `${r1.id}.jpg`)).metadata();
  assert.equal(prev.width, 1600);

  const r2 = await ingerirArquivo(db, p, { dirDados: tmp });
  assert.deepEqual(r2, { id: r1.id, novo: false });
});

// ruído puro não tem estrutura para o dHash; a cena precisa de formas
const cena = (cor) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
  <rect width="1600" height="1000" fill="#223"/><circle cx="500" cy="450" r="300" fill="${cor}"/>
  <rect x="1000" y="200" width="400" height="600" fill="#eee"/></svg>`);

test('phash quase igual para a mesma foto recomprimida e distante para outra cena', async () => {
  const a = await sharp(cena('#d8a94a')).jpeg({ quality: 95 }).toBuffer();
  const aPequena = await sharp(a).resize(800).jpeg({ quality: 40 }).toBuffer();
  const listras = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
    ${Array.from({ length: 16 }, (_, i) => `<rect x="${i * 100}" width="50" height="1000" y="${(i % 3) * 150}" fill="#fff"/>`).join('')}</svg>`);
  const outra = await sharp(listras).flatten({ background: '#000' }).jpeg().toBuffer();
  assert.ok(hamming(await phash(a), await phash(aPequena)) <= 6);
  assert.ok(hamming(await phash(a), await phash(outra)) > 16);
});

test('arquivo já importado é pulado pelo caminho, sem ler de novo', async () => {
  const db = abrirBanco(':memory:');
  const p = await foto('c.jpg');
  const r1 = await ingerirArquivo(db, p, { dirDados: tmp });
  fs.rmSync(p);
  assert.deepEqual(await ingerirArquivo(db, p, { dirDados: tmp }), { id: r1.id, novo: false });
});

test('HEIC é convertido pelo sips', { skip: process.platform !== 'darwin' }, async () => {
  const db = abrirBanco(':memory:');
  const jpg = await foto('d.jpg');
  const heic = path.join(tmp, 'd.heic');
  require('node:child_process').execFileSync('sips', ['-s', 'format', 'heic', jpg, '--out', heic], { stdio: 'ignore' });
  const r = await ingerirArquivo(db, heic, { dirDados: tmp });
  const a = db.prepare('SELECT largura, formato FROM assets WHERE id = ?').get(r.id);
  assert.equal(a.largura, 2000);
  const thumb = await sharp(path.join(tmp, 'midia/thumb', `${r.id}.jpg`)).metadata();
  assert.equal(thumb.width, 600);
});

