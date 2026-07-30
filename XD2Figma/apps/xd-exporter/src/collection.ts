function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Converts XD collection types (notably SceneNodeList) into a real array.
 * SceneNodeList is not index-addressable, so Array.from() returns undefined
 * entries even though the collection exposes a length.
 */
export function collectionToArray<T>(value: any): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(isPresent);

  if (typeof value.map === 'function') {
    const mapped = value.map((item: T) => item);
    if (Array.isArray(mapped)) return mapped.filter(isPresent);
  }

  if (typeof value.forEach === 'function') {
    const result: T[] = [];
    value.forEach((item: T) => {
      if (isPresent(item)) result.push(item);
    });
    return result;
  }

  const length = Number(value.length);
  if (Number.isInteger(length) && length >= 0 && typeof value.at === 'function') {
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = value.at(index) as T | null | undefined;
      if (isPresent(item)) result.push(item);
    }
    return result;
  }

  if (typeof value[Symbol.iterator] === 'function') {
    return Array.from(value as Iterable<T>).filter(isPresent);
  }

  if (Number.isInteger(length) && length >= 0) {
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = value[index] as T | null | undefined;
      if (isPresent(item)) result.push(item);
    }
    return result;
  }

  return [];
}

/** Iterates XD collection types without first copying the collection. */
export function forEachCollection<T>(value: any, callback: (item: T, index: number) => void): void {
  if (!value) return;
  if (typeof value.forEach === 'function') {
    value.forEach((item: T, index: number) => {
      if (isPresent(item)) callback(item, index);
    });
    return;
  }
  if (typeof value[Symbol.iterator] === 'function') {
    let index = 0;
    for (const item of value as Iterable<T>) {
      if (isPresent(item)) callback(item, index);
      index += 1;
    }
    return;
  }
  const length = Number(value.length);
  if (!Number.isInteger(length) || length < 0) return;
  for (let index = 0; index < length; index += 1) {
    const item = typeof value.at === 'function' ? value.at(index) : value[index];
    if (isPresent(item)) callback(item as T, index);
  }
}
