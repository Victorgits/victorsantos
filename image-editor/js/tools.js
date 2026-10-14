/*
 * Retoque — ferramentas.
 *
 * Cada ferramenta recebe pontos em coordenadas do documento
 * ({ x, y, sx, sy, pressure, pen }) e fala com o resto do editor
 * apenas através de Retoque.app.
 */
(function () {
  'use strict';
  var R = (window.Retoque = window.Retoque || {});
  var ops = R.ops;

  function app() { return R.app; }
  function settings(id) { return R.app.settings[id]; }

  function svg(paths) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
  }

  function clampToDoc(p, doc) {
    return { x: Math.max(0, Math.min(doc.width, p.x)), y: Math.max(0, Math.min(doc.height, p.y)) };
  }

  function normRect(x0, y0, x1, y1) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  function roundRect(r) {
    var x = Math.round(r.x), y = Math.round(r.y);
    return { x: x, y: y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
  }

  function rgba(hex, a) {
    var c = ops.hexToRgb(hex) || [0, 0, 0];
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  // Encaixa o ângulo em múltiplos de 45°.
  function snapAngle(start, p) {
    var dx = p.x - start.x, dy = p.y - start.y;
    var len = Math.hypot(dx, dy);
    var a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len };
  }

  /* ---------------------------------------------------------------- *
   * Conta-gotas (também usado com Alt nas ferramentas de pintura)
   * ---------------------------------------------------------------- */

  function sampleColor(p, size) {
    var a = app(), doc = a.doc;
    var x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
    if (a.view.compDirty) a.view.updateComposite(doc);
    var r = Math.floor(((size || 1) - 1) / 2);
    var x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
    var x1 = Math.min(doc.width, x + r + 1), y1 = Math.min(doc.height, y + r + 1);
    var data = a.view.comp.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
    var tr = 0, tg = 0, tb = 0, ta = 0;
    for (var i = 0; i < data.length; i += 4) {
      var al = data[i + 3];
      tr += data[i] * al; tg += data[i + 1] * al; tb += data[i + 2] * al; ta += al;
    }
    if (!ta) return null;
    return ops.rgbToHex(tr / ta, tg / ta, tb / ta);
  }

  function pickInto(p, secondary, size) {
    var hex = sampleColor(p, size);
    if (hex) app().setColor(secondary ? 'secondary' : 'primary', hex);
    return hex;
  }

  /* ---------------------------------------------------------------- *
   * Pincel e borracha
   * ---------------------------------------------------------------- */

  var tipCache = { key: '', canvas: null };

  function brushTip(size, hardness, color) {
    var key = size + '|' + hardness + '|' + color;
    if (tipCache.key === key) return tipCache.canvas;
    var d = Math.max(1, size), r = d / 2;
    var dim = Math.ceil(d) + 2;
    var c = R.canvas.create(dim, dim);
    var ctx = c.getContext('2d');
    var cx = dim / 2, h = hardness / 100;
    if (h >= 0.99 || d <= 3) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      var g = ctx.createRadialGradient(cx, cx, 0, cx, cx, r);
      g.addColorStop(0, rgba(color, 1));
      g.addColorStop(h, rgba(color, 1));
      for (var k = 1; k < 6; k++) {
        var t = k / 6;
        g.addColorStop(h + (1 - h) * t, rgba(color, (0.5 * (1 + Math.cos(Math.PI * t))).toFixed(3)));
      }
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, dim, dim);
    }
    tipCache = { key: key, canvas: c };
    return c;
  }

  function makePaintTool(def) {
    var tool = {
      id: def.id,
      label: def.label,
      key: def.key,
      icon: def.icon,
      cursor: 'crosshair',
      coalesce: true,
      hint: def.hint,
      options: [
        { type: 'range', key: 'size', label: 'Tamanho', min: 1, max: 500, step: 1, unit: 'px' },
        { type: 'range', key: 'hardness', label: 'Dureza', min: 0, max: 100, step: 1, unit: '%' },
        { type: 'range', key: 'opacity', label: 'Opacidade', min: 1, max: 100, step: 1, unit: '%' },
        { type: 'check', key: 'pressure', label: 'Pressão da caneta' }
      ],
      stroke: null,
      lastPoint: null,
      lastLayer: null,

      down: function (p, e) {
        if (def.mode === 'paint' && e.altKey) { pickInto(p, false, 1); return false; }
        var a = app();
        var layer = a.editableLayer();
        if (!layer) return false;
        var s = settings(def.id);
        var live = {
          canvas: R.canvas.create(layer.width, layer.height),
          mode: def.mode,
          opacity: s.opacity / 100,
          clip: a.selectionClip(layer)
        };
        layer.live = live;
        this.stroke = {
          layer: layer,
          ctx: live.canvas.getContext('2d'),
          last: null,
          carry: 0,
          tip: brushTip(s.size, s.hardness, def.mode === 'erase' ? '#000000' : a.colors.primary),
          size: s.size,
          pressure: s.pressure
        };
        if (e.shiftKey && this.lastPoint && this.lastLayer === layer) {
          this.stroke.last = this.lastPoint;
          this.segment(this.lastPoint, p);
        } else {
          this.stamp(p);
          this.stroke.last = p;
        }
        a.markDirty();
        return true;
      },

      scale: function (p) {
        return this.stroke.pressure && p.pen ? Math.max(0.05, p.pressure) : 1;
      },

      stamp: function (p) {
        var st = this.stroke, layer = st.layer;
        var dim = st.tip.width * this.scale(p);
        st.ctx.drawImage(st.tip, p.x - layer.x - dim / 2, p.y - layer.y - dim / 2, dim, dim);
      },

      segment: function (from, to) {
        var st = this.stroke;
        var dx = to.x - from.x, dy = to.y - from.y;
        var dist = Math.hypot(dx, dy);
        var spacing = Math.max(0.5, st.size * 0.1 * this.scale(to));
        var t = st.carry || spacing;
        while (t <= dist) {
          var k = t / dist;
          this.stamp({
            x: from.x + dx * k,
            y: from.y + dy * k,
            pressure: from.pressure + (to.pressure - from.pressure) * k,
            pen: to.pen
          });
          t += spacing;
        }
        st.carry = t - dist;
      },

      move: function (p) {
        if (!this.stroke) return;
        this.segment(this.stroke.last, p);
        this.stroke.last = p;
        app().markDirty();
      },

      up: function () {
        var st = this.stroke;
        if (!st) return;
        var layer = st.layer;
        layer.canvas = R.canvas.mergeLive(layer);
        layer.live = null;
        layer.text = null;
        this.lastPoint = st.last;
        this.lastLayer = layer;
        this.stroke = null;
        app().commit(def.label);
      },

      cancel: function () {
        if (!this.stroke) return;
        this.stroke.layer.live = null;
        this.stroke = null;
        app().markDirty();
      },

      overlay: function (ctx, view) {
        var p = app().pointer;
        if (!p || !p.inside) return;
        var s = settings(def.id);
        var r = (s.size * view.zoom) / 2;
        if (r < 2) return;
        var c = view.docToScreen(p.x, p.y);
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, r - 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    };
    return tool;
  }

  var brush = makePaintTool({
    id: 'brush',
    label: 'Pincel',
    key: 'b',
    mode: 'paint',
    hint: 'Arraste para pintar. Shift+clique traça uma reta desde o último ponto. Alt+clique copia a cor.',
    icon: svg('<path d="M14.5 4.5l5 5-7.5 7.5-5-5z"/><path d="M7 12l-2.6 2.6a2.5 2.5 0 0 0 0 3.5L6 19.6a2.5 2.5 0 0 0 3.5 0L12 17"/><path d="M4.5 20.5L6 19"/>')
  });

  var eraser = makePaintTool({
    id: 'eraser',
    label: 'Borracha',
    key: 'e',
    mode: 'erase',
    hint: 'Arraste para apagar e deixar transparente. Shift+clique apaga em linha reta.',
    icon: svg('<path d="M8.5 19.5h11"/><path d="M4.9 15.1l9.2-9.2a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8l-8.6 8.6H9.3l-4.4-4.4z"/><path d="M9.5 10.5l5 5"/>')
  });

  /* ---------------------------------------------------------------- *
   * Mover
   * ---------------------------------------------------------------- */

  var move = {
    id: 'move',
    label: 'Mover',
    key: 'v',
    cursor: 'move',
    hint: 'Arraste para mover a camada ativa. Shift trava o eixo; Ctrl+clique escolhe a camada sob o cursor; setas movem 1 px.',
    icon: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
    options: [
      { type: 'check', key: 'autoSelect', label: 'Escolher camada sob o cursor' },
      { type: 'button', label: 'Centralizar camada', command: 'layer.center' }
    ],
    drag: null,

    down: function (p, e) {
      var a = app(), doc = a.doc;
      if (settings('move').autoSelect || e.ctrlKey || e.metaKey) {
        for (var i = doc.layers.length - 1; i >= 0; i--) {
          var l = doc.layers[i];
          if (l.visible && l.alphaAt(p.x, p.y) > 8) {
            if (doc.active !== l) { doc.active = l; a.refreshLayers(); }
            break;
          }
        }
      }
      var layer = doc.active;
      if (!layer) { a.toast('Não há camada para mover.'); return false; }
      if (!layer.visible) { a.toast('A camada ativa está oculta.'); return false; }
      this.drag = { layer: layer, sx: layer.x, sy: layer.y, start: p, moved: false };
      return true;
    },

    move: function (p, e) {
      var d = this.drag;
      if (!d) return;
      var dx = Math.round(p.x - d.start.x), dy = Math.round(p.y - d.start.y);
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      d.layer.x = d.sx + dx;
      d.layer.y = d.sy + dy;
      d.moved = d.layer.x !== d.sx || d.layer.y !== d.sy;
      app().markDirty();
    },

    up: function () {
      var d = this.drag;
      this.drag = null;
      if (d && d.moved) app().commit('Mover camada');
    },

    cancel: function () {
      var d = this.drag;
      if (!d) return;
      d.layer.x = d.sx;
      d.layer.y = d.sy;
      this.drag = null;
      app().markDirty();
    },

    overlay: function (ctx, view) {
      var l = app().doc.active;
      if (!l || !l.visible) return;
      var a = view.docToScreen(l.x, l.y);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = view.colors.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(l.width * view.zoom), Math.round(l.height * view.zoom));
      ctx.restore();
    }
  };

  /* ---------------------------------------------------------------- *
   * Seleção retangular
   * ---------------------------------------------------------------- */

  var marquee = {
    id: 'marquee',
    label: 'Seleção retangular',
    key: 'm',
    cursor: 'crosshair',
    hint: 'Arraste para selecionar. Shift faz um quadrado. Um clique sem arrastar desmarca.',
    icon: svg('<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.6"/>'),
    options: [
      { type: 'button', label: 'Selecionar tudo', command: 'select.all' },
      { type: 'button', label: 'Desmarcar', command: 'select.none' },
      { type: 'button', label: 'Cortar para a seleção', command: 'image.cropToSelection' }
    ],
    drag: null,

    down: function (p) {
      this.drag = { start: clampToDoc(p, app().doc), rect: null };
      return true;
    },

    move: function (p, e) {
      var d = this.drag;
      if (!d) return;
      var doc = app().doc;
      var end = clampToDoc(p, doc);
      if (e.shiftKey) {
        var side = Math.max(Math.abs(end.x - d.start.x), Math.abs(end.y - d.start.y));
        end = clampToDoc({
          x: d.start.x + side * Math.sign(end.x - d.start.x || 1),
          y: d.start.y + side * Math.sign(end.y - d.start.y || 1)
        }, doc);
      }
      d.rect = roundRect(normRect(d.start.x, d.start.y, end.x, end.y));
      app().requestRender();
    },

    up: function () {
      var d = this.drag, a = app();
      this.drag = null;
      if (d && d.rect && d.rect.w >= 1 && d.rect.h >= 1) {
        a.doc.selection = d.rect;
        a.commit('Seleção retangular');
      } else if (a.doc.selection) {
        a.doc.selection = null;
        a.commit('Desmarcar');
      } else a.requestRender();
    },

    cancel: function () {
      this.drag = null;
      app().requestRender();
    },

    overlay: function (ctx, view) {
      if (this.drag && this.drag.rect) app().drawAnts(ctx, view, this.drag.rect);
    }
  };

  /* ---------------------------------------------------------------- *
   * Cortar
   * ---------------------------------------------------------------- */

  var ASPECTS = [
    ['free', 'Livre'], ['orig', 'Original'], ['1:1', '1:1 quadrado'], ['4:5', '4:5 retrato'],
    ['3:2', '3:2 foto'], ['4:3', '4:3'], ['16:9', '16:9 tela'], ['9:16', '9:16 stories']
  ];

  var crop = {
    id: 'crop',
    label: 'Cortar',
    key: 'c',
    cursor: 'crosshair',
    hint: 'Ajuste a moldura pelas alças ou arraste por dentro para movê-la. Enter aplica, Esc redefine.',
    icon: svg('<path d="M7 3v14h14"/><path d="M3 7h14v14"/>'),
    options: [
      { type: 'select', key: 'aspect', label: 'Proporção', choices: ASPECTS },
      { type: 'info', get: function () { var r = crop.rect; return r ? Math.round(r.w) + ' × ' + Math.round(r.h) + ' px' : ''; } },
      { type: 'button', label: 'Aplicar corte', primary: true, run: function () { crop.apply(); } },
      { type: 'button', label: 'Redefinir', run: function () { crop.reset(); } }
    ],
    rect: null,
    drag: null,
    origRatio: 1,

    activate: function () { this.reset(); },
    deactivate: function () { this.rect = null; this.drag = null; },
    docChanged: function () { this.reset(); },

    reset: function () {
      var doc = app().doc;
      if (!doc) return;
      this.origRatio = doc.width / doc.height;
      this.rect = doc.selection ? Object.assign({}, doc.selection) : { x: 0, y: 0, w: doc.width, h: doc.height };
      app().requestRender();
      app().ui.refreshOptionInfo();
    },

    ratio: function () {
      var a = settings('crop').aspect;
      if (a === 'free') return 0;
      if (a === 'orig') return this.origRatio;
      var parts = a.split(':');
      return Number(parts[0]) / Number(parts[1]);
    },

    optionChanged: function () {
      var k = this.ratio(), doc = app().doc;
      if (!k || !this.rect) return;
      var r = this.rect, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      var w = r.w, h = r.h;
      if (w / h > k) w = h * k; else h = w / k;
      var scale = Math.min(1, doc.width / w, doc.height / h);
      w *= scale; h *= scale;
      this.rect = this.clamp({ x: cx - w / 2, y: cy - h / 2, w: w, h: h }, true);
      app().requestRender();
      app().ui.refreshOptionInfo();
    },

    clamp: function (r, keepSize) {
      var doc = app().doc;
      if (keepSize) {
        r.x = Math.max(0, Math.min(doc.width - r.w, r.x));
        r.y = Math.max(0, Math.min(doc.height - r.h, r.y));
        return r;
      }
      var x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      var x1 = Math.min(doc.width, r.x + r.w), y1 = Math.min(doc.height, r.y + r.h);
      return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
    },

    handles: function (view) {
      var r = this.rect;
      var a = view.docToScreen(r.x, r.y), b = view.docToScreen(r.x + r.w, r.y + r.h);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      return {
        nw: [a.x, a.y], n: [mx, a.y], ne: [b.x, a.y], e: [b.x, my],
        se: [b.x, b.y], s: [mx, b.y], sw: [a.x, b.y], w: [a.x, my]
      };
    },

    hit: function (p, view) {
      if (!this.rect) return 'new';
      var hs = this.handles(view);
      for (var k in hs) {
        if (Math.abs(p.sx - hs[k][0]) <= 9 && Math.abs(p.sy - hs[k][1]) <= 9) return k;
      }
      var r = this.rect;
      if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h) return 'move';
      return 'new';
    },

    hover: function (p) {
      var map = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move', new: 'crosshair' };
      return map[this.hit(p, app().view)];
    },

    down: function (p) {
      this.drag = { mode: this.hit(p, app().view), start: p, rect: Object.assign({}, this.rect) };
      return true;
    },

    move: function (p) {
      var d = this.drag;
      if (!d) return;
      var doc = app().doc, k = this.ratio();
      var dx = p.x - d.start.x, dy = p.y - d.start.y;
      var r0 = d.rect;
      if (d.mode === 'move') {
        this.rect = this.clamp({ x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h }, true);
      } else if (d.mode === 'new') {
        var s = clampToDoc(d.start, doc), e = clampToDoc(p, doc);
        var w = e.x - s.x, h = e.y - s.y;
        if (k) {
          if (Math.abs(w) / Math.max(1e-6, Math.abs(h)) > k) w = Math.sign(w || 1) * Math.abs(h) * k;
          else h = Math.sign(h || 1) * Math.abs(w) / k;
        }
        this.rect = this.clamp(normRect(s.x, s.y, s.x + w, s.y + h));
      } else {
        var l = r0.x, t = r0.y, rr = r0.x + r0.w, b = r0.y + r0.h;
        var m = d.mode;
        if (m.indexOf('w') >= 0) l += dx;
        if (m.indexOf('e') >= 0) rr += dx;
        if (m.indexOf('n') >= 0) t += dy;
        if (m.indexOf('s') >= 0) b += dy;
        if (k) {
          var cw = rr - l, ch = b - t;
          if (m.length === 2) {
            if (Math.abs(cw) / Math.max(1e-6, Math.abs(ch)) > k) ch = Math.sign(ch || 1) * Math.abs(cw) / k;
            else cw = Math.sign(cw || 1) * Math.abs(ch) * k;
            if (m.indexOf('w') >= 0) l = rr - cw; else rr = l + cw;
            if (m.indexOf('n') >= 0) t = b - ch; else b = t + ch;
          } else if (m === 'e' || m === 'w') {
            var cy = (t + b) / 2;
            ch = Math.abs(cw) / k;
            t = cy - ch / 2; b = cy + ch / 2;
          } else {
            var cx = (l + rr) / 2;
            cw = Math.abs(ch) * k;
            l = cx - cw / 2; rr = cx + cw / 2;
          }
        }
        this.rect = this.clamp(normRect(l, t, rr, b));
      }
      app().requestRender();
      app().ui.refreshOptionInfo();
    },

    up: function () { this.drag = null; },
    cancel: function () { if (this.drag) { this.rect = this.drag.rect; this.drag = null; app().requestRender(); } },

    onKey: function (e) {
      if (e.key === 'Enter') { this.apply(); return true; }
      if (e.key === 'Escape') { this.reset(); return true; }
      return false;
    },

    apply: function () {
      var r = this.rect && roundRect(this.rect);
      if (!r || r.w < 1 || r.h < 1) { app().toast('Desenhe uma moldura de corte primeiro.'); return; }
      var doc = app().doc;
      if (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height) { app().toast('A moldura já cobre a imagem inteira.'); return; }
      app().cropTo(r);
    },

    overlay: function (ctx, view) {
      var r = this.rect, doc = app().doc;
      if (!r) return;
      var a = view.docToScreen(r.x, r.y), b = view.docToScreen(r.x + r.w, r.y + r.h);
      var d0 = view.docToScreen(0, 0), d1 = view.docToScreen(doc.width, doc.height);
      ctx.save();
      ctx.fillStyle = 'rgba(10, 10, 12, 0.6)';
      ctx.beginPath();
      ctx.rect(d0.x, d0.y, d1.x - d0.x, d1.y - d0.y);
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var i = 1; i < 3; i++) {
        var gx = Math.round(a.x + ((b.x - a.x) * i) / 3) + 0.5, gy = Math.round(a.y + ((b.y - a.y) * i) / 3) + 0.5;
        ctx.moveTo(gx, a.y); ctx.lineTo(gx, b.y);
        ctx.moveTo(a.x, gy); ctx.lineTo(b.x, gy);
      }
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x) - 1, Math.round(b.y - a.y) - 1);
      var hs = this.handles(view);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      for (var k in hs) {
        ctx.fillRect(hs[k][0] - 4, hs[k][1] - 4, 8, 8);
        ctx.strokeRect(hs[k][0] - 4.5, hs[k][1] - 4.5, 9, 9);
      }
      ctx.restore();
    }
  };

  /* ---------------------------------------------------------------- *
   * Balde de tinta
   * ---------------------------------------------------------------- */

  var fill = {
    id: 'fill',
    label: 'Balde de tinta',
    key: 'g',
    cursor: 'crosshair',
    hint: 'Clique para preencher áreas de cor parecida com a cor primária. Alt+clique copia a cor.',
    icon: svg('<path d="M4.5 11.5L11 5l7 7-6.5 6.5a1.5 1.5 0 0 1-2.1 0l-4.9-4.9a1.5 1.5 0 0 1 0-2.1z"/><path d="M4.5 12.5h13"/><path d="M8 3l3 2"/><path d="M20 15.5s1.5 1.9 1.5 2.9a1.5 1.5 0 0 1-3 0c0-1 1.5-2.9 1.5-2.9z"/>'),
    options: [
      { type: 'range', key: 'tolerance', label: 'Tolerância', min: 0, max: 255, step: 1 },
      { type: 'range', key: 'opacity', label: 'Opacidade', min: 1, max: 100, step: 1, unit: '%' },
      { type: 'check', key: 'contiguous', label: 'Contíguo' }
    ],

    down: function (p, e) {
      if (e.altKey) { pickInto(p, false, 1); return false; }
      var a = app();
      var layer = a.editableLayer();
      if (!layer) return false;
      var lx = Math.floor(p.x - layer.x), ly = Math.floor(p.y - layer.y);
      if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) { a.toast('Clique dentro da área da camada ativa.'); return false; }
      var clip = a.selectionClip(layer);
      if (clip && (lx < clip.x || ly < clip.y || lx >= clip.x + clip.w || ly >= clip.y + clip.h)) return false;
      var s = settings('fill');
      var img = layer.canvas.getContext('2d').getImageData(0, 0, layer.width, layer.height);
      var mask = ops.floodMask(img, lx, ly, s.tolerance, s.contiguous);
      if (!mask) return false;
      var colored = ops.maskToImageData(mask, layer.width, layer.height, ops.hexToRgb(a.colors.primary));
      layer.live = { canvas: R.canvas.fromImageData(colored), mode: 'paint', opacity: s.opacity / 100, clip: clip };
      layer.canvas = R.canvas.mergeLive(layer);
      layer.live = null;
      layer.text = null;
      a.commit('Balde de tinta');
      return false;
    }
  };

  /* ---------------------------------------------------------------- *
   * Gradiente
   * ---------------------------------------------------------------- */

  var gradient = {
    id: 'gradient',
    label: 'Gradiente',
    key: 'g',
    shift: true,
    cursor: 'crosshair',
    hint: 'Arraste para definir a direção do gradiente. Shift trava em 45°.',
    icon: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7 16l10-8"/><circle cx="7" cy="16" r="1.4"/><circle cx="17" cy="8" r="1.4"/>'),
    options: [
      { type: 'select', key: 'kind', label: 'Tipo', choices: [['linear', 'Linear'], ['radial', 'Radial']] },
      { type: 'select', key: 'colors', label: 'Cores', choices: [['two', 'Primária → secundária'], ['fade', 'Primária → transparente']] },
      { type: 'range', key: 'opacity', label: 'Opacidade', min: 1, max: 100, step: 1, unit: '%' }
    ],
    drag: null,

    down: function (p, e) {
      if (e.altKey) { pickInto(p, false, 1); return false; }
      var a = app();
      var layer = a.editableLayer();
      if (!layer) return false;
      var s = settings('gradient');
      layer.live = { canvas: R.canvas.create(layer.width, layer.height), mode: 'paint', opacity: s.opacity / 100, clip: a.selectionClip(layer) };
      this.drag = { layer: layer, start: p, end: p };
      return true;
    },

    move: function (p, e) {
      var d = this.drag;
      if (!d) return;
      d.end = e.shiftKey ? snapAngle(d.start, p) : p;
      var layer = d.layer, s = settings('gradient'), a = app();
      var ctx = layer.live.canvas.getContext('2d');
      var x0 = d.start.x - layer.x, y0 = d.start.y - layer.y, x1 = d.end.x - layer.x, y1 = d.end.y - layer.y;
      var g = s.kind === 'radial'
        ? ctx.createRadialGradient(x0, y0, 0, x0, y0, Math.max(1, Math.hypot(x1 - x0, y1 - y0)))
        : ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, a.colors.primary);
      g.addColorStop(1, s.colors === 'fade' ? rgba(a.colors.primary, 0) : a.colors.secondary);
      ctx.clearRect(0, 0, layer.width, layer.height);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, layer.width, layer.height);
      a.markDirty();
    },

    up: function () {
      var d = this.drag;
      this.drag = null;
      if (!d) return;
      if (Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) < 2) {
        d.layer.live = null;
        app().markDirty();
        return;
      }
      d.layer.canvas = R.canvas.mergeLive(d.layer);
      d.layer.live = null;
      d.layer.text = null;
      app().commit('Gradiente');
    },

    cancel: function () {
      if (!this.drag) return;
      this.drag.layer.live = null;
      this.drag = null;
      app().markDirty();
    },

    overlay: function (ctx, view) {
      var d = this.drag;
      if (!d) return;
      var a = view.docToScreen(d.start.x, d.start.y), b = view.docToScreen(d.end.x, d.end.y);
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      [a, b].forEach(function (pt) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.stroke();
      });
      ctx.restore();
    }
  };

  /* ---------------------------------------------------------------- *
   * Formas
   * ---------------------------------------------------------------- */

  var SHAPE_NAMES = { rect: 'Retângulo', ellipse: 'Elipse', line: 'Linha', arrow: 'Seta' };

  function arrowHead(sw) { return Math.max(12, sw * 4); }

  function drawShape(ctx, g, ox, oy) {
    var x0 = g.x0 + ox, y0 = g.y0 + oy, x1 = g.x1 + ox, y1 = g.y1 + oy;
    ctx.save();
    ctx.lineWidth = g.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (g.shape === 'line' || g.shape === 'arrow') {
      ctx.strokeStyle = g.fillColor;
      ctx.fillStyle = g.fillColor;
      var ang = Math.atan2(y1 - y0, x1 - x0);
      var head = g.shape === 'arrow' ? arrowHead(g.strokeWidth) : 0;
      var ex = x1 - Math.cos(ang) * head * 0.6, ey = y1 - Math.sin(ang) * head * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(head ? ex : x1, head ? ey : y1);
      ctx.stroke();
      if (head) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - Math.cos(ang - 0.45) * head, y1 - Math.sin(ang - 0.45) * head);
        ctx.lineTo(x1 - Math.cos(ang + 0.45) * head, y1 - Math.sin(ang + 0.45) * head);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      var r = normRect(x0, y0, x1, y1);
      ctx.beginPath();
      if (g.shape === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(r.x, r.y, r.w, r.h);
      if (g.style !== 'stroke') {
        ctx.fillStyle = g.fillColor;
        ctx.fill();
      }
      if (g.style !== 'fill') {
        ctx.lineJoin = 'miter';
        ctx.strokeStyle = g.style === 'both' ? g.strokeColor : g.fillColor;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function shapeBounds(g) {
    var pad = g.strokeWidth / 2 + 2;
    if (g.shape === 'arrow') pad += arrowHead(g.strokeWidth);
    var r = normRect(g.x0, g.y0, g.x1, g.y1);
    return { x: Math.floor(r.x - pad), y: Math.floor(r.y - pad), w: Math.ceil(r.w + pad * 2) + 1, h: Math.ceil(r.h + pad * 2) + 1 };
  }

  var shape = {
    id: 'shape',
    label: 'Formas',
    key: 'u',
    cursor: 'crosshair',
    hint: 'Arraste para desenhar. Shift faz quadrado/círculo ou trava retas em 45°; Alt desenha a partir do centro.',
    icon: svg('<rect x="3.5" y="10.5" width="10" height="10" rx="1"/><circle cx="15.5" cy="8.5" r="5"/>'),
    options: [
      { type: 'select', key: 'shape', label: 'Forma', choices: [['rect', 'Retângulo'], ['ellipse', 'Elipse'], ['line', 'Linha'], ['arrow', 'Seta']] },
      { type: 'select', key: 'style', label: 'Estilo', choices: [['fill', 'Preenchida'], ['stroke', 'Contorno'], ['both', 'Preenchida + contorno']] },
      { type: 'range', key: 'strokeWidth', label: 'Espessura', min: 1, max: 120, step: 1, unit: 'px' },
      { type: 'check', key: 'newLayer', label: 'Em nova camada' }
    ],
    drag: null,

    down: function (p) {
      var a = app(), doc = a.doc, s = settings('shape');
      var target;
      if (s.newLayer) {
        if (!doc) return false;
        var prev = doc.active;
        var layer = doc.blankLayer(SHAPE_NAMES[s.shape]);
        doc.addLayer(layer);
        a.refreshLayers();
        target = { layer: layer, prev: prev, canvas: layer.canvas, ox: 0, oy: 0, isNew: true };
      } else {
        var active = a.editableLayer();
        if (!active) return false;
        active.live = { canvas: R.canvas.create(active.width, active.height), mode: 'paint', opacity: 1, clip: a.selectionClip(active) };
        target = { layer: active, canvas: active.live.canvas, ox: -active.x, oy: -active.y, isNew: false };
      }
      this.drag = { target: target, start: p, geom: null };
      return true;
    },

    move: function (p, e) {
      var d = this.drag;
      if (!d) return;
      var a = app(), s = settings('shape');
      var start = d.start, end = p;
      var isLine = s.shape === 'line' || s.shape === 'arrow';
      if (e.shiftKey) {
        if (isLine) end = snapAngle(start, p);
        else {
          var side = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
          end = { x: start.x + side * Math.sign(p.x - start.x || 1), y: start.y + side * Math.sign(p.y - start.y || 1) };
        }
      }
      var x0 = start.x, y0 = start.y;
      if (e.altKey && !isLine) { x0 = start.x - (end.x - start.x); y0 = start.y - (end.y - start.y); }
      d.geom = {
        shape: s.shape, style: s.style, strokeWidth: s.strokeWidth,
        fillColor: a.colors.primary, strokeColor: a.colors.secondary,
        x0: x0, y0: y0, x1: end.x, y1: end.y
      };
      var t = d.target, ctx = t.canvas.getContext('2d');
      ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
      ctx.save();
      var sel = a.doc.selection;
      if (t.isNew && sel) { ctx.beginPath(); ctx.rect(sel.x, sel.y, sel.w, sel.h); ctx.clip(); }
      drawShape(ctx, d.geom, t.ox, t.oy);
      ctx.restore();
      a.markDirty();
    },

    up: function () {
      var d = this.drag, a = app(), doc = a.doc;
      this.drag = null;
      if (!d) return;
      var t = d.target, g = d.geom;
      var tooSmall = !g || Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 2;
      if (tooSmall) { this.discard(t); return; }
      if (t.isNew) {
        var b = shapeBounds(g);
        var x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
        var x1 = Math.min(doc.width, b.x + b.w), y1 = Math.min(doc.height, b.y + b.h);
        if (x1 - x0 < 1 || y1 - y0 < 1) { this.discard(t); return; }
        var trimmed = R.canvas.create(x1 - x0, y1 - y0);
        trimmed.getContext('2d').drawImage(t.layer.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
        t.layer.canvas = trimmed;
        t.layer.x = x0;
        t.layer.y = y0;
      } else {
        t.layer.canvas = R.canvas.mergeLive(t.layer);
        t.layer.live = null;
        t.layer.text = null;
      }
      a.commit(SHAPE_NAMES[g.shape]);
    },

    discard: function (t) {
      var a = app();
      if (t.isNew) {
        a.doc.removeLayer(t.layer);
        a.doc.active = t.prev;
        a.refreshLayers();
      } else t.layer.live = null;
      a.markDirty();
    },

    cancel: function () {
      if (!this.drag) return;
      this.discard(this.drag.target);
      this.drag = null;
    }
  };

  /* ---------------------------------------------------------------- *
   * Texto
   * ---------------------------------------------------------------- */

  function textLabel(content) {
    var first = String(content).split('\n')[0].trim();
    return first.length > 28 ? first.slice(0, 27) + '…' : first || 'Texto';
  }

  var text = {
    id: 'text',
    label: 'Texto',
    key: 't',
    cursor: 'text',
    hint: 'Clique para escrever ou clique num texto para editá-lo. Ctrl+Enter confirma, Esc cancela.',
    icon: svg('<path d="M5 7V4.5h14V7"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>'),
    options: function () {
      var list = [
        { type: 'select', key: 'family', label: 'Fonte', choices: R.text.FONTS.map(function (f) { return [f, f]; }) },
        { type: 'range', key: 'size', label: 'Tamanho', min: 6, max: 400, step: 1, unit: 'px' },
        { type: 'toggle', key: 'bold', label: 'N', title: 'Negrito', className: 'is-bold' },
        { type: 'toggle', key: 'italic', label: 'I', title: 'Itálico', className: 'is-italic' },
        { type: 'select', key: 'align', label: 'Alinhar', choices: [['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']] }
      ];
      if (text.editing) {
        list.push({ type: 'button', label: 'Confirmar', primary: true, run: function () { text.commit(); } });
        list.push({ type: 'button', label: 'Cancelar', run: function () { text.cancel(); } });
      }
      return list;
    },
    editing: null,

    down: function (p, e) {
      var a = app();
      if (this.editing) { this.commit(); return false; }
      if (e.altKey) { pickInto(p, false, 1); return false; }
      var doc = a.doc, hit = null;
      for (var i = doc.layers.length - 1; i >= 0; i--) {
        var l = doc.layers[i];
        if (l.text && l.visible && l.contains(p.x, p.y)) { hit = l; break; }
      }
      this.begin(hit, { x: Math.round(p.x), y: Math.round(p.y) });
      return false;
    },

    begin: function (layer, origin) {
      var a = app(), s = settings('text');
      a.beforeEdit();
      var props;
      if (layer) {
        props = Object.assign({}, layer.text);
        ['family', 'size', 'bold', 'italic', 'align'].forEach(function (k) { s[k] = props[k]; });
        a.setColor('primary', props.color);
        layer.editing = true;
        a.doc.active = layer;
        origin = layer.textOrigin();
        a.refreshLayers();
      } else {
        props = { content: '', family: s.family, size: s.size, bold: s.bold, italic: s.italic, align: s.align, color: a.colors.primary };
      }
      this.editing = { layer: layer, origin: origin, props: props };
      var ta = a.textArea;
      ta.value = props.content;
      ta.hidden = false;
      this.layout();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      a.ui.renderOptions();
      a.markDirty();
    },

    layout: function () {
      var ed = this.editing;
      if (!ed) return;
      var a = app(), ta = a.textArea, view = a.view, props = ed.props;
      var pos = view.docToScreen(ed.origin.x, ed.origin.y);
      ta.style.font = R.text.font(Object.assign({}, props, { size: props.size * view.zoom }));
      ta.style.lineHeight = String(R.text.LINE_HEIGHT);
      ta.style.color = props.color;
      ta.style.textAlign = props.align;
      ta.style.left = pos.x + 'px';
      ta.style.top = pos.y + 'px';
      ta.style.width = '0px';
      ta.style.height = '0px';
      ta.style.width = Math.max(ta.scrollWidth + 4, props.size * view.zoom * 0.6) + 'px';
      ta.style.height = Math.max(ta.scrollHeight, props.size * view.zoom * R.text.LINE_HEIGHT) + 'px';
      ta.scrollLeft = 0;
      ta.scrollTop = 0;
    },

    optionChanged: function (key) {
      var ed = this.editing;
      if (!ed) return;
      if (key in ed.props) ed.props[key] = settings('text')[key];
      this.layout();
    },

    colorChanged: function () {
      if (!this.editing) return;
      this.editing.props.color = app().colors.primary;
      this.layout();
    },

    commit: function () {
      var ed = this.editing, a = app();
      if (!ed) return;
      this.editing = null;
      var ta = a.textArea;
      var content = ta.value.replace(/\s+$/, '');
      ta.hidden = true;
      ta.blur();
      if (ed.layer) ed.layer.editing = false;
      a.ui.renderOptions();
      if (!content.trim()) {
        if (ed.layer) {
          a.doc.removeLayer(ed.layer);
          a.commit('Excluir texto');
        } else a.markDirty();
        return;
      }
      var props = Object.assign({}, ed.props, { content: content });
      var finish = function () {
        var out = R.text.render(props);
        var x = Math.round(ed.origin.x - out.pad), y = Math.round(ed.origin.y - out.pad);
        if (ed.layer) {
          var l = ed.layer;
          l.text = props;
          l.canvas = out.canvas;
          l.x = x;
          l.y = y;
          l.name = textLabel(content);
          a.commit('Editar texto');
        } else {
          a.doc.addLayer(new R.Layer({ name: textLabel(content), canvas: out.canvas, x: x, y: y, text: props }));
          a.commit('Texto');
        }
      };
      var font = R.text.font(props);
      if (!document.fonts || document.fonts.check(font)) finish();
      else document.fonts.load(font).then(finish, finish);
    },

    cancel: function () {
      var ed = this.editing, a = app();
      if (!ed) return;
      this.editing = null;
      if (ed.layer) ed.layer.editing = false;
      a.textArea.hidden = true;
      a.textArea.blur();
      a.ui.renderOptions();
      a.markDirty();
    },

    deactivate: function () { this.commit(); },
    docChanged: function () { if (this.editing) this.cancel(); },

    overlay: function (ctx, view) {
      if (this.editing) return;
      var l = app().doc.active;
      if (!l || !l.text || !l.visible) return;
      var a = view.docToScreen(l.x, l.y);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = view.colors.accent;
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(l.width * view.zoom), Math.round(l.height * view.zoom));
      ctx.restore();
    }
  };

  /* ---------------------------------------------------------------- *
   * Conta-gotas, mão e zoom
   * ---------------------------------------------------------------- */

  var eyedropper = {
    id: 'eyedropper',
    label: 'Conta-gotas',
    key: 'i',
    cursor: 'crosshair',
    hint: 'Clique para copiar a cor da imagem para a cor primária. Alt+clique define a secundária.',
    icon: svg('<path d="M13.5 6.5l4 4"/><path d="M16 4l1.5-1.5a2.1 2.1 0 0 1 3 3L19 7l1 1-2 2-6-6 2-2z"/><path d="M15 9l-8.5 8.5L4 20l2.5-2.5"/><path d="M12 6l-8 8v3h3l8-8"/>'),
    options: [
      { type: 'select', key: 'sample', label: 'Amostra', choices: [['1', 'Ponto exato'], ['3', 'Média 3 × 3'], ['5', 'Média 5 × 5'], ['11', 'Média 11 × 11']] }
    ],
    down: function (p, e) {
      if (!pickInto(p, e.altKey, Number(settings('eyedropper').sample))) app().toast('Não há cor visível nesse ponto.');
      return true;
    },
    move: function (p, e) { pickInto(p, e.altKey, Number(settings('eyedropper').sample)); },
    up: function () {}
  };

  var hand = {
    id: 'hand',
    label: 'Mão',
    key: 'h',
    cursor: 'grab',
    hint: 'Arraste para navegar. Segure Espaço para usar a mão com qualquer ferramenta.',
    icon: svg('<path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5"/><path d="M11 10.5V4.5a1.5 1.5 0 0 1 3 0v6"/><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v5.5"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.7-2.3l-3.2-4a1.5 1.5 0 0 1 2.2-2L8 14.5"/>'),
    options: [
      { type: 'button', label: 'Ajustar à tela', command: 'view.fit' },
      { type: 'button', label: '100%', command: 'view.actual' }
    ]
  };

  var zoom = {
    id: 'zoom',
    label: 'Zoom',
    key: 'z',
    cursor: 'zoom-in',
    hint: 'Clique para aproximar e Alt+clique para afastar. Ctrl+roda do mouse também funciona.',
    icon: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/><path d="M8 10.5h5M10.5 8v5"/>'),
    options: [
      { type: 'button', label: 'Ajustar à tela', command: 'view.fit' },
      { type: 'button', label: '100%', command: 'view.actual' }
    ],
    down: function (p, e) {
      app().view.zoomStep(e.altKey ? -1 : 1, p.sx, p.sy);
      app().viewChanged();
      return false;
    }
  };

  R.tools = [move, marquee, crop, brush, eraser, fill, gradient, shape, text, eyedropper, hand, zoom];

  R.toolDefaults = {
    move: { autoSelect: false },
    marquee: {},
    crop: { aspect: 'free' },
    brush: { size: 24, hardness: 80, opacity: 100, pressure: true },
    eraser: { size: 48, hardness: 60, opacity: 100, pressure: true },
    fill: { tolerance: 32, opacity: 100, contiguous: true },
    gradient: { kind: 'linear', colors: 'two', opacity: 100 },
    shape: { shape: 'rect', style: 'fill', strokeWidth: 6, newLayer: true },
    text: { family: 'Instrument Sans', size: 72, bold: false, italic: false, align: 'left' },
    eyedropper: { sample: '3' },
    hand: {},
    zoom: {}
  };

  R.toolHelpers = { sampleColor: sampleColor };
})();
