// Registro de uso (em qual peça e plano cada mídia entrou) e a regra de não repetir de cada cliente.
// A regra conta por origem_grupo (o mesmo item do banco salvo com dois nomes é uma mídia só) e ignora uso retirado.
const { vocabularioDe, validar } = require('./clientes');

const grupoDe = a => a.origem_grupo || a.id;

// mídia por id do mediabank ou pela chave da importação (ex.: clips2/cha, que o projeto de edição conhece)
function resolverMidia(db, cliente, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  return db.prepare(`SELECT * FROM assets WHERE cliente_id = ? AND (id = ? OR caminho_origem = ?
      OR id = (SELECT asset_id FROM apelidos WHERE cliente_id = ? AND chave = ?))`).get(validar(cliente), ref, `${cliente}:${ref}`, cliente, ref) || null;
}

// Para cada {plano, asset} proposto para a peça: o motivo de não poder, ou null. Olha as outras peças e os outros planos da mesma.
// Dentro da peça, `perto` diz a distância em planos que conta como repetição: no roteiro, só o que volta logo em seguida
// parece loop (vídeos aprovados costumam repetir cena longe uma da outra); na troca, nada se repete (perto = Infinity).
// Os planos nas mensagens contam a partir de 1, como a pessoa vê na tela.
function conflitos(db, cliente, peca, propostos, { perto = 2 } = {}) {
  const regras = vocabularioDe(cliente).REGRAS_USO;
  const outrasPecas = db.prepare(`SELECT DISTINCT u.peca FROM usos u JOIN assets x ON x.id = u.asset_id
    WHERE u.cliente_id = ? AND coalesce(x.origem_grupo, x.id) = ? AND u.situacao != 'retirado' AND u.peca != ? ORDER BY u.peca`);
  const naPeca = new Map(); // grupo -> planos desta peça que o usam
  for (const p of propostos) if (p.asset) naPeca.set(grupoDe(p.asset), [...(naPeca.get(grupoDe(p.asset)) || []), p.plano]);
  return propostos.map(p => {
    if (!p.asset) return { plano: p.plano, motivo: 'mídia não encontrada' };
    if (p.asset.aprovacao === 'reprovada') return { plano: p.plano, motivo: `reprovada${p.asset.aprovacao_motivo ? `: ${p.asset.aprovacao_motivo}` : ''}` };
    const grupo = grupoDe(p.asset);
    const repetida = (naPeca.get(grupo) || []).filter(x => x !== p.plano && Math.abs(x - p.plano) <= perto);
    if (!regras) return { plano: p.plano, motivo: null };
    const et = JSON.parse(p.asset.etiquetas || '{}');
    if (regras.livres?.some(l => et[l.campo] === l.valor)) return { plano: p.plano, motivo: null };
    if (repetida.length) return { plano: p.plano, motivo: `repete na mesma peça (plano ${repetida.map(x => x + 1).join(', ')})` };
    const pecas = outrasPecas.all(cliente, grupo, peca).map(r => r.peca);
    const unico = regras.unico?.find(r => r.valores.includes(et[r.campo]));
    if (unico && pecas.length) return { plano: p.plano, motivo: `${et[unico.campo]} não repete entre peças: já está em ${pecas.join(', ')}` };
    if (regras.maxPecas && pecas.length >= regras.maxPecas) return { plano: p.plano, motivo: `já está em ${pecas.length} peças (máximo ${regras.maxPecas}): ${pecas.join(', ')}` };
    return { plano: p.plano, motivo: null };
  });
}

// Grava os planos da peça (troca a lista inteira). Plano com mídia que o banco não conhece volta em `desconhecidas`.
function registrarPlanos(db, cliente, peca, { titulo = null, peca_tipo = 'video', planos }, quem) {
  validar(cliente);
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(peca) || !Array.isArray(planos) || planos.length > 300) throw new Error('use {planos: [{plano, midia, ancora, ini, fim}]} e um id de peça simples');
  const num = v => (Number.isFinite(v) ? v : null);
  const linhas = [], desconhecidas = [];
  for (const p of planos) {
    const a = resolverMidia(db, cliente, p.midia);
    if (!Number.isInteger(p.plano) || p.plano < 0) throw new Error(`plano inválido: ${p.plano}`);
    if (!a) { desconhecidas.push({ plano: p.plano, midia: p.midia }); continue; }
    linhas.push({ plano: p.plano, asset: a, ancora: typeof p.ancora === 'string' ? p.ancora.slice(0, 200) : null, ini: num(p.ini), fim: num(p.fim),
      cena_id: typeof p.cena === 'string' ? p.cena : null, trecho_ini: num(p.trecho_ini), trecho_fim: num(p.trecho_fim) });
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO pecas (cliente_id, id, titulo, peca_tipo) VALUES (?, ?, ?, ?)
      ON CONFLICT (cliente_id, id) DO UPDATE SET titulo = coalesce(excluded.titulo, titulo), atualizado_em = datetime('now')`).run(cliente, peca, titulo, peca_tipo);
    db.prepare("DELETE FROM usos WHERE cliente_id = ? AND peca = ? AND situacao = 'planejado'").run(cliente, peca);
    const ins = db.prepare(`INSERT INTO usos (cliente_id, peca, plano, asset_id, cena_id, ancora, ini, fim, trecho_ini, trecho_fim, registrado_por)
      VALUES (@cliente, @peca, @plano, @asset_id, @cena_id, @ancora, @ini, @fim, @trecho_ini, @trecho_fim, @quem)
      ON CONFLICT (cliente_id, peca, plano) DO UPDATE SET asset_id = excluded.asset_id, ancora = excluded.ancora, ini = excluded.ini, fim = excluded.fim`);
    for (const l of linhas) ins.run({ ...l, asset_id: l.asset.id, asset: undefined, cliente, peca, quem });
  })();
  // conflito é aviso: o roteiro atual entra mesmo assim, e a revisão mostra o motivo
  return { planos: linhas.length, desconhecidas, conflitos: conflitos(db, cliente, peca, linhas).filter(c => c.motivo) };
}

module.exports = { conflitos, registrarPlanos, resolverMidia, grupoDe };
