// cliente minimo da API SystemOne da TypeSafe (Jev)
// fetch com timeout (3 s por padrão) via AbortController, Bearer TYPESAFE_API_KEY,
// retry com backoff em 429 e 529 (ate 2 novas tentativas: 300 ms e 900 ms),
// erro claro com status

const URL_JEV = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 3000;
const BACKOFF = [300, 900];

async function consultarJev({ chave, fetchFn, timeoutMs = TIMEOUT_MS }, corpo) {
  const fn = fetchFn || fetch;
  let ultima;
  for (let tentativa = 0; tentativa <= BACKOFF.length; tentativa++) {
    if (tentativa > 0) await new Promise(r => setTimeout(r, BACKOFF[tentativa - 1]));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fn(URL_JEV, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${chave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      ultima = res;
      if (res.status !== 429 && res.status !== 529) {
        const texto = await res.text();
        throw new Error(`Jev ${res.status}: ${texto.slice(0, 200)}`);
      }
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Jev timeout');
      if (e.message.startsWith('Jev ')) throw e;
      if (tentativa === BACKOFF.length) throw e;
      ultima = e;
    }
  }
  const status = ultima?.status || 'erro';
  throw new Error(`Jev ${status}: esgotou tentativas`);
}

module.exports = { consultarJev };
