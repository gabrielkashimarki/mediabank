const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const auth = require('../src/auth');

test('senha guardada com sal e conferida', () => {
  const h = auth.hashSenha('senha-longa-1');
  assert.notEqual(h, auth.hashSenha('senha-longa-1'));
  assert.equal(auth.conferirSenha('senha-longa-1', h), true);
  assert.equal(auth.conferirSenha('outra-senha', h), false);
});

test('senha curta é recusada', () => {
  assert.throws(() => auth.criarUsuario(abrirBanco(':memory:'), { email: 'a@x.com', nome: 'A', senha: 'curta' }), /10 caracteres/);
});

test('login cria sessão; logout apaga; e-mail sem diferença de caixa', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'Ana@X.com', nome: 'Ana', senha: 'senha-longa-1', admin: true });
  const e = auth.entrar(db, ' ana@x.com ', 'senha-longa-1');
  assert.deepEqual(e.usuario, { id: 1, email: 'ana@x.com', nome: 'Ana', admin: true });
  assert.equal(db.prepare('SELECT hash FROM sessoes').get().hash.length, 64);
  assert.equal(auth.usuarioDaSessao(db, e.token).nome, 'Ana');
  auth.sair(db, e.token);
  assert.equal(auth.usuarioDaSessao(db, e.token), null);
});

test('cinco erros bloqueiam o e-mail, mesmo com a senha certa depois', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'b@x.com', nome: 'B', senha: 'senha-longa-1' });
  for (let i = 0; i < 5; i++) assert.equal(auth.entrar(db, 'b@x.com', 'errada').erro, 'credenciais');
  assert.equal(auth.entrar(db, 'b@x.com', 'senha-longa-1').erro, 'bloqueado');
  assert.equal(auth.entrar(db, 'ninguem@x.com', 'x').erro, 'credenciais');
});

test('sessão vencida não vale', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'c@x.com', nome: 'C', senha: 'senha-longa-1' });
  const { token } = auth.entrar(db, 'c@x.com', 'senha-longa-1');
  db.prepare("UPDATE sessoes SET expira_em = datetime('now', '-1 minute')").run();
  assert.equal(auth.usuarioDaSessao(db, token), null);
});

test('e-mail inexistente custa o mesmo scrypt que senha errada', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'd@x.com', nome: 'D', senha: 'senha-longa-1' });
  const crypto = require('node:crypto');
  const original = crypto.scryptSync;
  let n = 0;
  crypto.scryptSync = (...a) => { n++; return original(...a); };
  try {
    auth.entrar(db, 'd@x.com', 'errada'); const existente = n; n = 0;
    auth.entrar(db, 'ninguem@x.com', 'errada');
    assert.equal(n, existente);
  } finally { crypto.scryptSync = original; }
});

test('pedido para e-mail inexistente devolve null', () => {
  const db = abrirBanco(':memory:');
  assert.equal(auth.pedirRedefinicao(db, 'inexistente@x.com'), null);
});

test('quarto pedido em 15 min devolve null', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'limite-pedidos@x.com', nome: 'Limite', senha: 'senha-longa-1' });
  const p1 = auth.pedirRedefinicao(db, 'limite-pedidos@x.com');
  const p2 = auth.pedirRedefinicao(db, 'limite-pedidos@x.com');
  const p3 = auth.pedirRedefinicao(db, 'limite-pedidos@x.com');
  assert.ok(p1?.token);
  assert.ok(p2?.token);
  assert.ok(p3?.token);
  assert.equal(auth.pedirRedefinicao(db, 'limite-pedidos@x.com'), null);
});

test('senha curta falha', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'curta@x.com', nome: 'Curta', senha: 'senha-longa-1' });
  const p = auth.pedirRedefinicao(db, 'curta@x.com');
  assert.deepEqual(auth.redefinirSenha(db, p.token, 'curta'), { erro: 'senha_curta' });
});

test('token vale uma vez', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'uma-vez@x.com', nome: 'Uma Vez', senha: 'senha-longa-1' });
  const p = auth.pedirRedefinicao(db, 'uma-vez@x.com');
  assert.deepEqual(auth.redefinirSenha(db, p.token, 'nova-senha-valida'), { ok: true });
  assert.deepEqual(auth.redefinirSenha(db, p.token, 'outra-senha-valida'), { erro: 'link_invalido' });
});

test('token vencido falha', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'vencido@x.com', nome: 'Vencido', senha: 'senha-longa-1' });
  const p = auth.pedirRedefinicao(db, 'vencido@x.com');
  db.prepare("UPDATE redefinicoes SET expira_em = datetime('now', '-1 minute')").run();
  assert.deepEqual(auth.redefinirSenha(db, p.token, 'nova-senha-valida'), { erro: 'link_invalido' });
});

test('redefinir apaga as sessões', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'sessoes@x.com', nome: 'Sessoes', senha: 'senha-longa-1' });
  const s1 = auth.entrar(db, 'sessoes@x.com', 'senha-longa-1');
  const s2 = auth.entrar(db, 'sessoes@x.com', 'senha-longa-1');
  assert.ok(auth.usuarioDaSessao(db, s1.token));
  assert.ok(auth.usuarioDaSessao(db, s2.token));

  const p = auth.pedirRedefinicao(db, 'sessoes@x.com');
  const pNovo = auth.pedirRedefinicao(db, 'sessoes@x.com');
  assert.deepEqual(auth.redefinirSenha(db, p.token, 'nova-senha-123'), { erro: 'link_invalido' });

  assert.deepEqual(auth.redefinirSenha(db, pNovo.token, 'nova-senha-123'), { ok: true });
  assert.equal(auth.usuarioDaSessao(db, s1.token), null);
  assert.equal(auth.usuarioDaSessao(db, s2.token), null);
  assert.ok(auth.entrar(db, 'sessoes@x.com', 'nova-senha-123').token);
});

test('redefinir zera o bloqueio de falhas', () => {
  const db = abrirBanco(':memory:');
  auth.criarUsuario(db, { email: 'bloqueado-reset@x.com', nome: 'Bloq', senha: 'senha-longa-1' });
  for (let i = 0; i < 5; i++) auth.entrar(db, 'bloqueado-reset@x.com', 'errada');
  assert.equal(auth.entrar(db, 'bloqueado-reset@x.com', 'senha-longa-1').erro, 'bloqueado');

  const p = auth.pedirRedefinicao(db, 'bloqueado-reset@x.com');
  assert.deepEqual(auth.redefinirSenha(db, p.token, 'nova-senha-longa'), { ok: true });
  assert.ok(auth.entrar(db, 'bloqueado-reset@x.com', 'nova-senha-longa').token);
});


