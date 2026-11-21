// Tags: palavras-chave curtas que uma pessoa digitaria para achar a mídia (como no Pixabay e no Pexels).
// Guardadas em minúsculas, sem espaço sobrando, sem repetir; até 15 por mídia.
const MAX_TAGS = 15;

function normalizarTags(lista) {
  if (!Array.isArray(lista)) return [];
  const vistas = new Set();
  for (const t of lista) {
    if (typeof t !== 'string') continue;
    const n = t.toLowerCase().replace(/["'#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (n) vistas.add(n);
    if (vistas.size >= MAX_TAGS) break;
  }
  return [...vistas];
}

// tags do vídeo: as mais frequentes entre as cenas (empate: a que apareceu primeiro); sem tag de cena, fica a do vídeo
function tagsDoVideo(tagsDasCenas, tagsDoVideoTodo = []) {
  const conta = new Map();
  for (const t of tagsDasCenas.flat()) conta.set(t, (conta.get(t) || 0) + 1);
  if (!conta.size) return normalizarTags(tagsDoVideoTodo);
  return [...conta.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TAGS).map(([t]) => t);
}

module.exports = { normalizarTags, tagsDoVideo, MAX_TAGS };
