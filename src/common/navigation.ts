interface NavigationOptions {
  navigateTo: (path: string) => void;
  onLogout: () => void;
}

export function setActiveNav(
  homeButton: HTMLElement | null,
  globalButton: HTMLElement | null,
  relaysButton: HTMLElement | null,
  profileLink: HTMLElement | null,
  settingsButton: HTMLElement | null,
  activeButton: HTMLElement | null,
): void {
  if (homeButton) {
    homeButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    homeButton.classList.add('text-gray-700');
  }
  if (globalButton) {
    globalButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    globalButton.classList.add('text-gray-700');
  }
  if (relaysButton) {
    relaysButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    relaysButton.classList.add('text-gray-700');
  }
  if (profileLink) {
    profileLink.classList.remove('bg-indigo-100', 'text-indigo-700');
    profileLink.classList.add('text-gray-700');
  }
  if (settingsButton) {
    settingsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    settingsButton.classList.add('text-gray-700');
  }
  const aboutButton: HTMLElement | null = document.getElementById('nav-about');
  if (aboutButton) {
    aboutButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    aboutButton.classList.add('text-gray-700');
  }
  const reactionsButton: HTMLElement | null =
    document.getElementById('nav-reactions');
  if (reactionsButton) {
    reactionsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    reactionsButton.classList.add('text-gray-700');
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
        closeMobileMenu();
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
