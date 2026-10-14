/*
 * Retoque — área de trabalho: zoom, deslocamento e desenho da tela.
 */
(function () {
  'use strict';
  var R = (window.Retoque = window.Retoque || {});

  var ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

  function View(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this.comp = R.canvas.create(1, 1);
    this.compDirty = true;
    this.colors = null;
    this.checker = null;
  }

  View.prototype.resize = function () {
    var rect = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
  };

  View.prototype.readTheme = function () {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    this.colors = {
      workspace: v('--workspace'),
      checkerA: v('--checker-a'),
      checkerB: v('--checker-b'),
      accent: v('--accent'),
      frame: v('--frame')
    };
    var tile = R.canvas.create(16, 16);
    var tctx = tile.getContext('2d');
    tctx.fillStyle = this.colors.checkerA;
    tctx.fillRect(0, 0, 16, 16);
    tctx.fillStyle = this.colors.checkerB;
    tctx.fillRect(0, 0, 8, 8);
    tctx.fillRect(8, 8, 8, 8);
    this.checker = this.ctx.createPattern(tile, 'repeat');
  };

  View.prototype.screenToDoc = function (clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.panX) / this.zoom,
      y: (clientY - rect.top - this.panY) / this.zoom
    };
  };

  View.prototype.docToScreen = function (x, y) {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  };

  View.prototype.fitZoom = function (doc) {
    var margin = this.cssW < 600 ? 16 : 48;
    return Math.min((this.cssW - margin * 2) / doc.width, (this.cssH - margin * 2) / doc.height);
  };

  View.prototype.fit = function (doc, allowUpscale) {
    var z = this.fitZoom(doc);
    if (!allowUpscale) z = Math.min(1, z);
    this.zoom = Math.max(0.02, z);
    this.center(doc);
  };

  View.prototype.center = function (doc) {
    this.panX = Math.round((this.cssW - doc.width * this.zoom) / 2);
    this.panY = Math.round((this.cssH - doc.height * this.zoom) / 2);
  };

  View.prototype.setZoom = function (z, sx, sy) {
    z = Math.max(0.02, Math.min(64, z));
    if (sx == null) { sx = this.cssW / 2; sy = this.cssH / 2; }
    var dx = (sx - this.panX) / this.zoom, dy = (sy - this.panY) / this.zoom;
    this.zoom = z;
    this.panX = sx - dx * z;
    this.panY = sy - dy * z;
  };

  View.prototype.zoomStep = function (dir, sx, sy) {
    var z = this.zoom, next = z;
    if (dir > 0) {
      for (var i = 0; i < ZOOM_STEPS.length; i++) if (ZOOM_STEPS[i] > z * 1.001) { next = ZOOM_STEPS[i]; break; }
    } else {
      for (var j = ZOOM_STEPS.length - 1; j >= 0; j--) if (ZOOM_STEPS[j] < z * 0.999) { next = ZOOM_STEPS[j]; break; }
    }
    this.setZoom(next, sx, sy);
  };

  View.prototype.updateComposite = function (doc) {
    if (this.comp.width !== doc.width || this.comp.height !== doc.height) {
      this.comp.width = doc.width;
      this.comp.height = doc.height;
    }
    var ctx = this.comp.getContext('2d');
    ctx.clearRect(0, 0, doc.width, doc.height);
    doc.drawLayers(ctx);
    this.compDirty = false;
  };

  View.prototype.render = function (doc, drawOverlay) {
    if (!this.colors) this.readTheme();
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.colors.workspace;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!doc) return;
    if (this.compDirty) this.updateComposite(doc);

    var x = Math.round(this.panX * this.dpr) / this.dpr;
    var y = Math.round(this.panY * this.dpr) / this.dpr;
    var w = doc.width * this.zoom, h = doc.height * this.zoom;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = this.checker;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = this.checker;
    ctx.fillRect(x, y, w, h);
    ctx.restore();

    ctx.imageSmoothingEnabled = this.zoom < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.comp, x, y, w, h);
    ctx.imageSmoothingEnabled = true;

    ctx.strokeStyle = this.colors.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(w) + 1, Math.round(h) + 1);

    if (drawOverlay) drawOverlay(ctx, this);
  };

  R.View = View;
})();
