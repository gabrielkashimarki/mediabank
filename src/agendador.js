const { sincronizar } = require('./sync');
const { processar, processarVideos, etapaTecnica } = require('./pipeline');
const { recalcular } = require('./curadoria');
const { recalcularTakes } = require('./takes');
const { preencherPastas, classificarPastas, sincronizarColecoesDeEvento } = require('./pastas');
const { gerarCatalogo } = require('./catalogo');

// Ciclo do servidor: traz o que chegou no Drive, descreve com a IA e recalcula a curadoria.
// Estética e CLIP ficam com o trabalhador do Mac (py/sinais.py --remoto).
async function ciclo(cfg, { limiteSync = 200, limiteIa = 50 } = {}) {
  const r = {};
  if (cfg.drive && process.env.SYNC_AUTOMATICO === '1') r.sync = await sincronizar(cfg.db, cfg.drive, { dirDados: cfg.dirDados, limite: limiteSync, videos: process.env.SYNC_VIDEO === '1' });

  if (cfg.drive) {
    try {
      r.pastas = await preencherPastas(cfg.db, cfg.drive, { driveRaiz: process.env.DRIVE_ID });
    } catch (e) {
      r.pastas = { erro: e.message };
    }
  }

  if (cfg.jev) {
    try {
      r.classificacao = await classificarPastas(cfg.db, cfg.jev);
    } catch (e) {
      r.classificacao = { erro: e.message };
    }
  }

  if (cfg.drive || cfg.jev) {
    try {
      r.colecoes = await sincronizarColecoesDeEvento(cfg.db);
    } catch (e) {
      r.colecoes = { erro: e.message };
    }
  }

  if (cfg.cliente && process.env.IA_AUTOMATICA === '1') r.pipeline = await processar(cfg.db, { ...cfg, limite: limiteIa, concorrencia: Number(process.env.IA_CONCORRENCIA || 4) });
  if (cfg.cliente && process.env.IA_VIDEO === '1') {
    try { r.videos = await processarVideos(cfg.db, { ...cfg, limite: limiteIa, concorrencia: Number(process.env.IA_CONCORRENCIA || 4) }); }
    catch (e) { r.videos = { erro: e.message }; }
  }
  else r.tecnica = await etapaTecnica(cfg.db, cfg); // técnica é local e grátis: roda mesmo com a IA desligada

  if (cfg.cliente) {
    try {
      r.catalogo = await gerarCatalogo(cfg.db, {
        cliente: cfg.cliente,
        modelo: process.env.MODELO_CATALOGO || 'google/gemini-3.8-flash',
      });
    } catch (e) {
      r.catalogo = { erro: e.message };
    }
  }

  r.curadoria = recalcular(cfg.db).tiers;
  // percentil da nota de take é por cliente; sem vídeo, o ciclo responde igual a antes da fase 2
  const takes = Object.fromEntries(cfg.db.prepare('SELECT id FROM clientes').all().map(c => [c.id, recalcularTakes(cfg.db, c.id)]).filter(([, t]) => t.cenas));
  if (Object.keys(takes).length) r.takes = takes;
  return r;
}

// ponytail: agendador em memória, um processo só; se houver mais réplicas, trocar por trava no banco
function iniciar(cfg, { minutos = 15, ...limites } = {}) {
  let rodando = false;
  const rodar = async () => {
    if (rodando) return;
    rodando = true;
    try { console.log(new Date().toISOString(), 'ciclo', JSON.stringify(await ciclo(cfg, limites))); }
    catch (e) { console.error(new Date().toISOString(), 'ciclo falhou:', e.message); }
    finally { rodando = false; }
  };
  setTimeout(rodar, 30_000);
  return setInterval(rodar, minutos * 60_000);
}

module.exports = { ciclo, iniciar };
