const { eventoDaPasta } = require('./pastas');
const fs = require('node:fs');
const path = require('node:path');
const { medir, avaliar } = require('./tecnica');
const { analisarFoto } = require('./ia');
const video = require('./video');

async function emParalelo(itens, n, fn) {
  let i = 0;
  const trabalhador = async () => { while (i < itens.length) await fn(itens[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
}

const caminhoPreview = (dirDados, id) => path.join(dirDados, 'midia', 'preview', `${id}.jpg`);

async function etapaTecnica(db, { dirDados }) {
  const pendentes = db.prepare("SELECT id, largura, altura FROM assets WHERE tipo_midia = 'imagem' AND st_tecnica = 'pendente'").all();
  const upd = db.prepare(`UPDATE assets SET st_tecnica = @st, nota_nitidez = @nitidez, nota_brilho = @brilho,
    tier = CASE WHEN @st = 'reprovada' THEN 'descartar' ELSE tier END WHERE id = @id`);
  for (const a of pendentes) {
    const m = await medir(caminhoPreview(dirDados, a.id));
    upd.run({ id: a.id, st: avaliar({ ...m, menorLado: Math.min(a.largura, a.altura) }), ...m });
  }
  return pendentes.length;
}

async function etapaIa(db, { dirDados, cliente, modelo, limite = Infinity, concorrencia = 4, refazerErros = false }) {
  const estados = refazerErros ? "('pendente','erro')" : "('pendente')";
  const fila = db.prepare(`SELECT id FROM assets WHERE tipo_midia = 'imagem' AND st_tecnica = 'ok' AND st_ia IN ${estados} LIMIT ?`)
    .all(Number.isFinite(limite) ? limite : -1);
  let ok = 0, erro = 0;
  await emParalelo(fila, concorrencia, async ({ id }) => {
    try {
      const campos = await analisarFoto(fs.readFileSync(caminhoPreview(dirDados, id)), { cliente, modelo });
      const sets = Object.keys(campos).map(c => `${c} = @${c}`).join(', ');
      db.prepare(`UPDATE assets SET ${sets}, st_ia = 'ok', erro = NULL WHERE id = @id`).run({ ...campos, id });
      ok++;
    } catch (e) {
      db.prepare("UPDATE assets SET st_ia = 'erro', erro = ? WHERE id = ?").run(e.message, id);
      erro++;
    }
  });
  return { ok, erro };
}

// evento e caminho da pasta no Drive entram para a busca achar o nome do casal ou da empresa do evento
function textoParaEmbedding(a) {
  return [a.titulo, a.descricao, a.legenda, a.espaco, a.local, a.tipo_evento, a.evento_pasta, a.caminho_pasta,
    ...JSON.parse(a.perguntas_que_responde || '[]')].filter(Boolean).join('\n');
}

async function etapaEmbedding(db, { cliente, modelo, lote = 50 }) {
  const mapa = new Map(db.prepare('SELECT id, nome, pai_id, caminho, evento FROM pastas').all().map(p => [p.id, p]));
  const fila = db.prepare("SELECT * FROM assets WHERE tipo_midia = 'imagem' AND st_ia = 'ok' AND st_embedding = 'pendente'").all().map(a => {
    const ev = eventoDaPasta(mapa, a.pasta_id);
    return { ...a, evento_pasta: ev ? mapa.get(ev).nome : null, caminho_pasta: mapa.get(a.pasta_id)?.caminho || null };
  });
  const del = db.prepare('DELETE FROM vec_texto WHERE asset_id = ?');
  const ins = db.prepare('INSERT INTO vec_texto(asset_id, embedding) VALUES (?, ?)');
  const marca = db.prepare("UPDATE assets SET st_embedding = 'ok' WHERE id = ?");
  for (let i = 0; i < fila.length; i += lote) {
    const parte = fila.slice(i, i + lote);
    const vetores = await cliente.embed(modelo, parte.map(textoParaEmbedding));
    db.transaction(() => parte.forEach((a, j) => { del.run(a.id); ins.run(a.id, vetores[j]); marca.run(a.id); }))();
  }
  return fila.length;
}

async function processar(db, opcoes) {
  const tecnica = await etapaTecnica(db, opcoes);
  const ia = await etapaIa(db, { ...opcoes, modelo: opcoes.modeloDescricao });
  const embedding = await etapaEmbedding(db, { ...opcoes, modelo: opcoes.modeloEmbedding });
  return { tecnica, ia, embedding };
}

// vídeo: só o que o trabalhador já entregou (st_video = 'ok')
async function processarVideos(db, opcoes) {
  const ia = await video.etapaIaVideo(db, { ...opcoes, modelo: opcoes.modeloDescricao });
  const embedding = await video.etapaEmbeddingVideo(db, { ...opcoes, modelo: opcoes.modeloEmbedding });
  const quadros = opcoes.modeloQuadro ? await video.etapaQuadros(db, { ...opcoes, modelo: opcoes.modeloQuadro, dim: opcoes.dimQuadro }) : null;
  return { ia, embedding, quadros };
}

module.exports = { processar, processarVideos, etapaTecnica, etapaIa, etapaEmbedding, textoParaEmbedding };
