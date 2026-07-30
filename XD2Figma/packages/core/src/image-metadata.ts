import { sha256HexSync } from './hash';
import type { XdAsset } from './types';

export function extractImageMetadata(bytes: Uint8Array, mimeType: XdAsset['mimeType']): Pick<XdAsset, 'iccProfile' | 'exif'> {
  if (mimeType === 'image/png') return extractPngMetadata(bytes);
  if (mimeType === 'image/jpeg') return extractJpegMetadata(bytes);
  return { iccProfile: null, exif: null };
}

export function readImageDimensions(bytes: Uint8Array, mimeType: XdAsset['mimeType']): { width: number; height: number } {
  if (mimeType === 'image/png' && bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG') {
    return { width: read32be(bytes, 16), height: read32be(bytes, 20) };
  }
  if (mimeType === 'image/gif' && bytes.length >= 10 && ascii(bytes, 0, 3) === 'GIF') {
    return { width: bytes[6] | bytes[7] << 8, height: bytes[8] | bytes[9] << 8 };
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 4) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: bytes[offset + 5] << 8 | bytes[offset + 6], width: bytes[offset + 7] << 8 | bytes[offset + 8] };
      }
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes[offset + 2] << 8 | bytes[offset + 3];
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

function extractPngMetadata(bytes: Uint8Array): Pick<XdAsset, 'iccProfile' | 'exif'> {
  if (bytes.length < 8 || bytes[0] !== 0x89 || ascii(bytes, 1, 3) !== 'PNG') return { iccProfile: null, exif: null };
  let offset = 8;
  let iccProfile: string | null = null;
  let exif: Record<string, unknown> | null = null;
  while (offset + 12 <= bytes.length) {
    const length = read32be(bytes, offset);
    if (length > bytes.length - offset - 12) break;
    const type = ascii(bytes, offset + 4, 4);
    const payload = bytes.slice(offset + 8, offset + 8 + length);
    if (type === 'iCCP') iccProfile = auditBlob('png-iCCP', payload);
    if (type === 'eXIf') exif = auditRecord('png-eXIf', payload);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return { iccProfile, exif };
}

function extractJpegMetadata(bytes: Uint8Array): Pick<XdAsset, 'iccProfile' | 'exif'> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { iccProfile: null, exif: null };
  let offset = 2;
  const iccSegments: Uint8Array[] = [];
  let exif: Record<string, unknown> | null = null;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
    const length = bytes[offset + 2] << 8 | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    const payload = bytes.slice(offset + 4, offset + 2 + length);
    if (marker === 0xe1 && ascii(payload, 0, 6) === 'Exif\0\0') exif = auditRecord('jpeg-APP1-Exif', payload);
    if (marker === 0xe2 && ascii(payload, 0, 12) === 'ICC_PROFILE\0') iccSegments.push(payload);
    offset += 2 + length;
  }
  const iccProfile = iccSegments.length ? auditBlob('jpeg-APP2-ICC', join(iccSegments)) : null;
  return { iccProfile, exif };
}

function auditRecord(format: string, bytes: Uint8Array): Record<string, unknown> {
  return { format, sha256: sha256HexSync(bytes), rawBase64: base64(bytes) };
}

function auditBlob(format: string, bytes: Uint8Array): string {
  return `${format};sha256=${sha256HexSync(bytes)};base64=${base64(bytes)}`;
}

function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const value = a << 16 | (b ?? 0) << 8 | (c ?? 0);
    output += alphabet[value >>> 18 & 63];
    output += alphabet[value >>> 12 & 63];
    output += b === undefined ? '=' : alphabet[value >>> 6 & 63];
    output += c === undefined ? '=' : alphabet[value & 63];
  }
  return output;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = '';
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) result += String.fromCharCode(bytes[offset + index]);
  return result;
}

function read32be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3])) >>> 0;
}

function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
