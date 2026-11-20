# MediaBank

Banco de fotos e vídeos de um acervo no Google Drive. O MediaBank lê o Drive (ou uma pasta local), descreve cada
foto e cada cena de vídeo com IA dentro de um vocabulário fechado por cliente, guarda tudo num SQLite com busca por
significado e entrega o material por um painel web, por uma API HTTP, por um servidor MCP (para o Claude e outros
agentes) e por um plugin do get-brolls.

Atende mais de um cliente na mesma instância. O repositório vem com dois clientes fictícios, `exemplo` (Casa Exemplo)
e `outro` (Marca Exemplo), em `src/vocabularios/`.

## Requisitos

- Node 22 ou mais novo
- Chave do OpenRouter para a IA e o embedding
- Opcional: cliente OAuth do Google (Drive), SMTP (convites e senha), Python 3.12 com `uv` e `ffmpeg` para o
  trabalhador de vídeo (`py/`)

## Instalação rápida

1. `npm ci`
2. `cp .env.example .env` e preencha pelo menos `OPENROUTER_API_KEY`
3. Crie o primeiro usuário (a senha entra pelo stdin): `read -rs SENHA && printf %s "$SENHA" | node scripts/criar-usuario.js voce@exemplo.com "Seu Nome" --admin`
4. Traga as fotos: `node scripts/importar-pasta.js <pasta>` (ou configure o Drive com `node scripts/autorizar-drive.js`)
5. `npm start` e abra `http://localhost:3000`

Testes: `npm test`.

Como tudo funciona (pipeline, clientes, chaves, API, MCP, plugin e deploy): [docs/COMO-FUNCIONA.md](docs/COMO-FUNCIONA.md).
