/*
 * Retoque — leitura de DNG/TIFF, configurações do Lightroom (XMP) e EXIF.
 *
 * Funções puras sobre bytes (Uint8Array). A decodificação das imagens
 * JPEG embutidas fica com o navegador; aqui só localizamos onde elas estão.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Retoque = root.Retoque || {};
    root.Retoque.meta = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

  /* ---------------------------------------------------------------- *
   * Leitor TIFF
   * ---------------------------------------------------------------- */

  function Tiff(u8, base) {
    this.u8 = u8;
    this.base = base || 0;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var b0 = u8[this.base], b1 = u8[this.base + 1];
    if (b0 === 0x49 && b1 === 0x49) this.le = true;
    else if (b0 === 0x4d && b1 === 0x4d) this.le = false;
    else throw new Error('cabeçalho TIFF inválido');
    if (this.u16(2) !== 42) throw new Error('formato TIFF não suportado');
  }

  Tiff.prototype.inRange = function (off, len) {
    return off >= 0 && this.base + off + len <= this.u8.length;
  };
  Tiff.prototype.u16 = function (off) { return this.dv.getUint16(this.base + off, this.le); };
  Tiff.prototype.u32 = function (off) { return this.dv.getUint32(this.base + off, this.le); };

  Tiff.prototype.readIfd = function (off) {
    if (!this.inRange(off, 2)) return null;
    var n = this.u16(off);
    if (n > 1000 || !this.inRange(off + 2, n * 12 + 4)) return null;
    var tags = {};
    for (var i = 0; i < n; i++) {
      var p = off + 2 + i * 12;
      var tag = this.u16(p), type = this.u16(p + 2), count = this.u32(p + 4);
      var size = (TYPE_SIZE[type] || 1) * count;
      var valueOff = size <= 4 ? p + 8 : this.u32(p + 8);
      tags[tag] = { type: type, count: count, off: valueOff, size: size };
    }
    return { offset: off, tags: tags, next: this.u32(off + 2 + n * 12) };
  };

  // Valores de uma entrada: números (racionais já divididos) ou texto.
  Tiff.prototype.values = function (entry, max) {
    if (!entry || !this.inRange(entry.off, entry.size)) return null;
    var t = entry.type, n = Math.min(entry.count, max || 4096), out = [], o = entry.off;
    if (t === 2) {
      var s = '';
      for (var k = 0; k < entry.count && k < 4096; k++) {
        var ch = this.u8[this.base + o + k];
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      return s;
    }
    for (var i = 0; i < n; i++) {
      if (t === 1 || t === 7) out.push(this.u8[this.base + o + i]);
      else if (t === 6) out.push(this.dv.getInt8(this.base + o + i));
      else if (t === 3) out.push(this.u16(o + i * 2));
      else if (t === 8) out.push(this.dv.getInt16(this.base + o + i * 2, this.le));
      else if (t === 4 || t === 13) out.push(this.u32(o + i * 4));
      else if (t === 9) out.push(this.dv.getInt32(this.base + o + i * 4, this.le));
      else if (t === 5) { var den = this.u32(o + i * 8 + 4); out.push(den ? this.u32(o + i * 8) / den : 0); }
      else if (t === 10) { var sd = this.dv.getInt32(this.base + o + i * 8 + 4, this.le); out.push(sd ? this.dv.getInt32(this.base + o + i * 8, this.le) / sd : 0); }
      else if (t === 11) out.push(this.dv.getFloat32(this.base + o + i * 4, this.le));
      else if (t === 12) out.push(this.dv.getFloat64(this.base + o + i * 8, this.le));
    }
    return out;
  };

  Tiff.prototype.one = function (ifd, tag) {
    var v = this.values(ifd.tags[tag], 1);
    return v == null ? null : typeof v === 'string' ? v : v[0];
  };

  Tiff.prototype.text = function (ifd, tag) {
    var v = this.values(ifd.tags[tag]);
    return typeof v === 'string' ? v.trim() : null;
  };

  Tiff.prototype.bytes = function (entry) {
    if (!entry || !this.inRange(entry.off, entry.size)) return null;
    return this.u8.subarray(this.base + entry.off, this.base + entry.off + entry.size);
  };

  function cameraMeta(t, ifd0, exif) {
    var m = {
      make: t.text(ifd0, 271),
      model: t.text(ifd0, 272),
      orientation: t.one(ifd0, 274) || 1
    };
    if (exif) {
      m.exposureTime = t.one(exif, 33434);
      m.fNumber = t.one(exif, 33437);
      m.iso = t.one(exif, 34855);
      m.dateTimeOriginal = t.text(exif, 36867);
      m.focalLength = t.one(exif, 37386);
      m.lensModel = t.text(exif, 42036);
    }
    if (!m.dateTimeOriginal) m.dateTimeOriginal = t.text(ifd0, 306);
    Object.keys(m).forEach(function (k) { if (m[k] == null || m[k] === '') delete m[k]; });
    if (!(m.orientation >= 1 && m.orientation <= 8)) m.orientation = 1;
    return m;
  }

  /* ---------------------------------------------------------------- *
   * DNG
   * ---------------------------------------------------------------- */

  function srgbToLinear16(v) {
    var x = v / 255;
    return (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)) * 65535;
  }

  // A tabela de linearização de um DNG gerado a partir de JPEG converte sRGB em linear.
  function isSrgbTable(table) {
    if (!table || table.length !== 256) return false;
    for (var i = 0; i < 256; i += 15) if (Math.abs(table[i] - srgbToLinear16(i)) > 400) return false;
    return true;
  }

  function describeImage(t, ifd) {
    var tg = ifd.tags;
    var info = {
      subfile: t.one(ifd, 254) || 0,
      width: t.one(ifd, 256),
      height: t.one(ifd, 257),
      compression: t.one(ifd, 259),
      photometric: t.one(ifd, 262),
      samples: t.one(ifd, 277) || 1,
      bits: t.one(ifd, 258)
    };
    if (!info.width || !info.height) return null;
    var parts = [];
    if (tg[324] && tg[325]) {
      var tw = t.one(ifd, 322), th = t.one(ifd, 323);
      var offs = t.values(tg[324], 100000), lens = t.values(tg[325], 100000);
      var across = Math.ceil(info.width / tw);
      for (var i = 0; i < offs.length; i++) {
        parts.push({ x: (i % across) * tw, y: Math.floor(i / across) * th, offset: offs[i], length: lens[i] });
      }
    } else if (tg[273] && tg[279]) {
      var so = t.values(tg[273], 100000), sl = t.values(tg[279], 100000);
      var rps = t.one(ifd, 278) || info.height;
      for (var j = 0; j < so.length; j++) parts.push({ x: 0, y: j * rps, offset: so[j], length: sl[j] });
    }
    info.parts = parts.filter(function (p) { return t.inRange(p.offset, p.length) && p.length > 0; });
    if (tg[50712]) info.linearization = t.values(tg[50712], 70000);
    return info;
  }

  function isJpegData(u8, part) {
    return u8[part.offset] === 0xff && u8[part.offset + 1] === 0xd8;
  }

  function parseDng(input) {
    var u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    var t = new Tiff(u8, 0);
    var ifd0 = t.readIfd(t.u32(4));
    if (!ifd0) throw new Error('estrutura do arquivo danificada');

    var all = [], seen = {};
    function walk(ifd, depth) {
      if (!ifd || seen[ifd.offset] || depth > 4 || all.length > 64) return;
      seen[ifd.offset] = true;
      all.push(ifd);
      if (ifd.tags[330]) (t.values(ifd.tags[330], 64) || []).forEach(function (off) { walk(t.readIfd(off), depth + 1); });
    }
    walk(ifd0, 0);
    var next = ifd0.next, guard = 0;
    while (next && guard++ < 8) {
      var n = t.readIfd(next);
      if (!n || seen[n.offset]) break;
      walk(n, 1);
      next = n.next;
    }

    var exif = ifd0.tags[34665] ? t.readIfd(t.one(ifd0, 34665)) : null;
    var result = {
      isDng: !!ifd0.tags[50706],
      software: t.text(ifd0, 305),
      uniqueModel: t.text(ifd0, 50708),
      meta: cameraMeta(t, ifd0, exif),
      xmp: null,
      original: null,
      previews: []
    };
    var xmpBytes = t.bytes(ifd0.tags[700]);
    if (xmpBytes) result.xmp = utf8(xmpBytes);

    all.forEach(function (ifd) {
      var img = describeImage(t, ifd);
      if (!img || !img.parts.length) return;
      var jpeg = img.parts.every(function (p) { return isJpegData(u8, p); });
      if (img.subfile === 0) {
        if (img.photometric === 32803) img.kind = 'raw';
        else if ((img.compression === 34892 || img.compression === 7) && jpeg && img.samples === 3) {
          var srgb = img.photometric === 34892 ? isSrgbTable(img.linearization) : img.photometric === 6 || img.photometric === 2;
          img.kind = srgb ? 'jpeg' : 'linear';
        } else img.kind = 'unsupported';
        if (!result.original || img.width * img.height > result.original.width * result.original.height) result.original = img;
      } else if ((img.subfile & 1) && jpeg && (img.compression === 7 || img.compression === 6 || img.compression === 34892)) {
        result.previews.push(img);
      }
    });
    result.previews.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
    result.settings = result.xmp ? parseXmpSettings(result.xmp) : null;
    return result;
  }

  function utf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  /* ---------------------------------------------------------------- *
   * Configurações do Lightroom (XMP, namespace crs)
   * ---------------------------------------------------------------- */

  function parseXmpSettings(xml) {
    var s = {};
    var attr = /crs:([A-Za-z0-9]+)="([^"]*)"/g, m;
    while ((m = attr.exec(xml))) s[m[1]] = toValue(m[2]);
    var elem = /<crs:([A-Za-z0-9]+)>([^<]*)<\/crs:\1>/g;
    while ((m = elem.exec(xml))) if (!(m[1] in s)) s[m[1]] = toValue(m[2].trim());
    var seq = /<crs:(ToneCurvePV2012(?:Red|Green|Blue)?)>\s*<rdf:Seq>([\s\S]*?)<\/rdf:Seq>/g;
    while ((m = seq.exec(xml))) {
      var pts = [], li = /<rdf:li>\s*([\d.]+)\s*,\s*([\d.]+)\s*<\/rdf:li>/g, p;
      while ((p = li.exec(m[2]))) pts.push([Number(p[1]), Number(p[2])]);
      s[m[1]] = pts;
    }
    return s;
  }

  function toValue(v) {
    if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'True') return true;
    if (v === 'False') return false;
    return v;
  }

  var SUMMARY = [
    ['Exposure2012', 'Exposição', 2], ['Contrast2012', 'Contraste', 0], ['Highlights2012', 'Realces', 0],
    ['Shadows2012', 'Sombras', 0], ['Whites2012', 'Brancos', 0], ['Blacks2012', 'Pretos', 0],
    ['Temperature', 'Temperatura', 0], ['IncrementalTemperature', 'Temperatura', 0], ['Tint', 'Tonalidade', 0],
    ['IncrementalTint', 'Tonalidade', 0], ['Texture', 'Textura', 0], ['Clarity2012', 'Claridade', 0],
    ['Dehaze', 'Desembaçar', 0], ['Vibrance', 'Vibração', 0], ['Saturation', 'Saturação', 0],
    ['VignetteAmount', 'Vinheta', 0], ['PostCropVignetteAmount', 'Vinheta pós-corte', 0], ['GrainAmount', 'Granulação', 0],
    ['Sharpness', 'Nitidez', 0]
  ];

  function signed(n, digits) {
    var s = Math.abs(n).toFixed(digits).replace('.', ',');
    return n > 0 ? '+' + s : n < 0 ? '−' + s : s;
  }

  // Lista legível dos controles principais que foram mexidos.
  function summarizeSettings(s) {
    if (!s) return [];
    var out = [];
    SUMMARY.forEach(function (d) {
      var v = s[d[0]];
      if (typeof v !== 'number' || !v) return;
      if (d[0] === 'Temperature' && s.WhiteBalance === 'As Shot') return;
      out.push({ key: d[0], label: d[1], value: d[0] === 'Sharpness' ? String(v) : signed(v, d[2]) });
    });
    var hsl = ['Hue', 'Saturation', 'Luminance'].some(function (k) {
      return ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'].some(function (c) { return s[k + 'Adjustment' + c]; });
    });
    if (hsl) out.push({ key: 'HSL', label: 'Cores (HSL)', value: 'ajustadas' });
    if (s.SplitToningShadowSaturation || s.SplitToningHighlightSaturation || s.ColorGradeMidtoneSat || s.ColorGradeGlobalSat) {
      out.push({ key: 'ColorGrade', label: 'Gradação de cores', value: 'sim' });
    }
    if (s.ToneCurveName2012 === 'Custom') out.push({ key: 'Curve', label: 'Curva de tons', value: 'personalizada' });
    if (s.HasCrop === true) out.push({ key: 'Crop', label: 'Corte', value: 'sim' });
    return out;
  }

  // Efeitos espaciais que uma tabela de cores não consegue reproduzir.
  // Faz a média das referências.
  function spatialEffects(settingsList) {
    var list = settingsList.filter(Boolean);
    if (!list.length) return null;
    function avg(key, fallback) {
      var vals = list.map(function (s) { return typeof s[key] === 'number' ? s[key] : fallback; });
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    }
    return {
      sharpenAmount: Math.round(avg('Sharpness', 0)),
      sharpenRadius: Math.round(avg('SharpenRadius', 1) * 10) / 10 || 1,
      vignetteAmount: Math.round(avg('VignetteAmount', 0) + avg('PostCropVignetteAmount', 0)),
      vignetteMidpoint: Math.round(avg('VignetteMidpoint', 50))
    };
  }

  /* ---------------------------------------------------------------- *
   * EXIF em JPEG
   * ---------------------------------------------------------------- */

  // Lê os dados da câmera de um JPEG (segmento APP1 Exif).
  function readJpegMeta(input) {
    var u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    var p = 2;
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xff) return null;
      var marker = u8[p + 1];
      if (marker === 0xda || marker === 0xd9) return null;
      var len = (u8[p + 2] << 8) | u8[p + 3];
      if (marker === 0xe1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) {
        try {
          var t = new Tiff(u8.subarray(0, p + 2 + len), p + 10);
          var ifd0 = t.readIfd(t.u32(4));
          if (!ifd0) return null;
          var exif = ifd0.tags[34665] ? t.readIfd(t.one(ifd0, 34665)) : null;
          return cameraMeta(t, ifd0, exif);
        } catch (e) {
          return null;
        }
      }
      p += 2 + len;
    }
    return null;
  }

  function rational(v) {
    if (!(v > 0)) return [0, 1];
    if (v < 1) {
      var inv = 1 / v;
      if (Math.abs(inv - Math.round(inv)) < 0.01) return [1, Math.round(inv)];
    }
    return [Math.round(v * 1000), 1000];
  }

  // Monta um segmento APP1 Exif mínimo (câmera, lente, data e exposição).
  // A orientação vai sempre como 1 porque a imagem exportada já está girada.
  function buildExif(meta) {
    var m = meta || {};
    function ascii(s) { return String(s).replace(/[^\x20-\x7e]/g, '') + '\0'; }
    var ifd0 = [], exif = [];
    if (m.make) ifd0.push([271, 2, ascii(m.make)]);
    if (m.model) ifd0.push([272, 2, ascii(m.model)]);
    ifd0.push([274, 3, [1]]);
    ifd0.push([305, 2, ascii(m.software || 'Retoque')]);
    if (m.dateTime || m.dateTimeOriginal) ifd0.push([306, 2, ascii(m.dateTime || m.dateTimeOriginal)]);
    if (m.exposureTime) exif.push([33434, 5, [rational(m.exposureTime)]]);
    if (m.fNumber) exif.push([33437, 5, [rational(m.fNumber)]]);
    if (m.iso) exif.push([34855, 3, [Math.min(65535, Math.round(m.iso))]]);
    if (m.dateTimeOriginal) {
      exif.push([36867, 2, ascii(m.dateTimeOriginal)]);
      exif.push([36868, 2, ascii(m.dateTimeOriginal)]);
    }
    if (m.focalLength) exif.push([37386, 5, [rational(m.focalLength)]]);
    if (m.lensModel) exif.push([42036, 2, ascii(m.lensModel)]);
    if (exif.length) ifd0.push([34665, 4, [0]]);

    function size(e) { return e[1] === 2 ? e[2].length : e[1] === 3 ? 2 * e[2].length : e[1] === 4 ? 4 * e[2].length : 8 * e[2].length; }
    function ifdSize(list) {
      var extra = 0;
      list.forEach(function (e) { var s = size(e); if (s > 4) extra += s + (s & 1); });
      return 2 + list.length * 12 + 4 + extra;
    }
    ifd0.sort(function (a, b) { return a[0] - b[0]; });
    exif.sort(function (a, b) { return a[0] - b[0]; });
    var ifd0Off = 8, exifOff = ifd0Off + ifdSize(ifd0);
    var total = exifOff + (exif.length ? ifdSize(exif) : 0);
    var buf = new Uint8Array(total), dv = new DataView(buf.buffer);
    buf[0] = 0x49; buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifd0Off, true);

    function write(list, off) {
      dv.setUint16(off, list.length, true);
      var data = off + 2 + list.length * 12 + 4;
      list.forEach(function (e, i) {
        var p = off + 2 + i * 12, s = size(e);
        var count = e[1] === 2 ? e[2].length : e[2].length;
        dv.setUint16(p, e[0], true);
        dv.setUint16(p + 2, e[1], true);
        dv.setUint32(p + 4, count, true);
        var target = s > 4 ? data : p + 8;
        if (s > 4) { dv.setUint32(p + 8, data, true); data += s + (s & 1); }
        if (e[0] === 34665) e[2] = [exifOff];
        if (e[1] === 2) for (var k = 0; k < e[2].length; k++) buf[target + k] = e[2].charCodeAt(k);
        else if (e[1] === 3) e[2].forEach(function (v, k) { dv.setUint16(target + k * 2, v, true); });
        else if (e[1] === 4) e[2].forEach(function (v, k) { dv.setUint32(target + k * 4, v, true); });
        else if (e[1] === 5) e[2].forEach(function (v, k) { dv.setUint32(target + k * 8, v[0], true); dv.setUint32(target + k * 8 + 4, v[1], true); });
      });
      dv.setUint32(off + 2 + list.length * 12, 0, true);
    }
    write(ifd0, ifd0Off);
    if (exif.length) write(exif, exifOff);

    var segLen = 2 + 6 + buf.length;
    var seg = new Uint8Array(2 + segLen);
    seg[0] = 0xff; seg[1] = 0xe1; seg[2] = segLen >> 8; seg[3] = segLen & 255;
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    seg.set(buf, 10);
    return seg;
  }

  // Insere o segmento Exif logo após o início do JPEG, removendo APP0/APP1 existentes.
  function insertExif(jpeg, segment) {
    var u8 = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return u8;
    var p = 2;
    while (p + 4 <= u8.length && u8[p] === 0xff && (u8[p + 1] === 0xe0 || u8[p + 1] === 0xe1)) {
      p += 2 + ((u8[p + 2] << 8) | u8[p + 3]);
    }
    var out = new Uint8Array(2 + segment.length + (u8.length - p));
    out[0] = 0xff; out[1] = 0xd8;
    out.set(segment, 2);
    out.set(u8.subarray(p), 2 + segment.length);
    return out;
  }

  return {
    Tiff: Tiff,
    parseDng: parseDng,
    parseXmpSettings: parseXmpSettings,
    summarizeSettings: summarizeSettings,
    spatialEffects: spatialEffects,
    readJpegMeta: readJpegMeta,
    buildExif: buildExif,
    insertExif: insertExif,
    isSrgbTable: isSrgbTable
  };
});
