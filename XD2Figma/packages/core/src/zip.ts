export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

import { decodeUtf8, encodeUtf8 } from './utf8';

/** Create a standards-compliant uncompressed ZIP package. */
export function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    assertSafePath(entry.name);
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP path: ${entry.name}`);
    names.add(entry.name);
    const name = encodeUtf8(entry.name);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    write32(local, 0, 0x04034b50);
    write16(local, 4, 20);
    write16(local, 6, 0x0800);
    write16(local, 8, 0);
    write32(local, 14, checksum);
    write32(local, 18, entry.bytes.length);
    write32(local, 22, entry.bytes.length);
    write16(local, 26, name.length);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    write32(central, 0, 0x02014b50);
    write16(central, 4, 20);
    write16(central, 6, 20);
    write16(central, 8, 0x0800);
    write16(central, 10, 0);
    write32(central, 16, checksum);
    write32(central, 20, entry.bytes.length);
    write32(central, 24, entry.bytes.length);
    write16(central, 28, name.length);
    write32(central, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  write32(end, 0, 0x06054b50);
  write16(end, 8, entries.length);
  write16(end, 10, entries.length);
  write32(end, 12, centralSize);
  write32(end, 16, offset);
  return concat([...localParts, ...centralParts, end]);
}

export interface ZipDirectoryEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  crc: number;
  dataOffset: number;
}

export function readZipCentralDirectory(bytes: Uint8Array): ZipDirectoryEntry[] {
  const endOffset = findEnd(bytes);
  const count = read16(bytes, endOffset + 10);
  let offset = read32(bytes, endOffset + 16);
  const result: ZipDirectoryEntry[] = [];
  const names = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    if (read32(bytes, offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory entry.');
    const compression = read16(bytes, offset + 10);
    const crc = read32(bytes, offset + 16);
    const compressedSize = read32(bytes, offset + 20);
    const uncompressedSize = read32(bytes, offset + 24);
    const nameLength = read16(bytes, offset + 28);
    const extraLength = read16(bytes, offset + 30);
    const commentLength = read16(bytes, offset + 32);
    const localOffset = read32(bytes, offset + 42);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));
    assertSafePath(name);
    if (names.has(name)) throw new Error(`Duplicate ZIP path: ${name}`);
    names.add(name);
    if (read32(bytes, localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local entry: ${name}`);
    const localNameLength = read16(bytes, localOffset + 26);
    const localExtraLength = read16(bytes, localOffset + 28);
    result.push({ name, compression, compressedSize, uncompressedSize, localOffset, crc, dataOffset: localOffset + 30 + localNameLength + localExtraLength });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function assertSafePath(path: string): void {
  const segments = path.split('/');
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new Error(`Unsafe ZIP path: ${path}`);
  }
}

function findEnd(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (read32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end of central directory was not found.');
}

function read16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | bytes[offset + 1] << 8;
}

function read32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
}

function write16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
}

function write32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
  bytes[offset + 3] = value >>> 24 & 0xff;
}
