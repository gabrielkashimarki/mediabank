const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');

test('GET /oauth/callback responde 200 com HTML e instruções para colar a URL', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-oauth-'));
  const db = abrirBanco(':memory:');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${base}/oauth/callback?code=x&state=y`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('html'));
  const body = await res.text();
  assert.ok(body.includes('Copie o endereço'));
});
