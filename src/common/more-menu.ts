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
}

let openMenu: (() => void) | null = null;

/**
 * The part of the screen a menu can be seen in: the nearest scrolling
 * ancestor's box, cut to the viewport. A menu placed outside it is clipped
 * or only reachable by scrolling the list.
 */
function visibleBounds(element: HTMLElement): { top: number; bottom: number } {
  let top: number = 0;
  let bottom: number = window.innerHeight;
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const rect: DOMRect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
      break;
    }
    node = node.parentElement;
  }
  return { top, bottom };
}

/** The gap between the trigger and the menu, matching `.nox-menu`'s offset. */
const MENU_GAP_PX: number = 6.4;

/** Builds the trigger and its menu. Append the returned element where the mark belongs. */
export function createMoreMenu(options: MoreMenuOptions): HTMLElement {
  const wrap: HTMLDivElement = document.createElement('div');
  wrap.className = 'nox-more';

  const trigger: HTMLButtonElement = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'nox-more-trigger';
  trigger.textContent = '···';
  trigger.title = 'More';
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
    enabled[wrapped]?.focus();
  };

  const open = (): void => {
    // One menu at a time: opening this one closes whichever was open.
    openMenu?.();
    openMenu = close;
    menu.hidden = false;
    menu.classList.remove('nox-menu-up');
    trigger.setAttribute('aria-expanded', 'true');
    // A row near the bottom of a scrolling panel would open its menu into
    // the panel's overflow, where it can only be reached by scrolling the
    // list. If it does not fit below but fits above, open upward. If it fits
    // in neither direction it stays below, where the panel's own scrolling
    // still reaches it.
    const bounds = visibleBounds(wrap);
    const triggerRect: DOMRect = trigger.getBoundingClientRect();
    const height: number = menu.getBoundingClientRect().height + MENU_GAP_PX;
    const below: number = bounds.bottom - triggerRect.bottom;
    const above: number = triggerRect.top - bounds.top;
    if (height > below && height <= above) {
      menu.classList.add('nox-menu-up');
    }
    listeners = new AbortController();
    const { signal } = listeners;
    document.addEventListener(
      'click',
      (event: MouseEvent): void => {
        if (!wrap.contains(event.target as Node)) close();
      },
      { signal },
    );
    document.addEventListener(
      'keydown',
      (event: KeyboardEvent): void => {
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
