import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const appRoot = resolve('dist/apps/XD2Figma Converter.app');
const contents = `${appRoot}/Contents`;
const macOS = `${contents}/MacOS`;
const resources = `${contents}/Resources`;
const converter = `${resources}/converter`;
const swiftModuleCache = resolve('dist/swift-module-cache');
const iconSource = resolve('apps/xd-local-converter-macos/AppIcon.png');
const iconset = resolve('dist/AppIcon.iconset');

await rm(appRoot, { recursive: true, force: true });
await rm(iconset, { recursive: true, force: true });
await mkdir(macOS, { recursive: true });
await mkdir(converter, { recursive: true });
await mkdir(swiftModuleCache, { recursive: true });
await mkdir(iconset, { recursive: true });

await Promise.all([
  build({
    entryPoints: ['tools/xd-direct-cli.ts'],
    outfile: `${converter}/xd-direct-cli.cjs`,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    legalComments: 'none',
  }),
  build({
    entryPoints: ['tools/package-cli.ts'],
    outfile: `${converter}/package-cli.cjs`,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    legalComments: 'none',
  }),
  copyFile('apps/xd-local-converter-macos/Info.plist', `${contents}/Info.plist`),
  writeFile(`${resources}/default-output-path.txt`, `${resolve('output')}\n`),
]);

const iconVariants = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
await Promise.all(iconVariants.map(([filename, size]) => run('/usr/bin/sips', [
  '-z', String(size), String(size), iconSource, '--out', `${iconset}/${filename}`,
])));
await writeIcns(`${resources}/AppIcon.icns`, [
  ['icp4', `${iconset}/icon_16x16.png`],
  ['ic11', `${iconset}/icon_16x16@2x.png`],
  ['icp5', `${iconset}/icon_32x32.png`],
  ['ic12', `${iconset}/icon_32x32@2x.png`],
  ['ic07', `${iconset}/icon_128x128.png`],
  ['ic13', `${iconset}/icon_128x128@2x.png`],
  ['ic08', `${iconset}/icon_256x256.png`],
  ['ic14', `${iconset}/icon_256x256@2x.png`],
  ['ic09', `${iconset}/icon_512x512.png`],
  ['ic10', `${iconset}/icon_512x512@2x.png`],
]);
await rm(iconset, { recursive: true, force: true });

await run('/usr/bin/swiftc', [
  'apps/xd-local-converter-macos/XD2FigmaConverter.swift',
  '-o', `${macOS}/XD2FigmaConverter`,
  '-framework', 'SwiftUI',
  '-framework', 'AppKit',
  '-module-cache-path', swiftModuleCache,
  '-parse-as-library',
]);
await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appRoot]);
process.stdout.write(`${appRoot}\n`);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function writeIcns(output, representations) {
  const chunks = await Promise.all(representations.map(async ([type, path]) => {
    const image = await readFile(path);
    const chunk = Buffer.alloc(8 + image.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    image.copy(chunk, 8);
    return chunk;
  }));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + body.length, 4);
  await writeFile(output, Buffer.concat([header, body]));
}
