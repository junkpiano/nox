/**
 * Privacy policy and terms of use, served from the app itself.
 *
 * The documents live in `docs/` and are imported at build time, so the app and
 * the repository cannot disagree about what was agreed to. Both stores want a
 * stable URL for these, and a path on the app's own domain survives repository
 * reorganisation in a way a GitHub file path does not.
 */

import privacyMarkdown from '../../../docs/privacy-policy.md?raw';
import termsMarkdown from '../../../docs/terms-of-use.md?raw';
import type { SetActiveNavFn } from '../../common/types.js';
import { renderMarkdown } from './render-markdown.js';

export type LegalDocument = 'privacy' | 'terms';

interface LegalPageOptions {
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
  document: LegalDocument;
}

const TITLES: Record<LegalDocument, string> = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Use',
};

export function loadLegalPage(options: LegalPageOptions): void {
  options.closeAllWebSockets();
  options.stopBackgroundFetch();
  options.clearNotification();

  options.setActiveNav(
    document.getElementById('nav-home'),
    document.getElementById('nav-global'),
    document.getElementById('nav-relays'),
    document.getElementById('nav-profile'),
    document.getElementById('nav-settings'),
    document.getElementById('nav-about'),
  );

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = TITLES[options.document];
    postsHeader.style.display = '';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  const output: HTMLElement | null = options.output;
  if (!output) {
    return;
  }

  const source: string =
    options.document === 'privacy' ? privacyMarkdown : termsMarkdown;

  output.innerHTML = `
    <article class="nox-post-text text-sm leading-relaxed">
      ${renderMarkdown(source)}
    </article>
  `;
}
