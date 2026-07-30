import { copyFile, mkdir } from 'node:fs/promises';

const copies = [
  ['apps/figma-importer/manifest.json', 'dist/apps/figma-importer/manifest.json'],
  ['apps/figma-importer/ui/ui.html', 'dist/apps/figma-importer/ui.html'],
  ['apps/xd-exporter/manifest.json', 'dist/apps/xd-exporter/manifest.json'],
];

for (const [source, destination] of copies) {
  await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true });
  await copyFile(source, destination);
}
