const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarUsuario } = require('../src/auth');
const colecoes = require('../src/colecoes');
const {
  resolverPasta,
  preencherPastas,
  classificarPastas,
  eventoDaPasta,
  sincronizarColecoesDeEvento,
} = require('../src/pastas');

function inserirAsset(db, id, campos = {}) {
  const base = {
    id,
    origem: 'local',
    md5: id,
    phash: '0',
    aprovacao: 'aprovada',
    tem_crianca: 0,
    ...campos,
  };
  const cols = Object.keys(base);
  db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
}

test('resolverPasta monta caminho e para na raiz', async () => {
  const db = abrirBanco(':memory:');
  const chamadas = [];
  const pastasDrive = {
    p1: { id: 'p1', name: 'Casamentos', parents: ['raiz-drive'] },
    p2: { id: 'p2', name: '2. CASAMENTOS', parents: ['p1'] },
    p3: { id: 'p3', name: 'Clara & Bruno', parents: ['p2'] },
  };

  const drive = {
    async arquivo(id, campos) {
      chamadas.push(id);
      return pastasDrive[id];
    },
  };

  const p3 = await resolverPasta(db, drive, 'p3', 'raiz-drive');
  assert.equal(p3.caminho, 'Casamentos/2. CASAMENTOS/Clara & Bruno');
  assert.equal(p3.nome, 'Clara & Bruno');
  assert.equal(p3.pai_id, 'p2');

  const p1 = db.prepare("SELECT * FROM pastas WHERE id = 'p1'").get();
  assert.equal(p1.caminho, 'Casamentos');
  assert.equal(p1.pai_id, 'raiz-drive');

  // Segunda chamada usa o banco de dados sem bater no Drive
  const nAntes = chamadas.length;
  const p3Cache = await resolverPasta(db, drive, 'p3', 'raiz-drive');
  assert.equal(chamadas.length, nAntes);
  assert.equal(p3Cache.caminho, p3.caminho);
});

test('preencherPastas preenche asset antigo', async () => {
  const db = abrirBanco(':memory:');
  inserirAsset(db, 'a1', { drive_id: 'drv-1', pasta_id: null });
  inserirAsset(db, 'a2', { drive_id: 'drv-2', pasta_id: null });

  const arquivosDrive = {
    'drv-1': { id: 'drv-1', parents: ['pasta-a'] },
    'drv-2': { id: 'drv-2', parents: ['pasta-b'] },
    'pasta-a': { id: 'pasta-a', name: 'Evento A', parents: ['raiz'] },
    'pasta-b': { id: 'pasta-b', name: 'Evento B', parents: ['raiz'] },
  };

  const drive = {
    async arquivo(id) {
      return arquivosDrive[id];
    },
  };

  const res = await preencherPastas(db, drive, { driveRaiz: 'raiz', limite: 300 });
  assert.ok(res.chamadas > 0);

  const a1 = db.prepare("SELECT pasta_id FROM assets WHERE id = 'a1'").get();
  const a2 = db.prepare("SELECT pasta_id FROM assets WHERE id = 'a2'").get();
  assert.equal(a1.pasta_id, 'pasta-a');
  assert.equal(a2.pasta_id, 'pasta-b');

  const pastaA = db.prepare("SELECT * FROM pastas WHERE id = 'pasta-a'").get();
  assert.equal(pastaA.nome, 'Evento A');
  assert.equal(pastaA.caminho, 'Evento A');
});

test('classificarPastas grava prob e evento com Jev falso e não reavalia pasta fixa', async () => {
  const db = abrirBanco(':memory:');
  db.prepare(`
    INSERT INTO pastas (id, nome, pai_id, caminho, prob_evento, evento, evento_fixo)
    VALUES ('p1', 'Casamento X', NULL, 'Casamentos/Casamento X', NULL, NULL, 0),
           ('p2', 'FOTOS EM ALTA', 'p1', 'Casamentos/Casamento X/FOTOS EM ALTA', NULL, NULL, 0),
           ('p_fixa', 'Fixa', NULL, 'Fixa', NULL, 0, 1)
  `).run();

  const chamadasJev = [];
  const jev = async (corpo) => {
    chamadasJev.push(corpo.state.nome);
    assert.equal(corpo.model, 'jev-latest');
    assert.ok(corpo.questions.evento);
    if (corpo.state.nome === 'Casamento X') {
      return { answers: { evento: { noul: 0.92 } } };
    }
    if (corpo.state.nome === 'FOTOS EM ALTA') {
      return { answers: { evento: { noul: 0.08 } } };
    }
    throw new Error('Pasta inesperada: ' + corpo.state.nome);
  };

  const res = await classificarPastas(db, jev, { limite: 100 });
  assert.equal(res.avaliadas, 2);
  assert.deepEqual(chamadasJev.sort(), ['Casamento X', 'FOTOS EM ALTA']);

  const p1 = db.prepare("SELECT prob_evento, evento, evento_fixo, avaliada_em FROM pastas WHERE id = 'p1'").get();
  assert.equal(p1.prob_evento, 0.92);
  assert.equal(p1.evento, 1);
  assert.ok(p1.avaliada_em);

  const p2 = db.prepare("SELECT prob_evento, evento, evento_fixo, avaliada_em FROM pastas WHERE id = 'p2'").get();
  assert.equal(p2.prob_evento, 0.08);
  assert.equal(p2.evento, 0);
  assert.ok(p2.avaliada_em);

  const pFixa = db.prepare("SELECT prob_evento, evento, evento_fixo FROM pastas WHERE id = 'p_fixa'").get();
  assert.equal(pFixa.prob_evento, null);
  assert.equal(pFixa.evento, 0);
  assert.equal(pFixa.evento_fixo, 1);
});

test('eventoDaPasta pega a mais alta da cadeia', () => {
  const mapa = new Map([
    ['cat', { id: 'cat', pai_id: null, evento: 0 }],
    ['subcat', { id: 'subcat', pai_id: 'cat', evento: 0 }],
    ['evento_pai', { id: 'evento_pai', pai_id: 'subcat', evento: 1 }],
    ['evento_filho', { id: 'evento_filho', pai_id: 'evento_pai', evento: 1 }],
    ['subpasta_generica', { id: 'subpasta_generica', pai_id: 'evento_filho', evento: 0 }],
  ]);

  // subpasta de evento marcada como evento (P&B, COLORIDAS) cai no evento de cima
  assert.equal(eventoDaPasta(mapa, 'subpasta_generica'), 'evento_pai');
  assert.equal(eventoDaPasta(mapa, 'evento_filho'), 'evento_pai');
  assert.equal(eventoDaPasta(mapa, 'evento_pai'), 'evento_pai');
  assert.equal(eventoDaPasta(mapa, 'subcat'), null);
  assert.equal(eventoDaPasta(mapa, 'inexistente'), null);
});

test('sincronizarColecoesDeEvento cria a coleção, inclui foto de subpasta genérica, não duplica ao rodar duas vezes, apaga a automática quando a pasta vira evento=0 e não toca na manual', () => {
  const db = abrirBanco(':memory:');

  // Coleção manual
  const idManual = colecoes.criar(db, { nome: 'Seleção da Equipe' }, { id: null });

  // Pastas
  db.prepare(`
    INSERT INTO pastas (id, nome, pai_id, caminho, evento)
    VALUES ('ev1', 'CLARA E BRUNO ／ 2026', NULL, 'CASAMENTOS/CLARA E BRUNO ／ 2026', 1),
           ('sub_alta', 'FOTOS EM ALTA', 'ev1', 'CASAMENTOS/CLARA E BRUNO ／ 2026/FOTOS EM ALTA', 0),
           ('ev2', 'Jantar de Fim de Ano', NULL, 'CORP/Jantar de Fim de Ano', 1)
  `).run();

  // Fotos: f1 na subpasta genérica, f2 na pasta do evento, f3 no segundo evento
  inserirAsset(db, 'f1', { pasta_id: 'sub_alta', data_foto: '2026-10-01T12:00:00Z' });
  inserirAsset(db, 'f2', { pasta_id: 'ev1', data_foto: '2026-10-01T10:00:00Z' });
  inserirAsset(db, 'f3', { pasta_id: 'ev2', data_foto: '2026-10-01T15:00:00Z' });

  // Primeira sincronização
  const r1 = sincronizarColecoesDeEvento(db);
  assert.equal(r1.colecoes, 2);
  assert.equal(r1.fotos_adicionadas, 3);

  const colEv1 = db.prepare("SELECT * FROM colecoes WHERE pasta_id = 'ev1'").get();
  assert.equal(colEv1.nome, 'CLARA E BRUNO / 2026');
  assert.equal(colEv1.descricao, 'CASAMENTOS/CLARA E BRUNO ／ 2026');
  assert.equal(colEv1.criado_por, null);

  const fotosEv1 = db.prepare('SELECT asset_id FROM colecao_fotos WHERE colecao_id = ? ORDER BY posicao').all(colEv1.id).map(r => r.asset_id);
  assert.deepEqual(fotosEv1, ['f2', 'f1']); // f2 antes por data_foto; f1 de subpasta incluída

  // Segunda execução não duplica
  const r2 = sincronizarColecoesDeEvento(db);
  assert.equal(r2.colecoes, 2);
  assert.equal(r2.fotos_adicionadas, 0);
  const fotosEv1Depois = db.prepare('SELECT asset_id FROM colecao_fotos WHERE colecao_id = ? ORDER BY posicao').all(colEv1.id).map(r => r.asset_id);
  assert.deepEqual(fotosEv1Depois, ['f2', 'f1']);

  // Quando ev2 deixa de ser evento
  db.prepare("UPDATE pastas SET evento = 0 WHERE id = 'ev2'").run();
  const r3 = sincronizarColecoesDeEvento(db);
  assert.equal(r3.colecoes, 1);
  assert.equal(db.prepare("SELECT 1 FROM colecoes WHERE pasta_id = 'ev2'").get(), undefined);

  // Manual não é afetada
  const manual = db.prepare('SELECT * FROM colecoes WHERE id = ?').get(idManual);
  assert.ok(manual);
  assert.equal(manual.pasta_id, null);
});

test('rota de correção exige admin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-pastas-test-'));
  const db = abrirBanco(':memory:');
  criarUsuario(db, { email: 'admin@x.com', nome: 'Admin', senha: 'senha-longa-1', admin: true });
  criarUsuario(db, { email: 'equipe@x.com', nome: 'Equipe', senha: 'senha-longa-2', admin: false });

  db.prepare(`
    INSERT INTO pastas (id, nome, pai_id, caminho, evento, evento_fixo)
    VALUES ('p_evento', 'Casamento Teste', NULL, 'Casamentos/Casamento Teste', 1, 0)
  `).run();

  sincronizarColecoesDeEvento(db);
  assert.ok(db.prepare("SELECT 1 FROM colecoes WHERE pasta_id = 'p_evento'").get());

  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/painel`;

  const login = async (email, senha) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    });
    return res.headers.get('set-cookie')?.split(';')[0];
  };

  const cookieEquipe = await login('equipe@x.com', 'senha-longa-2');
  const cookieAdmin = await login('admin@x.com', 'senha-longa-1');

  // Sem login
  const rSemLogin = await fetch(`${base}/pastas/p_evento/evento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ evento: false }),
  });
  assert.equal(rSemLogin.status, 401);

  // Usuário comum (não admin)
  const rNaoAdmin = await fetch(`${base}/pastas/p_evento/evento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieEquipe },
    body: JSON.stringify({ evento: false }),
  });
  assert.equal(rNaoAdmin.status, 403);

  // Admin com dados inválidos
  const rInvalido = await fetch(`${base}/pastas/p_evento/evento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ evento: 'nao' }),
  });
  assert.equal(rInvalido.status, 400);

  // Admin com sucesso
  const rOk = await fetch(`${base}/pastas/p_evento/evento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ evento: false }),
  });
  assert.equal(rOk.status, 200);
  const jOk = await rOk.json();
  assert.equal(jOk.ok, true);

  // Pasta foi marcada como evento=0 e evento_fixo=1
  const pAtual = db.prepare("SELECT evento, evento_fixo FROM pastas WHERE id = 'p_evento'").get();
  assert.equal(pAtual.evento, 0);
  assert.equal(pAtual.evento_fixo, 1);

  // Coleção automática foi removida
  assert.equal(db.prepare("SELECT 1 FROM colecoes WHERE pasta_id = 'p_evento'").get(), undefined);
});

test('subpasta de evento também marcada como evento não vira coleção própria; foto sai da coleção que não é mais dela', () => {
  const db = abrirBanco(':memory:');
  db.prepare(`INSERT INTO pastas (id, nome, pai_id, caminho, evento) VALUES
    ('ev', 'CLARA E BRUNO', NULL, 'CASAMENTOS/CLARA E BRUNO', 1),
    ('pb', 'P&B', 'ev', 'CASAMENTOS/CLARA E BRUNO/P&B', 1)`).run();
  inserirAsset(db, 'a', { pasta_id: 'pb' });
  inserirAsset(db, 'b', { pasta_id: 'ev' });
  sincronizarColecoesDeEvento(db);
  const auto = db.prepare('SELECT id, pasta_id FROM colecoes WHERE pasta_id IS NOT NULL').all();
  assert.deepEqual(auto.map(c => c.pasta_id), ['ev']);
  assert.equal(db.prepare('SELECT count(*) n FROM colecao_fotos WHERE colecao_id = ?').get(auto[0].id).n, 2);

  // corrigido: a pasta de cima não é evento; P&B vira a coleção e a foto de fora sai
  db.prepare("UPDATE pastas SET evento = 0 WHERE id = 'ev'").run();
  sincronizarColecoesDeEvento(db);
  const depois = db.prepare('SELECT id, pasta_id FROM colecoes WHERE pasta_id IS NOT NULL').all();
  assert.deepEqual(depois.map(c => c.pasta_id), ['pb']);
  assert.deepEqual(db.prepare('SELECT asset_id FROM colecao_fotos WHERE colecao_id = ?').all(depois[0].id).map(r => r.asset_id), ['a']);
});
