const BASE = 'https://openrouter.ai/api/v1';

function criarCliente({ chave, fetch = globalThis.fetch }) {
  async function post(rota, corpo) {
    const r = await fetch(`${BASE}${rota}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(`OpenRouter ${r.status}: ${json.error?.message || 'sem detalhe'}`);
    return json;
  }

  return {
    // devolve o texto da primeira resposta
    async chat(modelo, mensagens, extra = {}) {
      const j = await post('/chat/completions', { model: modelo, messages: mensagens, ...extra });
      const escolha = j.choices[0];
      if (!escolha.message.content) throw new Error(`OpenRouter sem conteúdo (${escolha.finish_reason})`);
      return escolha.message.content;
    },
    // devolve um Float32Array por entrada, na mesma ordem; a entrada é texto ou {content: [...]} com imagem
    async embed(modelo, textos, extra = {}) {
      const j = await post('/embeddings', { model: modelo, input: textos, ...extra });
      return j.data.sort((a, b) => a.index - b.index).map(d => Float32Array.from(d.embedding));
    },
  };
}

module.exports = { criarCliente };
