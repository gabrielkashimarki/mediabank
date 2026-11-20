const colecoes = require('./colecoes');

const INSTRUCAO_EVENTO = "Esta pasta corresponde a UM evento ou ocasião específica que aconteceu (ex.: casamento de um casal, aniversário ou 15 anos de alguém, evento corporativo de uma empresa, um réveillon ou jantar temático de uma data, um ensaio pre wedding)? Responda não para pastas de categoria ou organização (tipo de evento, ano, mês, 'outros anos'), pastas de formato ou etapa (fotos em alta, em baixa, vídeos, editadas, cruas, takes), cardápio e fotos de pratos ou drinks, banco de imagens e acervo classificado por ambiente.";

// Resolve o caminho completo de uma pasta no Drive e grava no banco
async function resolverPasta(db, drive, id, driveRaiz, profundidade = 0, visitados = new Set()) {
  if (!id || id === driveRaiz) return null;
  const existente = db.prepare('SELECT * FROM pastas WHERE id = ?').get(id);
  if (existente) return existente;
  if (profundidade >= 20 || visitados.has(id)) {
    throw new Error(`Ciclo ou profundidade máxima atingida ao resolver pasta ${id}`);
  }

  visitados.add(id);
  try {
    const arq = await drive.arquivo(id, 'id,name,parents');
    const nome = arq?.name || id;
    const paiId = arq?.parents?.[0] || null;
    let caminho = nome;

    if (paiId && paiId !== driveRaiz) {
      const pai = await resolverPasta(db, drive, paiId, driveRaiz, profundidade + 1, visitados);
      if (pai && pai.caminho) {
        caminho = `${pai.caminho}/${nome}`;
      }
    }

    db.prepare(`
      INSERT INTO pastas (id, nome, pai_id, caminho)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, pai_id = excluded.pai_id, caminho = excluded.caminho
    `).run(id, nome, paiId, caminho);

    return db.prepare('SELECT * FROM pastas WHERE id = ?').get(id);
  } finally {
    visitados.delete(id);
  }
}

// Preenche pasta_id em assets antigos e garante resolverPasta para as pastas encontradas
async function preencherPastas(db, drive, { driveRaiz, limite = 300 } = {}) {
  let chamadas = 0;
  const driveContador = {
    ...drive,
    async arquivo(id, campos) {
      if (chamadas >= limite) throw new Error('Limite de chamadas ao Drive atingido');
      chamadas++;
      return drive.arquivo(id, campos);
    },
  };

  const pendentes = db.prepare('SELECT id, drive_id FROM assets WHERE drive_id IS NOT NULL AND pasta_id IS NULL').all();
  for (const a of pendentes) {
    if (chamadas >= limite) break;
    try {
      const arq = await driveContador.arquivo(a.drive_id, 'parents');
      const pastaId = arq?.parents?.[0] || null;
      if (pastaId) {
        db.prepare('UPDATE assets SET pasta_id = ? WHERE id = ?').run(pastaId, a.id);
      }
    } catch (e) {
      if (chamadas >= limite) break;
      console.error(`Erro ao buscar pasta do asset ${a.id}:`, e.message);
    }
  }

  const semPasta = db.prepare(`
    SELECT DISTINCT pasta_id FROM assets
    WHERE pasta_id IS NOT NULL AND pasta_id NOT IN (SELECT id FROM pastas)
  `).all();
  for (const { pasta_id } of semPasta) {
    if (chamadas >= limite) break;
    if (driveRaiz && pasta_id === driveRaiz) continue;
    try {
      await resolverPasta(db, driveContador, pasta_id, driveRaiz);
    } catch (e) {
      if (chamadas >= limite) break;
      console.error(`Erro ao resolver pasta ${pasta_id}:`, e.message);
    }
  }

  return { chamadas };
}

// Pergunta ao Jev se a pasta corresponde a um evento
async function classificarPastas(db, jev, { limite = 100 } = {}) {
  if (!jev) return { avaliadas: 0 };
  const pastas = db.prepare('SELECT * FROM pastas WHERE prob_evento IS NULL AND evento_fixo = 0 LIMIT ?').all(limite);
  let avaliadas = 0;

  for (const pasta of pastas) {
    try {
      const subpastas = db.prepare('SELECT nome FROM pastas WHERE pai_id = ? LIMIT 20').all(pasta.id).map(r => r.nome);
      const fotosDiretas = db.prepare('SELECT count(*) AS n FROM assets WHERE pasta_id = ?').get(pasta.id)?.n || 0;

      const corpo = {
        model: 'jev-latest',
        state: {
          caminho: pasta.caminho,
          nome: pasta.nome,
          subpastas,
          fotos_diretas: fotosDiretas,
        },
        questions: {
          evento: {
            type: 'noul',
            instructions: INSTRUCAO_EVENTO,
          },
        },
      };

      const resp = await jev(corpo);
      const prob = resp?.answers?.evento?.noul;
      if (typeof prob === 'number') {
        const evento = prob >= 0.5 ? 1 : 0;
        const avaliadaEm = new Date().toISOString();
        db.prepare('UPDATE pastas SET prob_evento = ?, evento = ?, avaliada_em = ? WHERE id = ?')
          .run(prob, evento, avaliadaEm, pasta.id);
        avaliadas++;
      }
    } catch (e) {
      console.error(`Erro ao classificar pasta ${pasta.id}:`, e.message);
    }
  }

  return { avaliadas };
}

// Sobe pela árvore e devolve a pasta-evento MAIS ALTA da cadeia: o Jev também marca como evento
// subpastas de um evento (P&B, COLORIDAS, FOTOS), e elas devem cair na coleção do evento de cima.
function eventoDaPasta(mapaPastas, pastaId) {
  let atualId = pastaId, evento = null;
  const visitados = new Set();
  while (atualId && !visitados.has(atualId)) {
    visitados.add(atualId);
    const pasta = mapaPastas instanceof Map ? mapaPastas.get(atualId) : mapaPastas[atualId];
    if (!pasta) break;
    if (pasta.evento === 1) evento = pasta.id;
    atualId = pasta.pai_id;
  }
  return evento;
}

// Cria e atualiza colecoes automaticas com base nas pastas classificadas como evento
function sincronizarColecoesDeEvento(db) {
  const todasPastas = db.prepare('SELECT * FROM pastas').all();
  const mapaPastas = new Map(todasPastas.map(p => [p.id, p]));

  // Remove colecoes automaticas de pastas que deixaram de ser evento
  const colecoesAuto = db.prepare('SELECT id, pasta_id FROM colecoes WHERE pasta_id IS NOT NULL').all();
  for (const c of colecoesAuto) {
    const pasta = mapaPastas.get(c.pasta_id);
    if (!pasta || pasta.evento !== 1 || eventoDaPasta(mapaPastas, pasta.id) !== pasta.id) {
      colecoes.excluir(db, c.id);
    }
  }

  const pastasEvento = todasPastas.filter(p => p.evento === 1 && eventoDaPasta(mapaPastas, p.id) === p.id);
  const mapaColecoesId = new Map();

  for (const pasta of pastasEvento) {
    const nome = pasta.nome.replace(/／/g, '/').replace(/\s+/g, ' ').trim();
    const descricao = pasta.caminho;
    const existente = db.prepare('SELECT id FROM colecoes WHERE pasta_id = ?').get(pasta.id);
    let colecaoId;
    if (!existente) {
      const info = db.prepare('INSERT INTO colecoes (nome, descricao, pasta_id, criado_por) VALUES (?, ?, ?, NULL)')
        .run(nome, descricao, pasta.id);
      colecaoId = info.lastInsertRowid;
    } else {
      colecaoId = existente.id;
      db.prepare('UPDATE colecoes SET nome = ?, descricao = ? WHERE id = ?').run(nome, descricao, colecaoId);
    }
    mapaColecoesId.set(pasta.id, colecaoId);
  }

  // só foto: vídeo registrado pelo sync ainda não tem pôster, e a coleção do evento é de fotos
  const assetsComPasta = db.prepare(`
    SELECT id, pasta_id FROM assets
    WHERE pasta_id IS NOT NULL AND tipo_midia = 'imagem'
    ORDER BY coalesce(data_foto, criado_em) ASC, id ASC
  `).all();

  const fotosPorEvento = new Map();
  for (const a of assetsComPasta) {
    const evId = eventoDaPasta(mapaPastas, a.pasta_id);
    if (!evId) continue;
    if (!fotosPorEvento.has(evId)) fotosPorEvento.set(evId, []);
    fotosPorEvento.get(evId).push(a.id);
  }

  let fotosAdicionadas = 0;
  for (const pasta of pastasEvento) {
    const colecaoId = mapaColecoesId.get(pasta.id);
    const ids = fotosPorEvento.get(pasta.id) || [];
    const manter = new Set(ids);
    for (const { asset_id } of db.prepare('SELECT asset_id FROM colecao_fotos WHERE colecao_id = ?').all(colecaoId)) {
      if (!manter.has(asset_id)) colecoes.remover(db, colecaoId, asset_id);
    }
    if (ids.length > 0) {
      fotosAdicionadas += colecoes.adicionar(db, colecaoId, ids);
    }
  }

  return { colecoes: pastasEvento.length, fotos_adicionadas: fotosAdicionadas };
}

module.exports = {
  resolverPasta,
  preencherPastas,
  classificarPastas,
  eventoDaPasta,
  sincronizarColecoesDeEvento,
  INSTRUCAO_EVENTO,
};
