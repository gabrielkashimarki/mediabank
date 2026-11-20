// Convite: cria o usuário (sem senha conhecida por ninguém), dá os vínculos e manda por e-mail um link para a pessoa
// criar a própria senha. O link usa a mesma tabela do "esqueci a senha", mas vale 7 dias.
const crypto = require('node:crypto');
const auth = require('./auth');
const { vincular } = require('./clientes');

const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// vinculos: [['exemplo', 'admin'], ['outro', 'admin']]
async function convidar(db, { email: destino, nome, vinculos, dias = 7, base }, enviador) {
  const endereco = String(destino || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(endereco) || !nome || !Array.isArray(vinculos) || !vinculos.length) throw new Error('use email, nome e ao menos um vínculo');
  let u = db.prepare('SELECT id, nome FROM usuarios WHERE email = ?').get(endereco);
  const novo = !u;
  let token = null;
  db.transaction(() => {
    if (novo) {
      const id = auth.criarUsuario(db, { email: endereco, nome, senha: crypto.randomBytes(32).toString('base64url') });
      u = { id, nome };
      token = crypto.randomBytes(32).toString('base64url');
      db.prepare("INSERT INTO redefinicoes (hash, usuario_id, expira_em) VALUES (?, ?, datetime('now', ?))").run(sha256(token), id, `+${dias} days`);
    }
    for (const [cliente, papel] of vinculos) vincular(db, u.id, cliente, papel);
  })();
  const nomes = vinculos.map(([c]) => db.prepare('SELECT nome FROM clientes WHERE id = ?').get(c)?.nome || c).join(' e ');
  const raiz = String(base || '').replace(/\/+$/, '');
  const html = novo
    ? `<p>Olá, ${esc(u.nome)}!</p><p>Você foi convidada(o) para o MediaBank (${esc(nomes)}).</p>`
      + `<p><a href="${raiz}/login.html?redefinir=${token}">Clique aqui para criar sua senha</a>. O link vale por ${dias} dias e só pode ser usado uma vez.</p>`
      + `<p>Depois é só entrar em <a href="${raiz}/login.html">${raiz.replace(/^https?:\/\//, '')}</a> com este e-mail.</p>`
    : `<p>Olá, ${esc(u.nome)}!</p><p>Seu acesso ao MediaBank agora inclui ${esc(nomes)}. Entre em <a href="${raiz}/login.html">${raiz.replace(/^https?:\/\//, '')}</a> com sua senha de sempre.</p>`;
  if (enviador) await enviador.enviar({ para: endereco, assunto: novo ? 'Convite para o MediaBank' : 'Novo acesso no MediaBank', html });
  return { usuario: u.id, novo, enviado: !!enviador, vinculos };
}

module.exports = { convidar };
