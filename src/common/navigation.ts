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

  const closeMobileMenu = (): void => {
    if (sidebar) {
      sidebar.classList.add('hidden');
      sidebar.classList.remove(
        'fixed',
        'inset-0',
        'z-50',
        'bg-black/50',
        'flex',
        'items-start',
        'pt-20',
        'px-4',
      );
      const sidebarContent = sidebar.querySelector('div');
      if (sidebarContent) {
        sidebarContent.classList.remove('w-full', 'max-w-sm');
      }
      isMobileMenuOpen = false;
    }
  };

  const openMobileMenu = (): void => {
    if (sidebar) {
      sidebar.classList.remove('hidden');
      sidebar.classList.add(
        'fixed',
        'inset-0',
        'z-50',
        'bg-black/50',
        'flex',
        'items-start',
        'pt-20',
        'px-4',
      );
      const sidebarContent = sidebar.querySelector('div');
      if (sidebarContent) {
        sidebarContent.classList.add('w-full', 'max-w-sm');
      }
      isMobileMenuOpen = true;
    }
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

  // Close mobile menu when clicking outside
  if (sidebar) {
    sidebar.addEventListener('click', (event: MouseEvent): void => {
      if (event.target === sidebar) {
        closeMobileMenu();
      }
    });
  }

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
