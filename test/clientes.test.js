const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { abrirBanco, SQL_EXPOSICAO, SQL_ACERVO } = require('../src/db');
const clientes = require('../src/clientes');
const { criarChave, dadosDaChave } = require('../src/chaves');

const SCHEMA_ANTIGO = fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-antes-multicliente.sql'), 'utf8');

// banco no formato de produção antes da spec, com uma foto, uma coleção, uma chave e um usuário
function bancoAntigo() {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-migra-')), 'mediabank.db');
  const db = new Database(arq);
  sqliteVec.load(db);
  db.exec(SCHEMA_ANTIGO);
  db.prepare("INSERT INTO assets (id, origem, md5, phash, aprovacao, tem_crianca) VALUES ('f1', 'drive', 'm1', '0', 'aprovada', 0)").run();
  db.prepare("INSERT INTO colecoes (nome, slug_publico) VALUES ('Casamento', 'casamento-abc')").run();
  db.prepare("INSERT INTO api_keys (nome, hash) VALUES ('bot', 'h1'), ('lote', 'h2')").run();
  db.prepare("INSERT INTO usuarios (email, nome, hash_senha) VALUES ('a@x.com', 'A', 'x:y')").run();
  db.prepare("INSERT INTO sync_estado (chave, valor) VALUES ('drive_token', '123')").run();
  db.close();
  return arq;
}

test('migração aditiva: o banco antigo abre duas vezes e tudo vira da Casa Exemplo', () => {
  const arq = bancoAntigo();
  abrirBanco(arq).close();
  const db = abrirBanco(arq); // segunda abertura: nada quebra nem duplica
  assert.deepEqual(db.prepare('SELECT id, nome FROM clientes').all(), [{ id: 'exemplo', nome: 'Casa Exemplo' }]);
  assert.deepEqual(db.prepare('SELECT cliente_id, tipo_midia, etiquetas FROM assets').get(), { cliente_id: 'exemplo', tipo_midia: 'imagem', etiquetas: '{}' });
  assert.equal(db.prepare('SELECT cliente_id FROM colecoes').get().cliente_id, 'exemplo');
  assert.deepEqual(db.prepare('SELECT nome, cliente_id, escopo FROM api_keys ORDER BY nome').all(),
    [{ nome: 'bot', cliente_id: 'exemplo', escopo: null }, { nome: 'lote', cliente_id: 'exemplo', escopo: null }]);
  for (const t of ['pastas', 'catalogo', 'marcacoes', 'duelos', 'pontuacao']) {
    assert.ok(db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'cliente_id'), t);
  }
  // o estado do sync não muda: o rollback para a imagem anterior continua de onde parou
  assert.equal(db.prepare("SELECT valor FROM sync_estado WHERE chave = 'drive_token'").get().valor, '123');
});

test('o código antigo continua gravando no banco migrado (rollback seguro)', () => {
  const arq = bancoAntigo();
  abrirBanco(arq).close();
  const db = new Database(arq);
  // INSERT como o código de antes faz, sem as colunas novas
  db.prepare("INSERT INTO assets (id, origem, md5, phash) VALUES ('f2', 'drive', 'm2', '0')").run();
  db.prepare("INSERT INTO colecoes (nome) VALUES ('Nova')").run();
  db.prepare("INSERT INTO api_keys (nome, hash) VALUES ('nova', 'h3')").run();
  assert.equal(db.prepare("SELECT cliente_id FROM assets WHERE id = 'f2'").get().cliente_id, 'exemplo');
  assert.equal(db.prepare("SELECT cliente_id FROM colecoes WHERE nome = 'Nova'").get().cliente_id, 'exemplo');
});

test('exposição da Casa Exemplo é a regra de antes, presa ao cliente', () => {
  assert.equal(SQL_ACERVO, "a.tem_crianca = 0 AND a.autorizacao_uso != 'nao' AND a.tier != 'descartar'");
  assert.equal(SQL_EXPOSICAO, `a.aprovacao = 'aprovada' AND ${SQL_ACERVO}`);
  assert.equal(clientes.exposicao('exemplo'), `a.cliente_id = 'exemplo' AND ${SQL_EXPOSICAO}`);
  assert.equal(clientes.acervo('exemplo'), `a.cliente_id = 'exemplo' AND ${SQL_ACERVO}`);
});

test('cliente desconhecido ou com aspas nunca chega ao SQL', () => {
  assert.throws(() => clientes.sqlCliente("x' OR 1=1 --"), /cliente desconhecido/);
  assert.throws(() => clientes.exposicao('inexistente'), /cliente desconhecido/);
  assert.throws(() => clientes.registrar(abrirBanco(':memory:'), { id: "a'b", nome: 'x' }), /id de cliente inválido/);
});

test('chave antiga: lote é do trabalhador, as outras leem v1 e MCP; chave nova tem cliente e escopo', () => {
  const db = abrirBanco(':memory:');
  assert.deepEqual(dadosDaChave(db, criarChave(db, 'bot')), { nome: 'bot', cliente: 'exemplo', escopos: ['v1', 'mcp'] });
  assert.deepEqual(dadosDaChave(db, criarChave(db, 'lote')).escopos, ['lote']);
  assert.deepEqual(dadosDaChave(db, criarChave(db, 'x', { escopo: 'v2' })).escopos, ['v2']);
  assert.throws(() => criarChave(db, 'x', { escopo: 'tudo' }), /escopo inválido/);
  assert.throws(() => criarChave(db, 'x', { cliente: 'inexistente' }), /cliente desconhecido/);
  assert.equal(dadosDaChave(db, 'mb_inexistente'), null);
});

test('vínculos: sem vínculo fica só na Casa Exemplo (admin lá, se era admin); outro cliente só com vínculo', () => {
  const db = abrirBanco(':memory:');
  clientes.registrar(db, { ...clientes.vocabularioDe('exemplo'), id: 'outro-b', nome: 'Outro B' });
  const id = db.prepare("INSERT INTO usuarios (email, nome, hash_senha) VALUES ('a@x.com', 'A', 'x')").run().lastInsertRowid;
  assert.deepEqual(clientes.clientesDoUsuario(db, { id }).map(c => [c.id, c.papel]), [['exemplo', 'editor']]);
  clientes.vincular(db, id, 'outro-b', 'leitor');
  assert.deepEqual(clientes.clientesDoUsuario(db, { id }).map(c => [c.id, c.papel]), [['outro-b', 'leitor']]);
  const adm = db.prepare("INSERT INTO usuarios (email, nome, hash_senha, admin) VALUES ('g@x.com', 'G', 'x', 1)").run().lastInsertRowid;
  assert.deepEqual(clientes.clientesDoUsuario(db, { id: adm, admin: true }).map(c => [c.id, c.papel]), [['exemplo', 'admin']]); // admin antigo não vê outro cliente
  clientes.vincular(db, adm, 'exemplo', 'admin');
  clientes.vincular(db, adm, 'outro-b', 'admin');
  assert.deepEqual(clientes.clientesDoUsuario(db, { id: adm, admin: true }).map(c => c.id).sort(), ['exemplo', 'outro-b']);
  assert.throws(() => clientes.vincular(db, id, 'outro-b', 'dono'), /papel inválido/);
});

test('convite: cria sem senha conhecida, dá os vínculos e manda o link de 7 dias; e-mail existente só ganha vínculo', async () => {
  const { convidar } = require('../src/convites');
  const auth = require('../src/auth');
  const db = abrirBanco(':memory:');
  clientes.registrar(db, { ...clientes.vocabularioDe('exemplo'), id: 'outro-c', nome: 'Outro C' });
  const enviados = [];
  const enviador = { async enviar(m) { enviados.push(m); } };
  const r = await convidar(db, { email: ' Ana@X.com ', nome: 'Ana', vinculos: [['exemplo', 'admin'], ['outro-c', 'admin']], base: 'https://mb.test/' }, enviador);
  assert.equal(r.novo, true);
  assert.deepEqual(clientes.clientesDoUsuario(db, { id: r.usuario }).map(c => [c.id, c.papel]), [['exemplo', 'admin'], ['outro-c', 'admin']]);
  assert.equal(enviados[0].para, 'ana@x.com');
  const token = enviados[0].html.match(/redefinir=([\w-]+)/)[1];
  const prazo = db.prepare("SELECT julianday(expira_em) - julianday('now') AS d FROM redefinicoes").get().d;
  assert.ok(prazo > 6.9 && prazo <= 7);
  assert.deepEqual(auth.redefinirSenha(db, token, 'senha-nova-da-ana'), { ok: true });
  assert.ok(auth.entrar(db, 'ana@x.com', 'senha-nova-da-ana').token);
  // já existe: não mexe na senha, só acrescenta o vínculo e avisa
  auth.criarUsuario(db, { email: 'g@x.com', nome: 'G', senha: 'senha-antiga-1', admin: true });
  const r2 = await convidar(db, { email: 'g@x.com', nome: 'G', vinculos: [['outro-c', 'admin']], base: 'https://mb.test' }, enviador);
  assert.equal(r2.novo, false);
  assert.doesNotMatch(enviados[1].html, /redefinir=/);
  assert.ok(auth.entrar(db, 'g@x.com', 'senha-antiga-1').token);
  await assert.rejects(convidar(db, { email: 'sem-arroba', nome: 'x', vinculos: [['exemplo', 'admin']] }), /use email/);
});

test('outro: vocabulário próprio na análise de vídeo e regra de uso própria', () => {
  const v = clientes.vocabularioDe('outro');
  const prompt = v.ANALISE_VIDEO.prompt(4, '', { campoCenas: () => '' });
  assert.match(prompt, /da Marca Exemplo/);
  assert.match(prompt, /"abertura"/);
  assert.equal(v.ANALISE_VIDEO.validar({ titulo: 't', descricao: 'x'.repeat(90), tema: 'cafe' }).campos.etiquetas.tema, 'cafe');
  assert.equal(v.REGRAS_USO.maxPecas, 3);
  assert.doesNotMatch(prompt, /Casa Exemplo/);
});
