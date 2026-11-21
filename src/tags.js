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

module.exports = { normalizarTags, MAX_TAGS };
