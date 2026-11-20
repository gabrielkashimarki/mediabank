const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/vocabulario');

test('localDe deriva o local do espaço', () => {
  assert.equal(v.localDe('Deck'), 'Casa Exemplo');
  assert.equal(v.localDe('Interior do teatro'), 'Teatro Exemplo');
  assert.equal(v.localDe('Arena'), 'Parque Exemplo');
  assert.equal(v.localDe(v.VISTA_AEREA), null);
  assert.equal(v.localDe('Inventado'), null);
});

test('filtro de local inclui a vista aérea', () => {
  assert.deepEqual(v.espacosDoLocal('Teatro Exemplo'), ['Interior do teatro', 'Vista externa', v.VISTA_AEREA]);
  assert.deepEqual(v.espacosDoLocal('Nenhum'), []);
});

test('tipo de evento pai traz os filhos', () => {
  assert.deepEqual(v.tiposComFilhos('Corporativo'), ['Corporativo', 'Palestra', 'Workshop', 'Confraternização', 'Lançamento']);
  assert.deepEqual(v.tiposComFilhos('Casamento'), ['Casamento']);
  assert.deepEqual(v.tiposComFilhos('Formatura'), []);
});

test('ESPACOS tem 15 itens sem repetição', () => {
  assert.equal(v.ESPACOS.length, 15);
  assert.equal(new Set(v.ESPACOS).size, 15);
});
