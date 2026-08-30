/**
 * Inputs must not be small enough to make a phone zoom.
 *
 * WebKit and Chrome enlarge the page when a focused field is under 16px, so
 * that what you are typing is readable. The zoom does not go away when the
 * field loses focus, so signing in left the whole app magnified - which no
 * native app does.
 *
 * The fix is the field size, not `maximum-scale=1` on the viewport: that stops
 * the zoom by taking pinch-zoom away from everyone, including the people who
 * need it.
 *
 * Checked against the built stylesheet rather than the source, because what
 * matters is which rule wins after Tailwind's utilities are in the same file.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const DIST_ASSETS: string = join(process.cwd(), 'dist', 'assets');

function builtStylesheet(): string {
  const file: string | undefined = readdirSync(DIST_ASSETS).find(
    (name: string): boolean => name.endsWith('.css'),
  );
  assert.ok(file, 'no built stylesheet - run the build first');
  return readFileSync(join(DIST_ASSETS, file), 'utf8');
}

test('the input rule sets a font size at all', () => {
  const css: string = builtStylesheet();
  const rule: string | undefined = css
    .slice(css.indexOf('.nox-input{'))
    .split('}')[0];
  assert.ok(rule, '.nox-input not found in the built stylesheet');
  assert.match(
    rule,
    /font-size:\s*16px/,
    '.nox-input must set 16px, or a focused field zooms the page',
  );
});

test('the input rule wins against the size utilities', () => {
  // Same specificity, so order decides. Tailwind's utilities are emitted where
  // the directive sits, near the top; the component rules follow.
  const css: string = builtStylesheet();
  const input: number = css.indexOf('.nox-input{');
  for (const utility of ['.text-sm{', '.text-xs{']) {
    const at: number = css.indexOf(utility);
    if (at < 0) continue;
    assert.ok(
      at < input,
      `${utility} comes after .nox-input and would win instead`,
    );
  }
});

test('pinch zoom is left alone', () => {
  // The tempting fix. It works by removing a feature people rely on to read.
  const html: string = readFileSync(
    join(process.cwd(), 'src', 'index.html'),
    'utf8',
  );
  const viewport: RegExpMatchArray | null = html.match(
    /<meta name="viewport" content="([^"]*)"/,
  );
  assert.ok(viewport, 'no viewport meta');
  assert.doesNotMatch(viewport[1] ?? '', /maximum-scale|user-scalable/);
});
