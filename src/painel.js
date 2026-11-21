const path = require('node:path');
const { pipeline, Readable } = require('node:stream');
const express = require('express');
const auth = require('./auth');
const { buscar, contar, facetas } = require('./busca');
const { editar, aprovar } = require('./edicao');
const col = require('./colecoes');
const { clientesDoUsuario, vocabularioDe, sqlCliente } = require('./clientes');
const { sincronizarColecoesDeEvento } = require('./pastas');
const { rotasVideo } = require('./rotas_video');
const { rotasPecas } = require('./rotas_pecas');
const { rotasGuias } = require('./rotas_guias');

const JSON_COLS = ['tags', 'fornecedores', 'decoracao', 'indesejados', 'perguntas_que_responde', 'destinos_sugeridos', 'destinos', 'qualidade', 'problemas'];
const BOOL_COLS = ['tem_pessoa', 'tem_crianca', 'rostos_identificaveis', 'marca_terceiro', 'tem_texto', 'espaco_para_texto', 'exposta'];

// linha do banco para o painel: JSON aberto, 0/1 como boolean, sem caminho interno do Mac
function formatar(a) {
  const { caminho_origem, ...f } = a;
  f.arquivo = path.basename(caminho_origem || '');
  for (const c of JSON_COLS) if (c in f) f[c] = JSON.parse(f[c]);
  for (const c of BOOL_COLS) if (c in f && f[c] != null) f[c] = !!f[c];
  f.thumb_url = `/api/painel/midia/thumb/${a.id}.jpg`;
  f.preview_url = `/api/painel/midia/preview/${a.id}.jpg`;
  if (a.drive_id) {
    f.drive_url = `https://drive.google.com/file/d/${a.drive_id}/view`;
    f.original_url = `/api/painel/fotos/${a.id}/original`;
  }
  return f;
}

const idsDoCorpo = b => (Array.isArray(b?.ids) && b.ids.length <= 500 && b.ids.every(i => typeof i === 'string') ? b.ids : null);
const idsOriginais = b => (Array.isArray(b?.ids) && b.ids.length <= 300 && b.ids.every(i => typeof i === 'string') ? b.ids : null);
const escaparHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function conferirOrigem(req) {
  const host = req.get('host');
  if (!host) return false;
  const extrairHost = (urlStr) => {
    try { return new URL(urlStr).host; } catch { return null; }
  };
  const hostOrigem = extrairHost(req.get('origin'));
  if (hostOrigem && hostOrigem === host) return true;
  const hostReferer = extrairHost(req.get('referer'));
  if (hostReferer && hostReferer === host) return true;
  return false;
}

function nomeUnico(nome, usados) {
  const ext = path.extname(nome);
  const base = path.basename(nome, ext);
  let atual = nome;
  let contador = 2;
  while (usados.has(atual.toLowerCase())) {
    atual = `${base} (${contador})${ext}`;
    contador++;
  }
  usados.add(atual.toLowerCase());
  return atual;
}

function sanitizarNomeArquivo(nome) {
  const base = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'colecao';
}

function criarZip(opcoes = { zlib: { level: 0 } }) {
  const archiver = require('archiver');
  if (typeof archiver === 'function') return archiver('zip', opcoes);
  if (archiver.ZipArchive) return new archiver.ZipArchive(opcoes);
  return new archiver(opcoes);
}

async function transmitirZip(res, { db, drive, ids, nomeZip, cliente }) {
  const nomesUsados = new Set();
  const faltaram = [];

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nomeZip)}`);

  const archive = criarZip({ zlib: { level: 0 } });
  archive.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  archive.pipe(res);

  for (const id of ids) {
    if (res.destroyed) break;
    const a = db.prepare(`SELECT a.id, a.drive_id FROM assets a WHERE a.id = ? AND ${sqlCliente(cliente)}`).get(id);
    if (!a || !a.drive_id) {
      faltaram.push(`Foto ${id}: sem original no Drive`);
      continue;
    }

    let meta, orig;
    try {
      meta = await drive.arquivo(a.drive_id, 'name,mimeType');
      orig = await drive.abrirOriginal(a.drive_id);
    } catch (err) {
      faltaram.push(`Foto ${id}: erro no Drive (${err.message})`);
      continue;
    }

    const nomeOriginal = meta?.name || `${a.id}.jpg`;
    const nomeFinal = nomeUnico(nomeOriginal, nomesUsados);

    const streamNode = (orig.corpo && typeof orig.corpo.pipe === 'function')
      ? orig.corpo
      : (orig.corpo && typeof Readable.fromWeb === 'function' && orig.corpo.getReader
        ? Readable.fromWeb(orig.corpo)
        : Readable.from(orig.corpo));

    try {
      await new Promise((resolve, reject) => {
        const onEntry = (e) => {
          if (e.name === nomeFinal) {
            limpar();
            resolve();
          }
        };
        const onErr = (err) => {
          limpar();
          reject(err);
        };
        function limpar() {
          archive.removeListener('entry', onEntry);
          archive.removeListener('error', onErr);
          streamNode.removeListener('error', onErr);
        }
        archive.on('entry', onEntry);
        archive.on('error', onErr);
        streamNode.on('error', onErr);
        archive.append(streamNode, { name: nomeFinal });
      });
    } catch (err) {
      faltaram.push(`Foto ${id}: erro no Drive (${err.message})`);
    }
  }

  if (faltaram.length > 0) {
    const texto = ['As seguintes fotos nao puderam ser incluidas:', '', ...faltaram].join('\n') + '\n';
    archive.append(texto, { name: 'LEIA-ME.txt' });
  }

  await archive.finalize();
}

// manda o original do Drive como download (painel e MCP)
async function enviarOriginal(drive, a, res) {
  const meta = await drive.arquivo(a.drive_id, 'name,mimeType');
  const orig = await drive.abrirOriginal(a.drive_id);

  const nomeArquivo = meta?.name || `${a.id}.jpg`;
  const tipo = orig.tipo || meta?.mimeType || 'application/octet-stream';
  res.setHeader('Content-Type', tipo);
  if (orig.tamanho) res.setHeader('Content-Length', orig.tamanho);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nomeArquivo)}`);

  const streamNode = (orig.corpo && typeof orig.corpo.pipe === 'function')
    ? orig.corpo
    : (orig.corpo && typeof Readable.fromWeb === 'function' && orig.corpo.getReader
      ? Readable.fromWeb(orig.corpo)
      : Readable.from(orig.corpo));

  pipeline(streamNode, res, (err) => {
    if (err && !res.destroyed) res.destroy();
  });
}

function criarPainel({ db, dirDados, embedQuery, embedQuadroQuery, email, drive, jev }) {
  const r = express.Router();
  // COOKIE_SEGURO=1 em produção: garante Secure mesmo se o proxy não mandar X-Forwarded-Proto
  const seguro = req => req.secure || process.env.COOKIE_SEGURO === '1';

  r.post('/login', express.json(), (req, res) => {
    const e = auth.entrar(db, req.body?.email, req.body?.senha);
    if (e.erro === 'bloqueado') return res.status(429).json({ erro: 'muitas tentativas, espere 15 minutos' });
    if (e.erro) return res.status(401).json({ erro: 'e-mail ou senha errados' });
    res.set('Set-Cookie', auth.cookieSessao(e.token, { seguro: seguro(req) })).json(e.usuario);
  });

  r.post('/esqueci-senha', express.json(), (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ erro: 'use JSON' });
    const rPed = auth.pedirRedefinicao(db, req.body?.email);
    if (rPed?.token && email) {
      const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
      const link = `${base}/login.html?redefinir=${rPed.token}`;
      const nome = escaparHtml(rPed.nome);
      const html = `<p>Olá, ${nome}!</p><p><a href="${link}">Clique aqui para redefinir sua senha</a></p><p>O link vale por 30 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>`;
      // sem await: esperar o SMTP só para e-mail cadastrado revelaria pelo tempo quem tem conta
      email.enviar({ para: rPed.email, assunto: 'Redefinir senha do MediaBank', html })
        .catch(err => console.error('erro ao enviar e-mail de redefinição:', err.message));
    }
    res.json({ ok: true });
  });

  r.post('/redefinir-senha', express.json(), (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ erro: 'use JSON' });
    const { token, senha } = req.body || {};
    const ret = auth.redefinirSenha(db, token, senha);
    if (ret.erro === 'senha_curta') return res.status(400).json({ erro: 'A senha precisa ter pelo menos 10 caracteres.' });
    if (ret.erro === 'link_invalido') return res.status(400).json({ erro: 'Link inválido ou vencido. Peça um novo.' });
    res.json({ ok: true });
  });

  r.use(auth.exigirLogin(db));
  r.use(express.json());

  // Cliente aberto: o escolhido na sessão, se o usuário tem acesso; senão o primeiro dele.
  // Toda rota abaixo lê e grava só em req.cliente. Leitor não altera nada.
  r.use((req, res, next) => {
    req.clientes = clientesDoUsuario(db, req.usuario);
    if (!req.clientes.length) return res.status(403).json({ erro: 'sem acesso a nenhum cliente' });
    const escolhido = auth.clienteDaSessao(db, auth.lerCookie(req));
    const atual = req.clientes.find(c => c.id === escolhido) || req.clientes[0];
    req.cliente = atual.id;
    req.papel = atual.papel;
    const livre = ['/logout', '/cliente', '/onboarding'].includes(req.path);
    if (req.papel === 'leitor' && req.method !== 'GET' && !livre) return res.status(403).json({ erro: 'acesso só de leitura' });
    next();
  });
  // vídeo: busca por cena, prévia, takes e trecho; a equipe vê tudo do cliente aberto
  rotasVideo(r, { db, dirDados, embedQuery, embedQuadroQuery, base: '/api/painel',
    contexto: req => ({ cliente: req.cliente, externo: false, quem: `usuario:${req.usuario.id}` }) });
  rotasPecas(r, { db, dirDados, embedQuery, embedQuadroQuery, base: '/api/painel',
    contexto: req => ({ cliente: req.cliente, quem: `usuario:${req.usuario.id}`, usuario: req.usuario.id }) });
  rotasGuias(r, { db, contexto: req => ({ cliente: req.cliente, quem: req.usuario.nome }) });

  // admin do cliente aberto (admin global é admin de todos)
  const exigirAdmin = (req, res, next) => (req.papel === 'admin' ? next() : res.status(403).json({ erro: 'só administrador' }));

  r.post('/logout', (req, res) => {
    auth.sair(db, auth.lerCookie(req));
    res.set('Set-Cookie', auth.cookieApagado()).json({ ok: true });
  });
  r.get('/eu', (req, res) => {
    const { contadorSugerir } = require('./api');
    const u = db.prepare('SELECT onboarding_em FROM usuarios WHERE id = ?').get(req.usuario.id);
    res.json({ ...req.usuario, onboarding_feito: Boolean(u?.onboarding_em), sugerir: contadorSugerir, cliente: req.cliente, papel: req.papel, clientes: req.clientes });
  });
  r.post('/cliente', (req, res) => {
    if (!req.clientes.some(c => c.id === req.body?.id)) return res.status(403).json({ erro: 'sem acesso a este cliente' });
    auth.escolherCliente(db, auth.lerCookie(req), req.body.id);
    res.json({ cliente: req.body.id });
  });
  r.post('/onboarding', (req, res) => {
    db.prepare("UPDATE usuarios SET onboarding_em = datetime('now') WHERE id = ?").run(req.usuario.id);
    res.json({ ok: true });
  });
  // o front monta facetas e campos de edição destas listas, sem cópia no HTML
  r.get('/vocabulario', (req, res) => {
    const { LOCAIS, VISTA_AEREA, TIPOS_EVENTO, LISTAS, DESTINOS, TIERS, AUTORIZACAO_USO, GASTRONOMIA } = vocabularioDe(req.cliente);
    res.json({ LOCAIS, VISTA_AEREA, TIPOS_EVENTO, LISTAS, DESTINOS, TIERS, AUTORIZACAO_USO, GASTRONOMIA });
  });

  r.get('/fotos', async (req, res, next) => {
    try {
      const filtros = { ...req.query, externo: false, cliente: req.cliente };
      const fotos = await buscar(db, filtros, { embedQuery, jev });
      res.json({ fotos: fotos.map(formatar), total: contar(db, filtros) });
    } catch (e) { next(e); }
  });

  r.get('/facetas', (req, res) => res.json(facetas(db, { ...req.query, externo: false, cliente: req.cliente })));

  // consultas presas ao cliente, preparadas uma vez por cliente
  const porCliente = new Map();
  const consultas = cliente => {
    if (!porCliente.has(cliente)) {
      porCliente.set(cliente, {
        umaFoto: db.prepare(`SELECT a.*, (${vocabularioDe(cliente).EXPOSICAO.externa}) AS exposta, u.nome AS aprovado_por_nome
          FROM assets a LEFT JOIN usuarios u ON u.id = a.aprovado_por WHERE a.id = ? AND ${sqlCliente(cliente)}`),
        driveDaFoto: db.prepare(`SELECT a.id, a.drive_id FROM assets a WHERE a.id = ? AND ${sqlCliente(cliente)}`),
        existe: db.prepare(`SELECT 1 FROM assets a WHERE a.id = ? AND ${sqlCliente(cliente)}`),
        colecao: db.prepare('SELECT * FROM colecoes WHERE id = ? AND cliente_id = ?'),
      });
    }
    return porCliente.get(cliente);
  };
  const umaFoto = { get: (id, cliente) => consultas(cliente).umaFoto.get(id) };
  const colecoesDaFoto = db.prepare('SELECT c.id, c.nome FROM colecao_fotos cf JOIN colecoes c ON c.id = cf.colecao_id WHERE cf.asset_id = ?');
  const pontuacaoDaFoto = db.prepare(`SELECT destino, elegivel, moodboard, score, percentil
    FROM pontuacao WHERE asset_id = ? ORDER BY destino`);
  r.get('/fotos/:id', (req, res) => {
    const a = umaFoto.get(req.params.id, req.cliente);
    if (!a) return res.status(404).json({ erro: 'não encontrada' });
    res.json({ ...formatar(a), colecoes: colecoesDaFoto.all(a.id), pontuacao: pontuacaoDaFoto.all(a.id) });
  });

  r.get('/fotos/:id/original', async (req, res, next) => {
    try {
      const a = consultas(req.cliente).driveDaFoto.get(req.params.id);
      if (!a) return res.status(404).json({ erro: 'não encontrada' });
      if (!a.drive_id) return res.status(404).json({ erro: 'foto sem original no Drive' });
      if (!drive) return res.status(503).json({ erro: 'drive não configurado' });

      await enviarOriginal(drive, a, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ erro: e.message });
      else res.destroy();
    }
  });

  r.patch('/fotos/:id', (req, res) => {
    const v = editar(db, [req.params.id], req.body, req.usuario, req.cliente);
    if (!v.ok) return res.status(400).json({ erros: v.erros });
    if (!v.n) return res.status(404).json({ erro: 'não encontrada' });
    res.json({ ...formatar(umaFoto.get(req.params.id, req.cliente)), colecoes: colecoesDaFoto.all(req.params.id) });
  });

  r.post('/fotos/lote', (req, res) => {
    const ids = idsDoCorpo(req.body);
    if (!ids) return res.status(400).json({ erros: ['ids inválidos'] });
    const v = editar(db, ids, req.body.campos, req.usuario, req.cliente);
    v.ok ? res.json({ n: v.n }) : res.status(400).json({ erros: v.erros });
  });

  r.post('/fotos/aprovar', exigirAdmin, (req, res) => {
    const ids = idsDoCorpo(req.body);
    if (!ids || typeof req.body.aprovar !== 'boolean') return res.status(400).json({ erros: ['use {ids, aprovar: true|false}'] });
    res.json({ n: aprovar(db, ids, req.body.aprovar, req.usuario, req.cliente) });
  });

  r.post('/originais.zip', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      if (!drive) return res.status(503).json({ erro: 'drive não configurado' });
      if (req.is('application/x-www-form-urlencoded')) {
        if (!conferirOrigem(req)) return res.status(403).json({ erro: 'origem não permitida' });
        if (typeof req.body?.ids === 'string') {
          try {
            req.body.ids = JSON.parse(req.body.ids);
          } catch {
            return res.status(400).json({ erros: ['ids inválidos'] });
          }
        }
      }
      const ids = idsOriginais(req.body);
      if (!ids) return res.status(400).json({ erros: ['ids inválidos'] });

      await transmitirZip(res, { db, drive, ids, nomeZip: `fotos-${req.cliente}.zip`, cliente: req.cliente });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ erro: e.message });
      else res.destroy();
    }
  });

  // equipe vê toda mídia do cliente; o id precisa existir no banco, o que também barra "../"
  r.get('/midia/:tamanho/:arquivo', (req, res) => {
    const id = req.params.arquivo.replace(/\.jpg$/, '');
    if (!['thumb', 'preview'].includes(req.params.tamanho) || !consultas(req.cliente).existe.get(id)) return res.status(404).end();
    res.sendFile(path.join(dirDados, 'midia', req.params.tamanho, `${id}.jpg`), e => e && !res.headersSent && res.status(404).end());
  });

  r.get('/colecoes', (req, res) => res.json(col.listar(db, req.cliente)));
  r.post('/colecoes', (req, res) => {
    try { res.status(201).json({ id: col.criar(db, req.body || {}, req.usuario, req.cliente) }); }
    catch (e) { res.status(400).json({ erros: [e.message] }); }
  });
  const colecao = { get: (id, cliente) => consultas(cliente).colecao.get(id, cliente) };
  r.get('/colecoes/:id', (req, res) => {
    const c = colecao.get(req.params.id, req.cliente);
    c ? res.json({ ...c, fotos: col.fotosDaColecao(db, c.id).map(formatar) }) : res.status(404).json({ erro: 'não encontrada' });
  });
  r.get('/colecoes/:id/originais.zip', async (req, res, next) => {
    try {
      if (!drive) return res.status(503).json({ erro: 'drive não configurado' });
      const c = colecao.get(req.params.id, req.cliente);
      if (!c) return res.status(404).json({ erro: 'não encontrada' });

      const fotos = col.fotosDaColecao(db, c.id);
      const ids = fotos.map(f => f.id);
      const nomeSanitizado = sanitizarNomeArquivo(c.nome);
      const nomeZip = `${nomeSanitizado}.zip`;

      await transmitirZip(res, { db, drive, ids, nomeZip, cliente: req.cliente });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ erro: e.message });
      else res.destroy();
    }
  });
  // coleção de outro cliente responde como inexistente
  const daColecao = fn => (req, res) => (colecao.get(req.params.id, req.cliente) ? fn(req, res) : res.status(404).json({ erro: 'não encontrada' }));
  r.delete('/colecoes/:id', daColecao((req, res) => res.status(col.excluir(db, req.params.id) ? 204 : 404).end()));
  r.post('/colecoes/:id/fotos', (req, res) => {
    const ids = idsDoCorpo(req.body);
    if (!ids) return res.status(400).json({ erros: ['ids inválidos'] });
    if (!colecao.get(req.params.id, req.cliente)) return res.status(404).json({ erro: 'não encontrada' });
    res.json({ n: col.adicionar(db, req.params.id, ids) });
  });
  r.delete('/colecoes/:id/fotos/:asset', daColecao((req, res) => res.status(col.remover(db, req.params.id, req.params.asset) ? 204 : 404).end()));
  r.post('/colecoes/:id/publicar', daColecao((req, res) => {
    const s = col.publicar(db, req.params.id);
    s ? res.json({ slug_publico: s, url: `/c/${s}` }) : res.status(404).json({ erro: 'não encontrada' });
  }));
  r.delete('/colecoes/:id/publicar', daColecao((req, res) => res.status(col.despublicar(db, req.params.id) ? 204 : 404).end()));

  r.post('/pastas/:id/evento', exigirAdmin, (req, res) => {
    if (typeof req.body?.evento !== 'boolean') return res.status(400).json({ erro: 'use {evento: boolean}' });
    const ev = req.body.evento ? 1 : 0;
    const info = db.prepare("UPDATE pastas SET evento = ?, evento_fixo = 1, avaliada_em = datetime('now') WHERE id = ? AND cliente_id = ?").run(ev, req.params.id, req.cliente);
    if (!info.changes) return res.status(404).json({ erro: 'pasta não encontrada' });
    const rSync = sincronizarColecoesDeEvento(db);
    res.json({ ok: true, ...rSync });
  });

  r.get('/catalogo', (req, res) => {
    const linhas = db.prepare('SELECT grupo, espaco, tipo_evento, n_fotos, gerado_em, conteudo FROM catalogo WHERE cliente_id = ? ORDER BY n_fotos DESC, grupo ASC').all(req.cliente);
    const grupos = linhas.map(l => ({
      grupo: l.grupo,
      espaco: l.espaco,
      tipo_evento: l.tipo_evento,
      n_fotos: l.n_fotos,
      gerado_em: l.gerado_em,
      conteudo: JSON.parse(l.conteudo || '{}'),
    }));
    res.json(grupos);
  });

  r.post('/catalogo/regerar', exigirAdmin, (req, res) => {
    const { grupo } = req.body || {};
    if (!grupo || typeof grupo !== 'string') return res.status(400).json({ erro: 'use {grupo}' });
    const info = db.prepare("UPDATE catalogo SET assinatura = '' WHERE grupo = ? AND cliente_id = ?").run(grupo, req.cliente);
    if (!info.changes) return res.status(404).json({ erro: 'grupo não encontrado' });
    res.json({ ok: true });
  });

  return r;
}

// página e dados do link do cliente: sem login, só o que passa na regra de exposição
function criarPublico({ db, dirDados, dirPublico }) {
  const r = express.Router();
  r.get('/c/:slug', (req, res) => (col.colecaoPublica(db, req.params.slug)
    ? res.sendFile(path.join(dirPublico, 'colecao.html')) : res.status(404).send('Coleção não encontrada')));
  r.get('/c/:slug/dados', (req, res) => {
    const c = col.colecaoPublica(db, req.params.slug);
    c ? res.json(c) : res.status(404).json({ erro: 'não encontrada' });
  });
  r.get('/c/:slug/midia/:tamanho/:arquivo', (req, res) => {
    const id = req.params.arquivo.replace(/\.jpg$/, '');
    if (!['thumb', 'preview'].includes(req.params.tamanho) || !col.fotoPublica(db, req.params.slug, id)) return res.status(404).end();
    res.sendFile(path.join(dirDados, 'midia', req.params.tamanho, `${id}.jpg`), e => e && !res.headersSent && res.status(404).end());
  });
  return r;
}

module.exports = { criarPainel, criarPublico, formatar, enviarOriginal };
