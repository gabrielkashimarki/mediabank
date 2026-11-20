// Uso: op read "op://<cofre>/<item>/password" | node scripts/criar-usuario.js <email> <nome> [--admin] [--cliente outro --papel editor]
// --admin: dono do sistema, entra em todos os clientes. --cliente: vínculo com um cliente (sem ele, o usuário é do cliente PADRAO).
// A senha entra pelo stdin, nunca pela linha de comando (ficaria no histórico do shell e no ps).
const { carregar } = require('../src/config');
const { criarUsuario } = require('../src/auth');
const { vincular } = require('../src/clientes');

const opcao = n => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
const valores = new Set(['cliente', 'papel'].map(opcao));
const [email, nome] = process.argv.slice(2).filter(a => !a.startsWith('--') && !valores.has(a));
if (!email || !nome) { console.error('uso: ... | node scripts/criar-usuario.js <email> <nome> [--admin]'); process.exit(1); }
if (process.stdin.isTTY) { console.error('mande a senha pelo stdin (ex.: op read ... |)'); process.exit(1); }

// leitura assíncrona: readFileSync(0) dá EAGAIN quando quem escreve no pipe demora (caso do op)
(async () => {
  let senha = '';
  for await (const pedaco of process.stdin) senha += pedaco;
  try {
    const { db } = carregar();
    const id = db.transaction(() => {
      const novo = criarUsuario(db, { email, nome, senha: senha.trim(), admin: process.argv.includes('--admin') });
      if (opcao('cliente')) vincular(db, novo, opcao('cliente'), opcao('papel') || 'editor');
      return novo;
    })();
    const vinculo = opcao('cliente') ? ` (${opcao('cliente')}, ${opcao('papel') || 'editor'})` : '';
    console.log(`usuário ${id} criado: ${email.trim().toLowerCase()}${process.argv.includes('--admin') ? ' (admin)' : ''}${vinculo}`);
  } catch (e) {
    console.error(e.message.includes('UNIQUE') ? 'e-mail já cadastrado' : e.message);
    process.exit(1);
  }
})();
