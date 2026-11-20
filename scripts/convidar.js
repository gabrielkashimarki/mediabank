// Uso (no servidor): node scripts/convidar.js <email> "<nome>" exemplo:admin outro:admin
// Cria o usuário com vínculo em cada cliente e manda o e-mail com o link para criar a senha (7 dias).
// Se o e-mail já existe, só acrescenta os vínculos e avisa. Ninguém vê a senha; o link sai só no e-mail.
const { carregar } = require('../src/config');
const { convidar } = require('../src/convites');

const [email, nome, ...pares] = process.argv.slice(2);
const vinculos = pares.map(p => p.split(':'));
const cfg = carregar();
if (!cfg.email) { console.error('SMTP não configurado: o convite não teria como chegar'); process.exit(1); }
convidar(cfg.db, { email, nome, vinculos, base: process.env.BASE_URL || 'http://localhost:3000' }, cfg.email)
  .then(r => console.log(JSON.stringify(r)))
  .catch(e => { console.error(e.message); process.exit(1); });
