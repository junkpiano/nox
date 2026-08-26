/**
 * A deliberately small Markdown renderer for the two legal documents.
 *
 * Not a general parser, and not meant to become one. It covers exactly what
 * `docs/privacy-policy.md` and `docs/terms-of-use.md` use: headings, lists,
 * tables, paragraphs, and inline bold, code and links.
 *
 * A library would be the right call for arbitrary input. Here the input is two
 * files in this repository, imported at build time, so it is neither untrusted
 * nor variable - and thirty kilobytes of parser for two static pages is a poor
 * trade right after a pass spent removing weight.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Bold, inline code and links, applied after escaping. */
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(
      /`([^`]+)`/g,
      '<code class="rounded bg-white/10 px-1 text-xs">$1</code>',
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="underline">$1</a>',
    );
}

function renderTableRow(line: string, cell: 'td' | 'th'): string {
  const cells: string[] = line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((value: string): string => value.trim());
  const className =
    cell === 'th' ? 'px-3 py-2 text-left font-semibold' : 'px-3 py-2 align-top';
  return `<tr>${cells
    .map(
      (value: string): string =>
        `<${cell} class="${className}">${renderInline(value)}</${cell}>`,
    )
    .join('')}</tr>`;
}

export function renderMarkdown(source: string): string {
  const lines: string[] = source.split('\n');
  const out: string[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let tableRows: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p class="mb-3">${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listItems.length > 0) {
      out.push(
        `<ul class="mb-3 list-disc space-y-1 pl-5">${listItems.join('')}</ul>`,
      );
      listItems = [];
    }
  };
  const flushTable = (): void => {
    if (tableRows.length > 0) {
      // Tables can be wider than a phone; let this one scroll rather than the
      // page.
      out.push(
        `<div class="mb-3 overflow-x-auto"><table class="w-full text-sm">${tableRows.join('')}</table></div>`,
      );
      tableRows = [];
    }
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line: string = raw.trimEnd();

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level: number = heading[1]?.length ?? 1;
      const text: string = heading[2] ?? '';
      const sizes: Record<number, string> = {
        1: 'mt-2 mb-4 text-2xl font-semibold',
        2: 'mt-6 mb-2 text-lg font-semibold',
        3: 'mt-4 mb-2 font-semibold',
        4: 'mt-3 mb-1 font-semibold',
      };
      out.push(
        `<h${level} class="${sizes[level] ?? sizes[4]}">${renderInline(text)}</h${level}>`,
      );
      continue;
    }

    if (line.startsWith('|')) {
      flushParagraph();
      flushList();
      // The alignment row carries no content.
      if (/^\|[\s:|-]+\|$/.test(line)) {
        continue;
      }
      tableRows.push(
        renderTableRow(line, tableRows.length === 0 ? 'th' : 'td'),
      );
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushTable();
      listItems.push(`<li>${renderInline(bullet[1] ?? '')}</li>`);
      continue;
    }

    flushList();
    flushTable();
    paragraph.push(line.trim());
  }

  flushAll();
  return out.join('\n');
}
