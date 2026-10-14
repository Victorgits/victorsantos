/*
 * Retoque — estilo aprendido.
 *
 * Aprende um "look" a partir de pares antes/depois (por exemplo, a foto
 * original e a versão editada no Lightroom que vêm dentro de um DNG) e o
 * aplica em outras fotos.
 *
 * O modelo tem duas partes:
 *  1. Curvas por canal (R, G, B), que capturam tom, contraste e dominante
 *     de cor e valem para qualquer foto.
 *  2. Uma tabela 3D de cores (LUT) com a correção residual de cada cor
 *     (ajustes de HSL, tonalização, saturação por matiz...). Cores que não
 *     aparecem nas referências recebem uma correção suavizada que tende a
 *     zero, então o estilo não inventa mudanças onde não tem informação.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Retoque = root.Retoque || {};
    root.Retoque.style = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GRID = 25;
  var VERSION = 1;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  var LIN = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var v = i / 255;
    LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linToByte(l) {
    l = clamp(l, 0, 1);
    var v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return v * 255;
  }

  // Média geométrica da luminância linear, em EV (log2). Ignora pixels transparentes.
  function logKey(img) {
    var d = img.data, sum = 0, n = 0;
    var step = Math.max(1, Math.floor(d.length / 4 / 200000)) * 4;
    for (var i = 0; i < d.length; i += step) {
      if (d[i + 3] === 0) continue;
      var y = 0.2126 * LIN[d[i]] + 0.7152 * LIN[d[i + 1]] + 0.0722 * LIN[d[i + 2]];
      sum += Math.log(y + 1e-4);
      n++;
    }
    return n ? sum / n / Math.LN2 : 0;
  }

  // Peso espacial: ignora as bordas, onde vinheta e efeitos locais confundem o aprendizado.
  function centerWeight(x, y, w, h) {
    var dx = (x + 0.5) / w * 2 - 1, dy = (y + 0.5) / h * 2 - 1;
    var r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
    return r < 0.62 ? 1 : r > 0.82 ? 0 : (0.82 - r) / 0.2;
  }

  /* ---------------------------------------------------------------- *
   * Curvas por canal
   * ---------------------------------------------------------------- */

  // Regressão isotônica (curva sempre crescente), ponderada.
  function isotonic(values, weights) {
    var n = values.length;
    var val = [], wt = [], len = [];
    for (var i = 0; i < n; i++) {
      val.push(values[i]); wt.push(weights[i]); len.push(1);
      while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
        var w2 = wt.pop(), v2 = val.pop(), l2 = len.pop();
        var k = val.length - 1;
        var wsum = wt[k] + w2;
        val[k] = wsum > 0 ? (val[k] * wt[k] + v2 * w2) / wsum : (val[k] + v2) / 2;
        wt[k] = wsum;
        len[k] += l2;
      }
    }
    var out = new Float32Array(n), p = 0;
    for (var b = 0; b < val.length; b++) for (var j = 0; j < len[b]; j++) out[p++] = val[b];
    return out;
  }

  function fitCurve(sum, cnt) {
    var smoothS = new Float64Array(256), smoothC = new Float64Array(256);
    var sigma = 3, radius = 9;
    var kernel = [];
    for (var k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    var total = 0;
    for (var i = 0; i < 256; i++) total += cnt[i];
    for (i = 0; i < 256; i++) {
      var s = 0, c = 0;
      for (k = -radius; k <= radius; k++) {
        var j = i + k;
        if (j < 0 || j > 255) continue;
        s += kernel[k + radius] * sum[j];
        c += kernel[k + radius] * cnt[j];
      }
      smoothS[i] = s;
      smoothC[i] = c;
    }
    var minCount = total * 2e-5;
    var curve = new Float32Array(256), weight = new Float32Array(256), known = [];
    for (i = 0; i < 256; i++) {
      if (smoothC[i] > minCount) {
        curve[i] = smoothS[i] / smoothC[i];
        weight[i] = smoothC[i];
        known.push(i);
      }
    }
    if (!known.length) {
      for (i = 0; i < 256; i++) curve[i] = i;
      return curve;
    }
    // Fora da faixa observada, mantém o deslocamento da ponta mais próxima,
    // com peso pequeno para não puxar a regressão.
    var first = known[0], last = known[known.length - 1];
    for (i = 0; i < first; i++) { curve[i] = i + (curve[first] - first); weight[i] = 1e-6; }
    for (i = last + 1; i < 256; i++) { curve[i] = i + (curve[last] - last); weight[i] = 1e-6; }
    for (var q = 0; q < known.length - 1; q++) {
      var a = known[q], b = known[q + 1];
      for (i = a + 1; i < b; i++) { curve[i] = curve[a] + (curve[b] - curve[a]) * (i - a) / (b - a); weight[i] = 1e-6; }
    }
    var mono = isotonic(curve, weight);
    for (i = 0; i < 256; i++) mono[i] = clamp(mono[i], 0, 255);
    return mono;
  }

  /* ---------------------------------------------------------------- *
   * Aprendizado
   * ---------------------------------------------------------------- */

  // pairs: [{ before, after }] com imagens do mesmo tamanho (formato ImageData).
  function fitStyle(pairs, options) {
    var opts = options || {};
    var N = opts.grid || GRID;
    var lambda = opts.smoothness == null ? 1 : opts.smoothness;
    var mu = opts.decay == null ? 0.02 : opts.decay;
    if (!pairs.length) throw new Error('Nenhuma referência para aprender.');

    var sums = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    var cnts = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    var keysBefore = [], keysAfter = [];

    // Cada referência pesa o mesmo, independentemente da resolução.
    var pairScale = pairs.map(function (p) {
      var w = p.before.width, h = p.before.height;
      if (p.after.width !== w || p.after.height !== h) throw new Error('Antes e depois precisam ter o mesmo tamanho.');
      var total = 0;
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) total += centerWeight(x, y, w, h);
      return (p.weight == null ? 1 : p.weight) * 100000 / Math.max(1, total);
    });

    pairs.forEach(function (p, idx) {
      var bd = p.before.data, ad = p.after.data, w = p.before.width, h = p.before.height;
      keysBefore.push(logKey(p.before));
      keysAfter.push(logKey(p.after));
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var wt = centerWeight(x, y, w, h) * pairScale[idx];
          if (!wt) continue;
          var o = (y * w + x) * 4;
          if (bd[o + 3] < 255 || ad[o + 3] < 255) continue;
          for (var c = 0; c < 3; c++) {
            sums[c][bd[o + c]] += wt * ad[o + c];
            cnts[c][bd[o + c]] += wt;
          }
        }
      }
    });
    var curves = [fitCurve(sums[0], cnts[0]), fitCurve(sums[1], cnts[1]), fitCurve(sums[2], cnts[2])];

    // Correção residual por cor, espalhada na grade com pesos trilineares.
    var nodes = N * N * N;
    var W = new Float64Array(nodes), S = new Float64Array(nodes * 3);
    var scale = (N - 1) / 255;
    pairs.forEach(function (p, idx) {
      var bd = p.before.data, ad = p.after.data, w = p.before.width, h = p.before.height;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var wt = centerWeight(x, y, w, h) * pairScale[idx];
          if (!wt) continue;
          var o = (y * w + x) * 4;
          if (bd[o + 3] < 255 || ad[o + 3] < 255) continue;
          var r = bd[o], g = bd[o + 1], b = bd[o + 2];
          var res0 = ad[o] - curves[0][r], res1 = ad[o + 1] - curves[1][g], res2 = ad[o + 2] - curves[2][b];
          var fr = r * scale, fg = g * scale, fb = b * scale;
          var ir = Math.min(N - 2, Math.floor(fr)), ig = Math.min(N - 2, Math.floor(fg)), ib = Math.min(N - 2, Math.floor(fb));
          var tr = fr - ir, tg = fg - ig, tb = fb - ib;
          for (var k = 0; k < 8; k++) {
            var dr = k & 1, dg = (k >> 1) & 1, db = (k >> 2) & 1;
            var ww = wt * (dr ? tr : 1 - tr) * (dg ? tg : 1 - tg) * (db ? tb : 1 - tb);
            if (!ww) continue;
            var n = ((ir + dr) * N + (ig + dg)) * N + (ib + db);
            W[n] += ww;
            S[n * 3] += ww * res0;
            S[n * 3 + 1] += ww * res1;
            S[n * 3 + 2] += ww * res2;
          }
        }
      }
    });

    // Normaliza os pesos (média 1 por nó) para que a suavização tenha o mesmo efeito sempre.
    var totalW = 0;
    for (var n = 0; n < nodes; n++) totalW += W[n];
    var norm = totalW > 0 ? nodes / totalW : 0;
    var R = new Float32Array(nodes * 3);
    for (n = 0; n < nodes; n++) {
      W[n] *= norm;
      S[n * 3] *= norm; S[n * 3 + 1] *= norm; S[n * 3 + 2] *= norm;
      if (W[n] > 0) {
        R[n * 3] = S[n * 3] / W[n]; R[n * 3 + 1] = S[n * 3 + 1] / W[n]; R[n * 3 + 2] = S[n * 3 + 2] / W[n];
      }
    }

    // Gauss-Seidel: dados nos nós observados, suavidade entre vizinhos e
    // decaimento leve para zero onde não há informação.
    var iterations = opts.iterations || 160;
    var NN = N * N;
    for (var it = 0; it < iterations; it++) {
      for (var ri = 0; ri < N; ri++) {
        for (var gi = 0; gi < N; gi++) {
          for (var bi = 0; bi < N; bi++) {
            n = (ri * N + gi) * N + bi;
            var deg = 0, s0 = 0, s1 = 0, s2 = 0, m;
            if (ri > 0) { m = (n - NN) * 3; s0 += R[m]; s1 += R[m + 1]; s2 += R[m + 2]; deg++; }
            if (ri < N - 1) { m = (n + NN) * 3; s0 += R[m]; s1 += R[m + 1]; s2 += R[m + 2]; deg++; }
            if (gi > 0) { m = (n - N) * 3; s0 += R[m]; s1 += R[m + 1]; s2 += R[m + 2]; deg++; }
            if (gi < N - 1) { m = (n + N) * 3; s0 += R[m]; s1 += R[m + 1]; s2 += R[m + 2]; deg++; }
            if (bi > 0) { m = (n - 1) * 3; s0 += R[m]; s1 += R[m + 1]; s2 += R[m + 2]; deg++; }
            if (bi < N - 1) { m = (n + 1) * 3; s0 += R[m]; s1 += R[m + 1]; s2 += R[m + 2]; deg++; }
            var den = W[n] + lambda * deg + mu;
            R[n * 3] = (S[n * 3] + lambda * s0) / den;
            R[n * 3 + 1] = (S[n * 3 + 1] + lambda * s1) / den;
            R[n * 3 + 2] = (S[n * 3 + 2] + lambda * s2) / den;
          }
        }
      }
    }

    var mean = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
    return {
      version: VERSION,
      grid: N,
      curves: curves,
      residual: R,
      targetKey: mean(keysAfter),
      exposureShift: mean(keysAfter) - mean(keysBefore),
      references: pairs.length
    };
  }

  /* ---------------------------------------------------------------- *
   * Aplicação
   * ---------------------------------------------------------------- */

  // Tabela de exposição em luz linear (EV), aplicada antes do estilo.
  function exposureTable(ev) {
    var t = new Float32Array(256);
    var gain = Math.pow(2, ev || 0);
    for (var i = 0; i < 256; i++) t[i] = gain === 1 ? i : linToByte(LIN[i] * gain);
    return t;
  }

  function applyStyle(img, style, options) {
    var opts = options || {};
    var strength = opts.strength == null ? 1 : opts.strength;
    var N = style.grid, R = style.residual, curves = style.curves;
    var NN = N * N;
    var pre = exposureTable(opts.exposure || 0);
    var scale = (N - 1) / 255;

    // Para cada valor de entrada (0–255 com 4 subníveis), índice na grade e fração.
    var LEVELS = 1024;
    var idx = new Int32Array(LEVELS), frac = new Float32Array(LEVELS), cv = [new Float32Array(LEVELS), new Float32Array(LEVELS), new Float32Array(LEVELS)];
    for (var q = 0; q < LEVELS; q++) {
      var vin = (q / (LEVELS - 1)) * 255;
      var f = vin * scale, i0 = Math.min(N - 2, Math.floor(f));
      idx[q] = i0;
      frac[q] = f - i0;
      var lo = Math.floor(vin), hi = Math.min(255, lo + 1), t = vin - lo;
      for (var c = 0; c < 3; c++) cv[c][q] = curves[c][lo] + (curves[c][hi] - curves[c][lo]) * t;
    }
    var preQ = new Int32Array(256);
    for (var p = 0; p < 256; p++) preQ[p] = Math.round((clamp(pre[p], 0, 255) / 255) * (LEVELS - 1));

    var d = img.data;
    var sR = NN * 3, sG = N * 3, sB = 3;
    for (var o = 0, len = d.length; o < len; o += 4) {
      var r0 = d[o], g0 = d[o + 1], b0 = d[o + 2];
      var qr = preQ[r0], qg = preQ[g0], qb = preQ[b0];
      var ir = idx[qr], ig = idx[qg], ib = idx[qb];
      var fx = frac[qr], fy = frac[qg], fz = frac[qb];
      var base = (ir * NN + ig * N + ib) * 3;
      // Interpolação tetraédrica: 4 nós por amostra.
      var w0, w1, w2, w3, n1, n2;
      if (fx > fy) {
        if (fy > fz) { w0 = 1 - fx; w1 = fx - fy; w2 = fy - fz; w3 = fz; n1 = sR; n2 = sR + sG; }
        else if (fx > fz) { w0 = 1 - fx; w1 = fx - fz; w2 = fz - fy; w3 = fy; n1 = sR; n2 = sR + sB; }
        else { w0 = 1 - fz; w1 = fz - fx; w2 = fx - fy; w3 = fy; n1 = sB; n2 = sR + sB; }
      } else {
        if (fz > fy) { w0 = 1 - fz; w1 = fz - fy; w2 = fy - fx; w3 = fx; n1 = sB; n2 = sG + sB; }
        else if (fz > fx) { w0 = 1 - fy; w1 = fy - fz; w2 = fz - fx; w3 = fx; n1 = sG; n2 = sG + sB; }
        else { w0 = 1 - fy; w1 = fy - fx; w2 = fx - fz; w3 = fz; n1 = sG; n2 = sR + sG; }
      }
      var n3 = sR + sG + sB;
      var a = base, b1 = base + n1, b2 = base + n2, b3 = base + n3;
      var outR = cv[0][qr] + w0 * R[a] + w1 * R[b1] + w2 * R[b2] + w3 * R[b3];
      var outG = cv[1][qg] + w0 * R[a + 1] + w1 * R[b1 + 1] + w2 * R[b2 + 1] + w3 * R[b3 + 1];
      var outB = cv[2][qb] + w0 * R[a + 2] + w1 * R[b1 + 2] + w2 * R[b2 + 2] + w3 * R[b3 + 2];
      if (strength !== 1) {
        outR = r0 + (outR - r0) * strength;
        outG = g0 + (outG - g0) * strength;
        outB = b0 + (outB - b0) * strength;
      }
      d[o] = outR;
      d[o + 1] = outG;
      d[o + 2] = outB;
    }
    return img;
  }

  // Exposição automática: aproxima o brilho médio do resultado daquele que
  // as fotos de referência têm depois de editadas. amount 0–1 controla quanto.
  function autoExposure(sample, style, amount, copy) {
    var k = amount == null ? 0.6 : amount;
    if (!k) return 0;
    var trial = copy(sample);
    applyStyle(trial, style, { exposure: 0 });
    var ev = clamp(k * (style.targetKey - logKey(trial)), -1.5, 1.5);
    return Math.round(ev * 100) / 100;
  }

  /* ---------------------------------------------------------------- *
   * Gravação em arquivo (.json)
   * ---------------------------------------------------------------- */

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(str) {
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    var s = atob(str), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function serialize(style, extra) {
    var curves = new Uint16Array(768);
    for (var c = 0; c < 3; c++) for (var i = 0; i < 256; i++) curves[c * 256 + i] = Math.round(clamp(style.curves[c][i], 0, 255) * 256);
    var res = new Int16Array(style.residual.length);
    for (i = 0; i < res.length; i++) res[i] = Math.round(clamp(style.residual[i], -255, 255) * 64);
    return Object.assign({
      app: 'retoque',
      kind: 'style',
      version: VERSION,
      grid: style.grid,
      targetKey: Math.round(style.targetKey * 1000) / 1000,
      exposureShift: Math.round(style.exposureShift * 1000) / 1000,
      references: style.references,
      curves: toBase64(new Uint8Array(curves.buffer)),
      residual: toBase64(new Uint8Array(res.buffer))
    }, extra || {});
  }

  function deserialize(data) {
    if (!data || data.app !== 'retoque' || data.kind !== 'style') throw new Error('o arquivo não é um estilo do Retoque');
    var N = Number(data.grid);
    if (!(N >= 2 && N <= 65)) throw new Error('grade de cores inválida');
    var cb = fromBase64(String(data.curves)), rb = fromBase64(String(data.residual));
    if (cb.length !== 1536 || rb.length !== N * N * N * 6) throw new Error('dados do estilo incompletos');
    var cu = new Uint16Array(cb.buffer, cb.byteOffset, 768);
    var rs = new Int16Array(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.length));
    var curves = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (var c = 0; c < 3; c++) for (var i = 0; i < 256; i++) curves[c][i] = cu[c * 256 + i] / 256;
    var residual = new Float32Array(rs.length);
    for (i = 0; i < rs.length; i++) residual[i] = rs[i] / 64;
    return {
      version: data.version,
      grid: N,
      curves: curves,
      residual: residual,
      targetKey: Number(data.targetKey) || 0,
      exposureShift: Number(data.exposureShift) || 0,
      references: Number(data.references) || 0
    };
  }

  return {
    GRID: GRID,
    logKey: logKey,
    fitStyle: fitStyle,
    applyStyle: applyStyle,
    autoExposure: autoExposure,
    exposureTable: exposureTable,
    serialize: serialize,
    deserialize: deserialize,
    isotonic: isotonic
  };
});
