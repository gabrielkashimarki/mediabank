const { carregar } = require('./src/config');
const { criarApp } = require('./src/api');
const { iniciar } = require('./src/agendador');

const cfg = carregar();
const porta = Number(process.env.PORT || 3000);
criarApp(cfg).listen(porta, () => console.log(`MediaBank na porta ${porta}`));

// na VPS: sync do Drive, IA e curadoria a cada 15 minutos
if (process.env.AGENDADOR === '1') {
  iniciar(cfg, {
    minutos: Number(process.env.AGENDADOR_MINUTOS || 15),
    limiteSync: Number(process.env.SYNC_LIMITE || 200),
    limiteIa: Number(process.env.IA_LIMITE || 50),
  });
}
