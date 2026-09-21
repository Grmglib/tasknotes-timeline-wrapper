'use strict';

const esbuild = require('esbuild');
const process = require('process');

const production = process.argv[2] === 'production';

esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  minify: production,
  external: ['obsidian'],
}).catch(() => process.exit(1));
