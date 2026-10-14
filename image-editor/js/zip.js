/*
 * Retoque — gerador de arquivos ZIP (sem compressão, ideal para JPEGs,
 * que já são comprimidos). Monta o arquivo como um Blob para não copiar
 * as fotos para a memória do JavaScript mais de uma vez.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Retoque = root.Retoque || {};
    root.Retoque.zip = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, previous) {
    var c = (previous == null ? 0 : previous) ^ 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8Bytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }

  function dosDateTime(date) {
    var d = date || new Date();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    var day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time, date: day };
  }

  function ZipWriter() {
    this.entries = [];
    this.parts = [];
    this.offset = 0;
    this.names = {};
  }

  // Evita nomes repetidos dentro do ZIP ("foto.jpg", "foto (2).jpg"...).
  ZipWriter.prototype.uniqueName = function (name) {
    var base = name, n = 2;
    while (this.names[name.toLowerCase()]) {
      var dot = base.lastIndexOf('.');
      name = dot > 0 ? base.slice(0, dot) + ' (' + n + ')' + base.slice(dot) : base + ' (' + n + ')';
      n++;
    }
    this.names[name.toLowerCase()] = true;
    return name;
  };

  // data: Uint8Array. part: o que entra no Blob (pode ser o próprio Blob de origem).
  ZipWriter.prototype.add = function (name, data, part, date) {
    var nameBytes = utf8Bytes(this.uniqueName(name));
    var crc = crc32(data);
    var dt = dosDateTime(date);
    var size = data.length;
    if (this.offset + size > 0xfffffff0) throw new Error('O ZIP passaria de 4 GB. Exporte em partes menores.');
    var header = new Uint8Array(30 + nameBytes.length);
    var v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // nomes em UTF-8
    v.setUint16(8, 0, true); // sem compressão
    v.setUint16(10, dt.time, true);
    v.setUint16(12, dt.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    this.entries.push({ name: nameBytes, crc: crc, size: size, offset: this.offset, dt: dt });
    this.parts.push(header, part || data);
    this.offset += header.length + size;
  };

  ZipWriter.prototype.finish = function () {
    var central = [], centralSize = 0;
    this.entries.forEach(function (e) {
      var h = new Uint8Array(46 + e.name.length);
      var v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.dt.time, true);
      v.setUint16(14, e.dt.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      h.set(e.name, 46);
      central.push(h);
      centralSize += h.length;
    });
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true);
    return this.parts.concat(central, [end]);
  };

  // No navegador devolve um Blob; em Node, um Uint8Array (para os testes).
  ZipWriter.prototype.toBlob = function () {
    var parts = this.finish();
    if (typeof Blob !== 'undefined') return new Blob(parts, { type: 'application/zip' });
    var total = parts.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(total), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  };

  return { crc32: crc32, ZipWriter: ZipWriter };
});
