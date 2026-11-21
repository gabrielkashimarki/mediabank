// Classificação de vídeo pela assinatura do Claude, contra o MediaBank em MEDIABANK_URL (chave MEDIABANK_LOTE_KEY).
//   node scripts/classificar-pela-assinatura.js baixar <pasta> [--limite 40] [--cliente exemplo]
//     grava instrucoes.md, pendentes.json e as grades (JPG com os quadros numerados das cenas) de cada vídeo
//   node scripts/classificar-pela-assinatura.js enviar <arquivo.json>
//     manda as análises ([{id, ...campos, cenas: [{n, descricao, tags, qualidade}]}]); o servidor valida contra o vocabulário
const fs = require('node:fs');
const path = require('node:path');

const { MEDIABANK_URL: BASE, MEDIABANK_LOTE_KEY: CHAVE } = process.env;
const opcao = (n, padrao) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? padrao : process.argv[i + 1]; };
const pedir = (rota, corpo) => fetch(BASE + rota, {
  method: corpo ? 'POST' : 'GET',
  headers: { 'X-API-Key': CHAVE, ...(corpo && { 'Content-Type': 'application/json' }) },
  body: corpo && JSON.stringify(corpo),
});

async function main() {
  const [modo, alvo] = process.argv.slice(2);
  if (!BASE || !CHAVE) throw new Error('faltam MEDIABANK_URL e MEDIABANK_LOTE_KEY (rodar com op run)');
  if (modo === 'baixar' && alvo) {
    const cliente = opcao('cliente', 'exemplo'), limite = opcao('limite', '40');
    fs.mkdirSync(alvo, { recursive: true });
    fs.writeFileSync(path.join(alvo, 'instrucoes.md'), await (await pedir(`/api/lote/videos/instrucoes?cliente=${cliente}`)).text());
    const pendentes = await (await pedir(`/api/lote/videos/ia-pendentes?cliente=${cliente}&limite=${limite}`)).json();
    for (const v of pendentes) {
      v.grades = await Promise.all(v.grades.map(async (url, i) => {
        const arq = path.resolve(alvo, `${v.id}_${i}.jpg`);
        fs.writeFileSync(arq, Buffer.from(await (await pedir(url)).arrayBuffer()));
        return arq;
      }));
    }
    fs.writeFileSync(path.join(alvo, 'pendentes.json'), JSON.stringify(pendentes, null, 1));
    console.log(JSON.stringify({ videos: pendentes.length, cenas: pendentes.reduce((s, v) => s + v.cenas, 0), pasta: path.resolve(alvo) }));
  } else if (modo === 'enviar' && alvo) {
    const r = { ok: 0, recusados: [] };
    for (const a of JSON.parse(fs.readFileSync(alvo, 'utf8'))) {
      const res = await pedir(`/api/lote/videos/${encodeURIComponent(a.id)}/analise`, a);
      if (res.ok) r.ok++;
      else r.recusados.push({ id: a.id, status: res.status, ...(await res.json().catch(() => ({}))) });
    }
    console.log(JSON.stringify(r, null, 1));
  } else {
    throw new Error('uso: baixar <pasta> [--limite N] [--cliente slug] | enviar <arquivo.json>');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
