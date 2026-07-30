import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['apps/figma-importer/src/code.ts'],
    outfile: 'dist/apps/figma-importer/code.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    legalComments: 'none',
  }),
  build({
    entryPoints: ['apps/xd-exporter/src/code.ts'],
    outfile: 'dist/apps/xd-exporter/code.js',
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2020',
    external: ['application', 'interactions', 'scenegraph', 'uxp'],
    sourcemap: true,
    legalComments: 'none',
  }),
]);
