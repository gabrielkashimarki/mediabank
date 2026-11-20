-- schema da main em 31/10/2026, antes da spec multi-cliente (test/clientes.test.js abre um banco neste formato)

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
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
  pasta_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_espaco ON assets(espaco);
CREATE INDEX IF NOT EXISTS idx_assets_tipo_evento ON assets(tipo_evento);
CREATE INDEX IF NOT EXISTS idx_assets_caminho ON assets(caminho_origem);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
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
  expira_em TEXT NOT NULL
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

CREATE VIRTUAL TABLE IF NOT EXISTS vec_texto USING vec0(
  asset_id TEXT PRIMARY KEY,
  embedding float[1536] distance_metric=cosine
);
