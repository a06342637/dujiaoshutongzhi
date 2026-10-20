import { z } from 'zod';
import { eventNames } from './types.js';

export const eventLabels = {
  increase: '可售增加',
  decrease: '可售减少',
  restock: '恢复有货',
  soldout: '售罄',
  range: '区间／展示状态变化',
  added: '商品新增',
  removed: '商品不可见',
  price: '价格变化',
};
export const numericFields = {
  interval: { label: '检查间隔（秒）', min: 1, max: 3600, default: 15 },
  timeout: { label: '请求超时（秒）', min: 3, max: 60, default: 10 },
  retries: { label: '请求重试次数', min: 0, max: 5, default: 2 },
  confirmations: { label: '变化确认次数', min: 1, max: 5, default: 1 },
  mergeWindow: { label: '通知合并窗口（秒）', min: 0, max: 300, default: 10 },
  boardInterval: { label: '看板最短更新间隔（秒）', min: 5, max: 3600, default: 15 },
  periodicInterval: { label: '定时通知间隔（秒）', min: 60, max: 604800, default: 3600 },
  threshold: { label: '数量变化门槛（件）', min: 1, max: 1000000000, default: 1 },
  missingConfirmations: { label: '商品消失确认次数', min: 2, max: 5, default: 2 },
  pageSize: { label: '看板每页商品数', min: 5, max: 20, default: 10 },
} as const;
const num = (key: keyof typeof numericFields) =>
  z.number().int().min(numericFields[key].min).max(numericFields[key].max);
export const httpUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, '请输入完整的 http:// 或 https:// 地址，不含用户名密码');
export const buttonUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ['http:', 'https:', 'tg:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, '按钮地址必须使用 http、https 或 tg 协议');
export const styleSchema = z.enum(['auto', 'default', 'danger', 'success', 'primary']);
const emojiId = z
  .string()
  .regex(/^\d{1,30}$/)
  .or(z.literal(''));
const eventsSchema = z
  .object(
    Object.fromEntries(eventNames.map((k) => [k, z.boolean()])) as Record<
      (typeof eventNames)[number],
      z.ZodBoolean
    >,
  )
  .strict();
const partialEvents = eventsSchema.partial();
const formatSchema = z
  .object({
    header: z.string().max(500),
    top: z.string().max(1000),
    detailsTitle: z.string().max(200),
    divider: z.string().max(100),
    stockTitle: z.string().max(200),
    footer: z.string().max(1000),
    order: z
      .array(z.enum(['header', 'top', 'details', 'divider', 'stock', 'time', 'footer']))
      .max(7)
      .refine((a) => new Set(a).size === a.length, '栏目不能重复'),
    timeFormat: z.enum(['MM-DD HH:mm', 'YYYY-MM-DD HH:mm:ss', 'HH:mm:ss']),
    timezone: z
      .string()
      .max(100)
      .refine((s) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: s });
          return true;
        } catch {
          return false;
        }
      }, '时区无效'),
    bodyTemplate: z.string().max(3000),
    changeTemplate: z.string().max(800),
  })
  .strict();
const productOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().max(200).optional(),
    emoji: z.string().max(40).optional(),
    customEmojiId: emojiId.optional(),
    style: styleSchema.optional(),
    order: z.number().int().min(-100000).max(100000).optional(),
    url: buttonUrl.optional(),
    expandSkus: z.boolean().optional(),
    showStock: z.boolean().optional(),
    events: partialEvents.optional(),
    threshold: num('threshold').optional(),
    confirmations: num('confirmations').optional(),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    siteUrl: httpUrl.or(z.literal('')),
    apiUrl: httpUrl.or(z.literal('')),
    paused: z.boolean(),
    notifications: z.boolean(),
    periodicNotifications: z.boolean().default(false),
    board: z.boolean(),
    autoMonitorNew: z.boolean(),
    timing: z
      .object({
        interval: num('interval'),
        timeout: num('timeout'),
        retries: num('retries'),
        confirmations: num('confirmations'),
        mergeWindow: num('mergeWindow'),
        boardInterval: num('boardInterval'),
        periodicInterval: num('periodicInterval').default(numericFields.periodicInterval.default),
        threshold: num('threshold'),
        missingConfirmations: num('missingConfirmations'),
        pageSize: num('pageSize'),
      })
      .strict(),
    events: eventsSchema,
    targets: z
      .array(
        z
          .object({
            id: z.string().regex(/^-?\d{1,20}$/),
            title: z.string().max(200),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(30)
      .refine((a) => new Set(a.map((x) => x.id)).size === a.length, '目标重复'),
    products: z.record(z.string().regex(/^\d{1,30}$/), productOverrideSchema),
    appearance: z
      .object({
        notification: formatSchema,
        board: formatSchema,
        buttonTemplate: z.string().max(500),
        emoji: z.string().max(40),
        customEmojiId: emojiId,
        style: styleSchema,
        filter: z.enum(['all', 'available', 'changed']),
        footerColumns: z.union([z.literal(1), z.literal(2)]),
        links: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z0-9-]{1,40}$/),
                text: z.string().min(1).max(100),
                url: buttonUrl,
                emoji: z.string().max(40),
                customEmojiId: emojiId,
                style: styleSchema,
              })
              .strict(),
          )
          .max(12),
      })
      .strict(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Format = Config['appearance']['notification'];
export type Override = z.infer<typeof productOverrideSchema>;
export function defaults(): Config {
  const common = {
    top: '',
    detailsTitle: '📦 变化详情',
    divider: '────────────',
    stockTitle: '当前库存 · 点击下方商品购买',
    footer: '',
    order: ['header', 'top', 'details', 'divider', 'stock', 'time', 'footer'],
    timeFormat: 'MM-DD HH:mm',
    timezone: 'Asia/Shanghai',
    bodyTemplate: '',
    changeTemplate: '{emoji} <b>{product}</b>{spec_line}\n{event}：{before} → {after}{delta_text}',
  };
  return configSchema.parse({
    version: 1,
    siteUrl: '',
    apiUrl: '',
    paused: false,
    notifications: true,
    periodicNotifications: false,
    board: true,
    autoMonitorNew: true,
    timing: Object.fromEntries(Object.entries(numericFields).map(([k, v]) => [k, v.default])),
    events: Object.fromEntries(
      eventNames.map((k) => [k, !['added', 'removed', 'price'].includes(k)]),
    ),
    targets: [],
    products: {},
    appearance: {
      notification: { ...common, header: '🛍 {site}｜库存动态' },
      board: { ...common, header: '🛍 {site}｜库存看板' },
      buttonTemplate: '{emoji} {product}｜{price}｜{stock}',
      emoji: '📦',
      customEmojiId: '',
      style: 'auto',
      filter: 'all',
      footerColumns: 2,
      links: [],
    },
  });
}
export function isEnabled(c: Config, id: string) {
  return c.products[id]?.enabled ?? c.autoMonitorNew;
}
export function showsStock(c: Config, id: string) {
  return c.products[id]?.showStock ?? true;
}
export function rules(c: Config, id: string) {
  const p = c.products[id];
  return {
    events: { ...c.events, ...p?.events },
    threshold: p?.threshold ?? c.timing.threshold,
    confirmations: p?.confirmations ?? c.timing.confirmations,
  };
}
export function parseConfig(value: unknown): Config {
  return configSchema.parse(value);
}
