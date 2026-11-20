const test = require('node:test');
const assert = require('node:assert/strict');
const { criarEmail } = require('../src/email');

test('criarEmail devolve objeto com enviar', () => {
  const e = criarEmail({ host: 'smtp.exemplo.com', porta: 465, usuario: 'u', senha: 's', remetente: 'r@x.com' });
  assert.equal(typeof e.enviar, 'function');
});
