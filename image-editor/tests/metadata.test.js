'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/metadata.js');

// Monta um TIFF/DNG pequeno (little-endian) a partir de uma lista de IFDs.
function buildTiff(ifds) {
  const chunks = [];
  let size = 8;
  const layout = ifds.map((entries) => {
    const off = size;
    const extra = entries.reduce((a, e) => a + (e.bytes.length > 4 ? e.bytes.length + (e.bytes.length & 1) : 0), 0);
    size += 2 + entries.length * 12 + 4 + extra;
    return off;
  });
  const blobs = [];
  const blobStart = size;
  const out = new Uint8Array(size + 4096 * 4);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, layout[0], true);
  let blobOff = blobStart;
  const resolve = (v) => (typeof v === 'function' ? v(layout, (bytes) => { const o = blobOff; out.set(bytes, o); blobOff += bytes.length; blobs.push(o); return o; }) : v);
  ifds.forEach((entries, k) => {
    const off = layout[k];
    entries.sort((a, b) => a.tag - b.tag);
    dv.setUint16(off, entries.length, true);
    let data = off + 2 + entries.length * 12 + 4;
    entries.forEach((e, i) => {
      const p = off + 2 + i * 12;
      const bytes = resolve(e.bytes);
      dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true);
      if (bytes.length > 4) { dv.setUint32(p + 8, data, true); out.set(bytes, data); data += bytes.length + (bytes.length & 1); }
      else out.set(bytes, p + 8);
    });
    dv.setUint32(off + 2 + entries.length * 12, 0, true);
  });
  chunks.push(out);
  return out.subarray(0, blobOff);
}

const u16 = (...v) => new Uint8Array(new Uint16Array(v).buffer);
const u32 = (...v) => new Uint8Array(new Uint32Array(v).buffer);
const ascii = (s) => new TextEncoder().encode(s + '\0');
const entry = (tag, type, count, bytes) => ({ tag, type, count, bytes });

function fakeDng() {
  const xmp = new TextEncoder().encode(
    '<x:xmpmeta><rdf:Description crs:Exposure2012="+0.30" crs:Contrast2012="-8" crs:Highlights2012="-100" ' +
    'crs:WhiteBalance="As Shot" crs:Sharpness="108" crs:SharpenRadius="+1.0" crs:VignetteAmount="+46" crs:HasSettings="True" ' +
    'crs:HueAdjustmentOrange="-8" crs:ToneCurveName2012="Custom"><crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 17</rdf:li>' +
    '<rdf:li>253, 215</rdf:li></rdf:Seq></crs:ToneCurvePV2012></rdf:Description></x:xmpmeta>');
  const jpegA = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
  const jpegB = new Uint8Array([0xff, 0xd8, 9, 8, 7, 0xff, 0xd9]);
  const table = [];
  for (let i = 0; i < 256; i++) { const x = i / 255; table.push(Math.round((x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)) * 65535)); }
  let jpegAOff = 0, jpegBOff = 0;
  const tiff = buildTiff([
    [
      entry(254, 4, 1, u32(1)), entry(256, 4, 1, u32(8)), entry(257, 4, 1, u32(6)),
      entry(271, 2, 6, ascii('Canon')), entry(272, 2, 15, ascii('Canon EOS 250D')), entry(274, 3, 1, u16(6, 0)),
      entry(305, 2, 18, ascii('Adobe Lightroom 11')),
      entry(330, 4, 2, (layout) => u32(layout[1], layout[2])),
      entry(700, 1, xmp.length, xmp),
      entry(50706, 1, 4, new Uint8Array([1, 4, 0, 0])),
      entry(50708, 2, 5, ascii('JPEG'))
    ],
    [
      entry(254, 4, 1, u32(0)), entry(256, 4, 1, u32(300)), entry(257, 4, 1, u32(200)), entry(258, 3, 3, u16(8, 8, 8)),
      entry(259, 3, 1, u16(34892, 0)), entry(262, 3, 1, u16(34892, 0)), entry(277, 3, 1, u16(3, 0)),
      entry(322, 4, 1, u32(300)), entry(323, 4, 1, u32(200)),
      entry(324, 4, 1, (l, put) => { jpegAOff = put(jpegA); return u32(jpegAOff); }), entry(325, 4, 1, u32(jpegA.length)),
      entry(50712, 3, 256, u16(...table))
    ],
    [
      entry(254, 4, 1, u32(1)), entry(256, 4, 1, u32(300)), entry(257, 4, 1, u32(200)),
      entry(259, 3, 1, u16(7, 0)), entry(262, 3, 1, u16(6, 0)), entry(277, 3, 1, u16(3, 0)),
      entry(273, 4, 1, (l, put) => { jpegBOff = put(jpegB); return u32(jpegBOff); }), entry(279, 4, 1, u32(jpegB.length))
    ]
  ]);
  return { tiff, jpegAOff, jpegBOff };
}

test('lê um DNG do Lightroom: original, prévia editada, câmera e ajustes', () => {
  const { tiff, jpegAOff, jpegBOff } = fakeDng();
  const d = M.parseDng(tiff);
  assert.equal(d.isDng, true);
  assert.equal(d.meta.make, 'Canon');
  assert.equal(d.meta.model, 'Canon EOS 250D');
  assert.equal(d.meta.orientation, 6);
  assert.equal(d.original.kind, 'jpeg');
  assert.equal(d.original.width, 300);
  assert.equal(d.original.parts[0].offset, jpegAOff);
  assert.equal(d.previews.length, 1);
  assert.equal(d.previews[0].parts[0].offset, jpegBOff);
  assert.equal(d.settings.Exposure2012, 0.3);
  assert.equal(d.settings.Highlights2012, -100);
  assert.deepEqual(d.settings.ToneCurvePV2012, [[0, 17], [253, 215]]);
});

test('resumo legível das configurações do Lightroom', () => {
  const s = M.parseDng(fakeDng().tiff).settings;
  const labels = M.summarizeSettings(s).map((x) => x.label + ' ' + x.value);
  assert.ok(labels.includes('Exposição +0,30'));
  assert.ok(labels.includes('Contraste −8'));
  assert.ok(labels.includes('Cores (HSL) ajustadas'));
  assert.ok(labels.includes('Curva de tons personalizada'));
});

test('efeitos espaciais fazem a média das referências', () => {
  const fx = M.spatialEffects([{ Sharpness: 100, SharpenRadius: 1, VignetteAmount: 40 }, { Sharpness: 50, SharpenRadius: 0.5 }]);
  assert.equal(fx.sharpenAmount, 75);
  assert.equal(fx.sharpenRadius, 0.8);
  assert.equal(fx.vignetteAmount, 20);
  assert.equal(M.spatialEffects([]), null);
});

test('tabela de linearização sRGB é reconhecida', () => {
  const lin = [], srgb = [];
  for (let i = 0; i < 256; i++) {
    lin.push(i * 257);
    const x = i / 255;
    srgb.push(Math.round((x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)) * 65535));
  }
  assert.equal(M.isSrgbTable(srgb), true);
  assert.equal(M.isSrgbTable(lin), false);
});

test('arquivo que não é TIFF gera erro claro', () => {
  assert.throws(() => M.parseDng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), /TIFF/);
});

test('EXIF gravado é lido de volta, com orientação 1', () => {
  const meta = {
    make: 'Canon', model: 'Canon EOS 250D', orientation: 8, exposureTime: 1 / 250, fNumber: 5.6, iso: 3200,
    dateTimeOriginal: '2026:09:13 14:20:15', focalLength: 40, lensModel: 'EF-S18-200mm f/3.5-5.6 IS'
  };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xe1, 0, 4, 0, 0, 0xff, 0xdb, 0, 2, 0xff, 0xd9]);
  const out = M.insertExif(jpeg, M.buildExif(meta));
  assert.equal(out[2], 0xff);
  assert.equal(out[3], 0xe1);
  const back = M.readJpegMeta(out);
  assert.equal(back.orientation, 1);
  assert.equal(back.make, 'Canon');
  assert.equal(back.iso, 3200);
  assert.equal(back.dateTimeOriginal, '2026:09:13 14:20:15');
  assert.ok(Math.abs(back.exposureTime - 0.004) < 1e-9);
  assert.equal(back.lensModel, 'EF-S18-200mm f/3.5-5.6 IS');
  // segmentos APP0/APP1 antigos são substituídos, o resto do JPEG é preservado
  assert.deepEqual([...out.slice(-6)], [0xff, 0xdb, 0, 2, 0xff, 0xd9]);
});

test('JPEG sem EXIF devolve null', () => {
  assert.equal(M.readJpegMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 2, 0xff, 0xd9])), null);
});
