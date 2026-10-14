#!/usr/bin/env node
/*
 * Gera uma versão do Retoque em arquivo único (CSS e JS embutidos).
 *
 *   node scripts/build-single.js                 -> dist/retoque.html
 *   node scripts/build-single.js --fragment out  -> só o conteúdo da página,
 *                                                  sem <html>/<head>/<body>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function inline(html) {
  return html
    .replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, file) => `<style>\n${read(file)}</style>`)
    .replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, file) => `<script>\n${read(file).replace(/<\/script/gi, '<\\/script')}</script>`);
}

function fragment(html) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1]
    .replace(/<meta charset[^>]*>\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '')
    .replace(/<meta name="description"[^>]*>\s*/i, '');
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
  return head.trim() + '\n' + body.trim() + '\n';
}

const args = process.argv.slice(2);
const full = inline(read('index.html'));
const fragIndex = args.indexOf('--fragment');

if (fragIndex >= 0) {
  const out = path.resolve(args[fragIndex + 1] || path.join(root, 'dist', 'retoque-fragment.html'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, fragment(full));
  console.log('Fragmento gerado em ' + out);
} else {
  const out = path.join(root, 'dist', 'retoque.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, full);
  console.log('Arquivo único gerado em ' + out + ' (' + Math.round(full.length / 1024) + ' KB)');
}
