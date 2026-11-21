const { normalizarTags } = require('./tags');
const { nome, contexto, ESPACOS, TIPOS_EVENTO, LISTAS, DESTINOS, GASTRONOMIA, localDe } = require('./vocabulario');

const lista = xs => xs.map(x => `"${x}"`).join(', ');

function montarPrompt() {
  const listas = Object.entries(LISTAS).map(([campo, xs]) => `- ${campo}: ${lista(xs)}`).join('\n');
  return `Você cataloga o acervo de fotos da ${nome} (${contexto}).
Analise a foto e responda APENAS com um objeto JSON com estes campos:

- titulo: até 60 caracteres
- descricao: 120 a 200 palavras, concreta (espaço, decoração, luz, composição, clima, o que está em foco)
- legenda: uma frase para rede social, sem hashtag
- alt: texto alternativo objetivo, até 125 caracteres
- espaco: um de ${lista(ESPACOS)}
- tipo_evento: um de ${lista(Object.keys(TIPOS_EVENTO))} ou null se não der para saber
${listas}
- tem_crianca: true/false (na dúvida, true)
- gastronomia: só quando tipo for Gastronomia ou Bar, um de ${lista(GASTRONOMIA)} (Preparo de alimentos = cozinha, cortes, panelas; Empratamento = montagem e finalização do prato; Estação ao vivo = chef preparando na frente dos convidados); senão null
- tem_pessoa: true/false, há alguma pessoa na foto, mesmo de costas, de longe, desfocada ou só parte do corpo (mão servindo, silhueta)
- qtd_rostos: número de rostos visíveis
- rostos_identificaveis: true/false (na dúvida, true)
- marca_terceiro: true/false, logo ou marca de outra empresa visível
- tem_texto: true/false, só texto, arte gráfica ou marca d'água SOBREPOSTOS à foto (edição, post de rede social); telão, placa, banner, cardápio ou letreiro que fazem parte da cena não contam (false)
- indesejados: lista de problemas visíveis (lixo, fio, extintor, pessoa cortada, equipe de serviço...), [] se nenhum
- capacidade_estimada: número de convidados que o espaço montado comporta, ou null
- tags: 8 a 15 palavras-chave em português, minúsculas, 1 a 3 palavras cada, o que alguém digitaria para achar esta mídia: objetos, ação, clima, cores, e sinônimos comuns (ex.: "taça", "espumante", "champanhe", "brinde", "noite", "luz quente")
- perguntas_que_responde: 2 a 5 perguntas de cliente que esta foto responde (ex.: "Como fica o deck à noite?")
- espaco_para_texto: true/false, área limpa para colocar texto
- decoracao: { "estilo": texto curto, "cores": até 5 cores, "flores": true/false, "iluminacao_cenica": true/false }
- qualidade: objeto com seis notas inteiras de 1 a 10, julgando a foto como material profissional para vender o espaço:
  { "assunto": há um assunto principal claro, que o olho encontra na hora,
    "enquadramento": nada importante cortado (mesa, pessoa, prato, arquitetura) e sem sobra morta no quadro,
    "composicao": equilíbrio, linhas, uso do espaço,
    "luz": exposição e qualidade da luz no assunto,
    "limpeza": cena sem distração (equipe de serviço, fios, lixo, bagunça, gente cortada ao fundo),
    "momento": clima, emoção ou cena que vende o evento ou o lugar }
  Régua (seja severo, use a escala inteira):
  3 = foto de registro: sem assunto, cortes feios, metade do quadro sem interesse; não serve para vender.
  5 = aceitável para uso interno, com defeitos visíveis.
  7 = boa, publicável com pequenos defeitos.
  9 = excelente, de portfólio.
  Exemplo 3: mesa de buffet cortada nas laterais, metade de baixo ocupada por prateleira escura, réchaud de inox chamando mais atenção que a comida, equipe de serviço ao fundo.
  Exemplo 8: mesa posta vista de cima, simétrica, flores e velas, luz quente uniforme, nada cortado, nenhuma distração.
  O que vende a ${nome} é o espaço, a decoração, a gastronomia e o clima do evento. Foto de convidados posando ou sorrindo para a câmera, em que as pessoas ocupam o quadro e o lugar quase não aparece, é registro social do evento, não material de venda: assunto e momento no máximo 4, destinos_sugeridos vazio, veredito dizendo que é registro de convidados. Exceção: pessoas integradas à cena que mostram o evento acontecendo (pista cheia, brinde com o salão decorado, noivos com o espaço ao fundo).
  Exemplo 4: três convidadas sorrindo para a câmera na entrada, nítidas e bem iluminadas, o espaço só aparece como fundo desfocado.
- problemas: lista de até 5 problemas de qualidade, cada um em até 8 palavras (ex.: "mesa cortada nas laterais", "sem assunto principal"), [] se nenhum
- veredito: uma frase de até 12 palavras dizendo para que a foto serve (ex.: "não usar para venda; só registro do buffet")
- destinos_sugeridos: subconjunto de ${lista(DESTINOS)} (prop = proposta de locação, social = rede social, site = site)

Use exatamente os valores das listas, com a mesma grafia.`;
}

const erroSe = (cond, msg, erros) => { if (cond) erros.push(msg); };
const bool = v => typeof v === 'boolean';

const CRITERIOS = ['assunto', 'enquadramento', 'composicao', 'luz', 'limpeza', 'momento'];
const PESOS_QUALIDADE = { assunto: 25, enquadramento: 20, composicao: 15, luz: 15, limpeza: 15, momento: 10 };

// Confere a resposta contra o vocabulário e devolve as colunas prontas para o banco.
// Campo de proteção ausente vira o valor mais restritivo.
// O modelo às vezes troca tipo e direção da luz ("Mista quente" na direção, "Difusa" no tipo).
// Valor que pertence ao outro campo vai para lá; o que sobrar inválido vira null em vez de perder a foto.
function normalizarLuz(r) {
  const { luz_tipo: tipos, luz_direcao: direcoes } = LISTAS;
  if (direcoes.includes(r.luz_tipo) && !direcoes.includes(r.luz_direcao)) [r.luz_tipo, r.luz_direcao] = [r.luz_direcao, r.luz_tipo];
  if (tipos.includes(r.luz_direcao) && !tipos.includes(r.luz_tipo)) [r.luz_tipo, r.luz_direcao] = [r.luz_direcao, r.luz_tipo];
  if (!tipos.includes(r.luz_tipo)) r.luz_tipo = null;
  if (!direcoes.includes(r.luz_direcao)) r.luz_direcao = null;
}

function validarAnalise(r) {
  const erros = [];
  normalizarLuz(r);
  erroSe(typeof r.titulo !== 'string' || !r.titulo, 'titulo', erros);
  erroSe(typeof r.descricao !== 'string' || r.descricao.length < 200, 'descricao', erros);
  erroSe(!ESPACOS.includes(r.espaco), `espaco: ${r.espaco}`, erros);
  erroSe(r.tipo_evento != null && !(r.tipo_evento in TIPOS_EVENTO), `tipo_evento: ${r.tipo_evento}`, erros);
  for (const [campo, xs] of Object.entries(LISTAS)) erroSe(!xs.includes(r[campo]) && !(campo.startsWith('luz_') && r[campo] === null), `${campo}: ${r[campo]}`, erros);
  // validação de qualidade
  const q = r.qualidade && typeof r.qualidade === 'object' ? r.qualidade : {};
  for (const c of CRITERIOS) {
    const v = q[c];
    erroSe(!Number.isInteger(v) || v < 1 || v > 10, `qualidade: ${c}`, erros);
  }
  const destinos = Array.isArray(r.destinos_sugeridos) ? r.destinos_sugeridos : [];
  erroSe(destinos.some(d => !DESTINOS.includes(d)), `destinos_sugeridos: ${destinos}`, erros);
  if (erros.length) return { ok: false, erros };

  // problemas: lista de textos, corta em 5
  let problemas = Array.isArray(r.problemas) && r.problemas.every(p => typeof p === 'string') ? r.problemas : [];
  problemas = problemas.slice(0, 5);
  // veredito: texto, corta em 150
  let veredito = typeof r.veredito === 'string' ? r.veredito.slice(0, 150) : null;

  // nota_rubrica = média ponderada
  let soma = 0, pesoTotal = 0;
  for (const c of CRITERIOS) { soma += q[c] * PESOS_QUALIDADE[c]; pesoTotal += PESOS_QUALIDADE[c]; }
  const nota_rubrica = Math.round(soma / pesoTotal * 10) / 10;

  const b = v => (v ? 1 : 0);
  return {
    ok: true,
    campos: {
      titulo: r.titulo.slice(0, 60),
      descricao: r.descricao,
      legenda: r.legenda ?? null,
      alt: r.alt ?? null,
      espaco: r.espaco,
      local: localDe(r.espaco),
      tipo_evento: r.tipo_evento ?? null,
      ...Object.fromEntries(Object.keys(LISTAS).map(c => [c, r[c]])),
      tem_crianca: bool(r.tem_crianca) ? b(r.tem_crianca) : 1,
      tem_pessoa: bool(r.tem_pessoa) ? b(r.tem_pessoa) : null,
      gastronomia: GASTRONOMIA.includes(r.gastronomia) ? r.gastronomia : null,
      qtd_rostos: Number.isInteger(r.qtd_rostos) ? r.qtd_rostos : null,
      rostos_identificaveis: bool(r.rostos_identificaveis) ? b(r.rostos_identificaveis) : 1,
      marca_terceiro: bool(r.marca_terceiro) ? b(r.marca_terceiro) : 1,
      tem_texto: bool(r.tem_texto) ? b(r.tem_texto) : 1,
      indesejados: JSON.stringify(Array.isArray(r.indesejados) ? r.indesejados : []),
      capacidade_estimada: Number.isInteger(r.capacidade_estimada) ? r.capacidade_estimada : null,
      perguntas_que_responde: JSON.stringify(Array.isArray(r.perguntas_que_responde) ? r.perguntas_que_responde : []),
      tags: JSON.stringify(normalizarTags(r.tags)),
      espaco_para_texto: b(r.espaco_para_texto),
      decoracao: JSON.stringify(r.decoracao && typeof r.decoracao === 'object' ? r.decoracao : {}),
      nota_rubrica,
      qualidade: JSON.stringify(q),
      problemas: JSON.stringify(problemas),
      veredito,
      destinos_sugeridos: JSON.stringify(destinos),
    },
  };
}

// cliente = criarCliente(...) de openrouter.js
async function analisarFoto(jpeg, { cliente, modelo }) {
  // o raciocínio conta no max_tokens: com 2000 ele cortava o JSON no meio
  const texto = await cliente.chat(modelo, [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
      { type: 'text', text: montarPrompt() },
    ],
  }], { response_format: { type: 'json_object' }, max_tokens: 6000, temperature: 0.2, reasoning: { effort: 'low' } });
  const json = texto.match(/\{[\s\S]*\}/);
  if (!json) throw new Error(`resposta sem JSON: ${texto.slice(0, 120)}`);
  const v = validarAnalise(JSON.parse(json[0]));
  if (!v.ok) throw new Error(`fora do vocabulário: ${v.erros.join('; ')}`);
  return v.campos;
}

module.exports = { montarPrompt, validarAnalise, analisarFoto, CRITERIOS, PESOS_QUALIDADE };

