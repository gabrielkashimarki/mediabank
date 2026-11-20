// Revisão de peça durante a edição (spec, seção 5b): planos do roteiro, render da versão atual, decisão por plano
// (aprovar, reprovar, trocar), candidatos para troca já filtrados pela regra de não repetir, e as trocas para o projeto puxar.
// Montado na API v2 (chave) e no painel (sessão); `contexto(req)` diz o cliente, quem pede e se pode alterar o banco.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const { conflitos, registrarPlanos, resolverMidia } = require('./usos');
const { buscarVideos } = require('./busca_video');
const { formatarVideo } = require('./rotas_video');

const ESTADOS = ['aprovado', 'reprovado', 'trocar'];
const MARCAS = ['reprovada', 'evitar'];
const arquivoRender = (cliente, peca, versao) => path.join('render', cliente, `${peca}-v${versao}.mp4`);

function rotasPecas(r, { db, dirDados, embedQuery, embedQuadroQuery, contexto, base }) {
  const peca = (cliente, id) => db.prepare('SELECT * FROM pecas WHERE cliente_id = ? AND id = ?').get(cliente, id);
  const ultimas = db.prepare(`SELECT r.* FROM revisoes r WHERE r.id IN (SELECT max(id) FROM revisoes WHERE cliente_id = ? AND peca = ? AND versao = ? GROUP BY plano)`);

  function planosDa(p) {
    const usos = db.prepare(`SELECT u.*, a.titulo, a.caminho_origem, a.aprovacao, a.aprovacao_motivo, a.etiquetas, a.duracao, a.orientacao,
        (SELECT c.id FROM cenas c WHERE c.asset_id = a.id AND c.st_tecnica = 'ok' ORDER BY c.nota_take DESC NULLS LAST, c.ordem LIMIT 1) AS cena,
        (SELECT max(c.nota_take) FROM cenas c WHERE c.asset_id = a.id) AS nota_take
      FROM usos u JOIN assets a ON a.id = u.asset_id WHERE u.cliente_id = ? AND u.peca = ? ORDER BY u.plano`).all(p.cliente_id, p.id);
    const decisao = new Map(ultimas.all(p.cliente_id, p.id, p.versao).map(d => [d.plano, d]));
    const avisos = new Map(conflitos(db, p.cliente_id, p.id, usos.map(u => ({ plano: u.plano, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(u.asset_id) })))
      .map(c => [c.plano, c.motivo]));
    return usos.map(u => {
      const d = decisao.get(u.plano);
      const troca = d?.troca_asset_id ? db.prepare('SELECT id, titulo, caminho_origem FROM assets WHERE id = ?').get(d.troca_asset_id) : null;
      return {
        plano: u.plano, ancora: u.ancora, ini: u.ini, fim: u.fim,
        midia: { id: u.asset_id, chave: (u.caminho_origem || '').replace(`${p.cliente_id}:`, ''), titulo: u.titulo, aprovacao: u.aprovacao, motivo: u.aprovacao_motivo,
          tema: JSON.parse(u.etiquetas || '{}').tema || null, nota_take: u.nota_take, thumb_url: `${base}/midias/${u.asset_id}/thumb.jpg`,
          quadro_url: u.cena ? `${base}/cenas/${u.cena}.jpg` : null },
        aviso: avisos.get(u.plano) || null,
        decisao: d ? { estado: d.estado, motivo: d.motivo, em: d.em, troca: troca && { id: troca.id, titulo: troca.titulo, chave: (troca.caminho_origem || '').replace(`${p.cliente_id}:`, '') } } : null,
      };
    });
  }

  const resumo = p => {
    const planos = planosDa(p);
    return { id: p.id, titulo: p.titulo, peca_tipo: p.peca_tipo, versao: p.versao, situacao: p.situacao, atualizado_em: p.atualizado_em,
      planos: planos.length, revisados: planos.filter(x => x.decisao).length, trocas: planos.filter(x => x.decisao?.estado === 'trocar').length,
      reprovados: planos.filter(x => x.decisao?.estado === 'reprovado').length, render_url: p.render ? `${base}/pecas/${p.id}/render.mp4` : null };
  };

  r.get('/pecas', (req, res) => {
    const { cliente } = contexto(req);
    res.json({ pecas: db.prepare('SELECT * FROM pecas WHERE cliente_id = ? ORDER BY atualizado_em DESC, id').all(cliente).map(resumo) });
  });

  r.get('/pecas/:id', (req, res) => {
    const p = peca(contexto(req).cliente, req.params.id);
    p ? res.json({ ...resumo(p), planos: planosDa(p) }) : res.status(404).json({ erro: 'peça não encontrada' });
  });

  // planos do roteiro: [{plano, midia (id ou chave da importação), ancora, ini, fim}] com os tempos dentro do render
  r.put('/pecas/:id', express.json({ limit: '1mb' }), (req, res) => {
    const { cliente, quem } = contexto(req);
    try { res.json(registrarPlanos(db, cliente, req.params.id, req.body || {}, quem)); }
    catch (e) { res.status(400).json({ erros: [e.message] }); }
  });

  // render novo = versão nova: a revisão recomeça (as decisões antigas ficam no histórico)
  r.put('/pecas/:id/render', async (req, res) => {
    const { cliente } = contexto(req);
    const p = peca(cliente, req.params.id);
    if (!p) return res.status(404).json({ erro: 'mande os planos antes (PUT /pecas/:id)' });
    const versao = p.versao + 1;
    const destino = path.join(dirDados, 'midia', arquivoRender(cliente, p.id, versao));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    try {
      await pipeline(req, fs.createWriteStream(`${destino}.parcial`));
      if (!fs.statSync(`${destino}.parcial`).size) throw new Error('arquivo vazio');
      fs.renameSync(`${destino}.parcial`, destino);
    } catch (e) { fs.rmSync(`${destino}.parcial`, { force: true }); return res.status(400).json({ erro: e.message }); }
    db.prepare("UPDATE pecas SET versao = ?, render = 1, situacao = 'em_revisao', atualizado_em = datetime('now') WHERE cliente_id = ? AND id = ?").run(versao, cliente, p.id);
    res.json({ versao, render_url: `${base}/pecas/${p.id}/render.mp4` });
  });

  r.get('/pecas/:id/render.mp4', (req, res) => {
    const { cliente } = contexto(req);
    const p = peca(cliente, req.params.id);
    const arq = p?.render && path.join(dirDados, 'midia', arquivoRender(cliente, p.id, p.versao));
    arq && fs.existsSync(arq) ? res.sendFile(arq) : res.status(404).end();
  });

  // decisão de um plano. reprovado pode marcar a mídia no banco (reprovada ou evitar, com o motivo) para não voltar;
  // trocar confere a regra de não repetir (forcar: true passa por cima e registra o aviso no motivo)
  r.post('/pecas/:id/planos/:plano/revisao', express.json({ limit: '16kb' }), (req, res) => {
    const { cliente, usuario } = contexto(req);
    const p = peca(cliente, req.params.id);
    const plano = Number(req.params.plano);
    const uso = p && db.prepare('SELECT * FROM usos WHERE cliente_id = ? AND peca = ? AND plano = ?').get(cliente, p.id, plano);
    if (!uso) return res.status(404).json({ erro: 'plano não encontrado' });
    const { estado, motivo = null, troca = null, marcar = null, forcar = false } = req.body || {};
    const motivoTxt = typeof motivo === 'string' ? motivo.trim().slice(0, 500) : '';
    if (!ESTADOS.includes(estado)) return res.status(400).json({ erros: [`estado: ${ESTADOS.join(' | ')}`] });
    if (estado === 'reprovado' && !motivoTxt) return res.status(400).json({ erros: ['reprovar pede o motivo'] });
    if (marcar && (!MARCAS.includes(marcar) || estado !== 'reprovado')) return res.status(400).json({ erros: [`marcar (${MARCAS.join(' | ')}) só ao reprovar`] });
    let trocaId = null, aviso = null;
    if (estado === 'trocar') {
      const a = resolverMidia(db, cliente, troca);
      if (!a) return res.status(400).json({ erros: ['troca: mídia não encontrada'] });
      const outros = db.prepare('SELECT plano, asset_id FROM usos WHERE cliente_id = ? AND peca = ? AND plano != ?').all(cliente, p.id, plano)
        .map(u => ({ plano: u.plano, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(u.asset_id) }));
      aviso = conflitos(db, cliente, p.id, [...outros, { plano, asset: a }], { perto: Infinity }).find(c => c.plano === plano).motivo;
      if (aviso && !forcar) return res.status(409).json({ erro: aviso });
      trocaId = a.id;
    }
    db.transaction(() => {
      db.prepare('INSERT INTO revisoes (cliente_id, peca, versao, plano, estado, motivo, troca_asset_id, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(cliente, p.id, p.versao, plano, estado, [motivoTxt, aviso && `(forçado: ${aviso})`].filter(Boolean).join(' ') || null, trocaId, usuario ?? null);
      if (marcar) db.prepare('UPDATE assets SET aprovacao = ?, aprovacao_motivo = ? WHERE id = ? AND cliente_id = ?').run(marcar, motivoTxt, uso.asset_id, cliente);
      // todos os planos decididos e nenhum reprovado sem troca: peça aprovada
      const planos = planosDa(p);
      const fechada = planos.length && planos.every(x => x.decisao && x.decisao.estado !== 'reprovado');
      db.prepare(`UPDATE pecas SET situacao = ?, atualizado_em = datetime('now') WHERE cliente_id = ? AND id = ?`)
        .run(fechada ? 'aprovada' : p.render ? 'em_revisao' : p.situacao, cliente, p.id);
    })();
    res.json({ ok: true, ...resumo(peca(cliente, p.id)) });
  });

  // candidatos para o plano: a frase pedida ou a âncora, sem o que quebraria a regra nesta peça
  r.get('/pecas/:id/planos/:plano/candidatos', async (req, res, next) => {
    try {
      const ctx = contexto(req);
      const p = peca(ctx.cliente, req.params.id);
      const uso = p && db.prepare('SELECT u.*, a.etiquetas FROM usos u JOIN assets a ON a.id = u.asset_id WHERE u.cliente_id = ? AND u.peca = ? AND u.plano = ?')
        .get(ctx.cliente, p.id, Number(req.params.plano));
      if (!uso) return res.status(404).json({ erro: 'plano não encontrado' });
      const q = String(req.query.q || '').trim() || [uso.ancora, JSON.parse(uso.etiquetas || '{}').tema].filter(Boolean).join(' ');
      const videos = await buscarVideos(db, { q, limite: 40, cliente: ctx.cliente, externo: 'acervo' }, { embedQuery, embedQuadroQuery });
      const outros = db.prepare('SELECT plano, asset_id FROM usos WHERE cliente_id = ? AND peca = ? AND plano != ?').all(ctx.cliente, p.id, uso.plano)
        .map(u => ({ plano: u.plano, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(u.asset_id) }));
      const livres = [];
      for (const v of videos) {
        if (v.id === uso.asset_id) continue;
        const motivo = conflitos(db, ctx.cliente, p.id, [...outros, { plano: uso.plano, asset: v }], { perto: Infinity }).find(c => c.plano === uso.plano).motivo;
        if (!motivo) livres.push({ ...formatarVideo(v, base), chave: (v.caminho_origem || '').replace(`${ctx.cliente}:`, ''), evitar: v.aprovacao === 'evitar' ? v.aprovacao_motivo || 'evitar' : null });
        if (livres.length >= Math.min(Number(req.query.limite) || 12, 30)) break;
      }
      res.json({ consulta: q, candidatos: livres });
    } catch (e) { next(e); }
  });

  // o que o projeto de edição precisa aplicar: planos com troca decidida na versão atual
  r.get('/pecas/:id/trocas', (req, res) => {
    const p = peca(contexto(req).cliente, req.params.id);
    if (!p) return res.status(404).json({ erro: 'peça não encontrada' });
    const trocas = planosDa(p).filter(x => x.decisao?.estado === 'trocar')
      .map(x => ({ plano: x.plano, ancora: x.ancora, de: x.midia.chave, para: x.decisao.troca.chave, para_id: x.decisao.troca.id, original_url: `${base}/midias/${x.decisao.troca.id}/original` }));
    res.json({ peca: p.id, versao: p.versao, situacao: p.situacao, trocas, reprovados: planosDa(p).filter(x => x.decisao?.estado === 'reprovado').map(x => ({ plano: x.plano, motivo: x.decisao.motivo })) });
  });

  // confere uma lista sem gravar (antes do render)
  r.post('/usos/conferir', express.json({ limit: '1mb' }), (req, res) => {
    const { cliente } = contexto(req);
    const { peca: id, planos } = req.body || {};
    if (typeof id !== 'string' || !Array.isArray(planos)) return res.status(400).json({ erros: ['use {peca, planos: [{plano, midia}]}'] });
    const propostos = planos.map(x => ({ plano: x.plano, asset: resolverMidia(db, cliente, x.midia) }));
    res.json({ conflitos: conflitos(db, cliente, id, propostos).filter(c => c.motivo) });
  });

  // original do clipe importado (o projeto de edição baixa a troca escolhida)
  r.get('/midias/:id/original', (req, res) => {
    const a = db.prepare('SELECT arquivo FROM assets WHERE id = ? AND cliente_id = ?').get(req.params.id, contexto(req).cliente);
    a?.arquivo ? res.download(path.join(dirDados, a.arquivo), `${req.params.id}.mp4`) : res.status(404).end();
  });
}

module.exports = { rotasPecas };
