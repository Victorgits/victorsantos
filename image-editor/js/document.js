/*
 * Retoque — documento, camadas e utilitários de canvas.
 *
 * Regra de ouro: o canvas de uma camada nunca é modificado no lugar.
 * Toda edição cria um canvas novo e troca a referência; é isso que
 * permite ao histórico guardar estados apenas por referência.
 */
(function () {
  'use strict';
  var R = (window.Retoque = window.Retoque || {});
  var nextLayerId = 1;

  /* ---------------------------------------------------------------- *
   * Canvas
   * ---------------------------------------------------------------- */

  function createCanvas(width, height) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    return c;
  }

  function cloneCanvas(src) {
    var c = createCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  function canvasFromImageData(img) {
    var c = createCanvas(img.width, img.height);
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function flipCanvas(src, horizontal) {
    var c = createCanvas(src.width, src.height);
    var ctx = c.getContext('2d');
    if (horizontal) {
      ctx.translate(src.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, src.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(src, 0, 0);
    return c;
  }

  // turns: 1 = 90° horário, -1 = 90° anti-horário, 2 = 180°.
  function rotateCanvas(src, turns) {
    var swap = turns !== 2;
    var c = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
    var ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  // Redimensiona com boa qualidade: reduções grandes são feitas em etapas
  // de 50% para evitar serrilhado.
  function resampleCanvas(src, width, height, method) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (method === 'nearest') {
      var n = createCanvas(width, height);
      var nctx = n.getContext('2d');
      nctx.imageSmoothingEnabled = false;
      nctx.drawImage(src, 0, 0, width, height);
      return n;
    }
    var cur = src;
    while (cur.width / 2 >= width && cur.height / 2 >= height) {
      var half = createCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
      var hctx = half.getContext('2d');
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    var out = createCanvas(width, height);
    var octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cur, 0, 0, width, height);
    return out;
  }

  // Escala e gira em torno do centro. Devolve o novo canvas e o
  // deslocamento do canto superior esquerdo em relação ao original.
  function transformCanvas(src, scaleX, scaleY, angleDeg, smooth) {
    var a = (angleDeg * Math.PI) / 180;
    var w = src.width * Math.abs(scaleX), h = src.height * Math.abs(scaleY);
    var cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    var bw = Math.ceil(w * cos + h * sin), bh = Math.ceil(w * sin + h * cos);
    var c = createCanvas(bw, bh);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = smooth !== false;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(bw / 2, bh / 2);
    ctx.rotate(a);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return {
      canvas: c,
      dx: Math.round(src.width / 2 - bw / 2),
      dy: Math.round(src.height / 2 - bh / 2)
    };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Falha ao codificar a imagem.'));
      }, type, quality);
    });
  }

  /* ---------------------------------------------------------------- *
   * Texto
   * ---------------------------------------------------------------- */

  var FONT_STACKS = {
    'Instrument Sans': '"Instrument Sans", system-ui, sans-serif',
    'Bricolage Grotesque': '"Bricolage Grotesque", system-ui, sans-serif',
    'JetBrains Mono': '"JetBrains Mono", ui-monospace, monospace',
    Arial: 'Arial, Helvetica, sans-serif',
    Georgia: 'Georgia, "Times New Roman", serif',
    'Times New Roman': '"Times New Roman", Times, serif',
    Verdana: 'Verdana, Geneva, sans-serif',
    'Trebuchet MS': '"Trebuchet MS", sans-serif',
    Impact: 'Impact, "Arial Narrow Bold", sans-serif',
    'Courier New': '"Courier New", Courier, monospace'
  };

  function fontStack(family) {
    return FONT_STACKS[family] || family + ', sans-serif';
  }

  function textFont(t) {
    return (t.italic ? 'italic ' : '') + (t.bold ? '700 ' : '400 ') + t.size + 'px ' + fontStack(t.family);
  }

  var LINE_HEIGHT = 1.2;

  // Desenha o texto num canvas justo. pad dá folga para itálicos e acentos.
  function renderText(t) {
    var measure = createCanvas(1, 1).getContext('2d');
    measure.font = textFont(t);
    var lines = String(t.content).split('\n');
    var widths = lines.map(function (line) { return measure.measureText(line).width; });
    var maxW = Math.max.apply(null, widths.concat([1]));
    var lineH = t.size * LINE_HEIGHT;
    var probe = measure.measureText('ÁÇgjy');
    var ascent = probe.fontBoundingBoxAscent || t.size * 0.8;
    var descent = probe.fontBoundingBoxDescent || t.size * 0.2;
    var pad = Math.ceil(t.size * 0.25) + 2;
    var c = createCanvas(Math.ceil(maxW) + pad * 2, Math.ceil(lines.length * lineH) + pad * 2);
    var ctx = c.getContext('2d');
    ctx.font = textFont(t);
    ctx.fillStyle = t.color;
    ctx.textBaseline = 'alphabetic';
    var lead = (lineH - (ascent + descent)) / 2;
    lines.forEach(function (line, i) {
      var x = pad;
      if (t.align === 'center') x += (maxW - widths[i]) / 2;
      else if (t.align === 'right') x += maxW - widths[i];
      ctx.fillText(line, x, pad + i * lineH + lead + ascent);
    });
    return { canvas: c, pad: pad };
  }

  /* ---------------------------------------------------------------- *
   * Camada
   * ---------------------------------------------------------------- */

  function Layer(opts) {
    this.id = nextLayerId++;
    this.name = opts.name || 'Camada ' + this.id;
    this.canvas = opts.canvas;
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.opacity = opts.opacity == null ? 1 : opts.opacity;
    this.blend = opts.blend || 'source-over';
    this.visible = opts.visible !== false;
    this.text = opts.text || null; // camada de texto editável
    this.preview = null; // { canvas, x, y } durante pré-visualizações
    this.live = null; // traço em andamento { canvas, mode, opacity, clip }
    this.editing = false; // escondida enquanto o texto é editado
  }

  Object.defineProperty(Layer.prototype, 'width', { get: function () { return this.canvas.width; } });
  Object.defineProperty(Layer.prototype, 'height', { get: function () { return this.canvas.height; } });

  Layer.prototype.contains = function (x, y) {
    return x >= this.x && y >= this.y && x < this.x + this.width && y < this.y + this.height;
  };

  Layer.prototype.alphaAt = function (x, y) {
    var lx = Math.floor(x - this.x), ly = Math.floor(y - this.y);
    if (lx < 0 || ly < 0 || lx >= this.width || ly >= this.height) return 0;
    return this.canvas.getContext('2d').getImageData(lx, ly, 1, 1).data[3];
  };

  // Origem do texto (canto da caixa de texto, sem a folga).
  Layer.prototype.textOrigin = function () {
    var pad = Math.ceil(this.text.size * 0.25) + 2;
    return { x: this.x + pad, y: this.y + pad };
  };

  /* ---------------------------------------------------------------- *
   * Documento
   * ---------------------------------------------------------------- */

  var scratch = null;

  function drawLive(ctx, live) {
    ctx.save();
    if (live.clip) {
      ctx.beginPath();
      ctx.rect(live.clip.x, live.clip.y, live.clip.w, live.clip.h);
      ctx.clip();
    }
    ctx.globalAlpha = live.opacity;
    ctx.globalCompositeOperation = live.mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.drawImage(live.canvas, 0, 0);
    ctx.restore();
  }

  // Funde o traço em andamento numa cópia do canvas da camada.
  function mergeLive(layer) {
    var c = cloneCanvas(layer.canvas);
    drawLive(c.getContext('2d'), layer.live);
    return c;
  }

  function Doc(width, height, name) {
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.name = name || 'Sem título';
    this.layers = [];
    this.active = null;
    this.selection = null;
  }

  Doc.prototype.indexOf = function (layer) {
    return this.layers.indexOf(layer);
  };

  Doc.prototype.addLayer = function (layer, index) {
    if (index == null) index = this.active ? this.indexOf(this.active) + 1 : this.layers.length;
    this.layers.splice(index, 0, layer);
    this.active = layer;
    return layer;
  };

  Doc.prototype.removeLayer = function (layer) {
    var i = this.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (this.active === layer) this.active = this.layers[Math.min(i, this.layers.length - 1)] || this.layers[i - 1] || null;
  };

  Doc.prototype.blankLayer = function (name) {
    return new Layer({ name: name, canvas: createCanvas(this.width, this.height) });
  };

  Doc.prototype.layerSource = function (layer) {
    if (layer.preview) return layer.preview;
    if (layer.live) {
      if (!scratch) scratch = createCanvas(1, 1);
      if (scratch.width !== layer.width || scratch.height !== layer.height) {
        scratch.width = layer.width;
        scratch.height = layer.height;
      }
      var ctx = scratch.getContext('2d');
      ctx.clearRect(0, 0, scratch.width, scratch.height);
      ctx.drawImage(layer.canvas, 0, 0);
      drawLive(ctx, layer.live);
      return { canvas: scratch, x: layer.x, y: layer.y };
    }
    return { canvas: layer.canvas, x: layer.x, y: layer.y };
  };

  Doc.prototype.drawLayers = function (ctx, layers) {
    var list = layers || this.layers;
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (!l.visible || l.editing || l.opacity <= 0) continue;
      var src = this.layerSource(l);
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend;
      ctx.drawImage(src.canvas, src.x, src.y);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };

  // Imagem achatada do tamanho do documento.
  Doc.prototype.flatten = function (background) {
    var c = createCanvas(this.width, this.height);
    var ctx = c.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    this.drawLayers(ctx);
    return c;
  };

  Doc.prototype.snapshot = function () {
    var sel = this.selection;
    return {
      width: this.width,
      height: this.height,
      name: this.name,
      selection: sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : null,
      activeId: this.active ? this.active.id : null,
      layers: this.layers.map(function (l) {
        return {
          layer: l,
          canvas: l.canvas,
          name: l.name,
          x: l.x,
          y: l.y,
          opacity: l.opacity,
          blend: l.blend,
          visible: l.visible,
          text: l.text ? Object.assign({}, l.text) : null
        };
      })
    };
  };

  Doc.prototype.restore = function (s) {
    this.width = s.width;
    this.height = s.height;
    this.name = s.name;
    this.selection = s.selection ? Object.assign({}, s.selection) : null;
    this.layers = s.layers.map(function (e) {
      var l = e.layer;
      l.canvas = e.canvas;
      l.name = e.name;
      l.x = e.x;
      l.y = e.y;
      l.opacity = e.opacity;
      l.blend = e.blend;
      l.visible = e.visible;
      l.text = e.text ? Object.assign({}, e.text) : null;
      l.preview = null;
      l.live = null;
      l.editing = false;
      return l;
    });
    var id = s.activeId;
    this.active = this.layers.filter(function (l) { return l.id === id; })[0] || this.layers[this.layers.length - 1] || null;
  };

  Doc.measure = function (state) {
    return state.layers.map(function (e) {
      return [e.canvas, e.canvas.width * e.canvas.height * 4];
    });
  };

  R.Layer = Layer;
  R.Doc = Doc;
  R.canvas = {
    create: createCanvas,
    clone: cloneCanvas,
    fromImageData: canvasFromImageData,
    flip: flipCanvas,
    rotate: rotateCanvas,
    resample: resampleCanvas,
    transform: transformCanvas,
    toBlob: canvasToBlob,
    mergeLive: mergeLive
  };
  R.text = {
    FONTS: Object.keys(FONT_STACKS),
    LINE_HEIGHT: LINE_HEIGHT,
    fontStack: fontStack,
    font: textFont,
    render: renderText
  };
})();
