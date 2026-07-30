export type PortableBlendMode =
  | 'PASS_THROUGH'
  | 'NORMAL'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'COLOR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'COLOR_DODGE'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY';

const PORTABLE_BLEND_MODES = new Set<PortableBlendMode>([
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN',
  'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT',
  'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
]);

/** Normalize Adobe XD blend-mode spellings to the equivalent Figma value. */
export function normalizePortableBlendMode(value: string | null | undefined): PortableBlendMode | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().toLocaleUpperCase().replace(/[\s-]+/g, '_');
  const alias = normalized === 'PASSTHROUGH' ? 'PASS_THROUGH' : normalized;
  return PORTABLE_BLEND_MODES.has(alias as PortableBlendMode) ? alias as PortableBlendMode : null;
}
