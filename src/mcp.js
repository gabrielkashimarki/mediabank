// MCP remoto (Streamable HTTP, sem sessão) para o Claude buscar e ver fotos do acervo.
// A chave vai no caminho (/mcp/<chave>) porque conector personalizado do claude.ai não manda cabeçalho.
// Mostra o acervo interno (acervo(cliente)) do cliente da chave: ainda não aprovada entra, criança e descartada não.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { acervo, vocabularioDe } = require('./clientes');
const { buscar } = require('./busca');
const { exigirEscopo } = require('./chaves');
const { enviarOriginal } = require('./painel');
const { ESPACOS, TIPOS_EVENTO, GASTRONOMIA, LISTAS, USOS_VIDEO } = require('./vocabulario');
const { buscarVideos } = require('./busca_video');
const { FORMATOS_TRECHO } = require('./rotas_video');
const guias = require('./rotas_guias');

const VERSOES = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ponytail: as ferramentas usam as listas do cliente PADRAO; cliente com outro vocabulário ganha as próprias na fase 3
const ferramentas = cliente => [
  {
    name: 'buscar_fotos',
    description: vocabularioDe(cliente).MCP.descricaoBusca,
    inputSchema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'O que a foto deve mostrar, em português.' },
        sem_pessoas: { type: 'boolean', description: 'true traz só fotos sem pessoas (padrão true, bom para site e anúncio).' },
        espaco: { type: 'string', enum: ESPACOS },
        tipo_evento: { type: 'string', enum: Object.keys(TIPOS_EVENTO) },
        tipo: { type: 'string', enum: LISTAS.tipo, description: 'Assunto principal da foto.' },
        gastronomia: { type: 'string', enum: GASTRONOMIA },
        tags: { type: 'array', items: { type: 'string' }, description: 'Só o que tem todas estas tags (minúsculas, ex.: ["noite", "taça"]).' },
        nota_min: { type: 'number', description: 'Nota mínima de qualidade da IA, de 1 a 10.' },
        limite: { type: 'integer', minimum: 1, maximum: 30, description: 'Quantas fotos (padrão 12).' },
      },
      required: ['consulta'],
    },
  },
  {
    name: 'ver_foto',
    description: 'Mostra uma foto do acervo em tamanho de prévia, com a descrição completa e o link do original.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'buscar_videos',
    description: 'Busca trechos de vídeo do acervo pelo significado do texto, ex.: "brinde no deck à noite", "chef finalizando prato". '
      + 'Cada vídeo vem com as cenas que bateram (início e fim em segundos, descrição, nota de take de 0 a 10) e o quadro de cada cena para olhar. '
      + 'Sem consulta, traz os melhores takes.',
    inputSchema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'O que o trecho deve mostrar, em português.' },
        espaco: { type: 'string', enum: ESPACOS },
        tipo_evento: { type: 'string', enum: Object.keys(TIPOS_EVENTO) },
        uso: { type: 'string', enum: USOS_VIDEO, description: 'Para que o vídeo foi feito (TV e telão, rede social...).' },
        orientacao: { type: 'string', enum: ['horizontal', 'vertical'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Só o que tem todas estas tags (minúsculas, ex.: ["noite", "taça"]).' },
        limite: { type: 'integer', minimum: 1, maximum: 10, description: 'Quantos vídeos (padrão 5).' },
      },
    },
  },
  {
    name: 'ver_video',
    description: 'Mostra um vídeo do acervo: a tira com 4 quadros, a lista de cenas com tempo e nota de take, e a fala transcrita quando há.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ler_guia',
    description: 'Lê os guias do cliente: brandbook, playbook de edição e regras aprovadas. Sem slug, lista os guias; com slug, devolve o texto. '
      + 'Leia o playbook antes de montar ou revisar um vídeo.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  },
  {
    name: 'pedir_trecho',
    description: 'Pede o corte de um trecho do vídeo original (até 10 min). Devolve o link de download, que fica pronto em alguns minutos '
      + '(o corte é feito pelo trabalhador do Mac). corte exato; formato: original (resolução do arquivo), 1080p ou 540p; vertical: corta o centro em 9:16.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, ini: { type: 'number' }, fim: { type: 'number' },
        formato: { type: 'string', enum: FORMATOS_TRECHO }, vertical: { type: 'boolean' },
      },
      required: ['id', 'ini', 'fim'],
    },
  },
];

function criarMcp({ db, dirDados, embedQuery, embedQuadroQuery, drive }) {
  const r = express.Router({ mergeParams: true });
  const consultas = new Map();
  const exposta = (cliente, id) => {
    if (!consultas.has(cliente)) consultas.set(cliente, db.prepare(`SELECT a.* FROM assets a WHERE a.id = ? AND a.tipo_midia = 'imagem' AND ${acervo(cliente)}`));
    return consultas.get(cliente).get(id);
  };
  const imagem = (tamanho, id) => {
    const arq = path.join(dirDados, 'midia', tamanho, `${id}.jpg`);
    return fs.existsSync(arq) ? { type: 'image', mimeType: 'image/jpeg', data: fs.readFileSync(arq).toString('base64') } : null;
  };

  r.use(exigirEscopo(db, 'mcp', req => req.params.chave));

  r.get('/trecho/:id', (req, res) => {
    const t = db.prepare("SELECT * FROM tarefas WHERE id = ? AND cliente_id = ? AND tipo = 'trecho'").get(req.params.id, req.chave.cliente);
    if (!t) return res.status(404).json({ erro: 'não encontrado' });
    if (t.estado !== 'pronta') return res.status(t.estado === 'erro' ? 500 : 202).json({ estado: t.estado, erro: t.erro });
    res.download(path.join(dirDados, 'midia', t.arquivo), `trecho-${t.id}.mp4`);
  });

  r.get('/original/:id', async (req, res) => {
    const a = exposta(req.chave.cliente, req.params.id);
    if (!a?.drive_id) return res.status(404).json({ erro: 'não encontrada' });
    if (!drive) return res.status(503).json({ erro: 'drive não configurado' });
    try { await enviarOriginal(drive, a, res); } catch (e) {
      console.error('mcp original:', e.message);
      res.headersSent ? res.destroy() : res.status(502).json({ erro: 'falha ao abrir o original' });
    }
  });

  async function chamar(nome, args, base, cliente) {
    const resumo = a => ({
      id: a.id, titulo: a.titulo, descricao: a.descricao, espaco: a.espaco, tipo_evento: a.tipo_evento,
      tipo: a.tipo, gastronomia: a.gastronomia, tags: JSON.parse(a.tags || '[]'), nota: a.nota_rubrica, aprovacao: a.aprovacao, tem_pessoa: a.tem_pessoa, largura: a.largura, altura: a.altura,
      original_url: a.drive_id ? `${base}/original/${a.id}` : null,
    });
    if (nome === 'buscar_fotos') {
      const q = String(args.consulta || '').trim();
      if (!q) throw new Error('informe a consulta');
      const limite = Math.min(Math.max(Math.trunc(Number(args.limite)) || 12, 1), 30);
      const fotos = await buscar(db, {
        q, limite, externo: 'acervo', cliente, tipo_midia: 'imagem', espaco: args.espaco, tipo_evento: args.tipo_evento,
        tipo: args.tipo, gastronomia: args.gastronomia, tag: args.tags, nota_min: args.nota_min, pessoas: args.sem_pessoas === false ? undefined : 'sem',
      }, { embedQuery });
      if (!fotos.length) return [{ type: 'text', text: 'Nenhuma foto encontrada. Tente outra consulta ou tire filtros.' }];
      return [
        { type: 'text', text: JSON.stringify(fotos.map(resumo), null, 1) },
        ...fotos.flatMap(a => [{ type: 'text', text: `miniatura ${a.id}` }, imagem('thumb', a.id)].filter(Boolean)),
      ];
    }
    if (nome === 'ver_foto') {
      const a = exposta(cliente, String(args.id || ''));
      if (!a) throw new Error('foto não encontrada');
      return [{ type: 'text', text: JSON.stringify({ ...resumo(a), legenda: a.legenda, alt: a.alt }, null, 1) }, imagem('preview', a.id)].filter(Boolean);
    }
    const umVideo = id => db.prepare(`SELECT a.* FROM assets a WHERE a.id = ? AND a.tipo_midia = 'video' AND a.st_video = 'ok' AND ${acervo(cliente)}`).get(id);
    const cenaResumo = c => ({ id: c.id, ini: c.ini, fim: c.fim, descricao: c.descricao, nota_take: c.nota_take, ...(c.transcricao && { fala: c.transcricao }) });
    const resumoVideo = a => ({ id: a.id, titulo: a.titulo, descricao: a.descricao, tags: JSON.parse(a.tags || '[]'), espaco: a.espaco, tipo_evento: a.tipo_evento,
      duracao: a.duracao, largura: a.largura, altura: a.altura, aprovacao: a.aprovacao, drive_url: a.drive_id ? `https://drive.google.com/file/d/${a.drive_id}/view` : null });
    if (nome === 'buscar_videos') {
      const limite = Math.min(Math.max(Math.trunc(Number(args.limite)) || 5, 1), 10);
      const videos = await buscarVideos(db, { q: args.consulta, limite, cliente, externo: 'acervo', espaco: args.espaco, tipo_evento: args.tipo_evento,
        et_uso: args.uso, orientacao: args.orientacao, tag: args.tags },
        { embedQuery, embedQuadroQuery });
      if (!videos.length) return [{ type: 'text', text: 'Nenhum vídeo encontrado. Tente outra consulta ou tire filtros.' }];
      return [
        { type: 'text', text: JSON.stringify(videos.map(v => ({ ...resumoVideo(v), cenas: v.cenas.map(cenaResumo) })), null, 1) },
        ...videos.flatMap(v => v.cenas.flatMap(c => [{ type: 'text', text: `cena ${c.id} (${c.ini.toFixed(1)}–${c.fim.toFixed(1)} s)` }, imagem('cena', c.id)].filter(Boolean))),
      ];
    }
    if (nome === 'ver_video') {
      const a = umVideo(String(args.id || ''));
      if (!a) throw new Error('vídeo não encontrado');
      const cenas = db.prepare("SELECT * FROM cenas WHERE asset_id = ? AND st_tecnica = 'ok' ORDER BY ordem").all(a.id);
      return [{ type: 'text', text: JSON.stringify({ ...resumoVideo(a), legenda: a.legenda, fala: a.transcricao, cenas: cenas.map(cenaResumo) }, null, 1) }, imagem('tira', a.id)].filter(Boolean);
    }
    if (nome === 'ler_guia') {
      if (!args.slug) {
        const lista = guias.listar(db, cliente);
        return [{ type: 'text', text: lista.length ? JSON.stringify(lista.map(g => ({ slug: g.slug, titulo: g.titulo, tipo: g.tipo, versao: g.versao, atualizado_em: g.atualizado_em })), null, 1) : 'Este cliente ainda não tem guias.' }];
      }
      const g = guias.ler(db, cliente, String(args.slug));
      if (!g) throw new Error('guia não encontrado; chame ler_guia sem slug para ver a lista');
      return [{ type: 'text', text: `# ${g.titulo} (versão ${g.versao}, ${g.formato})

${g.conteudo}` }];
    }
    if (nome === 'pedir_trecho') {
      const a = umVideo(String(args.id || ''));
      if (!a) throw new Error('vídeo não encontrado');
      const ini = Number(args.ini), fim = Math.min(Number(args.fim), a.duracao || Infinity);
      const formato = args.formato || 'original', vertical = !!args.vertical;
      if (!Number.isFinite(ini) || !Number.isFinite(fim) || ini < 0 || fim <= ini || fim - ini > 600 || !FORMATOS_TRECHO.includes(formato)) throw new Error('trecho inválido: ini e fim em segundos, até 10 min');
      const tid = db.prepare("INSERT INTO tarefas (cliente_id, tipo, asset_id, parametros, criado_por) VALUES (?, 'trecho', ?, ?, ?)")
        .run(cliente, a.id, JSON.stringify({ ini, fim, formato, vertical }), 'mcp').lastInsertRowid;
      return [{ type: 'text', text: `Pedido de trecho ${tid} feito (${ini}–${fim} s, ${formato}${vertical ? ', vertical' : ''}). Fica pronto em alguns minutos: ${base}/trecho/${tid} (202 enquanto corta).` }];
    }
    throw new Error(`ferramenta desconhecida: ${nome}`);
  }

  r.post('/', express.json({ limit: '256kb' }), async (req, res) => {
    const { id, method, params = {} } = req.body || {};
    if (typeof method !== 'string') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'pedido inválido' } });
    if (id === undefined) return res.status(202).end(); // notificação (ex.: notifications/initialized)
    const responder = result => res.json({ jsonrpc: '2.0', id, result });
    const erro = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        return responder({
          protocolVersion: VERSOES.includes(params.protocolVersion) ? params.protocolVersion : VERSOES[0],
          capabilities: { tools: {} },
          serverInfo: { name: vocabularioDe(req.chave.cliente).MCP.nome, version: '1.0.0' },
          instructions: vocabularioDe(req.chave.cliente).MCP.instrucoes,
        });
      }
      if (method === 'ping') return responder({});
      if (method === 'tools/list') return responder({ tools: ferramentas(req.chave.cliente) });
      if (method === 'tools/call') {
        const base = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
        try {
          return responder({ content: await chamar(params.name, params.arguments || {}, base, req.chave.cliente) });
        } catch (e) {
          return responder({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      return erro(-32601, `método não suportado: ${method}`);
    } catch (e) {
      console.error('mcp:', e);
      return erro(-32603, 'falha interna');
    }
  });

  // sem sessão nem SSE: GET e DELETE não se aplicam
  r.all('/', (req, res) => res.status(405).set('Allow', 'POST').end());
  return r;
}

module.exports = { criarMcp };
