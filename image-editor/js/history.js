/*
 * Retoque — histórico de desfazer/refazer.
 *
 * Cada entrada guarda um estado completo do documento. Como os canvases
 * das camadas nunca são alterados depois de entrarem no histórico
 * (cópia na escrita), os estados compartilham referências e o custo de
 * memória é só o dos pixels que realmente mudaram. O orçamento de memória
 * descarta as entradas mais antigas quando o total passa do limite.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Retoque = root.Retoque || {};
    root.Retoque.History = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function History(options) {
    var opts = options || {};
    this.limit = opts.limit || 60;
    this.budget = opts.budget || Infinity;
    // measure(state) -> [[chave, bytes], ...]; chaves repetidas contam uma vez.
    this.measure = opts.measure || null;
    this.entries = [];
    this.index = -1;
  }

  History.prototype.reset = function (state, label) {
    this.entries = [{ label: label, state: state }];
    this.index = 0;
  };

  History.prototype.push = function (state, label) {
    this.entries.length = this.index + 1;
    this.entries.push({ label: label, state: state });
    this.index = this.entries.length - 1;
    this.trim();
  };

  // Substitui o estado da entrada atual (para agrupar passos repetidos,
  // como vários toques nas setas, numa única entrada).
  History.prototype.amend = function (state) {
    if (this.index < 0) return;
    this.entries.length = this.index + 1;
    this.entries[this.index].state = state;
  };

  History.prototype.bytes = function () {
    if (!this.measure) return 0;
    var seen = new Set();
    var total = 0;
    for (var i = 0; i < this.entries.length; i++) {
      var parts = this.measure(this.entries[i].state);
      for (var j = 0; j < parts.length; j++) {
        if (seen.has(parts[j][0])) continue;
        seen.add(parts[j][0]);
        total += parts[j][1];
      }
    }
    return total;
  };

  History.prototype.trim = function () {
    while (this.entries.length > this.limit && this.index > 0) {
      this.entries.shift();
      this.index--;
    }
    if (!this.measure || this.budget === Infinity) return;
    while (this.entries.length > 2 && this.index > 0 && this.bytes() > this.budget) {
      this.entries.shift();
      this.index--;
    }
  };

  History.prototype.canUndo = function () {
    return this.index > 0;
  };

  History.prototype.canRedo = function () {
    return this.index < this.entries.length - 1;
  };

  History.prototype.undo = function () {
    if (!this.canUndo()) return null;
    this.index--;
    return this.entries[this.index].state;
  };

  History.prototype.redo = function () {
    if (!this.canRedo()) return null;
    this.index++;
    return this.entries[this.index].state;
  };

  History.prototype.go = function (index) {
    if (index < 0 || index >= this.entries.length || index === this.index) return null;
    this.index = index;
    return this.entries[index].state;
  };

  History.prototype.current = function () {
    return this.entries[this.index] || null;
  };

  return History;
});
