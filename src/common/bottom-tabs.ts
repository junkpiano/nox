/**
 * Bottom tab bar for narrow viewports.
 *
 * The tabs delegate to the existing sidebar buttons instead of re-implementing
 * navigation, so routing, relay teardown and every other side effect stay in
 * one place. Only the active highlight is mirrored here, derived from the path
 * rather than from the sidebar's classes.
 */

const ACTIVE_CLASS: string = 'is-active';

/** Placeholder for the profile tab, whose real path depends on who is signed in. */
const PROFILE_PATH_TOKEN: string = '__profile__';

function resolveTabPath(tab: HTMLElement): string | null {
  const path: string | undefined = tab.dataset.navPath;
  if (!path) {
    return null;
  }
  if (path !== PROFILE_PATH_TOKEN) {
    return path;
  }

  // The profile tab points at whichever npub is signed in.
  const link = document.getElementById(
    'nav-profile',
  ) as HTMLAnchorElement | null;
  const href: string | null = link?.getAttribute('href') ?? null;
  return href && href !== '#' ? href : null;
}

function isSignedIn(): boolean {
  try {
    return Boolean(localStorage.getItem('nostr_pubkey'));
  } catch {
    return false;
  }
}

function syncActiveTab(): void {
  const currentPath: string =
    window.location.pathname === '/' ? '/home' : window.location.pathname;

  for (const tab of document.querySelectorAll<HTMLElement>('.nox-tab')) {
    const path: string | null = resolveTabPath(tab);
    const active: boolean = path !== null && path === currentPath;
    tab.classList.toggle(ACTIVE_CLASS, active);

    // Signed out, profile and messages have nothing to show. Dimming says so
    // before the tap rather than after it.
    const needsSignIn: boolean =
      tab.dataset.navTarget === 'nav-profile' ||
      tab.dataset.navTarget === 'nav-messages';
    tab.classList.toggle('is-unavailable', needsSignIn && !isSignedIn());
    if (active) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  }
}

export function setupBottomTabs(): void {
  for (const tab of document.querySelectorAll<HTMLElement>('.nox-tab')) {
    const targetId: string | undefined = tab.dataset.navTarget;
    if (!targetId) {
      // The overflow tab keeps its own handler from setupNavigation().
      continue;
    }

    tab.addEventListener('click', (): void => {
      // Signed out, the profile link has no npub to point at, so delegating
      // would silently do nothing. Send the user where they can sign in
      // instead: a tab that appears to be broken is worse than one that
      // explains itself.
      if (targetId === 'nav-profile' && !isSignedIn()) {
        window.dispatchEvent(
          new CustomEvent('navigate-to-path', { detail: { path: '/home' } }),
        );
        syncActiveTab();
        return;
      }

      // Delegating a click keeps one implementation of each destination.
      document.getElementById(targetId)?.click();
      syncActiveTab();
    });
  }

  window.addEventListener('popstate', syncActiveTab);
  // Routing is driven by pushState, which fires no event of its own.
  window.addEventListener('app-route-changed', syncActiveTab);

  syncActiveTab();
}
