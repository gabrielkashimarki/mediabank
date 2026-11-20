const test = require('node:test');
const assert = require('node:assert/strict');
const { criarDrive } = require('../src/drive');

test('renova o token uma vez, manda os parâmetros de Drive compartilhado e pagina', async () => {
  const chamadas = [];
  const fetch = async (url, opts = {}) => {
    chamadas.push(url);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    const u = new URL(url);
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    assert.equal(u.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(u.searchParams.get('includeItemsFromAllDrives'), 'true');
    const pagina = u.searchParams.get('pageToken');
    return { ok: true, json: async () => (pagina ? { files: [{ id: '2' }] } : { files: [{ id: '1' }], nextPageToken: 'p2' }) };
  };
  const d = criarDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch });
  const ids = [];
  for await (const f of d.imagens()) ids.push(f.id);
  assert.deepEqual(ids, ['1', '2']);
  assert.equal(chamadas.filter(u => u.includes('oauth2')).length, 1);
  assert.match(chamadas[1], /corpora=allDrives/);
});

test('token recusado vira erro com a causa', async () => {
  const fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) });
  const d = criarDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch });
  await assert.rejects(d.tokenInicial(), /Google token 400: invalid_grant Token has been expired/);
});

test('com driveId, lista e acompanha só aquele drive compartilhado', async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(new URL(url));
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('startPageToken')) return { ok: true, json: async () => ({ startPageToken: '7' }) };
    if (url.includes('/changes')) return { ok: true, json: async () => ({ changes: [], newStartPageToken: '8' }) };
    return { ok: true, json: async () => ({ files: [] }) };
  };
  const d = criarDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', driveId: 'D1', fetch });
  for await (const f of d.imagens()) void f;
  await d.tokenInicial();
  await d.mudancas('7');
  const [lista, inicio, mud] = urls.filter(u => !u.href.includes('oauth2'));
  assert.equal(lista.searchParams.get('corpora'), 'drive');
  assert.equal(lista.searchParams.get('driveId'), 'D1');
  assert.equal(inicio.searchParams.get('driveId'), 'D1');
  assert.equal(mud.searchParams.get('driveId'), 'D1');
});

test('arquivo busca /files/{id} com fields e parametros padrao', async () => {
  let chamada;
  const fetch = async (url) => {
    chamada = new URL(url);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, json: async () => ({ id: 'f1', name: 'pasta1', parents: ['root'] }) };
  };
  const d = criarDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch });
  const arq = await d.arquivo('f1', 'id,name,parents');
  assert.deepEqual(arq, { id: 'f1', name: 'pasta1', parents: ['root'] });
  assert.equal(chamada.pathname, '/drive/v3/files/f1');
  assert.equal(chamada.searchParams.get('fields'), 'id,name,parents');
  assert.equal(chamada.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(chamada.searchParams.get('includeItemsFromAllDrives'), 'true');
});

test('abrirOriginal busca /files/{id}?alt=media e devolve corpo sem ler', async () => {
  let chamada;
  const corpoFalso = { mock: 'stream' };
  const headers = new Headers({ 'content-type': 'image/jpeg', 'content-length': '12345' });
  const fetch = async (url) => {
    chamada = new URL(url);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, body: corpoFalso, headers };
  };
  const d = criarDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch });
  const res = await d.abrirOriginal('f1');
  assert.equal(res.corpo, corpoFalso);
  assert.equal(res.tipo, 'image/jpeg');
  assert.equal(res.tamanho, 12345);
  assert.equal(chamada.pathname, '/drive/v3/files/f1');
  assert.equal(chamada.searchParams.get('alt'), 'media');
  assert.equal(chamada.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(chamada.searchParams.get('includeItemsFromAllDrives'), 'true');
});

