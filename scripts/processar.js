// Uso: node scripts/processar.js [--limite N] [--refazer-erros] [--concorrencia N]
// --limite controla o gasto: só N fotos vão para a IA nesta rodada.
const { carregar } = require('../src/config');
const { processar } = require('../src/pipeline');

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const cfg = carregar();
  if (!cfg.cliente) throw new Error('OPENROUTER_API_KEY ausente');
  const r = await processar(cfg.db, {
    ...cfg,
    limite: arg('--limite') ? Number(arg('--limite')) : Infinity,
    concorrencia: Number(arg('--concorrencia') || 4),
    refazerErros: process.argv.includes('--refazer-erros'),
  });
  const erros = cfg.db.prepare("SELECT erro, count(*) n FROM assets WHERE st_ia = 'erro' GROUP BY erro ORDER BY n DESC LIMIT 5").all();
  console.log(JSON.stringify({ ...r, erros }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
