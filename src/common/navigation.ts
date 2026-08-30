import { hidesWallet } from './platform.js';

interface NavigationOptions {
  navigateTo: (path: string) => void;
  onLogout: () => void;
}

/**
 * Highlights one navigation entry and clears the rest.
 *
 * Clears every `.nox-nav-button` rather than an enumerated list. The previous
 * version named the buttons it knew about, so each destination added later -
 * messages, wallet, notifications - kept its highlight forever, and two entries
 * could look selected at once. Enumerating meant every new screen had to
 * remember to opt in, which is a rule that only holds until someone forgets.
 *
 * The parameters are kept so existing call sites do not have to change; only
 * `activeButton` is still read.
 */
export function setActiveNav(
  _homeButton: HTMLElement | null,
  _globalButton: HTMLElement | null,
  _relaysButton: HTMLElement | null,
  _profileLink: HTMLElement | null,
  _settingsButton: HTMLElement | null,
  activeButton: HTMLElement | null,
): void {
  for (const button of document.querySelectorAll<HTMLElement>(
    '.nox-nav-button',
  )) {
    button.classList.remove('bg-indigo-100', 'text-indigo-700');
    button.classList.add('text-gray-700');
  }

  if (activeButton) {
    activeButton.classList.remove('text-gray-700');
    activeButton.classList.add('bg-indigo-100', 'text-indigo-700');
  }
}

export function setupNavigation(options: NavigationOptions): void {
  const homeButton: HTMLElement | null = document.getElementById('nav-home');
  const globalButton: HTMLElement | null =
    document.getElementById('nav-global');
  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  const reactionsButton: HTMLElement | null =
    document.getElementById('nav-reactions');
  const relaysButton: HTMLElement | null =
    document.getElementById('nav-relays');
  const profileLink: HTMLAnchorElement | null = document.getElementById(
    'nav-profile',
  ) as HTMLAnchorElement | null;
  const settingsButton: HTMLElement | null =
    document.getElementById('nav-settings');
  const aboutButton: HTMLElement | null = document.getElementById('nav-about');
  const walletButton: HTMLElement | null =
    document.getElementById('nav-wallet');
  const messagesButton: HTMLElement | null =
    document.getElementById('nav-messages');
  const logoutButton: HTMLElement | null =
    document.getElementById('nav-logout');
  const signInButton: HTMLElement | null =
    document.getElementById('nav-signin');
  const mobileMenuButton: HTMLElement | null =
    document.getElementById('mobile-menu-button');
  const sidebar: HTMLElement | null = document.getElementById('sidebar');
  const searchMobileButton: HTMLElement | null =
    document.getElementById('nav-search-mobile');
  const searchOverlay: HTMLElement | null =
    document.getElementById('search-overlay');
  const searchOverlayClose: HTMLElement | null = document.getElementById(
    'search-overlay-close',
  );
  const searchOverlayBackdrop: HTMLElement | null = document.getElementById(
    'search-overlay-backdrop',
  );

  // Mobile menu toggle
  let isMobileMenuOpen = false;

  // The drawer is driven by one class rather than a dozen utility toggles, so
  // the open and closed states are described in CSS and can be animated. A
  // panel that appears in place reads as a dialog; one that slides in from the
  // edge reads as a drawer, which is what it is.
  const closeMobileMenu = (): void => {
    if (!sidebar) {
      return;
    }
    sidebar.classList.remove('is-open');
    document.body.classList.remove('nox-drawer-open');
    isMobileMenuOpen = false;
  };

  const openMobileMenu = (): void => {
    if (!sidebar) {
      return;
    }
    // The element carries `hidden` for the desktop layout, where the sidebar is
    // a column rather than a drawer; the drawer styles override it.
    sidebar.classList.add('is-open');
    // Stops the page scrolling underneath the open drawer.
    document.body.classList.add('nox-drawer-open');
    isMobileMenuOpen = true;
  };

  if (mobileMenuButton) {
    mobileMenuButton.addEventListener('click', (): void => {
      if (isMobileMenuOpen) {
        closeMobileMenu();
      } else {
        openMobileMenu();
      }
    });
  }

  // Close mobile menu when tapping the dimmed area beside the drawer
  if (sidebar) {
    sidebar.addEventListener('click', (event: MouseEvent): void => {
      if (event.target === sidebar) {
        closeMobileMenu();
      }
    });
  }

  // Escape closes it, and so does the system back gesture via popstate.
  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isMobileMenuOpen) {
      closeMobileMenu();
    }
  });
  window.addEventListener('popstate', (): void => {
    if (isMobileMenuOpen) {
      closeMobileMenu();
    }
  });

  // Auto-close mobile menu after navigation
  const wrapNavigationHandler = (handler: () => void): (() => void) => {
    return (): void => {
      handler();
      closeMobileMenu();
    };
  };

  if (homeButton) {
    homeButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/home');
      }),
    );
  }

  if (globalButton) {
    globalButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/global');
      }),
    );
  }

  // Real hrefs, so they can be opened in a new tab or copied like any link,
  // but routed in-app on a plain click.
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    '.nox-legal-link',
  )) {
    link.addEventListener('click', (event: MouseEvent): void => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button !== 0
      ) {
        return;
      }
      const href: string | null = link.getAttribute('href');
      if (!href || !href.startsWith('/')) {
        return;
      }
      event.preventDefault();
      wrapNavigationHandler((): void => {
        options.navigateTo(href);
      })();
    });
  }

  // Where a store does not allow a wallet, the way in is removed rather than
  // left to fail: an entry that leads nowhere is worse than no entry.
  if (hidesWallet()) {
    for (const element of document.querySelectorAll<HTMLElement>(
      '#nav-wallet, [data-nav-target="nav-wallet"]',
    )) {
      element.style.display = 'none';
    }
  }

  if (signInButton) {
    signInButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/signin');
      }),
    );
  }

  if (notificationsButton) {
    notificationsButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/notifications');
      }),
    );
  }

  if (reactionsButton) {
    reactionsButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/reactions');
      }),
    );
  }

  if (profileLink) {
    profileLink.addEventListener('click', (event: MouseEvent): void => {
      const href: string | null = profileLink.getAttribute('href');
      if (!href || !href.startsWith('/')) {
        // Signed out there is no profile to open. Asking for one is the same
        // as asking to sign in.
        event.preventDefault();
        wrapNavigationHandler((): void => {
          options.navigateTo('/signin');
        })();
        return;
      }

      event.preventDefault();
      wrapNavigationHandler((): void => {
        options.navigateTo(href);
      })();
    });
  }

  if (relaysButton) {
    relaysButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/relays');
      }),
    );
  }

  if (settingsButton) {
    settingsButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/settings');
      }),
    );
  }

  if (aboutButton) {
    aboutButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/about');
      }),
    );
  }

  if (walletButton) {
    walletButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/wallet');
      }),
    );
  }

  if (messagesButton) {
    messagesButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.navigateTo('/messages');
      }),
    );
  }

  if (logoutButton) {
    logoutButton.addEventListener(
      'click',
      wrapNavigationHandler((): void => {
        options.onLogout();
        options.navigateTo('/home');
      }),
    );
  }

  // Mobile search overlay
  if (searchMobileButton && searchOverlay) {
    searchMobileButton.addEventListener('click', (): void => {
      closeMobileMenu();
      searchOverlay.style.display = 'block';
    });
  }

  if (searchOverlayClose && searchOverlay) {
    searchOverlayClose.addEventListener('click', (): void => {
      searchOverlay.style.display = 'none';
    });
  }

  if (searchOverlayBackdrop && searchOverlay) {
    searchOverlayBackdrop.addEventListener('click', (): void => {
      searchOverlay.style.display = 'none';
    });
  }
}
