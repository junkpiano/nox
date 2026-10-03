/**
 * Text that somebody else wrote, made safe to put inside HTML.
 *
 * One copy. There were eight, three of them built on a throwaway `<div>` -
 * which leaves quotes alone, so they were safe in a text node and not in an
 * attribute - and one that the phone could not use because of that `<div>`.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
