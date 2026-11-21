const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const sharp = require('sharp');
const { DESTINOS } = require('./vocabulario');
const { exigirEscopo } = require('./chaves');
const { medir, avaliar, LIMITES } = require('./tecnica');
const { registrar, vocabularioDe, VOCABULARIOS, PADRAO } = require('./clientes');
const { analiseDe, validarCenas, montarGrade, POR_GRADE } = require('./video');
const { tagsDoVideo } = require('./tags');

// cena reprovada no portão de vídeo: tremido acima disto (deslocamento médio entre quadros, em px a 160 px de largura).
// Só o extremo: nos 20 primeiros brutos reais de um cliente, câmera de celular andando deu 1,7 a 3,6, e o
// limite de 1,5 (calibrado em vídeo sintético) reprovava quase metade das cenas. O tremido segue pesando na nota de take.
const TREMIDO_MAX = Number(process.env.TEC_TREMIDO_MAX || 4);
// vídeo de 720p ainda serve (foto exige 800 px no lado menor)
const MIN_LADO_VIDEO = Number(process.env.TEC_MIN_LADO_VIDEO || 720);
const MAX_CENAS = 60;
const idCena = (assetId, ordem) => `${assetId}-${String(ordem).padStart(3, '0')}`;
const b64jpg = v => (typeof v === 'string' && v.length < 8e6 ? Buffer.from(v, 'base64') : null);

const BYTES_VETOR = 768 * 4;

// API do trabalhador de estética e CLIP (py/sinais.py --remoto, rodando no Mac).
// Só chave com escopo 'lote' entra (a de nome 'lote', antes dos escopos); ela não serve para a API v1.
// O trabalhador processa a mídia de todos os clientes.
function criarLote({ db, dirDados }) {
  const r = express.Router();
  r.use(exigirEscopo(db, 'lote', req => req.get('X-API-Key')));
  criarRotasVideo(r, { db, dirDados });
  r.use(express.json({ limit: '64kb' }));

  // Classificação de vídeo feita fora do servidor (o Claude da assinatura, ou uma classificação já pronta):
  // mesmo JSON que a IA de vídeo devolve ({campos do vídeo, cenas: [{n, descricao, qualidade}]}) e a mesma validação.
  const cenasOk = db.prepare("SELECT id, ordem, ini, fim FROM cenas WHERE asset_id = ? AND st_tecnica = 'ok' ORDER BY ordem");
  // Fila da assinatura: vídeos processados que esperam classificação, com as cenas (cada grade tem até 16 quadros numerados)
  r.get('/videos/ia-pendentes', (req, res) => {
    const limite = Math.min(Math.max(Math.trunc(Number(req.query.limite)) || 20, 1), 200);
    const cliente = typeof req.query.cliente === 'string' ? req.query.cliente : null;
    const vs = db.prepare(`SELECT a.id, a.cliente_id, a.duracao, a.orientacao, a.transcricao, p.caminho AS pasta FROM assets a LEFT JOIN pastas p ON p.id = a.pasta_id
      WHERE a.tipo_midia = 'video' AND a.st_video = 'ok' AND a.st_tecnica = 'ok' AND a.st_ia = 'pendente' AND (? IS NULL OR a.cliente_id = ?)
      ORDER BY a.data_foto DESC, a.id LIMIT ?`).all(cliente, cliente, limite);
    res.json(vs.map(v => {
      const cenas = cenasOk.all(v.id);
      return { ...v, transcricao: v.transcricao ? v.transcricao.slice(0, 1500) : null, cenas: cenas.length,
        grades: Array.from({ length: Math.ceil(cenas.length / POR_GRADE) }, (_, i) => `/api/lote/videos/${v.id}/grade/${i}.jpg`) };
    }));
  });
  r.get('/videos/:id/grade/:parte', async (req, res, next) => {
    try {
      const parte = Number.parseInt(req.params.parte, 10);
      const cenas = cenasOk.all(req.params.id).slice(parte * POR_GRADE, (parte + 1) * POR_GRADE);
      if (!cenas.length) return res.status(404).end();
      res.type('jpg').send(await montarGrade(cenas.map(c => path.join(dirDados, 'midia', 'cena', `${c.id}.jpg`))));
    } catch (e) { next(e); }
  });
  // as mesmas instruções que a IA paga recebe, com N no lugar do número de quadros
  r.get('/videos/instrucoes', (req, res) => {
    const cliente = typeof req.query.cliente === 'string' ? req.query.cliente : PADRAO;
    res.type('text').send(analiseDe(cliente).prompt('N', null));
  });

  r.get('/videos/por-drive', (req, res) => {
    const umPorDrive = db.prepare("SELECT id, drive_id, cliente_id, duracao, st_video, st_ia FROM assets WHERE drive_id = ? AND tipo_midia = 'video'");
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 500);
    res.json(ids.map(d => umPorDrive.get(d)).filter(Boolean).map(a => ({ ...a, cenas: cenasOk.all(a.id) })));
  });
  r.post('/videos/:id/analise', (req, res) => {
    const a = db.prepare("SELECT id, cliente_id, etiquetas FROM assets WHERE id = ? AND tipo_midia = 'video' AND st_video = 'ok'").get(req.params.id);
    if (!a) return res.status(404).json({ erro: 'vídeo processado não encontrado' });
    const v = analiseDe(a.cliente_id).validar({ ...(req.body || {}) });
    if (!v.ok) return res.status(400).json({ erros: v.erros });
    const cenas = cenasOk.all(a.id), porCena = validarCenas(req.body.cenas, cenas.length);
    // etiqueta que veio da curadoria (importação, equipe) vale mais que a da classificação
    if (v.campos.etiquetas) v.campos.etiquetas = JSON.stringify({ ...v.campos.etiquetas, ...JSON.parse(a.etiquetas || '{}') });
    const sets = Object.keys(v.campos).map(c => `${c} = @${c}`).join(', ');
    const updCena = db.prepare('UPDATE cenas SET descricao = @descricao, qualidade = @qualidade, nota_rubrica = @nota_rubrica, tags = @tags WHERE id = @id');
    v.campos.tags = JSON.stringify(tagsDoVideo(porCena.map(c => JSON.parse(c.tags)), JSON.parse(v.campos.tags || '[]')));
    db.transaction(() => {
      db.prepare(`UPDATE assets SET ${sets}, st_ia = 'ok', st_embedding = 'pendente', erro = NULL WHERE id = @id`).run({ ...v.campos, id: a.id });
      cenas.forEach((c, i) => updCena.run({ ...porCena[i], id: c.id }));
    })();
    res.json({ ok: true, cenas: cenas.length });
  });

  r.get('/pendentes', (req, res) => {
    const limite = Math.min(Math.max(Math.trunc(Number(req.query.limite)) || 50, 1), 500);
    res.json(db.prepare("SELECT id FROM assets WHERE tipo_midia = 'imagem' AND st_tecnica = 'ok' AND st_estetica = 'pendente' LIMIT ?").all(limite).map(a => a.id));
  });

  const existePendente = db.prepare("SELECT 1 FROM assets WHERE id = ? AND st_estetica = 'pendente'");
  r.get('/preview/:arquivo', (req, res) => {
    const id = req.params.arquivo.replace(/\.jpg$/, '');
    if (!existePendente.get(id)) return res.status(404).end();
    res.sendFile(path.join(dirDados, 'midia', 'preview', `${id}.jpg`), e => e && !res.headersSent && res.status(404).end());
  });

  const vetorValido = b64 => { const b = typeof b64 === 'string' ? Buffer.from(b64, 'base64') : null; return b && b.length === BYTES_VETOR ? b : null; };

  const existe = db.prepare('SELECT 1 FROM assets WHERE id = ?');
  r.post('/sinais', (req, res) => {
    const { id, nota_estetica: nota, vetor } = req.body || {};
    const buf = vetorValido(vetor);
    if (typeof id !== 'string' || !existe.get(id) || !Number.isFinite(nota) || nota < 0 || nota > 10 || !buf) return res.status(400).json({ erros: ['use {id, nota_estetica (0-10), vetor base64 de 768 float32}'] });
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO emb_imagem (asset_id, vetor) VALUES (?, ?)').run(id, buf);
      db.prepare("UPDATE assets SET nota_estetica = ?, st_estetica = 'ok' WHERE id = ?").run(nota, id);
    })();
    res.json({ ok: true });
  });

  r.post('/erro', (req, res) => {
    const { id, erro } = req.body || {};
    if (typeof id !== 'string' || typeof erro !== 'string') return res.status(400).json({ erros: ['use {id, erro}'] });
    const n = db.prepare("UPDATE assets SET st_estetica = 'erro', erro = ? WHERE id = ?").run(`estetica: ${erro}`.slice(0, 500), id).changes;
    res.status(n ? 200 : 404).json({ ok: !!n });
  });

  r.post('/moodboard', (req, res) => {
    const { destino, vetor, n } = req.body || {};
    const buf = vetorValido(vetor);
    if (!DESTINOS.includes(destino) || !buf || !Number.isInteger(n) || n < 1) return res.status(400).json({ erros: ['use {destino, vetor, n}'] });
    db.prepare('INSERT OR REPLACE INTO moodboard (destino, vetor, n) VALUES (?, ?, ?)').run(destino, buf, n);
    res.json({ ok: true });
  });

  return r;
}

// Vídeo: o trabalhador (py/videos.py) pega os pendentes, baixa o original do Drive no Mac e devolve
// pôster, tira, quadro-chave por cena e sinais de take; a prévia e os trechos sobem como mp4 cru.
function criarRotasVideo(r, { db, dirDados }) {
  const midia = (...p) => path.join(dirDados, 'midia', ...p);
  const video = db.prepare("SELECT * FROM assets WHERE id = ? AND tipo_midia = 'video'");

  // o original vem do Drive (drive_id) ou do volume do servidor (arquivo, importação)
  // corpo cru (mp4): vai para um temporário e só troca o arquivo quando chega inteiro
  // Arquivo grande vem em partes (?parte=0,1,2... e &fim=1 na última): o Traefik 2.11 corta a requisição que passa
  // de 60 s, e daqui sobe a ~1 MB/s. Sem ?parte, é um envio só (como antes). Devolve true quando o arquivo ficou completo.
  const receberMp4 = async (req, destino) => {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const tmp = `${destino}.parcial`;
    const parte = req.query.parte === undefined ? null : Number(req.query.parte);
    if (parte !== null && (!Number.isInteger(parte) || parte < 0)) throw new Error('parte inválida');
    if (parte > 0 && !fs.existsSync(tmp)) throw new Error('parte fora de ordem: comece da 0');
    await pipeline(req, fs.createWriteStream(tmp, { flags: parte > 0 ? 'a' : 'w' }));
    if (parte !== null && req.query.fim !== '1') return false;
    if (!fs.statSync(tmp).size) { fs.rmSync(tmp); throw new Error('arquivo vazio'); }
    fs.renameSync(tmp, destino);
    return true;
  };

  r.get('/videos/pendentes', (req, res) => {
    const limite = Math.min(Math.max(Math.trunc(Number(req.query.limite)) || 20, 1), 200);
    const cliente = typeof req.query.cliente === 'string' ? req.query.cliente : null; // ?cliente=outro: só os desse cliente
    // ?drive_ids=a,b: só estes arquivos do Drive (ex.: processar primeiro um lote já classificado)
    const driveIds = typeof req.query.drive_ids === 'string' ? JSON.stringify(req.query.drive_ids.split(',').filter(Boolean)) : null;
    res.json(db.prepare(`SELECT id, drive_id, duracao, cliente_id, arquivo IS NOT NULL AS arquivo FROM assets
      WHERE tipo_midia = 'video' AND st_video = 'pendente' AND (drive_id IS NOT NULL OR arquivo IS NOT NULL) AND (? IS NULL OR cliente_id = ?)
        AND (? IS NULL OR drive_id IN (SELECT value FROM json_each(?)))
      ORDER BY data_foto DESC, id LIMIT ?`).all(cliente, cliente, driveIds, driveIds, limite)
      .map(v => ({ ...v, arquivo: !!v.arquivo })));
  });

  r.get('/videos/:id/original', (req, res) => {
    const a = video.get(req.params.id);
    if (!a?.arquivo) return res.status(404).end();
    res.sendFile(path.join(dirDados, a.arquivo), e => e && !res.headersSent && res.status(404).end());
  });

  // Importação (banco de cenas, pasta local): cria os registros e diz quais precisam do arquivo.
  // Idempotente: a chave (ex.: clips2/acucar) vira caminho_origem <cliente>:<chave>; md5 repetido não entra.
  const APROVACAO = { ok: 'aprovada', evitar: 'evitar', reprovada: 'reprovada', pendente: 'pendente' };
  r.post('/importar', express.json({ limit: '2mb' }), (req, res) => {
    const { cliente, itens } = req.body || {};
    if (!Object.hasOwn(VOCABULARIOS, cliente) || !Array.isArray(itens) || !itens.length || itens.length > 1000) return res.status(400).json({ erros: ['use {cliente, itens: [...]}'] });
    registrar(db, vocabularioDe(cliente));
    const texto = (v, max = 500) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    const porCaminho = db.prepare('SELECT id, arquivo FROM assets WHERE caminho_origem = ?');
    const porMd5 = db.prepare('SELECT id, cliente_id FROM assets WHERE md5 = ?');
    const ins = db.prepare(`INSERT INTO assets (id, cliente_id, tipo_midia, origem, caminho_origem, md5, phash, formato, fonte, fonte_id, fonte_url, autor, licenca,
        origem_grupo, etiquetas, aprovacao, aprovacao_motivo, titulo, st_video, st_quadros, tem_crianca, data_foto)
      VALUES (@id, @cliente, 'video', 'importacao', @caminho, @md5, '', 'video/mp4', @fonte, @fonte_id, @fonte_url, @autor, @licenca,
        @grupo, @etiquetas, @aprovacao, @motivo, @titulo, 'pendente', 'pendente', 1, @data)`);
    const upd = db.prepare(`UPDATE assets SET fonte = @fonte, fonte_id = @fonte_id, fonte_url = @fonte_url, autor = coalesce(@autor, autor), licenca = @licenca,
        origem_grupo = @grupo, etiquetas = json_patch(etiquetas, @etiquetas), aprovacao = @aprovacao, aprovacao_motivo = @motivo WHERE id = @id`);
    const resultado = {};
    const erros = [];
    db.transaction(() => {
      for (const it of itens) {
        const chave = texto(it?.chave, 200);
        if (!chave || typeof it.md5 !== 'string' || !/^[0-9a-f]{32}$/.test(it.md5)) { erros.push(`item inválido: ${chave || '?'}`); continue; }
        const caminho = `${cliente}:${chave}`;
        const dados = {
          cliente, caminho, md5: it.md5, fonte: texto(it.fonte, 40), fonte_id: texto(it.fonte_id, 80), fonte_url: texto(it.fonte_url),
          autor: texto(it.autor, 200), licenca: texto(it.licenca, 40), titulo: texto(it.titulo, 120), data: texto(it.data, 40),
          etiquetas: JSON.stringify(it.etiquetas && typeof it.etiquetas === 'object' ? it.etiquetas : {}),
          aprovacao: APROVACAO[it.aprovacao] || 'pendente', motivo: texto(it.motivo),
        };
        dados.grupo = dados.fonte && dados.fonte_id ? `${dados.fonte}:${dados.fonte_id}` : texto(it.grupo, 200) || caminho;
        const ja = porCaminho.get(caminho);
        if (ja) { upd.run({ ...dados, id: ja.id }); resultado[chave] = { id: ja.id, precisa_arquivo: !ja.arquivo }; continue; }
        const outro = porMd5.get(it.md5);
        // mesmo arquivo com outro nome no mesmo cliente: vira apelido (o roteiro que cita esse nome continua achando a mídia)
        if (outro && outro.cliente_id === cliente) {
          db.prepare('INSERT OR IGNORE INTO apelidos (cliente_id, chave, asset_id) VALUES (?, ?, ?)').run(cliente, chave, outro.id);
          resultado[chave] = { id: outro.id, precisa_arquivo: false, apelido: true };
          continue;
        }
        if (outro) { erros.push(`${chave}: mesmo arquivo de ${outro.id} (${outro.cliente_id})`); continue; }
        const id = require('node:crypto').randomUUID();
        ins.run({ ...dados, id });
        resultado[chave] = { id, precisa_arquivo: true };
      }
    })();
    res.json({ itens: resultado, erros });
  });

  r.put('/originais/:id', async (req, res) => {
    const a = video.get(req.params.id);
    if (!a || a.drive_id) return res.status(404).json({ erro: 'vídeo importado não encontrado' });
    try {
      const arquivo = path.join('originais', a.cliente_id, `${a.id}.mp4`);
      if (!await receberMp4(req, path.join(dirDados, arquivo))) return res.json({ ok: true, parcial: true });
      db.prepare('UPDATE assets SET arquivo = ? WHERE id = ?').run(arquivo, a.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  r.post('/videos/:id', express.json({ limit: '60mb' }), async (req, res) => {
    const a = video.get(req.params.id);
    if (!a) return res.status(404).json({ erro: 'vídeo não encontrado' });
    const { meta = {}, poster, tira, cenas, transcricao = null } = req.body || {};
    const bufPoster = b64jpg(poster), bufTira = b64jpg(tira);
    const okCena = c => Number.isFinite(c?.ini) && Number.isFinite(c?.fim) && c.fim > c.ini && b64jpg(c.quadro);
    if (!bufPoster || !bufTira || !Array.isArray(cenas) || !cenas.length || cenas.length > MAX_CENAS || !cenas.every(okCena)) {
      return res.status(400).json({ erros: [`use {meta, poster, tira, cenas: [{ini, fim, quadro, phash, tremido, estetica}] (1 a ${MAX_CENAS})}`] });
    }
    try {
      const largura = Number(meta.largura) || a.largura, altura = Number(meta.altura) || a.altura;
      const menorLado = Math.min(largura || 0, altura || 0);
      for (const d of ['thumb', 'preview', 'tira', 'cena']) fs.mkdirSync(midia(d), { recursive: true });
      const img = sharp(bufPoster);
      await img.clone().resize(600, 600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(midia('thumb', `${a.id}.jpg`));
      await img.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(midia('preview', `${a.id}.jpg`));
      await sharp(bufTira).jpeg({ quality: 80 }).toFile(midia('tira', `${a.id}.jpg`));
      const linhas = [];
      for (const [i, c] of cenas.entries()) {
        const id = idCena(a.id, i);
        const arq = midia('cena', `${id}.jpg`);
        await sharp(b64jpg(c.quadro)).resize(600, 600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(arq);
        const { nitidez, brilho } = await medir(arq);
        const tremido = Number.isFinite(c.tremido) ? c.tremido : null;
        const st = avaliar({ nitidez, brilho, menorLado }, { ...LIMITES, menorLado: MIN_LADO_VIDEO }) === 'ok' && !(tremido > TREMIDO_MAX) ? 'ok' : 'reprovada';
        const fala = transcricao?.segmentos?.filter(s => s.fim > c.ini && s.ini < c.fim).map(s => s.texto).join(' ').trim() || null;
        linhas.push({ id, asset_id: a.id, cliente_id: a.cliente_id, ordem: i, ini: c.ini, fim: c.fim, phash: typeof c.phash === 'string' ? c.phash : null,
          nota_nitidez: nitidez, nota_exposicao: brilho, nota_tremido: tremido, nota_estetica: Number.isFinite(c.estetica) ? c.estetica : null, st_tecnica: st, transcricao: fala });
      }
      const algumaOk = linhas.some(l => l.st_tecnica === 'ok');
      db.transaction(() => {
        db.prepare('DELETE FROM cenas WHERE asset_id = ?').run(a.id);
        const ins = db.prepare(`INSERT INTO cenas (id, asset_id, cliente_id, ordem, ini, fim, phash, nota_nitidez, nota_exposicao, nota_tremido, nota_estetica, st_tecnica, transcricao)
          VALUES (@id, @asset_id, @cliente_id, @ordem, @ini, @fim, @phash, @nota_nitidez, @nota_exposicao, @nota_tremido, @nota_estetica, @st_tecnica, @transcricao)`);
        for (const l of linhas) ins.run(l);
        db.prepare(`UPDATE assets SET st_video = 'ok', st_tecnica = @st, st_ia = 'pendente', st_embedding = 'pendente', st_quadros = 'pendente', erro = NULL,
            tier = CASE WHEN @st = 'reprovada' THEN 'descartar' ELSE tier END,
            duracao = coalesce(@duracao, duracao), fps = @fps, codec = @codec, tem_audio = @tem_audio, largura = @largura, altura = @altura,
            orientacao = CASE WHEN @largura > @altura THEN 'horizontal' WHEN @largura < @altura THEN 'vertical' ELSE 'quadrado' END,
            phash = coalesce(@phash, phash), transcricao = @transcricao, nota_nitidez = @nitidez, nota_estetica = @estetica,
            data_foto = coalesce(@captura, data_foto) WHERE id = @id`).run({
          captura: typeof meta.captura === 'string' && !Number.isNaN(Date.parse(meta.captura)) ? new Date(meta.captura).toISOString() : null,
          id: a.id, st: algumaOk ? 'ok' : 'reprovada', duracao: Number(meta.duracao) || null, fps: Number(meta.fps) || null,
          codec: typeof meta.codec === 'string' ? meta.codec : null, tem_audio: meta.tem_audio ? 1 : 0, largura, altura,
          phash: typeof meta.phash === 'string' ? meta.phash : null, transcricao: typeof transcricao?.texto === 'string' ? transcricao.texto : null,
          nitidez: Math.max(...linhas.map(l => l.nota_nitidez)),
          estetica: linhas.some(l => l.nota_estetica != null) ? Math.max(...linhas.map(l => l.nota_estetica ?? -Infinity)) : null,
        });
      })();
      res.json({ ok: true, cenas: linhas.length, reprovadas: linhas.filter(l => l.st_tecnica !== 'ok').length });
    } catch (e) {
      console.error('lote vídeo:', e.message);
      res.status(500).json({ erro: e.message });
    }
  });

  r.put('/videos/:id/previa', async (req, res) => {
    const a = video.get(req.params.id);
    if (!a) return res.status(404).json({ erro: 'vídeo não encontrado' });
    try {
      if (!await receberMp4(req, midia('previa', `${a.id}.mp4`))) return res.json({ ok: true, parcial: true });
      db.prepare('UPDATE assets SET previa = 1 WHERE id = ?').run(a.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  r.post('/videos/:id/erro', express.json({ limit: '64kb' }), (req, res) => {
    const { erro } = req.body || {};
    if (typeof erro !== 'string') return res.status(400).json({ erros: ['use {erro}'] });
    const n = db.prepare("UPDATE assets SET st_video = 'erro', erro = ? WHERE id = ? AND tipo_midia = 'video'").run(`video: ${erro}`.slice(0, 500), req.params.id).changes;
    res.status(n ? 200 : 404).json({ ok: !!n });
  });

  // tarefas (trecho de vídeo): a pendente passa a andando quando o trabalhador a pega
  r.get('/tarefas/pendentes', (req, res) => {
    const fila = db.prepare(`SELECT t.id, t.tipo, t.asset_id, t.parametros, a.drive_id FROM tarefas t JOIN assets a ON a.id = t.asset_id
      WHERE t.estado = 'pendente' ORDER BY t.id LIMIT 20`).all();
    const marca = db.prepare("UPDATE tarefas SET estado = 'andando' WHERE id = ? AND estado = 'pendente'");
    res.json(fila.filter(t => marca.run(t.id).changes).map(t => ({ ...t, parametros: JSON.parse(t.parametros) })));
  });

  r.put('/tarefas/:id/arquivo', async (req, res) => {
    const t = db.prepare("SELECT id FROM tarefas WHERE id = ? AND estado = 'andando'").get(req.params.id);
    if (!t) return res.status(404).json({ erro: 'tarefa não encontrada' });
    try {
      const arquivo = path.join('trecho', `${t.id}.mp4`);
      if (!await receberMp4(req, midia(arquivo))) return res.json({ ok: true, parcial: true });
      db.prepare("UPDATE tarefas SET estado = 'pronta', arquivo = ?, pronta_em = datetime('now') WHERE id = ?").run(arquivo, t.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  r.post('/tarefas/:id/erro', express.json({ limit: '64kb' }), (req, res) => {
    const n = db.prepare("UPDATE tarefas SET estado = 'erro', erro = ? WHERE id = ? AND estado IN ('pendente', 'andando')")
      .run(String(req.body?.erro || 'sem detalhe').slice(0, 500), req.params.id).changes;
    res.status(n ? 200 : 404).json({ ok: !!n });
  });
}

module.exports = { criarLote, BYTES_VETOR, idCena, TREMIDO_MAX };
