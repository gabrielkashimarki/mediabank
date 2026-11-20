// Uso: node scripts/curadoria.js
// Recalcula rajadas, nota por destino (percentis, pesos, moodboard) e tier.
// Rodar depois do py/sinais.py.
const { carregar } = require('../src/config');
const { recalcular } = require('../src/curadoria');

console.log(JSON.stringify(recalcular(carregar().db), null, 2));
