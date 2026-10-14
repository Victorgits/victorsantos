/*
 * Retoque — edição automática em lote.
 *
 * 1. Estilo: aprende com DNGs exportados do Lightroom (original + versão
 *    editada dentro do mesmo arquivo) ou carrega um estilo salvo.
 * 2. Fotos: JPEG, PNG, WebP ou DNG; cada uma recebe o estilo e uma
 *    exposição automática, com ajuste fino por foto.
 * 3. Exporta tudo em JPEG dentro de um ZIP, mantendo os dados da câmera.
 */
(function () {
  'use strict';
  var R = window.Retoque;
  var ui = R.ui, h = ui.h, ops = R.ops, S = R.style, M = R.meta;

  var THUMB = 420;
  var TRAIN = 640;
  var STORE_KEY = 'retoque.style.v1';
  var NEUTRAL_KEY = -2.2;
  var nextId = 1;

  var state = {
    refs: [],
    photos: [],
    style: null,
    styleInfo: null,
    savedStyle: null,
    options: { strength: 100, autoExposure: true, exposure: 0, effects: true, autoContrast: true, size: '0', quality: 90, keepMeta: true, suffix: '-editada' },
    running: false,
    cancel: false
  };
  var root = null;
  var els = {};

  function app() { return R.app; }

  function fmtEv(v) {
    var s = Math.abs(v).toFixed(1).replace('.', ',');
    return (v > 0.04 ? '+' : v < -0.04 ? '−' : '') + s + ' EV';
  }

  function cloneImage(img) { return ops.cloneImageData(img); }

  function nextFrame() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { setTimeout(resolve, 0); }); });
  }

  function neutralStyle() {
    var curve = new Float32Array(256);
    for (var i = 0; i < 256; i++) curve[i] = i;
    return { grid: 2, curves: [curve, curve, curve], residual: new Float32Array(24), targetKey: NEUTRAL_KEY, exposureShift: 0, references: 0 };
  }

  function activeStyle() { return state.style || neutralStyle(); }

  function effects() {
    if (!state.options.effects) return null;
    return state.styleInfo && state.styleInfo.effects ? state.styleInfo.effects : null;
  }

  /* ---------------------------------------------------------------- *
   * Pipeline de edição (miniaturas e arquivos finais)
   * ---------------------------------------------------------------- */

  function evFor(item) {
    var o = state.options;
    return (o.autoExposure ? item.autoEv || 0 : 0) + o.exposure + (item.ev || 0);
  }

  // scale: tamanho da imagem processada em relação à foto original (para a nitidez).
  function process(img, ev, full, scale) {
    var o = state.options, k = o.strength / 100;
    if (state.style) {
      S.applyStyle(img, state.style, { strength: k, exposure: ev });
    } else {
      if (ev) S.applyStyle(img, neutralStyle(), { exposure: ev });
      if (o.autoContrast && k > 0) {
        var before = k < 1 ? cloneImage(img) : null;
        ops.autoLevels(img, false, 0.1);
        if (before) for (var i = 0; i < img.data.length; i++) img.data[i] = before.data[i] + (img.data[i] - before.data[i]) * k;
      }
    }
    var fx = effects();
    if (fx && k > 0) {
      if (fx.vignetteAmount) ops.vignette(img, Math.max(-100, Math.min(100, fx.vignetteAmount * 0.5 * k)), 25 + fx.vignetteMidpoint * 0.5);
      if (full && fx.sharpenAmount > 0) {
        var radius = Math.max(0.5, fx.sharpenRadius * Math.min(1, scale || 1));
        sharpenInStrips(img, fx.sharpenAmount * 0.7 * k, radius);
      }
    }
    return img;
  }

  // Máscara de nitidez em faixas, para não alocar várias cópias de uma foto de 24 MP.
  function sharpenInStrips(img, amount, radius) {
    var w = img.width, hgt = img.height, d = img.data;
    var pad = Math.ceil(radius * 3) + 2, stripH = 384;
    var rowBytes = w * 4;
    var prevTail = null, prevTailStart = 0;
    for (var y0 = 0; y0 < hgt; y0 += stripH) {
      var y1 = Math.min(hgt, y0 + stripH);
      var a = Math.max(0, y0 - pad), b = Math.min(hgt, y1 + pad);
      var buf = ops.createImageData(w, b - a);
      buf.data.set(d.subarray(a * rowBytes, b * rowBytes));
      if (prevTail) buf.data.set(prevTail.subarray((a - prevTailStart) * rowBytes), 0);
      var tailStart = Math.max(0, y1 - pad);
      prevTail = d.slice(tailStart * rowBytes, y1 * rowBytes);
      prevTailStart = tailStart;
      ops.unsharpMask(buf, amount, radius, 2);
      d.set(buf.data.subarray((y0 - a) * rowBytes, (y1 - a) * rowBytes), y0 * rowBytes);
    }
  }

  /* ---------------------------------------------------------------- *
   * Estilo: referências e aprendizado
   * ---------------------------------------------------------------- */

  function luminanceSmall(src, w, hgt) {
    var c = R.canvas.create(w, hgt);
    var ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, hgt);
    var d = ctx.getImageData(0, 0, w, hgt).data, out = new Float32Array(w * hgt);
    for (var i = 0; i < out.length; i++) out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    return out;
  }

  function correlation(a, b) {
    var n = a.length, ma = 0, mb = 0;
    for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) {
      var x = a[i] - ma, y = b[i] - mb;
      sab += x * y; saa += x * x; sbb += y * y;
    }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }

  // Possíveis enquadramentos do corte do Lightroom, em coordenadas do sensor.
  function cropCandidates(settings, orientation) {
    var s = settings || {};
    if (s.HasCrop !== true) return [{ rect: [0, 0, 1, 1], angle: 0 }];
    var l = +s.CropLeft || 0, t = +s.CropTop || 0, r = s.CropRight == null ? 1 : +s.CropRight, b = s.CropBottom == null ? 1 : +s.CropBottom;
    var rects = [[l, t, r, b]];
    if (orientation === 6) rects.push([t, 1 - r, b, 1 - l]);
    else if (orientation === 8) rects.push([1 - b, l, 1 - t, r]);
    else if (orientation === 3) rects.push([1 - r, 1 - b, 1 - l, 1 - t]);
    var angle = +s.CropAngle || 0;
    var out = [];
    rects.forEach(function (rc) {
      out.push({ rect: rc, angle: 0 });
      if (angle) { out.push({ rect: rc, angle: angle }); out.push({ rect: rc, angle: -angle }); }
    });
    out.push({ rect: [0, 0, 1, 1], angle: 0 });
    return out;
  }

  function renderCrop(src, cand, w, hgt) {
    var c = R.canvas.create(w, hgt);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    var rc = cand.rect;
    var cx = ((rc[0] + rc[2]) / 2) * src.width, cy = ((rc[1] + rc[3]) / 2) * src.height;
    var cw = (rc[2] - rc[0]) * src.width, ch = (rc[3] - rc[1]) * src.height;
    ctx.translate(w / 2, hgt / 2);
    ctx.scale(w / cw, hgt / ch);
    ctx.rotate((-cand.angle * Math.PI) / 180);
    ctx.translate(-cx, -cy);
    ctx.drawImage(src, 0, 0);
    return c;
  }

  function imageDataOf(canvas) {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  }

  // Lê um DNG editado e prepara o par antes/depois alinhado.
  function prepareReference(file) {
    return R.decode.loadSource(file).then(function (src) {
      if (src.kind !== 'dng') throw new Error('use um DNG exportado do Lightroom (ele traz o original e a edição juntos)');
      if (!src.hasEdited) throw new Error('este DNG não tem uma versão editada pelo Lightroom');
      if (!src.hasOriginal) throw new Error('a foto original deste DNG é RAW da câmera; por enquanto o Retoque aprende com fotos tiradas em JPEG');
      return Promise.all([
        R.decode.decodeSource(src, 'edited', TRAIN, true),
        R.decode.decodeSource(src, 'original', TRAIN * 2.5, true)
      ]).then(function (res) {
        var after = res[0], original = res[1];
        var sw = 64, sh = Math.max(8, Math.round((64 * after.height) / after.width));
        var target = luminanceSmall(after, sw, sh);
        var best = null;
        cropCandidates(src.settings, src.orientation).forEach(function (cand) {
          var r = correlation(luminanceSmall(renderCrop(original, cand, sw, sh), sw, sh), target);
          if (!best || r > best.r) best = { cand: cand, r: r };
        });
        if (!best || best.r < 0.7) throw new Error('não foi possível alinhar a foto original com a editada (corte ou retoque local muito forte)');
        var before = renderCrop(original, best.cand, after.width, after.height);
        var ref = {
          id: nextId++,
          name: src.name,
          source: src,
          settings: src.settings,
          summary: src.summary,
          before: imageDataOf(before),
          after: imageDataOf(after),
          use: true
        };
        ref.preview = splitPreview(R.decode.orient(before, src.orientation), R.decode.orient(after, src.orientation));
        original.width = original.height = 0;
        return ref;
      });
    });
  }

  function splitPreview(before, after) {
    var w = 320, hgt = Math.max(1, Math.round((320 * after.height) / after.width));
    var c = R.canvas.create(w, hgt);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(after, 0, 0, w, hgt);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w / 2, hgt);
    ctx.clip();
    ctx.drawImage(before, 0, 0, w, hgt);
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w / 2 - 1, 0, 2, hgt);
    return c;
  }

  var learnTimer = null;
  function relearn() {
    clearTimeout(learnTimer);
    learnTimer = setTimeout(function () {
      var used = state.refs.filter(function (r) { return r.use && r.before; });
      if (!used.length) {
        if (state.refs.length) { state.style = null; state.styleInfo = null; }
        else restoreSaved();
        refreshStyle();
        rethumbAll();
        return;
      }
      ui.setBusy(true, 'Aprendendo o estilo…');
      setTimeout(function () {
        try {
          state.style = S.fitStyle(used.map(function (r) { return { before: r.before, after: r.after }; }));
          state.styleInfo = {
            name: 'Estilo aprendido',
            refs: used.map(function (r) { return r.name; }),
            effects: M.spatialEffects(used.map(function (r) { return r.settings; })),
            createdAt: new Date().toISOString()
          };
          persist();
        } catch (err) {
          app().toast('Não foi possível aprender o estilo: ' + err.message, 'error');
        }
        ui.setBusy(false);
        refreshStyle();
        rethumbAll();
      }, 30);
    }, 120);
  }

  function persist() {
    if (!state.style) return;
    try {
      var data = S.serialize(state.style, { name: state.styleInfo.name, refs: state.styleInfo.refs, effects: state.styleInfo.effects, createdAt: state.styleInfo.createdAt });
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      state.savedStyle = data;
    } catch (e) { /* sem armazenamento: o estilo vale só nesta sessão */ }
  }

  function loadStyleData(data) {
    var style = S.deserialize(data);
    state.style = style;
    state.styleInfo = {
      name: String(data.name || 'Estilo salvo'),
      refs: Array.isArray(data.refs) ? data.refs.map(String).slice(0, 200) : [],
      effects: data.effects && typeof data.effects === 'object' ? {
        sharpenAmount: +data.effects.sharpenAmount || 0,
        sharpenRadius: +data.effects.sharpenRadius || 1,
        vignetteAmount: +data.effects.vignetteAmount || 0,
        vignetteMidpoint: data.effects.vignetteMidpoint == null ? 50 : +data.effects.vignetteMidpoint
      } : null,
      createdAt: data.createdAt || null,
      saved: true
    };
  }

  function restoreSaved() {
    state.style = null;
    state.styleInfo = null;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      loadStyleData(data);
      state.savedStyle = data;
    } catch (e) {
      state.style = null;
      state.styleInfo = null;
    }
  }

  function addReferences(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var chain = Promise.resolve();
    list.forEach(function (file) {
      var placeholder = { id: nextId++, name: file.name, loading: true, use: false };
      state.refs.push(placeholder);
      refreshRefs();
      chain = chain.then(function () {
        return prepareReference(file).then(function (ref) {
          state.refs[state.refs.indexOf(placeholder)] = ref;
        }, function (err) {
          placeholder.loading = false;
          placeholder.error = err.message;
        }).then(function () { refreshRefs(); return nextFrame(); });
      });
    });
    chain.then(relearn);
  }

  /* ---------------------------------------------------------------- *
   * Fotos
   * ---------------------------------------------------------------- */

  function computeAutoEv(item) {
    if (!item.thumb) return 0;
    var ev = S.autoExposure(item.thumb, activeStyle(), 0.5, cloneImage);
    if (!state.style && state.options.autoContrast) ev *= 0.6;
    return ev;
  }

  function addPhotos(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|dng|tiff?|hei[cf]|avif)$/i.test(f.name);
    });
    if (!list.length) { app().toast('Nenhuma foto reconhecida. Use JPEG, PNG, WebP ou DNG.'); return; }
    var chain = Promise.resolve();
    list.forEach(function (file) {
      var item = { id: nextId++, name: file.name, loading: true, ev: 0, autoEv: 0 };
      state.photos.push(item);
      chain = chain.then(function () {
        return R.decode.loadSource(file).then(function (src) {
          item.source = src;
          return R.decode.decodeSource(src, 'original', THUMB);
        }).then(function (canvas) {
          item.thumb = imageDataOf(canvas);
          item.loading = false;
          item.autoEv = computeAutoEv(item);
        }, function (err) {
          item.loading = false;
          item.error = err.message;
        }).then(function () { renderPhotoCard(item); updateCount(); return nextFrame(); });
      });
    });
    refreshPhotos();
  }

  function rethumbAll() {
    var list = state.photos.slice();
    var i = 0;
    (function step() {
      var end = Math.min(list.length, i + 4);
      for (; i < end; i++) {
        var item = list[i];
        if (item.thumb) item.autoEv = computeAutoEv(item);
        drawThumb(item);
      }
      if (i < list.length) requestAnimationFrame(step);
    })();
  }

  var thumbTimer = null;
  function scheduleRethumb() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(rethumbAll, 60);
  }

  function drawThumb(item, showOriginal) {
    var card = item.card;
    if (!card || !item.thumb) return;
    var canvas = card.querySelector('canvas');
    if (canvas.width !== item.thumb.width) { canvas.width = item.thumb.width; canvas.height = item.thumb.height; }
    var img = showOriginal ? item.thumb : process(cloneImage(item.thumb), evFor(item), false);
    canvas.getContext('2d').putImageData(img, 0, 0);
    var out = card.querySelector('.ev-value');
    if (out) {
      out.textContent = fmtEv(evFor(item));
      out.title = 'Automático ' + fmtEv(state.options.autoExposure ? item.autoEv : 0) + ' · ajuste desta foto ' + fmtEv(item.ev);
    }
  }

  function renderPhotoCard(item) {
    var card = h('article', { class: 'photo-card' + (item.error ? ' has-error' : '') + (item.loading ? ' is-loading' : '') });
    var frame = h('div', { class: 'photo-frame' });
    if (item.loading) frame.appendChild(h('span', { class: 'photo-status', text: 'Lendo…' }));
    else if (item.error) frame.appendChild(h('span', { class: 'photo-status', text: 'Não abriu: ' + item.error }));
    else {
      var canvas = h('canvas', { 'aria-label': 'Prévia de ' + item.name });
      frame.appendChild(canvas);
      frame.appendChild(h('span', { class: 'before-tag', text: 'Original' }));
      var show = function (on) {
        frame.classList.toggle('show-original', on);
        drawThumb(item, on);
      };
      frame.addEventListener('pointerdown', function (e) { e.preventDefault(); show(true); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { frame.addEventListener(ev, function () { if (frame.classList.contains('show-original')) show(false); }); });
      frame.title = 'Segure para ver a foto original';
    }
    var sub = [];
    if (item.source && item.source.width) sub.push(item.source.width + ' × ' + item.source.height);
    if (item.source && item.source.meta && item.source.meta.model) sub.push(item.source.meta.model);
    if (item.source && item.source.usesPreview) sub.push('prévia do DNG');
    card.appendChild(frame);
    card.appendChild(h('div', { class: 'photo-meta' },
      h('span', { class: 'photo-name', text: item.name, title: item.name }),
      sub.length ? h('span', { class: 'photo-sub', text: sub.join(' · ') }) : null));
    var actions = h('div', { class: 'photo-actions' });
    if (!item.loading && !item.error) {
      actions.appendChild(h('div', { class: 'ev-control', role: 'group', 'aria-label': 'Exposição de ' + item.name },
        h('button', { class: 'mini-btn', type: 'button', 'aria-label': 'Escurecer', html: ui.ICONS.minus, onclick: function () { item.ev = Math.round((item.ev - 0.1) * 10) / 10; drawThumb(item); } }),
        h('output', { class: 'ev-value', text: fmtEv(evFor(item)) }),
        h('button', { class: 'mini-btn', type: 'button', 'aria-label': 'Clarear', html: ui.ICONS.plus, onclick: function () { item.ev = Math.round((item.ev + 0.1) * 10) / 10; drawThumb(item); } })));
      actions.appendChild(h('button', { class: 'btn btn-small', type: 'button', text: 'Abrir no editor', onclick: function () { openInEditor(item); } }));
    }
    actions.appendChild(h('button', {
      class: 'mini-btn photo-remove', type: 'button', 'aria-label': 'Remover ' + item.name, title: 'Remover', html: ui.ICONS.close,
      onclick: function () {
        state.photos.splice(state.photos.indexOf(item), 1);
        card.remove();
        updateCount();
      }
    }));
    card.appendChild(actions);
    if (item.card && item.card.parentNode) item.card.replaceWith(card);
    else els.grid.appendChild(card);
    item.card = card;
    drawThumb(item);
  }

  function refreshPhotos() {
    els.grid.innerHTML = '';
    state.photos.forEach(function (item) { item.card = null; renderPhotoCard(item); });
    updateCount();
  }

  function updateCount() {
    var ready = state.photos.filter(function (p) { return p.thumb && !p.error; }).length;
    var total = state.photos.length;
    els.count.textContent = total ? ready + (ready === 1 ? ' foto pronta' : ' fotos prontas') + (total > ready ? ' de ' + total : '') : '';
    els.empty.hidden = total > 0;
    els.clear.hidden = !total;
    els.exportBtn.disabled = !ready || state.running;
    els.exportBtn.textContent = ready > 1 ? 'Editar ' + ready + ' fotos e baixar (.zip)' : ready === 1 ? 'Editar e baixar a foto' : 'Adicione fotos para exportar';
  }

  /* ---------------------------------------------------------------- *
   * Exportação
   * ---------------------------------------------------------------- */

  function outputName(item) {
    var base = String(item.name).replace(/\.[^.]+$/, '');
    return app().safeName(base + (state.options.suffix || '')) + '.jpg';
  }

  function renderFull(item) {
    var o = state.options;
    var maxSide = Number(o.size) || 0;
    return R.decode.decodeSource(item.source, 'original', maxSide).then(function (canvas) {
      var ctx = canvas.getContext('2d');
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var scale = item.source.width ? Math.max(canvas.width, canvas.height) / Math.max(item.source.width, item.source.height) : 1;
      process(img, evFor(item), true, scale);
      ctx.putImageData(img, 0, 0);
      img = null;
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return R.canvas.toBlob(canvas, 'image/jpeg', o.quality / 100).then(function (blob) {
        canvas.width = canvas.height = 0;
        return blob.arrayBuffer();
      });
    }).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (o.keepMeta) bytes = M.insertExif(bytes, M.buildExif(item.source.meta || {}));
      return bytes;
    });
  }

  function setProgress(done, total, label) {
    els.progress.hidden = false;
    els.progressBar.style.width = (total ? (done / total) * 100 : 0) + '%';
    els.progressText.textContent = label;
  }

  function exportAll() {
    var items = state.photos.filter(function (p) { return p.thumb && !p.error; });
    if (!items.length || state.running) return;
    state.running = true;
    state.cancel = false;
    updateCount();
    els.cancelBtn.hidden = false;
    var zip = new R.zip.ZipWriter();
    var single = null, failures = [], started = Date.now();
    var chain = Promise.resolve();
    items.forEach(function (item, i) {
      chain = chain.then(function () {
        if (state.cancel) return;
        var eta = '';
        if (i > 0) {
          var left = ((Date.now() - started) / i) * (items.length - i) / 1000;
          eta = ' · cerca de ' + (left < 60 ? Math.ceil(left) + ' s' : Math.ceil(left / 60) + ' min') + ' restantes';
        }
        setProgress(i, items.length, 'Editando ' + (i + 1) + ' de ' + items.length + ': ' + item.name + eta);
        return nextFrame().then(function () { return renderFull(item); }).then(function (bytes) {
          if (items.length === 1) single = bytes;
          else zip.add(outputName(item), bytes, new Blob([bytes], { type: 'image/jpeg' }));
        }, function (err) {
          failures.push(item.name + ' (' + err.message + ')');
        });
      });
    });
    chain.then(function () {
      if (state.cancel) {
        setProgress(0, 1, 'Exportação cancelada.');
        return;
      }
      var ok = items.length - failures.length;
      setProgress(1, 1, ok + (ok === 1 ? ' foto editada.' : ' fotos editadas.') + (failures.length ? ' Falharam: ' + failures.join('; ') : ''));
      if (!ok) return;
      if (single) return app().saveFile(new Blob([single], { type: 'image/jpeg' }), outputName(items[0]));
      return app().saveFile(zip.toBlob(), 'Retoque - ' + ok + ' fotos editadas.zip');
    }).catch(function (err) {
      setProgress(0, 1, 'Falha na exportação: ' + err.message);
    }).then(function () {
      state.running = false;
      els.cancelBtn.hidden = true;
      updateCount();
    });
  }

  function openInEditor(item) {
    ui.setBusy(true, 'Abrindo no editor…');
    var original;
    R.decode.decodeSource(item.source, 'original', 0).then(function (canvas) {
      original = R.canvas.clone(canvas);
      var ctx = canvas.getContext('2d');
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      process(img, evFor(item), true, 1);
      ctx.putImageData(img, 0, 0);
      ui.setBusy(false);
      close(true);
      app().openLayers(item.name.replace(/\.[^.]+$/, ''), [
        { name: 'Original', canvas: original, visible: false },
        { name: state.style ? 'Estilo aplicado' : 'Correção automática', canvas: canvas }
      ], 'Edição em lote');
    }, function (err) {
      ui.setBusy(false);
      app().toast('Não foi possível abrir: ' + err.message, 'error');
    });
  }

  /* ---------------------------------------------------------------- *
   * Interface
   * ---------------------------------------------------------------- */

  function refreshRefs() {
    var list = els.refList;
    list.innerHTML = '';
    state.refs.forEach(function (ref) {
      var li = h('li', { class: 'ref-card' + (ref.error ? ' has-error' : '') });
      if (ref.loading) {
        li.appendChild(h('div', { class: 'ref-thumb ref-thumb-empty', text: 'Lendo…' }));
      } else if (ref.error) {
        li.appendChild(h('div', { class: 'ref-thumb ref-thumb-empty', text: 'Não usado' }));
      } else {
        var wrap = h('div', { class: 'ref-thumb' });
        ref.preview.className = 'ref-canvas';
        wrap.appendChild(ref.preview);
        wrap.appendChild(h('span', { class: 'ref-label ref-label-l', text: 'Antes' }));
        wrap.appendChild(h('span', { class: 'ref-label ref-label-r', text: 'Lightroom' }));
        li.appendChild(wrap);
      }
      var body = h('div', { class: 'ref-body' });
      var head = h('div', { class: 'ref-head' });
      if (!ref.loading && !ref.error) {
        var cb = h('input', { type: 'checkbox', id: 'ref-use-' + ref.id, checked: ref.use, onchange: function () { ref.use = cb.checked; relearn(); } });
        head.appendChild(h('label', { class: 'opt-check', for: 'ref-use-' + ref.id }, cb, h('span', { class: 'ref-name', text: ref.name })));
      } else head.appendChild(h('span', { class: 'ref-name', text: ref.name }));
      head.appendChild(h('button', {
        class: 'mini-btn', type: 'button', title: 'Remover', 'aria-label': 'Remover ' + ref.name, html: ui.ICONS.close,
        onclick: function () { state.refs.splice(state.refs.indexOf(ref), 1); refreshRefs(); relearn(); }
      }));
      body.appendChild(head);
      if (ref.error) body.appendChild(h('p', { class: 'ref-error', text: ref.error }));
      if (ref.summary && ref.summary.length) {
        body.appendChild(h('p', { class: 'ref-settings' }, ref.summary.slice(0, 8).map(function (s) {
          return h('span', { class: 'chip-setting' }, s.label + ' ', h('b', { text: s.value }));
        })));
      }
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  function refreshStyle() {
    var info = state.styleInfo, st = els.styleStatus;
    st.innerHTML = '';
    var hasStyle = !!state.style;
    st.classList.toggle('is-active', hasStyle);
    if (hasStyle) {
      var n = info.refs.length || state.style.references;
      st.appendChild(h('strong', { text: info.saved ? 'Estilo salvo pronto para usar' : 'Estilo aprendido' }));
      st.appendChild(h('span', { text: 'Com base em ' + n + (n === 1 ? ' foto editada' : ' fotos editadas') + (info.saved && info.createdAt ? ', criado em ' + new Date(info.createdAt).toLocaleDateString('pt-BR') : '') + '.' }));
      var fx = info.effects;
      if (fx && (fx.sharpenAmount || fx.vignetteAmount)) {
        st.appendChild(h('span', { class: 'style-fx', text: 'Do Lightroom também: nitidez ' + fx.sharpenAmount + (fx.vignetteAmount ? ' · vinheta ' + (fx.vignetteAmount > 0 ? '+' : '') + fx.vignetteAmount : '') + '.' }));
      }
    } else {
      st.appendChild(h('strong', { text: 'Sem estilo: correção automática' }));
      st.appendChild(h('span', { text: 'Cada foto recebe exposição e contraste automáticos. Adicione fotos editadas para ensinar um estilo.' }));
    }
    els.saveStyle.disabled = !hasStyle;
    els.forgetStyle.hidden = !(state.savedStyle && !state.refs.length);
    els.effectsRow.hidden = !(state.styleInfo && state.styleInfo.effects && (state.styleInfo.effects.sharpenAmount || state.styleInfo.effects.vignetteAmount));
    els.autoContrastRow.hidden = hasStyle;
    els.strengthLabel.textContent = hasStyle ? 'Intensidade do estilo' : 'Intensidade da correção';
  }

  function optionSlider(id, label, key, min, max, step, unit, format) {
    var out = h('output', { for: id });
    var range = h('input', { type: 'range', id: id, min: min, max: max, step: step, value: state.options[key] });
    function show() { out.textContent = format ? format(state.options[key]) : state.options[key] + (unit || ''); }
    range.addEventListener('input', function () { state.options[key] = Number(range.value); show(); scheduleRethumb(); });
    show();
    var lab = h('label', { class: 'batch-label', for: id, text: label });
    return { el: h('div', { class: 'batch-field' }, h('div', { class: 'batch-field-head' }, lab, out), range), label: lab };
  }

  function optionCheck(id, label, key, note, onChange) {
    var cb = h('input', { type: 'checkbox', id: id, checked: !!state.options[key], onchange: function () {
      state.options[key] = cb.checked;
      if (onChange) onChange();
      scheduleRethumb();
    } });
    return h('div', { class: 'batch-check' }, h('label', { class: 'opt-check', for: id }, cb, h('span', { text: label })), note ? h('p', { class: 'batch-note', text: note }) : null);
  }

  function build() {
    var refInput = h('input', { type: 'file', id: 'batch-ref-input', accept: '.dng,image/x-adobe-dng,image/dng', multiple: true, hidden: true, onchange: function (e) { addReferences(e.target.files); e.target.value = ''; } });
    var photoInput = h('input', { type: 'file', id: 'batch-photo-input', accept: 'image/*,.dng', multiple: true, hidden: true, onchange: function (e) { addPhotos(e.target.files); e.target.value = ''; } });
    var styleInput = h('input', { type: 'file', id: 'batch-style-input', accept: '.json,application/json', hidden: true, onchange: function (e) {
      var f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      f.text().then(function (txt) {
        loadStyleData(JSON.parse(txt));
        state.refs = [];
        persist();
        refreshRefs();
        refreshStyle();
        rethumbAll();
        app().toast('Estilo carregado.');
      }).catch(function (err) { app().toast('Não foi possível carregar o estilo: ' + err.message, 'error'); });
    } });

    els.styleStatus = h('div', { class: 'style-status', role: 'status' });
    els.refList = h('ul', { class: 'ref-list' });
    els.saveStyle = h('button', { class: 'btn btn-small', type: 'button', text: 'Salvar estilo', onclick: function () {
      var data = S.serialize(state.style, { name: state.styleInfo.name, refs: state.styleInfo.refs, effects: state.styleInfo.effects, createdAt: state.styleInfo.createdAt || new Date().toISOString() });
      app().saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'estilo.retoque-estilo.json');
    } });
    els.forgetStyle = h('button', { class: 'btn btn-small', type: 'button', text: 'Esquecer estilo salvo', onclick: function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignora */ }
      state.savedStyle = null;
      state.style = null;
      state.styleInfo = null;
      refreshStyle();
      rethumbAll();
    } });

    var styleCol = h('section', { class: 'batch-col batch-style', 'aria-labelledby': 'batch-h-style' },
      h('h3', { id: 'batch-h-style' }, h('span', { class: 'step', text: '1' }), 'Estilo'),
      h('p', { class: 'batch-note', text: 'Adicione fotos já editadas no Lightroom e exportadas em DNG. Cada DNG traz a foto original e a edição; o Retoque compara as duas e aprende as cores e os tons.' }),
      h('button', { class: 'btn btn-primary', type: 'button', id: 'batch-add-refs', text: 'Adicionar fotos editadas (DNG)', onclick: function () { refInput.click(); } }),
      els.styleStatus,
      els.refList,
      h('div', { class: 'batch-row' }, els.saveStyle,
        h('button', { class: 'btn btn-small', type: 'button', text: 'Carregar estilo', onclick: function () { styleInput.click(); } }),
        els.forgetStyle));

    els.count = h('span', { class: 'photo-count' });
    els.clear = h('button', { class: 'btn btn-small', type: 'button', text: 'Limpar lista', onclick: function () { state.photos = []; refreshPhotos(); } });
    els.grid = h('div', { class: 'photo-grid' });
    els.empty = h('div', { class: 'photo-empty' },
      h('strong', { text: 'Arraste as fotos para cá' }),
      h('span', { text: 'JPEG, PNG, WebP ou DNG, quantas quiser. Nada é enviado para a internet: tudo é processado no seu aparelho.' }),
      h('button', { class: 'btn', type: 'button', text: 'Escolher fotos', onclick: function () { photoInput.click(); } }));
    var photosCol = h('section', { class: 'batch-col batch-photos', 'aria-labelledby': 'batch-h-photos' },
      h('div', { class: 'photos-head' },
        h('h3', { id: 'batch-h-photos' }, h('span', { class: 'step', text: '2' }), 'Fotos para editar'),
        els.count,
        h('div', { class: 'batch-row' }, els.clear, h('button', { class: 'btn btn-small', type: 'button', id: 'batch-add-photos', text: 'Adicionar fotos', onclick: function () { photoInput.click(); } }))),
      h('p', { class: 'batch-note', text: 'Segure o dedo ou o clique sobre uma foto para ver o original. Use − e + para corrigir a exposição de uma foto específica.' }),
      els.empty, els.grid);

    var strength = optionSlider('batch-strength', 'Intensidade do estilo', 'strength', 0, 150, 5, '%');
    els.strengthLabel = strength.label;
    els.effectsRow = optionCheck('batch-effects', 'Nitidez e vinheta do Lightroom', 'effects', 'Usa a média dos valores das fotos de referência.');
    els.autoContrastRow = optionCheck('batch-autocontrast', 'Contraste automático', 'autoContrast');
    var size = h('select', { id: 'batch-size', onchange: function () { state.options.size = size.value; } },
      [['0', 'Tamanho original'], ['4096', 'Lado maior 4096 px'], ['3000', 'Lado maior 3000 px'], ['2048', 'Lado maior 2048 px — redes sociais'], ['1080', 'Lado maior 1080 px — WhatsApp']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    size.value = state.options.size;
    var quality = optionSlider('batch-quality', 'Qualidade do JPEG', 'quality', 50, 100, 1, '%');
    var suffix = h('input', { type: 'text', id: 'batch-suffix', value: state.options.suffix, oninput: function () { state.options.suffix = suffix.value; } });

    els.exportBtn = h('button', { class: 'btn btn-primary btn-wide', type: 'button', id: 'batch-export', onclick: exportAll });
    els.cancelBtn = h('button', { class: 'btn btn-small', type: 'button', text: 'Cancelar', hidden: true, onclick: function () { state.cancel = true; } });
    els.progressBar = h('div', { class: 'progress-bar' });
    els.progressText = h('p', { class: 'progress-text', role: 'status' });
    els.progress = h('div', { class: 'batch-progress', hidden: true }, h('div', { class: 'progress-track' }, els.progressBar), els.progressText);

    var outCol = h('section', { class: 'batch-col batch-output', 'aria-labelledby': 'batch-h-out' },
      h('h3', { id: 'batch-h-out' }, h('span', { class: 'step', text: '3' }), 'Ajustes e exportação'),
      strength.el,
      optionCheck('batch-auto-ev', 'Exposição automática', 'autoExposure', 'Equilibra o brilho de cada foto antes de aplicar o estilo.'),
      optionSlider('batch-ev', 'Exposição de todas as fotos', 'exposure', -2, 2, 0.1, '', fmtEv).el,
      els.autoContrastRow,
      els.effectsRow,
      h('hr', { class: 'batch-sep' }),
      h('div', { class: 'batch-field' }, h('label', { class: 'batch-label', for: 'batch-size', text: 'Tamanho dos arquivos' }), size),
      quality.el,
      h('div', { class: 'batch-field' }, h('label', { class: 'batch-label', for: 'batch-suffix', text: 'Acrescentar ao nome' }), suffix,
        h('p', { class: 'batch-note', text: 'Exemplo: IMG_0001-editada.jpg' })),
      optionCheck('batch-meta', 'Manter data e dados da câmera', 'keepMeta', 'Mantém data, câmera, lente e exposição nos arquivos, para que fiquem na ordem certa na galeria.'),
      els.exportBtn,
      els.progress,
      els.cancelBtn);
    suffix.addEventListener('input', function () {
      outCol.querySelector('#batch-suffix').nextSibling.textContent = 'Exemplo: IMG_0001' + (suffix.value || '') + '.jpg';
    });

    root = h('div', { class: 'batch', id: 'batch', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'batch-title', hidden: true },
      h('header', { class: 'batch-head' },
        h('div', { class: 'batch-title-wrap' },
          h('h2', { id: 'batch-title', text: 'Edição automática em lote' }),
          h('p', { text: 'Ensine o estilo uma vez e aplique em quantas fotos quiser.' })),
        h('button', { class: 'mini-btn', type: 'button', 'aria-label': 'Fechar edição em lote', html: ui.ICONS.close, onclick: function () { close(); } })),
      h('div', { class: 'batch-body' }, styleCol, photosCol, outCol),
      refInput, photoInput, styleInput);
    document.body.appendChild(root);

    // Soltar arquivos: na coluna de estilo viram referências; no resto, fotos.
    root.addEventListener('dragover', function (e) { e.preventDefault(); });
    root.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      if (styleCol.contains(e.target)) addReferences(files);
      else addPhotos(files);
    });
  }

  function open() {
    if (!root) {
      build();
      restoreSaved();
    }
    root.hidden = false;
    document.body.classList.add('batch-open');
    refreshRefs();
    refreshStyle();
    updateCount();
    var first = root.querySelector('#batch-add-refs');
    if (first) first.focus();
  }

  function close(force) {
    if (!root || root.hidden) return;
    if (state.running && !force) { app().toast('Aguarde a exportação terminar ou cancele.'); return; }
    root.hidden = true;
    document.body.classList.remove('batch-open');
  }

  R.batch = {
    open: open,
    close: close,
    isOpen: function () { return !!root && !root.hidden; },
    // Para o filtro "Aplicar estilo aprendido" do editor.
    currentStyle: function () {
      if (!root) restoreSaved();
      return state.style ? { style: state.style, info: state.styleInfo } : null;
    },
    processForEditor: function (img, ev, strength) {
      if (!state.style) return img;
      S.applyStyle(img, state.style, { strength: strength, exposure: ev });
      return img;
    }
  };
})();
