const crypto = require('node:crypto');
const { eventoDaPasta } = require('./pastas');
const { nome, contexto } = require('./vocabulario');

const INSTRUCOES = `Você monta o catálogo de possibilidades da ${nome} (${contexto}) a partir de descrições de fotos reais de eventos já realizados.
Para o grupo de fotos recebido (um espaço e um tipo de evento), devolva JSON com:
- "resumo": 2 frases sobre o que esse espaço já recebeu nesse formato.
- "itens": lista de possibilidades comprovadas, cada uma {"categoria": uma de [cenario, decoracao, mobiliario, iluminacao, montagem, gastronomia_bar, entretenimento, servico], "o_que": frase curta e concreta (ex.: "Mesa imperial com arranjos baixos de flores brancas"), "fotos": [ids que comprovam, 1 a 4]}. Só inclua o que aparece nas descrições; não invente. Agrupe repetições num item só. Entre 5 e 15 itens.
- "capacidade": o que as fotos sugerem sobre número de convidados, ou null.
- "ideias": até 3 combinações pouco usadas ou diferenciadas que aparecem nas fotos e podem ser oferecidas como opção, cada {"ideia": frase, "fotos": [ids]}.
- "perguntas": até 5 perguntas típicas de cliente que essas fotos ajudam a responder.
Responda só o JSON.`;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function resumoFoto(f, mapaPastas) {
  let evNome = null;
  if (f.pasta_id && mapaPastas) {
    const evId = eventoDaPasta(mapaPastas, f.pasta_id);
    if (evId) {
      evNome = (mapaPastas instanceof Map ? mapaPastas.get(evId) : mapaPastas[evId])?.nome || null;
    }
  } else if (f.evento) {
    evNome = f.evento;
  }

  let decoracao = f.decoracao;
  if (typeof decoracao === 'string') {
    try { decoracao = JSON.parse(decoracao); } catch { decoracao = {}; }
  }
  let fornecedores = f.fornecedores;
  if (typeof fornecedores === 'string') {
    try { fornecedores = JSON.parse(fornecedores); } catch { fornecedores = []; }
  }

  return {
    id: f.id.slice(0, 8),
    titulo: f.titulo || null,
    tipo: f.tipo || null,
    evento: evNome || null,
    decoracao: decoracao && typeof decoracao === 'object' ? decoracao : {},
    capacidade: f.capacidade_estimada ?? null,
    fornecedores: Array.isArray(fornecedores) ? fornecedores : [],
    descricao: (f.descricao || '').slice(0, 600),
  };
}

function agrupar(db) {
  const fotos = db.prepare(`
    SELECT a.*
    FROM assets a
    WHERE a.tipo_midia = 'imagem' AND a.st_ia = 'ok' AND coalesce(a.tier, '') != 'descartar'
    ORDER BY a.nota_rubrica DESC, a.id ASC
  `).all();

  const grupos = new Map();
  for (const f of fotos) {
    const espaco = f.espaco || 'Sem espaço';
    const tipo = f.tipo_evento || 'Sem tipo';
    const chave = `${espaco} | ${tipo}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(f);
  }

  for (const [chave, lista] of [...grupos]) {
    const espaco = chave.split(' | ')[0];
    const outros = `${espaco} | Outros`;
    if (chave === outros) continue;
    if (lista.length >= 4) continue;
    grupos.delete(chave);
    if (!grupos.has(outros)) grupos.set(outros, []);
    grupos.get(outros).push(...lista);
  }

  for (const [chave, lista] of [...grupos]) {
    if (!lista.length) grupos.delete(chave);
  }

  const resultado = [];
  const gruposOrdenados = [...grupos].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  for (const [chave, listaOriginal] of gruposOrdenados) {
    const partes = chave.split(' | ');
    const espaco = partes[0];
    const tipo_evento = partes[1];

    const lista = listaOriginal
      .slice()
      .sort((a, b) => (b.nota_rubrica ?? 0) - (a.nota_rubrica ?? 0) || a.id.localeCompare(b.id))
      .slice(0, 80);

    const idsOrdenados = lista.map(f => f.id).sort();
    const assinatura = sha256(idsOrdenados.join(','));

    resultado.push({
      grupo: chave,
      espaco,
      tipo_evento,
      n_fotos: listaOriginal.length, // total do grupo; o LLM recebe só as 80 melhores
      fotos: lista,
      assinatura,
    });
  }
  return resultado;
}

// Regera um grupo só quando ele cresceu bastante (mínimo minNovas e 25%): com a IA importando
// 50 fotos por ciclo, regerar a cada 5 novas custaria várias chamadas ao LLM por ciclo.
async function gerarCatalogo(db, { cliente, modelo, limite = 5, minNovas = 10 }) {
  const grupos = agrupar(db);
  const mapaPastas = new Map(db.prepare('SELECT id, nome, pai_id, evento FROM pastas').all().map(p => [p.id, p]));

  let gerados = 0;
  let erros = 0;

  for (const g of grupos) {
    if (gerados >= limite) break;

    const existente = db.prepare('SELECT n_fotos, assinatura FROM catalogo WHERE grupo = ?').get(g.grupo);
    const novoOuMudou = !existente
      || !existente.assinatura
      || (existente.assinatura !== g.assinatura && g.n_fotos - existente.n_fotos >= Math.max(minNovas, existente.n_fotos * 0.25));

    if (!novoOuMudou) continue;

    const curto = new Map(g.fotos.map(f => [f.id.slice(0, 8), f.id]));
    const fotosResumo = g.fotos.map(f => resumoFoto(f, mapaPastas));

    try {
      const mensagens = [
        { role: 'system', content: INSTRUCOES },
        { role: 'user', content: JSON.stringify({ grupo: g.grupo, fotos: fotosResumo }) },
      ];

      const resposta = await cliente.chat(modelo, mensagens, { response_format: { type: 'json_object' } });

      let parsed;
      let custo = null;

      if (typeof resposta === 'string') {
        const jsonMatch = resposta.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`Resposta sem JSON: ${resposta.slice(0, 120)}`);
        parsed = JSON.parse(jsonMatch[0]);
      } else if (resposta && typeof resposta === 'object') {
        if (typeof resposta.conteudo === 'string') {
          parsed = JSON.parse(resposta.conteudo);
        } else if (resposta.saida) {
          parsed = resposta.saida;
        } else {
          parsed = resposta;
        }
        if (resposta.custo != null) custo = resposta.custo;
      }

      const ids = xs => (xs || []).map(x => curto.get(String(x).slice(0, 8))).filter(Boolean);
      for (const it of parsed.itens || []) it.fotos = ids(it.fotos);
      for (const it of parsed.ideias || []) it.fotos = ids(it.fotos);

      const agora = new Date().toISOString();
      const conteudoStr = JSON.stringify(parsed);

      db.prepare(`
        INSERT INTO catalogo (grupo, espaco, tipo_evento, n_fotos, assinatura, conteudo, custo, gerado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (grupo) DO UPDATE SET
          espaco = excluded.espaco,
          tipo_evento = excluded.tipo_evento,
          n_fotos = excluded.n_fotos,
          assinatura = excluded.assinatura,
          conteudo = excluded.conteudo,
          custo = excluded.custo,
          gerado_em = excluded.gerado_em
      `).run(g.grupo, g.espaco, g.tipo_evento, g.n_fotos, g.assinatura, conteudoStr, custo, agora);

      gerados++;
    } catch (e) {
      console.error(`Erro ao gerar catalogo para grupo ${g.grupo}:`, e.message);
      erros++;
    }
  }

  return { gerados, erros };
}

module.exports = {
  agrupar,
  gerarCatalogo,
  INSTRUCOES,
  resumoFoto,
  sha256,
};
