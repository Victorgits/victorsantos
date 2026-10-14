'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/style.js');

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = fn(x, y);
      data.set([px[0], px[1], px[2], 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

// Imagem de teste que cobre bem o cubo de cores.
function colorful(width, height, seed) {
  let s = seed || 1;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  return image(width, height, (x, y) => {
    const t = rand();
    return [((x * 7 + y * 3) % 256), ((y * 5 + Math.floor(t * 60)) % 256), ((x * 3 + y * 11 + 90) % 256)];
  });
}

function mapImage(img, fn) {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let i = 0; i < out.data.length; i += 4) {
    const v = fn(out.data[i], out.data[i + 1], out.data[i + 2]);
    out.data[i] = v[0]; out.data[i + 1] = v[1]; out.data[i + 2] = v[2];
  }
  return out;
}

const copy = (img) => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

function mae(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) { s += Math.abs(a.data[i + c] - b.data[i + c]); n++; }
  return s / n;
}

test('aprende uma curva de tons e a aplica em outra foto', () => {
  const curve = (v) => 255 * Math.pow(v / 255, 0.75);
  const before = colorful(160, 120, 3);
  const after = mapImage(before, (r, g, b) => [curve(r), curve(g), curve(b)]);
  const style = S.fitStyle([{ before, after }]);
  const other = colorful(120, 90, 99);
  const expected = mapImage(other, (r, g, b) => [curve(r), curve(g), curve(b)]);
  const result = S.applyStyle(copy(other), style);
  assert.ok(mae(result, expected) < 2.5, 'erro ' + mae(result, expected));
});

test('par sem edição gera um estilo neutro', () => {
  const before = colorful(120, 90, 5);
  const style = S.fitStyle([{ before, after: copy(before) }]);
  const other = colorful(80, 60, 8);
  assert.ok(mae(S.applyStyle(copy(other), style), other) < 1);
});

test('mudança só nos tons avermelhados não vaza para os azuis', () => {
  // metade vermelha, metade azul; a edição deixa os vermelhos mais alaranjados
  const before = image(100, 100, (x, y) => (x < 50 ? [180 + (y % 40), 40 + (x % 20), 40] : [40, 60 + (y % 30), 180 + (x % 40)]));
  const after = mapImage(before, (r, g, b) => (r > b ? [r, g + 40, b] : [r, g, b]));
  const style = S.fitStyle([{ before, after }]);
  const red = image(4, 4, () => [200, 50, 40]);
  const blue = image(4, 4, () => [40, 70, 200]);
  const r = S.applyStyle(copy(red), style).data;
  const b = S.applyStyle(copy(blue), style).data;
  assert.ok(r[1] > 75, 'verde do vermelho subiu: ' + r[1]);
  assert.ok(Math.abs(b[1] - 70) < 12, 'azul quase intacto: ' + b[1]);
});

test('intensidade zero não altera a foto', () => {
  const before = colorful(60, 40, 2);
  const after = mapImage(before, (r, g, b) => [255 - r, 255 - g, 255 - b]);
  const style = S.fitStyle([{ before, after }]);
  const other = colorful(30, 20, 4);
  assert.equal(mae(S.applyStyle(copy(other), style, { strength: 0 }), other), 0);
});

test('exposição em EV clareia em luz linear', () => {
  const t = S.exposureTable(1);
  assert.ok(t[128] > 160 && t[128] < 190);
  assert.equal(Math.round(t[0]), 0);
  assert.equal(S.exposureTable(0)[77], 77);
});

test('exposição automática clareia fotos escuras e escurece claras', () => {
  const neutral = { grid: 2, curves: [0, 1, 2].map(() => Float32Array.from({ length: 256 }, (_, i) => i)), residual: new Float32Array(24), targetKey: -2.2 };
  const dark = image(40, 30, () => [25, 25, 25]);
  const bright = image(40, 30, () => [235, 235, 235]);
  assert.ok(S.autoExposure(dark, neutral, 0.6, copy) > 0.5);
  assert.ok(S.autoExposure(bright, neutral, 0.6, copy) < -0.5);
  assert.equal(S.autoExposure(dark, neutral, 0, copy), 0);
});

test('estilo salvo e carregado produz o mesmo resultado', () => {
  const before = colorful(100, 80, 7);
  const after = mapImage(before, (r, g, b) => [r * 0.9 + 20, g, b * 0.8 + 10]);
  const style = S.fitStyle([{ before, after }]);
  const data = JSON.parse(JSON.stringify(S.serialize(style, { name: 'Teste' })));
  assert.equal(data.name, 'Teste');
  const back = S.deserialize(data);
  const img = colorful(50, 40, 11);
  assert.ok(mae(S.applyStyle(copy(img), style), S.applyStyle(copy(img), back)) < 0.6);
  assert.throws(() => S.deserialize({ app: 'outro' }));
});

test('referências de tamanhos diferentes pesam igual', () => {
  const small = colorful(40, 30, 1), big = colorful(200, 150, 2);
  const plus = (img, k) => mapImage(img, (r, g, b) => [r + k, g + k, b + k]);
  const style = S.fitStyle([{ before: small, after: plus(small, 30) }, { before: big, after: plus(big, -30) }]);
  const mid = image(10, 10, () => [128, 128, 128]);
  const out = S.applyStyle(copy(mid), style).data;
  assert.ok(Math.abs(out[0] - 128) < 12, 'média das duas edições: ' + out[0]);
});

test('regressão isotônica produz curva crescente', () => {
  const out = S.isotonic([1, 3, 2, 2, 5, 4], [1, 1, 1, 1, 1, 1]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1]);
});
