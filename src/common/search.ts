import { hashtagQuery } from './interests.js';

export function setupSearchBar(navigateTo: (path: string) => void): void {
  const searchButton: HTMLElement | null =
    document.getElementById('search-button');
  const clearSearchButton: HTMLElement | null = document.getElementById(
    'clear-search-button',
  );
  const searchInput: HTMLInputElement | null = document.getElementById(
    'search-input',
  ) as HTMLInputElement;

  // Mobile search elements
  const searchButtonMobile: HTMLElement | null = document.getElementById(
    'search-button-mobile',
  );
  const clearSearchButtonMobile: HTMLElement | null = document.getElementById(
    'clear-search-button-mobile',
  );
  const searchInputMobile: HTMLInputElement | null = document.getElementById(
    'search-input-mobile',
  ) as HTMLInputElement;
  const searchOverlay: HTMLElement | null =
    document.getElementById('search-overlay');

  function performSearch(fromMobile: boolean = false): void {
    const activeInput =
      fromMobile && searchInputMobile ? searchInputMobile : searchInput;

    if (activeInput) {
      const query: string = activeInput.value.trim();
      if (!query) {
        clearSearch();
        return;
      }

      // Sync inputs
      if (searchInput && searchInputMobile) {
        searchInput.value = query;
        searchInputMobile.value = query;
      }

      // `#word` opens that hashtag, as on the phone; anything else searches.
      const tag: string | null = hashtagQuery(query);
      const path: string = tag
        ? `/t/${encodeURIComponent(tag)}`
        : `/search?q=${encodeURIComponent(query)}`;
      navigateTo(path);

      if (clearSearchButton) {
        clearSearchButton.style.display = '';
      }

      if (clearSearchButtonMobile) {
        clearSearchButtonMobile.style.display = '';
      }

      // Close mobile search overlay after search
      if (fromMobile && searchOverlay) {
        searchOverlay.style.display = 'none';
      }
    }
  }

  function clearSearch(): void {
    if (searchInput) {
      searchInput.value = '';
    }

    if (searchInputMobile) {
      searchInputMobile.value = '';
    }

    if (clearSearchButton) {
      clearSearchButton.style.display = 'none';
    }

    if (clearSearchButtonMobile) {
      clearSearchButtonMobile.style.display = 'none';
    }

    if (window.location.pathname === '/search') {
      navigateTo('/home');
    }
  }

  if (searchButton) {
    searchButton.addEventListener('click', (): void => performSearch(false));
  }

  if (clearSearchButton) {
    clearSearchButton.addEventListener('click', clearSearch);
  }

  if (searchInput) {
    searchInput.addEventListener('keypress', (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        performSearch(false);
      }
    });

    searchInput.addEventListener('input', (): void => {
      const query: string = searchInput.value.trim();
      if (query === '') {
        clearSearch();
      }
    });
  }

  // Mobile search event listeners
  if (searchButtonMobile) {
    searchButtonMobile.addEventListener('click', (): void =>
      performSearch(true),
    );
  }

  if (clearSearchButtonMobile) {
    clearSearchButtonMobile.addEventListener('click', (): void => {
      clearSearch();
      if (searchOverlay) {
        searchOverlay.style.display = 'none';
      }
    });
  }

  if (searchInputMobile) {
    searchInputMobile.addEventListener('keypress', (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        performSearch(true);
      }
    });

    searchInputMobile.addEventListener('input', (): void => {
      const query: string = searchInputMobile.value.trim();
      if (query === '') {
        clearSearch();
      }
    });
  }
}
