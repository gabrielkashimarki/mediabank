const crypto = require('node:crypto');
const { PADRAO, ESCOPOS, validar, escoposDaChave } = require('./clientes');

const hashChave = chave => crypto.createHash('sha256').update(chave).digest('hex');

// devolve a chave em claro uma única vez; o banco guarda só o hash
// sem escopo, vale a regra das chaves antigas (clientes.escoposDaChave)
function criarChave(db, nome, { cliente = PADRAO, escopo = null } = {}) {
  validar(cliente);
  if (escopo && !escopo.split(' ').every(e => ESCOPOS.includes(e))) throw new Error(`escopo inválido: ${escopo}`);
  const chave = 'mb_' + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO api_keys (nome, hash, cliente_id, escopo) VALUES (?, ?, ?, ?)').run(nome, hashChave(chave), cliente, escopo);
  return chave;
}

// {nome, cliente, escopos} da chave, ou null
function dadosDaChave(db, chave) {
  if (!chave) return null;
  const k = db.prepare('SELECT nome, cliente_id, escopo FROM api_keys WHERE hash = ?').get(hashChave(chave));
  return k ? { nome: k.nome, cliente: k.cliente_id, escopos: escoposDaChave(k) } : null;
}

// middleware: a chave (lida por `ler`) precisa ter o escopo; req.chave fica com os dados dela
const exigirEscopo = (db, escopo, ler) => (req, res, next) => {
  const k = dadosDaChave(db, ler(req));
  if (!k || !k.escopos.includes(escopo)) return res.status(401).json({ erro: 'chave inválida' });
  req.chave = k;
  next();
};

function chaveValida(db, chave) {
  if (!chave) return false;
  return !!db.prepare('SELECT 1 FROM api_keys WHERE hash = ?').get(hashChave(chave));
}

// nome da chave (ex.: 'lote' para o trabalhador de estética e CLIP), ou null
function nomeDaChave(db, chave) {
  if (!chave) return null;
  return db.prepare('SELECT nome FROM api_keys WHERE hash = ?').get(hashChave(chave))?.nome ?? null;
}

module.exports = { criarChave, chaveValida, nomeDaChave, dadosDaChave, exigirEscopo };
