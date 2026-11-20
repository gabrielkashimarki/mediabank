const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { ingerirArquivo } = require('./ingestao');
const { PADRAO } = require('./clientes');

const TENTATIVAS = 3;
const TAMANHO_MAX = 40 * 1024 * 1024;
const TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/tiff', 'image/x-adobe-dng'];

const lerEstado = (db, chave) => db.prepare('SELECT valor FROM sync_estado WHERE chave = ?').get(chave)?.valor ?? null;
const gravarEstado = (db, chave, valor) => db.prepare(`INSERT INTO sync_estado (chave, valor) VALUES (?, ?)
  ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')`).run(chave, valor);

// Uma imagem do Drive: pula sem baixar se o drive_id ou o md5 (que o Drive informa) já existem.
async function importar(db, drive, f, { dirDados }) {
  // já importada: aproveita a listagem para preencher a pasta de fotos anteriores ao pasta_id, sem chamada extra ao Drive
  if (db.prepare('UPDATE assets SET pasta_id = coalesce(pasta_id, ?) WHERE drive_id = ?').run(f.parents?.[0] || null, f.id).changes) return 'repetido';
  if (f.md5Checksum && db.prepare('SELECT 1 FROM assets WHERE md5 = ?').get(f.md5Checksum)) return 'repetido';
  if ((db.prepare('SELECT tentativas FROM sync_falhas WHERE drive_id = ?').get(f.id)?.tentativas ?? 0) >= TENTATIVAS) return 'ignorado';

  // tipo ou tamanho incompatível: nem baixa
  if (!TIPOS.includes(f.mimeType)) {
    db.prepare(`INSERT INTO sync_falhas (drive_id, nome, erro, tentativas) VALUES (?, ?, ?, ?)
      ON CONFLICT (drive_id) DO UPDATE SET erro = excluded.erro, tentativas = excluded.tentativas`).run(f.id, f.name, `tipo não suportado: ${f.mimeType}`, TENTATIVAS);
    return 'ignorado';
  }
  if (Number(f.size) > TAMANHO_MAX) {
    const mb = (Number(f.size) / (1024 * 1024)).toFixed(1);
    db.prepare(`INSERT INTO sync_falhas (drive_id, nome, erro, tentativas) VALUES (?, ?, ?, ?)
      ON CONFLICT (drive_id) DO UPDATE SET erro = excluded.erro, tentativas = excluded.tentativas`).run(f.id, f.name, `grande demais: ${mb} MB`, TENTATIVAS);
    return 'ignorado';
  }

  // conta a tentativa ANTES de baixar (se o processo morrer, a tentativa já contou)
  const ext = path.extname(f.name || '').toLowerCase();
  db.prepare(`INSERT INTO sync_falhas (drive_id, nome, erro) VALUES (?, ?, 'em andamento')
    ON CONFLICT (drive_id) DO UPDATE SET tentativas = tentativas + 1`).run(f.id, f.name);

  const tmp = path.join(os.tmpdir(), `mb-drive-${f.id}-${crypto.randomUUID()}${ext}`);
  try {
    fs.writeFileSync(tmp, await drive.baixar(f.id));
    const pastaId = f.parents?.[0] || null;
    const r = await ingerirArquivo(db, tmp, { dirDados, origem: 'drive', driveId: f.id, caminhoOrigem: `drive:${f.id}`, pastaId });
    db.prepare('DELETE FROM sync_falhas WHERE drive_id = ?').run(f.id);
    return r.novo ? 'novo' : 'repetido';
  } catch (e) {
    db.prepare(`UPDATE sync_falhas SET erro = ? WHERE drive_id = ?`).run(e.message.slice(0, 500), f.id);
    return 'falha';
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Vídeo não é baixado no servidor: entra como registro (md5, duração e dimensões vêm do Drive) e o trabalhador
// do Mac (py/videos.py) baixa, corta em cenas e devolve pôster, quadros e prévia. Repetido pelo md5 e arquivo vazio não entram.
function registrarVideo(db, f, { cliente = PADRAO } = {}) {
  if (db.prepare('UPDATE assets SET pasta_id = coalesce(pasta_id, ?) WHERE drive_id = ?').run(f.parents?.[0] || null, f.id).changes) return 'repetido';
  if (!Number(f.size)) return 'ignorado';
  if (f.md5Checksum && db.prepare('SELECT 1 FROM assets WHERE md5 = ?').get(f.md5Checksum)) return 'repetido';
  const v = f.videoMediaMetadata || {};
  const w = Number(v.width) || null, h = Number(v.height) || null;
  db.prepare(`INSERT INTO assets (id, cliente_id, tipo_midia, origem, caminho_origem, drive_id, md5, phash, pasta_id, largura, altura,
      formato, duracao, orientacao, data_foto, st_video, st_quadros)
    VALUES (@id, @cliente, 'video', 'drive', @caminho, @drive_id, @md5, '', @pasta, @w, @h, @formato, @duracao, @orientacao, @data, 'pendente', 'pendente')`).run({
    id: crypto.randomUUID(), cliente, caminho: `drive:${f.id}`, drive_id: f.id, md5: f.md5Checksum || `drive:${f.id}`,
    pasta: f.parents?.[0] || null, w, h, formato: f.mimeType, duracao: v.durationMillis != null ? Number(v.durationMillis) / 1000 : null,
    orientacao: !w || !h ? null : w > h ? 'horizontal' : w < h ? 'vertical' : 'quadrado', data: f.createdTime || null,
  });
  return 'novo';
}

// Vídeos que já estavam no Drive antes de ligar SYNC_VIDEO não aparecem no changes.list: uma carga única lista todos.
async function cargaVideos(db, drive, r) {
  if (lerEstado(db, 'videos_carga')) return;
  for await (const f of drive.videos()) r.videos[registrarVideo(db, f)]++;
  gravarEstado(db, 'videos_carga', new Date().toISOString());
}

// Primeira vez: lista todas as imagens que a conta vê. Depois: só o changes.list desde o último token.
// O token só avança quando a passada termina inteira e sem falha: com limite de fotos novas ou com
// download que falhou, a próxima passada relê as mesmas mudanças, sem baixar de novo o que já entrou
// (pula pelo drive_id e pelo md5). Arquivo que falha 3 vezes é ignorado e deixa o token andar.
// videos: com true (SYNC_VIDEO=1), vídeo novo também entra, como registro sem download.
async function sincronizar(db, drive, { dirDados, limite = Infinity, videos = false } = {}) {
  const r = { novos: 0, repetidos: 0, falhas: 0, ignorados: 0, completo: true, modo: null };
  if (videos) r.videos = { novo: 0, repetido: 0, ignorado: 0 };
  const token = lerEstado(db, 'drive_token');
  let arquivos, novoToken;
  if (token) {
    r.modo = 'mudancas';
    ({ arquivos, novoToken } = await drive.mudancas(token));
    if (videos) for (const f of arquivos) if (!f.trashed && (f.mimeType || '').startsWith('video/')) r.videos[registrarVideo(db, f)]++;
    arquivos = arquivos.filter(f => !f.trashed && (f.mimeType || '').startsWith('image/'));
  } else {
    r.modo = 'inicial';
    novoToken = await drive.tokenInicial(); // pego antes de listar: nada que mude durante a listagem se perde
    arquivos = drive.imagens();
  }
  for await (const f of arquivos) {
    if (r.novos >= limite) { r.completo = false; break; }
    const s = await importar(db, drive, f, { dirDados });
    r[{ novo: 'novos', repetido: 'repetidos', falha: 'falhas', ignorado: 'ignorados' }[s]]++;
  }
  if (videos) await cargaVideos(db, drive, r);
  if (r.completo && !r.falhas && novoToken) gravarEstado(db, 'drive_token', novoToken);
  gravarEstado(db, 'ultimo_sync', new Date().toISOString());
  return r;
}

module.exports = { sincronizar, importar, registrarVideo, lerEstado, gravarEstado, TENTATIVAS, TAMANHO_MAX, TIPOS };
