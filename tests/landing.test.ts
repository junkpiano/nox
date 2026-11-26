/**
 * The landing page and the card a shared nox.garden link unfolds into.
 *
 * Read from the source files: the tags must be in the HTML a crawler fetches,
 * because no link-preview crawler runs the app's scripts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root: string = process.cwd();
const indexHtml: string = readFileSync(join(root, 'src/index.html'), 'utf8');
const welcome: string = readFileSync(
  join(root, 'src/features/home/welcome.ts'),
  'utf8',
);

function meta(attr: 'property' | 'name', key: string): string | null {
  const match: RegExpMatchArray | null = indexHtml.match(
    new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`),
  );
  return match?.[1] ?? null;
}

test('LANDING-3: Get the app leads to /apps as a full page load', (): void => {
  assert.match(
    welcome,
    /<a href="\/apps" data-full-load[^>]*>Get the app<\/a>/,
  );
});

test('LANDING-4: a shared link unfolds into a large card with a picture', (): void => {
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('property', 'og:image'), 'https://nox.garden/og.png');
  assert.equal(meta('name', 'twitter:image'), 'https://nox.garden/og.png');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  assert.equal(
    meta('property', 'og:url'),
    null,
    'og:url would point every route at one page',
  );
  const png: Buffer = readFileSync(join(root, 'public/og.png'));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
