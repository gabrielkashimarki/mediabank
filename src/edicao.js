const { ESPACOS, TIPOS_EVENTO, LISTAS, DESTINOS, TIERS, AUTORIZACAO_USO, localDe } = require('./vocabulario');
const { PADRAO, validar } = require('./clientes');

const texto = max => v => (v === null || (typeof v === 'string' && v.length <= max) ? v : undefined);
const umDe = xs => v => (xs.includes(v) ? v : undefined);
const umDeOuNulo = xs => v => (v === null ? null : umDe(xs)(v));
const bool = v => (typeof v === 'boolean' ? (v ? 1 : 0) : undefined);
const listaTexto = v => (Array.isArray(v) && v.every(x => typeof x === 'string' && x.length <= 200) ? JSON.stringify(v) : undefined);

// campo editável: converte o valor para a coluna ou devolve undefined se inválido
const EDITAVEIS = {
  titulo: texto(120), descricao: texto(4000), legenda: texto(500), alt: texto(250),
  evento: texto(200), fotografo: texto(200),
  espaco: umDeOuNulo(ESPACOS),
  tipo_evento: v => (v === null || Object.hasOwn(TIPOS_EVENTO, v) ? v : undefined),
  ...Object.fromEntries(Object.entries(LISTAS).map(([c, xs]) => [c, umDeOuNulo(xs)])),
  tier: umDe(TIERS),
  autorizacao_uso: umDe(AUTORIZACAO_USO),
  destinos: v => (Array.isArray(v) && v.every(d => DESTINOS.includes(d)) ? JSON.stringify([...new Set(v)]) : undefined),
  tem_crianca: bool, tem_texto: bool, marca_terceiro: bool, rostos_identificaveis: bool,
  perguntas_que_responde: listaTexto, fornecedores: listaTexto,
  capacidade_estimada: v => (v === null || (Number.isInteger(v) && v >= 0) ? v : undefined),
};

// mudar um destes numa foto aprovada, sem ser admin, derruba a aprovação
const PROTECAO = ['tem_crianca', 'autorizacao_uso', 'tier', 'tem_texto', 'marca_terceiro', 'rostos_identificaveis'];
// mudar um destes invalida o embedding de texto
const REINDEXA = ['titulo', 'descricao', 'legenda', 'espaco', 'tipo_evento', 'perguntas_que_responde'];

function validarEdicao(campos) {
  const sets = {}, erros = [];
  if (!campos || typeof campos !== 'object' || Array.isArray(campos)) return { ok: false, erros: ['corpo inválido'] };
  for (const [c, v] of Object.entries(campos)) {
    if (!Object.hasOwn(EDITAVEIS, c)) { erros.push(`campo não editável: ${c}`); continue; }
    const conv = EDITAVEIS[c](v);
    conv === undefined ? erros.push(`valor inválido em ${c}`) : (sets[c] = conv);
  }
  if ('espaco' in sets) sets.local = localDe(sets.espaco);
  if (!erros.length && !Object.keys(sets).length) erros.push('nada para editar');
  return erros.length ? { ok: false, erros } : { ok: true, sets };
}

// Aplica a edição validada em cada id do cliente. Devolve quantas fotos mudaram.
function editar(db, ids, campos, usuario, cliente = PADRAO) {
  const v = validarEdicao(campos);
  if (!v.ok) return v;
  const sets = { ...v.sets };
  if (REINDEXA.some(c => c in sets)) sets.st_embedding = 'pendente';
  // a curadoria automática não desfaz tier ou destinos escolhidos pela equipe
  if ('tier' in sets || 'destinos' in sets) sets.tier_fixo = 1;
  const cols = Object.keys(sets).map(c => `${c} = @${c}`).join(', ');
  const derruba = !usuario.admin && PROTECAO.some(c => c in sets);
  const upd = db.prepare(`UPDATE assets SET ${cols}${derruba ? `,
    aprovacao = CASE WHEN aprovacao = 'aprovada' THEN 'pendente' ELSE aprovacao END,
    aprovado_por = NULL, aprovado_em = NULL` : ''} WHERE id = @id AND cliente_id = @cliente_id`);
  let n = 0;
  db.transaction(() => { for (const id of ids) n += upd.run({ ...sets, id, cliente_id: validar(cliente) }).changes; })();
  return { ok: true, n };
}

// só admin chega aqui (a rota confere); revogar volta para pendente
function aprovar(db, ids, sim, usuario, cliente = PADRAO) {
  validar(cliente);
  const upd = sim
    ? db.prepare("UPDATE assets SET aprovacao = 'aprovada', aprovado_por = ?, aprovado_em = datetime('now') WHERE id = ? AND cliente_id = ?")
    : db.prepare("UPDATE assets SET aprovacao = 'pendente', aprovado_por = NULL, aprovado_em = NULL WHERE id = ? AND cliente_id = ?");
  let n = 0;
  db.transaction(() => { for (const id of ids) n += (sim ? upd.run(usuario.id, id, cliente) : upd.run(id, cliente)).changes; })();
  return n;
}

module.exports = { validarEdicao, editar, aprovar, EDITAVEIS, PROTECAO, REINDEXA };
