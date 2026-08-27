/**
 * What a signed-out visitor sees instead of a page that needs a session.
 *
 * The global timeline, settings and about stay open, along with the legal
 * documents the app stores require to be reachable. Everything else asks first.
 *
 * Deliberately one line and one button. A signed-out visitor already knows they
 * are signed out; explaining it at length would only be an apology for the
 * door.
 */

import type { SetActiveNavFn } from '../../common/types.js';

interface SignInGateOptions {
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  navigateTo: (path: string) => void;
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
}

export function showSignInGate(options: SignInGateOptions): void {
  options.closeAllWebSockets();
  options.stopBackgroundFetch();
  options.clearNotification();

  // Nothing is active: the route the visitor asked for is not the one they got.
  options.setActiveNav(null, null, null, null, null, null);

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    // Cleared, not just hidden: the mobile header copies this text, so leaving
    // it would title the gate after whichever page was open before.
    postsHeader.textContent = '';
    postsHeader.style.display = 'none';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  const output: HTMLElement | null = options.output;
  if (!output) {
    return;
  }

  output.innerHTML = `
    <section class="nox-gate">
      <p class="nox-gate-copy">Sign in to see this.</p>
      <button id="gate-sign-in" class="nox-primary-button py-3 px-6">Sign in</button>
    </section>
  `;

  document
    .getElementById('gate-sign-in')
    ?.addEventListener('click', (): void => {
      options.navigateTo('/signin');
    });
}
