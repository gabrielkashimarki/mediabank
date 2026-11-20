const test = require('node:test');
const assert = require('node:assert/strict');
const { medirVideos, faixaDuracao, orientacao, resolucao } = require('../src/medicao');
const { criarDrive } = require('../src/drive');

const video = (id, mb, seg, w, h, extra = {}) => ({
  id, name: `${id}.mp4`, mimeType: 'video/mp4', size: String(mb * 1024 * 1024), md5Checksum: `m${id}`,
  createdTime: '2025-05-01T00:00:00Z', parents: ['P1'],
  ...(seg != null && { videoMediaMetadata: { width: w, height: h, durationMillis: String(seg * 1000) } }), ...extra,
});

test('soma GB, horas e faixas, e conta o que o Drive ainda não processou', async () => {
  const m = await medirVideos([
    video('a', 1024, 3600, 1920, 1080),
    video('b', 100, 30, 1080, 1920),
    video('c', 50, null),
    video('d', 100, 30, 1080, 1920, { md5Checksum: 'mb' }),
    video('e', 0, null),
  ]);
  assert.equal(m.n, 5);
  assert.equal(m.gb, 1.24);
  assert.equal(m.horas, 1.02);
  assert.equal(m.sem_metadado, 2);
  assert.equal(m.vazios, 1);
  assert.deepEqual(m.md5_repetidos, { grupos: 1, arquivos_a_mais: 1 });
  assert.equal(m.por_duracao['30 min ou mais'].n, 1);
  assert.equal(m.por_orientacao.vertical.n, 2);
  assert.equal(m.maiores[0].id, 'a');
  // d repete o md5 de b: a previsão conta a, b e c (sem duração, conta 20 s)
  assert.deepEqual(m.unicos, { n: 3, gb: 1.15, horas: 1.01 });
  assert.equal(m.previsao_disco_gb.previa_20s, +(60 / 60 * 9 / 1024).toFixed(2));
  assert.ok(m.previsao_disco_gb.previa_inteira > m.previsao_disco_gb.previa_20s);
});

test('faixas de duração, orientação e resolução', () => {
  assert.equal(faixaDuracao(null), 'sem metadado');
  assert.equal(faixaDuracao(14), '< 15 s');
  assert.equal(faixaDuracao(1800), '30 min ou mais');
  assert.equal(orientacao(1080, 1920), 'vertical');
  assert.equal(resolucao(3840, 2160), '4K');
  assert.equal(resolucao(1280, 720), '720p');
});

test('drive.videos lista video/* com videoMediaMetadata e as imagens continuam iguais', async () => {
  const urls = [];
  const fetch = async (url) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    urls.push(new URL(url));
    return { ok: true, json: async () => ({ files: [{ id: 'v1' }] }) };
  };
  const d = criarDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch });
  for await (const f of d.videos()) assert.equal(f.id, 'v1');
  for await (const f of d.imagens()) void f;
  const [v, i] = urls;
  assert.equal(v.searchParams.get('q'), "mimeType contains 'video/' and trashed = false");
  assert.match(v.searchParams.get('fields'), /videoMediaMetadata\(width,height,durationMillis\)/);
  assert.equal(i.searchParams.get('q'), "mimeType contains 'image/' and trashed = false");
  assert.doesNotMatch(i.searchParams.get('fields'), /videoMediaMetadata/);
});
