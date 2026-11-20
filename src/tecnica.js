const sharp = require('sharp');

const LIMITES = {
  menorLado: Number(process.env.TEC_MIN_LADO || 800),
  nitidez: Number(process.env.TEC_NITIDEZ_MIN || 30),
  brilhoMin: Number(process.env.TEC_BRILHO_MIN || 20),
  brilhoMax: Number(process.env.TEC_BRILHO_MAX || 235),
};

// Nitidez = maior variância do laplaciano entre 16 blocos. O máximo por bloco
// não pune foto com fundo desfocado de propósito, só a que não tem nada em foco.
async function medir(entrada) {
  const { data, info } = await sharp(entrada).greyscale().resize(512, 512, { fit: 'inside' })
    .raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let soma = 0;
  for (const v of data) soma += v;
  const brilho = soma / data.length;

  const lap = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    lap[i] = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
  }
  let nitidez = 0;
  const bw = Math.floor(w / 4), bh = Math.floor(h / 4);
  for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
    let s = 0, s2 = 0, n = 0;
    for (let y = Math.max(1, by * bh); y < Math.min(h - 1, (by + 1) * bh); y++)
      for (let x = Math.max(1, bx * bw); x < Math.min(w - 1, (bx + 1) * bw); x++) {
        const v = lap[y * w + x]; s += v; s2 += v * v; n++;
      }
    if (n) nitidez = Math.max(nitidez, s2 / n - (s / n) ** 2);
  }
  return { nitidez, brilho };
}

function avaliar({ nitidez, brilho, menorLado }, lim = LIMITES) {
  if (menorLado < lim.menorLado) return 'reprovada';
  if (nitidez < lim.nitidez) return 'reprovada';
  if (brilho < lim.brilhoMin || brilho > lim.brilhoMax) return 'reprovada';
  return 'ok';
}

module.exports = { medir, avaliar, LIMITES };
