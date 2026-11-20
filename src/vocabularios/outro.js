// Vocabulário de exemplo de um segundo cliente: a Marca Exemplo, fictícia, com um banco de cenas para anúncios em vídeo.
// Mostra o MediaBank multicliente: listas próprias, análise de vídeo própria e regra de uso das cenas entre peças.

const TEMAS = ['abertura', 'produto', 'pensativa', 'cozinha', 'cafe', 'cha', 'laboratorio', 'escritorio', 'reuniao', 'celular',
  'rua', 'festa', 'viagem', 'natureza', 'rosto', 'marca'];
const EMOCOES = ['tensão', 'desconforto', 'alívio', 'esperança', 'alegria', 'neutro'];
const PESSOAS = ['nenhuma', 'mulher', 'homem', 'casal', 'grupo', 'criança'];
const PLANOS = ['close', 'médio', 'aberto', 'detalhe', 'aéreo'];

// Regra de uso: esses temas aparecem em uma peça só; o resto em até 3; take da marca é livre.
// Conta por origem_grupo (o mesmo vídeo do banco salvo com dois nomes é uma cena só) e ignora uso retirado.
const REGRAS_USO = {
  unico: [{ campo: 'tema', valores: ['abertura', 'pensativa'] }],
  maxPecas: 3,
  livres: [{ campo: 'marca', valor: true }],
};

// Vale o que não foi reprovado; para fora (API v2) também precisa de licença conhecida.
const EXPOSICAO = {
  acervo: "a.aprovacao != 'reprovada'",
  externa: "a.aprovacao != 'reprovada' AND a.licenca IS NOT NULL",
};

const MCP = {
  nome: 'mediabank-outro',
  descricaoBusca: 'Busca no banco de cenas da Marca Exemplo pelo significado do texto, ex.: "mulher tomando café na janela", "produto na mão".',
  instrucoes: 'Banco de cenas da Marca Exemplo. Use buscar_videos para achar trechos e ver_video para olhar um. '
    + 'Cena "evitar" tem motivo: leia antes de usar. Abertura e pensativa não se repetem entre vídeos; o resto aparece em até 3.',
};

const lista = xs => xs.map(x => `"${x}"`).join(', ');
const bool = v => typeof v === 'boolean';
const b = v => (v ? 1 : 0);

// outro cliente de vídeo pode reusar a mesma análise com o próprio contexto e listas
const analiseVideo = (contexto, { TEMAS, EMOCOES, PESSOAS, PLANOS }) => ({
  prompt(n, transcricao, { campoCenas }) {
    return `Você cataloga o banco de cenas ${contexto}.
A imagem é uma GRADE com ${n} quadros numerados (1 a ${n}) de um mesmo clipe, em ordem: cada quadro é o meio de uma cena.
${transcricao ? `Fala transcrita: """${transcricao.slice(0, 1500)}"""\n` : ''}Responda APENAS com um objeto JSON:
- titulo: até 60 caracteres, o que o clipe mostra
- descricao: 40 a 120 palavras, concreta (ação, pessoas, objetos, lugar, luz, clima)
- alt: até 125 caracteres
- tema: um de ${lista(TEMAS)}
- emocao: um de ${lista(EMOCOES)}
- pessoas: um de ${lista(PESSOAS)}
- plano: um de ${lista(PLANOS)}
- foto_parada: true se é foto, ilustração ou vetor sem movimento de filmagem
- tem_crianca: true/false (na dúvida, true)
- tem_pessoa: true/false
- qtd_rostos: número de rostos visíveis
- rostos_identificaveis: true/false (na dúvida, true)
- tem_texto: true/false, texto, legenda, logo ou marca d'água SOBREPOSTOS ao vídeo
- marca_terceiro: true/false, embalagem, logo ou produto de outra empresa visível
- qualidade: { "assunto", "enquadramento", "composicao", "luz", "limpeza", "momento" }: notas inteiras de 1 a 10 do clipe como take de anúncio (3 = não serve, 7 = bom, 9 = excelente)
${campoCenas(n)}
Use exatamente os valores das listas.`;
  },
  // devolve {ok, campos} com as colunas do asset; os campos do vocabulário vão em etiquetas
  validar(r) {
    const erros = [];
    if (typeof r.titulo !== 'string' || !r.titulo) erros.push('titulo');
    if (typeof r.descricao !== 'string' || r.descricao.length < 80) erros.push('descricao');
    if (erros.length) return { ok: false, erros };
    // etiqueta fora da lista vira vazia (no teste real o modelo respondeu emocao "pensativa"); o tema da curadoria vale mais
    const daLista = (v, xs) => (xs.includes(v) ? v : null);
    const q = r.qualidade && typeof r.qualidade === 'object' ? r.qualidade : {};
    const notas = ['assunto', 'enquadramento', 'composicao', 'luz', 'limpeza', 'momento'].map(k => q[k]);
    const rubrica = notas.every(v => Number.isInteger(v) && v >= 1 && v <= 10) ? Math.round(notas.reduce((s, v) => s + v, 0) / 6 * 10) / 10 : null;
    return {
      ok: true,
      campos: {
        titulo: r.titulo.slice(0, 60), descricao: r.descricao, alt: typeof r.alt === 'string' ? r.alt.slice(0, 125) : null,
        tem_crianca: bool(r.tem_crianca) ? b(r.tem_crianca) : 1,
        tem_pessoa: bool(r.tem_pessoa) ? b(r.tem_pessoa) : null,
        qtd_rostos: Number.isInteger(r.qtd_rostos) ? r.qtd_rostos : null,
        rostos_identificaveis: bool(r.rostos_identificaveis) ? b(r.rostos_identificaveis) : 1,
        tem_texto: bool(r.tem_texto) ? b(r.tem_texto) : 1,
        marca_terceiro: bool(r.marca_terceiro) ? b(r.marca_terceiro) : 1,
        qualidade: JSON.stringify(q), nota_rubrica: rubrica,
        etiquetas: { tema: daLista(r.tema, TEMAS), emocao: daLista(r.emocao, EMOCOES), pessoas: daLista(r.pessoas, PESSOAS), plano: daLista(r.plano, PLANOS), foto_parada: !!r.foto_parada },
      },
    };
  },
});
const ANALISE_VIDEO = analiseVideo('da Marca Exemplo, que faz anúncios em vídeo vertical de produtos de bem-estar', { TEMAS, EMOCOES, PESSOAS, PLANOS });

module.exports = {
  id: 'outro',
  nome: 'Marca Exemplo',
  EXPOSICAO, MCP, REGRAS_USO, ANALISE_VIDEO, analiseVideo,
  TEMAS, EMOCOES, PESSOAS, PLANOS,
  ETIQUETAS: { tema: TEMAS, emocao: EMOCOES, pessoas: PESSOAS, plano: PLANOS },
  // o painel monta a Biblioteca de fotos com estas listas; a Marca Exemplo não tem fotos
  LOCAIS: {}, VISTA_AEREA: '', ESPACOS: [], TIPOS_EVENTO: {}, LISTAS: {}, DESTINOS: ['prop', 'social', 'site'],
  TIERS: ['hero', 'social', 'arquivo', 'variacao', 'descartar'], AUTORIZACAO_USO: ['sim', 'nao', 'desconhecida'], GASTRONOMIA: [],
};
