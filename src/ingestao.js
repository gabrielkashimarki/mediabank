const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
// No container de 512-768 MB, foto de câmera (24+ MP) com o cache e as threads padrão do libvips estoura a memória (OOM, exit 137).
sharp.cache(false);
sharp.concurrency(1);
const exifr = require('exifr');
const { PADRAO, validar } = require('./clientes');

// dHash de 64 bits em hex: resistente a redimensionar e recomprimir
async function phash(entrada) {
  const px = await sharp(entrada).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

async function lerExif(buffer) {
  try {
    const e = await exifr.parse(buffer, ['DateTimeOriginal', 'Make', 'Model', 'LensModel', 'ISO', 'FNumber', 'ExposureTime', 'FocalLength']);
    if (!e) return {};
    return {
      data_foto: e.DateTimeOriginal instanceof Date ? e.DateTimeOriginal.toISOString() : null,
      camera: [e.Make, e.Model].filter(Boolean).join(' ') || null,
      lente: e.LensModel || null,
      iso: e.ISO ?? null,
      abertura: e.FNumber ?? null,
      velocidade: e.ExposureTime ? (e.ExposureTime < 1 ? `1/${Math.round(1 / e.ExposureTime)}` : String(e.ExposureTime)) : null,
      focal: e.FocalLength ?? null,
    };
  } catch {
    return {};
  }
}

// O sharp pré-compilado não decodifica HEIC (patente do HEVC). No Mac o sips converte;
// no Linux (imagem Docker) o heif-convert, do pacote libheif-examples.
function paraDecodificar(caminho, original) {
  if (!/\.hei[cf]$/i.test(caminho)) return original;
  const tmp = path.join(os.tmpdir(), `mb-${crypto.randomUUID()}.jpg`);
  if (process.platform === 'darwin') execFileSync('sips', ['-s', 'format', 'jpeg', caminho, '--out', tmp], { stdio: 'ignore' });
  else execFileSync('heif-convert', ['-q', '90', caminho, tmp], { stdio: 'ignore' });
  try { return fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

// Grava thumb (600px) e preview (1600px) em dirDados/midia e registra o asset.
// Caminho ou md5 já conhecidos não são reprocessados.
// caminhoOrigem: o que fica gravado como origem (ex.: drive:<id>) quando o arquivo lido é temporário
async function ingerirArquivo(db, caminho, { dirDados, origem = 'local', driveId = null, caminhoOrigem = caminho, pastaId = null, cliente = PADRAO }) {
  // carga interrompida: pula pelo caminho antes de ler, senão o Drive em streaming baixa tudo de novo
  // ponytail: arquivo editado no mesmo caminho não é relido; o sync do Drive (plano 4) trata mudança pelo drive_id
  const visto = db.prepare('SELECT id FROM assets WHERE caminho_origem = ?').get(caminhoOrigem);
  if (visto) return { id: visto.id, novo: false };

  const original = fs.readFileSync(caminho);
  const md5 = crypto.createHash('md5').update(original).digest('hex');
  const existente = db.prepare('SELECT id FROM assets WHERE md5 = ?').get(md5);
  if (existente) return { id: existente.id, novo: false };

  const buffer = paraDecodificar(caminho, original);
  const id = crypto.randomUUID();
  const img = sharp(buffer).rotate();
  const meta = await img.metadata();
  const girada = meta.orientation >= 5;
  for (const [pasta, lado] of [['thumb', 600], ['preview', 1600]]) {
    const dir = path.join(dirDados, 'midia', pasta);
    fs.mkdirSync(dir, { recursive: true });
    await img.clone().resize(lado, lado, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(dir, `${id}.jpg`));
  }

  const linha = {
    id, cliente_id: validar(cliente), origem, caminho_origem: caminhoOrigem, drive_id: driveId, md5,
    pasta_id: pastaId,
    phash: await phash(buffer),
    largura: girada ? meta.height : meta.width,
    altura: girada ? meta.width : meta.height,
    formato: meta.format,
    ...(await lerExif(original)),
  };
  const cols = Object.keys(linha);
  db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(linha);
  return { id, novo: true };
}

module.exports = { ingerirArquivo, phash, hamming };
