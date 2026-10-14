/*
 * Retoque — operações de pixel.
 *
 * Funções puras que trabalham sobre objetos no formato ImageData
 * ({ data: Uint8ClampedArray, width, height }). Não dependem do DOM,
 * por isso rodam tanto no navegador quanto nos testes em Node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Retoque = root.Retoque || {};
    root.Retoque.ops = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Luminância relativa (Rec. 709).
  function luma(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(v) {
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  function createImageData(width, height) {
    if (typeof ImageData !== 'undefined') return new ImageData(width, height);
    return { data: new Uint8ClampedArray(width * height * 4), width: width, height: height };
  }

  function cloneImageData(img) {
    var copy = new Uint8ClampedArray(img.data);
    if (typeof ImageData !== 'undefined') return new ImageData(copy, img.width, img.height);
    return { data: copy, width: img.width, height: img.height };
  }

  // Gerador pseudoaleatório determinístico (mulberry32).
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- *
   * Ajustes (painel "Ajustes")
   * ---------------------------------------------------------------- */

  var ADJUSTMENTS = [
    { key: 'exposure', label: 'Exposição', min: -3, max: 3, step: 0.05, unit: 'EV', group: 'Luz' },
    { key: 'contrast', label: 'Contraste', min: -100, max: 100, step: 1, group: 'Luz' },
    { key: 'brightness', label: 'Brilho', min: -100, max: 100, step: 1, group: 'Luz' },
    { key: 'highlights', label: 'Realces', min: -100, max: 100, step: 1, group: 'Luz' },
    { key: 'shadows', label: 'Sombras', min: -100, max: 100, step: 1, group: 'Luz' },
    { key: 'temperature', label: 'Temperatura', min: -100, max: 100, step: 1, group: 'Cor' },
    { key: 'tint', label: 'Tonalidade', min: -100, max: 100, step: 1, group: 'Cor' },
    { key: 'vibrance', label: 'Vibração', min: -100, max: 100, step: 1, group: 'Cor' },
    { key: 'saturation', label: 'Saturação', min: -100, max: 100, step: 1, group: 'Cor' },
    { key: 'hue', label: 'Matiz', min: -180, max: 180, step: 1, unit: '°', group: 'Cor' }
  ];

  function defaultAdjustments() {
    var out = {};
    ADJUSTMENTS.forEach(function (a) { out[a.key] = 0; });
    return out;
  }

  function isNeutral(adj) {
    return ADJUSTMENTS.every(function (a) { return !adj[a.key]; });
  }

  // Tabelas de tom por canal: balanço de branco, exposição, brilho,
  // contraste, realces e sombras. Na posição neutra viram identidade.
  function buildToneLUTs(adj) {
    var k = (adj.temperature || 0) / 100;
    var m = (adj.tint || 0) / 100;
    var gains = [1 + 0.3 * k + 0.08 * m, 1 - 0.25 * m, 1 - 0.3 * k + 0.08 * m];
    var expo = Math.pow(2, adj.exposure || 0);
    var gamma = Math.pow(2, -(adj.brightness || 0) / 100);
    var contrast = Math.pow(2, (adj.contrast || 0) / 50);
    var shadows = ((adj.shadows || 0) / 100) * 0.5;
    var highlights = ((adj.highlights || 0) / 100) * 0.5;
    var linearStage = gains[0] !== 1 || gains[1] !== 1 || gains[2] !== 1 || expo !== 1;

    var luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    for (var c = 0; c < 3; c++) {
      var lut = luts[c];
      for (var i = 0; i < 256; i++) {
        var v = i / 255;
        if (linearStage) v = linearToSrgb(Math.min(1, srgbToLinear(v) * gains[c] * expo));
        if (gamma !== 1) v = Math.pow(v, gamma);
        if (contrast !== 1) v = clamp((v - 0.5) * contrast + 0.5, 0, 1);
        if (shadows) v += shadows * 4 * v * (1 - v) * (1 - v);
        if (highlights) v += highlights * 4 * v * v * (1 - v);
        lut[i] = Math.round(clamp(v, 0, 1) * 255);
      }
    }
    return luts;
  }

  // Matriz de rotação de matiz (mesma definição do filtro CSS hue-rotate).
  function hueMatrix(deg) {
    var a = (deg * Math.PI) / 180;
    var c = Math.cos(a);
    var s = Math.sin(a);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
    ];
  }

  function applyAdjustments(img, adj) {
    if (isNeutral(adj)) return img;
    var d = img.data;
    var luts = buildToneLUTs(adj);
    var lr = luts[0], lg = luts[1], lb = luts[2];
    var sat = 1 + (adj.saturation || 0) / 100;
    var vib = (adj.vibrance || 0) / 100;
    var hm = adj.hue ? hueMatrix(adj.hue) : null;
    var color = hm !== null || sat !== 1 || vib !== 0;

    for (var i = 0, n = d.length; i < n; i += 4) {
      var r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
      if (color) {
        if (hm) {
          var r2 = hm[0] * r + hm[1] * g + hm[2] * b;
          var g2 = hm[3] * r + hm[4] * g + hm[5] * b;
          var b2 = hm[6] * r + hm[7] * g + hm[8] * b;
          r = r2; g = g2; b = b2;
        }
        var f = sat;
        if (vib) {
          var mx = r > g ? (r > b ? r : b) : g > b ? g : b;
          var mn = r < g ? (r < b ? r : b) : g < b ? g : b;
          f *= 1 + vib * (1 - (mx - mn) / 255);
        }
        if (f !== 1) {
          var L = luma(r, g, b);
          r = L + (r - L) * f;
          g = L + (g - L) * f;
          b = L + (b - L) * f;
        }
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
    return img;
  }

  /* ---------------------------------------------------------------- *
   * Filtros simples por pixel
   * ---------------------------------------------------------------- */

  function grayscale(img) {
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      var L = luma(d[i], d[i + 1], d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = L;
    }
    return img;
  }

  function sepia(img, amount) {
    var t = amount == null ? 1 : clamp(amount, 0, 1);
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = r + (0.393 * r + 0.769 * g + 0.189 * b - r) * t;
      d[i + 1] = g + (0.349 * r + 0.686 * g + 0.168 * b - g) * t;
      d[i + 2] = b + (0.272 * r + 0.534 * g + 0.131 * b - b) * t;
    }
    return img;
  }

  function invert(img) {
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    return img;
  }

  function posterize(img, levels) {
    var steps = Math.max(2, Math.round(levels)) - 1;
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) lut[v] = Math.round((Math.round((v / 255) * steps) / steps) * 255);
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    return img;
  }

  function threshold(img, level) {
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      var v = luma(d[i], d[i + 1], d[i + 2]) >= level ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return img;
  }

  function noise(img, amount, monochrome, seed) {
    var strength = (clamp(amount, 0, 100) / 100) * 80;
    var rand = rng(seed == null ? 1234 : seed);
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      if (monochrome) {
        var k = (rand() + rand() - 1) * strength;
        d[i] += k; d[i + 1] += k; d[i + 2] += k;
      } else {
        d[i] += (rand() + rand() - 1) * strength;
        d[i + 1] += (rand() + rand() - 1) * strength;
        d[i + 2] += (rand() + rand() - 1) * strength;
      }
    }
    return img;
  }

  function pixelate(img, size) {
    var s = Math.max(1, Math.round(size));
    if (s === 1) return img;
    var w = img.width, h = img.height, d = img.data;
    for (var by = 0; by < h; by += s) {
      for (var bx = 0; bx < w; bx += s) {
        var ex = Math.min(bx + s, w), ey = Math.min(by + s, h);
        var r = 0, g = 0, b = 0, a = 0, count = 0;
        for (var y = by; y < ey; y++) {
          for (var x = bx; x < ex; x++) {
            var p = (y * w + x) * 4, al = d[p + 3];
            r += d[p] * al; g += d[p + 1] * al; b += d[p + 2] * al; a += al; count++;
          }
        }
        var ar = a ? r / a : 0, ag = a ? g / a : 0, ab = a ? b / a : 0, aa = a / count;
        for (y = by; y < ey; y++) {
          for (x = bx; x < ex; x++) {
            p = (y * w + x) * 4;
            d[p] = ar; d[p + 1] = ag; d[p + 2] = ab; d[p + 3] = aa;
          }
        }
      }
    }
    return img;
  }

  // amount: -100 (escurece as bordas) a 100 (clareia). size: 0–100, onde o efeito começa.
  function vignette(img, amount, size) {
    var a = clamp(amount, -100, 100) / 100;
    if (!a) return img;
    var start = clamp(size == null ? 50 : size, 0, 100) / 100;
    var w = img.width, h = img.height, d = img.data;
    var cx = w / 2, cy = h / 2, maxD = Math.SQRT2;
    for (var y = 0; y < h; y++) {
      var dy = (y + 0.5 - cy) / cy;
      for (var x = 0; x < w; x++) {
        var dx = (x + 0.5 - cx) / cx;
        var t = (Math.sqrt(dx * dx + dy * dy) - start) / (maxD - start);
        if (t <= 0) continue;
        if (t > 1) t = 1;
        t = t * t * (3 - 2 * t);
        var p = (y * w + x) * 4;
        if (a < 0) {
          var f = 1 + a * t;
          d[p] *= f; d[p + 1] *= f; d[p + 2] *= f;
        } else {
          var k = a * t;
          d[p] += (255 - d[p]) * k;
          d[p + 1] += (255 - d[p + 1]) * k;
          d[p + 2] += (255 - d[p + 2]) * k;
        }
      }
    }
    return img;
  }

  /* ---------------------------------------------------------------- *
   * Desfoque gaussiano (três passadas de caixa, alfa pré-multiplicado)
   * ---------------------------------------------------------------- */

  function boxSizesForGauss(sigma, n) {
    var wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    var wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    var wu = wl + 2;
    var mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    var m = Math.round(mIdeal);
    var sizes = [];
    for (var i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }

  function clampIndex(k, len) {
    return k < 0 ? 0 : k >= len ? len - 1 : k;
  }

  // Média móvel sobre uma linha (ou coluna, via stride), bordas estendidas.
  function blurLine(src, dst, start, stride, len, r) {
    var inv = 1 / (2 * r + 1);
    var acc = 0;
    for (var k = -r; k <= r; k++) acc += src[start + clampIndex(k, len) * stride];
    for (k = 0; k < len; k++) {
      dst[start + k * stride] = acc * inv;
      acc += src[start + clampIndex(k + r + 1, len) * stride] - src[start + clampIndex(k - r, len) * stride];
    }
  }

  function blurPlane(plane, tmp, w, h, sigma) {
    var sizes = boxSizesForGauss(sigma, 3);
    for (var s = 0; s < sizes.length; s++) {
      var r = (sizes[s] - 1) / 2;
      if (r < 1) continue;
      for (var y = 0; y < h; y++) blurLine(plane, tmp, y * w, 1, w, r);
      for (var x = 0; x < w; x++) blurLine(tmp, plane, x, w, h, r);
    }
  }

  function gaussianBlur(img, radius) {
    if (!(radius > 0)) return img;
    var w = img.width, h = img.height, d = img.data, n = w * h;
    var alpha = new Float32Array(n);
    var plane = new Float32Array(n);
    var tmp = new Float32Array(n);
    var i, p;
    var opaque = true;
    for (i = 0; i < n; i++) {
      alpha[i] = d[i * 4 + 3];
      if (alpha[i] !== 255) opaque = false;
    }
    if (!opaque) blurPlane(alpha, tmp, w, h, radius);

    for (var c = 0; c < 3; c++) {
      for (i = 0, p = c; i < n; i++, p += 4) plane[i] = opaque ? d[p] : (d[p] * d[i * 4 + 3]) / 255;
      blurPlane(plane, tmp, w, h, radius);
      for (i = 0, p = c; i < n; i++, p += 4) {
        if (opaque) d[p] = plane[i];
        else d[p] = alpha[i] > 0.001 ? (plane[i] * 255) / alpha[i] : 0;
      }
    }
    if (!opaque) for (i = 0; i < n; i++) d[i * 4 + 3] = alpha[i];
    return img;
  }

  // Máscara de nitidez: amount em %, radius em px, threshold 0–255.
  function unsharpMask(img, amount, radius, thresholdLevel) {
    var blurred = gaussianBlur(cloneImageData(img), radius);
    var k = amount / 100;
    var t = thresholdLevel || 0;
    var d = img.data, b = blurred.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      for (var c = 0; c < 3; c++) {
        var diff = d[i + c] - b[i + c];
        if (Math.abs(diff) >= t) d[i + c] = d[i + c] + diff * k;
      }
    }
    return img;
  }

  // Detecção de bordas (Sobel sobre a luminância).
  function edgeDetect(img) {
    var w = img.width, h = img.height, d = img.data;
    var L = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) L[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    for (var y = 0; y < h; y++) {
      var y0 = y > 0 ? y - 1 : 0, y2 = y < h - 1 ? y + 1 : h - 1;
      for (var x = 0; x < w; x++) {
        var x0 = x > 0 ? x - 1 : 0, x2 = x < w - 1 ? x + 1 : w - 1;
        var tl = L[y0 * w + x0], tc = L[y0 * w + x], tr = L[y0 * w + x2];
        var ml = L[y * w + x0], mr = L[y * w + x2];
        var bl = L[y2 * w + x0], bc = L[y2 * w + x], br = L[y2 * w + x2];
        var gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
        var gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        var v = Math.sqrt(gx * gx + gy * gy);
        var p = (y * w + x) * 4;
        d[p] = d[p + 1] = d[p + 2] = v;
      }
    }
    return img;
  }

  /* ---------------------------------------------------------------- *
   * Histograma e correções automáticas
   * ---------------------------------------------------------------- */

  function histogram(img) {
    var r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    var d = img.data, count = 0;
    for (var i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
      l[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
      count++;
    }
    return { r: r, g: g, b: b, l: l, count: count };
  }

  function percentileBounds(hist, total, clipFraction) {
    var cut = total * clipFraction;
    var lo = 0, hi = 255, acc = 0;
    for (lo = 0; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
    acc = 0;
    for (hi = 255; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
    return [lo, hi];
  }

  function stretchLUT(lo, hi) {
    var lut = new Uint8ClampedArray(256);
    var range = hi - lo;
    for (var v = 0; v < 256; v++) lut[v] = range > 0 ? Math.round(((v - lo) * 255) / range) : v;
    return lut;
  }

  // perChannel=false: contraste automático (preserva as cores).
  // perChannel=true: tom automático (também neutraliza dominantes de cor).
  function autoLevels(img, perChannel, clipPercent) {
    var clip = (clipPercent == null ? 0.1 : clipPercent) / 100;
    var hist = histogram(img);
    if (!hist.count) return img;
    var luts;
    if (perChannel) {
      luts = [hist.r, hist.g, hist.b].map(function (hc) {
        var bounds = percentileBounds(hc, hist.count, clip);
        return stretchLUT(bounds[0], bounds[1]);
      });
    } else {
      var all = new Uint32Array(256);
      for (var v = 0; v < 256; v++) all[v] = hist.r[v] + hist.g[v] + hist.b[v];
      var bounds = percentileBounds(all, hist.count * 3, clip);
      var lut = stretchLUT(bounds[0], bounds[1]);
      luts = [lut, lut, lut];
    }
    var d = img.data;
    for (var i = 0, n = d.length; i < n; i += 4) {
      d[i] = luts[0][d[i]];
      d[i + 1] = luts[1][d[i + 1]];
      d[i + 2] = luts[2][d[i + 2]];
    }
    return img;
  }

  /* ---------------------------------------------------------------- *
   * Balde de tinta
   * ---------------------------------------------------------------- */

  // Devolve uma máscara (1 = preencher) a partir do pixel (sx, sy).
  function floodMask(img, sx, sy, tolerance, contiguous) {
    var w = img.width, h = img.height, d = img.data;
    sx = Math.floor(sx);
    sy = Math.floor(sy);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
    var tol = tolerance || 0;
    var p0 = (sy * w + sx) * 4;
    var tr = d[p0], tg = d[p0 + 1], tb = d[p0 + 2], ta = d[p0 + 3];
    var mask = new Uint8Array(w * h);

    function matches(idx) {
      var q = idx * 4;
      if (ta === 0 && d[q + 3] === 0) return true;
      return (
        Math.abs(d[q] - tr) <= tol &&
        Math.abs(d[q + 1] - tg) <= tol &&
        Math.abs(d[q + 2] - tb) <= tol &&
        Math.abs(d[q + 3] - ta) <= tol
      );
    }

    if (!contiguous) {
      for (var i = 0; i < w * h; i++) if (matches(i)) mask[i] = 1;
      return mask;
    }

    var stack = [sx, sy];
    while (stack.length) {
      var y = stack.pop();
      var x = stack.pop();
      var row = y * w;
      if (mask[row + x] || !matches(row + x)) continue;
      var lx = x, rx = x;
      while (lx > 0 && !mask[row + lx - 1] && matches(row + lx - 1)) lx--;
      while (rx < w - 1 && !mask[row + rx + 1] && matches(row + rx + 1)) rx++;
      for (var xx = lx; xx <= rx; xx++) mask[row + xx] = 1;
      for (var dir = -1; dir <= 1; dir += 2) {
        var ny = y + dir;
        if (ny < 0 || ny >= h) continue;
        var nrow = ny * w, inSpan = false;
        for (xx = lx; xx <= rx; xx++) {
          var j = nrow + xx;
          if (!mask[j] && matches(j)) {
            if (!inSpan) { stack.push(xx, ny); inSpan = true; }
          } else inSpan = false;
        }
      }
    }
    return mask;
  }

  function maskToImageData(mask, width, height, rgb) {
    var out = createImageData(width, height);
    var d = out.data;
    for (var i = 0, n = width * height; i < n; i++) {
      if (!mask[i]) continue;
      var p = i * 4;
      d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 255;
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Cores
   * ---------------------------------------------------------------- */

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      var s = Math.round(clamp(v, 0, 255)).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  return {
    clamp: clamp,
    luma: luma,
    rng: rng,
    createImageData: createImageData,
    cloneImageData: cloneImageData,
    ADJUSTMENTS: ADJUSTMENTS,
    defaultAdjustments: defaultAdjustments,
    isNeutral: isNeutral,
    buildToneLUTs: buildToneLUTs,
    hueMatrix: hueMatrix,
    applyAdjustments: applyAdjustments,
    grayscale: grayscale,
    sepia: sepia,
    invert: invert,
    posterize: posterize,
    threshold: threshold,
    noise: noise,
    pixelate: pixelate,
    vignette: vignette,
    boxSizesForGauss: boxSizesForGauss,
    gaussianBlur: gaussianBlur,
    unsharpMask: unsharpMask,
    edgeDetect: edgeDetect,
    histogram: histogram,
    autoLevels: autoLevels,
    floodMask: floodMask,
    maskToImageData: maskToImageData,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex
  };
});
