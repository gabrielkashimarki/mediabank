const crypto = require('node:crypto');

const COOKIE = 'mb_sessao';
const DURACAO_DIAS = 30;
const TENTATIVAS = 5;
const JANELA_MS = 15 * 60 * 1000;

const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');

// scrypt nativo do Node; guarda "sal:hash" em hex
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  return `${sal.toString('hex')}:${crypto.scryptSync(senha, sal, 64).toString('hex')}`;
}

function conferirSenha(senha, guardado) {
  const [sal, hash] = guardado.split(':');
  const calculado = crypto.scryptSync(senha, Buffer.from(sal, 'hex'), 64);
  return crypto.timingSafeEqual(calculado, Buffer.from(hash, 'hex'));
}

function criarUsuario(db, { email, nome, senha, admin = false }) {
  if (!senha || senha.length < 10) throw new Error('senha precisa ter pelo menos 10 caracteres');
  return db.prepare('INSERT INTO usuarios (email, nome, hash_senha, admin) VALUES (?, ?, ?, ?)')
    .run(email.trim().toLowerCase(), nome, hashSenha(senha), admin ? 1 : 0).lastInsertRowid;
}

// ponytail: contador em memória, zera quando o processo reinicia; bom para um processo só
const falhas = new Map();
const PEDIDOS_REDEFINICAO = 3;
const pedidos = new Map();
const HASH_FALSO = hashSenha('x'.repeat(10));

function entrar(db, email, senha) {
  const chave = String(email || '').trim().toLowerCase();
  const agora = Date.now();
  if (falhas.size > 1000) for (const [k, v] of falhas) if (agora - v.desde >= JANELA_MS) falhas.delete(k);
  const f = falhas.get(chave);
  if (f && f.n >= TENTATIVAS && agora - f.desde < JANELA_MS) return { erro: 'bloqueado' };

  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(chave);
  // confere mesmo sem usuário, para não revelar pelo tempo quais e-mails existem
  const ok = conferirSenha(String(senha || ''), u?.hash_senha || HASH_FALSO) && !!u;
  if (!ok) {
    const novo = f && agora - f.desde < JANELA_MS ? { n: f.n + 1, desde: f.desde } : { n: 1, desde: agora };
    falhas.set(chave, novo);
    return { erro: 'credenciais' };
  }
  falhas.delete(chave);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO sessoes (hash, usuario_id, expira_em) VALUES (?, ?, datetime('now', ?))")
    .run(sha256(token), u.id, `+${DURACAO_DIAS} days`);
  return { token, usuario: { id: u.id, email: u.email, nome: u.nome, admin: !!u.admin } };
}

function lerCookie(req) {
  const m = (req.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

function usuarioDaSessao(db, token) {
  if (!token) return null;
  const u = db.prepare(`SELECT u.id, u.email, u.nome, u.admin FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.hash = ? AND s.expira_em > datetime('now')`).get(sha256(token));
  return u ? { ...u, admin: !!u.admin } : null;
}

// cliente escolhido no seletor do painel (null = ainda não escolheu)
function clienteDaSessao(db, token) {
  return token ? db.prepare('SELECT cliente_id FROM sessoes WHERE hash = ?').get(sha256(token))?.cliente_id ?? null : null;
}
const escolherCliente = (db, token, clienteId) => db.prepare('UPDATE sessoes SET cliente_id = ? WHERE hash = ?').run(clienteId, sha256(token));

function sair(db, token) {
  if (token) db.prepare('DELETE FROM sessoes WHERE hash = ?').run(sha256(token));
}

function cookieSessao(token, { seguro }) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${DURACAO_DIAS * 86400}`];
  if (seguro) attrs.push('Secure');
  return attrs.join('; ');
}
const cookieApagado = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// POST só com JSON: formulário de outro site não manda application/json sem preflight (CSRF).
// PATCH e DELETE vindos de outro site já exigem preflight, que o servidor não libera.
function exigirLogin(db) {
  return (req, res, next) => {
    req.usuario = usuarioDaSessao(db, lerCookie(req));
    if (!req.usuario) return res.status(401).json({ erro: 'faça login' });
    const formOriginais = req.path === '/originais.zip' && req.is('application/x-www-form-urlencoded');
    if (req.method === 'POST' && !req.is('application/json') && !formOriginais) return res.status(415).json({ erro: 'use JSON' });
    next();
  };
}

const exigirAdmin = (req, res, next) => req.usuario?.admin ? next() : res.status(403).json({ erro: 'só administrador' });

function pedirRedefinicao(db, email) {
  const chave = String(email || '').trim().toLowerCase();
  if (!chave) return null;
  const agora = Date.now();
  if (pedidos.size > 1000) for (const [k, v] of pedidos) if (agora - v.desde >= JANELA_MS) pedidos.delete(k);
  const p = pedidos.get(chave);
  if (p && p.n >= PEDIDOS_REDEFINICAO && agora - p.desde < JANELA_MS) return null;

  const u = db.prepare('SELECT id, email, nome FROM usuarios WHERE email = ?').get(chave);
  if (!u) return null;

  pedidos.set(chave, p && agora - p.desde < JANELA_MS ? { n: p.n + 1, desde: p.desde } : { n: 1, desde: agora });
  db.prepare('DELETE FROM redefinicoes WHERE usuario_id = ? AND usado_em IS NULL').run(u.id);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO redefinicoes (hash, usuario_id, expira_em) VALUES (?, ?, datetime('now', '+30 minutes'))")
    .run(sha256(token), u.id);
  return { token, email: u.email, nome: u.nome };
}

function redefinirSenha(db, token, senha) {
  if (!senha || typeof senha !== 'string' || senha.length < 10) return { erro: 'senha_curta' };
  if (!token || typeof token !== 'string') return { erro: 'link_invalido' };

  const r = db.prepare(`SELECT r.hash, r.usuario_id, u.email FROM redefinicoes r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.hash = ? AND r.usado_em IS NULL AND r.expira_em > datetime('now')`).get(sha256(token));
  if (!r) return { erro: 'link_invalido' };

  db.transaction(() => {
    db.prepare('UPDATE usuarios SET hash_senha = ? WHERE id = ?').run(hashSenha(senha), r.usuario_id);
    db.prepare("UPDATE redefinicoes SET usado_em = datetime('now') WHERE hash = ?").run(r.hash);
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(r.usuario_id);
  })();

  falhas.delete(r.email.trim().toLowerCase());
  return { ok: true };
}

module.exports = {
  hashSenha, conferirSenha, criarUsuario, entrar, sair, usuarioDaSessao, lerCookie, clienteDaSessao, escolherCliente,
  cookieSessao, cookieApagado, exigirLogin, exigirAdmin,
  pedirRedefinicao, redefinirSenha,
};
