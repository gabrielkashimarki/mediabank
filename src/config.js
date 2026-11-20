const path = require('node:path');
const { abrirBanco } = require('./db');
const { criarCliente } = require('./openrouter');
const { criarDrive } = require('./drive');
const { consultarJev } = require('./jev');
const { criarEmail } = require('./email');

// monta banco e cliente a partir do ambiente (rodar com `op run --env-file .env`)
function carregar() {
  const dirDados = path.resolve(process.env.DIR_DADOS || 'dados');
  require('node:fs').mkdirSync(dirDados, { recursive: true });
  const db = abrirBanco(path.join(dirDados, 'mediabank.db'));
  const cliente = process.env.OPENROUTER_API_KEY ? criarCliente({ chave: process.env.OPENROUTER_API_KEY }) : null;
  const modeloDescricao = process.env.MODELO_DESCRICAO || 'google/gemini-3.8-flash';
  const modeloEmbedding = process.env.MODELO_EMBEDDING || 'openai/text-embedding-3-small';
  const embedQuery = cliente ? async q => (await cliente.embed(modeloEmbedding, [q]))[0] : null;
  // vetor de imagem dos quadros de vídeo e da frase da busca, no mesmo espaço (fase 0: gemini-embedding-2 venceu o CLIP)
  const modeloQuadro = process.env.MODELO_QUADRO || 'google/gemini-embedding-2';
  const dimQuadro = Number(process.env.DIM_QUADRO || 768);
  const { ajustar } = require('./video');
  const embedQuadroQuery = cliente ? async q => ajustar((await cliente.embed(modeloQuadro, [q], { dimensions: dimQuadro }))[0], dimQuadro) : null;
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  const drive = clientId && clientSecret && refreshToken ? criarDrive({ clientId, clientSecret, refreshToken, driveId: process.env.DRIVE_ID || null }) : null;
  const jev = process.env.TYPESAFE_API_KEY ? (corpo, opcoes = {}) => consultarJev({ chave: process.env.TYPESAFE_API_KEY, ...opcoes }, corpo) : null;
  const { SMTP_HOST, SMTP_PORTA, SMTP_USUARIO, SMTP_SENHA, SMTP_REMETENTE } = process.env;
  const email = SMTP_HOST ? criarEmail({
    host: SMTP_HOST,
    porta: Number(SMTP_PORTA || 465),
    usuario: SMTP_USUARIO,
    senha: SMTP_SENHA,
    remetente: SMTP_REMETENTE,
  }) : null;
  return { db, dirDados, cliente, modeloDescricao, modeloEmbedding, embedQuery, modeloQuadro, dimQuadro, embedQuadroQuery, drive, jev, email };
}

module.exports = { carregar };
