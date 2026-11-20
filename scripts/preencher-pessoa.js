// Preenche tem_pessoa nas fotos analisadas antes de o campo existir, com uma pergunta curta à IA de visão.
// Uso: node scripts/preencher-pessoa.js [--modelo openai/gpt-6-luna] [--concorrencia 8] [--limite N]
const fs = require('node:fs');
const path = require('node:path');
const { carregar } = require('../src/config');

const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i === -1 ? padrao : process.argv[i + 1]; };
const PERGUNTA = 'Há alguma pessoa nesta foto, mesmo de costas, de longe, desfocada ou só parte do corpo (mão servindo, silhueta)? Responda só JSON: {"tem_pessoa": true ou false}';

async function main() {
  const cfg = carregar();
  if (!cfg.cliente) throw new Error('OPENROUTER_API_KEY ausente');
  const modelo = arg('--modelo', 'openai/gpt-6-luna');
  const fila = cfg.db.prepare("SELECT id FROM assets WHERE tipo_midia = 'imagem' AND st_ia = 'ok' AND tem_pessoa IS NULL LIMIT ?")
    .all(Number(arg('--limite', 1e9))).map(r => r.id);
  const gravar = cfg.db.prepare('UPDATE assets SET tem_pessoa = ? WHERE id = ?');
  const r = { total: fila.length, com: 0, sem: 0, erros: 0 };
  const trabalhar = async () => {
    while (fila.length) {
      const id = fila.shift();
      try {
        // max_tokens folgado: o raciocínio do modelo conta no limite e 50 cortava a resposta
        // a miniatura de 600 px basta para ver se há gente e custa menos que a prévia
        const jpeg = fs.readFileSync(path.join(cfg.dirDados, 'midia', 'thumb', `${id}.jpg`));
        const texto = await cfg.cliente.chat(modelo, [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          { type: 'text', text: PERGUNTA },
        ] }], { response_format: { type: 'json_object' }, max_tokens: 400, temperature: 0, reasoning: { effort: 'low' } });
        const v = JSON.parse(texto.match(/\{[\s\S]*\}/)[0]).tem_pessoa;
        if (typeof v !== 'boolean') throw new Error(`resposta sem booleano: ${texto.slice(0, 60)}`);
        gravar.run(v ? 1 : 0, id);
        r[v ? 'com' : 'sem']++;
      } catch (e) {
        r.erros++;
        console.error(id, e.message.slice(0, 120));
      }
    }
  };
  await Promise.all(Array.from({ length: Number(arg('--concorrencia', 8)) }, trabalhar));
  console.log(JSON.stringify(r));
}

main().catch(e => { console.error(e.message); process.exit(1); });
