/**
 * The phone app's type sizes, in one place.
 *
 * Post text is 16 points, the size both platforms use for body text; names
 * match it and the time, handle and client sit at 13. A tablet holds the
 * phone a little further away and gives the text far more room, so there
 * every size is a fifth larger. The system's text-size setting still scales
 * all of it on top.
 */

import { Dimensions } from 'react-native';

const { width, height } = Dimensions.get('screen');
/** A tablet by its shorter side, which does not change when it is turned. */
export const IS_TABLET: boolean = Math.min(width, height) >= 600;

const scaled = (points: number): number =>
  Math.round(points * (IS_TABLET ? 1.2 : 1));

export const TYPE = {
  /** A post's text. */
  body: scaled(16),
  bodyLine: scaled(23),
  /** The post a thread is about, a step above the rest. */
  lead: scaled(18),
  leadLine: scaled(26),
  name: scaled(16),
  /** Time, handle, client, status. */
  meta: scaled(13),
  /** Badges and small print. */
  small: scaled(12),
  /** Buttons and short labels. */
  label: scaled(14),
  /** Action-row symbols. */
  icon: scaled(22),
} as const;
