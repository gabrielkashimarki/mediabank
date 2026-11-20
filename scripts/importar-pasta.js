// Uso: node scripts/importar-pasta.js <pasta>
// Varre a pasta (recursivo) e ingere as imagens. Pode ser a pasta do Drive para desktop.
const fs = require('node:fs');
const path = require('node:path');
const { carregar } = require('../src/config');
const { ingerirArquivo } = require('../src/ingestao');

const EXT = /\.(jpe?g|png|webp|tiff?|heic|dng)$/i;

async function main() {
  const pasta = process.argv[2];
  if (!pasta) throw new Error('informe a pasta');
  const { db, dirDados } = carregar();
  const arquivos = fs.readdirSync(pasta, { recursive: true }).filter(f => EXT.test(f)).map(f => path.join(pasta, f));
  let novos = 0, repetidos = 0, falhas = 0;
  for (const [i, arq] of arquivos.entries()) {
    try {
      (await ingerirArquivo(db, arq, { dirDados })).novo ? novos++ : repetidos++;
    } catch (e) {
      falhas++;
      console.error(`falha em ${arq}: ${e.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`${i + 1}/${arquivos.length}`);
  }
  console.log(JSON.stringify({ total: arquivos.length, novos, repetidos, falhas }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
