'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../js/history.js');

test('desfazer e refazer percorrem os estados', () => {
  const h = new History();
  h.reset('a', 'Abrir');
  h.push('b', 'Pincel');
  h.push('c', 'Texto');
  assert.equal(h.undo(), 'b');
  assert.equal(h.undo(), 'a');
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), 'b');
  assert.equal(h.current().label, 'Pincel');
});

test('uma ação nova descarta o ramo de refazer', () => {
  const h = new History();
  h.reset('a', 'Abrir');
  h.push('b', 'B');
  h.push('c', 'C');
  h.undo();
  h.push('d', 'D');
  assert.equal(h.canRedo(), false);
  assert.deepEqual(h.entries.map((e) => e.state), ['a', 'b', 'd']);
});

test('limite de passos remove os mais antigos', () => {
  const h = new History({ limit: 3 });
  h.reset(0, 'Abrir');
  for (let i = 1; i <= 5; i++) h.push(i, 'Passo ' + i);
  assert.deepEqual(h.entries.map((e) => e.state), [3, 4, 5]);
  assert.equal(h.index, 2);
});

test('orçamento de memória conta canvases compartilhados uma única vez', () => {
  const shared = { id: 'fundo' };
  const measure = (s) => s.map((key) => [key, 100]);
  const h = new History({ budget: 350, measure });
  h.reset([shared], 'Abrir');
  h.push([shared, { id: 1 }], 'A');
  h.push([shared, { id: 2 }], 'B');
  assert.equal(h.bytes(), 300);
  h.push([shared, { id: 3 }], 'C');
  assert.ok(h.bytes() <= 350);
  assert.equal(h.current().label, 'C');
});

test('ir direto para um passo do histórico', () => {
  const h = new History();
  h.reset('a', 'Abrir');
  h.push('b', 'B');
  h.push('c', 'C');
  assert.equal(h.go(0), 'a');
  assert.equal(h.go(0), null);
  assert.equal(h.go(2), 'c');
  assert.equal(h.go(9), null);
});

test('amend troca o estado atual e descarta o refazer', () => {
  const h = new History();
  h.reset('a', 'Abrir');
  h.push('b', 'Mover');
  h.amend('b2');
  assert.equal(h.current().state, 'b2');
  assert.equal(h.entries.length, 2);
});
