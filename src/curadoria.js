const { hamming } = require('./ingestao');
const { DESTINOS } = require('./vocabulario');

// pesos em pontos; sinal ausente não pesa e o peso dele vai para os presentes
const PESOS = { estetica: 40, rubrica: 40, moodboard: 20 };
const P_SOCIAL = 70;
const P_HERO = 90;
const TOPO_HERO = 100;
const RAJADA = { hamming: 10, segundos: 600 };

// pré-requisitos por destino, sobre a linha do asset. Na proposta de locação, telão ou placa
// da cena não atrapalha; em rede social e site, texto por cima da foto atrapalha.
const PREREQUISITOS = {
  prop: () => true,
  social: a => !a.tem_texto && !a.marca_terceiro,
  site: a => a.largura > a.altura && !!a.espaco_para_texto && !a.tem_texto,
};

const vetor = buf => new Float32Array(new Uint8Array(buf).buffer);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// percentil 0 a 100 de cada valor na lista; null fica null; empate recebe a posição média
function percentis(valores) {
  const ord = valores.map((v, i) => [v, i]).filter(([v]) => v != null).sort((x, y) => x[0] - y[0]);
  const out = valores.map(() => null);
  const n = ord.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && ord[j + 1][0] === ord[i][0]) j++;
    const p = n === 1 ? 100 : ((i + j) / 2 / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[ord[k][1]] = p;
    i = j + 1;
  }
  return out;
}

// Rajada: fotos em sequência (até 10 min da primeira do grupo) com phash parecido.
// Só a de maior força segue; as outras viram variação. Sem data não agrupa.
function rajadas(fotos) {
  const comData = fotos.filter(f => f.data_foto && !Number.isNaN(Date.parse(f.data_foto))).sort((a, b) => a.data_foto.localeCompare(b.data_foto));
  const rajadaDe = new Map(), variacoes = new Set();
  let grupo = [];
  const fechar = () => {
    if (grupo.length > 1) {
      const melhor = grupo.reduce((m, f) => (f.forca > m.forca ? f : m));
      for (const f of grupo) { rajadaDe.set(f.id, grupo[0].id); if (f !== melhor) variacoes.add(f.id); }
    }
    grupo = [];
  };
  for (const f of comData) {
    const cabeca = grupo[0];
    const junto = cabeca && (Date.parse(f.data_foto) - Date.parse(cabeca.data_foto)) / 1000 <= RAJADA.segundos
      && hamming(f.phash, cabeca.phash) <= RAJADA.hamming;
    if (!junto) fechar();
    grupo.push(f);
  }
  fechar();
  return { rajadaDe, variacoes };
}

// Recalcula sinais, nota por destino, rajadas e tier.
function recalcular(db) {
  const fotos = db.prepare(`SELECT a.id, a.phash, a.data_foto, a.nota_estetica, a.nota_rubrica, a.largura, a.altura,
      a.tem_texto, a.marca_terceiro, a.espaco_para_texto, a.tier, a.tier_fixo, e.vetor
    FROM assets a LEFT JOIN emb_imagem e ON e.asset_id = a.id
    WHERE a.tipo_midia = 'imagem' AND a.st_tecnica = 'ok' AND a.st_ia = 'ok'`).all();
  const pEst = percentis(fotos.map(f => f.nota_estetica));
  const pRub = percentis(fotos.map(f => f.nota_rubrica));
  fotos.forEach((f, i) => {
    f.pEst = pEst[i]; f.pRub = pRub[i];
    f.v = f.vetor ? vetor(f.vetor) : null;
    f.forca = ((f.pEst ?? 0) + (f.pRub ?? 0)) / 2;
  });
  const { rajadaDe, variacoes } = rajadas(fotos);
  const mood = Object.fromEntries(db.prepare('SELECT destino, vetor FROM moodboard').all().map(m => [m.destino, vetor(m.vetor)]));

  const pontos = [], resumo = {};
  for (const destino of DESTINOS) {
    const eleg = fotos.map(f => !variacoes.has(f.id) && f.tier !== 'descartar' && PREREQUISITOS[destino](f));
    const moodV = fotos.map(f => (mood[destino] && f.v ? dot(f.v, mood[destino]) : null));
    const soEleg = xs => xs.map((v, i) => (eleg[i] ? v : null));
    const pMood = percentis(soEleg(moodV));
    const score = fotos.map((f, i) => {
      if (!eleg[i]) return null;
      const s = { estetica: f.pEst, rubrica: f.pRub, moodboard: pMood[i] };
      let total = 0, soma = 0;
      for (const [k, p] of Object.entries(PESOS)) if (s[k] != null) { total += p * s[k]; soma += p; }
      return soma ? total / soma : null;
    });
    const pScore = percentis(score);
    fotos.forEach((f, i) => pontos.push({
      asset_id: f.id, destino, elegivel: eleg[i] ? 1 : 0, moodboard: moodV[i], score: score[i], percentil: pScore[i],
    }));
    resumo[destino] = {
      elegiveis: eleg.filter(Boolean).length, moodboard: !!mood[destino],
    };
  }

  const upPonto = db.prepare(`INSERT INTO pontuacao (asset_id, destino, elegivel, moodboard, score, percentil)
    VALUES (@asset_id, @destino, @elegivel, @moodboard, @score, @percentil)
    ON CONFLICT (asset_id, destino) DO UPDATE SET elegivel = excluded.elegivel, moodboard = excluded.moodboard,
      score = excluded.score, percentil = excluded.percentil`);
  // hero: percentil do score >= 90 no destino, só as 100 de maior score de cada destino
  const hero = db.prepare(`SELECT p.asset_id FROM pontuacao p JOIN assets a ON a.id = p.asset_id
    WHERE p.destino = ? AND p.elegivel = 1 AND p.percentil >= ?
    AND a.tier != 'descartar' ORDER BY p.score DESC LIMIT ?`);
  // tier ou destinos editados à mão (tier_fixo) ficam como a equipe deixou; descarte manual não reverte
  const upAsset = db.prepare(`UPDATE assets SET rajada_id = @rajada_id, nota_final = @nota_final,
    destinos = CASE WHEN tier_fixo = 1 THEN destinos ELSE @destinos END,
    tier = CASE WHEN tier_fixo = 1 OR tier = 'descartar' THEN tier ELSE @tier END WHERE id = @id`);

  const tiers = { hero: 0, social: 0, arquivo: 0, variacao: 0 };
  db.transaction(() => {
    db.exec("DELETE FROM pontuacao WHERE asset_id NOT IN (SELECT id FROM assets WHERE tipo_midia = 'imagem' AND st_tecnica = 'ok' AND st_ia = 'ok')");
    for (const p of pontos) upPonto.run(p);
    const heroes = new Set(DESTINOS.flatMap(d => hero.all(d, P_HERO, TOPO_HERO).map(r => r.asset_id)));
    const porFoto = new Map();
    for (const p of pontos) (porFoto.get(p.asset_id) || porFoto.set(p.asset_id, []).get(p.asset_id)).push(p);
    for (const f of fotos) {
      const ps = porFoto.get(f.id);
      const destinos = ps.filter(p => p.percentil != null && p.percentil >= P_SOCIAL).map(p => p.destino);
      const maior = Math.max(...ps.map(p => p.percentil ?? -1));
      const tier = variacoes.has(f.id) ? 'variacao' : heroes.has(f.id) ? 'hero' : destinos.length ? 'social' : 'arquivo';
      if (!f.tier_fixo) tiers[tier]++;
      upAsset.run({
        id: f.id, rajada_id: rajadaDe.get(f.id) ?? null, nota_final: maior >= 0 ? Math.round(maior) / 10 : null,
        destinos: JSON.stringify(destinos), tier,
      });
    }
  })();
  return { fotos: fotos.length, rajadas: new Set(rajadaDe.values()).size, variacoes: variacoes.size, tiers, destinos: resumo };
}

module.exports = { recalcular, percentis, rajadas, PREREQUISITOS, PESOS, P_SOCIAL, P_HERO, TOPO_HERO };
