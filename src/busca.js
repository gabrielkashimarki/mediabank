const { PADRAO, sqlCliente, vocabularioDe } = require('./clientes');
const { espacosDoLocal, tiposComFilhos, TIPOS_EVENTO } = require('./vocabulario');

// query string repetida (?tier=a&tier=b) vira lista; valor único também
const lista = v => (v == null || v === '' ? [] : [].concat(v).map(String));

// facetas multivaloradas: dentro da faceta é OU, entre facetas é E
const FACETAS = ['tier', 'tipo_evento', 'destino', 'tipo', 'gastronomia', 'luz_tipo', 'plano', 'uso', 'tag'];

// monta o WHERE; `sem` deixa uma faceta de fora (contagem da própria faceta)
// cliente: sem ele, vale o cliente PADRAO (quem chamava antes da spec multi-cliente); rota nova passa sempre
// tipo_midia: 'imagem' ou 'video'; sem ele, as duas
function montarOnde(filtros, sem) {
  const { local, espaco, externo = true, cliente = PADRAO } = filtros;
  const { EXPOSICAO } = vocabularioDe(cliente);
  const onde = [sqlCliente(cliente)], params = [];
  const em = (col, valores) => { onde.push(`${col} IN (${valores.map(() => '?').join(',') || 'NULL'})`); params.push(...valores); };
  const f = k => (k === sem ? [] : lista(filtros[k]));

  if (externo) onde.push(externo === 'acervo' ? EXPOSICAO.acervo : EXPOSICAO.externa);
  if (filtros.tipo_midia) em('a.tipo_midia', lista(filtros.tipo_midia));
  if (lista(filtros.orientacao).length) em('a.orientacao', lista(filtros.orientacao));
  // arte gráfica: post, flyer, cardápio com texto ou grafismo sobre a imagem (tem_texto da IA)
  if (filtros.arte === 'so') onde.push('a.tem_texto = 1');
  if (filtros.arte === 'sem') onde.push('coalesce(a.tem_texto, 0) = 0'); // vídeo: horizontal, vertical, quadrado
  // campos do vocabulário do cliente que moram em etiquetas: ?et_tema=intestino&et_tema=dor
  for (const [k, v] of Object.entries(filtros)) {
    const campo = /^et_([a-z_]{1,30})$/.exec(k)?.[1];
    if (campo && lista(v).length) em(`json_extract(a.etiquetas, '$.${campo}')`, lista(v));
  }
  // rajada: só a melhor foto do grupo aparece; quem quer as variações filtra o tier Variação
  if (sem !== 'tier' && !lista(filtros.tier).length) onde.push("coalesce(a.tier, '') != 'variacao'");
  const notaMin = Number(filtros.nota_min);
  if (notaMin > 0) { onde.push('a.nota_rubrica >= ?'); params.push(notaMin); } // nota de qualidade da IA (1 a 10)
  // tem_pessoa vale desde 06/10/2026; fotos analisadas antes usam a contagem de rostos
  if (filtros.pessoas === 'sem') onde.push('coalesce(a.tem_pessoa, a.qtd_rostos > 0) = 0');
  if (filtros.pessoas === 'com') onde.push('coalesce(a.tem_pessoa, a.qtd_rostos > 0) = 1');
  if (local) em('a.espaco', espacosDoLocal(String(local)));
  if (espaco) em('a.espaco', [String(espaco)]);
  if (f('tipo_evento').length) em('a.tipo_evento', f('tipo_evento').flatMap(tiposComFilhos));
  for (const col of ['tier', 'tipo', 'gastronomia', 'luz_tipo', 'plano']) if (f(col).length) em(`a.${col}`, f(col));
  if (f('destino').length) {
    onde.push(`EXISTS (SELECT 1 FROM json_each(a.destinos) WHERE value IN (${f('destino').map(() => '?').join(',')}))`);
    params.push(...f('destino'));
  }
  // tags: entre tags é E (filtrar "noite" e "taça" traz o que tem as duas), como no Pixabay
  for (const t of f('tag')) { onde.push('EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?)'); params.push(t.toLowerCase()); }
  const uso = f('uso');
  if (uso.length === 1) onde.push(uso[0] === 'liberada' ? `(${EXPOSICAO.externa})` : `NOT (${EXPOSICAO.externa})`);
  return { onde, params, exposta: EXPOSICAO.externa };
}

const where = onde => (onde.length ? 'WHERE ' + onde.join(' AND ') : '');

// Busca por filtros e, se houver q, por similaridade do texto.
// externo = true aplica a regra de exposição (site, bot, Jev, link público).
// O vetor acha o tema, mas perde detalhe da frase ("ao pôr do sol" volta foto à noite).
// O Jev lê a frase contra a descrição de cada uma das N mais próximas e reordena pela relevância.
const N_JEV = 60;
async function reordenarComJev(jev, consulta, fotos) {
  const alvo = fotos.slice(0, N_JEV);
  const state = {
    consulta,
    fotos: Object.fromEntries(alvo.map((f, i) => [`f${i}`, {
      titulo: f.titulo, espaco: f.espaco, tipo_evento: f.tipo_evento, descricao: (f.descricao || '').slice(0, 500),
    }])),
  };
  const questions = Object.fromEntries(alvo.map((_, i) => [`f${i}`, {
    type: 'noul',
    instructions: `A foto \`fotos.f${i}\` mostra o que a pessoa procura em \`consulta\`? Considere cada detalhe pedido (horário e luz, espaço, objeto, tipo de evento, com ou sem pessoas): detalhe pedido que a foto contradiz conta como não.`,
  }]));
  try {
    const r = await jev({ model: 'jev-latest', state, questions }, { timeoutMs: 8000 });
    const p = alvo.map((_, i) => r?.answers?.[`f${i}`]?.noul);
    if (p.some(x => typeof x !== 'number')) return fotos;
    const ordem = alvo.map((f, i) => ({ f: { ...f, relevancia: p[i] }, i })).sort((a, b) => b.f.relevancia - a.f.relevancia || a.i - b.i);
    return [...ordem.map(x => x.f), ...fotos.slice(N_JEV)];
  } catch (e) {
    console.error('reordenar com Jev falhou, fica a ordem do vetor:', e.message);
    return fotos;
  }
}

async function buscar(db, filtros, { embedQuery, jev } = {}) {
  const { q } = filtros;
  const limite = Math.min(Math.max(Math.trunc(Number(filtros.limite)) || 48, 1), 200);
  const offset = Math.max(Math.trunc(Number(filtros.offset)) || 0, 0); // rolagem infinita do painel
  const { onde, params, exposta } = montarOnde(filtros);
  const ordem = { recente: 'a.criado_em DESC', ia: 'a.nota_rubrica DESC NULLS LAST, a.criado_em DESC' }[filtros.ordem]
    || 'a.nota_final DESC NULLS LAST, a.criado_em DESC';

  let sql, args;
  if (q && embedQuery) {
    // Distância calculada em toda foto que passa no filtro. O KNN do vec0 filtraria só depois
    // dos k vizinhos, e o k máximo é 4096.
    // ponytail: varredura exata, ~330 ms com 14 mil fotos; acima de ~100 mil, colunas de metadado no vec0
    const vetor = await embedQuery(String(q));
    sql = `SELECT a.*, (${exposta}) AS exposta, vec_distance_cosine(v.embedding, ?) AS distancia
      FROM assets a JOIN vec_texto v ON v.asset_id = a.id
      ${where(onde)} ORDER BY distancia LIMIT ? OFFSET ?`;
    args = [vetor, ...params, limite, offset];
  } else {
    sql = `SELECT a.*, (${exposta}) AS exposta FROM assets a ${where(onde)} ORDER BY ${ordem} LIMIT ? OFFSET ?`;
    args = [...params, limite, offset];
  }
  const linhas = db.prepare(sql).all(...args);
  // só na primeira página e com página maior que N: a segunda página continua pela distância, sem repetir foto
  return q && jev && offset === 0 && limite >= N_JEV ? reordenarComJev(jev, String(q), linhas) : linhas;
}

function contar(db, filtros) {
  const { onde, params } = montarOnde(filtros);
  return db.prepare(`SELECT count(*) AS n FROM assets a ${where(onde)}`).get(...params).n;
}

// Contagem por valor de cada faceta, considerando as outras facetas (como no Algolia).
// Tipo de evento pai soma os filhos. Espaços contam o acervo inteiro (barra de locais).
function facetas(db, filtros) {
  const r = {};
  for (const fac of FACETAS) {
    const { onde, params, exposta } = montarOnde(filtros, fac);
    const expr = fac === 'uso' ? `CASE WHEN ${exposta} THEN 'liberada' ELSE 'interno' END` : `a.${fac}`;
    // tag: só as 40 mais comuns no recorte atual (a lista inteira não cabe na lateral)
    const sql = fac === 'destino' || fac === 'tag'
      ? `SELECT d.value AS v, count(*) AS n FROM assets a, json_each(a.${fac === 'tag' ? 'tags' : 'destinos'}) d ${where(onde)} GROUP BY d.value ORDER BY n DESC${fac === 'tag' ? ' LIMIT 40' : ''}`
      : `SELECT ${expr} AS v, count(*) AS n FROM assets a ${where(onde)} GROUP BY v`;
    r[fac] = Object.fromEntries(db.prepare(sql).all(...params).filter(l => l.v != null).map(l => [l.v, l.n]));
  }
  for (const [filho, pai] of Object.entries(TIPOS_EVENTO)) {
    if (pai && r.tipo_evento[filho]) r.tipo_evento[pai] = (r.tipo_evento[pai] || 0) + r.tipo_evento[filho];
  }
  const tipos = lista(filtros.tipo_midia).filter(t => t === 'imagem' || t === 'video');
  r.espaco = Object.fromEntries(db.prepare(`SELECT espaco AS v, count(*) AS n FROM assets a
    WHERE ${sqlCliente(filtros.cliente || PADRAO)} ${tipos.length ? `AND a.tipo_midia IN (${tipos.map(t => `'${t}'`).join(',')})` : ''}
      AND espaco IS NOT NULL GROUP BY espaco`).all().map(l => [l.v, l.n]));
  return r;
}

module.exports = { buscar, contar, facetas, montarOnde, FACETAS };
