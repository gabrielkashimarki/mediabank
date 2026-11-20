// Uso: op run --env-file .env -- node scripts/medir-videos.js [saida.json]
// Fase 0: mede os vídeos do Drive (quantos, GB, horas, formatos, os maiores) e a previsão de disco da prévia.
// Só lê a listagem do Drive: não baixa vídeo, não abre o banco, não grava nada além do JSON de saída.
const fs = require('node:fs');
const { criarDrive } = require('../src/drive');
const { medirVideos } = require('../src/medicao');

async function main() {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('faltam GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN (rodar com op run)');
  const drive = criarDrive({ clientId, clientSecret, refreshToken, driveId: process.env.DRIVE_ID || null });
  const m = await medirVideos(drive.videos());

  // nome e caminho das 15 pastas com mais horas (uma chamada por pasta)
  const pastas = Object.entries(m.por_pasta).sort((a, b) => b[1].horas - a[1].horas).slice(0, 15);
  m.pastas_com_mais_horas = [];
  for (const [id, v] of pastas) {
    let nome = id;
    try { nome = (await drive.arquivo(id, 'name')).name; } catch { /* pasta sem acesso: fica o id */ }
    m.pastas_com_mais_horas.push({ id, nome, ...v });
  }

  const saida = process.argv[2];
  if (saida) fs.writeFileSync(saida, JSON.stringify(m, null, 1));
  const { lista, por_pasta, ...resumo } = m;
  console.log(JSON.stringify(resumo, null, 1));
}

main().catch(e => { console.error(e.message); process.exit(1); });
