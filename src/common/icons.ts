/**
 * The app's icons, named once for every platform.
 *
 * Each action has an SF Symbol, which iOS draws, and a Material Symbol,
 * which Android draws and the web can load from Google's Material Symbols
 * font by the same name. Screens ask for an action ("reply"), never for a
 * glyph: a text character such as ↩ is drawn as a colour emoji on iOS and
 * as a thin glyph elsewhere, so it could not be the same icon anywhere.
 *
 * Shared with the phone and the web: no DOM here.
 */

export interface IconNames {
  /** SF Symbol, for iOS. */
  sf: string;
  /** Material Symbol, for Android and the web. */
  material: string;
}

export const ICONS = {
  home: { sf: 'house', material: 'home' },
  search: { sf: 'magnifyingglass', material: 'search' },
  messages: { sf: 'envelope', material: 'mail' },
  alerts: { sf: 'bell', material: 'notifications' },
  reply: { sf: 'arrowshape.turn.up.left', material: 'reply' },
  repost: { sf: 'arrow.2.squarepath', material: 'repeat' },
  like: { sf: 'heart', material: 'favorite' },
  liked: { sf: 'heart.fill', material: 'favorite' },
  react: { sf: 'face.smiling', material: 'add_reaction' },
  more: { sf: 'ellipsis', material: 'more_horiz' },
  report: { sf: 'flag', material: 'flag' },
  settings: { sf: 'gearshape', material: 'settings' },
} as const satisfies Record<string, IconNames>;

export type IconName = keyof typeof ICONS;
