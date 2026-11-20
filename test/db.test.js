const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco, SQL_EXPOSICAO } = require('../src/db');

function inserir(db, id, campos = {}) {
  const base = { id, origem: 'local', md5: id, phash: '0'.repeat(16), ...campos };
  const cols = Object.keys(base);
  db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
}

test('regra de exposição só deixa passar aprovada, sem criança, com uso permitido e fora do descarte', () => {
  const db = abrirBanco(':memory:');
  const ok = { aprovacao: 'aprovada', tem_crianca: 0, autorizacao_uso: 'desconhecida', tier: 'social' };
  inserir(db, 'ok', ok);
  inserir(db, 'pendente', { ...ok, aprovacao: 'pendente' });
  inserir(db, 'crianca', { ...ok, tem_crianca: 1 });
  inserir(db, 'proibida', { ...ok, autorizacao_uso: 'nao' });
  inserir(db, 'descartada', { ...ok, tier: 'descartar' });
  inserir(db, 'padrao', {});
  const ids = db.prepare(`SELECT id FROM assets a WHERE ${SQL_EXPOSICAO}`).all().map(r => r.id);
  assert.deepEqual(ids, ['ok']);
});

test('md5 repetido é recusado pelo banco', () => {
  const db = abrirBanco(':memory:');
  inserir(db, 'a', { md5: 'x' });
  assert.throws(() => inserir(db, 'b', { md5: 'x' }), /UNIQUE/);
});

test('vec_texto aceita embedding e devolve vizinho', () => {
  const db = abrirBanco(':memory:');
  const v = new Float32Array(1536); v[0] = 1;
  db.prepare('INSERT INTO vec_texto(asset_id, embedding) VALUES (?, ?)').run('a', v);
  const r = db.prepare('SELECT asset_id FROM vec_texto WHERE embedding MATCH ? AND k = 1').get(v);
  assert.equal(r.asset_id, 'a');
});

test('migração backfill: tier_fixo = 1 para linhas com tier != arquivo ou destinos != []', () => {
  const Database = require('better-sqlite3');
  const sqliteVec = require('sqlite-vec');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  // cria banco com schema antigo (sem tier_fixo)
  const tmp = path.join(os.tmpdir(), `db-mig-${Date.now()}.db`);
  const raw = new Database(tmp);
  sqliteVec.load(raw);
  raw.pragma('journal_mode = WAL');
  raw.exec(`CREATE TABLE assets (
    id TEXT PRIMARY KEY, origem TEXT NOT NULL, md5 TEXT NOT NULL UNIQUE,
    phash TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'arquivo',
    aprovacao TEXT NOT NULL DEFAULT 'pendente', tem_crianca INTEGER NOT NULL DEFAULT 1,
    autorizacao_uso TEXT NOT NULL DEFAULT 'desconhecida',
    destinos TEXT NOT NULL DEFAULT '[]',
    st_tecnica TEXT NOT NULL DEFAULT 'pendente', st_ia TEXT NOT NULL DEFAULT 'pendente',
    st_embedding TEXT NOT NULL DEFAULT 'pendente', st_estetica TEXT NOT NULL DEFAULT 'pendente',
    st_score TEXT NOT NULL DEFAULT 'pendente', largura INTEGER, altura INTEGER, formato TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    nota_nitidez REAL, nota_brilho REAL, nota_estetica REAL, nota_rubrica REAL, nota_moodboard REAL,
    nota_gosto REAL, elo REAL, nota_final REAL,
    titulo TEXT, descricao TEXT, legenda TEXT, alt TEXT,
    espaco TEXT, local TEXT, tipo_evento TEXT, tipo TEXT, evento TEXT, fotografo TEXT,
    fornecedores TEXT NOT NULL DEFAULT '[]', decoracao TEXT NOT NULL DEFAULT '{}',
    tem_texto INTEGER, marca_terceiro INTEGER, qtd_rostos INTEGER,
    rostos_identificaveis INTEGER, indesejados TEXT NOT NULL DEFAULT '[]',
    caminho_origem TEXT, drive_id TEXT UNIQUE,
    data_foto TEXT, camera TEXT, lente TEXT, iso INTEGER, abertura REAL, velocidade TEXT, focal REAL,
    altura_camera TEXT, plano TEXT, composicao TEXT, ponto_vista TEXT,
    luz_tipo TEXT, luz_direcao TEXT, profundidade TEXT,
    capacidade_estimada INTEGER, perguntas_que_responde TEXT NOT NULL DEFAULT '[]',
    posicao_assunto TEXT, espaco_para_texto INTEGER, sazonal TEXT, tratamento TEXT,
    destinos_sugeridos TEXT NOT NULL DEFAULT '[]', erro TEXT, rajada_id TEXT
  )`);
  raw.prepare("INSERT INTO assets (id, origem, md5, phash, tier) VALUES ('heroi', 'local', 'h1', '0000000000000000', 'hero')").run();
  raw.prepare("INSERT INTO assets (id, origem, md5, phash, tier) VALUES ('normal', 'local', 'n1', '0000000000000001', 'arquivo')").run();
  raw.prepare("INSERT INTO assets (id, origem, md5, phash, destinos) VALUES ('dest', 'local', 'd1', '0000000000000002', '[\"social\"]')").run();
  raw.close();
  // abre com abrirBanco (que roda garantirColunas)
  const db = abrirBanco(tmp);
  assert.equal(db.prepare("SELECT tier_fixo FROM assets WHERE id = 'heroi'").get().tier_fixo, 1);
  assert.equal(db.prepare("SELECT tier_fixo FROM assets WHERE id = 'normal'").get().tier_fixo, 0);
  assert.equal(db.prepare("SELECT tier_fixo FROM assets WHERE id = 'dest'").get().tier_fixo, 1);
  db.close();
  fs.unlinkSync(tmp);
});
