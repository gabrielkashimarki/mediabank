// Fase 0 da spec multi-cliente: quanto vídeo há no Drive, só com o que o Drive já informa (nada é baixado).

const MB = 1024 * 1024;
const GB = 1024 * MB;
// prévia em 540p, H.264 ~1,2 Mbit/s, sem áudio: ~9 MB por minuto (spec, seção 2)
const MB_PREVIA_MIN = 9;
const SEG_PREVIA_CURTA = 20;
// pôster (thumb + preview), tira e quadros-chave de cena: ~60 KB cada, até 60 cenas
const KB_POR_QUADRO = 60;
const MAX_CENAS = 60;

const faixaDuracao = s => (s == null ? 'sem metadado' : s < 15 ? '< 15 s' : s < 60 ? '15 s a 1 min' : s < 300 ? '1 a 5 min' : s < 1800 ? '5 a 30 min' : '30 min ou mais');
const orientacao = (w, h) => (!w || !h ? 'sem metadado' : w > h ? 'horizontal' : w < h ? 'vertical' : 'quadrado');
const resolucao = (w, h) => {
  const menor = Math.min(w || 0, h || 0);
  return !menor ? 'sem metadado' : menor >= 2160 ? '4K' : menor >= 1080 ? '1080p' : menor >= 720 ? '720p' : 'menor que 720p';
};
const conta = (obj, k, bytes, seg) => {
  const c = (obj[k] ||= { n: 0, gb: 0, horas: 0 });
  c.n++; c.gb += bytes / GB; c.horas += seg / 3600;
};
const arredondar = obj => Object.fromEntries(Object.entries(obj)
  .sort((a, b) => b[1].n - a[1].n)
  .map(([k, v]) => [k, { n: v.n, gb: +v.gb.toFixed(2), horas: +v.horas.toFixed(2) }]));

// arquivos: iterável (assíncrono ou não) de arquivos do Drive com videoMediaMetadata
async function medirVideos(arquivos) {
  const r = { n: 0, bytes: 0, segundos: 0, sem_metadado: 0, sem_md5: 0, por_tipo: {}, por_ano: {}, por_duracao: {}, por_orientacao: {}, por_resolucao: {}, por_pasta: {} };
  const lista = [];
  const md5s = new Map();
  for await (const f of arquivos) {
    const bytes = Number(f.size) || 0;
    const v = f.videoMediaMetadata || {};
    const seg = v.durationMillis != null ? Number(v.durationMillis) / 1000 : null;
    r.n++; r.bytes += bytes; r.segundos += seg || 0;
    if (seg == null) r.sem_metadado++;
    if (!f.md5Checksum) r.sem_md5++;
    else md5s.set(f.md5Checksum, (md5s.get(f.md5Checksum) || 0) + 1);
    conta(r.por_tipo, f.mimeType || '?', bytes, seg || 0);
    conta(r.por_ano, (f.createdTime || '?').slice(0, 4), bytes, seg || 0);
    conta(r.por_duracao, faixaDuracao(seg), bytes, seg || 0);
    conta(r.por_orientacao, orientacao(v.width, v.height), bytes, seg || 0);
    conta(r.por_resolucao, resolucao(v.width, v.height), bytes, seg || 0);
    conta(r.por_pasta, f.parents?.[0] || '?', bytes, seg || 0);
    lista.push({ id: f.id, md5: f.md5Checksum || null, nome: f.name, mb: +(bytes / MB).toFixed(1), seg, w: v.width ?? null, h: v.height ?? null, pasta: f.parents?.[0] || null });
  }
  const repetidos = [...md5s.values()].filter(n => n > 1);
  // o sync pula md5 repetido e arquivo vazio: a previsão de disco vale para o que de fato entra
  const vistos = new Set();
  const unicos = lista.filter(l => l.mb > 0 && !(l.md5 && vistos.has(l.md5)) && (l.md5 ? vistos.add(l.md5) : true));
  const segUnicos = unicos.reduce((s, l) => s + (l.seg || 0), 0);
  const cenasPorVideo = l => (l.seg == null ? 1 : Math.min(MAX_CENAS, Math.max(1, Math.round(l.seg / 8))));
  const quadros = unicos.reduce((s, l) => s + 3 + cenasPorVideo(l), 0); // thumb, preview, tira + 1 por cena
  return {
    n: r.n,
    gb: +(r.bytes / GB).toFixed(2),
    horas: +(r.segundos / 3600).toFixed(2),
    sem_metadado: r.sem_metadado,
    sem_md5: r.sem_md5,
    vazios: lista.filter(l => l.mb === 0).length,
    md5_repetidos: { grupos: repetidos.length, arquivos_a_mais: repetidos.reduce((s, n) => s + n - 1, 0) },
    unicos: { n: unicos.length, gb: +(unicos.reduce((s, l) => s + l.mb, 0) / 1024).toFixed(2), horas: +(segUnicos / 3600).toFixed(2) },
    previsao_disco_gb: {
      quadros: +(quadros * KB_POR_QUADRO / 1024 / 1024).toFixed(2),
      previa_inteira: +(segUnicos / 60 * MB_PREVIA_MIN / 1024).toFixed(2),
      previa_20s: +(unicos.reduce((s, l) => s + Math.min(l.seg ?? SEG_PREVIA_CURTA, SEG_PREVIA_CURTA), 0) / 60 * MB_PREVIA_MIN / 1024).toFixed(2),
    },
    por_tipo: arredondar(r.por_tipo),
    por_ano: arredondar(r.por_ano),
    por_duracao: arredondar(r.por_duracao),
    por_orientacao: arredondar(r.por_orientacao),
    por_resolucao: arredondar(r.por_resolucao),
    por_pasta: arredondar(r.por_pasta),
    maiores: [...lista].sort((a, b) => b.mb - a.mb).slice(0, 15),
    mais_longos: [...lista].filter(l => l.seg != null).sort((a, b) => b.seg - a.seg).slice(0, 15),
    lista,
  };
}

module.exports = { medirVideos, faixaDuracao, orientacao, resolucao };
