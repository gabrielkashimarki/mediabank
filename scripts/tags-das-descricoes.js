// Uso: node scripts/tags-das-descricoes.js [--cenas] [--limite N] [--lote 20] [--concorrencia 4] [--cliente exemplo]
// --cenas: tags de cada take (cena de vídeo) a partir da descrição da cena; o vídeo fica com as mais frequentes.
// Gera tags para o que já foi classificado antes das tags existirem, lendo o título e a descrição (só texto,
// sem imagem: custa uma fração da IA de visão). Grava as tags e marca o embedding para refazer.
const { carregar } = require('../src/config');
const { normalizarTags, tagsDoVideo } = require('../src/tags');

const arg = (nome, padrao) => { const i = process.argv.indexOf(`--${nome}`); return i === -1 ? padrao : process.argv[i + 1]; };

const PROMPT = (itens, cenas) => `Para cada ${cenas ? 'trecho de vídeo' : 'mídia'} abaixo (${cenas ? 'take' : 'foto ou vídeo'} de um acervo de restaurante e eventos), escreva de ${cenas ? '3 a 8' : '8 a 15'} tags em português:
palavras-chave curtas (1 a 3 palavras, minúsculas) que alguém digitaria para achar a mídia. Objetos, ação, clima, cores, luz,
e sinônimos comuns (ex.: "taça", "espumante", "champanhe", "brinde", "noite", "luz quente"). Use só o que a descrição diz.
Responda APENAS com um objeto JSON {"<id>": ["tag", ...], ...}, com todos os ids.

${itens.map(a => `id: ${a.id}\ntítulo: ${a.titulo || ''}\ndescrição: ${(a.descricao || '').slice(0, 1500)}`).join('\n\n')}`;

async function main() {
  const { db, cliente, modeloDescricao } = carregar();
  if (!cliente) throw new Error('OPENROUTER_API_KEY ausente');
  const modelo = process.env.MODELO_TAGS || modeloDescricao;
  const limite = Number(arg('limite', Infinity)), tamLote = Number(arg('lote', 20)), conc = Number(arg('concorrencia', 4));
  const clienteId = arg('cliente', null), cenas = process.argv.includes('--cenas');
  const fila = cenas
    ? db.prepare(`SELECT c.id, a.titulo, c.descricao, c.asset_id FROM cenas c JOIN assets a ON a.id = c.asset_id
        WHERE a.st_ia = 'ok' AND c.tags = '[]' AND c.descricao IS NOT NULL AND c.st_tecnica = 'ok' AND (? IS NULL OR c.cliente_id = ?) LIMIT ?`)
      .all(clienteId, clienteId, Number.isFinite(limite) ? limite : -1)
    : db.prepare(`SELECT id, titulo, descricao FROM assets WHERE st_ia = 'ok' AND tags = '[]' AND descricao IS NOT NULL
        AND (? IS NULL OR cliente_id = ?) LIMIT ?`).all(clienteId, clienteId, Number.isFinite(limite) ? limite : -1);
  const lotes = [];
  for (let i = 0; i < fila.length; i += tamLote) lotes.push(fila.slice(i, i + tamLote));
  const grava = cenas
    ? db.prepare("UPDATE cenas SET tags = ? WHERE id = ? AND tags = '[]'")
    : db.prepare("UPDATE assets SET tags = ?, st_embedding = 'pendente' WHERE id = ? AND tags = '[]'");
  const videos = new Set();
  let ok = 0, falhas = 0, feitos = 0;
  async function trabalhador() {
    for (let lote; (lote = lotes.shift());) {
      try {
        const texto = await cliente.chat(modelo, [{ role: 'user', content: PROMPT(lote, cenas) }],
          { response_format: { type: 'json_object' }, max_tokens: 4000, temperature: 0.2 });
        const r = JSON.parse(texto.match(/\{[\s\S]*\}/)[0]);
        db.transaction(() => {
          for (const a of lote) {
            const tags = normalizarTags(r[a.id]).slice(0, cenas ? 8 : 15);
            if (tags.length >= 3) { grava.run(JSON.stringify(tags), a.id); ok++; if (cenas) videos.add(a.asset_id); } else falhas++;
          }
        })();
      } catch (e) {
        falhas += lote.length;
        console.error('lote falhou:', e.message.slice(0, 160));
      }
      feitos += lote.length;
      if (feitos % 500 < tamLote) console.log(`${feitos}/${fila.length} (${ok} com tags, ${falhas} sem)`);
    }
  }
  await Promise.all(Array.from({ length: conc }, trabalhador));
  // vídeo: tags = as mais frequentes dos takes; embedding refeito no agendador
  const tagsCenas = db.prepare('SELECT tags FROM cenas WHERE asset_id = ? AND st_tecnica = \'ok\'');
  const gravaVideo = db.prepare("UPDATE assets SET tags = ?, st_embedding = 'pendente' WHERE id = ?");
  db.transaction(() => {
    for (const v of videos) gravaVideo.run(JSON.stringify(tagsDoVideo(tagsCenas.all(v).map(c => JSON.parse(c.tags)), JSON.parse(db.prepare('SELECT tags FROM assets WHERE id = ?').get(v).tags))), v);
  })();
  console.log(JSON.stringify({ total: fila.length, com_tags: ok, sem: falhas, modelo }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
