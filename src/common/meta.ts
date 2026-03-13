import type { Npub } from '../../types/nostr';

function upsertMetaTag(property: string, content: string): void {
  const selector: string = `meta[property="${property}"]`;
  let tag: HTMLMetaElement | null = document.head.querySelector(selector);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('property', property);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function upsertMetaName(name: string, content: string): void {
  const selector: string = `meta[name="${name}"]`;
  let tag: HTMLMetaElement | null = document.head.querySelector(selector);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', name);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function removeMetaTag(property: string): void {
  const selector: string = `meta[property="${property}"]`;
  const tag: HTMLMetaElement | null = document.head.querySelector(selector);
  if (tag) {
    tag.remove();
  }
}

function removeMetaName(name: string): void {
  const selector: string = `meta[name="${name}"]`;
  const tag: HTMLMetaElement | null = document.head.querySelector(selector);
  if (tag) {
    tag.remove();
  }
}

function extractFirstImageUrl(content: string): string | null {
  const match: RegExpMatchArray | null = content.match(
    /https?:\/\/[^\s]+?\.(jpeg|jpg|gif|png|webp|svg)/i,
  );
  return match ? match[0] : null;
}

export function setEventMeta(
  event: { id: string; content: string; created_at: number; pubkey: string },
  npub: Npub,
): void {
  const title: string = `nox - Event ${event.id.slice(0, 8)}`;
  const description: string =
    event.content.length > 140
      ? `${event.content.slice(0, 140)}...`
      : event.content;
  const imageUrl: string | null = extractFirstImageUrl(event.content);

  document.title = title;
  upsertMetaTag('og:title', title);
  upsertMetaTag('og:description', description || `Event by ${npub}`);
  upsertMetaTag('og:type', 'article');
  upsertMetaTag('og:url', window.location.href);
  if (imageUrl) {
    upsertMetaTag('og:image', imageUrl);
  } else {
    removeMetaTag('og:image');
  }

  upsertMetaName('description', description || `Event by ${npub}`);
  upsertMetaName('twitter:card', imageUrl ? 'summary_large_image' : 'summary');
  upsertMetaName('twitter:title', title);
  upsertMetaName('twitter:description', description || `Event by ${npub}`);
  if (imageUrl) {
    upsertMetaName('twitter:image', imageUrl);
  } else {
    removeMetaName('twitter:image');
  }
}
