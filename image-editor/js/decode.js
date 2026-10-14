/*
 * Retoque — leitura de fotos (JPEG, PNG, WebP e DNG) para canvas.
 */
(function () {
  'use strict';
  var R = (window.Retoque = window.Retoque || {});

  var IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var MAX_PIXELS = IS_IOS ? 16e6 : 50e6;

  function readFile(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('o arquivo não pôde ser lido')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function isTiffHeader(u8) {
    return (u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42 && u8[3] === 0) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0 && u8[3] === 42);
  }

  function isDngFile(file) {
    return /\.dng$/i.test(file.name) || file.type === 'image/x-adobe-dng' || file.type === 'image/dng';
  }

  function imageFromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('o navegador não conseguiu decodificar a imagem')); };
      img.src = url;
    });
  }

  // Decodifica um JPEG sem metadados (os blocos internos do DNG).
  function bitmapFromBlob(blob, resize) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, resize || undefined).catch(function () {
        return resize ? createImageBitmap(blob).catch(function () { return imageFromBlob(blob); }) : imageFromBlob(blob);
      });
    }
    return imageFromBlob(blob);
  }

  function release(src) {
    if (src && typeof src.close === 'function') src.close();
  }

  // Aplica a orientação EXIF (1–8) e devolve um canvas novo.
  function orient(src, o) {
    if (!o || o === 1) return src;
    var w = src.width, h = src.height;
    var swap = o >= 5;
    var c = R.canvas.create(swap ? h : w, swap ? w : h);
    var ctx = c.getContext('2d');
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    }
    ctx.drawImage(src, 0, 0);
    return c;
  }

  function targetSize(w, h, maxSide) {
    var k = 1;
    if (maxSide && Math.max(w, h) > maxSide) k = maxSide / Math.max(w, h);
    if (w * h * k * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (w * h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k: k };
  }

  function toCanvas(src, w, h) {
    if (src.width === w && src.height === h) {
      var c = R.canvas.create(w, h);
      c.getContext('2d').drawImage(src, 0, 0);
      return c;
    }
    return R.canvas.resample(src, w, h);
  }

  // Lê o arquivo e descobre o que ele contém, sem decodificar a imagem inteira.
  function loadSource(file) {
    return readFile(file).then(function (buffer) {
      var u8 = new Uint8Array(buffer);
      var src = { file: file, name: file.name, size: file.size };
      if (isTiffHeader(u8) && (isDngFile(file) || /\.tiff?$/i.test(file.name))) {
        var dng = R.meta.parseDng(u8);
        src.kind = 'dng';
        src.bytes = u8;
        src.dng = dng;
        src.meta = dng.meta;
        src.orientation = dng.meta.orientation || 1;
        src.settings = dng.settings;
        src.summary = R.meta.summarizeSettings(dng.settings);
        src.hasOriginal = !!(dng.original && dng.original.kind === 'jpeg');
        src.hasEdited = dng.previews.length > 0 && !!dng.settings && dng.settings.HasSettings !== false;
        var main = src.hasOriginal ? dng.original : dng.previews[0];
        if (!main) throw new Error('este DNG só tem dados RAW da câmera, que o navegador não consegue abrir');
        var swap = src.orientation >= 5;
        src.width = swap ? main.height : main.width;
        src.height = swap ? main.width : main.height;
        src.usesPreview = !src.hasOriginal;
        return src;
      }
      if (/^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name)) src.heic = true;
      src.kind = 'image';
      src.meta = u8[0] === 0xff && u8[1] === 0xd8 ? R.meta.readJpegMeta(u8) : null;
      return src;
    });
  }

  function decodeDngPart(src, info, maxSide) {
    var t = targetSize(info.width, info.height, maxSide);
    var parts = info.parts;
    function blobOf(p) { return new Blob([src.bytes.subarray(p.offset, p.offset + p.length)], { type: 'image/jpeg' }); }
    if (parts.length === 1) {
      var resize = t.k < 1 ? { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' } : null;
      return bitmapFromBlob(blobOf(parts[0]), resize).then(function (bmp) {
        var c = toCanvas(bmp, t.w, t.h);
        release(bmp);
        return c;
      });
    }
    var c = R.canvas.create(t.w, t.h);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    var chain = Promise.resolve();
    parts.forEach(function (p) {
      chain = chain.then(function () {
        return bitmapFromBlob(blobOf(p)).then(function (bmp) {
          ctx.drawImage(bmp, p.x * t.k, p.y * t.k, bmp.width * t.k, bmp.height * t.k);
          release(bmp);
        });
      });
    });
    return chain.then(function () { return c; });
  }

  // which: 'original' (foto da câmera) ou 'edited' (prévia editada no Lightroom).
  // raw=true mantém a orientação gravada no sensor (usado no aprendizado).
  function decodeSource(src, which, maxSide, raw) {
    if (src.kind === 'dng') {
      var info = which === 'edited' ? src.dng.previews[0] : src.hasOriginal ? src.dng.original : src.dng.previews[0];
      if (!info) return Promise.reject(new Error('imagem não encontrada no DNG'));
      return decodeDngPart(src, info, maxSide).then(function (c) {
        return raw ? c : orient(c, src.orientation);
      });
    }
    return imageFromBlob(src.file).catch(function (err) {
      throw src.heic ? new Error('fotos HEIC só abrem no Safari; exporte como JPEG') : err;
    }).then(function (img) {
      var w = img.naturalWidth || img.width || 1024, h = img.naturalHeight || img.height || 768;
      src.width = w;
      src.height = h;
      var t = targetSize(w, h, maxSide);
      return toCanvas(img, t.w, t.h);
    });
  }

  R.decode = {
    MAX_PIXELS: MAX_PIXELS,
    readFile: readFile,
    isDngFile: isDngFile,
    loadSource: loadSource,
    decodeSource: decodeSource,
    decodeDngPart: decodeDngPart,
    orient: orient
  };
})();
