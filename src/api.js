const path = require('node:path');
const express = require('express');
const { exposicao } = require('./clientes');
const { buscar } = require('./busca');
const { exigirEscopo } = require('./chaves');
const { criarLote } = require('./lote');
const { criarPainel, criarPublico } = require('./painel');
const { criarMcp } = require('./mcp');
const { rotasVideo } = require('./rotas_video');
const { rotasPecas } = require('./rotas_pecas');
const { rotasGuias } = require('./rotas_guias');

const DIR_PUBLICO = path.join(__dirname, '..', 'public');

// contador em memoria de chamadas ao sugerir
const contadorSugerir = { jev: 0, busca: 0, erros: 0 };

function formatar(a) {
  return {
    id: a.id, titulo: a.titulo, descricao: a.descricao, legenda: a.legenda, alt: a.alt,
    local: a.local, espaco: a.espaco, tipo_evento: a.tipo_evento, tipo: a.tipo,
    perguntas_que_responde: JSON.parse(a.perguntas_que_responde),
    tags: JSON.parse(a.tags || '[]'),
    destinos: JSON.parse(a.destinos), tier: a.tier, nota: a.nota_final,
    largura: a.largura, altura: a.altura,
    thumb_url: `/api/v1/midia/thumb/${a.id}.jpg`,
    preview_url: `/api/v1/midia/preview/${a.id}.jpg`,
    ...(a.distancia != null && { distancia: a.distancia }),
  };
}

function criarApp({ db, dirDados, embedQuery, embedQuadroQuery, jev, email, drive }) {
  const app = express();
  const v1 = express.Router();

  // a chave diz o cliente; a do trabalhador ('lote') não lê a API v1. A v1 é só de fotos: vídeo entra pela v2.
  v1.use(exigirEscopo(db, 'v1', req => req.get('X-API-Key')));

  const consultas = new Map();
  const exposta = (cliente, id) => {
    if (!consultas.has(cliente)) consultas.set(cliente, db.prepare(`SELECT a.* FROM assets a WHERE a.id = ? AND a.tipo_midia = 'imagem' AND ${exposicao(cliente)}`));
    return consultas.get(cliente).get(id);
  };

  v1.get('/fotos', async (req, res, next) => {
    try {
      const { q, local, espaco, tipo_evento, destino, tier, limite } = req.query;
      const linhas = await buscar(db, { q, local, espaco, tipo_evento, destino, tier, limite, externo: true, cliente: req.chave.cliente, tipo_midia: 'imagem' }, { embedQuery });
      res.json({ fotos: linhas.map(formatar) });
    } catch (e) { next(e); }
  });

  v1.get('/fotos/:id', (req, res) => {
    const a = exposta(req.chave.cliente, req.params.id);
    a ? res.json(formatar(a)) : res.status(404).json({ erro: 'não encontrada' });
  });

  v1.get('/midia/:tamanho/:arquivo', (req, res) => {
    const { tamanho, arquivo } = req.params;
    const id = arquivo.replace(/\.jpg$/, '');
    if (!['thumb', 'preview'].includes(tamanho) || !exposta(req.chave.cliente, id)) return res.status(404).end();
    res.sendFile(path.join(dirDados, 'midia', tamanho, `${id}.jpg`));
  });

  v1.get('/catalogo', (req, res) => {
    const { espaco, tipo_evento } = req.query;
    let sql = 'SELECT grupo, espaco, tipo_evento, n_fotos, conteudo, gerado_em FROM catalogo WHERE cliente_id = ?';
    const params = [req.chave.cliente];
    if (espaco) {
      sql += ' AND espaco = ?';
      params.push(espaco);
    }
    if (tipo_evento) {
      sql += ' AND tipo_evento = ?';
      params.push(tipo_evento);
    }
    sql += ' ORDER BY n_fotos DESC, grupo ASC';

    const linhas = db.prepare(sql).all(...params);

    const todosIds = new Set();
    const grupos = linhas.map(l => {
      const conteudo = JSON.parse(l.conteudo || '{}');
      for (const it of conteudo.itens || []) {
        for (const id of it.fotos || []) todosIds.add(id);
      }
      for (const it of conteudo.ideias || []) {
        for (const id of it.fotos || []) todosIds.add(id);
      }
      return {
        grupo: l.grupo,
        espaco: l.espaco,
        tipo_evento: l.tipo_evento,
        n_fotos: l.n_fotos,
        gerado_em: l.gerado_em,
        conteudo,
      };
    });

    let permitidos = new Set();
    if (todosIds.size > 0) {
      const placeholders = [...todosIds].map(() => '?').join(',');
      const rows = db.prepare(`SELECT a.id FROM assets a WHERE a.id IN (${placeholders}) AND a.tipo_midia = 'imagem' AND ${exposicao(req.chave.cliente)}`).all(...todosIds);
      permitidos = new Set(rows.map(r => r.id));
    }

    for (const g of grupos) {
      const { conteudo } = g;
      for (const it of conteudo.itens || []) {
        it.fotos = (it.fotos || [])
          .filter(id => permitidos.has(id))
          .map(id => ({
            id,
            thumb_url: `/api/v1/midia/thumb/${id}.jpg`,
            preview_url: `/api/v1/midia/preview/${id}.jpg`,
          }));
      }
      for (const it of conteudo.ideias || []) {
        it.fotos = (it.fotos || [])
          .filter(id => permitidos.has(id))
          .map(id => ({
            id,
            thumb_url: `/api/v1/midia/thumb/${id}.jpg`,
            preview_url: `/api/v1/midia/preview/${id}.jpg`,
          }));
      }
    }

    res.json({ catalogo: grupos });
  });

  // POST /api/v1/fotos/sugerir: o Jev decide SE o bot do cliente deve mandar foto e QUAL
  v1.post('/fotos/sugerir', express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const conversa = typeof req.body?.conversa === 'string' ? req.body.conversa.slice(-2000) : '';
      if (!conversa.trim()) return res.status(400).json({ erro: 'use {conversa, limite}' });
      const limite = Math.min(Math.max(Math.trunc(Number(req.body.limite)) || 3, 1), 10);
      const linhas = await buscar(db, { q: conversa, limite: 10, externo: true, cliente: req.chave.cliente, tipo_midia: 'imagem' }, { embedQuery });

      // sem candidatas: resposta sem chamar o Jev
      if (!linhas.length) {
        contadorSugerir.busca++;
        console.log('sugerir fonte=busca motivo=sem_candidatas');
        return res.json({ enviar: null, fotos: [], probabilidade: null, fonte: 'busca' });
      }

      // sem Jev: fallback busca
      if (!jev) {
        contadorSugerir.busca++;
        console.log('sugerir fonte=busca motivo=sem_chave');
        return res.json({ enviar: null, fotos: linhas.slice(0, limite).map(formatar), probabilidade: null, fonte: 'busca' });
      }

      // montar mapa c1..cN
      const mapa = {};
      const candidatas = {};
      linhas.forEach((l, i) => {
        const cid = `c${i + 1}`;
        mapa[cid] = l;
        candidatas[cid] = {
          titulo: l.titulo,
          espaco: l.espaco,
          tipo_evento: l.tipo_evento,
          perguntas_que_responde: JSON.parse(l.perguntas_que_responde),
        };
      });

      // montar criterios do choice
      const criterios = {};
      for (const [cid, c] of Object.entries(candidatas)) {
        criterios[cid] = `${c.titulo} (${c.espaco}, ${c.tipo_evento}): ${c.perguntas_que_responde.join('; ')}`;
      }
      criterios['nenhuma'] = 'Nenhuma candidata mostra o que o cliente pediu';

      const corpo = {
        model: 'jev-latest',
        state: { conversa, candidatas },
        questions: {
          enviar_foto: {
            type: 'noul',
            instructions: 'Pela conversa em `conversa`, o cliente pediu ou se beneficiaria agora de ver uma foto do espaço, da decoração, da gastronomia ou de um evento?',
            criteria: {
              true: 'Pediu foto, quer ver como fica, está comparando ou decidindo sobre o espaço',
              false: 'Só pergunta preço, data, horário, disponibilidade, logística, pede o cardápio ou o link do menu, comenta a imagem de um anúncio, ou está encerrando a conversa',
            },
          },
          melhor: {
            type: 'choice',
            instructions: 'Qual candidata em `candidatas` mostra melhor o que o cliente quer ver, segundo `conversa`?',
            criteria: criterios,
          },
        },
      };

      let respJev;
      const t0 = Date.now();
      try {
        respJev = await jev(corpo);
      } catch (e) {
        contadorSugerir.erros++;
        contadorSugerir.busca++;
        const motivo = e.message.slice(0, 60).replace(/\s+/g, '_');
        console.log(`sugerir fonte=busca motivo=${motivo}`);
        return res.json({ enviar: null, fotos: linhas.slice(0, limite).map(formatar), probabilidade: null, fonte: 'busca' });
      }
      const latencia = Date.now() - t0;

      // validar resposta
      const enviarResp = respJev?.answers?.enviar_foto;
      const melhorResp = respJev?.answers?.melhor;
      if (enviarResp?.noul == null || melhorResp?.choice == null || melhorResp?.probabilities == null || melhorResp?.confidence == null) {
        contadorSugerir.erros++;
        contadorSugerir.busca++;
        console.log('sugerir fonte=busca motivo=resposta_incompleta');
        return res.json({ enviar: null, fotos: linhas.slice(0, limite).map(formatar), probabilidade: null, fonte: 'busca' });
      }

      const enviar = enviarResp.noul;
      const escolha = melhorResp.choice;
      const confianca = melhorResp.confidence;
      const probabilidade = escolha !== 'nenhuma' ? (melhorResp.probabilities?.[escolha] ?? null) : null;

      // montar lista de fotos
      let fotosOrdenadas;
      if (escolha !== 'nenhuma' && mapa[escolha]) {
        const escolhida = mapa[escolha];
        const outras = linhas.filter(l => l.id !== escolhida.id);
        fotosOrdenadas = [escolhida, ...outras].slice(0, limite);
      } else {
        fotosOrdenadas = linhas.slice(0, limite);
      }

      contadorSugerir.jev++;
      console.log(`sugerir fonte=jev latencia_ms=${latencia} enviar=${enviar.toFixed(2)} confianca=${confianca.toFixed(2)} candidatas=${linhas.length}`);
      res.json({ enviar, fotos: fotosOrdenadas.map(formatar), probabilidade, confianca, fonte: 'jev' });
    } catch (e) { next(e); }
  });

  app.use('/api/v1', v1);
  // v2: vídeo (e imagem pelo mesmo formato), na regra de exposição externa do cliente da chave
  const v2 = express.Router();
  v2.use(exigirEscopo(db, 'v2', req => req.get('X-API-Key')));
  rotasVideo(v2, { db, dirDados, embedQuery, embedQuadroQuery, base: '/api/v2',
    contexto: req => ({ cliente: req.chave.cliente, externo: req.chave.escopos.includes('acervo') ? 'acervo' : true, quem: `chave:${req.chave.nome}` }) });
  rotasPecas(v2, { db, dirDados, embedQuery, embedQuadroQuery, base: '/api/v2',
    contexto: req => ({ cliente: req.chave.cliente, quem: `chave:${req.chave.nome}`, usuario: null }) });
  rotasGuias(v2, { db, contexto: req => ({ cliente: req.chave.cliente, quem: `chave:${req.chave.nome}` }) });
  app.use('/api/v2', v2);
  app.use('/api/lote', criarLote({ db, dirDados }));
  // atrás do Traefik: req.secure vem do X-Forwarded-Proto, e o cookie ganha Secure
  app.set('trust proxy', 1);
  app.use('/api/painel', criarPainel({ db, dirDados, embedQuery, embedQuadroQuery, email, drive, jev }));
  app.use('/mcp/:chave', criarMcp({ db, dirDados, embedQuery, embedQuadroQuery, drive }));
  app.use(criarPublico({ db, dirDados, dirPublico: DIR_PUBLICO }));

  // volta do consentimento do Google: o código fica na URL e é colado no terminal do scripts/autorizar-drive.js
  app.get('/oauth/callback', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Autorização do Drive</title><body style="font:16px system-ui;margin:40px;max-width:640px">
<h1>Quase lá</h1><p>Copie o endereço completo desta página (barra do navegador) e cole no terminal que está esperando.</p>
<p>Depois pode fechar esta aba.</p></body>`));

  app.use(express.static(DIR_PUBLICO));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: 'falha interna' }); });
  return app;
}

module.exports = { criarApp, contadorSugerir };
