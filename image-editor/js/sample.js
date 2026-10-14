/*
 * Retoque — imagem de exemplo gerada por código (lago ao entardecer),
 * para o editor abrir já com algo para editar, sem baixar arquivos.
 */
(function () {
  'use strict';
  var R = (window.Retoque = window.Retoque || {});

  // Linha de cumeeira por deslocamento do ponto médio.
  function ridge(rand, segments, roughness) {
    var pts = new Float32Array(segments + 1);
    pts[0] = rand();
    pts[segments] = rand();
    var step = segments, amp = 1;
    while (step > 1) {
      var half = step / 2;
      for (var i = half; i < segments; i += step) {
        pts[i] = (pts[i - half] + pts[i + half]) / 2 + (rand() - 0.5) * amp;
      }
      step = half;
      amp *= roughness;
    }
    return pts;
  }

  function drawRange(ctx, rand, w, base, height, color, roughness) {
    var pts = ridge(rand, 256, roughness);
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < pts.length; i++) { min = Math.min(min, pts[i]); max = Math.max(max, pts[i]); }
    ctx.beginPath();
    ctx.moveTo(0, base + 2);
    for (i = 0; i < pts.length; i++) {
      var t = (pts[i] - min) / (max - min || 1);
      ctx.lineTo((i / (pts.length - 1)) * w, base - t * height);
    }
    ctx.lineTo(w, base + 2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  R.createSampleCanvas = function (width, height) {
    var w = width || 1600, h = height || 1067;
    var rand = R.ops.rng(20261014);
    var c = R.canvas.create(w, h);
    var ctx = c.getContext('2d');
    var horizon = Math.round(h * 0.6);

    // Céu
    var sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#1c2550');
    sky.addColorStop(0.42, '#5b4f86');
    sky.addColorStop(0.78, '#e2876f');
    sky.addColorStop(1, '#f7c58c');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon + 4);

    // Sol e brilho
    var sx = w * 0.64, sy = horizon - h * 0.07;
    var glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.42);
    glow.addColorStop(0, 'rgba(255, 228, 180, 0.95)');
    glow.addColorStop(0.18, 'rgba(255, 190, 130, 0.45)');
    glow.addColorStop(1, 'rgba(255, 160, 120, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, horizon + 4);
    ctx.beginPath();
    ctx.arc(sx, sy, h * 0.042, 0, Math.PI * 2);
    ctx.fillStyle = '#fff4dc';
    ctx.fill();

    // Nuvens finas
    for (var i = 0; i < 14; i++) {
      var cx = rand() * w, cy = h * (0.12 + rand() * 0.3);
      var rw = w * (0.08 + rand() * 0.16), rh = h * (0.008 + rand() * 0.014);
      var cloud = ctx.createRadialGradient(cx, cy, 0, cx, cy, rw);
      cloud.addColorStop(0, 'rgba(255, 200, 190, 0.28)');
      cloud.addColorStop(1, 'rgba(255, 200, 190, 0)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, rh / rw);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = cloud;
      ctx.fillRect(cx - rw, cy - rw, rw * 2, rw * 2);
      ctx.restore();
    }

    // Montanhas, do fundo para a frente
    drawRange(ctx, rand, w, horizon, h * 0.2, '#8d6f95', 0.55);
    drawRange(ctx, rand, w, horizon, h * 0.15, '#5e4a73', 0.58);
    drawRange(ctx, rand, w, horizon, h * 0.09, '#382d4f', 0.62);

    // Lago: reflexo espelhado do céu e das montanhas
    var reflH = h - horizon;
    ctx.fillStyle = '#231d3a';
    ctx.fillRect(0, horizon, w, reflH);
    ctx.save();
    ctx.translate(0, horizon * 2);
    ctx.scale(1, -1);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(c, 0, horizon - reflH, w, reflH, 0, horizon - reflH, w, reflH);
    ctx.restore();
    var water = ctx.createLinearGradient(0, horizon, 0, h);
    water.addColorStop(0, 'rgba(30, 32, 70, 0.25)');
    water.addColorStop(1, 'rgba(14, 16, 40, 0.85)');
    ctx.fillStyle = water;
    ctx.fillRect(0, horizon, w, reflH);

    // Ondulações claras sob o sol
    for (i = 0; i < 90; i++) {
      var ry = horizon + Math.pow(rand(), 1.6) * reflH * 0.75;
      var spread = 0.04 + ((ry - horizon) / reflH) * 0.25;
      var rx = sx + (rand() - 0.5) * w * spread;
      var len = w * (0.01 + rand() * 0.05);
      ctx.fillStyle = 'rgba(255, 222, 180,' + (0.15 + rand() * 0.35).toFixed(2) + ')';
      ctx.fillRect(rx - len / 2, ry, len, 1 + rand() * 1.5);
    }

    // Margem em primeiro plano com capim
    ctx.fillStyle = '#120f1d';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, h * 0.86);
    ctx.bezierCurveTo(w * 0.18, h * 0.83, w * 0.3, h * 0.93, w * 0.46, h * 0.95);
    ctx.lineTo(w * 0.46, h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#120f1d';
    ctx.lineCap = 'round';
    for (i = 0; i < 260; i++) {
      var gx = rand() * w * 0.45;
      var gy = h * 0.86 + (gx / (w * 0.45)) * h * 0.08 + rand() * 6;
      var gh = h * (0.02 + rand() * 0.06);
      ctx.lineWidth = 1 + rand() * 1.5;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + (rand() - 0.3) * 10, gy - gh * 0.6, gx + (rand() - 0.2) * 22, gy - gh);
      ctx.stroke();
    }

    // Granulação de filme
    var img = ctx.getImageData(0, 0, w, h);
    R.ops.noise(img, 5, true, 7);
    ctx.putImageData(img, 0, 0);
    return c;
  };
})();
