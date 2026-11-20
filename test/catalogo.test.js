const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');
const { criarUsuario } = require('../src/auth');
const { agrupar, gerarCatalogo, sha256 } = require('../src/catalogo');

function inserirAsset(db, id, campos = {}) {
  const base = {
    id,
    origem: 'local',
    md5: id,
    phash: '0',
    st_ia: 'ok',
    tier: 'social',
    aprovacao: 'aprovada',
    tem_crianca: 0,
    autorizacao_uso: 'sim',
    nota_rubrica: 7.0,
    espaco: 'Deck',
    tipo_evento: 'Casamento',
    ...campos,
  };
  const cols = Object.keys(base);
  db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
}

test('agrupar junta grupos pequenos em Outros e limita a 80', () => {
  const db = abrirBanco(':memory:');

  // Grupos pequenos do Deck (< 4 fotos cada)
  inserirAsset(db, 'cas_1', { espaco: 'Deck', tipo_evento: 'Casamento', nota_rubrica: 8.0 });
  inserirAsset(db, 'cas_2', { espaco: 'Deck', tipo_evento: 'Casamento', nota_rubrica: 7.5 });
  inserirAsset(db, 'cas_3', { espaco: 'Deck', tipo_evento: 'Casamento', nota_rubrica: 7.0 });

  inserirAsset(db, 'corp_1', { espaco: 'Deck', tipo_evento: 'Corporativo', nota_rubrica: 6.5 });
  inserirAsset(db, 'corp_2', { espaco: 'Deck', tipo_evento: 'Corporativo', nota_rubrica: 6.0 });

  // Grupo grande de outro espaço (>= 4 fotos)
  for (let i = 1; i <= 5; i++) {
    inserirAsset(db, `salao_${i}`, { espaco: 'Salão Principal', tipo_evento: 'Casamento', nota_rubrica: 7.0 + i * 0.1 });
  }

  // Grupo com mais de 80 fotos no Deck para testar o limite de 80
  for (let i = 1; i <= 85; i++) {
    const id = `aniv_${String(i).padStart(3, '0')}`;
    inserirAsset(db, id, { espaco: 'Deck', tipo_evento: 'Aniversário', nota_rubrica: i * 0.1 });
  }

  // Foto pendente na IA e foto descartada nao entram
  inserirAsset(db, 'pend_1', { espaco: 'Deck', tipo_evento: 'Casamento', st_ia: 'pendente' });
  inserirAsset(db, 'desc_1', { espaco: 'Deck', tipo_evento: 'Casamento', tier: 'descartar' });

  const grupos = agrupar(db);

  // Deck | Casamento e Deck | Corporativo foram para Deck | Outros
  assert.equal(grupos.find(g => g.grupo === 'Deck | Casamento'), undefined);
  assert.equal(grupos.find(g => g.grupo === 'Deck | Corporativo'), undefined);

  const outrosDeck = grupos.find(g => g.grupo === 'Deck | Outros');
  assert.ok(outrosDeck);
  assert.equal(outrosDeck.n_fotos, 5);
  const idsOutros = outrosDeck.fotos.map(f => f.id).sort();
  assert.deepEqual(idsOutros, ['cas_1', 'cas_2', 'cas_3', 'corp_1', 'corp_2']);
  assert.equal(outrosDeck.assinatura, sha256(idsOutros.join(',')));

  // Salão Principal | Casamento permaneceu com suas 5 fotos
  const salaoCas = grupos.find(g => g.grupo === 'Salão Principal | Casamento');
  assert.ok(salaoCas);
  assert.equal(salaoCas.n_fotos, 5);

  // Deck | Aniversário foi limitado a 80 fotos, pegando as de maior nota_rubrica
  const anivDeck = grupos.find(g => g.grupo === 'Deck | Aniversário');
  assert.ok(anivDeck);
  assert.equal(anivDeck.n_fotos, 85);
  assert.equal(anivDeck.fotos.length, 80);

  // As 5 fotos de menor nota_rubrica (aniv_001 a aniv_005) foram cortadas
  const idsAniv = new Set(anivDeck.fotos.map(f => f.id));
  assert.ok(!idsAniv.has('aniv_001'));
  assert.ok(!idsAniv.has('aniv_002'));
  assert.ok(!idsAniv.has('aniv_003'));
  assert.ok(!idsAniv.has('aniv_004'));
  assert.ok(!idsAniv.has('aniv_005'));
  assert.ok(idsAniv.has('aniv_085'));
  assert.ok(idsAniv.has('aniv_084'));

  // Assinatura bate com o hash dos 80 IDs ordenados
  const idsOrdenadosAniv = anivDeck.fotos.map(f => f.id).sort();
  assert.equal(anivDeck.assinatura, sha256(idsOrdenadosAniv.join(',')));
});

test('gerarCatalogo com cliente falso grava conteudo, troca ids curtos e descarta id inventado', async () => {
  const db = abrirBanco(':memory:');

  // Cria pasta-evento
  db.prepare(`
    INSERT INTO pastas (id, nome, pai_id, caminho, evento)
    VALUES ('pasta_ev', 'Casamento Clara & Bruno', NULL, 'Casamentos/Clara & Bruno', 1)
  `).run();

  const idsReais = [];
  for (let i = 1; i <= 5; i++) {
    const id = `foto_${i}_id_longo_real`;
    idsReais.push(id);
    inserirAsset(db, id, {
      espaco: 'Deck',
      tipo_evento: 'Casamento',
      pasta_id: 'pasta_ev',
      titulo: `Foto ${i}`,
      descricao: `Descricao da foto ${i}`,
    });
  }

  let chamadaModelo = null;
  let chamadaMensagens = null;

  const clienteFalso = {
    async chat(modelo, mensagens, extra) {
      chamadaModelo = modelo;
      chamadaMensagens = mensagens;
      const f1Curto = idsReais[0].slice(0, 8);
      const f2Curto = idsReais[1].slice(0, 8);
      const f3Curto = idsReais[2].slice(0, 8);

      return JSON.stringify({
        resumo: 'O Deck recebeu casamentos ao ar livre com vista para o parque.',
        itens: [
          {
            categoria: 'decoracao',
            o_que: 'Mesa imperial de madeira com flores brancas',
            fotos: [f1Curto, 'inventad', f2Curto],
          },
        ],
        capacidade: '150 convidados sentados',
        ideias: [
          {
            ideia: 'Cerimônia no pôr do sol com passarela espelhada',
            fotos: [f3Curto, 'naoexiste'],
          },
        ],
        perguntas: ['Como fica a iluminação cênica à noite?'],
      });
    },
  };

  const res = await gerarCatalogo(db, { cliente: clienteFalso, modelo: 'modelo-teste', limite: 5 });
  assert.equal(res.gerados, 1);
  assert.equal(res.erros, 0);
  assert.equal(chamadaModelo, 'modelo-teste');

  // Verifica que o resumo enviado ao modelo trouxe o evento da pasta
  const corpoEnviado = JSON.parse(chamadaMensagens[1].content);
  assert.equal(corpoEnviado.grupo, 'Deck | Casamento');
  assert.equal(corpoEnviado.fotos[0].evento, 'Casamento Clara & Bruno');
  assert.equal(corpoEnviado.fotos[0].id, idsReais[0].slice(0, 8));

  // Verifica gravacao no banco
  const row = db.prepare("SELECT * FROM catalogo WHERE grupo = 'Deck | Casamento'").get();
  assert.ok(row);
  assert.equal(row.espaco, 'Deck');
  assert.equal(row.tipo_evento, 'Casamento');
  assert.equal(row.n_fotos, 5);
  assert.ok(row.gerado_em);

  const conteudo = JSON.parse(row.conteudo);
  assert.equal(conteudo.resumo, 'O Deck recebeu casamentos ao ar livre com vista para o parque.');
  assert.equal(conteudo.capacidade, '150 convidados sentados');

  // IDs curtos foram substituidos pelos completos e o id inventado foi descartado
  assert.deepEqual(conteudo.itens[0].fotos, [idsReais[0], idsReais[1]]);
  assert.deepEqual(conteudo.ideias[0].fotos, [idsReais[2]]);
  assert.deepEqual(conteudo.perguntas, ['Como fica a iluminação cênica à noite?']);
});

test('não regera sem fotos novas suficientes', async () => {
  const db = abrirBanco(':memory:');

  for (let i = 1; i <= 10; i++) {
    inserirAsset(db, `foto_deck_${i}`, { espaco: 'Deck', tipo_evento: 'Casamento' });
  }

  let chamadas = 0;
  const clienteFalso = {
    async chat() {
      chamadas++;
      return JSON.stringify({ resumo: 'Resumo', itens: [], ideias: [], perguntas: [] });
    },
  };

  const r1 = await gerarCatalogo(db, { cliente: clienteFalso, modelo: 'teste', minNovas: 5 });
  assert.equal(r1.gerados, 1);
  assert.equal(chamadas, 1);

  // Adiciona apenas 2 fotos novas (12 - 10 = 2 < 5 minNovas)
  inserirAsset(db, 'foto_deck_nova_1', { espaco: 'Deck', tipo_evento: 'Casamento' });
  inserirAsset(db, 'foto_deck_nova_2', { espaco: 'Deck', tipo_evento: 'Casamento' });

  const r2 = await gerarCatalogo(db, { cliente: clienteFalso, modelo: 'teste', minNovas: 5 });
  assert.equal(r2.gerados, 0);
  assert.equal(chamadas, 1); // Nao chamou o modelo novamente
});

test('regera quando a assinatura muda com minNovas', async () => {
  const db = abrirBanco(':memory:');

  for (let i = 1; i <= 10; i++) {
    inserirAsset(db, `f_${i}`, { espaco: 'Deck', tipo_evento: 'Casamento' });
  }

  let chamadas = 0;
  const clienteFalso = {
    async chat() {
      chamadas++;
      return JSON.stringify({ resumo: `Versao ${chamadas}`, itens: [], ideias: [], perguntas: [] });
    },
  };

  await gerarCatalogo(db, { cliente: clienteFalso, modelo: 'teste', minNovas: 5 });
  assert.equal(chamadas, 1);

  // Adiciona 5 fotos novas (15 - 10 = 5 >= 5 minNovas)
  for (let i = 11; i <= 15; i++) {
    inserirAsset(db, `f_${i}`, { espaco: 'Deck', tipo_evento: 'Casamento' });
  }

  const r = await gerarCatalogo(db, { cliente: clienteFalso, modelo: 'teste', minNovas: 5 });
  assert.equal(r.gerados, 1);
  assert.equal(chamadas, 2);

  const row = db.prepare("SELECT n_fotos, conteudo FROM catalogo WHERE grupo = 'Deck | Casamento'").get();
  assert.equal(row.n_fotos, 15);
  assert.equal(JSON.parse(row.conteudo).resumo, 'Versao 2');
});

test('erro num grupo não derruba os outros', async () => {
  const db = abrirBanco(':memory:');

  for (let i = 1; i <= 5; i++) {
    inserirAsset(db, `deck_${i}`, { espaco: 'Deck', tipo_evento: 'Casamento' });
    inserirAsset(db, `salao_${i}`, { espaco: 'Salão Principal', tipo_evento: 'Corporativo' });
  }

  const clienteFalho = {
    async chat(modelo, mensagens) {
      const corpo = JSON.parse(mensagens[1].content);
      if (corpo.grupo === 'Deck | Casamento') {
        throw new Error('Falha simulada na IA do grupo Deck');
      }
      return JSON.stringify({ resumo: 'Salão sucesso', itens: [], ideias: [], perguntas: [] });
    },
  };

  const res = await gerarCatalogo(db, { cliente: clienteFalho, modelo: 'teste', limite: 5 });
  assert.equal(res.gerados, 1);
  assert.equal(res.erros, 1);

  // O grupo com sucesso foi gravado
  const rowSalao = db.prepare("SELECT * FROM catalogo WHERE grupo = 'Salão Principal | Corporativo'").get();
  assert.ok(rowSalao);
  assert.equal(JSON.parse(rowSalao.conteudo).resumo, 'Salão sucesso');

  // O grupo com erro nao foi gravado
  const rowDeck = db.prepare("SELECT * FROM catalogo WHERE grupo = 'Deck | Casamento'").get();
  assert.equal(rowDeck, undefined);
});

test('/api/v1/catalogo esconde foto que não passa na exposição', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cat-v1-'));
  fs.mkdirSync(path.join(dir, 'midia/thumb'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'midia/preview'), { recursive: true });
  const db = abrirBanco(':memory:');

  // Foto 1 passa na exposicao
  inserirAsset(db, 'f_exposta', {
    aprovacao: 'aprovada',
    tem_crianca: 0,
    autorizacao_uso: 'sim',
    tier: 'social',
    espaco: 'Deck',
    tipo_evento: 'Casamento',
  });

  // Foto 2 nao passa na exposicao (reprovada por ter crianca)
  inserirAsset(db, 'f_oculta_crianca', {
    aprovacao: 'aprovada',
    tem_crianca: 1,
    autorizacao_uso: 'sim',
    tier: 'social',
    espaco: 'Deck',
    tipo_evento: 'Casamento',
  });

  // Foto 3 nao passa na exposicao (aprovacao pendente)
  inserirAsset(db, 'f_oculta_pendente', {
    aprovacao: 'pendente',
    tem_crianca: 0,
    autorizacao_uso: 'sim',
    tier: 'social',
    espaco: 'Deck',
    tipo_evento: 'Casamento',
  });

  // Grava catalogo com as 3 fotos citadas nos itens e ideias
  db.prepare(`
    INSERT INTO catalogo (grupo, espaco, tipo_evento, n_fotos, assinatura, conteudo, gerado_em)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    'Deck | Casamento', 'Deck', 'Casamento', 3, 'sig123',
    JSON.stringify({
      resumo: 'Deck para casamentos',
      itens: [
        {
          categoria: 'cenario',
          o_que: 'Altar de frente para o lago',
          fotos: ['f_exposta', 'f_oculta_crianca'],
        },
      ],
      ideias: [
        {
          ideia: 'Mesa de doces suspensa',
          fotos: ['f_oculta_pendente', 'f_exposta'],
        },
      ],
      perguntas: ['Como é o altar?'],
    })
  );

  const chave = criarChave(db, 'site');
  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/v1`;

  const res = await fetch(`${base}/catalogo?espaco=Deck&tipo_evento=Casamento`, {
    headers: { 'X-API-Key': chave },
  });
  assert.equal(res.status, 200);

  const corpo = await res.json();
  const grupos = corpo.catalogo || corpo;
  assert.equal(grupos.length, 1);

  const g = grupos[0];
  assert.equal(g.grupo, 'Deck | Casamento');

  // Em cada item/ideia, apenas f_exposta deve aparecer, acompanhada das URLs de midia da v1
  const fotosItem = g.conteudo.itens[0].fotos;
  assert.equal(fotosItem.length, 1);
  assert.equal(fotosItem[0].id, 'f_exposta');
  assert.equal(fotosItem[0].thumb_url, '/api/v1/midia/thumb/f_exposta.jpg');
  assert.equal(fotosItem[0].preview_url, '/api/v1/midia/preview/f_exposta.jpg');

  const fotosIdeia = g.conteudo.ideias[0].fotos;
  assert.equal(fotosIdeia.length, 1);
  assert.equal(fotosIdeia[0].id, 'f_exposta');
  assert.equal(fotosIdeia[0].thumb_url, '/api/v1/midia/thumb/f_exposta.jpg');
  assert.equal(fotosIdeia[0].preview_url, '/api/v1/midia/preview/f_exposta.jpg');
});

test('regerar exige admin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cat-painel-'));
  const db = abrirBanco(':memory:');

  criarUsuario(db, { email: 'admin@x.com', nome: 'Admin', senha: 'senha-longa-1', admin: true });
  criarUsuario(db, { email: 'equipe@x.com', nome: 'Equipe', senha: 'senha-longa-2', admin: false });

  db.prepare(`
    INSERT INTO catalogo (grupo, espaco, tipo_evento, n_fotos, assinatura, conteudo, gerado_em)
    VALUES ('Deck | Casamento', 'Deck', 'Casamento', 10, 'assinatura_original_123', '{}', datetime('now'))
  `).run();

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

  // Sem login devolve 401
  const rSemLogin = await fetch(`${base}/catalogo/regerar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grupo: 'Deck | Casamento' }),
  });
  assert.equal(rSemLogin.status, 401);

  // Usuario da equipe (nao admin) devolve 403
  const rEquipe = await fetch(`${base}/catalogo/regerar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieEquipe },
    body: JSON.stringify({ grupo: 'Deck | Casamento' }),
  });
  assert.equal(rEquipe.status, 403);

  // Admin com dados validos zera a assinatura
  const rAdmin = await fetch(`${base}/catalogo/regerar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ grupo: 'Deck | Casamento' }),
  });
  assert.equal(rAdmin.status, 200);
  const jAdmin = await rAdmin.json();
  assert.equal(jAdmin.ok, true);

  const row = db.prepare("SELECT assinatura FROM catalogo WHERE grupo = 'Deck | Casamento'").get();
  assert.equal(row.assinatura, '');
});

test('GET /api/painel/catalogo lista grupos com conteudo parseado e exige login', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cat-painel-get-'));
  const db = abrirBanco(':memory:');

  criarUsuario(db, { email: 'equipe@x.com', nome: 'Equipe', senha: 'senha-longa-2', admin: false });

  db.prepare(`
    INSERT INTO catalogo (grupo, espaco, tipo_evento, n_fotos, assinatura, conteudo, gerado_em)
    VALUES ('Deck | Casamento', 'Deck', 'Casamento', 8, 'sig456', '{"resumo":"Deck bom","itens":[]}', datetime('now'))
  `).run();

  const srv = criarApp({ db, dirDados: dir }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/painel`;

  // Sem login devolve 401
  const rSemLogin = await fetch(`${base}/catalogo`);
  assert.equal(rSemLogin.status, 401);

  // Com login devolve a lista de grupos com conteudo parseado
  const resLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'equipe@x.com', senha: 'senha-longa-2' }),
  });
  const cookie = resLogin.headers.get('set-cookie')?.split(';')[0];

  const resOk = await fetch(`${base}/catalogo`, { headers: { Cookie: cookie } });
  assert.equal(resOk.status, 200);
  const lista = await resOk.json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].grupo, 'Deck | Casamento');
  assert.equal(lista[0].espaco, 'Deck');
  assert.equal(lista[0].tipo_evento, 'Casamento');
  assert.equal(lista[0].n_fotos, 8);
  assert.equal(typeof lista[0].conteudo, 'object');
  assert.equal(lista[0].conteudo.resumo, 'Deck bom');
  assert.deepEqual(lista[0].conteudo.itens, []);
});

