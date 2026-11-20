// Uso: node scripts/criar-chave.js <nome> [--cliente exemplo] [--escopo "v1 mcp"] | op item create ... (a chave sai só no stdout, uma vez)
// Sem --escopo vale a regra das chaves antigas: 'lote' é do trabalhador, as outras leem a API v1 e o MCP.
const { carregar } = require('../src/config');
const { criarChave } = require('../src/chaves');

const opcao = n => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
const nome = process.argv[2];
if (!nome || nome.startsWith('--')) { console.error('informe o nome (ex.: site)'); process.exit(1); }
try {
  process.stdout.write(criarChave(carregar().db, nome, { cliente: opcao('cliente'), escopo: opcao('escopo') }));
} catch (e) { console.error(e.message); process.exit(1); }
