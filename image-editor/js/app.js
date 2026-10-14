/*
 * Retoque — controlador principal: estado, comandos, atalhos e arquivos.
 */
(function () {
  'use strict';
  var R = window.Retoque;
  var ops = R.ops, ui = R.ui, h = ui.h, $ = ui.$;

  var STORAGE_KEY = 'retoque.settings.v1';
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var MAX_PIXELS = IS_IOS ? 16e6 : 50e6;
  var MAX_SIDE = 16384;
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var toolById = {};
  R.tools.forEach(function (t) { toolById[t.id] = t; });
  var textTool = toolById.text;

  var app = (R.app = {
    doc: null,
    view: null,
    history: new R.History({ limit: 60, budget: 768 * 1024 * 1024, measure: R.Doc.measure }),
    tool: null,
    settings: {},
    colors: { primary: '#1d1d1f', secondary: '#ffffff' },
    recentColors: [],
    pointer: null,
    clipboard: null,
    commands: {},
    textArea: null,
    pristine: true,
    ui: ui
  });

  /* ---------------------------------------------------------------- *
   * Preferências (só neste navegador)
   * ---------------------------------------------------------------- */

  var storedTool = null;

  function validHex(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }

  function loadSettings() {
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) { stored = {}; }
    var tools = stored.tools || {};
    R.tools.forEach(function (t) {
      app.settings[t.id] = Object.assign({}, R.toolDefaults[t.id], tools[t.id] || {});
    });
    if (stored.colors && validHex(stored.colors.primary) && validHex(stored.colors.secondary)) {
      app.colors = { primary: stored.colors.primary, secondary: stored.colors.secondary };
    }
    if (Array.isArray(stored.recent)) app.recentColors = stored.recent.filter(validHex).slice(0, 8);
    if (stored.theme === 'light' || stored.theme === 'dark') document.documentElement.setAttribute('data-theme', stored.theme);
    if (toolById[stored.tool]) storedTool = stored.tool;
  }

  var saveTimer = null;
  app.saveSettings = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          tools: app.settings,
          colors: app.colors,
          recent: app.recentColors,
          theme: document.documentElement.getAttribute('data-theme') || '',
          tool: app.tool && app.tool.id
        }));
      } catch (e) { /* armazenamento indisponível: preferências valem só nesta sessão */ }
    }, 300);
  };

  /* ---------------------------------------------------------------- *
   * Desenho
   * ---------------------------------------------------------------- */

  var renderQueued = false;
  var antsOffset = 0, antsTimer = null;

  app.requestRender = function () {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  };

  app.markDirty = function () {
    app.view.compDirty = true;
    app.requestRender();
    scheduleHistogram();
  };

  app.viewChanged = function () {
    app.requestRender();
    if (textTool.editing) textTool.layout();
  };

  function render() {
    renderQueued = false;
    app.view.render(app.doc, drawOverlays);
    ui.refreshStatus();
  }

  function drawOverlays(ctx, view) {
    var doc = app.doc;
    if (doc.selection && app.tool.id !== 'crop') app.drawAnts(ctx, view, doc.selection);
    if (app.tool.overlay) app.tool.overlay(ctx, view);
  }

  app.drawAnts = function (ctx, view, r) {
    var a = view.docToScreen(r.x, r.y);
    var x = Math.round(a.x) + 0.5, y = Math.round(a.y) + 0.5;
    var w = Math.max(1, Math.round(r.w * view.zoom) - 1), hh = Math.max(1, Math.round(r.h * view.zoom) - 1);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(x, y, w, hh);
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -antsOffset;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, hh);
    ctx.restore();
    if (!antsTimer && !REDUCED_MOTION) {
      antsTimer = setTimeout(function () {
        antsTimer = null;
        antsOffset = (antsOffset + 1) % 9;
        app.requestRender();
      }, 90);
    }
  };

  var histTimer = null, histCanvas = null, histCtx = null;

  function scheduleHistogram() {
    clearTimeout(histTimer);
    histTimer = setTimeout(updateHistogram, 220);
  }

  function updateHistogram() {
    var doc = app.doc;
    if (!doc) return;
    if (app.view.compDirty) app.view.updateComposite(doc);
    var scale = Math.min(1, 360 / Math.max(doc.width, doc.height));
    var w = Math.max(1, Math.round(doc.width * scale)), hh = Math.max(1, Math.round(doc.height * scale));
    if (!histCanvas) {
      histCanvas = R.canvas.create(w, hh);
      histCtx = histCanvas.getContext('2d', { willReadFrequently: true });
    }
    histCanvas.width = w;
    histCanvas.height = hh;
    histCtx.drawImage(app.view.comp, 0, 0, w, hh);
    ui.drawHistogram(ops.histogram(histCtx.getImageData(0, 0, w, hh)));
  }

  /* ---------------------------------------------------------------- *
   * Histórico
   * ---------------------------------------------------------------- */

  var nudge = { index: -1, time: 0 };

  function afterChange() {
    app.markDirty();
    ui.refreshLayers();
    ui.refreshHistory();
    ui.refreshAdjust();
    ui.refreshOptionInfo();
  }

  app.commit = function (label) {
    app.history.push(app.doc.snapshot(), label);
    app.pristine = false;
    afterChange();
  };

  function restoreState(state) {
    var sizeChanged = state.width !== app.doc.width || state.height !== app.doc.height;
    app.doc.restore(state);
    if (app.tool.docChanged) app.tool.docChanged();
    if (sizeChanged) { app.view.fit(app.doc); app.viewChanged(); }
    afterChange();
  }

  app.undo = function () {
    if (textTool.editing) { textTool.cancel(); return; }
    if (adjust.pending()) { adjust.cancel(); return; }
    var s = app.history.undo();
    if (s) restoreState(s);
  };

  app.redo = function () {
    if (textTool.editing || adjust.pending()) return;
    var s = app.history.redo();
    if (s) restoreState(s);
  };

  app.historyGo = function (i) {
    if (textTool.editing) textTool.cancel();
    if (adjust.pending()) adjust.cancel();
    var s = app.history.go(i);
    if (s) restoreState(s);
  };

  function setDocument(doc, label) {
    if (textTool.editing) textTool.cancel();
    adjust.cancel();
    app.doc = doc;
    app.history.reset(doc.snapshot(), label);
    app.pristine = true;
    app.view.fit(doc);
    if (app.tool && app.tool.docChanged) app.tool.docChanged();
    afterChange();
    app.viewChanged();
  }

  /* ---------------------------------------------------------------- *
   * Ajudantes de edição
   * ---------------------------------------------------------------- */

  app.toast = function (msg, kind) { ui.toast(msg, kind); };
  app.refreshLayers = function () { ui.refreshLayers(); };

  app.editableLayer = function () {
    var l = app.doc && app.doc.active;
    if (!l) { app.toast('Crie ou selecione uma camada primeiro.'); return null; }
    if (!l.visible) { app.toast('A camada “' + l.name + '” está oculta. Torne-a visível para editar.'); return null; }
    return l;
  };

  app.selectionClip = function (layer) {
    var s = app.doc.selection;
    return s ? { x: s.x - layer.x, y: s.y - layer.y, w: s.w, h: s.h } : null;
  };

  // Antes de qualquer edição, aplica os ajustes que estão em pré-visualização.
  app.beforeEdit = function () {
    if (adjust.pending()) adjust.apply();
  };

  app.setColor = function (which, hex) {
    app.colors[which] = hex;
    ui.refreshSwatches();
    if (which === 'primary' && app.tool.colorChanged) app.tool.colorChanged();
    app.saveSettings();
  };

  app.rememberColor = function (hex) {
    var rgb = ops.hexToRgb(hex);
    if (!rgb) return;
    var norm = ops.rgbToHex(rgb[0], rgb[1], rgb[2]);
    app.recentColors = [norm].concat(app.recentColors.filter(function (c) { return c !== norm; })).slice(0, 8);
    app.saveSettings();
  };

  app.setTool = function (id) {
    var t = toolById[id];
    if (!t || t === app.tool) return;
    if (app.tool) {
      if (pointer.active && pointer.mode === 'tool' && app.tool.cancel) app.tool.cancel();
      pointer.active = false;
      if (app.tool.deactivate) app.tool.deactivate();
    }
    app.tool = t;
    if (t.activate) t.activate();
    $('view').style.cursor = t.cursor;
    ui.refreshToolbar();
    ui.renderOptions();
    ui.setHint(t.hint);
    app.requestRender();
    app.saveSettings();
  };

  app.selectLayer = function (layer) {
    if (app.doc.active === layer) return;
    if (textTool.editing) textTool.commit();
    app.beforeEdit();
    app.doc.active = layer;
    ui.refreshLayers();
    ui.refreshAdjust();
    app.requestRender();
  };

  app.moveLayerTo = function (dragId, targetId, above) {
    var doc = app.doc;
    var dragged = doc.layers.filter(function (l) { return l.id === dragId; })[0];
    if (!dragged || dragId === targetId) return;
    var from = doc.indexOf(dragged);
    doc.layers.splice(from, 1);
    var t = doc.layers.map(function (l) { return l.id; }).indexOf(targetId);
    doc.layers.splice(above ? t + 1 : t, 0, dragged);
    if (doc.indexOf(dragged) === from) { ui.refreshLayers(); return; }
    app.commit('Reordenar camadas');
  };

  app.cropTo = function (r) {
    var doc = app.doc;
    doc.layers.forEach(function (l) { l.x -= r.x; l.y -= r.y; });
    doc.width = r.w;
    doc.height = r.h;
    doc.selection = null;
    app.commit('Cortar');
    app.view.fit(doc);
    if (app.tool.docChanged) app.tool.docChanged();
    app.viewChanged();
  };

  function regionFor(layer) {
    var sel = app.doc.selection;
    var x0 = 0, y0 = 0, x1 = layer.width, y1 = layer.height;
    if (sel) {
      x0 = Math.max(0, sel.x - layer.x);
      y0 = Math.max(0, sel.y - layer.y);
      x1 = Math.min(layer.width, sel.x + sel.w - layer.x);
      y1 = Math.min(layer.height, sel.y + sel.h - layer.y);
    }
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Sessão de pré-visualização: copia a região editável da camada ativa,
  // mostra o resultado de fn sem tocar no original e aplica ou descarta.
  function previewSession() {
    var layer = app.editableLayer();
    if (!layer) return null;
    var region = regionFor(layer);
    if (!region) { app.toast('A seleção não cobre a camada ativa.'); return null; }
    var source = layer.canvas.getContext('2d').getImageData(region.x, region.y, region.w, region.h);
    var canvas = R.canvas.clone(layer.canvas);
    var shown = true;
    return {
      layer: layer,
      render: function (fn) {
        var img = ops.cloneImageData(source);
        fn(img);
        canvas.getContext('2d').putImageData(img, region.x, region.y);
        if (shown) layer.preview = { canvas: canvas, x: layer.x, y: layer.y };
        app.markDirty();
      },
      showResult: function (on) {
        shown = on;
        layer.preview = on ? { canvas: canvas, x: layer.x, y: layer.y } : null;
        app.markDirty();
      },
      apply: function (label) {
        layer.preview = null;
        layer.canvas = canvas;
        layer.text = null;
        app.commit(label);
      },
      cancel: function () {
        layer.preview = null;
        app.markDirty();
      }
    };
  }

  function runBusy(label, fn) {
    ui.setBusy(true, label || 'Processando…');
    requestAnimationFrame(function () {
      setTimeout(function () {
        try { fn(); }
        catch (err) { app.toast('Não foi possível concluir: ' + err.message, 'error'); }
        finally { ui.setBusy(false); }
      }, 0);
    });
  }

  function quickFilter(label, fn) {
    var s = previewSession();
    if (!s) return;
    runBusy(null, function () {
      s.render(fn);
      s.apply(label);
    });
  }

  /* ---------------------------------------------------------------- *
   * Ajustes (painel lateral)
   * ---------------------------------------------------------------- */

  var adjust = (app.adjustments = {
    values: ops.defaultAdjustments(),
    session: null,
    queued: false,
    pending: function () { return !!this.session; },
    set: function (key, v) {
      this.values[key] = v;
      if (!this.session) {
        if (ops.isNeutral(this.values)) return;
        if (textTool.editing) textTool.commit();
        this.session = previewSession();
        if (!this.session) {
          this.values = ops.defaultAdjustments();
          ui.refreshAdjust();
          return;
        }
        ui.refreshAdjust();
      }
      this.schedule();
    },
    schedule: function () {
      if (this.queued) return;
      this.queued = true;
      var self = this;
      requestAnimationFrame(function () {
        self.queued = false;
        if (!self.session) return;
        var vals = Object.assign({}, self.values);
        self.session.render(function (img) { ops.applyAdjustments(img, vals); });
      });
    },
    apply: function () {
      var s = this.session;
      if (!s) return;
      var vals = Object.assign({}, this.values);
      this.session = null;
      this.queued = false;
      this.values = ops.defaultAdjustments();
      if (ops.isNeutral(vals)) { s.cancel(); ui.refreshAdjust(); return; }
      s.render(function (img) { ops.applyAdjustments(img, vals); });
      s.apply('Ajustes');
    },
    cancel: function () {
      if (this.session) this.session.cancel();
      this.session = null;
      this.queued = false;
      this.values = ops.defaultAdjustments();
      ui.refreshAdjust();
    }
  });

  /* ---------------------------------------------------------------- *
   * Arquivos
   * ---------------------------------------------------------------- */

  var downloadsPromise = null;

  function getDownloads() {
    if (!downloadsPromise) {
      downloadsPromise = window.claude && typeof window.claude.use === 'function'
        ? Promise.resolve(window.claude.use('downloads')).catch(function () { return null; })
        : Promise.resolve(null);
    }
    return downloadsPromise;
  }

  function saveFile(blob, filename) {
    return getDownloads().then(function (downloads) {
      if (downloads) {
        return downloads.save({ filename: filename, data: blob }).then(function () {
          app.toast('Arquivo salvo: ' + filename);
        }, function (err) {
          var code = err && err.code;
          if (code === 'declined') app.toast('Salvamento cancelado.');
          else if (code === 'rate_limited') app.toast('Já existe um pedido de salvamento aberto. Responda a ele e tente de novo.');
          else app.toast('Não foi possível salvar o arquivo aqui (' + (code || 'erro') + ').', 'error');
        });
      }
      var url = URL.createObjectURL(blob);
      var a = h('a', { href: url, download: filename, hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      app.toast('Arquivo salvo: ' + filename);
    });
  }

  // Nomes de arquivo só com ASCII: alguns navegadores trocam nomes acentuados por "download".
  function safeName(name) {
    return String(name || 'imagem')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[^\w .()+-]+/g, '-')
      .replace(/\s+/g, ' ').trim().slice(0, 80) || 'imagem';
  }

  function baseName(filename) {
    return String(filename).replace(/\.[^.]+$/, '');
  }

  function fitPixels(w, hh) {
    var k = 1;
    if (w * hh > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (w * hh));
    k = Math.min(k, MAX_SIDE / w, MAX_SIDE / hh);
    return k;
  }

  function loadImageSource(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 1024, hh = img.naturalHeight || 768;
        var k = fitPixels(w, hh);
        var c = R.canvas.create(Math.round(w * Math.min(1, k)), Math.round(hh * Math.min(1, k)));
        var ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.wasReduced = k < 1;
        resolve(c);
      };
      img.onerror = function () { reject(new Error('o arquivo não é uma imagem válida')); };
      img.src = src;
    });
  }

  function loadImageFile(file) {
    var url = URL.createObjectURL(file);
    return loadImageSource(url).then(function (c) {
      URL.revokeObjectURL(url);
      return c;
    }, function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  function isProjectFile(f) {
    return /\.json$/i.test(f.name) || f.type === 'application/json';
  }

  function isImageFile(f) {
    return /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i.test(f.name);
  }

  function openFiles(files, asLayer) {
    var f = files && files[0];
    if (!f) return;
    if (isProjectFile(f)) { loadProject(f); return; }
    if (!isImageFile(f)) { app.toast('Formato não suportado: ' + f.name + '. Use PNG, JPEG, WebP, GIF ou um projeto .json.', 'error'); return; }
    ui.setBusy(true, 'Abrindo…');
    loadImageFile(f).then(function (c) {
      ui.setBusy(false);
      if (c.wasReduced) app.toast('A imagem era grande demais para este navegador e foi reduzida para ' + c.width + ' × ' + c.height + ' px.');
      if (asLayer) placeCanvas(c, baseName(f.name));
      else {
        var doc = new R.Doc(c.width, c.height, baseName(f.name));
        doc.addLayer(new R.Layer({ name: 'Fundo', canvas: c }));
        setDocument(doc, 'Abrir imagem');
      }
    }, function (err) {
      ui.setBusy(false);
      app.toast('Não foi possível abrir “' + f.name + '”: ' + err.message + '.', 'error');
    });
  }

  function placeCanvas(c, name, at) {
    var doc = app.doc;
    if (textTool.editing) textTool.commit();
    app.beforeEdit();
    var canvas = c;
    if (!at && (c.width > doc.width || c.height > doc.height)) {
      var k = Math.min(doc.width / c.width, doc.height / c.height);
      canvas = R.canvas.resample(c, c.width * k, c.height * k);
    }
    var x = at ? at.x : Math.round((doc.width - canvas.width) / 2);
    var y = at ? at.y : Math.round((doc.height - canvas.height) / 2);
    doc.addLayer(new R.Layer({ name: name || 'Imagem', canvas: canvas, x: x, y: y }));
    app.commit(at ? 'Colar' : 'Inserir imagem');
  }

  function saveProject() {
    var doc = app.doc;
    ui.setBusy(true, 'Salvando projeto…');
    setTimeout(function () {
      var data = {
        app: 'retoque',
        version: 1,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        active: doc.indexOf(doc.active),
        layers: doc.layers.map(function (l) {
          return {
            name: l.name, x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible,
            text: l.text, image: l.canvas.toDataURL('image/png')
          };
        })
      };
      var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      ui.setBusy(false);
      saveFile(blob, safeName(doc.name) + '.retoque.json');
    }, 30);
  }

  function loadProject(file) {
    ui.setBusy(true, 'Abrindo projeto…');
    var fail = function (msg) {
      ui.setBusy(false);
      app.toast('Não foi possível abrir o projeto: ' + msg + '.', 'error');
    };
    file.text().then(function (txt) {
      var data;
      try { data = JSON.parse(txt); } catch (e) { fail('o arquivo não é um JSON válido'); return; }
      if (!data || data.app !== 'retoque' || !Array.isArray(data.layers) || !(data.width > 0) || !(data.height > 0)) {
        fail('ele não foi salvo pelo Retoque');
        return;
      }
      var blendOk = {};
      ui.BLEND_MODES.forEach(function (m) { blendOk[m[0]] = true; });
      Promise.all(data.layers.map(function (l) {
        if (typeof l.image !== 'string' || l.image.indexOf('data:image/') !== 0) return Promise.reject(new Error('camada sem imagem'));
        return loadImageSource(l.image).then(function (c) {
          var text = l.text && typeof l.text.content === 'string' ? {
            content: l.text.content, family: String(l.text.family || 'Arial'), size: Number(l.text.size) || 48,
            bold: !!l.text.bold, italic: !!l.text.italic, align: ['left', 'center', 'right'].indexOf(l.text.align) >= 0 ? l.text.align : 'left',
            color: validHex(l.text.color) ? l.text.color : '#000000'
          } : null;
          return new R.Layer({
            name: String(l.name || 'Camada'), canvas: c, x: Number(l.x) || 0, y: Number(l.y) || 0,
            opacity: Math.max(0, Math.min(1, Number(l.opacity))), blend: blendOk[l.blend] ? l.blend : 'source-over',
            visible: l.visible !== false, text: text
          });
        });
      })).then(function (layers) {
        var doc = new R.Doc(Math.min(MAX_SIDE, Math.round(data.width)), Math.min(MAX_SIDE, Math.round(data.height)), String(data.name || baseName(file.name)));
        doc.layers = layers;
        doc.active = layers[data.active] || layers[layers.length - 1] || null;
        ui.setBusy(false);
        setDocument(doc, 'Abrir projeto');
      }, function (err) { fail(err.message); });
    }, function () { fail('o arquivo não pôde ser lido'); });
  }

  /* ---------------------------------------------------------------- *
   * Diálogos
   * ---------------------------------------------------------------- */

  function numberInput(id, value, min, max) {
    return h('input', { type: 'number', id: id, class: 'num num-wide', min: min, max: max, step: 1, value: value });
  }

  function newDocumentDialog() {
    var presets = [
      ['1920x1080', 'Full HD — 1920 × 1080'], ['1280x720', 'HD — 1280 × 720'], ['3840x2160', '4K — 3840 × 2160'],
      ['1080x1080', 'Post quadrado — 1080 × 1080'], ['1080x1350', 'Post retrato — 1080 × 1350'],
      ['1080x1920', 'Stories e Reels — 1080 × 1920'], ['1280x720t', 'Miniatura de vídeo — 1280 × 720'],
      ['2480x3508', 'A4 a 300 dpi — 2480 × 3508'], ['1500x500', 'Banner — 1500 × 500'], ['custom', 'Personalizado']
    ];
    var preset = h('select', { id: 'nd-preset' }, presets.map(function (p) { return h('option', { value: p[0], text: p[1] }); }));
    var w = numberInput('nd-w', 1920, 1, MAX_SIDE), hh = numberInput('nd-h', 1080, 1, MAX_SIDE);
    var bg = h('select', { id: 'nd-bg' },
      h('option', { value: 'white', text: 'Branco' }), h('option', { value: 'transparent', text: 'Transparente' }),
      h('option', { value: 'primary', text: 'Cor primária' }), h('option', { value: 'secondary', text: 'Cor secundária' }));
    var name = h('input', { type: 'text', id: 'nd-name', value: 'Sem título' });
    preset.addEventListener('change', function () {
      var m = /^(\d+)x(\d+)/.exec(preset.value);
      if (m) { w.value = m[1]; hh.value = m[2]; }
    });
    [w, hh].forEach(function (inp) { inp.addEventListener('input', function () { preset.value = 'custom'; }); });
    ui.dialog({
      title: 'Novo documento',
      content: h('div', { class: 'form-grid' },
        ui.field('Nome', name),
        ui.field('Predefinição', preset),
        h('div', { class: 'field-pair' }, ui.field('Largura (px)', w), ui.field('Altura (px)', hh)),
        ui.field('Fundo', bg),
        app.pristine ? null : h('p', { class: 'form-note', text: 'O documento atual será fechado. Salve o projeto antes se quiser continuar a editá-lo depois.' })),
      actions: [
        { label: 'Cancelar', cancel: true },
        {
          label: 'Criar', primary: true, run: function () {
            var W = Math.round(Number(w.value)), H = Math.round(Number(hh.value));
            if (!(W >= 1 && H >= 1 && W <= MAX_SIDE && H <= MAX_SIDE) || W * H > MAX_PIXELS) {
              app.toast('Use dimensões entre 1 e ' + MAX_SIDE + ' px, com até ' + Math.round(MAX_PIXELS / 1e6) + ' megapixels.', 'error');
              return false;
            }
            var doc = new R.Doc(W, H, name.value.trim() || 'Sem título');
            var layer = doc.blankLayer('Fundo');
            var color = bg.value === 'white' ? '#ffffff' : bg.value === 'primary' ? app.colors.primary : bg.value === 'secondary' ? app.colors.secondary : null;
            if (color) {
              var ctx = layer.canvas.getContext('2d');
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, W, H);
            }
            doc.addLayer(layer);
            setDocument(doc, 'Novo documento');
          }
        }
      ]
    });
  }

  function imageSizeDialog() {
    var doc = app.doc, ratio = doc.width / doc.height;
    var w = numberInput('is-w', doc.width, 1, MAX_SIDE), hh = numberInput('is-h', doc.height, 1, MAX_SIDE);
    var link = h('input', { type: 'checkbox', id: 'is-link', checked: true });
    var pct = h('output', { class: 'form-note', text: '100% do tamanho atual' });
    var method = h('select', { id: 'is-method' },
      h('option', { value: 'smooth', text: 'Bicúbica — fotos e ilustrações' }),
      h('option', { value: 'nearest', text: 'Vizinho mais próximo — pixel art' }));
    function update() { pct.textContent = Math.round((Number(w.value) / doc.width) * 1000) / 10 + '% da largura atual'; }
    w.addEventListener('input', function () { if (link.checked) hh.value = Math.max(1, Math.round(Number(w.value) / ratio)); update(); });
    hh.addEventListener('input', function () { if (link.checked) w.value = Math.max(1, Math.round(Number(hh.value) * ratio)); update(); });
    var quick = h('div', { class: 'chip-row' }, [25, 50, 200].map(function (p) {
      return h('button', { class: 'chip', type: 'button', text: p + '%', onclick: function () {
        w.value = Math.max(1, Math.round((doc.width * p) / 100));
        hh.value = Math.max(1, Math.round((doc.height * p) / 100));
        update();
      } });
    }));
    ui.dialog({
      title: 'Tamanho da imagem',
      content: h('div', { class: 'form-grid' },
        h('div', { class: 'field-pair' }, ui.field('Largura (px)', w), ui.field('Altura (px)', hh)),
        h('label', { class: 'opt-check' }, link, h('span', { text: 'Manter proporções' })),
        quick, pct,
        ui.field('Reamostragem', method)),
      actions: [
        { label: 'Cancelar', cancel: true },
        {
          label: 'Redimensionar', primary: true, run: function () {
            var W = Math.round(Number(w.value)), H = Math.round(Number(hh.value));
            if (!(W >= 1 && H >= 1 && W <= MAX_SIDE && H <= MAX_SIDE) || W * H > MAX_PIXELS) {
              app.toast('Use dimensões entre 1 e ' + MAX_SIDE + ' px, com até ' + Math.round(MAX_PIXELS / 1e6) + ' megapixels.', 'error');
              return false;
            }
            if (W === doc.width && H === doc.height) return;
            runBusy('Redimensionando…', function () { resizeImage(W, H, method.value); });
          }
        }
      ]
    });
  }

  function resizeImage(W, H, method) {
    var doc = app.doc;
    var sx = W / doc.width, sy = H / doc.height;
    var uniform = Math.abs(sx - sy) < 1e-3;
    doc.layers.forEach(function (l) {
      var x1 = Math.round((l.x + l.width) * sx), y1 = Math.round((l.y + l.height) * sy);
      var nx = Math.round(l.x * sx), ny = Math.round(l.y * sy);
      l.canvas = R.canvas.resample(l.canvas, Math.max(1, x1 - nx), Math.max(1, y1 - ny), method);
      l.x = nx;
      l.y = ny;
      if (l.text) {
        if (uniform) l.text.size = Math.max(1, Math.round(l.text.size * sx * 10) / 10);
        else l.text = null;
      }
    });
    doc.width = W;
    doc.height = H;
    doc.selection = null;
    app.commit('Tamanho da imagem');
    app.view.fit(doc);
    if (app.tool.docChanged) app.tool.docChanged();
    app.viewChanged();
  }

  function canvasSizeDialog() {
    var doc = app.doc;
    var w = numberInput('cs-w', doc.width, 1, MAX_SIDE), hh = numberInput('cs-h', doc.height, 1, MAX_SIDE);
    var anchor = { x: 0.5, y: 0.5 };
    var grid = h('div', { class: 'anchor-grid', role: 'radiogroup', 'aria-label': 'Ponto de ancoragem' });
    var cells = [];
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        (function (ax, ay) {
          var b = h('button', {
            type: 'button', class: 'anchor-cell', role: 'radio',
            'aria-label': 'Ancorar ' + ['em cima', 'no meio', 'embaixo'][ay * 2] + ' ' + ['à esquerda', 'ao centro', 'à direita'][ax * 2],
            onclick: function () { anchor = { x: ax, y: ay }; mark(); }
          });
          b._a = [ax, ay];
          cells.push(b);
          grid.appendChild(b);
        })(c / 2, r / 2);
      }
    }
    function mark() {
      cells.forEach(function (b) {
        var on = b._a[0] === anchor.x && b._a[1] === anchor.y;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    mark();
    var fillBg = h('input', { type: 'checkbox', id: 'cs-fill' });
    ui.dialog({
      title: 'Tamanho da tela',
      content: h('div', { class: 'form-grid' },
        h('p', { class: 'form-note', text: 'Aumenta ou reduz a área do documento sem redimensionar as camadas. Atual: ' + doc.width + ' × ' + doc.height + ' px.' }),
        h('div', { class: 'field-pair' }, ui.field('Largura (px)', w), ui.field('Altura (px)', hh)),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Âncora' }), grid),
        h('label', { class: 'opt-check' }, fillBg, h('span', { text: 'Preencher a área nova com a cor secundária' }))),
      actions: [
        { label: 'Cancelar', cancel: true },
        {
          label: 'Aplicar', primary: true, run: function () {
            var W = Math.round(Number(w.value)), H = Math.round(Number(hh.value));
            if (!(W >= 1 && H >= 1 && W <= MAX_SIDE && H <= MAX_SIDE) || W * H > MAX_PIXELS) {
              app.toast('Use dimensões entre 1 e ' + MAX_SIDE + ' px.', 'error');
              return false;
            }
            var dx = Math.round((W - doc.width) * anchor.x), dy = Math.round((H - doc.height) * anchor.y);
            doc.layers.forEach(function (l) { l.x += dx; l.y += dy; });
            doc.width = W;
            doc.height = H;
            doc.selection = null;
            if (fillBg.checked) {
              var bg = doc.blankLayer('Fundo da tela');
              var ctx = bg.canvas.getContext('2d');
              ctx.fillStyle = app.colors.secondary;
              ctx.fillRect(0, 0, W, H);
              var keep = doc.active;
              doc.addLayer(bg, 0);
              doc.active = keep || bg;
            }
            app.commit('Tamanho da tela');
            app.view.fit(doc);
            if (app.tool.docChanged) app.tool.docChanged();
            app.viewChanged();
          }
        }
      ]
    });
  }

  // Diálogo genérico de filtro com pré-visualização ao vivo.
  function filterDialog(title, label, params, fn) {
    var s = previewSession();
    if (!s) return;
    var values = {};
    params.forEach(function (p) { values[p.key] = p.value; });
    var renderedKey = null, timer = null;
    function key() { return JSON.stringify(values); }
    function update() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        ui.setBusy(true, 'Calculando prévia…');
        requestAnimationFrame(function () {
          setTimeout(function () {
            var k = key();
            s.render(function (img) { fn(img, values); });
            renderedKey = k;
            ui.setBusy(false);
          }, 0);
        });
      }, 90);
    }
    var controls = params.map(function (p) {
      if (p.type === 'check') {
        var cb = h('input', { type: 'checkbox', id: 'flt-' + p.key, checked: !!p.value, onchange: function () { values[p.key] = cb.checked; update(); } });
        return h('label', { class: 'opt-check' }, cb, h('span', { text: p.label }));
      }
      return ui.slider('flt-' + p.key, p.label, {
        min: p.min, max: p.max, step: p.step, value: p.value, unit: p.unit,
        onInput: function (v) { values[p.key] = v; update(); }
      });
    });
    var previewToggle = h('input', { type: 'checkbox', id: 'flt-preview', checked: true, onchange: function () { s.showResult(previewToggle.checked); } });
    ui.dialog({
      title: title,
      content: h('div', { class: 'form-grid' }, controls,
        h('label', { class: 'opt-check' }, previewToggle, h('span', { text: 'Mostrar prévia na imagem' })),
        h('p', { class: 'form-note', text: app.doc.selection ? 'Aplica-se apenas à área selecionada.' : 'Aplica-se à camada “' + s.layer.name + '”.' })),
      onCancel: function () { clearTimeout(timer); s.cancel(); },
      actions: [
        { label: 'Cancelar', cancel: true },
        {
          label: 'Aplicar', primary: true, run: function () {
            clearTimeout(timer);
            runBusy(null, function () {
              if (renderedKey !== key()) s.render(function (img) { fn(img, values); });
              s.apply(label);
            });
          }
        }
      ]
    });
    update();
  }

  function transformDialog() {
    var layer = app.editableLayer();
    if (!layer) return;
    var vals = { sx: 100, sy: 100, angle: 0 };
    var link = h('input', { type: 'checkbox', id: 'tf-link', checked: true });
    var result = null, timer = null;
    function compute() {
      result = R.canvas.transform(layer.canvas, vals.sx / 100, vals.sy / 100, vals.angle, true);
      layer.preview = { canvas: result.canvas, x: layer.x + result.dx, y: layer.y + result.dy };
      app.markDirty();
    }
    function update() { clearTimeout(timer); timer = setTimeout(compute, 40); }
    var sxs, sys;
    sxs = ui.slider('tf-sx', 'Largura', { min: 1, max: 400, step: 1, value: 100, unit: '%', onInput: function (v) {
      vals.sx = v;
      if (link.checked) { vals.sy = v; sys.querySelector('input[type=range]').value = v; sys.querySelector('input[type=number]').value = v; }
      update();
    } });
    sys = ui.slider('tf-sy', 'Altura', { min: 1, max: 400, step: 1, value: 100, unit: '%', onInput: function (v) {
      vals.sy = v;
      if (link.checked) { vals.sx = v; sxs.querySelector('input[type=range]').value = v; sxs.querySelector('input[type=number]').value = v; }
      update();
    } });
    var rot = ui.slider('tf-angle', 'Rotação', { min: -180, max: 180, step: 0.5, value: 0, unit: '°', onInput: function (v) { vals.angle = v; update(); } });
    ui.dialog({
      title: 'Transformar camada',
      content: h('div', { class: 'form-grid' }, sxs, sys,
        h('label', { class: 'opt-check' }, link, h('span', { text: 'Manter proporções' })), rot,
        layer.text ? h('p', { class: 'form-note', text: 'O texto será convertido em pixels e deixará de ser editável.' }) : null),
      onCancel: function () { clearTimeout(timer); layer.preview = null; app.markDirty(); },
      actions: [
        { label: 'Cancelar', cancel: true },
        {
          label: 'Aplicar', primary: true, run: function () {
            clearTimeout(timer);
            if (vals.sx === 100 && vals.sy === 100 && vals.angle === 0) { layer.preview = null; app.markDirty(); return; }
            compute();
            layer.preview = null;
            layer.canvas = result.canvas;
            layer.x += result.dx;
            layer.y += result.dy;
            layer.text = null;
            app.commit('Transformar camada');
          }
        }
      ]
    });
  }

  function exportDialog() {
    var doc = app.doc;
    var format = h('select', { id: 'ex-format' },
      h('option', { value: 'image/png', text: 'PNG — sem perdas, mantém transparência' }),
      h('option', { value: 'image/jpeg', text: 'JPEG — fotos, arquivo menor' }),
      h('option', { value: 'image/webp', text: 'WebP — moderno, transparência e arquivo pequeno' }));
    var scale = h('select', { id: 'ex-scale' }, [200, 150, 100, 75, 50, 25].map(function (p) {
      return h('option', { value: p, text: p + '% — ' + Math.max(1, Math.round((doc.width * p) / 100)) + ' × ' + Math.max(1, Math.round((doc.height * p) / 100)) + ' px' });
    }));
    scale.value = '100';
    var quality = ui.slider('ex-quality', 'Qualidade', { min: 1, max: 100, step: 1, value: 90, unit: '%', onInput: estimate });
    var name = h('input', { type: 'text', id: 'ex-name', value: safeName(doc.name) });
    var size = h('output', { class: 'export-size', text: 'Calculando tamanho…' });
    var bgNote = h('p', { class: 'form-note', text: 'Áreas transparentes ficam brancas no JPEG.' });
    var timer = null, token = 0;

    function extension() { return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[format.value]; }

    function build() {
      var flat = doc.flatten(format.value === 'image/jpeg' ? '#ffffff' : null);
      var k = Number(scale.value) / 100;
      if (k !== 1) flat = R.canvas.resample(flat, Math.max(1, Math.round(doc.width * k)), Math.max(1, Math.round(doc.height * k)));
      return flat;
    }

    function encode() {
      return R.canvas.toBlob(build(), format.value, format.value === 'image/png' ? undefined : quality.getValue() / 100);
    }

    function estimate() {
      clearTimeout(timer);
      var my = ++token;
      size.textContent = 'Calculando tamanho…';
      timer = setTimeout(function () {
        encode().then(function (blob) {
          if (my !== token) return;
          var kb = blob.size / 1024;
          var real = blob.type === format.value ? '' : ' (este navegador gera ' + blob.type.replace('image/', '').toUpperCase() + ')';
          size.textContent = 'Tamanho estimado: ' + (kb < 1024 ? Math.round(kb) + ' KB' : (kb / 1024).toFixed(1).replace('.', ',') + ' MB') + real;
        }, function () { size.textContent = ''; });
      }, 250);
    }

    function sync() {
      quality.hidden = format.value === 'image/png';
      bgNote.hidden = format.value !== 'image/jpeg';
      estimate();
    }
    format.addEventListener('change', sync);
    scale.addEventListener('change', estimate);

    ui.dialog({
      title: 'Exportar imagem',
      content: h('div', { class: 'form-grid' },
        ui.field('Nome do arquivo', name),
        ui.field('Formato', format),
        quality,
        ui.field('Tamanho', scale),
        bgNote, size),
      onCancel: function () { token++; clearTimeout(timer); },
      actions: [
        { label: 'Cancelar', cancel: true },
        {
          label: 'Exportar', primary: true, run: function () {
            token++;
            clearTimeout(timer);
            var filename = safeName(name.value || doc.name) + '.' + extension();
            ui.setBusy(true, 'Exportando…');
            setTimeout(function () {
              encode().then(function (blob) {
                ui.setBusy(false);
                var real = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
                if (real && real !== extension()) filename = filename.replace(/\.[^.]+$/, '.' + real);
                return saveFile(blob, filename);
              }).catch(function (err) {
                ui.setBusy(false);
                app.toast('Falha ao exportar: ' + err.message, 'error');
              });
            }, 30);
          }
        }
      ]
    });
    sync();
  }

  function shortcutsDialog() {
    var rows = [];
    R.tools.forEach(function (t) { rows.push([t.label, (t.shift ? 'Shift+' : '') + t.key.toUpperCase()]); });
    rows.push(['Usar a mão temporariamente', 'Espaço']);
    rows.push(['Diminuir / aumentar o pincel', '[  ]']);
    rows.push(['Dureza do pincel', 'Shift+[  ]']);
    rows.push(['Opacidade do pincel (10%–100%)', '1 … 0']);
    rows.push(['Copiar cor com o pincel', 'Alt+clique']);
    rows.push(['Mover camada 1 px / 10 px', 'Setas / Shift+setas']);
    Object.keys(app.commands).forEach(function (id) {
      var c = app.commands[id];
      if (c.keys) rows.push([typeof c.label === 'function' ? c.label() : c.label, c.keys]);
    });
    ui.dialog({
      title: 'Atalhos de teclado',
      wide: true,
      content: h('div', { class: 'shortcut-table-wrap' }, h('table', { class: 'shortcut-table' },
        h('tbody', null, rows.map(function (r) { return h('tr', null, h('td', { text: r[0] }), h('td', null, h('kbd', { text: r[1] }))); })))),
      actions: [{ label: 'Fechar', primary: true }]
    });
  }

  function aboutDialog() {
    ui.dialog({
      title: 'Sobre o Retoque',
      content: h('div', { class: 'about' },
        h('p', { text: 'Editor de imagens com camadas, ajustes de luz e cor, filtros, seleção, corte, texto e histórico completo.' }),
        h('p', { text: 'Tudo é processado no seu navegador. Suas imagens não são enviadas para nenhum servidor.' }),
        h('p', { class: 'form-note', text: 'Formatos: abre PNG, JPEG, WebP, GIF, BMP, SVG e projetos .retoque.json; exporta PNG, JPEG e WebP.' })),
      actions: [{ label: 'Fechar', primary: true }]
    });
  }

  /* ---------------------------------------------------------------- *
   * Comandos
   * ---------------------------------------------------------------- */

  function hasLayer() { return !!(app.doc && app.doc.active); }
  function hasSelection() { return !!(app.doc && app.doc.selection); }

  function formatCombo(combo) {
    var parts = combo.split('+');
    var key = parts.pop();
    var names = { delete: 'Delete', backspace: 'Backspace', arrowup: '↑', arrowdown: '↓', ' ': 'Espaço', '=': '+', '?': '?' };
    key = names[key] || key.toUpperCase();
    var mods = parts.map(function (m) {
      if (m === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (m === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (m === 'alt') return IS_MAC ? '⌥' : 'Alt';
      return m;
    });
    return IS_MAC ? mods.join('') + key : mods.concat([key]).join('+');
  }

  var KEYMAP = {};

  function cmd(id, label, run, opts) {
    var o = opts || {};
    app.commands[id] = { label: label, run: run, enabled: o.enabled, passive: o.passive, combos: o.combos || [] };
    if (o.combos && o.combos.length) app.commands[id].keys = formatCombo(o.combos[0]);
    (o.combos || []).forEach(function (c) { KEYMAP[c] = id; });
  }

  app.run = function (id) {
    var c = app.commands[id];
    if (!c || !app.doc) return;
    if (c.enabled && !c.enabled()) return;
    if (!c.passive) {
      if (textTool.editing) textTool.commit();
      app.beforeEdit();
    }
    c.run();
  };

  function layerOp(label, fn) {
    return function () {
      var l = app.editableLayer();
      if (!l) return;
      fn(l);
      app.commit(label);
    };
  }

  function copy(merged, cut) {
    var doc = app.doc, sel = doc.selection;
    var c, x, y;
    if (merged) {
      if (app.view.compDirty) app.view.updateComposite(doc);
      var r = sel || { x: 0, y: 0, w: doc.width, h: doc.height };
      c = R.canvas.create(r.w, r.h);
      c.getContext('2d').drawImage(app.view.comp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      x = r.x; y = r.y;
    } else {
      var l = app.editableLayer();
      if (!l) return;
      if (sel) {
        c = R.canvas.create(sel.w, sel.h);
        c.getContext('2d').drawImage(l.canvas, sel.x - l.x, sel.y - l.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
        x = sel.x; y = sel.y;
      } else {
        c = R.canvas.clone(l.canvas);
        x = l.x; y = l.y;
      }
      if (cut) {
        var nc = R.canvas.clone(l.canvas);
        var clip = sel ? app.selectionClip(l) : { x: 0, y: 0, w: l.width, h: l.height };
        nc.getContext('2d').clearRect(clip.x, clip.y, clip.w, clip.h);
        l.canvas = nc;
        l.text = null;
        app.commit('Recortar');
      }
    }
    app.clipboard = { canvas: c, x: x, y: y, stale: false };
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new window.ClipboardItem({ 'image/png': R.canvas.toBlob(c, 'image/png') })]).catch(function () {});
      }
    } catch (e) { /* a área de transferência do sistema pode estar bloqueada; a interna continua valendo */ }
    app.toast(cut ? 'Recortado.' : 'Copiado.');
  }

  function pasteInternal() {
    var cb = app.clipboard;
    if (!cb) { app.toast('Copie algo primeiro, ou use Ctrl+V para colar uma imagem de outro programa.'); return; }
    placeCanvas(R.canvas.clone(cb.canvas), 'Colado', { x: cb.x, y: cb.y });
  }

  function rotateImage(turns, label) {
    var doc = app.doc, W = doc.width, H = doc.height;
    doc.layers.forEach(function (l) {
      var x = l.x, y = l.y, w = l.width, hh = l.height;
      l.canvas = R.canvas.rotate(l.canvas, turns);
      if (turns === 1) { l.x = H - y - hh; l.y = x; }
      else if (turns === -1) { l.x = y; l.y = W - x - w; }
      else { l.x = W - x - w; l.y = H - y - hh; }
      l.text = null;
    });
    if (turns !== 2) { doc.width = H; doc.height = W; }
    doc.selection = null;
    app.commit(label);
    app.view.fit(doc);
    if (app.tool.docChanged) app.tool.docChanged();
    app.viewChanged();
  }

  function flipImage(horizontal) {
    var doc = app.doc;
    doc.layers.forEach(function (l) {
      l.canvas = R.canvas.flip(l.canvas, horizontal);
      if (horizontal) l.x = doc.width - l.x - l.width;
      else l.y = doc.height - l.y - l.height;
      l.text = null;
    });
    if (doc.selection) {
      var s = doc.selection;
      if (horizontal) s.x = doc.width - s.x - s.w;
      else s.y = doc.height - s.y - s.h;
    }
    app.commit(horizontal ? 'Espelhar horizontalmente' : 'Espelhar verticalmente');
  }

  function cycleTheme() {
    var root = document.documentElement;
    var cur = root.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : cur === 'light' ? null : 'dark';
    if (next) root.setAttribute('data-theme', next);
    else root.removeAttribute('data-theme');
    themeChanged();
    app.saveSettings();
    app.toast('Tema: ' + themeLabel() + '.');
  }

  function themeLabel() {
    var cur = document.documentElement.getAttribute('data-theme');
    return cur === 'dark' ? 'escuro' : cur === 'light' ? 'claro' : 'do sistema';
  }

  function themeChanged() {
    app.view.readTheme();
    app.requestRender();
    scheduleHistogram();
  }

  function registerCommands() {
    // Arquivo
    cmd('file.new', 'Novo documento…', newDocumentDialog, { combos: ['mod+alt+n'] });
    cmd('file.open', 'Abrir…', function () { $('file-input').click(); }, { combos: ['mod+o'] });
    cmd('file.place', 'Inserir imagem como camada…', function () { $('place-input').click(); });
    cmd('file.save', 'Salvar projeto (.json)', saveProject, { combos: ['mod+s'] });
    cmd('file.export', 'Exportar imagem…', exportDialog, { combos: ['mod+shift+s', 'mod+shift+e'] });

    // Editar
    cmd('edit.undo', 'Desfazer', app.undo, { passive: true, combos: ['mod+z'], enabled: function () { return app.history.canUndo() || adjust.pending() || !!textTool.editing; } });
    cmd('edit.redo', 'Refazer', app.redo, { passive: true, combos: ['mod+shift+z', 'mod+y'], enabled: function () { return app.history.canRedo(); } });
    cmd('edit.cut', 'Recortar', function () { copy(false, true); }, { combos: ['mod+x'], enabled: hasLayer });
    cmd('edit.copy', 'Copiar', function () { copy(false, false); }, { combos: ['mod+c'], enabled: hasLayer });
    cmd('edit.copyMerged', 'Copiar mesclado', function () { copy(true, false); }, { combos: ['mod+shift+c'] });
    cmd('edit.paste', 'Colar no mesmo lugar', pasteInternal, { enabled: function () { return !!app.clipboard; } });
    cmd('edit.clear', 'Apagar área selecionada', function () {
      if (!app.doc.selection) { app.toast('Faça uma seleção para apagar apenas uma parte.'); return; }
      var l = app.editableLayer();
      if (!l) return;
      var c = R.canvas.clone(l.canvas), clip = app.selectionClip(l);
      c.getContext('2d').clearRect(clip.x, clip.y, clip.w, clip.h);
      l.canvas = c;
      l.text = null;
      app.commit('Apagar');
    }, { combos: ['delete', 'backspace'], enabled: hasSelection });
    cmd('edit.fill', 'Preencher com a cor primária', function () {
      var l = app.editableLayer();
      if (!l) return;
      var c = R.canvas.clone(l.canvas), clip = app.selectionClip(l) || { x: 0, y: 0, w: l.width, h: l.height };
      var ctx = c.getContext('2d');
      ctx.fillStyle = app.colors.primary;
      ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
      l.canvas = c;
      l.text = null;
      app.commit('Preencher');
    }, { combos: ['alt+backspace', 'alt+delete'], enabled: hasLayer });
    cmd('select.all', 'Selecionar tudo', function () {
      app.doc.selection = { x: 0, y: 0, w: app.doc.width, h: app.doc.height };
      app.commit('Selecionar tudo');
    }, { combos: ['mod+a'] });
    cmd('select.none', 'Desmarcar', function () {
      app.doc.selection = null;
      app.commit('Desmarcar');
    }, { combos: ['mod+d'], enabled: hasSelection });

    // Imagem
    cmd('image.size', 'Tamanho da imagem…', imageSizeDialog, { combos: ['mod+alt+i'] });
    cmd('image.canvasSize', 'Tamanho da tela…', canvasSizeDialog, { combos: ['mod+alt+c'] });
    cmd('image.cropToSelection', 'Cortar para a seleção', function () { app.cropTo(app.doc.selection); }, { enabled: hasSelection });
    cmd('image.rotateCW', 'Girar 90° no sentido horário', function () { rotateImage(1, 'Girar 90° horário'); });
    cmd('image.rotateCCW', 'Girar 90° no sentido anti-horário', function () { rotateImage(-1, 'Girar 90° anti-horário'); });
    cmd('image.rotate180', 'Girar 180°', function () { rotateImage(2, 'Girar 180°'); });
    cmd('image.flipH', 'Espelhar horizontalmente', function () { flipImage(true); });
    cmd('image.flipV', 'Espelhar verticalmente', function () { flipImage(false); });
    cmd('image.autoContrast', 'Contraste automático', function () { quickFilter('Contraste automático', function (img) { ops.autoLevels(img, false); }); }, { combos: ['mod+alt+shift+l'], enabled: hasLayer });
    cmd('image.autoTone', 'Tom automático', function () { quickFilter('Tom automático', function (img) { ops.autoLevels(img, true); }); }, { combos: ['mod+shift+l'], enabled: hasLayer });
    cmd('image.flatten', 'Achatar imagem', function () {
      var doc = app.doc;
      var layer = new R.Layer({ name: 'Fundo', canvas: doc.flatten() });
      doc.layers = [layer];
      doc.active = layer;
      app.commit('Achatar imagem');
    }, { enabled: function () { return app.doc.layers.length > 0; } });

    // Camada
    cmd('layer.new', 'Nova camada', function () {
      var doc = app.doc;
      doc.addLayer(doc.blankLayer('Camada ' + (doc.layers.length + 1)));
      app.commit('Nova camada');
    }, { combos: ['shift+n'] });
    cmd('layer.duplicate', 'Duplicar camada', function () {
      var doc = app.doc, l = doc.active;
      doc.addLayer(new R.Layer({
        name: l.name + ' cópia', canvas: l.canvas, x: l.x, y: l.y, opacity: l.opacity, blend: l.blend,
        visible: l.visible, text: l.text ? Object.assign({}, l.text) : null
      }));
      app.commit('Duplicar camada');
    }, { combos: ['mod+j'], enabled: hasLayer });
    cmd('layer.delete', 'Excluir camada', function () {
      app.doc.removeLayer(app.doc.active);
      app.commit('Excluir camada');
    }, { enabled: hasLayer });
    cmd('layer.transform', 'Transformar camada…', transformDialog, { combos: ['mod+alt+t'], enabled: hasLayer });
    cmd('layer.flipH', 'Espelhar camada horizontalmente', layerOp('Espelhar camada', function (l) { l.canvas = R.canvas.flip(l.canvas, true); l.text = null; }), { enabled: hasLayer });
    cmd('layer.flipV', 'Espelhar camada verticalmente', layerOp('Espelhar camada', function (l) { l.canvas = R.canvas.flip(l.canvas, false); l.text = null; }), { enabled: hasLayer });
    cmd('layer.center', 'Centralizar camada', layerOp('Centralizar camada', function (l) {
      l.x = Math.round((app.doc.width - l.width) / 2);
      l.y = Math.round((app.doc.height - l.height) / 2);
    }), { enabled: hasLayer });
    cmd('layer.rasterize', 'Converter texto em pixels', layerOp('Converter texto em pixels', function (l) { l.text = null; }), { enabled: function () { return !!(app.doc.active && app.doc.active.text); } });
    cmd('layer.up', 'Subir camada', function () {
      var doc = app.doc, i = doc.indexOf(doc.active);
      doc.layers.splice(i, 1);
      doc.layers.splice(i + 1, 0, doc.active);
      app.commit('Subir camada');
    }, { combos: ['mod+]'], enabled: function () { return hasLayer() && app.doc.indexOf(app.doc.active) < app.doc.layers.length - 1; } });
    cmd('layer.down', 'Descer camada', function () {
      var doc = app.doc, i = doc.indexOf(doc.active);
      doc.layers.splice(i, 1);
      doc.layers.splice(i - 1, 0, doc.active);
      app.commit('Descer camada');
    }, { combos: ['mod+['], enabled: function () { return hasLayer() && app.doc.indexOf(app.doc.active) > 0; } });
    cmd('layer.mergeDown', 'Mesclar com a camada de baixo', function () {
      var doc = app.doc, l = doc.active, below = doc.layers[doc.indexOf(l) - 1];
      var x0 = Math.min(l.x, below.x), y0 = Math.min(l.y, below.y);
      var x1 = Math.max(l.x + l.width, below.x + below.width), y1 = Math.max(l.y + l.height, below.y + below.height);
      var c = R.canvas.create(x1 - x0, y1 - y0);
      var ctx = c.getContext('2d');
      ctx.drawImage(below.canvas, below.x - x0, below.y - y0);
      if (l.visible) {
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = l.blend;
        ctx.drawImage(l.canvas, l.x - x0, l.y - y0);
      }
      below.canvas = c;
      below.x = x0;
      below.y = y0;
      below.text = null;
      doc.removeLayer(l);
      doc.active = below;
      app.commit('Mesclar camadas');
    }, { combos: ['mod+e'], enabled: function () { return hasLayer() && app.doc.indexOf(app.doc.active) > 0; } });

    // Filtros
    cmd('filter.blur', 'Desfoque gaussiano…', function () {
      filterDialog('Desfoque gaussiano', 'Desfoque gaussiano', [{ key: 'radius', label: 'Raio', min: 0.5, max: 100, step: 0.5, value: 4, unit: 'px' }],
        function (img, v) { ops.gaussianBlur(img, v.radius); });
    }, { enabled: hasLayer });
    cmd('filter.sharpen', 'Nitidez…', function () {
      filterDialog('Máscara de nitidez', 'Nitidez', [
        { key: 'amount', label: 'Intensidade', min: 1, max: 500, step: 1, value: 80, unit: '%' },
        { key: 'radius', label: 'Raio', min: 0.5, max: 20, step: 0.1, value: 1.5, unit: 'px' },
        { key: 'threshold', label: 'Limiar', min: 0, max: 64, step: 1, value: 2, unit: 'níveis' }
      ], function (img, v) { ops.unsharpMask(img, v.amount, v.radius, v.threshold); });
    }, { enabled: hasLayer });
    cmd('filter.noise', 'Adicionar ruído…', function () {
      var seed = Math.floor(Math.random() * 1e9);
      filterDialog('Adicionar ruído', 'Ruído', [
        { key: 'amount', label: 'Quantidade', min: 1, max: 100, step: 1, value: 12, unit: '%' },
        { key: 'mono', label: 'Monocromático (granulação de filme)', type: 'check', value: true }
      ], function (img, v) { ops.noise(img, v.amount, v.mono, seed); });
    }, { enabled: hasLayer });
    cmd('filter.pixelate', 'Pixelizar…', function () {
      filterDialog('Pixelizar', 'Pixelizar', [{ key: 'size', label: 'Tamanho do bloco', min: 2, max: 200, step: 1, value: 12, unit: 'px' }],
        function (img, v) { ops.pixelate(img, v.size); });
    }, { enabled: hasLayer });
    cmd('filter.vignette', 'Vinheta…', function () {
      filterDialog('Vinheta', 'Vinheta', [
        { key: 'amount', label: 'Intensidade', min: -100, max: 100, step: 1, value: -45 },
        { key: 'size', label: 'Início', min: 0, max: 100, step: 1, value: 45, unit: '%' }
      ], function (img, v) { ops.vignette(img, v.amount, v.size); });
    }, { enabled: hasLayer });
    cmd('filter.posterize', 'Posterizar…', function () {
      filterDialog('Posterizar', 'Posterizar', [{ key: 'levels', label: 'Níveis por canal', min: 2, max: 32, step: 1, value: 6 }],
        function (img, v) { ops.posterize(img, v.levels); });
    }, { enabled: hasLayer });
    cmd('filter.threshold', 'Limiar…', function () {
      filterDialog('Limiar', 'Limiar', [{ key: 'level', label: 'Nível', min: 1, max: 255, step: 1, value: 128 }],
        function (img, v) { ops.threshold(img, v.level); });
    }, { enabled: hasLayer });
    cmd('filter.grayscale', 'Preto e branco', function () { quickFilter('Preto e branco', ops.grayscale); }, { combos: ['mod+shift+u'], enabled: hasLayer });
    cmd('filter.sepia', 'Sépia', function () { quickFilter('Sépia', function (img) { ops.sepia(img, 1); }); }, { enabled: hasLayer });
    cmd('filter.invert', 'Inverter cores', function () { quickFilter('Inverter cores', ops.invert); }, { combos: ['mod+i'], enabled: hasLayer });
    cmd('filter.edges', 'Detectar bordas', function () { quickFilter('Detectar bordas', ops.edgeDetect); }, { enabled: hasLayer });

    // Exibir
    cmd('view.zoomIn', 'Aproximar', function () { app.view.zoomStep(1); app.viewChanged(); }, { passive: true, combos: ['mod+=', 'mod++', 'mod+shift++', 'mod+shift+='] });
    cmd('view.zoomOut', 'Afastar', function () { app.view.zoomStep(-1); app.viewChanged(); }, { passive: true, combos: ['mod+-', 'mod+shift+_'] });
    cmd('view.fit', 'Ajustar à tela', function () { app.view.fit(app.doc, true); app.viewChanged(); }, { passive: true, combos: ['mod+0'] });
    cmd('view.actual', 'Tamanho real (100%)', function () { app.view.zoom = 1; app.view.center(app.doc); app.viewChanged(); }, { passive: true, combos: ['mod+1'] });
    cmd('view.theme', function () { return 'Alternar tema (atual: ' + themeLabel() + ')'; }, cycleTheme, { passive: true });
    cmd('view.panels', 'Mostrar ou ocultar painéis', togglePanels, { passive: true });

    // Cores e ajuda
    cmd('color.swap', 'Trocar cores', function () {
      var p = app.colors.primary;
      app.colors.primary = app.colors.secondary;
      app.colors.secondary = p;
      ui.refreshSwatches();
      if (app.tool.colorChanged) app.tool.colorChanged();
      app.saveSettings();
    }, { passive: true, combos: ['x'] });
    cmd('color.reset', 'Cores padrão', function () {
      app.colors.primary = '#000000';
      app.colors.secondary = '#ffffff';
      ui.refreshSwatches();
      if (app.tool.colorChanged) app.tool.colorChanged();
      app.saveSettings();
    }, { passive: true, combos: ['d'] });
    cmd('help.shortcuts', 'Atalhos de teclado', shortcutsDialog, { passive: true, combos: ['shift+?'] });
    cmd('help.about', 'Sobre o Retoque', aboutDialog, { passive: true });
  }

  var MENUS = [
    { label: 'Arquivo', items: ['file.new', 'file.open', 'file.place', '-', 'file.save', 'file.export'] },
    { label: 'Editar', items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.copyMerged', 'edit.paste', '-', 'edit.clear', 'edit.fill', '-', 'select.all', 'select.none'] },
    { label: 'Imagem', items: ['image.size', 'image.canvasSize', 'image.cropToSelection', '-', 'image.rotateCW', 'image.rotateCCW', 'image.rotate180', 'image.flipH', 'image.flipV', '-', 'image.autoContrast', 'image.autoTone', '-', 'image.flatten'] },
    { label: 'Camada', items: ['layer.new', 'layer.duplicate', 'layer.delete', '-', 'layer.transform', 'layer.flipH', 'layer.flipV', 'layer.center', 'layer.rasterize', '-', 'layer.up', 'layer.down', 'layer.mergeDown'] },
    { label: 'Filtros', items: ['filter.blur', 'filter.sharpen', 'filter.noise', 'filter.pixelate', 'filter.vignette', '-', 'filter.grayscale', 'filter.sepia', 'filter.invert', 'filter.posterize', 'filter.threshold', 'filter.edges'] },
    { label: 'Exibir', items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.theme', 'view.panels'] },
    { label: 'Ajuda', items: ['help.shortcuts', 'help.about'] }
  ];

  function togglePanels() {
    var open = document.body.classList.toggle('panels-open');
    $('panel-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ---------------------------------------------------------------- *
   * Ponteiro, roda do mouse e gestos
   * ---------------------------------------------------------------- */

  var pointer = { active: false, id: null, mode: null, last: null };
  var touches = new Map();
  var pinch = null;
  var spaceDown = false;

  function makePoint(canvas, e) {
    var p = app.view.screenToDoc(e.clientX, e.clientY);
    var rect = canvas.getBoundingClientRect();
    p.sx = e.clientX - rect.left;
    p.sy = e.clientY - rect.top;
    p.pressure = e.pressure || 0.5;
    p.pen = e.pointerType === 'pen';
    return p;
  }

  function pinchInfo() {
    var pts = Array.from(touches.values());
    return {
      dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
    };
  }

  function bindPointer() {
    var canvas = $('view');

    canvas.addEventListener('pointerdown', function (e) {
      ui.closeMenus();
      ui.closeColorPicker();
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          if (pointer.active && pointer.mode === 'tool' && app.tool.cancel) app.tool.cancel();
          pointer.active = false;
          var info = pinchInfo();
          pinch = { dist: info.dist, mid: info.mid, zoom: app.view.zoom, panX: app.view.panX, panY: app.view.panY };
          return;
        }
        if (touches.size > 2) return;
      }
      if (pointer.active || (e.button !== 0 && e.button !== 1)) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignora */ }
      e.preventDefault();
      pointer.id = e.pointerId;
      if (e.button === 1 || spaceDown || app.tool.id === 'hand') {
        pointer.active = true;
        pointer.mode = 'pan';
        pointer.last = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (['hand', 'zoom', 'eyedropper', 'text'].indexOf(app.tool.id) < 0) app.beforeEdit();
      if (app.tool.down && app.tool.down(makePoint(canvas, e), e)) {
        pointer.active = true;
        pointer.mode = 'tool';
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size >= 2) {
          var info = pinchInfo(), rect = canvas.getBoundingClientRect();
          var z = Math.max(0.02, Math.min(64, (pinch.zoom * info.dist) / pinch.dist));
          var dx = (pinch.mid.x - rect.left - pinch.panX) / pinch.zoom;
          var dy = (pinch.mid.y - rect.top - pinch.panY) / pinch.zoom;
          app.view.zoom = z;
          app.view.panX = info.mid.x - rect.left - dx * z;
          app.view.panY = info.mid.y - rect.top - dy * z;
          app.viewChanged();
          return;
        }
      }
      var p = makePoint(canvas, e);
      app.pointer = { x: p.x, y: p.y, inside: true };
      if (pointer.active && e.pointerId === pointer.id) {
        if (pointer.mode === 'pan') {
          app.view.panX += e.clientX - pointer.last.x;
          app.view.panY += e.clientY - pointer.last.y;
          pointer.last = { x: e.clientX, y: e.clientY };
          app.viewChanged();
          return;
        }
        if (app.tool.move) {
          var list = app.tool.coalesce && e.getCoalescedEvents ? e.getCoalescedEvents() : null;
          if (list && list.length) list.forEach(function (ev) { app.tool.move(makePoint(canvas, ev), e); });
          else app.tool.move(p, e);
        }
      } else if (!pointer.active) {
        if (spaceDown) canvas.style.cursor = 'grab';
        else if (app.tool.hover) canvas.style.cursor = app.tool.hover(p, e) || app.tool.cursor;
      }
      app.requestRender();
    });

    function end(e) {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (pinch) { if (touches.size < 2) pinch = null; return; }
      }
      if (!pointer.active || e.pointerId !== pointer.id) return;
      var mode = pointer.mode;
      pointer.active = false;
      pointer.mode = null;
      if (mode === 'pan') { canvas.style.cursor = spaceDown ? 'grab' : app.tool.cursor; return; }
      if (e.type === 'pointercancel') { if (app.tool.cancel) app.tool.cancel(); return; }
      if (app.tool.up) app.tool.up(makePoint(canvas, e), e);
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', function () {
      if (app.pointer) app.pointer.inside = false;
      app.requestRender();
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        var k = e.deltaMode === 1 ? 0.05 : 0.0025;
        app.view.setZoom(app.view.zoom * Math.exp(-e.deltaY * k), sx, sy);
      } else {
        var unit = e.deltaMode === 1 ? 16 : 1;
        var dx = e.deltaX, dy = e.deltaY;
        if (e.shiftKey && !dx) { dx = dy; dy = 0; }
        app.view.panX -= dx * unit;
        app.view.panY -= dy * unit;
      }
      app.viewChanged();
    }, { passive: false });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ---------------------------------------------------------------- *
   * Teclado
   * ---------------------------------------------------------------- */

  function isTyping(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
    return el.tagName === 'INPUT' && ['range', 'checkbox', 'radio', 'button', 'color'].indexOf(el.type) < 0;
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.target === app.textArea) {
        if (e.key === 'Escape') { e.preventDefault(); textTool.cancel(); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); textTool.commit(); }
        return;
      }
      if (ui.hasDialog()) {
        if ((e.key === 'Escape' || e.key === 'Enter') && ui.dialogKey(e)) e.preventDefault();
        return;
      }
      if (e.key === 'Escape') { ui.closeMenus(); ui.closeColorPicker(); }
      if (isTyping(e.target)) return;
      if (!app.doc) return;

      var mod = e.ctrlKey || e.metaKey;
      var k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();

      if (e.key === ' ' && !mod) {
        e.preventDefault();
        if (!spaceDown) { spaceDown = true; if (!pointer.active) $('view').style.cursor = 'grab'; }
        return;
      }

      if (app.tool.onKey && app.tool.onKey(e)) { e.preventDefault(); return; }

      var combo = (mod ? 'mod+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + k;
      var id = KEYMAP[combo];
      if (id) {
        e.preventDefault();
        app.run(id);
        return;
      }
      if (mod || e.altKey) return;

      // Ferramentas
      for (var i = 0; i < R.tools.length; i++) {
        var t = R.tools[i];
        if (t.key === k && !!t.shift === e.shiftKey) { e.preventDefault(); app.setTool(t.id); return; }
      }

      var s = app.settings[app.tool.id];
      if ((k === '[' || k === ']' || k === '{' || k === '}') && s && 'size' in s) {
        e.preventDefault();
        var up = k === ']' || k === '}';
        if (e.shiftKey && 'hardness' in s) {
          s.hardness = Math.max(0, Math.min(100, s.hardness + (up ? 10 : -10)));
          ui.syncOption('hardness');
        } else {
          var max = app.tool.id === 'text' ? 400 : 500;
          s.size = Math.max(1, Math.min(max, up ? Math.ceil(s.size * 1.15 + 0.5) : Math.floor(s.size / 1.15)));
          ui.syncOption('size');
          if (app.tool.optionChanged) app.tool.optionChanged('size');
        }
        app.saveSettings();
        app.requestRender();
        return;
      }

      if (/^[0-9]$/.test(k) && s && 'opacity' in s) {
        e.preventDefault();
        s.opacity = k === '0' ? 100 : Number(k) * 10;
        ui.syncOption('opacity');
        app.saveSettings();
        return;
      }

      if (k.indexOf('arrow') === 0 && app.tool.id === 'move' && app.doc.active) {
        e.preventDefault();
        var step = e.shiftKey ? 10 : 1;
        var l = app.doc.active;
        if (k === 'arrowleft') l.x -= step;
        if (k === 'arrowright') l.x += step;
        if (k === 'arrowup') l.y -= step;
        if (k === 'arrowdown') l.y += step;
        var now = Date.now();
        if (nudge.index === app.history.index && now - nudge.time < 1500) {
          app.history.amend(app.doc.snapshot());
          app.pristine = false;
          afterChange();
        } else {
          app.commit('Mover camada');
          nudge.index = app.history.index;
        }
        nudge.time = now;
      }
    });

    document.addEventListener('keyup', function (e) {
      if (e.key === ' ' && spaceDown) {
        spaceDown = false;
        if (!pointer.active) $('view').style.cursor = app.tool.cursor;
      }
    });

    window.addEventListener('blur', function () {
      spaceDown = false;
      if (app.clipboard) app.clipboard.stale = true;
    });
  }

  /* ---------------------------------------------------------------- *
   * Colar, arrastar e soltar
   * ---------------------------------------------------------------- */

  function bindTransfer() {
    document.addEventListener('paste', function (e) {
      if (isTyping(e.target) || ui.hasDialog()) return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var file = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { file = items[i].getAsFile(); break; }
      }
      e.preventDefault();
      if (app.clipboard && !app.clipboard.stale) { pasteInternal(); return; }
      if (file) {
        loadImageFile(file).then(function (c) { placeCanvas(c, 'Imagem colada'); }, function () {
          app.toast('Não foi possível ler a imagem colada.', 'error');
        });
        return;
      }
      if (app.clipboard) { pasteInternal(); return; }
      app.toast('A área de transferência não tem uma imagem.');
    });

    var hint = $('drop-hint'), depth = 0;
    function hasFiles(e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      depth++;
      hint.textContent = app.pristine ? 'Solte para abrir a imagem' : 'Solte para inserir como nova camada';
      hint.hidden = false;
    });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) hint.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      hint.hidden = true;
      var files = e.dataTransfer.files;
      if (!files.length) return;
      openFiles(files, !app.pristine && !isProjectFile(files[0]));
    });

    $('file-input').addEventListener('change', function (e) {
      openFiles(e.target.files, false);
      e.target.value = '';
    });
    $('place-input').addEventListener('change', function (e) {
      openFiles(e.target.files, true);
      e.target.value = '';
    });
  }

  /* ---------------------------------------------------------------- *
   * Inicialização
   * ---------------------------------------------------------------- */

  function bindChrome() {
    $('zoom-out').addEventListener('click', function () { app.run('view.zoomOut'); });
    $('zoom-in').addEventListener('click', function () { app.run('view.zoomIn'); });
    $('zoom-fit').addEventListener('click', function () { app.run('view.fit'); });
    var zi = $('zoom-input');
    zi.addEventListener('change', function () {
      var v = parseFloat(String(zi.value).replace(',', '.'));
      if (v > 0) { app.view.setZoom(v / 100); app.viewChanged(); }
      zi.blur();
      ui.refreshStatus();
    });
    zi.addEventListener('focus', function () { zi.select(); });
    $('panel-toggle').addEventListener('click', togglePanels);
    $('btn-open').addEventListener('click', function () { app.run('file.open'); });
    $('btn-export').addEventListener('click', function () { app.run('file.export'); });
    $('panels-close').addEventListener('click', togglePanels);
    $('dialog-root').addEventListener('pointerdown', function (e) {
      if (e.target === e.currentTarget) ui.closeDialog(true);
    });
    $('adjust-toggle').addEventListener('click', function () {
      var panel = $('panel-adjust');
      var collapsed = panel.classList.toggle('is-collapsed');
      $('adjust-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      try { localStorage.setItem('retoque.adjustCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignora */ }
    });
    try {
      if (localStorage.getItem('retoque.adjustCollapsed') === '1') {
        $('panel-adjust').classList.add('is-collapsed');
        $('adjust-toggle').setAttribute('aria-expanded', 'false');
      }
    } catch (e) { /* ignora */ }

    var viewport = $('viewport');
    var first = true;
    var ro = new ResizeObserver(function () {
      var oldW = app.view.cssW, oldH = app.view.cssH;
      app.view.resize();
      if (first) { first = false; if (app.doc) app.view.fit(app.doc); }
      else {
        app.view.panX += (app.view.cssW - oldW) / 2;
        app.view.panY += (app.view.cssH - oldH) / 2;
      }
      app.viewChanged();
      scheduleHistogram();
    });
    ro.observe(viewport);

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { themeChanged(); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { app.requestRender(); });

    window.addEventListener('beforeunload', function (e) {
      if (app.pristine) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  function init() {
    loadSettings();
    ui.init(app);
    app.textArea = $('text-editor');
    app.textArea.addEventListener('input', function () { textTool.layout(); });
    app.view = new R.View($('view'));
    registerCommands();
    ui.buildMenus(MENUS);
    ui.buildToolbar();
    ui.buildLayersPanel();
    ui.buildAdjustPanel();
    ui.refreshSwatches();
    app.view.resize();

    var sample = R.createSampleCanvas(1600, 1067);
    var doc = new R.Doc(sample.width, sample.height, 'Exemplo — lago ao entardecer');
    doc.addLayer(new R.Layer({ name: 'Fundo', canvas: sample }));
    app.tool = toolById.hand;
    setDocument(doc, 'Abrir exemplo');
    app.tool = null;
    app.setTool(storedTool || 'brush');

    bindPointer();
    bindKeyboard();
    bindTransfer();
    bindChrome();
    getDownloads();
    document.documentElement.classList.add('is-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
