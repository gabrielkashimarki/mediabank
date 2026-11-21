// Rotas de vídeo, montadas na API v2 (chave: cliente da chave, regra de exposição externa) e no painel
// (sessão: cliente aberto, tudo do cliente). `contexto(req)` diz o cliente, a regra e quem pede.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { buscar } = require('./busca');
const { buscarVideos, takesDoGrupo } = require('./busca_video');
const { exposicao, acervo, sqlCliente } = require('./clientes');

const FORMATOS_TRECHO = ['original', '1080p', '540p'];
const regra = ({ cliente, externo }) => (externo === 'acervo' ? acervo(cliente) : externo ? exposicao(cliente) : sqlCliente(cliente));

function formatarCena(c, base) {
  return { id: c.id, ordem: c.ordem, ini: c.ini, fim: c.fim, descricao: c.descricao, tags: JSON.parse(c.tags || '[]'), transcricao: c.transcricao || null,
    nota_take: c.nota_take, take_grupo: c.take_grupo, ...(c.pontos != null && { pontos: c.pontos }), quadro_url: `${base}/cenas/${c.id}.jpg` };
}

function formatarVideo(a, base) {
  return {
    id: a.id, tipo: 'video', titulo: a.titulo, descricao: a.descricao, legenda: a.legenda, espaco: a.espaco, local: a.local,
    tipo_evento: a.tipo_evento, tags: JSON.parse(a.tags || '[]'), duracao: a.duracao, largura: a.largura, altura: a.altura, orientacao: a.orientacao, tem_audio: !!a.tem_audio,
    nota_estetica: a.nota_estetica, aprovacao: a.aprovacao, exposta: a.exposta == null ? undefined : !!a.exposta,
    thumb_url: `${base}/midias/${a.id}/thumb.jpg`, tira_url: `${base}/midias/${a.id}/tira.jpg`,
    previa_url: a.previa ? `${base}/midias/${a.id}/previa.mp4` : null,
    drive_url: a.drive_id ? `https://drive.google.com/file/d/${a.drive_id}/view` : null,
    ...(a.cenas && { cenas: a.cenas.map(c => formatarCena(c, base)) }),
    ...(a.pontos != null && { pontos: a.pontos }),
  };
}

function rotasVideo(r, { db, dirDados, embedQuery, embedQuadroQuery, contexto, base }) {
  const midia = (...p) => path.join(dirDados, 'midia', ...p);
  const umVideo = (req, id) => db.prepare(`SELECT a.* FROM assets a WHERE a.id = ? AND a.tipo_midia = 'video' AND ${regra(contexto(req))}`).get(id);
  const enviar = (res, arq) => (fs.existsSync(arq) ? res.sendFile(arq) : res.status(404).end());

  // ?tipo=video (padrão) ou imagem; filtros iguais aos de fotos (espaco, tipo_evento, local...)
  r.get('/midias', async (req, res, next) => {
    try {
      // `tipo` aqui é imagem ou vídeo; a faceta de assunto das fotos (Espaço, Decoração...) vem como `assunto`
      const { tipo: midia, assunto, ...resto } = req.query;
      const filtros = { ...resto, ...(assunto && { tipo: assunto }), ...contexto(req) };
      if (midia === 'imagem') {
        const fotos = await buscar(db, { ...filtros, tipo_midia: 'imagem' }, { embedQuery });
        return res.json({ midias: fotos.map(a => ({ id: a.id, tipo: 'imagem', titulo: a.titulo, espaco: a.espaco, tipo_evento: a.tipo_evento,
          largura: a.largura, altura: a.altura, thumb_url: `${base}/midias/${a.id}/thumb.jpg` })) });
      }
      const videos = await buscarVideos(db, filtros, { embedQuery, embedQuadroQuery });
      res.json({ midias: videos.map(v => formatarVideo(v, base)) });
    } catch (e) { next(e); }
  });

  r.get('/midias/:id', (req, res) => {
    const a = umVideo(req, req.params.id);
    if (!a) return res.status(404).json({ erro: 'não encontrado' });
    const cenas = db.prepare("SELECT * FROM cenas WHERE asset_id = ? AND st_tecnica = 'ok' ORDER BY ordem").all(a.id);
    res.json({ ...formatarVideo({ ...a, cenas }, base), transcricao: a.transcricao });
  });

  r.get('/midias/:id/:arquivo', (req, res, next) => {
    const { id, arquivo } = req.params;
    const destino = { 'thumb.jpg': ['thumb', `${id}.jpg`], 'preview.jpg': ['preview', `${id}.jpg`], 'tira.jpg': ['tira', `${id}.jpg`], 'previa.mp4': ['previa', `${id}.mp4`] }[arquivo];
    const existe = db.prepare(`SELECT 1 FROM assets a WHERE a.id = ? AND ${regra(contexto(req))}`).get(id);
    if (!destino) return next(); // outro arquivo (ex.: /original, das rotas de peça)
    if (!existe) return res.status(404).end();
    enviar(res, midia(...destino)); // sendFile responde Range: o player pula para o meio da prévia sem baixar tudo
  });

  r.get('/cenas/:arquivo', (req, res) => {
    const id = req.params.arquivo.replace(/\.jpg$/, '');
    const ok = db.prepare(`SELECT 1 FROM cenas c JOIN assets a ON a.id = c.asset_id WHERE c.id = ? AND ${regra(contexto(req))}`).get(id);
    ok ? enviar(res, midia('cena', `${id}.jpg`)) : res.status(404).end();
  });

  r.get('/takes/:grupo', (req, res) => {
    res.json({ takes: takesDoGrupo(db, req.params.grupo, contexto(req)).map(c => ({ ...c, quadro_url: `${base}/cenas/${c.id}.jpg` })) });
  });

  // pede o trecho cortado do original; o trabalhador do Mac corta e devolve (estado em /tarefas/:id)
  r.post('/midias/:id/trecho', express.json({ limit: '16kb' }), (req, res) => {
    const a = umVideo(req, req.params.id);
    if (!a) return res.status(404).json({ erro: 'não encontrado' });
    const { ini, formato = 'original', vertical = false } = req.body || {};
    const fim = Math.min(req.body?.fim, a.duracao || Infinity); // fim além do vídeo vai até o fim dele
    if (!Number.isFinite(ini) || !Number.isFinite(fim) || ini < 0 || fim <= ini || fim - ini > 600
      || !FORMATOS_TRECHO.includes(formato) || typeof vertical !== 'boolean') {
      return res.status(400).json({ erros: [`use {ini, fim (segundos, até 10 min), formato: ${FORMATOS_TRECHO.join(' | ')} (original = resolução do arquivo), vertical: boolean}`] });
    }
    const { cliente, quem } = contexto(req);
    const id = db.prepare('INSERT INTO tarefas (cliente_id, tipo, asset_id, parametros, criado_por) VALUES (?, ?, ?, ?, ?)')
      .run(cliente, 'trecho', a.id, JSON.stringify({ ini, fim, formato, vertical }), quem).lastInsertRowid;
    res.status(202).json({ tarefa: id, estado: 'pendente', url: `${base}/tarefas/${id}` });
  });

  const tarefa = (req, id) => db.prepare('SELECT * FROM tarefas WHERE id = ? AND cliente_id = ?').get(id, contexto(req).cliente);
  r.get('/tarefas/:id', (req, res) => {
    const t = tarefa(req, req.params.id);
    if (!t) return res.status(404).json({ erro: 'não encontrada' });
    res.json({ tarefa: t.id, tipo: t.tipo, estado: t.estado, erro: t.erro, parametros: JSON.parse(t.parametros), asset_id: t.asset_id,
      arquivo_url: t.estado === 'pronta' ? `${base}/tarefas/${t.id}/arquivo` : null });
  });
  r.get('/tarefas/:id/arquivo', (req, res) => {
    const t = tarefa(req, req.params.id);
    if (!t || t.estado !== 'pronta') return res.status(404).end();
    res.download(midia(t.arquivo), `trecho-${t.asset_id.slice(0, 8)}-${t.id}.mp4`);
  });
}

module.exports = { rotasVideo, formatarVideo, formatarCena, FORMATOS_TRECHO };
