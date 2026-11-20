// Uso: DRIVE_CONTA=<e-mail> OP_COFRE=<cofre> op run --env-file .env -- node scripts/autorizar-drive.js
// Imprime o link de consentimento do Google para a conta DRIVE_CONTA (só leitura do Drive).
// Depois de consentir, o navegador volta para /oauth/callback no BASE_URL. O operador cola a URL
// inteira no terminal e o script troca o code pelo token, confere o e-mail e guarda no 1Password
// (cofre OP_COFRE, item "MediaBank Drive <conta>"). O token nunca é impresso.
// Pré-requisito no Google Cloud (cliente OAuth do .env): redirect URI <BASE_URL>/oauth/callback e app "In production".
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const REDIRECT = process.env.OAUTH_REDIRECT || `${(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')}/oauth/callback`;
const { OP_COFRE: COFRE, DRIVE_CONTA: CONTA } = process.env;
if (!COFRE || !CONTA) { console.error('faltam DRIVE_CONTA (e-mail que vai autorizar) e OP_COFRE (cofre do 1Password)'); process.exit(1); }
const ITEM = `MediaBank Drive ${CONTA}`;
const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) { console.error('faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (rodar com op run)'); process.exit(1); }

const estado = crypto.randomBytes(16).toString('hex');
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', access_type: 'offline', prompt: 'consent',
  scope: 'https://www.googleapis.com/auth/drive.readonly', login_hint: CONTA, state: estado,
});

function guardar(refreshToken, email) {
  // modelo em arquivo temporário (0600) para o token não passar pela linha de comando
  const modelo = path.join(os.tmpdir(), `mb-op-${crypto.randomUUID()}.json`);
  fs.writeFileSync(modelo, JSON.stringify({
    title: ITEM, category: 'API_CREDENTIAL',
    fields: [
      { id: 'credential', label: 'credential', type: 'CONCEALED', value: refreshToken },
      { id: 'conta', label: 'conta', type: 'STRING', value: email },
      { id: 'client_id', label: 'client_id', type: 'STRING', value: clientId },
    ],
  }), { mode: 0o600 });
  try { execFileSync('op', ['item', 'create', '--vault', COFRE, '--template', modelo], { stdio: 'ignore' }); }
  finally { fs.rmSync(modelo, { force: true }); }
}

console.log(`Abra no navegador, logado como ${CONTA}:\n\n${url}\n`);
console.log('Depois de autorizar, copie o endereço completo da página de volta e cole aqui:');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (linha) => {
  rl.close();
  try {
    const u = new URL(linha.trim());
    if (u.searchParams.get('state') !== estado) throw new Error('state não confere');
    if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error'));
    const code = u.searchParams.get('code');
    if (!code) throw new Error('URL sem parâmetro code');
    const t = await (await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    })).json();
    if (!t.refresh_token) throw new Error(`Google não devolveu refresh token: ${t.error || 'sem detalhe'}`);
    const sobre = await (await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const email = sobre.user?.emailAddress;
    if (!email) throw new Error('drive/v3/about não devolveu o e-mail da conta');
    // verifica se já existe item no 1Password
    try { execFileSync('op', ['item', 'get', ITEM, '--vault', COFRE], { stdio: 'ignore' }); throw new Error('já existe um item; apague ou renomeie antes de autorizar de novo'); } catch (e) { if (e.message.includes('já existe')) throw e; /* item não existe: ok */ }
    guardar(t.refresh_token, email);
    console.log(`refresh token de ${email} guardado no 1Password: op://${COFRE}/${ITEM}/credential`);
    if (email !== CONTA) console.log(`ATENÇÃO: a conta autorizada não é a ${CONTA}`);
  } catch (e) {
    console.error('falhou:', e.message);
    process.exitCode = 1;
  }
});
