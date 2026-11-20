// Clientes (workspaces) do MediaBank: vocabulário, regra de exposição e quem entra em qual.
// O primeiro é o PADRAO; o que existia antes do multicliente é dele (padrão das colunas cliente_id).
// Os dois vocabulários são exemplos fictícios: troque pelos dos seus clientes.

const PADRAO = 'exemplo';
// o vocabulário existe no código; a linha em clientes só entra quando o cliente é criado (importação, registrar)
const VOCABULARIOS = {
  exemplo: require('./vocabularios/exemplo'),
  outro: require('./vocabularios/outro'),
};
const PAPEIS = ['admin', 'editor', 'leitor'];

// o id vai literal no SQL (a.cliente_id = '...'): só slug conhecido passa
function validar(id) {
  if (!Object.hasOwn(VOCABULARIOS, id)) throw new Error(`cliente desconhecido: ${id}`);
  return id;
}

const vocabularioDe = id => VOCABULARIOS[validar(id)];

// cliente novo: vocabulário no registro e linha em clientes (idempotente)
function registrar(db, vocab) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(vocab.id)) throw new Error(`id de cliente inválido: ${vocab.id}`);
  VOCABULARIOS[vocab.id] = vocab;
  db.prepare('INSERT OR IGNORE INTO clientes (id, nome) VALUES (?, ?)').run(vocab.id, vocab.nome);
}
const sqlCliente = (id, alias = 'a') => `${alias}.cliente_id = '${validar(id)}'`;

// regra de exposição externa (site, bot, Jev, link público) e acervo interno (MCP), sempre presa ao cliente
const exposicao = id => `${sqlCliente(id)} AND ${vocabularioDe(id).EXPOSICAO.externa}`;
const acervo = id => `${sqlCliente(id)} AND ${vocabularioDe(id).EXPOSICAO.acervo}`;

// Clientes que o usuário pode abrir, com o papel. Só entra em um cliente quem tem vínculo com ele em membros:
// usuarios.admin não dá acesso a outros clientes.
// Usuário sem nenhum vínculo é do PADRAO (todos os que existiam antes da tabela membros), admin se era admin.
function clientesDoUsuario(db, usuario) {
  const todos = db.prepare('SELECT id, nome FROM clientes ORDER BY criado_em, id').all();
  const vinculos = db.prepare('SELECT cliente_id, papel FROM membros WHERE usuario_id = ?').all(usuario.id);
  if (!vinculos.length) return todos.filter(c => c.id === PADRAO).map(c => ({ ...c, papel: usuario.admin ? 'admin' : 'editor' }));
  const papel = new Map(vinculos.map(v => [v.cliente_id, v.papel]));
  return todos.filter(c => papel.has(c.id)).map(c => ({ ...c, papel: papel.get(c.id) }));
}

function vincular(db, usuarioId, clienteId, papel = 'editor') {
  validar(clienteId);
  if (!PAPEIS.includes(papel)) throw new Error(`papel inválido: ${papel}`);
  db.prepare(`INSERT INTO membros (usuario_id, cliente_id, papel) VALUES (?, ?, ?)
    ON CONFLICT (usuario_id, cliente_id) DO UPDATE SET papel = excluded.papel`).run(usuarioId, clienteId, papel);
}

// Escopos da chave. Chave anterior aos escopos (escopo nulo): 'lote' é do trabalhador, as outras leem a API v1 e o MCP.
// acervo: junto com v2, a chave vê o acervo interno do cliente (como o MCP), não só o aprovado (uso da própria equipe, ex.: get-brolls)
const ESCOPOS = ['v1', 'mcp', 'lote', 'v2', 'acervo'];
const escoposDaChave = ({ nome, escopo }) => (escopo ? escopo.split(' ') : nome === 'lote' ? ['lote'] : ['v1', 'mcp']);

module.exports = { PADRAO, VOCABULARIOS, PAPEIS, ESCOPOS, validar, registrar, vocabularioDe, sqlCliente, exposicao, acervo, clientesDoUsuario, vincular, escoposDaChave };
