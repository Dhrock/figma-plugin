/** UTF-8 codec that also works in the restricted Figma plugin sandbox. */
export function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + next - 0xdc00;
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | codePoint >> 6, 0x80 | codePoint & 0x3f);
    else if (codePoint <= 0xffff) bytes.push(0xe0 | codePoint >> 12, 0x80 | codePoint >> 6 & 0x3f, 0x80 | codePoint & 0x3f);
    else bytes.push(0xf0 | codePoint >> 18, 0x80 | codePoint >> 12 & 0x3f, 0x80 | codePoint >> 6 & 0x3f, 0x80 | codePoint & 0x3f);
  }
  return Uint8Array.from(bytes);
}

export function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let codePoint: number;
    let remaining: number;
    let minimum: number;
    if (first <= 0x7f) {
      codePoint = first;
      remaining = 0;
      minimum = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      remaining = 1;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      remaining = 2;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      remaining = 3;
      minimum = 0x10000;
    } else {
      result += '\ufffd';
      continue;
    }

    const continuationStart = index;
    let valid = index + remaining <= bytes.length;
    for (let count = 0; valid && count < remaining; count += 1) {
      const next = bytes[index + count];
      if ((next & 0xc0) !== 0x80) valid = false;
      else codePoint = codePoint << 6 | next & 0x3f;
    }
    if (!valid || codePoint < minimum || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) {
      result += '\ufffd';
      index = continuationStart;
      continue;
    }
    index += remaining;
    if (codePoint <= 0xffff) result += String.fromCharCode(codePoint);
    else {
      codePoint -= 0x10000;
      result += String.fromCharCode(0xd800 | codePoint >> 10, 0xdc00 | codePoint & 0x3ff);
    }
  }
  return result;
}
