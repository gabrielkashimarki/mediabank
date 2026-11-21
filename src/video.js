// Etapas de vídeo do pipeline, depois que o trabalhador (py/videos.py) entrega cenas e quadros:
// IA por grade de quadros numerados, embedding de texto por vídeo e por cena, e vetor de imagem de cada quadro.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { montarPrompt, validarAnalise, CRITERIOS, PESOS_QUALIDADE } = require('./ia');
const { eventoDaPasta } = require('./pastas');
const { vocabularioDe } = require('./clientes');

const POR_GRADE = 16;
const LADO_CELULA = 384;
const caminhoCena = (dirDados, id) => path.join(dirDados, 'midia', 'cena', `${id}.jpg`);

// Grade com os quadros numerados de 1 a n, na ordem. Cada célula cabe num quadrado de 384 px.
async function montarGrade(arquivos) {
  const cols = Math.ceil(Math.sqrt(arquivos.length));
  const linhas = Math.ceil(arquivos.length / cols);
  const celulas = await Promise.all(arquivos.map(async (arq, i) => {
    const img = await sharp(arq).resize(LADO_CELULA, LADO_CELULA, { fit: 'contain', background: '#000' }).toBuffer();
    const rotulo = Buffer.from(`<svg width="64" height="44"><rect width="64" height="44" rx="8" fill="#000" opacity="0.75"/>
      <text x="32" y="32" font-family="Helvetica, Arial" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${i + 1}</text></svg>`);
    return [{ input: img, left: (i % cols) * LADO_CELULA, top: Math.floor(i / cols) * LADO_CELULA },
      { input: rotulo, left: (i % cols) * LADO_CELULA + 8, top: Math.floor(i / cols) * LADO_CELULA + 8 }];
  }));
  return sharp({ create: { width: cols * LADO_CELULA, height: linhas * LADO_CELULA, channels: 3, background: '#111' } })
    .composite(celulas.flat()).jpeg({ quality: 82 }).toBuffer();
}

const CAMPO_CENAS = n => `- cenas: lista com ${n} objetos, um por quadro, na ordem: { "n": número do quadro,
  "descricao": até 30 palavras, o que acontece naquele trecho (ação, pessoas, objetos, luz),
  "qualidade": as mesmas seis notas inteiras de 1 a 10 (assunto, enquadramento, composicao, luz, limpeza, momento), julgando o trecho como take para um vídeo de venda }`;

// Vídeo inteiro: os campos de foto valem para o vídeo como um todo, mais a lista de cenas.
function montarPromptVideo(n, transcricao) {
  return `A imagem é uma GRADE com ${n} quadros numerados (1 a ${n}) de um mesmo vídeo, em ordem: cada quadro é o meio de uma cena (um corte).
Preencha os campos abaixo para o VÍDEO COMO UM TODO (no lugar de "foto", leia "vídeo"). Proteção: se algum quadro mostra criança, tem_crianca é true.
${transcricao ? `Fala transcrita do vídeo: """${transcricao.slice(0, 1500)}"""\n` : ''}
${montarPrompt().replace('Analise a foto e responda APENAS com um objeto JSON com estes campos:', 'Responda APENAS com um objeto JSON com estes campos:')}
${CAMPO_CENAS(n)}`;
}

// Grades seguintes de um vídeo longo: só as cenas.
function montarPromptCenas(n, inicio, titulo) {
  return `A imagem é uma GRADE com ${n} quadros numerados (1 a ${n}) do vídeo "${titulo}", na ordem (são as cenas ${inicio + 1} a ${inicio + n}).
Responda APENAS com um objeto JSON { "cenas": [...] }:
${CAMPO_CENAS(n)}`;
}

const notaRubrica = q => {
  if (!q || !CRITERIOS.every(c => Number.isInteger(q[c]) && q[c] >= 1 && q[c] <= 10)) return null;
  let soma = 0, peso = 0;
  for (const c of CRITERIOS) { soma += q[c] * PESOS_QUALIDADE[c]; peso += PESOS_QUALIDADE[c]; }
  return Math.round(soma / peso * 10) / 10;
};

// Cena faltando ou com nota inválida não derruba o vídeo: fica sem descrição e sem rubrica.
function validarCenas(lista, n) {
  const porN = new Map((Array.isArray(lista) ? lista : []).filter(c => Number.isInteger(c?.n)).map(c => [c.n, c]));
  return Array.from({ length: n }, (_, i) => {
    const c = porN.get(i + 1) || {};
    const q = c.qualidade && typeof c.qualidade === 'object' ? c.qualidade : null;
    const rub = notaRubrica(q);
    return { descricao: typeof c.descricao === 'string' ? c.descricao.slice(0, 400) : null, qualidade: rub == null ? '{}' : JSON.stringify(q), nota_rubrica: rub };
  });
}

const lerJson = texto => {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`resposta sem JSON: ${texto.slice(0, 120)}`);
  return JSON.parse(m[0]);
};

const OPCOES_CHAT = { response_format: { type: 'json_object' }, max_tokens: 9000, temperature: 0.2, reasoning: { effort: 'low' } };
const chamarGrade = (cliente, modelo, jpeg, texto) => cliente.chat(modelo, [{
  role: 'user',
  content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }, { type: 'text', text: texto }],
}], OPCOES_CHAT);

// Cliente de fotos (PADRAO): os campos de foto valem para o vídeo inteiro. Cliente com ANALISE_VIDEO no vocabulário usa a dele.
const { USOS_VIDEO } = require('./vocabulario');
const CAMPO_USO = `- uso: para que o vídeo foi feito, um de ${USOS_VIDEO.map(u => `"${u}"`).join(', ')} (TV e telão = cardápio, preços, avisos ou vídeo em loop para a televisão ou o telão do espaço, quase sempre horizontal e com texto; Rede social = peça vertical de reels ou stories; Anúncio e institucional = peça editada horizontal para site, YouTube ou apresentação; Captação (bruto) = material sem edição, câmera rodando)`;
const ANALISE_PADRAO = {
  prompt: (n, transcricao) => `${montarPromptVideo(n, transcricao)}\n${CAMPO_USO}`,
  // uso fora da lista não derruba o vídeo: só não vira etiqueta
  validar: r => {
    const v = validarAnalise(r);
    if (v.ok && USOS_VIDEO.includes(r.uso)) v.campos.etiquetas = { uso: r.uso };
    return v;
  },
};
const analiseDe = clienteId => vocabularioDe(clienteId).ANALISE_VIDEO || ANALISE_PADRAO;

// cenas: [{id, arquivo}] na ordem (só as que passaram no portão técnico)
async function analisarVideo(cenas, { cliente, modelo, transcricao = null, analise = ANALISE_PADRAO }) {
  const partes = [];
  for (let i = 0; i < cenas.length; i += POR_GRADE) partes.push(cenas.slice(i, i + POR_GRADE));
  const primeira = partes[0];
  const r = lerJson(await chamarGrade(cliente, modelo, await montarGrade(primeira.map(c => c.arquivo)), analise.prompt(primeira.length, transcricao, { campoCenas: CAMPO_CENAS })));
  const v = analise.validar(r);
  if (!v.ok) throw new Error(`fora do vocabulário: ${v.erros.join('; ')}`);
  const porCena = validarCenas(r.cenas, primeira.length);
  for (const [k, parte] of partes.slice(1).entries()) {
    const inicio = (k + 1) * POR_GRADE;
    const rc = lerJson(await chamarGrade(cliente, modelo, await montarGrade(parte.map(c => c.arquivo)), montarPromptCenas(parte.length, inicio, v.campos.titulo)));
    porCena.push(...validarCenas(rc.cenas, parte.length));
  }
  return { campos: v.campos, cenas: porCena };
}

async function emParalelo(itens, n, fn) {
  let i = 0;
  const trabalhador = async () => { while (i < itens.length) await fn(itens[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
}

async function etapaIaVideo(db, { dirDados, cliente, modelo, limite = Infinity, concorrencia = 4 }) {
  const fila = db.prepare(`SELECT id, cliente_id, etiquetas, transcricao FROM assets WHERE tipo_midia = 'video' AND st_video = 'ok' AND st_tecnica = 'ok' AND st_ia = 'pendente' LIMIT ?`)
    .all(Number.isFinite(limite) ? limite : -1);
  const cenasDe = db.prepare("SELECT id FROM cenas WHERE asset_id = ? AND st_tecnica = 'ok' ORDER BY ordem");
  const updCena = db.prepare('UPDATE cenas SET descricao = @descricao, qualidade = @qualidade, nota_rubrica = @nota_rubrica WHERE id = @id');
  let ok = 0, erro = 0;
  await emParalelo(fila, concorrencia, async a => {
    try {
      const cenas = cenasDe.all(a.id).map(c => ({ id: c.id, arquivo: caminhoCena(dirDados, c.id) }));
      const r = await analisarVideo(cenas, { cliente, modelo, transcricao: a.transcricao, analise: analiseDe(a.cliente_id) });
      // etiqueta que veio da curadoria (importação, equipe) vale mais que a da IA
      if (r.campos.etiquetas) r.campos.etiquetas = JSON.stringify({ ...r.campos.etiquetas, ...JSON.parse(a.etiquetas || '{}') });
      const sets = Object.keys(r.campos).map(c => `${c} = @${c}`).join(', ');
      db.transaction(() => {
        db.prepare(`UPDATE assets SET ${sets}, st_ia = 'ok', erro = NULL WHERE id = @id`).run({ ...r.campos, id: a.id });
        cenas.forEach((c, i) => updCena.run({ ...r.cenas[i], id: c.id }));
      })();
      ok++;
    } catch (e) {
      db.prepare("UPDATE assets SET st_ia = 'erro', erro = ? WHERE id = ?").run(e.message.slice(0, 500), a.id);
      erro++;
    }
  });
  return { ok, erro };
}

// texto da cena: o que acontece nela, a fala e o contexto do vídeo (título, espaço, evento da pasta)
function textoDaCena(c, v) {
  return [c.descricao, c.transcricao, v.titulo, JSON.parse(v.tags || '[]').join(', '), v.espaco, v.tipo_evento, v.evento_pasta, v.caminho_pasta].filter(Boolean).join('\n');
}
function textoDoVideo(v, cenas) {
  return [v.titulo, v.descricao, JSON.parse(v.tags || '[]').join(', '), v.legenda, v.espaco, v.local, v.tipo_evento, v.evento_pasta, v.caminho_pasta,
    ...JSON.parse(v.perguntas_que_responde || '[]'), ...cenas.map(c => c.descricao), v.transcricao].filter(Boolean).join('\n').slice(0, 24000);
}

async function etapaEmbeddingVideo(db, { cliente, modelo }) {
  const mapa = new Map(db.prepare('SELECT id, nome, pai_id, caminho, evento FROM pastas').all().map(p => [p.id, p]));
  const fila = db.prepare("SELECT * FROM assets WHERE tipo_midia = 'video' AND st_ia = 'ok' AND st_embedding = 'pendente'").all();
  const cenasDe = db.prepare("SELECT id, descricao, transcricao FROM cenas WHERE asset_id = ? AND st_tecnica = 'ok' ORDER BY ordem");
  const delV = db.prepare('DELETE FROM vec_texto WHERE asset_id = ?'), insV = db.prepare('INSERT INTO vec_texto(asset_id, embedding) VALUES (?, ?)');
  const delC = db.prepare('DELETE FROM vec_cena WHERE cena_id = ?'), insC = db.prepare('INSERT INTO vec_cena(cena_id, embedding) VALUES (?, ?)');
  const marca = db.prepare("UPDATE assets SET st_embedding = 'ok' WHERE id = ?");
  for (const a of fila) {
    const ev = eventoDaPasta(mapa, a.pasta_id);
    const v = { ...a, evento_pasta: ev ? mapa.get(ev).nome : null, caminho_pasta: mapa.get(a.pasta_id)?.caminho || null };
    const cenas = cenasDe.all(a.id);
    const vetores = await cliente.embed(modelo, [textoDoVideo(v, cenas), ...cenas.map(c => textoDaCena(c, v))]);
    db.transaction(() => {
      delV.run(a.id); insV.run(a.id, vetores[0]);
      cenas.forEach((c, i) => { delC.run(c.id); insC.run(c.id, vetores[i + 1]); });
      marca.run(a.id);
    })();
  }
  return fila.length;
}

// Matryoshka: se a API devolver mais dimensões que o pedido, os primeiros valores renormalizados valem
function ajustar(v, dim) {
  const x = v.length > dim ? v.slice(0, dim) : v;
  let n = 0;
  for (const y of x) n += y * y;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(x, y => y / n);
}

// vetor de imagem de cada quadro-chave (mesmo espaço da frase da busca)
async function etapaQuadros(db, { dirDados, cliente, modelo, dim = 768, limite = 50 }) {
  const fila = db.prepare("SELECT id FROM assets WHERE tipo_midia = 'video' AND st_video = 'ok' AND st_quadros = 'pendente' LIMIT ?").all(limite);
  const cenasDe = db.prepare("SELECT id FROM cenas WHERE asset_id = ? AND st_tecnica = 'ok' ORDER BY ordem");
  const ins = db.prepare('INSERT OR REPLACE INTO emb_quadro (cena_id, vetor) VALUES (?, ?)');
  let ok = 0, erro = 0;
  for (const { id } of fila) {
    try {
      const cenas = cenasDe.all(id);
      const vetores = [];
      for (let i = 0; i < cenas.length; i += POR_GRADE) {
        const entradas = cenas.slice(i, i + POR_GRADE).map(c => ({
          content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(caminhoCena(dirDados, c.id)).toString('base64')}` } }],
        }));
        vetores.push(...await cliente.embed(modelo, entradas, { dimensions: dim }));
      }
      db.transaction(() => {
        cenas.forEach((c, i) => ins.run(c.id, Buffer.from(ajustar(vetores[i], dim).buffer)));
        db.prepare("UPDATE assets SET st_quadros = 'ok' WHERE id = ?").run(id);
      })();
      ok++;
    } catch (e) {
      db.prepare("UPDATE assets SET st_quadros = 'erro', erro = ? WHERE id = ?").run(`quadros: ${e.message}`.slice(0, 500), id);
      erro++;
    }
  }
  return { ok, erro };
}

module.exports = { analiseDe, montarGrade, montarPromptVideo, validarCenas, analisarVideo, etapaIaVideo, etapaEmbeddingVideo, etapaQuadros, ajustar, textoDaCena, POR_GRADE };
