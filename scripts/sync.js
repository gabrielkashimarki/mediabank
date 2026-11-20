// Uso: node scripts/sync.js [--limite N]
// Traz do Drive (conta do .env) as imagens novas. --limite corta quantas fotos NOVAS entram nesta rodada.
const { carregar } = require('../src/config');
const { sincronizar } = require('../src/sync');

async function main() {
  const cfg = carregar();
  if (!cfg.drive) throw new Error('faltam GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN (rodar com op run)');
  const i = process.argv.indexOf('--limite');
  const limite = i === -1 ? Infinity : Number(process.argv[i + 1]);
  console.log(JSON.stringify(await sincronizar(cfg.db, cfg.drive, { dirDados: cfg.dirDados, limite })));
  const falhas = cfg.db.prepare('SELECT nome, erro, tentativas FROM sync_falhas ORDER BY tentativas DESC LIMIT 5').all();
  if (falhas.length) console.log('falhas:', JSON.stringify(falhas));
}

main().catch(e => { console.error(e.message); process.exit(1); });
