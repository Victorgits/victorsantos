'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../js/zip.js');

const enc = (s) => new TextEncoder().encode(s);

// Lê o diretório central de um ZIP sem compressão.
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const localName = dv.getUint16(local + 26, true);
    const data = bytes.subarray(local + 30 + localName, local + 30 + localName + size);
    files.push({ name, crc, data });
    p += 46 + nameLen;
  }
  return files;
}

test('CRC-32 bate com o valor de referência', () => {
  assert.equal(Z.crc32(enc('hello')), 0x3610a686);
  assert.equal(Z.crc32(new Uint8Array(0)), 0);
});

test('gera um ZIP válido com nomes repetidos e acentos', () => {
  const z = new Z.ZipWriter();
  z.add('foto.jpg', enc('abc'));
  z.add('foto.jpg', enc('defg'));
  z.add('ação.txt', enc('ç'));
  const OriginalBlob = global.Blob;
  global.Blob = undefined;
  let bytes;
  try { bytes = z.toBlob(); } finally { global.Blob = OriginalBlob; }
  const files = readZip(bytes);
  assert.deepEqual(files.map((f) => f.name), ['foto.jpg', 'foto (2).jpg', 'ação.txt']);
  assert.equal(new TextDecoder().decode(files[1].data), 'defg');
  files.forEach((f) => assert.equal(Z.crc32(f.data), f.crc));
});
