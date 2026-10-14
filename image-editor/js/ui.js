/*
 * Retoque — interface: menus, barra de opções, painéis, diálogos e avisos.
 */
(function () {
  'use strict';
  var R = (window.Retoque = window.Retoque || {});
  var ops = R.ops;
  var app;

  /* ---------------------------------------------------------------- *
   * Utilidades de DOM
   * ---------------------------------------------------------------- */

  var PROPS = { value: 1, checked: 1, disabled: 1, hidden: 1, selected: 1, title: 1, type: 1, id: 1 };

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (PROPS[k]) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  function $(id) { return document.getElementById(id); }

  function icon(paths) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
  }

  var ICONS = {
    plus: icon('<path d="M12 5v14M5 12h14"/>'),
    duplicate: icon('<rect x="8.5" y="8.5" width="11" height="11" rx="1.5"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
    up: icon('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    down: icon('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    merge: icon('<path d="M7 4v5a5 5 0 0 0 5 5 5 5 0 0 1 5 5v1"/><path d="M17 4v5a5 5 0 0 1-2 4"/><path d="M14 17l3 3 3-3"/>'),
    trash: icon('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/><path d="M10 10.5v6M14 10.5v6"/>'),
    eye: icon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: icon('<path d="M4 4l16 16"/><path d="M10 6.1a9 9 0 0 1 2-.6c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.5 8A16 16 0 0 0 2.5 12S6 18.5 12 18.5a8.7 8.7 0 0 0 4-1"/>'),
    swap: icon('<path d="M7 4.5L4.5 7 7 9.5"/><path d="M4.5 7H14a3.5 3.5 0 0 1 3.5 3.5V16"/><path d="M15 13.5l2.5 2.5 2.5-2.5"/>'),
    reset: icon('<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/><rect x="12" y="12" width="8" height="8" rx="1"/>'),
    chevron: icon('<path d="M6 9l6 6 6-6"/>'),
    panels: icon('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>'),
    close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
    minus: icon('<path d="M5 12h14"/>'),
    fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')
  };

  var BLEND_MODES = [
    ['source-over', 'Normal'], ['multiply', 'Multiplicação'], ['screen', 'Tela'], ['overlay', 'Sobrepor'],
    ['darken', 'Escurecer'], ['lighten', 'Clarear'], ['color-dodge', 'Subexposição de cores'],
    ['color-burn', 'Superexposição de cores'], ['hard-light', 'Luz direta'], ['soft-light', 'Luz suave'],
    ['difference', 'Diferença'], ['exclusion', 'Exclusão'], ['hue', 'Matiz'], ['saturation', 'Saturação'],
    ['color', 'Cor'], ['luminosity', 'Luminosidade']
  ];

  function fmt(v, step) {
    var decimals = step && step < 1 ? String(step).split('.')[1].length : 0;
    var s = Number(v).toFixed(decimals);
    return Number(v) > 0 && decimals ? '+' + s : s;
  }

  /* ---------------------------------------------------------------- *
   * Menus
   * ---------------------------------------------------------------- */

  var openMenu = null;

  function closeMenus() {
    if (!openMenu) return;
    openMenu.trigger.setAttribute('aria-expanded', 'false');
    openMenu.list.hidden = true;
    openMenu = null;
  }

  function showMenu(entry) {
    closeMenus();
    entry.list.innerHTML = '';
    entry.def.items.forEach(function (id) {
      if (id === '-') { entry.list.appendChild(h('div', { class: 'menu-sep', role: 'separator' })); return; }
      var cmd = app.commands[id];
      if (!cmd) return;
      var enabled = cmd.enabled ? cmd.enabled() : true;
      var label = typeof cmd.label === 'function' ? cmd.label() : cmd.label;
      entry.list.appendChild(h('button', {
        class: 'menu-item',
        role: 'menuitem',
        disabled: !enabled,
        onclick: function () { closeMenus(); app.run(id); }
      }, h('span', { text: label }), cmd.keys ? h('kbd', { text: cmd.keys }) : null));
    });
    entry.list.hidden = false;
    entry.trigger.setAttribute('aria-expanded', 'true');
    var rect = entry.trigger.getBoundingClientRect();
    entry.list.style.left = Math.min(rect.left, window.innerWidth - entry.list.offsetWidth - 8) + 'px';
    entry.list.style.top = rect.bottom + 'px';
    openMenu = entry;
  }

  function buildMenus(defs) {
    var bar = $('menus');
    defs.forEach(function (def) {
      var list = h('div', { class: 'menu-list', role: 'menu', hidden: true });
      var trigger = h('button', { class: 'menu-trigger', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: def.label });
      var entry = { def: def, trigger: trigger, list: list };
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (openMenu === entry) closeMenus();
        else showMenu(entry);
      });
      trigger.addEventListener('pointerenter', function () {
        if (openMenu && openMenu !== entry) showMenu(entry);
      });
      bar.appendChild(trigger);
      document.body.appendChild(list);
    });
    document.addEventListener('pointerdown', function (e) {
      if (openMenu && !openMenu.list.contains(e.target) && !openMenu.trigger.contains(e.target)) closeMenus();
    });
    window.addEventListener('resize', closeMenus);
  }

  /* ---------------------------------------------------------------- *
   * Ferramentas, opções e cores
   * ---------------------------------------------------------------- */

  function buildToolbar() {
    var wrap = $('tools');
    R.tools.forEach(function (tool) {
      var keyLabel = (tool.shift ? 'Shift+' : '') + tool.key.toUpperCase();
      wrap.appendChild(h('button', {
        class: 'tool-btn',
        id: 'tool-' + tool.id,
        title: tool.label + ' (' + keyLabel + ')',
        'aria-label': tool.label,
        'aria-pressed': 'false',
        html: tool.icon,
        onclick: function () { app.setTool(tool.id); }
      }));
    });

    var sw = $('swatches');
    sw.appendChild(h('button', { class: 'swatch swatch-primary', id: 'swatch-primary', title: 'Cor primária', 'aria-label': 'Escolher cor primária', onclick: function (e) { openColorPicker('primary', e.currentTarget); } }));
    sw.appendChild(h('button', { class: 'swatch swatch-secondary', id: 'swatch-secondary', title: 'Cor secundária', 'aria-label': 'Escolher cor secundária', onclick: function (e) { openColorPicker('secondary', e.currentTarget); } }));
    sw.appendChild(h('button', { class: 'mini-btn swatch-swap', title: 'Trocar cores (X)', 'aria-label': 'Trocar cores', html: ICONS.swap, onclick: function () { app.run('color.swap'); } }));
    sw.appendChild(h('button', { class: 'mini-btn swatch-reset', title: 'Cores padrão (D)', 'aria-label': 'Restaurar cores padrão', html: ICONS.reset, onclick: function () { app.run('color.reset'); } }));
  }

  function refreshToolbar() {
    R.tools.forEach(function (tool) {
      var b = $('tool-' + tool.id);
      var on = app.tool === tool;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function refreshSwatches() {
    $('swatch-primary').style.background = app.colors.primary;
    $('swatch-secondary').style.background = app.colors.secondary;
  }

  function renderOptions() {
    var bar = $('optionsbar');
    var tool = app.tool;
    bar.innerHTML = '';
    if (!tool) return;
    bar.appendChild(h('div', { class: 'opt-tool' }, h('span', { class: 'opt-tool-icon', html: tool.icon }), h('span', { text: tool.label })));
    var defs = typeof tool.options === 'function' ? tool.options() : tool.options || [];
    var s = app.settings[tool.id];

    function changed(key, value) {
      s[key] = value;
      app.saveSettings();
      if (tool.optionChanged) tool.optionChanged(key);
      app.requestRender();
    }

    defs.forEach(function (o, i) {
      var id = 'opt-' + tool.id + '-' + (o.key || (o.label ? o.label.replace(/\W+/g, '-').toLowerCase() : o.type + i));
      if (o.type === 'range') {
        var range = h('input', { type: 'range', id: id, min: o.min, max: o.max, step: o.step || 1, value: s[o.key] });
        var num = h('input', { type: 'number', class: 'num', id: id + '-num', min: o.min, max: o.max, step: o.step || 1, value: s[o.key], 'aria-label': o.label });
        range.addEventListener('input', function () { num.value = range.value; changed(o.key, Number(range.value)); });
        num.addEventListener('change', function () {
          var v = Math.max(o.min, Math.min(o.max, Number(num.value) || o.min));
          num.value = v; range.value = v; changed(o.key, v);
        });
        bar.appendChild(h('label', { class: 'opt opt-range', for: id }, h('span', { class: 'opt-label', text: o.label }), range, num, o.unit ? h('span', { class: 'opt-unit', text: o.unit }) : null));
      } else if (o.type === 'select') {
        var sel = h('select', { id: id, onchange: function () { changed(o.key, sel.value); } },
          o.choices.map(function (c) { return h('option', { value: c[0], text: c[1] }); }));
        sel.value = String(s[o.key]);
        bar.appendChild(h('label', { class: 'opt', for: id }, h('span', { class: 'opt-label', text: o.label }), sel));
      } else if (o.type === 'check') {
        var cb = h('input', { type: 'checkbox', id: id, checked: !!s[o.key], onchange: function () { changed(o.key, cb.checked); } });
        bar.appendChild(h('label', { class: 'opt opt-check', for: id }, cb, h('span', { text: o.label })));
      } else if (o.type === 'toggle') {
        var tb = h('button', {
          class: 'toggle-btn ' + (o.className || ''),
          id: id,
          title: o.title,
          'aria-label': o.title,
          'aria-pressed': s[o.key] ? 'true' : 'false',
          text: o.label,
          onclick: function () {
            var v = !s[o.key];
            tb.setAttribute('aria-pressed', v ? 'true' : 'false');
            changed(o.key, v);
          }
        });
        bar.appendChild(tb);
      } else if (o.type === 'button') {
        bar.appendChild(h('button', {
          class: 'btn btn-small' + (o.primary ? ' btn-primary' : ''),
          id: id,
          text: o.label,
          onclick: function () { if (o.run) o.run(); else app.run(o.command); }
        }));
      } else if (o.type === 'info') {
        var info = h('span', { class: 'opt-info', text: o.get() });
        info._get = o.get;
        bar.appendChild(info);
      }
    });
    if (tool.hint) bar.title = tool.hint;
  }

  function refreshOptionInfo() {
    var infos = $('optionsbar').querySelectorAll('.opt-info');
    for (var i = 0; i < infos.length; i++) if (infos[i]._get) infos[i].textContent = infos[i]._get();
  }

  // Atualiza os controles da barra quando o valor muda por atalho ([ ] etc.).
  function syncOption(key) {
    var tool = app.tool, s = app.settings[tool.id];
    var range = $('opt-' + tool.id + '-' + key);
    var num = $('opt-' + tool.id + '-' + key + '-num');
    if (range) range.value = s[key];
    if (num) num.value = s[key];
  }

  /* ---------------------------------------------------------------- *
   * Seletor de cor
   * ---------------------------------------------------------------- */

  var PALETTE = ['#000000', '#3d3d3d', '#7a7a7a', '#bdbdbd', '#ffffff', '#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#00838f', '#1565c0', '#4527a0', '#ad1457', '#6d4c41', '#f4c7b8', '#cfe3f4'];
  var picker = null;

  function closeColorPicker() {
    if (!picker) return;
    picker.el.remove();
    document.removeEventListener('pointerdown', picker.outside, true);
    picker = null;
  }

  function openColorPicker(which, anchor) {
    if (picker && picker.which === which) { closeColorPicker(); return; }
    closeColorPicker();
    var current = app.colors[which];
    var native = h('input', { type: 'color', id: 'cp-native', value: current, 'aria-label': 'Seletor de cor' });
    var hex = h('input', { type: 'text', id: 'cp-hex', class: 'hex-input', value: current.toUpperCase(), maxlength: '7', spellcheck: 'false', 'aria-label': 'Código hexadecimal' });
    function set(v, fromNative) {
      var rgb = ops.hexToRgb(v);
      if (!rgb) return;
      var norm = ops.rgbToHex(rgb[0], rgb[1], rgb[2]);
      if (!fromNative) native.value = norm;
      hex.value = norm.toUpperCase();
      app.setColor(which, norm);
    }
    native.addEventListener('input', function () { set(native.value, true); });
    native.addEventListener('change', function () { app.rememberColor(native.value); });
    hex.addEventListener('change', function () { set(hex.value); app.rememberColor(hex.value); });
    function chips(list) {
      return h('div', { class: 'cp-chips' }, list.map(function (c) {
        return h('button', { class: 'cp-chip', style: 'background:' + c, title: c.toUpperCase(), 'aria-label': 'Usar ' + c, onclick: function () { set(c); } });
      }));
    }
    var el = h('div', { class: 'popover color-popover', role: 'dialog', 'aria-label': which === 'primary' ? 'Cor primária' : 'Cor secundária' },
      h('div', { class: 'cp-head' }, h('strong', { text: which === 'primary' ? 'Cor primária' : 'Cor secundária' })),
      h('div', { class: 'cp-row' }, native, hex),
      h('div', { class: 'cp-label', text: 'Paleta' }), chips(PALETTE),
      app.recentColors.length ? [h('div', { class: 'cp-label', text: 'Recentes' }), chips(app.recentColors)] : null
    );
    document.body.appendChild(el);
    var r = anchor.getBoundingClientRect();
    el.style.left = Math.min(r.right + 8, window.innerWidth - el.offsetWidth - 8) + 'px';
    el.style.top = Math.max(8, Math.min(r.top - 40, window.innerHeight - el.offsetHeight - 8)) + 'px';
    var outside = function (e) {
      if (!el.contains(e.target) && !e.target.closest('.swatch')) closeColorPicker();
    };
    document.addEventListener('pointerdown', outside, true);
    picker = { which: which, el: el, outside: outside };
  }

  /* ---------------------------------------------------------------- *
   * Painel de camadas
   * ---------------------------------------------------------------- */

  var dragId = null;

  function buildLayersPanel() {
    var blend = $('layer-blend');
    BLEND_MODES.forEach(function (m) { blend.appendChild(h('option', { value: m[0], text: m[1] })); });
    blend.addEventListener('change', function () {
      var l = app.doc && app.doc.active;
      if (!l) return;
      l.blend = blend.value;
      app.commit('Modo de mesclagem');
    });
    var op = $('layer-opacity'), opOut = $('layer-opacity-out');
    op.addEventListener('input', function () {
      var l = app.doc && app.doc.active;
      if (!l) return;
      l.opacity = Number(op.value) / 100;
      opOut.textContent = op.value + '%';
      app.markDirty();
    });
    op.addEventListener('change', function () {
      if (app.doc && app.doc.active) app.commit('Opacidade da camada');
    });

    var foot = $('layer-actions');
    [
      ['layer.new', ICONS.plus], ['layer.duplicate', ICONS.duplicate], ['layer.up', ICONS.up],
      ['layer.down', ICONS.down], ['layer.mergeDown', ICONS.merge], ['layer.delete', ICONS.trash]
    ].forEach(function (b) {
      var cmd = app.commands[b[0]];
      foot.appendChild(h('button', {
        class: 'mini-btn',
        id: 'btn-' + b[0].replace('.', '-'),
        title: cmd.label + (cmd.keys ? ' (' + cmd.keys + ')' : ''),
        'aria-label': cmd.label,
        html: b[1],
        onclick: function () { app.run(b[0]); }
      }));
    });
  }

  function drawThumb(canvas, layer, doc) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, hgt = canvas.height;
    ctx.clearRect(0, 0, w, hgt);
    var scale = Math.min(w / doc.width, hgt / doc.height);
    var dw = doc.width * scale, dh = doc.height * scale;
    var ox = (w - dw) / 2, oy = (hgt - dh) / 2;
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(ox, oy, dw, dh);
    ctx.fillStyle = '#f5f5f5';
    for (var y = 0; y < dh; y += 4) for (var x = (y / 4) % 2 ? 4 : 0; x < dw; x += 8) ctx.fillRect(ox + x, oy + y, Math.min(4, dw - x), Math.min(4, dh - y));
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, dw, dh);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, ox + layer.x * scale, oy + layer.y * scale, layer.width * scale, layer.height * scale);
    ctx.restore();
  }

  function refreshLayers() {
    var list = $('layer-list');
    var doc = app.doc;
    list.innerHTML = '';
    if (!doc) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      (function (layer) {
        var active = doc.active === layer;
        var thumb = h('canvas', { class: 'thumb', width: Math.round(48 * dpr), height: Math.round(36 * dpr) });
        drawThumb(thumb, layer, doc);
        var name = h('span', { class: 'layer-name', text: layer.name, title: 'Clique duas vezes para renomear' });
        var row = h('li', {
          class: 'layer-row' + (active ? ' is-active' : '') + (layer.visible ? '' : ' is-hidden'),
          role: 'option',
          'aria-selected': active ? 'true' : 'false',
          draggable: 'true',
          tabindex: '0',
          'data-id': layer.id,
          onclick: function () { app.selectLayer(layer); },
          onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.selectLayer(layer); } }
        },
        h('button', {
          class: 'eye',
          title: layer.visible ? 'Ocultar camada' : 'Mostrar camada',
          'aria-label': (layer.visible ? 'Ocultar ' : 'Mostrar ') + layer.name,
          'aria-pressed': layer.visible ? 'true' : 'false',
          html: layer.visible ? ICONS.eye : ICONS.eyeOff,
          onclick: function (e) {
            e.stopPropagation();
            layer.visible = !layer.visible;
            app.commit(layer.visible ? 'Mostrar camada' : 'Ocultar camada');
          }
        }),
        thumb,
        h('span', { class: 'layer-meta' }, name, layer.text ? h('span', { class: 'badge', text: 'Texto' }) : null,
          layer.blend !== 'source-over' || layer.opacity < 1
            ? h('span', { class: 'layer-sub', text: blendName(layer.blend) + ' · ' + Math.round(layer.opacity * 100) + '%' })
            : null));

        name.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          var input = h('input', { type: 'text', class: 'rename-input', value: layer.name, 'aria-label': 'Nome da camada' });
          name.replaceWith(input);
          input.focus();
          input.select();
          var done = false;
          function finish(save) {
            if (done) return;
            done = true;
            var v = input.value.trim();
            if (save && v && v !== layer.name) { layer.name = v; app.commit('Renomear camada'); }
            else refreshLayers();
          }
          input.addEventListener('keydown', function (ev) {
            ev.stopPropagation();
            if (ev.key === 'Enter') finish(true);
            if (ev.key === 'Escape') finish(false);
          });
          input.addEventListener('blur', function () { finish(true); });
          input.addEventListener('click', function (ev) { ev.stopPropagation(); });
        });

        row.addEventListener('dragstart', function (e) {
          dragId = layer.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(layer.id));
          row.classList.add('is-dragging');
        });
        row.addEventListener('dragend', function () {
          dragId = null;
          row.classList.remove('is-dragging');
          clearDropMarks();
        });
        row.addEventListener('dragover', function (e) {
          if (dragId == null) return;
          e.preventDefault();
          var r = row.getBoundingClientRect();
          var above = e.clientY < r.top + r.height / 2;
          clearDropMarks();
          row.classList.add(above ? 'drop-above' : 'drop-below');
        });
        row.addEventListener('drop', function (e) {
          if (dragId == null) return;
          e.preventDefault();
          var r = row.getBoundingClientRect();
          var above = e.clientY < r.top + r.height / 2;
          app.moveLayerTo(dragId, layer.id, above);
          dragId = null;
          clearDropMarks();
        });
        list.appendChild(row);
      })(doc.layers[i]);
    }

    var l = doc.active;
    var blend = $('layer-blend'), op = $('layer-opacity');
    blend.disabled = op.disabled = !l;
    if (l) {
      blend.value = l.blend;
      op.value = Math.round(l.opacity * 100);
      $('layer-opacity-out').textContent = op.value + '%';
    }
    ['layer.duplicate', 'layer.up', 'layer.down', 'layer.mergeDown', 'layer.delete'].forEach(function (id) {
      var btn = $('btn-' + id.replace('.', '-'));
      var cmd = app.commands[id];
      if (btn) btn.disabled = cmd.enabled ? !cmd.enabled() : false;
    });
  }

  function clearDropMarks() {
    var rows = $('layer-list').querySelectorAll('.drop-above, .drop-below');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('drop-above', 'drop-below');
  }

  function blendName(mode) {
    for (var i = 0; i < BLEND_MODES.length; i++) if (BLEND_MODES[i][0] === mode) return BLEND_MODES[i][1];
    return mode;
  }

  /* ---------------------------------------------------------------- *
   * Painel de histórico
   * ---------------------------------------------------------------- */

  function refreshHistory() {
    var list = $('history-list');
    var hist = app.history;
    list.innerHTML = '';
    hist.entries.forEach(function (entry, i) {
      var cls = 'history-item' + (i === hist.index ? ' is-current' : '') + (i > hist.index ? ' is-future' : '');
      list.appendChild(h('li', null, h('button', {
        class: cls,
        'aria-current': i === hist.index ? 'step' : null,
        onclick: function () { app.historyGo(i); }
      }, h('span', { class: 'history-n', text: String(i + 1) }), h('span', { text: entry.label }))));
    });
    // Rola só a lista (scrollIntoView também rolaria a coluna de painéis).
    var cur = list.querySelector('.is-current');
    if (cur) {
      var li = cur.parentElement;
      if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
      else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
    }
  }

  /* ---------------------------------------------------------------- *
   * Painel de ajustes
   * ---------------------------------------------------------------- */

  var adjustInputs = {};

  function buildAdjustPanel() {
    var body = $('adjust-body');
    var group = null;
    ops.ADJUSTMENTS.forEach(function (a) {
      if (a.group !== group) {
        group = a.group;
        body.appendChild(h('div', { class: 'adjust-group', text: group }));
      }
      var id = 'adj-' + a.key;
      var range = h('input', { type: 'range', id: id, min: a.min, max: a.max, step: a.step, value: 0, class: 'adj-range adj-' + a.key });
      var out = h('output', { for: id, text: fmt(0, a.step) });
      range.addEventListener('input', function () {
        out.textContent = fmt(range.value, a.step);
        app.adjustments.set(a.key, Number(range.value));
      });
      var row = h('div', { class: 'adjust-row' }, h('label', { for: id, text: a.label, title: 'Clique duas vezes para zerar' }), out, range);
      row.querySelector('label').addEventListener('dblclick', function () {
        range.value = 0;
        out.textContent = fmt(0, a.step);
        app.adjustments.set(a.key, 0);
      });
      body.appendChild(row);
      adjustInputs[a.key] = { range: range, out: out, def: a };
    });
    $('adjust-apply').addEventListener('click', function () { app.adjustments.apply(); });
    $('adjust-reset').addEventListener('click', function () { app.adjustments.cancel(); });
  }

  function refreshAdjust() {
    var st = app.adjustments;
    Object.keys(adjustInputs).forEach(function (k) {
      var it = adjustInputs[k];
      it.range.value = st.values[k];
      it.out.textContent = fmt(st.values[k], it.def.step);
    });
    var pending = st.pending();
    $('adjust-apply').disabled = !pending;
    $('adjust-reset').disabled = !pending;
    var doc = app.doc;
    var target = !doc || !doc.active ? 'Nenhuma camada ativa'
      : (doc.selection ? 'Seleção em ' : 'Camada ') + '“' + doc.active.name + '”';
    $('adjust-target').textContent = target;
  }

  /* ---------------------------------------------------------------- *
   * Histograma
   * ---------------------------------------------------------------- */

  function drawHistogram(hist) {
    var c = $('histogram');
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, hgt = c.clientHeight;
    if (!w || !hgt) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    var cs = getComputedStyle(document.documentElement);
    ctx.strokeStyle = cs.getPropertyValue('--line').trim();
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var q = 1; q < 4; q++) { var gx = Math.round((w * q) / 4) + 0.5; ctx.moveTo(gx, 0); ctx.lineTo(gx, hgt); }
    ctx.stroke();
    if (!hist || !hist.count) return;
    var max = 1;
    ['r', 'g', 'b'].forEach(function (k) {
      // ignora os extremos ao escalar, para que áreas estouradas não achatem o gráfico
      for (var i = 1; i < 255; i++) max = Math.max(max, hist[k][i]);
    });
    function path(arr) {
      ctx.beginPath();
      ctx.moveTo(0, hgt);
      for (var i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, hgt - Math.min(1, arr[i] / max) * (hgt - 2));
      ctx.lineTo(w, hgt);
      ctx.closePath();
    }
    ctx.globalCompositeOperation = cs.getPropertyValue('--hist-blend').trim() || 'screen';
    [['r', '--hist-r'], ['g', '--hist-g'], ['b', '--hist-b']].forEach(function (p) {
      path(hist[p[0]]);
      ctx.fillStyle = cs.getPropertyValue(p[1]).trim();
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
    path(hist.l);
    ctx.strokeStyle = cs.getPropertyValue('--fg-muted').trim();
    ctx.stroke();
  }

  /* ---------------------------------------------------------------- *
   * Barra de status
   * ---------------------------------------------------------------- */

  function refreshStatus() {
    var doc = app.doc, view = app.view;
    var zoomInput = $('zoom-input');
    if (document.activeElement !== zoomInput) zoomInput.value = Math.round(view.zoom * 1000) / 10 + '%';
    $('status-size').textContent = doc ? doc.width + ' × ' + doc.height + ' px' : '';
    var p = app.pointer;
    $('status-pos').textContent = p && p.inside ? 'X ' + Math.floor(p.x) + '  Y ' + Math.floor(p.y) : 'X –  Y –';
    var sel = doc && doc.selection;
    var selEl = $('status-sel');
    selEl.hidden = !sel;
    if (sel) selEl.textContent = 'Seleção ' + sel.w + ' × ' + sel.h;
    $('doc-title').textContent = doc ? doc.name : '';
  }

  function setHint(text) {
    $('status-hint').textContent = text || '';
  }

  /* ---------------------------------------------------------------- *
   * Diálogos e avisos
   * ---------------------------------------------------------------- */

  var activeDialog = null;

  function dialog(opts) {
    closeDialog(true);
    closeMenus();
    var root = $('dialog-root');
    var actions = h('div', { class: 'dialog-actions' });
    var box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('header', { class: 'dialog-head' },
        h('h2', { id: 'dialog-title', text: opts.title }),
        h('button', { class: 'mini-btn', 'aria-label': 'Fechar', html: ICONS.close, onclick: function () { closeDialog(true); } })),
      h('div', { class: 'dialog-body' }, opts.content),
      actions);
    if (opts.wide) box.classList.add('dialog-wide');
    var handle = { el: box, onCancel: opts.onCancel, primary: null };
    (opts.actions || []).forEach(function (a) {
      var b = h('button', {
        class: 'btn' + (a.primary ? ' btn-primary' : ''),
        text: a.label,
        onclick: function () {
          if (a.cancel) { closeDialog(true); return; }
          if (a.run && a.run() === false) return;
          closeDialog(false);
        }
      });
      if (a.primary) handle.primary = b;
      actions.appendChild(b);
    });
    root.innerHTML = '';
    root.appendChild(box);
    root.hidden = false;
    activeDialog = handle;
    var first = box.querySelector('.dialog-body input, .dialog-body select, .dialog-body button') || handle.primary;
    if (first) first.focus();
    return handle;
  }

  function closeDialog(cancelled) {
    if (!activeDialog) return;
    var d = activeDialog;
    activeDialog = null;
    $('dialog-root').hidden = true;
    $('dialog-root').innerHTML = '';
    if (cancelled && d.onCancel) d.onCancel();
  }

  function dialogKey(e) {
    if (!activeDialog) return false;
    if (e.key === 'Escape') { closeDialog(true); return true; }
    if (e.key === 'Enter' && activeDialog.primary && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      activeDialog.primary.click();
      return true;
    }
    return true;
  }

  // Controles reutilizados nos diálogos.
  function field(label, control, note) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control, note ? h('span', { class: 'field-note', text: note }) : null);
  }

  function slider(id, label, o) {
    var range = h('input', { type: 'range', id: id, min: o.min, max: o.max, step: o.step || 1, value: o.value });
    var num = h('input', { type: 'number', class: 'num', id: id + '-num', min: o.min, max: o.max, step: o.step || 1, value: o.value, 'aria-label': label });
    range.addEventListener('input', function () { num.value = range.value; if (o.onInput) o.onInput(Number(range.value)); });
    num.addEventListener('change', function () {
      var v = Math.max(o.min, Math.min(o.max, Number(num.value) || 0));
      num.value = v; range.value = v;
      if (o.onInput) o.onInput(v);
    });
    var el = h('div', { class: 'field field-slider' },
      h('label', { class: 'field-label', for: id, text: label }),
      h('div', { class: 'slider-row' }, range, num, o.unit ? h('span', { class: 'opt-unit', text: o.unit }) : null));
    el.getValue = function () { return Number(range.value); };
    return el;
  }

  function toast(msg, kind) {
    var wrap = $('toasts');
    var t = h('div', { class: 'toast' + (kind ? ' toast-' + kind : ''), role: kind === 'error' ? 'alert' : 'status', text: msg });
    wrap.appendChild(t);
    while (wrap.children.length > 3) wrap.firstChild.remove();
    setTimeout(function () { t.classList.add('is-leaving'); }, 3200);
    setTimeout(function () { t.remove(); }, 3600);
  }

  function setBusy(on, label) {
    var b = $('busy');
    b.hidden = !on;
    if (label) b.textContent = label;
  }

  R.ui = {
    h: h,
    $: $,
    ICONS: ICONS,
    BLEND_MODES: BLEND_MODES,
    init: function (a) { app = a; },
    buildMenus: buildMenus,
    closeMenus: closeMenus,
    buildToolbar: buildToolbar,
    refreshToolbar: refreshToolbar,
    refreshSwatches: refreshSwatches,
    renderOptions: renderOptions,
    refreshOptionInfo: refreshOptionInfo,
    syncOption: syncOption,
    openColorPicker: openColorPicker,
    closeColorPicker: closeColorPicker,
    buildLayersPanel: buildLayersPanel,
    refreshLayers: refreshLayers,
    refreshHistory: refreshHistory,
    buildAdjustPanel: buildAdjustPanel,
    refreshAdjust: refreshAdjust,
    drawHistogram: drawHistogram,
    refreshStatus: refreshStatus,
    setHint: setHint,
    dialog: dialog,
    closeDialog: closeDialog,
    dialogKey: dialogKey,
    hasDialog: function () { return !!activeDialog; },
    field: field,
    slider: slider,
    toast: toast,
    setBusy: setBusy
  };
})();
