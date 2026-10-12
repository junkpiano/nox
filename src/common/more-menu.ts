/**
 * The three dots, and what opens under them.
 *
 * A row that offers four or five things - move, edit, remove, report -
 * cannot give each a button without the buttons becoming the row. One
 * quiet mark opens a list, and the list behaves like a menu: opens on
 * click or Enter, walks with the arrow keys, closes on Escape, on a choice,
 * or on a click anywhere else. Every listener the menu puts on the
 * document goes when the menu closes, so a page that redraws its rows a
 * hundred times does not keep a hundred menus listening.
 */

export interface MoreMenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in the warning colour: removing, reporting. */
  danger?: boolean;
  /** Present but not offered - the first row cannot move up. */
  disabled?: boolean;
}

export interface MoreMenuOptions {
  /** What the trigger is for, read to screen readers. */
  label: string;
  items: MoreMenuItem[];
  /**
   * Which edge of the trigger the menu hangs from. A mark at the right end
   * of a row opens leftwards, or it opens into the wall.
   */
  align?: 'start' | 'end';
  /**
   * A button already drawn to open the menu - the repost arrows, say -
   * instead of the three dots. It keeps its look and gains the menu.
   */
  trigger?: HTMLButtonElement;
}

let openMenu: (() => void) | null = null;

/** The gap between the trigger and the menu, matching `.nox-menu`'s offset. */
const MENU_GAP_PX: number = 6.4;

/** Builds the trigger and its menu. Append the returned element where the mark belongs. */
export function createMoreMenu(options: MoreMenuOptions): HTMLElement {
  const wrap: HTMLDivElement = document.createElement('div');
  wrap.className = 'nox-more';

  const trigger: HTMLButtonElement =
    options.trigger ?? document.createElement('button');
  if (!options.trigger) {
    trigger.type = 'button';
    trigger.className = 'nox-more-trigger';
    trigger.textContent = '···';
    trigger.title = 'More';
  }
  trigger.setAttribute('aria-label', options.label);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  const menu: HTMLDivElement = document.createElement('div');
  menu.className = `nox-menu${options.align === 'end' ? ' nox-menu-end' : ''}`;
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  let listeners: AbortController | null = null;

  const close = (): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    // Back beside its trigger, where it lives while closed.
    wrap.append(menu);
    trigger.setAttribute('aria-expanded', 'false');
    listeners?.abort();
    listeners = null;
    if (openMenu === close) openMenu = null;
  };

  const buttons: HTMLButtonElement[] = options.items.map(
    (item: MoreMenuItem): HTMLButtonElement => {
      const button: HTMLButtonElement = document.createElement('button');
      button.type = 'button';
      button.className = `nox-menu-item${item.danger ? ' nox-menu-item-danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.disabled = Boolean(item.disabled);
      button.addEventListener('click', (): void => {
        close();
        item.onSelect();
      });
      menu.appendChild(button);
      return button;
    },
  );

  const enabledItems = (): HTMLButtonElement[] =>
    buttons.filter((button: HTMLButtonElement): boolean => !button.disabled);

  const focusItem = (index: number): void => {
    const enabled: HTMLButtonElement[] = enabledItems();
    if (enabled.length === 0) return;
    const wrapped: number = (index + enabled.length) % enabled.length;
    const item: HTMLButtonElement | undefined = enabled[wrapped];
    if (!item) return;
    // Without scrolling the page: the menu is fixed to the screen, so it is
    // always in view, and a page scroll would close it. A menu capped to the
    // screen's height scrolls itself instead, to show the item.
    item.focus({ preventScroll: true });
    if (item.offsetTop < menu.scrollTop) {
      menu.scrollTop = item.offsetTop;
    } else if (
      item.offsetTop + item.offsetHeight >
      menu.scrollTop + menu.clientHeight
    ) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  };

  const open = (): void => {
    // One menu at a time: opening this one closes whichever was open.
    openMenu?.();
    openMenu = close;
    // Open, it hangs from the page itself: a panel with a backdrop blur or a
    // transform makes `fixed` relative to that panel, and a scrolling box
    // clips whatever sits inside it.
    document.body.append(menu);
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // Placed against the screen, not the row: a card or a panel that clips
    // its overflow cut a menu off whenever it held a short post or the last
    // row, and no choice of direction inside it fixed that. Below the trigger
    // when it fits, above when only that fits, and kept on the screen.
    const triggerRect: DOMRect = trigger.getBoundingClientRect();
    const box: DOMRect = menu.getBoundingClientRect();
    const below: number = window.innerHeight - triggerRect.bottom;
    const above: number = triggerRect.top;
    const height: number = box.height + MENU_GAP_PX;
    const top: number =
      height > below && height <= above
        ? triggerRect.top - height
        : triggerRect.bottom + MENU_GAP_PX;
    const preferredLeft: number =
      options.align === 'end'
        ? triggerRect.right - box.width
        : triggerRect.left;
    const left: number = Math.min(
      Math.max(8, preferredLeft),
      window.innerWidth - box.width - 8,
    );
    // On the screen whatever happens: a menu taller than the room scrolls
    // inside itself (CSS caps its height), rather than running off the edge.
    const maxTop: number = Math.max(8, window.innerHeight - box.height - 8);
    Object.assign(menu.style, {
      position: 'fixed',
      top: `${Math.min(Math.max(8, top), maxTop)}px`,
      left: `${left}px`,
      right: 'auto',
      bottom: 'auto',
    });
    listeners = new AbortController();
    const { signal } = listeners;
    // Fixed to the screen, it would float away from its row on a scroll;
    // any scroll, of the page or of a panel, closes it instead.
    window.addEventListener(
      'scroll',
      (event: Event): void => {
        // Its own scrolling, when it is taller than the screen, is not leaving.
        if (!menu.contains(event.target as Node)) close();
      },
      { signal, capture: true, passive: true },
    );
    window.addEventListener('resize', close, { signal });
    // Hung from the page, it no longer goes when its row does: a new route,
    // Back or Forward, or the row redrawn away closes it.
    window.addEventListener('app-route-changed', close, { signal });
    window.addEventListener('popstate', close, { signal });
    const watch = setInterval((): void => {
      if (!trigger.isConnected) close();
    }, 1000);
    signal.addEventListener('abort', (): void => clearInterval(watch));
    // In the capture phase: a control that stops its own clicks (the emoji
    // button, say) would otherwise open on top of a menu that never heard.
    document.addEventListener(
      'click',
      (event: MouseEvent): void => {
        const target: Node = event.target as Node;
        if (!wrap.contains(target) && !menu.contains(target)) close();
      },
      { signal, capture: true },
    );
    document.addEventListener(
      'keydown',
      (event: KeyboardEvent): void => {
        // Keys are the menu's only while it, or its trigger, has focus: typed
        // into a search box elsewhere they belong there.
        const focused: Element | null = document.activeElement;
        if (focused !== trigger && !menu.contains(focused)) return;
        const current: number = enabledItems().findIndex(
          (button: HTMLButtonElement): boolean =>
            button === document.activeElement,
        );
        switch (event.key) {
          case 'Escape':
            event.preventDefault();
            close();
            trigger.focus();
            break;
          case 'ArrowDown':
            event.preventDefault();
            focusItem(current + 1);
            break;
          case 'ArrowUp':
            event.preventDefault();
            focusItem(current - 1);
            break;
          case 'Home':
            event.preventDefault();
            focusItem(0);
            break;
          case 'End':
            event.preventDefault();
            focusItem(-1);
            break;
          case 'Tab':
            // Tabbing away is leaving.
            close();
            break;
          default:
            break;
        }
      },
      { signal },
    );
    focusItem(0);
  };

  trigger.addEventListener('click', (event: MouseEvent): void => {
    event.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  trigger.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown' && menu.hidden) {
      event.preventDefault();
      open();
    }
  });

  wrap.append(trigger, menu);
  return wrap;
}
