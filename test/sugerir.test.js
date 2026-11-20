const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarChave } = require('../src/chaves');

function criarJevFalso(resposta) {
  return async (corpo) => {
    if (resposta instanceof Error) throw resposta;
    return typeof resposta === 'function' ? resposta(corpo) : resposta;
  };
}

function montarBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sug-'));
  fs.mkdirSync(path.join(dir, 'midia/thumb'), { recursive: true });
  const db = abrirBanco(':memory:');
  const add = (id, campos) => {
    const base = {
      id, origem: 'local', md5: id, phash: '0',
      espaco: 'Deck', tipo_evento: 'corporativo', tipo: 'foto',
      perguntas_que_responde: '["Como é o deck?"]',
      destinos: '["instagram"]',
      aprovacao: 'aprovada', tem_crianca: 0,
      titulo: id, ...campos,
    };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
    fs.writeFileSync(path.join(dir, 'midia/thumb', `${id}.jpg`), 'jpg');
  };
  add('deck-noite', { titulo: 'Deck à noite', espaco: 'Deck', tipo_evento: 'corporativo', perguntas_que_responde: '["Como é o deck à noite?"]' });
  add('salao-festa', { titulo: 'Salão de festas', espaco: 'Salão Nobre', tipo_evento: 'casamento', perguntas_que_responde: '["Como é o salão?"]' });
  add('jardim', { titulo: 'Jardim externo', espaco: 'Jardim', tipo_evento: 'corporativo', perguntas_que_responde: '["Como é o jardim?"]' });
  add('crianca-deck', { titulo: 'Deck com crianças', espaco: 'Deck', tem_crianca: 1, perguntas_que_responde: '["Como é o deck?"]' });
  return { db, dir };
}

async function subir(jev) {
  const { db, dir } = montarBanco();
  const chave = criarChave(db, 'teste');
  const srv = criarApp({ db, dirDados: dir, jev }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const post = (rota, corpo, k = chave) => fetch(base + rota, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(k ? { 'X-API-Key': k } : {}) },
    body: JSON.stringify(corpo),
  });
  return { srv, post };
}

test('cliente pede foto do deck à noite: enviar alto e foto do deck primeiro, fonte jev', async () => {
  const jev = criarJevFalso((corpo) => {
    assert.ok(corpo.questions.enviar_foto);
    assert.ok(corpo.questions.melhor);
    // verifica que usa c1..cN e nenhuma, sem ids internos
    const opcoes = Object.keys(corpo.questions.melhor.criteria);
    assert.ok(opcoes.includes('c1'));
    assert.ok(opcoes.includes('nenhuma'));
    assert.ok(!opcoes.includes('deck-noite'));
    return {
      model: 'jev-1.13.0',
      answers: {
        enviar_foto: { type: 'noul', noul: 0.98 },
        melhor: { type: 'choice', choice: 'c1', confidence: 1.0, probabilities: { c1: 0.9, c2: 0.05, c3: 0.05, nenhuma: 0.0 } },
      },
    };
  });
  const { srv, post } = await subir(jev);
  const res = await post('/fotos/sugerir', { conversa: 'Quero ver como é o deck à noite, tem foto?' });
  const corpo = await res.json();
  assert.equal(corpo.fonte, 'jev');
  assert.equal(corpo.enviar, 0.98);
  assert.equal(corpo.fotos[0].id, 'deck-noite');
  assert.equal(corpo.confianca, 1.0);
  assert.equal(corpo.probabilidade, 0.9);
  srv.close();
});

test('cliente só pergunta preço: enviar baixo repassado', async () => {
  const jev = criarJevFalso(() => ({
    model: 'jev-1.13.0',
    answers: {
      enviar_foto: { type: 'noul', noul: 0.05 },
      melhor: { type: 'choice', choice: 'c1', confidence: 0.8, probabilities: { c1: 0.5, c2: 0.3, c3: 0.2, nenhuma: 0.0 } },
    },
  }));
  const { srv, post } = await subir(jev);
  const res = await post('/fotos/sugerir', { conversa: 'Qual o preço do buffet por pessoa?' });
  const corpo = await res.json();
  assert.equal(corpo.fonte, 'jev');
  assert.equal(corpo.enviar, 0.05);
  srv.close();
});

test('Jev lança erro/timeout: fallback fonte busca', async () => {
  const jev = criarJevFalso(new Error('timeout'));
  const { srv, post } = await subir(jev);
  const res = await post('/fotos/sugerir', { conversa: 'Quero ver como é o deck à noite' });
  const corpo = await res.json();
  assert.equal(corpo.fonte, 'busca');
  assert.equal(corpo.enviar, null);
  assert.equal(corpo.probabilidade, null);
  assert.ok(corpo.fotos.length > 0);
  srv.close();
});

test('Jev escolhe nenhuma: ordem da busca', async () => {
  const jev = criarJevFalso(() => ({
    model: 'jev-1.13.0',
    answers: {
      enviar_foto: { type: 'noul', noul: 0.7 },
      melhor: { type: 'choice', choice: 'nenhuma', confidence: 0.9, probabilities: { c1: 0.1, c2: 0.1, c3: 0.1, nenhuma: 0.7 } },
    },
  }));
  const { srv, post } = await subir(jev);
  const res = await post('/fotos/sugerir', { conversa: 'Quero ver como é o deck à noite' });
  const corpo = await res.json();
  assert.equal(corpo.fonte, 'jev');
  assert.equal(corpo.probabilidade, null);
  assert.ok(corpo.fotos.length > 0);
  srv.close();
});

test('candidata com criança nunca aparece', async () => {
  const jev = criarJevFalso(() => ({
    model: 'jev-1.13.0',
    answers: {
      enviar_foto: { type: 'noul', noul: 0.9 },
      melhor: { type: 'choice', choice: 'c1', confidence: 1.0, probabilities: { c1: 1.0, nenhuma: 0.0 } },
    },
  }));
  const { srv, post } = await subir(jev);
  const res = await post('/fotos/sugerir', { conversa: 'Quero ver o deck' });
  const corpo = await res.json();
  const ids = corpo.fotos.map(f => f.id);
  assert.ok(!ids.includes('crianca-deck'));
  srv.close();
});

test('corpo mandado ao Jev tem c1..cN e nenhuma e não tem ids internos', async () => {
  let corpoCapturado;
  const jev = criarJevFalso((corpo) => {
    corpoCapturado = corpo;
    return {
      model: 'jev-1.13.0',
      answers: {
        enviar_foto: { type: 'noul', noul: 0.5 },
        melhor: { type: 'choice', choice: 'c1', confidence: 1.0, probabilities: { c1: 1.0, nenhuma: 0.0 } },
      },
    };
  });
  const { srv, post } = await subir(jev);
  await post('/fotos/sugerir', { conversa: 'Quero ver o deck' });
  const opcoes = Object.keys(corpoCapturado.questions.melhor.criteria);
  assert.ok(opcoes.every(o => /^c\d+$/.test(o) || o === 'nenhuma'), `opcoes inesperadas: ${opcoes}`);
  assert.ok(opcoes.includes('nenhuma'));
  // state.candidatas usa c1..cN
  const chavesCandidatas = Object.keys(corpoCapturado.state.candidatas);
  assert.ok(chavesCandidatas.every(c => /^c\d+$/.test(c)));
  srv.close();
});

test('sem chave do Jev: fallback fonte busca', async () => {
  const { srv, post } = await subir(null);
  const res = await post('/fotos/sugerir', { conversa: 'Quero ver o deck' });
  const corpo = await res.json();
  assert.equal(corpo.fonte, 'busca');
  assert.equal(corpo.enviar, null);
  assert.equal(corpo.probabilidade, null);
  srv.close();
});

test('cliente jev.js refaz em 429 e desiste com erro claro depois das novas tentativas', async () => {
  const { consultarJev } = require('../src/jev');
  let tentativas = 0;
  const fetchFalso = async () => {
    tentativas++;
    return { ok: false, status: 429, text: async () => 'limite de taxa' };
  };
  try {
    await consultarJev({ chave: 'teste', fetchFn: fetchFalso }, {});
    assert.fail('deveria lançar');
  } catch (e) {
    assert.ok(e.message.includes('429'), `erro sem status: ${e.message}`);
    assert.equal(tentativas, 3); // 1 original + 2 novas tentativas
  }
});
