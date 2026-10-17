export type StockStatus = 'in' | 'low' | 'out';
export type Stock =
  | { kind: 'exact'; quantity: number; status: StockStatus }
  | { kind: 'range'; min: number; max: number | null; status: StockStatus }
  | { kind: 'hidden'; status: StockStatus | null }
  | { kind: 'unlimited' }
  | { kind: 'unknown' };
export interface SKU {
  id: string;
  name: string;
  price: string;
  stock: Stock;
}
export interface Product {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  categoryName: string;
  price: string;
  priceFrom: boolean;
  stock: Stock;
  skus: SKU[];
}
export interface Scan {
  products: Product[];
  siteName: string;
  currency: string;
  pages: number;
  at: number;
}
export const eventNames = [
  'increase',
  'decrease',
  'restock',
  'soldout',
  'range',
  'added',
  'removed',
  'price',
] as const;
export type EventName = (typeof eventNames)[number];
export interface Change {
  productId: string;
  productName: string;
  skuId?: string;
  skuName?: string;
  type: EventName;
  before: Stock;
  after: Stock;
  beforePrice?: string;
  afterPrice?: string;
  at: number;
}
export interface EngineState {
  initialized: boolean;
  accepted: Record<string, Product>;
  candidates: Record<string, { signature: string; count: number }>;
  missing: Record<string, number>;
}
export interface Batch {
  id: string;
  openedAt: number;
  events: Change[];
}
export interface BoardRecord {
  messageId: number;
  page: number;
  signature: string;
  updatedAt: number;
}
export interface Runtime {
  lastSuccess: number;
  lastAttempt: number;
  failures: number;
  lastError: string;
  pages: number;
  productCount: number;
  siteName: string;
  currency: string;
  nextCheck: number;
}
export type Button = {
  text: string;
  style?: 'danger' | 'success' | 'primary';
  icon_custom_emoji_id?: string;
  fallback_text?: string;
} & ({ url: string; callback_data?: never } | { callback_data: string; url?: never });
export interface MessagePayload {
  text: string;
  reply_markup: { inline_keyboard: Button[][] };
  parse_mode: 'HTML';
  link_preview_options: { is_disabled: true };
}
export interface Job {
  id: number;
  dedupe: string;
  target: string;
  payload: MessagePayload;
  status: string;
  attempts: number;
  nextAttempt: number;
  lastError: string;
}
