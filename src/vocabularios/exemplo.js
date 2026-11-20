// Vocabulário de exemplo: a Casa Exemplo, um restaurante e espaço de eventos fictício com acervo de fotos.
// Fonte única das listas fechadas: monta o prompt, valida a resposta da IA e as facetas do painel.
// Para um cliente real, copie este arquivo, troque as listas e registre em src/clientes.js.

const LOCAIS = {
  'Teatro Exemplo': ['Interior do teatro', 'Vista externa'],
  'Casa Exemplo': ['Salão interno', 'Restaurante', 'Deck', 'Bar', 'Pérgola', 'Antessala', 'Hall', 'Cozinha', 'Fachada'],
  'Parque Exemplo': ['Tendas (área coberta)', 'Arena', 'Vista externa do parque'],
};
// mostra os três locais juntos: sem local próprio, entra no filtro de qualquer local
const VISTA_AEREA = 'Vista aérea do complexo';
const ESPACOS = [...Object.values(LOCAIS).flat(), VISTA_AEREA];

const TIPOS_EVENTO = {
  'Casamento': null,
  '15 anos': null,
  'Aniversário': null,
  'Corporativo': null,
  'Palestra': 'Corporativo',
  'Workshop': 'Corporativo',
  'Confraternização': 'Corporativo',
  'Lançamento': 'Corporativo',
  'Jantar temático': null,
  'Réveillon': null,
  'Dia dos Namorados': null,
  'Restaurante no dia a dia': null,
  'Espaço vazio': null,
};

const LISTAS = {
  tipo: ['Espaço', 'Decoração', 'Gastronomia', 'Bar', 'Pessoas'],
  luz_tipo: ['Noturna', 'Hora dourada', 'Vela', 'Natural', 'Sol direto', 'Mista quente', 'Janela'],
  luz_direcao: ['Frontal', 'Lateral', 'Contraluz', 'Zenital', 'Difusa'],
  plano: ['Geral', 'Aberto', 'Médio', 'Detalhe', 'Retrato'],
  altura_camera: ['Aérea', 'Alta', 'Olho', 'Baixa', 'Chão'],
  composicao: ['Simétrica', 'Regra dos terços', 'Centralizada', 'Linhas guia', 'Enquadramento natural', 'Diagonal'],
  ponto_vista: ['Frontal', 'Três quartos', 'Lateral', 'Top down', 'Por trás'],
  profundidade: ['Rasa', 'Média', 'Total'],
  posicao_assunto: ['Esquerda', 'Centro', 'Direita'],
  sazonal: ['Nenhum', 'Natal', 'Réveillon', 'Dia dos Namorados', 'Inverno', 'Verão'],
  tratamento: ['Natural', 'Quente', 'Frio', 'P&B', 'Alto contraste', 'Filme'],
};

// subcategoria das fotos de tipo Gastronomia ou Bar
const GASTRONOMIA = ['Drinks e coquetéis', 'Vinhos e espumantes', 'Café e bebidas sem álcool', 'Pratos finalizados',
  'Entradas e couvert', 'Sobremesas e mesa de doces', 'Finger food e canapés', 'Buffet', 'Estação ao vivo',
  'Preparo de alimentos', 'Empratamento', 'Ingredientes'];

const DESTINOS = ['prop', 'social', 'site'];
const TIERS = ['hero', 'social', 'arquivo', 'variacao', 'descartar'];
const AUTORIZACAO_USO = ['sim', 'nao', 'desconhecida'];

function localDe(espaco) {
  for (const [local, espacos] of Object.entries(LOCAIS)) if (espacos.includes(espaco)) return local;
  return null;
}

// espaços que um filtro de local deve trazer
function espacosDoLocal(local) {
  return LOCAIS[local] ? [...LOCAIS[local], VISTA_AEREA] : [];
}

// o próprio tipo mais os filhos (filtrar Corporativo traz Palestra etc.)
function tiposComFilhos(tipo) {
  if (!(tipo in TIPOS_EVENTO)) return [];
  return [tipo, ...Object.keys(TIPOS_EVENTO).filter(t => TIPOS_EVENTO[t] === tipo)];
}

// regra de exposição (sem o filtro de cliente, que clientes.js acrescenta)
// acervo interno (MCP do dono): tudo menos criança, descartada e sem autorização; ainda não aprovada entra
const EXPOSICAO = {
  acervo: "a.tem_crianca = 0 AND a.autorizacao_uso != 'nao' AND a.tier != 'descartar'",
};
EXPOSICAO.externa = `a.aprovacao = 'aprovada' AND ${EXPOSICAO.acervo}`;

const MCP = {
  nome: 'mediabank-exemplo',
  descricaoBusca: 'Busca fotos no acervo da Casa Exemplo (MediaBank) pelo significado do texto, ex.: "drink no bar à noite", '
    + '"deck decorado para casamento", "fachada iluminada". Devolve a lista com id, descrição, espaço, '
    + 'nota de qualidade da IA (1 a 10), tamanho em pixels e link do original, e as miniaturas para olhar.',
  instrucoes: 'Acervo de fotos da Casa Exemplo. Use buscar_fotos para achar e ver_foto para olhar uma em tamanho maior. '
    + 'As fotos vêm sem criança e sem as descartadas, mas a maioria ainda não foi aprovada nem tem autorização de imagem: antes de publicar, confira se aparece convidado com rosto identificável ou marca de terceiro.',
};

module.exports = {
  id: 'exemplo',
  nome: 'Casa Exemplo',
  contexto: 'restaurante e espaço de eventos',
  EXPOSICAO, MCP,
  GASTRONOMIA,
  LOCAIS, VISTA_AEREA, ESPACOS, TIPOS_EVENTO, LISTAS, DESTINOS, TIERS, AUTORIZACAO_USO,
  localDe, espacosDoLocal, tiposComFilhos,
};
