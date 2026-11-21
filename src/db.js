const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const { EXPOSICAO } = require('./vocabularios/exemplo');

const EMBED_DIM = Number(process.env.EMBED_DIM || 1536);

// Regra de exposição do cliente PADRAO, sem o filtro de cliente. Rota nova usa exposicao(cliente) / acervo(cliente) de clientes.js.
const SQL_ACERVO = EXPOSICAO.acervo;
const SQL_EXPOSICAO = EXPOSICAO.externa;

const SCHEMA = `
-- workspaces: cada mídia, coleção e chave é de um cliente (spec multi-cliente, 31/10/2026)
CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL DEFAULT 'exemplo',
  tipo_midia TEXT NOT NULL DEFAULT 'imagem',
  -- origem
  origem TEXT NOT NULL,
  caminho_origem TEXT,
  drive_id TEXT UNIQUE,
  md5 TEXT NOT NULL UNIQUE,
  phash TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  -- arquivo
  largura INTEGER, altura INTEGER, formato TEXT,
  data_foto TEXT, camera TEXT, lente TEXT, iso INTEGER, abertura REAL, velocidade TEXT, focal REAL,
  -- pipeline: pendente | ok | reprovada | erro
  st_tecnica TEXT NOT NULL DEFAULT 'pendente',
  st_ia TEXT NOT NULL DEFAULT 'pendente',
  st_embedding TEXT NOT NULL DEFAULT 'pendente',
  st_estetica TEXT NOT NULL DEFAULT 'pendente',
  st_score TEXT NOT NULL DEFAULT 'pendente',
  erro TEXT,
  -- onde / o quê
  espaco TEXT, local TEXT, tipo_evento TEXT, tipo TEXT,
  evento TEXT, fotografo TEXT, fornecedores TEXT NOT NULL DEFAULT '[]',
  -- decoração
  decoracao TEXT NOT NULL DEFAULT '{}',
  -- fotografia
  altura_camera TEXT, plano TEXT, composicao TEXT, ponto_vista TEXT,
  luz_tipo TEXT, luz_direcao TEXT, profundidade TEXT,
  -- proteção (padrão restritivo até a IA ou a equipe dizer o contrário)
  tem_crianca INTEGER NOT NULL DEFAULT 1,
  tem_pessoa INTEGER,
  gastronomia TEXT,
  qtd_rostos INTEGER,
  rostos_identificaveis INTEGER,
  autorizacao_uso TEXT NOT NULL DEFAULT 'desconhecida',
  marca_terceiro INTEGER,
  tem_texto INTEGER,
  indesejados TEXT NOT NULL DEFAULT '[]',
  -- conteúdo
  titulo TEXT, descricao TEXT, legenda TEXT, alt TEXT,
  capacidade_estimada INTEGER,
  perguntas_que_responde TEXT NOT NULL DEFAULT '[]',
  posicao_assunto TEXT, espaco_para_texto INTEGER, sazonal TEXT, tratamento TEXT,
  destinos_sugeridos TEXT NOT NULL DEFAULT '[]',
  qualidade TEXT NOT NULL DEFAULT '{}',
  problemas TEXT NOT NULL DEFAULT '[]',
  veredito TEXT,
  -- notas
  nota_nitidez REAL, nota_brilho REAL,
  nota_estetica REAL, nota_rubrica REAL, nota_moodboard REAL, nota_gosto REAL, elo REAL, nota_final REAL,
  -- curadoria
  tier TEXT NOT NULL DEFAULT 'arquivo',
  aprovacao TEXT NOT NULL DEFAULT 'pendente',
  aprovado_por INTEGER REFERENCES usuarios(id),
  aprovado_em TEXT,
  destinos TEXT NOT NULL DEFAULT '[]',
  -- curadoria
  rajada_id TEXT,
  tier_fixo INTEGER NOT NULL DEFAULT 0,
  pasta_id TEXT,
  -- campos do vocabulário de clientes que não são colunas; motivo de reprovada / evitar
  etiquetas TEXT NOT NULL DEFAULT '{}',
  aprovacao_motivo TEXT,
  -- vídeo (nulos em imagem): st_video vai de pendente a ok quando o trabalhador entrega cenas, pôster e prévia
  duracao REAL, fps REAL, codec TEXT, tem_audio INTEGER, orientacao TEXT, transcricao TEXT, previa INTEGER,
  st_video TEXT, st_quadros TEXT,
  -- origem e licença (banco externo, importação); origem_grupo junta o mesmo item salvo com nomes diferentes
  fonte TEXT, fonte_id TEXT, fonte_url TEXT, autor TEXT, licenca TEXT, origem_grupo TEXT, derivado_de TEXT,
  arquivo TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_espaco ON assets(espaco);
CREATE INDEX IF NOT EXISTS idx_assets_tipo_evento ON assets(tipo_evento);
CREATE INDEX IF NOT EXISTS idx_assets_caminho ON assets(caminho_origem);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  cliente_id TEXT NOT NULL DEFAULT 'exemplo',
  escopo TEXT,
  nome TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  hash_senha TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  onboarding_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- o cookie leva o token; o banco guarda só o sha256
CREATE TABLE IF NOT EXISTS sessoes (
  hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL,
  cliente_id TEXT
);

-- quem da equipe entra em qual cliente; usuário sem vínculo é do PADRAO (clientes.js)
CREATE TABLE IF NOT EXISTS membros (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'editor', 'leitor')),
  PRIMARY KEY (usuario_id, cliente_id)
);

CREATE TABLE IF NOT EXISTS redefinicoes (
  hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL,
  usado_em TEXT
);

CREATE TABLE IF NOT EXISTS pastas (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  pai_id TEXT,
  caminho TEXT NOT NULL,
  prob_evento REAL,
  evento INTEGER,
  evento_fixo INTEGER NOT NULL DEFAULT 0,
  avaliada_em TEXT
);

CREATE TABLE IF NOT EXISTS colecoes (
  id INTEGER PRIMARY KEY,
  cliente_id TEXT NOT NULL DEFAULT 'exemplo',
  nome TEXT NOT NULL,
  descricao TEXT,
  slug_publico TEXT UNIQUE,
  pasta_id TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS colecao_fotos (
  colecao_id INTEGER NOT NULL REFERENCES colecoes(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  posicao INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (colecao_id, asset_id)
);

-- embedding CLIP da imagem (float32, normalizado), gravado pelo py/sinais.py
CREATE TABLE IF NOT EXISTS emb_imagem (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  vetor BLOB NOT NULL
);

-- média dos embeddings das referências de cada destino (moodboard externo)
CREATE TABLE IF NOT EXISTS moodboard (
  destino TEXT PRIMARY KEY,
  vetor BLOB NOT NULL,
  n INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marcacoes (
  id INTEGER PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  destino TEXT NOT NULL,
  serve INTEGER NOT NULL,
  peso REAL NOT NULL DEFAULT 1,
  origem TEXT NOT NULL DEFAULT 'equipe',
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asset_id, destino, usuario_id, origem)
);

-- sinais e resultado por destino
CREATE TABLE IF NOT EXISTS pontuacao (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  destino TEXT NOT NULL,
  elegivel INTEGER NOT NULL DEFAULT 0,
  moodboard REAL, gosto REAL, score REAL, percentil REAL,
  elo REAL NOT NULL DEFAULT 1500,
  n_duelos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, destino)
);

CREATE TABLE IF NOT EXISTS duelos (
  id INTEGER PRIMARY KEY,
  destino TEXT NOT NULL,
  a TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  b TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  resultado TEXT NOT NULL CHECK (resultado IN ('a', 'b', 'pulado', 'descartar_ambas')),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_duelos_par ON duelos(destino, a, b);

-- fotos que a tela Marcar mostra primeiro (posts do Instagram casados com o acervo)
CREATE TABLE IF NOT EXISTS prioridade_marcar (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL
);

-- estado do sync do Drive (token do changes.list) e arquivos que falharam
CREATE TABLE IF NOT EXISTS sync_estado (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sync_falhas (
  drive_id TEXT PRIMARY KEY,
  nome TEXT,
  erro TEXT NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS catalogo (
  grupo TEXT PRIMARY KEY,
  espaco TEXT,
  tipo_evento TEXT,
  n_fotos INTEGER NOT NULL,
  assinatura TEXT NOT NULL,
  conteudo TEXT NOT NULL DEFAULT '{}',
  custo REAL,
  gerado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalogo_espaco ON catalogo(espaco);
CREATE INDEX IF NOT EXISTS idx_catalogo_tipo_evento ON catalogo(tipo_evento);

-- cortes de cena de um vídeo, com a nota de take (spec multi-cliente, seção 2)
CREATE TABLE IF NOT EXISTS cenas (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL,
  ordem INTEGER NOT NULL,
  ini REAL NOT NULL, fim REAL NOT NULL,
  phash TEXT,
  descricao TEXT, etiquetas TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', transcricao TEXT,
  -- sinais de take: técnica e estética do trabalhador; qualidade e rubrica da IA; nota_take em percentil por cliente
  nota_nitidez REAL, nota_exposicao REAL, nota_tremido REAL, nota_estetica REAL,
  qualidade TEXT NOT NULL DEFAULT '{}', nota_rubrica REAL,
  st_tecnica TEXT NOT NULL DEFAULT 'ok',
  nota_take REAL, take_grupo TEXT,
  UNIQUE (asset_id, ordem)
);
CREATE INDEX IF NOT EXISTS idx_cenas_asset ON cenas(asset_id);
CREATE INDEX IF NOT EXISTS idx_cenas_grupo ON cenas(take_grupo);

-- vetor de imagem do quadro-chave (embedding multimodal por API, float32 normalizado)
CREATE TABLE IF NOT EXISTS emb_quadro (
  cena_id TEXT PRIMARY KEY REFERENCES cenas(id) ON DELETE CASCADE,
  vetor BLOB NOT NULL
);

-- trabalho sob demanda que o trabalhador do Mac faz (trecho de vídeo; ampliação na fase 5)
CREATE TABLE IF NOT EXISTS tarefas (
  id INTEGER PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
  parametros TEXT NOT NULL DEFAULT '{}',
  estado TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'andando', 'pronta', 'erro')),
  erro TEXT,
  arquivo TEXT,
  custo REAL,
  criado_por TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  pronta_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_tarefas_estado ON tarefas(estado, tipo);

-- outro nome para a mesma mídia (um banco de cenas pode ter o mesmo arquivo salvo com dois nomes)
CREATE TABLE IF NOT EXISTS apelidos (
  cliente_id TEXT NOT NULL,
  chave TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (cliente_id, chave)
);

-- onde cada mídia entrou: plano de uma peça (vídeo, post, proposta); a regra de não repetir conta por origem_grupo
CREATE TABLE IF NOT EXISTS usos (
  id INTEGER PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  peca TEXT NOT NULL,
  plano INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  cena_id TEXT,
  ancora TEXT,
  ini REAL, fim REAL,               -- tempo do plano dentro do render da peça
  trecho_ini REAL, trecho_fim REAL, -- trecho usado da mídia (vídeo bruto)
  situacao TEXT NOT NULL DEFAULT 'planejado' CHECK (situacao IN ('planejado', 'publicado', 'retirado')),
  registrado_por TEXT NOT NULL,
  em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, peca, plano)
);
CREATE INDEX IF NOT EXISTS idx_usos_asset ON usos(asset_id);

-- peça em edição (vídeo, reel, proposta) com o render da versão atual para revisar
CREATE TABLE IF NOT EXISTS pecas (
  cliente_id TEXT NOT NULL,
  id TEXT NOT NULL,
  titulo TEXT,
  peca_tipo TEXT NOT NULL DEFAULT 'video',
  versao INTEGER NOT NULL DEFAULT 0,
  render INTEGER NOT NULL DEFAULT 0,
  situacao TEXT NOT NULL DEFAULT 'em_edicao' CHECK (situacao IN ('em_edicao', 'em_revisao', 'aprovada', 'publicada')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cliente_id, id)
);

-- decisões da revisão, plano a plano; a última de cada plano na versão vale
CREATE TABLE IF NOT EXISTS revisoes (
  id INTEGER PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  peca TEXT NOT NULL,
  versao INTEGER NOT NULL,
  plano INTEGER NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('aprovado', 'reprovado', 'trocar')),
  motivo TEXT,
  troca_asset_id TEXT REFERENCES assets(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revisoes_peca ON revisoes(cliente_id, peca, versao, plano);

-- brandbook, playbook de edição e outros guias do cliente, editáveis no painel; cada gravação guarda a versão anterior
CREATE TABLE IF NOT EXISTS guias (
  cliente_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  titulo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'outro' CHECK (tipo IN ('brandbook', 'playbook', 'outro')),
  formato TEXT NOT NULL DEFAULT 'markdown' CHECK (formato IN ('markdown', 'html')),
  conteudo TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1,
  atualizado_por TEXT,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cliente_id, slug)
);
CREATE TABLE IF NOT EXISTS guias_versoes (
  cliente_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  versao INTEGER NOT NULL,
  titulo TEXT NOT NULL,
  formato TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  por TEXT,
  em TEXT NOT NULL,
  PRIMARY KEY (cliente_id, slug, versao)
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_cena USING vec0(
  cena_id TEXT PRIMARY KEY,
  embedding float[${EMBED_DIM}] distance_metric=cosine
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_texto USING vec0(
  asset_id TEXT PRIMARY KEY,
  embedding float[${EMBED_DIM}] distance_metric=cosine
);
`;

// Banco criado antes de uma coluna existir não ganha a coluna pelo CREATE TABLE IF NOT EXISTS.
const COLUNAS_NOVAS = {
  assets: {
    aprovado_por: 'INTEGER REFERENCES usuarios(id)',
    aprovado_em: 'TEXT',
    rajada_id: 'TEXT',
    tier_fixo: 'INTEGER NOT NULL DEFAULT 0',
    qualidade: "TEXT NOT NULL DEFAULT '{}'",
    problemas: "TEXT NOT NULL DEFAULT '[]'",
    veredito: 'TEXT',
    pasta_id: 'TEXT',
    tem_pessoa: 'INTEGER',
    gastronomia: 'TEXT',
    // cliente_id sem REFERENCES: o SQLite não aceita ADD COLUMN com chave estrangeira e padrão não nulo
    cliente_id: "TEXT NOT NULL DEFAULT 'exemplo'",
    tipo_midia: "TEXT NOT NULL DEFAULT 'imagem'",
    etiquetas: "TEXT NOT NULL DEFAULT '{}'",
    tags: "TEXT NOT NULL DEFAULT '[]'",
    aprovacao_motivo: 'TEXT',
    ...Object.fromEntries(['duracao REAL', 'fps REAL', 'codec TEXT', 'tem_audio INTEGER', 'orientacao TEXT', 'transcricao TEXT',
      'previa INTEGER', 'st_video TEXT', 'st_quadros TEXT', 'fonte TEXT', 'fonte_id TEXT', 'fonte_url TEXT', 'autor TEXT',
      'licenca TEXT', 'origem_grupo TEXT', 'derivado_de TEXT', 'arquivo TEXT'].map(c => c.split(' '))),
  },
  // tags por take (a busca de vídeo é por cena)
  cenas: {
    tags: "TEXT NOT NULL DEFAULT '[]'",
  },
  colecoes: {
    pasta_id: 'TEXT',
    cliente_id: "TEXT NOT NULL DEFAULT 'exemplo'",
  },
  usuarios: {
    onboarding_em: 'TEXT',
  },
  api_keys: {
    cliente_id: "TEXT NOT NULL DEFAULT 'exemplo'",
    escopo: 'TEXT',
  },
  sessoes: {
    cliente_id: 'TEXT',
  },
  // moodboard fica sem cliente_id: a chave é o destino; moodboard por cliente reconstrói a tabela (fase 3)
  ...Object.fromEntries(['pastas', 'catalogo', 'marcacoes', 'duelos', 'pontuacao']
    .map(t => [t, { cliente_id: "TEXT NOT NULL DEFAULT 'exemplo'" }])),
};

function garantirColunas(db) {
  for (const [tabela, cols] of Object.entries(COLUNAS_NOVAS)) {
    const temTabela = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tabela);
    if (!temTabela) continue;
    const tem = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name));
    for (const [col, def] of Object.entries(cols)) {
      if (!tem.has(col)) {
        db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${col} ${def}`);
        // tier/destinos anteriores à curadoria foram escolha humana: preservar
        if (tabela === 'assets' && col === 'tier_fixo') {
          db.exec("UPDATE assets SET tier_fixo = 1 WHERE tier != 'arquivo' OR destinos != '[]'");
        }
      }
    }
  }
  const temColecoes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='colecoes'").get();
  if (temColecoes) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS colecoes_pasta ON colecoes(pasta_id) WHERE pasta_id IS NOT NULL');
  }
  const temAssets = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets'").get();
  if (temAssets) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_pasta ON assets(pasta_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_cliente ON assets(cliente_id, tipo_midia)');
    // não é único: um banco de cenas pode ter o mesmo item da Pexels salvo em dois arquivos (mesma origem, origem_grupo igual)
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_fonte ON assets(cliente_id, fonte, fonte_id) WHERE fonte_id IS NOT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_grupo ON assets(origem_grupo)');
  }
  // o primeiro cliente: tudo o que existia antes da spec multi-cliente é dele
  db.prepare("INSERT OR IGNORE INTO clientes (id, nome) VALUES ('exemplo', 'Casa Exemplo')").run();
}

function abrirBanco(caminho) {
  const db = new Database(caminho);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  garantirColunas(db);
  return db;
}

module.exports = { abrirBanco, SQL_EXPOSICAO, SQL_ACERVO, EMBED_DIM };
