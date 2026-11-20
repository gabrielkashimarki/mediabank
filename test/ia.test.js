const test = require('node:test');
const assert = require('node:assert/strict');
const { validarAnalise, analisarFoto, montarPrompt } = require('../src/ia');

const boa = {
  titulo: 'Deck ao pôr do sol',
  descricao: 'x'.repeat(250),
  legenda: 'Fim de tarde no deck.',
  alt: 'Deck de madeira com mesas e lago ao fundo',
  espaco: 'Deck',
  tipo_evento: 'Restaurante no dia a dia',
  tipo: 'Espaço', luz_tipo: 'Hora dourada', luz_direcao: 'Contraluz', plano: 'Aberto',
  altura_camera: 'Olho', composicao: 'Regra dos terços', ponto_vista: 'Três quartos',
  profundidade: 'Total', posicao_assunto: 'Centro', sazonal: 'Nenhum', tratamento: 'Quente',
  tem_crianca: false, qtd_rostos: 0, rostos_identificaveis: false, marca_terceiro: false, tem_texto: false,
  indesejados: [], capacidade_estimada: 80, perguntas_que_responde: ['Como é o deck?'],
  espaco_para_texto: true, decoracao: { estilo: 'rústico', cores: ['verde'], flores: false, iluminacao_cenica: false },
  qualidade: { assunto: 8, enquadramento: 8, composicao: 7, luz: 8, limpeza: 7, momento: 6 }, problemas: ['leve ruído'], veredito: 'boa para rede social',
  destinos_sugeridos: ['social'],
};

test('resposta válida vira colunas com local derivado', () => {
  const v = validarAnalise(boa);
  assert.equal(v.ok, true);
  assert.equal(v.campos.local, 'Casa Exemplo');
  assert.equal(v.campos.tem_crianca, 0);
  assert.equal(v.campos.nota_rubrica, 7.5);
  assert.equal(v.campos.perguntas_que_responde, '["Como é o deck?"]');
});

test('valor fora do vocabulário é recusado', () => {
  const v = validarAnalise({ ...boa, espaco: 'Varanda', luz_tipo: 'Neon', tipo_evento: 'Formatura' });
  assert.equal(v.ok, false);
  assert.deepEqual(v.erros, ['espaco: Varanda', 'tipo_evento: Formatura']);
});

test('luz trocada entre tipo e direção volta para o campo certo; luz inválida vira null', () => {
  const trocada = validarAnalise({ ...boa, luz_tipo: 'Difusa', luz_direcao: 'Mista quente' });
  assert.equal(trocada.ok, true);
  assert.deepEqual([trocada.campos.luz_tipo, trocada.campos.luz_direcao], ['Mista quente', 'Difusa']);
  const invalida = validarAnalise({ ...boa, luz_tipo: 'Neon', luz_direcao: 'Mista quente' });
  assert.equal(invalida.ok, true);
  assert.deepEqual([invalida.campos.luz_tipo, invalida.campos.luz_direcao], ['Mista quente', null]);
});

test('proteção ausente vira o valor mais restritivo', () => {
  const { tem_crianca, rostos_identificaveis, marca_terceiro, tem_texto, ...resto } = boa;
  const v = validarAnalise(resto);
  assert.equal(v.campos.tem_crianca, 1);
  assert.equal(v.campos.rostos_identificaveis, 1);
  assert.equal(v.campos.marca_terceiro, 1);
  assert.equal(v.campos.tem_texto, 1);
});

test('tipo_evento nulo é aceito', () => {
  assert.equal(validarAnalise({ ...boa, tipo_evento: null }).ok, true);
});

test('analisarFoto manda a imagem e o prompt e valida a volta', async () => {
  let pedido;
  const cliente = { chat: async (modelo, msgs, extra) => { pedido = { modelo, msgs, extra }; return '```json\n' + JSON.stringify(boa) + '\n```'; } };
  const campos = await analisarFoto(Buffer.from('jpeg'), { cliente, modelo: 'google/gemini-3.8-flash' });
  assert.equal(campos.espaco, 'Deck');
  assert.equal(pedido.modelo, 'google/gemini-3.8-flash');
  assert.match(pedido.msgs[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(pedido.extra.response_format.type, 'json_object');
  assert.ok(montarPrompt().includes('Vista aérea do complexo'));
  assert.ok(montarPrompt().includes('SOBREPOSTOS à foto'));
});

test('analisarFoto falha quando a IA sai do vocabulário', async () => {
  const cliente = { chat: async () => JSON.stringify({ ...boa, espaco: 'Varanda' }) };
  await assert.rejects(analisarFoto(Buffer.from('x'), { cliente, modelo: 'm' }), /fora do vocabulário: espaco: Varanda/);
});

test('qualidade sem limpeza dá erro', () => {
  const { limpeza, ...semLimpeza } = boa.qualidade;
  const v = validarAnalise({ ...boa, qualidade: semLimpeza });
  assert.equal(v.ok, false);
  assert.ok(v.erros.includes('qualidade: limpeza'));
});

test('qualidade com assunto 11 dá erro', () => {
  const v = validarAnalise({ ...boa, qualidade: { ...boa.qualidade, assunto: 11 } });
  assert.equal(v.ok, false);
  assert.ok(v.erros.includes('qualidade: assunto'));
});

test('problemas com 7 itens vira 5', () => {
  const v = validarAnalise({ ...boa, problemas: ['a','b','c','d','e','f','g'] });
  assert.equal(v.ok, true);
  assert.equal(JSON.parse(v.campos.problemas).length, 5);
});

test('montarPrompt contém "assunto" e Exemplo 3', () => {
  const p = montarPrompt();
  assert.ok(p.includes('"assunto"'));
  assert.ok(p.includes('Exemplo 3'));
});

test('tem_pessoa vira 1 ou 0; ausente fica null', () => {
  assert.equal(validarAnalise({ ...boa, tem_pessoa: true }).campos.tem_pessoa, 1);
  assert.equal(validarAnalise({ ...boa, tem_pessoa: false }).campos.tem_pessoa, 0);
  assert.equal(validarAnalise({ ...boa }).campos.tem_pessoa, null);
});

test('gastronomia aceita só valor da lista; fora dela vira null', () => {
  assert.equal(validarAnalise({ ...boa, tipo: 'Bar', gastronomia: 'Drinks e coquetéis' }).campos.gastronomia, 'Drinks e coquetéis');
  assert.equal(validarAnalise({ ...boa, gastronomia: 'Sushi' }).campos.gastronomia, null);
});
