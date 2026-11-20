const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCliente } = require('../src/openrouter');

const resposta = (status, corpo) => async (url, opts) => ({ ok: status < 400, status, json: async () => corpo, url, opts });

test('chat devolve o texto e manda a chave', async () => {
  let visto;
  const fetch = async (url, opts) => { visto = { url, opts }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'oi' } }] }) }; };
  const c = criarCliente({ chave: 'k', fetch });
  assert.equal(await c.chat('m', []), 'oi');
  assert.equal(visto.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(visto.opts.headers.Authorization, 'Bearer k');
});

test('embed ordena pelo index', async () => {
  const c = criarCliente({ chave: 'k', fetch: resposta(200, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }) });
  const [a, b] = await c.embed('m', ['a', 'b']);
  assert.equal(a[0], 1);
  assert.equal(b[0], 2);
});

test('erro da API vira exceção com a mensagem', async () => {
  const c = criarCliente({ chave: 'k', fetch: resposta(402, { error: { message: 'Insufficient credits' } }) });
  await assert.rejects(c.chat('m', []), /OpenRouter 402: Insufficient credits/);
});
