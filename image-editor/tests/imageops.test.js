'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../js/imageops.js');

function image(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const px = typeof fill === 'function' ? fill(i % width, Math.floor(i / width)) : fill;
    data.set(px, i * 4);
  }
  return { data, width, height };
}

function gradientImage() {
  return image(16, 16, (x, y) => [x * 16, y * 16, (x + y) * 8, 255]);
}

test('ajustes neutros não alteram os pixels', () => {
  const img = gradientImage();
  const before = new Uint8ClampedArray(img.data);
  ops.applyAdjustments(img, ops.defaultAdjustments());
  assert.deepEqual(img.data, before);
});

test('tabelas de tom são identidade na posição neutra', () => {
  const luts = ops.buildToneLUTs(ops.defaultAdjustments());
  for (const lut of luts) for (let i = 0; i < 256; i++) assert.equal(lut[i], i);
});

test('exposição positiva clareia e negativa escurece', () => {
  const up = ops.buildToneLUTs({ exposure: 1 });
  const down = ops.buildToneLUTs({ exposure: -1 });
  assert.ok(up[0][128] > 128);
  assert.ok(down[0][128] < 128);
  assert.equal(up[0][0], 0);
  assert.equal(up[0][255], 255);
});

test('contraste mantém o cinza médio e afasta os extremos', () => {
  const lut = ops.buildToneLUTs({ contrast: 50 })[0];
  assert.ok(Math.abs(lut[128] - 128) <= 1);
  assert.ok(lut[64] < 64);
  assert.ok(lut[192] > 192);
});

test('temperatura positiva aquece (mais vermelho, menos azul)', () => {
  const img = image(1, 1, [128, 128, 128, 255]);
  ops.applyAdjustments(img, { temperature: 60 });
  assert.ok(img.data[0] > 128);
  assert.ok(img.data[2] < 128);
});

test('saturação -100 produz cinza', () => {
  const img = image(2, 1, [200, 50, 30, 255]);
  ops.applyAdjustments(img, { saturation: -100 });
  assert.ok(Math.abs(img.data[0] - img.data[1]) <= 1);
  assert.ok(Math.abs(img.data[1] - img.data[2]) <= 1);
});

test('rotação de matiz de 360° volta à cor original', () => {
  const img = image(1, 1, [200, 80, 40, 255]);
  ops.applyAdjustments(img, { hue: 180 });
  ops.applyAdjustments(img, { hue: 180 });
  assert.ok(Math.abs(img.data[0] - 200) <= 3);
  assert.ok(Math.abs(img.data[1] - 80) <= 3);
  assert.ok(Math.abs(img.data[2] - 40) <= 3);
});

test('ajustes preservam o canal alfa', () => {
  const img = image(1, 1, [90, 120, 200, 77]);
  ops.applyAdjustments(img, { exposure: 1, saturation: 40, hue: 30 });
  assert.equal(img.data[3], 77);
});

test('preto e branco iguala os canais', () => {
  const img = gradientImage();
  ops.grayscale(img);
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i], img.data[i + 1]);
    assert.equal(img.data[i + 1], img.data[i + 2]);
  }
});

test('inverter duas vezes devolve a imagem original', () => {
  const img = gradientImage();
  const before = new Uint8ClampedArray(img.data);
  ops.invert(ops.invert(img));
  assert.deepEqual(img.data, before);
});

test('posterizar limita o número de níveis', () => {
  const img = image(256, 1, (x) => [x, x, x, 255]);
  ops.posterize(img, 4);
  const levels = new Set();
  for (let i = 0; i < img.data.length; i += 4) levels.add(img.data[i]);
  assert.deepEqual([...levels].sort((a, b) => a - b), [0, 85, 170, 255]);
});

test('limiar gera apenas preto e branco', () => {
  const img = gradientImage();
  ops.threshold(img, 100);
  for (let i = 0; i < img.data.length; i += 4) assert.ok(img.data[i] === 0 || img.data[i] === 255);
});

test('ruído com a mesma semente é determinístico', () => {
  const a = image(8, 8, [128, 128, 128, 255]);
  const b = image(8, 8, [128, 128, 128, 255]);
  ops.noise(a, 30, true, 42);
  ops.noise(b, 30, true, 42);
  assert.deepEqual(a.data, b.data);
});

test('desfoque mantém uma imagem de cor única intacta', () => {
  const img = image(20, 12, [40, 160, 220, 255]);
  ops.gaussianBlur(img, 5);
  for (let i = 0; i < img.data.length; i += 4) {
    assert.ok(Math.abs(img.data[i] - 40) <= 1);
    assert.ok(Math.abs(img.data[i + 1] - 160) <= 1);
    assert.ok(Math.abs(img.data[i + 2] - 220) <= 1);
    assert.equal(img.data[i + 3], 255);
  }
});

test('desfoque espalha um ponto e conserva a energia', () => {
  const img = image(21, 21, (x, y) => (x === 10 && y === 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  ops.gaussianBlur(img, 2);
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4) sum += img.data[i];
  assert.ok(img.data[(10 * 21 + 10) * 4] < 255);
  assert.ok(img.data[(10 * 21 + 12) * 4] > 0);
  assert.ok(Math.abs(sum - 255) < 40);
});

test('desfoque não escurece bordas de áreas transparentes', () => {
  const img = image(20, 1, (x) => (x < 10 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  ops.gaussianBlur(img, 2);
  const p = 10 * 4;
  assert.ok(img.data[p + 3] > 0 && img.data[p + 3] < 255);
  assert.ok(img.data[p] > 240, 'a cor da borda continua vermelha');
});

test('nitidez aumenta o contraste local', () => {
  const img = image(10, 1, (x) => (x < 5 ? [100, 100, 100, 255] : [150, 150, 150, 255]));
  ops.unsharpMask(img, 100, 1, 0);
  assert.ok(img.data[4 * 4] < 100);
  assert.ok(img.data[5 * 4] > 150);
});

test('histograma conta apenas pixels visíveis', () => {
  const img = image(4, 1, (x) => (x < 3 ? [10, 20, 30, 255] : [10, 20, 30, 0]));
  const hist = ops.histogram(img);
  assert.equal(hist.count, 3);
  assert.equal(hist.r[10], 3);
  assert.equal(hist.g[20], 3);
  assert.equal(hist.b[30], 3);
});

test('contraste automático estica a faixa tonal', () => {
  const img = image(100, 1, (x) => {
    const v = 80 + Math.round(x * 0.9);
    return [v, v, v, 255];
  });
  ops.autoLevels(img, false, 0);
  let min = 255, max = 0;
  for (let i = 0; i < img.data.length; i += 4) { min = Math.min(min, img.data[i]); max = Math.max(max, img.data[i]); }
  assert.equal(min, 0);
  assert.equal(max, 255);
});

test('tom automático neutraliza dominante de cor', () => {
  const img = image(64, 1, (x) => [60 + x, 40 + x, 20 + x * 2, 255]);
  ops.autoLevels(img, true, 0);
  const last = (img.width - 1) * 4;
  assert.equal(img.data[0], 0);
  assert.equal(img.data[last], 255);
  assert.equal(img.data[last + 2], 255);
});

test('balde contíguo respeita regiões separadas', () => {
  // duas áreas brancas separadas por uma coluna preta
  const img = image(5, 3, (x) => (x === 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const contiguous = ops.floodMask(img, 0, 0, 0, true);
  const global = ops.floodMask(img, 0, 0, 0, false);
  const count = (m) => m.reduce((a, b) => a + b, 0);
  assert.equal(count(contiguous), 6);
  assert.equal(count(global), 12);
  assert.equal(contiguous[4], 0);
});

test('balde considera a tolerância', () => {
  const img = image(4, 1, (x) => [100 + x * 10, 100, 100, 255]);
  assert.equal(ops.floodMask(img, 0, 0, 15, true).reduce((a, b) => a + b, 0), 2);
  assert.equal(ops.floodMask(img, 0, 0, 30, true).reduce((a, b) => a + b, 0), 4);
});

test('balde fora da imagem devolve null', () => {
  assert.equal(ops.floodMask(gradientImage(), -1, 3, 10, true), null);
});

test('pixelizar deixa cada bloco com uma cor só', () => {
  const img = gradientImage();
  ops.pixelate(img, 4);
  const p = (x, y) => (y * 16 + x) * 4;
  assert.deepEqual([...img.data.slice(p(0, 0), p(0, 0) + 4)], [...img.data.slice(p(3, 3), p(3, 3) + 4)]);
  assert.notDeepEqual([...img.data.slice(p(0, 0), p(0, 0) + 4)], [...img.data.slice(p(4, 0), p(4, 0) + 4)]);
});

test('vinheta negativa escurece os cantos e preserva o centro', () => {
  const img = image(41, 41, [200, 200, 200, 255]);
  ops.vignette(img, -80, 40);
  assert.equal(img.data[(20 * 41 + 20) * 4], 200);
  assert.ok(img.data[0] < 120);
});

test('conversão de cores hexadecimais', () => {
  assert.deepEqual(ops.hexToRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(ops.hexToRgb('0f0'), [0, 255, 0]);
  assert.equal(ops.hexToRgb('#zzz'), null);
  assert.equal(ops.rgbToHex(255, 128, 0), '#ff8000');
  assert.equal(ops.rgbToHex(300, -5, 15.6), '#ff0010');
});

test('caixas do desfoque aproximam o sigma pedido', () => {
  const sigma = 6;
  const sizes = ops.boxSizesForGauss(sigma, 3);
  const variance = sizes.reduce((acc, w) => acc + (w * w - 1) / 12, 0);
  assert.ok(Math.abs(Math.sqrt(variance) - sigma) < 0.6);
});
