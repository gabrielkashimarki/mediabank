const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { medir, avaliar } = require('../src/tecnica');

const ruido = () => sharp({ create: { width: 800, height: 800, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();

test('foto borrada tem nitidez menor que a nítida', async () => {
  const nitida = await ruido();
  const borrada = await sharp(nitida).blur(12).toBuffer();
  const n = await medir(nitida), b = await medir(borrada);
  assert.ok(n.nitidez > 10 * b.nitidez, `${n.nitidez} vs ${b.nitidez}`);
});

test('avaliar reprova resolução, foco e exposição fora dos limites', () => {
  const lim = { menorLado: 800, nitidez: 30, brilhoMin: 20, brilhoMax: 235 };
  const boa = { nitidez: 100, brilho: 120, menorLado: 1200 };
  assert.equal(avaliar(boa, lim), 'ok');
  assert.equal(avaliar({ ...boa, menorLado: 500 }, lim), 'reprovada');
  assert.equal(avaliar({ ...boa, nitidez: 5 }, lim), 'reprovada');
  assert.equal(avaliar({ ...boa, brilho: 5 }, lim), 'reprovada');
  assert.equal(avaliar({ ...boa, brilho: 250 }, lim), 'reprovada');
});
