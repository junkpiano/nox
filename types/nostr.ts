// types/nostr.ts - TypeScript interfaces for Nostr protocol

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrProfile {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  url?: string;
  nip05?: string;
  lud16?: string;
  emojiTags?: string[][];
  [key: string]: any;
}

export interface RelayMessage {
  type: 'EVENT' | 'EOSE' | 'OK' | 'NOTICE' | 'CLOSED';
  data?: any;
}

export interface RelayRequest {
  type: 'REQ' | 'CLOSE';
  id: string;
  filters?: NostrFilter[];
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: string]: any;
}

export interface WebSocketMessage {
  data: string;
}

export interface RelayConnection {
  url: string;
  socket: WebSocket;
  connected: boolean;
}

// Utility types
export type PubkeyHex = string;
export type Npub = string;
export type EventId = string;

// API response types
export interface OGPMetadata {
  [key: string]: string | undefined;
  title?: string;
  description?: string;
  'og:title'?: string;
  'og:description'?: string;
  'og:image'?: string;
  'og:url'?: string;
  'og:type'?: string;
  'og:site_name'?: string;
  'twitter:card'?: string;
  'twitter:image'?: string;
  'twitter:site'?: string;
}

export interface OGPResponse {
  url: string;
  data: OGPMetadata;
}

export interface APIError {
  error: string;
}

export interface APISuccess<T = any> {
  data: T;
  success: boolean;
}
