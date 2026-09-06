/**
 * The gate, on the web.
 *
 * A full-screen overlay appended to `<body>` and, crucially, the thing that
 * stops the rest of the boot: `showTermsGate` resolves only once somebody has
 * agreed, and the caller awaits it before wiring routes, opening sockets or
 * fetching anything. Rendering it *over* a running app would leave the global
 * timeline loading behind it and reachable the moment a stylesheet failed.
 *
 * The documents are rendered inside it rather than linked. Linking would have
 * pointed at /terms, which is behind this gate - so the one place you could go
 * to read what you were agreeing to would have shown you this again.
 *
 * The summary above them comes from the same list the phone renders, so the
 * two builds cannot say different things.
 */

import privacyMarkdown from '../../../docs/privacy-policy.md?raw';
import termsMarkdown from '../../../docs/terms-of-use.md?raw';
import {
  acceptTerms,
  hasAcceptedTerms,
  TERMS_SUMMARY,
  type TermsPoint,
} from '../../common/terms.js';
import { renderMarkdown } from './render-markdown.js';

const GATE_ID: string = 'terms-gate';

function escapeHtml(value: string): string {
  const holder: HTMLDivElement = document.createElement('div');
  holder.textContent = value;
  return holder.innerHTML;
}

/**
 * Resolves once the terms have been accepted, immediately if they already
 * were. Awaiting this is what makes it a gate rather than a banner.
 */
export function showTermsGate(): Promise<void> {
  if (hasAcceptedTerms()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve): void => {
    const points: string = TERMS_SUMMARY.map(
      (point: TermsPoint): string => `
        <section class="mb-5">
          <h2 class="mb-1 text-base font-semibold text-gray-900">
            ${escapeHtml(point.heading)}
          </h2>
          <p class="text-sm leading-relaxed text-gray-600">
            ${escapeHtml(point.body)}
          </p>
        </section>
      `,
    ).join('');

    const gate: HTMLDivElement = document.createElement('div');
    gate.id = GATE_ID;
    gate.className =
      'fixed inset-0 z-[100] flex h-dvh items-center justify-center bg-white p-4';
    gate.innerHTML = `
      <div class="flex max-h-full w-full max-w-lg flex-col">
        <div class="min-h-0 flex-1 overflow-y-auto pr-1">
          <h1 class="mb-2 text-2xl font-bold text-gray-900">Before you start</h1>
          <p class="mb-6 text-sm leading-relaxed text-gray-700">
            nox is a Nostr client. A few things are worth knowing first,
            because none of them can be undone afterwards.
          </p>
          ${points}
          <details class="mb-3 rounded border border-gray-200 p-3">
            <summary class="cursor-pointer text-sm font-semibold text-gray-800">
              Terms of Use, in full
            </summary>
            <article class="nox-post-text mt-3 text-sm leading-relaxed">
              ${renderMarkdown(termsMarkdown)}
            </article>
          </details>
          <details class="mb-6 rounded border border-gray-200 p-3">
            <summary class="cursor-pointer text-sm font-semibold text-gray-800">
              Privacy Policy, in full
            </summary>
            <article class="nox-post-text mt-3 text-sm leading-relaxed">
              ${renderMarkdown(privacyMarkdown)}
            </article>
          </details>
          <p class="mb-2 text-sm leading-relaxed text-gray-600">
            Continuing accepts both. You must be at least 13.
          </p>
        </div>
        <button id="terms-gate-accept" type="button"
          class="mt-4 w-full flex-none rounded-lg bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700">
          Agree and continue
        </button>
      </div>
    `;

    document.body.appendChild(gate);
    // Nothing behind this scrolls while it is up.
    document.body.classList.add('overflow-hidden');

    const accept: HTMLButtonElement | null = gate.querySelector(
      '#terms-gate-accept',
    ) as HTMLButtonElement | null;

    accept?.addEventListener('click', (): void => {
      acceptTerms();
      gate.remove();
      document.body.classList.remove('overflow-hidden');
      resolve();
    });
  });
}
