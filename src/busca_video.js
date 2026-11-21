// Busca de vídeo por cena: semelhança da frase com o texto da cena (descrição, fala, contexto) e com o
// quadro-chave (vetor de imagem), somadas por posição (RRF). Resposta por vídeo, com as cenas que bateram.
const { montarOnde } = require('./busca');

const K_RRF = 60;
const CENAS_POR_VIDEO = 3;

const vetor = buf => new Float32Array(new Uint8Array(buf).buffer);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// do grupo de takes repetidos fica só o de maior nota (os outros saem em /takes/:grupo)
function melhoresDoGrupo(cenas) {
  const melhor = new Map();
  for (const c of cenas) if (c.take_grupo && (!melhor.has(c.take_grupo) || (c.nota_take ?? -1) > (melhor.get(c.take_grupo).nota_take ?? -1))) melhor.set(c.take_grupo, c);
  return cenas.filter(c => !c.take_grupo || melhor.get(c.take_grupo) === c);
}

async function buscarVideos(db, filtros, { embedQuery, embedQuadroQuery } = {}) {
  const limite = Math.min(Math.max(Math.trunc(Number(filtros.limite)) || 24, 1), 100);
  const offset = Math.max(Math.trunc(Number(filtros.offset)) || 0, 0);
  // tag filtra o take: cena com a tag (cena ainda sem tags usa as do vídeo)
  const { tag, ...semTag } = filtros;
  const { onde, params, exposta } = montarOnde({ ...semTag, tipo_midia: 'video' });
  for (const t of [].concat(tag ?? []).map(x => String(x).toLowerCase()).filter(Boolean)) {
    onde.push(`(EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?) OR (c.tags = '[]' AND EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?)))`);
    params.push(t, t);
  }
  const cenas = db.prepare(`SELECT c.id, c.asset_id, c.ordem, c.ini, c.fim, c.descricao, c.transcricao, c.nota_take, c.take_grupo, c.tags
    FROM cenas c JOIN assets a ON a.id = c.asset_id WHERE ${onde.join(' AND ')} AND c.st_tecnica = 'ok'`).all(...params);
  const q = String(filtros.q || '').trim();
  let pontos;
  if (q && (embedQuery || embedQuadroQuery)) {
    pontos = new Map(cenas.map(c => [c.id, 0]));
    const ids = new Set(cenas.map(c => c.id));
    const somar = ranking => ranking.forEach((id, i) => pontos.set(id, pontos.get(id) + 1 / (K_RRF + i + 1)));
    if (embedQuery) {
      const v = await embedQuery(q);
      somar(db.prepare('SELECT cena_id, vec_distance_cosine(embedding, ?) AS d FROM vec_cena ORDER BY d').all(v).map(r => r.cena_id).filter(id => ids.has(id)));
    }
    if (embedQuadroQuery) {
      const v = await embedQuadroQuery(q);
      const sim = db.prepare('SELECT cena_id, vetor FROM emb_quadro').all().filter(r => ids.has(r.cena_id)).map(r => [r.cena_id, dot(vetor(r.vetor), v)]);
      somar(sim.sort((a, b) => b[1] - a[1]).map(([id]) => id));
    }
  } else {
    pontos = new Map(cenas.map(c => [c.id, c.nota_take ?? -1])); // sem frase: pelos melhores takes
  }
  const porVideo = new Map();
  for (const c of melhoresDoGrupo(cenas)) porVideo.set(c.asset_id, [...(porVideo.get(c.asset_id) || []), { ...c, pontos: pontos.get(c.id) }]);
  const ordenados = [...porVideo.entries()].map(([id, cs]) => {
    cs.sort((a, b) => b.pontos - a.pontos || a.ordem - b.ordem);
    return { id, pontos: cs[0].pontos, cenas: cs.slice(0, CENAS_POR_VIDEO) };
  }).sort((a, b) => b.pontos - a.pontos || (a.id < b.id ? -1 : 1)).slice(offset, offset + limite);
  if (!ordenados.length) return [];
  const linhas = new Map(db.prepare(`SELECT a.*, (${exposta}) AS exposta FROM assets a WHERE a.id IN (${ordenados.map(() => '?').join(',')})`)
    .all(...ordenados.map(v => v.id)).map(a => [a.id, a]));
  return ordenados.map(v => ({ ...linhas.get(v.id), pontos: v.pontos, cenas: v.cenas }));
}

// todos os takes de um grupo, do melhor para o pior (só do cliente e da regra pedidos)
function takesDoGrupo(db, grupo, filtros) {
  const { onde, params } = montarOnde({ ...filtros, tipo_midia: 'video' });
  return db.prepare(`SELECT c.id, c.asset_id, c.ini, c.fim, c.descricao, c.nota_take, a.titulo, a.drive_id
    FROM cenas c JOIN assets a ON a.id = c.asset_id WHERE c.take_grupo = ? AND ${onde.join(' AND ')} ORDER BY c.nota_take DESC NULLS LAST`).all(grupo, ...params);
}

module.exports = { buscarVideos, takesDoGrupo, melhoresDoGrupo, K_RRF };
