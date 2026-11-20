// Nota de take por cena e grupos de takes repetidos (spec multi-cliente, "Melhores takes").
// Mesma ideia da curadoria de fotos: sinais em percentil, pesos fixos, e o grupo mostra só o melhor.
const { hamming } = require('./ingestao');
const { percentis } = require('./curadoria');
const { PADRAO, sqlCliente } = require('./clientes');

const PESOS = { estetica: 40, rubrica: 40, tecnica: 20 };
// takes do mesmo plano: mesma pasta, gravados com até 10 min de diferença e quadro parecido.
// Medido em takes reais (31/10): o mesmo plano dá cosseno 0,92 a 0,97 e planos diferentes até 0,88; o phash
// do quadro varia demais em vídeo de câmera na mão (23 a 27 no mesmo plano) e só vale quando falta o vetor.
const GRUPO = { segundos: 600, cosseno: 0.915, hammingSemVetor: 8 };

const vetor = buf => new Float32Array(new Uint8Array(buf).buffer);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const media = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

// técnica da cena: nitidez alta, pouco tremido e exposição perto do meio, cada um em percentil
function notaTecnica(cenas) {
  const nit = percentis(cenas.map(c => c.nota_nitidez));
  const tre = percentis(cenas.map(c => (c.nota_tremido == null ? null : -c.nota_tremido)));
  const exp = percentis(cenas.map(c => (c.nota_exposicao == null ? null : -Math.abs(c.nota_exposicao - 128))));
  return cenas.map((_, i) => media([nit[i], tre[i], exp[i]]));
}

function agrupar(cenas) {
  const pai = new Map(cenas.map(c => [c.id, c.id]));
  const raiz = x => { while (pai.get(x) !== x) { pai.set(x, pai.get(pai.get(x))); x = pai.get(x); } return x; };
  const porPasta = new Map();
  for (const c of cenas) if (c.pasta_id) porPasta.set(c.pasta_id, [...(porPasta.get(c.pasta_id) || []), c]);
  for (const grupo of porPasta.values()) {
    for (let i = 0; i < grupo.length; i++) for (let j = i + 1; j < grupo.length; j++) {
      const a = grupo[i], b = grupo[j];
      if (a.asset_id === b.asset_id) continue; // cortes do mesmo arquivo não são takes repetidos
      const ta = Date.parse(a.data_foto), tb = Date.parse(b.data_foto);
      if (Number.isNaN(ta) || Number.isNaN(tb) || Math.abs(ta - tb) / 1000 > GRUPO.segundos) continue;
      const parecido = a.v && b.v ? dot(a.v, b.v) >= GRUPO.cosseno : !!(a.phash && b.phash) && hamming(a.phash, b.phash) <= GRUPO.hammingSemVetor;
      if (parecido) pai.set(raiz(a.id), raiz(b.id));
    }
  }
  const membros = new Map();
  for (const c of cenas) membros.set(raiz(c.id), [...(membros.get(raiz(c.id)) || []), c.id]);
  const grupoDe = new Map();
  for (const ids of membros.values()) if (ids.length > 1) { const g = `g:${[...ids].sort()[0]}`; for (const id of ids) grupoDe.set(id, g); }
  return grupoDe;
}

function recalcularTakes(db, cliente = PADRAO) {
  const cenas = db.prepare(`SELECT c.*, a.pasta_id, a.data_foto, e.vetor FROM cenas c JOIN assets a ON a.id = c.asset_id
      LEFT JOIN emb_quadro e ON e.cena_id = c.id
    WHERE ${sqlCliente(cliente)} AND a.tipo_midia = 'video' AND a.st_ia = 'ok' AND c.st_tecnica = 'ok'`).all()
    .map(c => ({ ...c, v: c.vetor ? vetor(c.vetor) : null }));
  const tec = percentis(notaTecnica(cenas));
  const est = percentis(cenas.map(c => c.nota_estetica));
  const rub = percentis(cenas.map(c => c.nota_rubrica));
  // sinal ausente não pesa e o peso dele vai para os presentes
  const score = cenas.map((_, i) => {
    const s = [[est[i], PESOS.estetica], [rub[i], PESOS.rubrica], [tec[i], PESOS.tecnica]].filter(([v]) => v != null);
    const peso = s.reduce((t, [, p]) => t + p, 0);
    return peso ? s.reduce((t, [v, p]) => t + v * p, 0) / peso : null;
  });
  const pct = percentis(score);
  const grupoDe = agrupar(cenas);
  const upd = db.prepare('UPDATE cenas SET nota_take = ?, take_grupo = ? WHERE id = ?');
  db.transaction(() => {
    db.prepare(`UPDATE cenas SET nota_take = NULL, take_grupo = NULL WHERE cliente_id = ? AND st_tecnica != 'ok'`).run(cliente);
    cenas.forEach((c, i) => upd.run(pct[i] == null ? null : Math.round(pct[i]) / 10, grupoDe.get(c.id) || null, c.id));
  })();
  return { cenas: cenas.length, grupos: new Set(grupoDe.values()).size };
}

module.exports = { recalcularTakes, agrupar, notaTecnica, PESOS, GRUPO };
