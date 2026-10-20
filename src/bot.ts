import { randomUUID } from 'node:crypto';
import { Bot, Context, InputFile } from 'grammy';
import {
  buttonUrl,
  defaults,
  eventLabels,
  httpUrl,
  isEnabled,
  numericFields,
  parseConfig,
  rules,
  type Config,
} from './config.js';
import { eventNames, type Button, type Product, type BoardRecord } from './types.js';
import {
  escapeHTML,
  renderBoard,
  renderNotification,
  stockText,
  validateAppearance,
} from './render.js';
import type { StockService } from './service.js';
import { VERSION, REPOSITORY_URL } from './version.js';
import type { UpdateManager } from './updater.js';
import { normalizeTarget, targetError, TARGET_INPUT_HELP } from './targets.js';
import { orderProducts, movedProductOrder, moveDirections, type MoveDirection } from './sorting.js';

type Pending = { kind: string; args: string[]; back: string; expires: number };
type Draft = {
  appearance?: Config['appearance'];
  products: Record<string, Record<string, unknown>>;
};
type Filters = { search: string; category: string };
const visualKeys = [
  'name',
  'emoji',
  'customEmojiId',
  'style',
  'order',
  'url',
  'expandSkus',
] as const;
const visualLabels = {
  name: '显示名称',
  emoji: '普通表情',
  customEmojiId: '自定义表情',
  style: '按钮颜色',
  order: '排序数字',
  url: '购买链接',
  expandSkus: '规格展示',
};
const styles = ['auto', 'default', 'success', 'danger', 'primary'] as const;
const styleNames = {
  auto: '按库存自动',
  default: '默认色',
  success: '绿色',
  danger: '红色',
  primary: '蓝色',
};
const formatFields = {
  header: '标题',
  top: '顶部说明',
  detailsTitle: '变化栏目名',
  changeTemplate: '变化明细模板',
  divider: '分隔线',
  stockTitle: '库存栏目名',
  footer: '底部文字',
  order: '栏目顺序',
  timeFormat: '时间格式',
  timezone: '时区',
  bodyTemplate: '高级整段模板',
};
const onoff = (value: boolean) => (value ? '✅' : '▫️');
const cb = (text: string, data: string): Button => ({ text, callback_data: data });
const homeRow = [cb('🏠 主菜单', 'home')];
export function canManage(
  userId: number | undefined,
  chatType: string | undefined,
  adminId: string,
) {
  return String(userId) === adminId && chatType === 'private';
}
export class AdminBot {
  constructor(
    readonly bot: Bot,
    readonly service: StockService,
    readonly updates?: UpdateManager,
  ) {
    this.register();
  }
  private get store() {
    return this.service.store;
  }
  private config() {
    return this.store.config();
  }
  private draft(): Draft {
    return this.store.get('draft', { products: {} });
  }
  private edited(): Config {
    const c = this.config(),
      draft = this.draft();
    if (draft.appearance) c.appearance = draft.appearance;
    for (const [id, patch] of Object.entries(draft.products)) {
      const entry: Record<string, unknown> = { ...c.products[id] };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete entry[k];
        else entry[k] = v;
      }
      c.products[id] = entry;
    }
    return parseConfig(c);
  }
  private editAppearance(fn: (appearance: Config['appearance']) => void) {
    const draft = this.draft();
    draft.appearance ??= structuredClone(this.config().appearance);
    fn(draft.appearance);
    this.store.set('draft', draft);
  }
  private patchVisual(id: string, key: string, value: unknown) {
    const d = this.draft();
    d.products[id] ??= {};
    d.products[id]![key] = value;
    this.store.set('draft', d);
  }
  private save(c: Config) {
    this.service.configure(c);
  }
  private setPending(kind: string, args: string[], back: string) {
    this.store.set('pending', {
      kind,
      args,
      back,
      expires: Date.now() + 1800000,
    } satisfies Pending);
  }
  private async show(ctx: Context, text: string, rows: Button[][]) {
    const opts = {
      parse_mode: 'HTML' as const,
      reply_markup: { inline_keyboard: rows },
      link_preview_options: { is_disabled: true as const },
    };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, opts);
        return;
      } catch (e) {
        if (String(e).includes('message is not modified')) return;
      }
    }
    await ctx.reply(text, opts);
  }
  private async prompt(ctx: Context, kind: string, args: string[], back: string, text: string) {
    this.setPending(kind, args, back);
    await this.show(ctx, `${text}\n\n发送 /cancel 取消。输入将在 30 分钟后过期。`, [
      [cb('取消', `cancel:${back}`)],
    ]);
  }
  private async targetInput(ctx: Context) {
    this.setPending('target', [], 'targets');
    await ctx.reply(`${TARGET_INPUT_HELP}\n\n发送 /cancel 取消，输入将在 30 分钟后过期。`, {
      reply_markup: { remove_keyboard: true },
    });
  }
  private previewData(c: Config) {
    const rt = this.service.runtime();
    const products = this.service.products();
    const sample: Product = {
      id: '1',
      slug: 'demo',
      name: '示例商品',
      categoryId: '1',
      categoryName: '示例',
      price: '20.00',
      priceFrom: false,
      stock: { kind: 'exact', quantity: 8, status: 'in' },
      skus: [],
    };
    const preview = structuredClone(c);
    if (!preview.siteUrl) preview.siteUrl = 'https://example.com';
    const list = products.length ? products : [sample];
    if (!products.length) preview.products['1'] = { enabled: true };
    const selected = list.find((p) => isEnabled(preview, p.id)) ?? list[0]!;
    return {
      c: preview,
      products: list,
      site: rt.siteName,
      currency: rt.currency,
      at: Date.now(),
      events: [
        {
          productId: selected.id,
          productName: selected.name,
          type: 'restock' as const,
          before: { kind: 'exact' as const, quantity: 0, status: 'out' as const },
          after: selected.stock,
          at: Date.now(),
        },
      ],
    };
  }
  private validateDraft(c: Config) {
    validateAppearance(c);
    const p = this.previewData(c);
    renderBoard(p.c, p.products, p.site, p.currency, p.at, 0);
    renderNotification(p.c, p.products, p.events, p.site, p.currency, p.at);
  }
  private async menu(ctx: Context, path = 'home') {
    const [name, a] = path.split(':'),
      c = this.config(),
      rt = this.service.runtime();
    if (name === 'home') {
      const draft = !!this.store.get('draft', null);
      return this.show(
        ctx,
        `<b>🦄 独角数卡库存通知 · v${VERSION}</b>\n${c.siteUrl ? escapeHTML(c.siteUrl) : '① 先连接网站 → ② 添加通知目标 → ③ 预览并开启'}\n${c.paused ? '⏸ 已暂停' : '▶ 监测开启'} · ${rt.productCount} 个商品\n${draft ? '📝 有未保存的样式草稿' : ''}`,
        [
          [cb('🌐 网站连接', 'site'), cb('📣 通知目标', 'targets')],
          [cb('📦 商品管理', 'products:0'), cb('⏱ 监测速度', 'timing')],
          [cb('🔔 通知规则', 'rules'), cb('📝 消息排版', 'templates')],
          [cb('🎨 按钮样式', 'buttons'), cb('📊 库存看板', 'boards')],
          [cb('🛠 运行状态', 'status'), cb('💾 备份与恢复', 'backup')],
          [cb('⚙️ 设置／版本更新', 'settings')],
          [cb(c.paused ? '▶ 恢复监测' : '⏸ 暂停监测', 'toggle:paused'), cb('🔎 立即检查', 'check')],
          ...(draft
            ? [[cb('👁 预览草稿', 'preview:notification'), cb('💾 保存草稿', 'draft:save')]]
            : []),
        ],
      );
    }
    if (name === 'settings') {
      const result = this.updates?.status();
      return this.show(
        ctx,
        `<b>⚙️ 设置与版本</b>\n当前版本：<b>v${VERSION}</b>\n更新来源：${REPOSITORY_URL}\n${this.updates?.supported ? '支持在 Telegram 一键更新应用。' : '当前启动方式不支持应用切换，请用新版 Docker 镜像或 npm start 启动。'}\n${result ? `上次更新：${escapeHTML(result.message)}` : ''}`,
        [
          [cb('🔎 检查更新', 'update:check')],
          [cb('⏱ 监测速度', 'timing'), cb('🔔 通知规则', 'rules')],
          [cb('💾 备份与恢复', 'backup')],
          homeRow,
        ],
      );
    }
    if (name === 'site')
      return this.show(
        ctx,
        `<b>🌐 网站连接</b>\n店铺：${escapeHTML(c.siteUrl || '未设置')}\nAPI：${escapeHTML(c.apiUrl || '自动使用店铺 /api/v1')}\n公开接口读取，网站无需放文件。\n更换网址会重新建立库存基线并清除旧商品设置；旧频道消息不会删除。`,
        [
          [cb('设置／更换店铺网址', 'input:site')],
          [cb('设置独立 API 基址', 'input:api')],
          [cb('🔎 测试现有连接', 'check')],
          homeRow,
        ],
      );
    if (name === 'timing')
      return this.show(
        ctx,
        `<b>⏱ 监测速度与稳定性</b>\n当前 ${rt.pages} 页，商品请求约 ${rt.pages ? Math.ceil((rt.pages * 60) / c.timing.interval) : 0} 次/分钟，另每 5 分钟读取配置和分类。\n通知延迟还包括请求耗时、${c.timing.confirmations} 次确认和 ${c.timing.mergeWindow} 秒合并。\n同一轮不会重叠；低间隔增加网站负载。`,
        [
          ...Object.entries(numericFields).map(([k, v]) => [
            cb(`${v.label}：${c.timing[k as keyof typeof numericFields]}`, `number:${k}`),
          ]),
          [cb('恢复速度默认值', 'confirm:timing-reset')],
          homeRow,
        ],
      );
    if (name === 'rules')
      return this.show(ctx, '<b>🔔 通知规则</b>\n状态事件不受数量门槛影响。修改立即生效。', [
        [
          cb(`${onoff(c.notifications)} 变化通知`, 'toggle:notifications'),
          cb(`${onoff(c.board)} 库存看板`, 'toggle:board'),
        ],
        [cb(`${onoff(c.autoMonitorNew)} 自动监测新商品`, 'toggle:autoMonitorNew')],
        ...eventNames.map((k) => [cb(`${onoff(c.events[k])} ${eventLabels[k]}`, `event:${k}`)]),
        homeRow,
      ]);
    if (name === 'products') {
      const filters = this.store.get<Filters>('filters', { search: '', category: '' });
      const edited = this.edited();
      const all = orderProducts(this.service.products(), edited);
      const list = all.filter(
        (p) =>
          (!filters.search ||
            `${edited.products[p.id]?.name || p.name} ${p.name} ${p.id}`
              .toLowerCase()
              .includes(filters.search.toLowerCase())) &&
          (!filters.category || p.categoryId === filters.category),
      );
      const page = Math.min(
        Math.max(Number(a) || 0, 0),
        Math.max(0, Math.ceil(list.length / 8) - 1),
      );
      const rows = list
        .slice(page * 8, page * 8 + 8)
        .map((p) => [
          cb(
            `${onoff(isEnabled(c, p.id))} ${(edited.products[p.id]?.name || p.name).slice(0, 32)} · ${stockText(p.stock)}`,
            `product:${p.id}`,
          ),
        ]);
      rows.push([
        cb('🔎 搜索', 'input:search'),
        cb('🗂 分类', 'categories'),
        cb('清除筛选', 'filter:clear'),
      ]);
      rows.push([cb('启用筛选结果', 'bulk:on'), cb('暂停筛选结果', 'bulk:off')]);
      rows.push([cb('↕️ 调整商品顺序', 'sort:0'), cb('💾 保存草稿', 'draft:save')]);
      rows.push(
        [
          cb('◀', `products:${Math.max(0, page - 1)}`),
          cb(`${page + 1}/${Math.max(1, Math.ceil(list.length / 8))}`, 'noop'),
          cb('▶', `products:${Math.min(Math.max(0, Math.ceil(list.length / 8) - 1), page + 1)}`),
        ],
        homeRow,
      );
      return this.show(
        ctx,
        `<b>📦 商品管理</b>\n共 ${list.length} 件；搜索：${escapeHTML(filters.search || '全部')}\n列表按当前排序草稿显示；排序与外观修改保存后同步通知和看板。启停立即生效。`,
        rows,
      );
    }
    if (name === 'sort') {
      const edited = this.edited(),
        list = orderProducts(this.service.products(), edited);
      const pages = Math.max(1, Math.ceil(list.length / 8)),
        page = Math.min(pages - 1, Math.max(0, Math.trunc(Number(a) || 0)));
      return this.show(
        ctx,
        '<b>↕️ 商品排序</b>\n这是全店顺序，包含暂停监测的商品。点选商品后可上移、下移、置顶或置底，也可填写排序值（小的在前）。\n修改先进入草稿，保存后同步通知购买按钮和库存看板。',
        [
          ...list
            .slice(page * 8, page * 8 + 8)
            .map((p, i) => [
              cb(
                `${page * 8 + i + 1}. ${(edited.products[p.id]?.name || p.name).slice(0, 32)}`,
                `product:${p.id}`,
              ),
            ]),
          [
            cb('◀', `sort:${Math.max(0, page - 1)}`),
            cb(`${page + 1}/${pages}`, 'noop'),
            cb('▶', `sort:${Math.min(pages - 1, page + 1)}`),
          ],
          [cb('💾 保存排序草稿', 'draft:save'), cb('丢弃草稿', 'draft:discard')],
          [cb('返回商品', 'products:0')],
        ],
      );
    }
    if (name === 'categories') {
      const cats = [
        ...new Map(
          this.service.products().map((p) => [p.categoryId, p.categoryName || p.categoryId]),
        ).entries(),
      ];
      const page = Math.max(0, Number(a) || 0);
      return this.show(ctx, '选择分类', [
        [cb('全部分类', 'category:all')],
        ...cats
          .slice(page * 20, page * 20 + 20)
          .map(([id, label]) => [cb(label, `category:${id}`)]),
        [
          cb('◀', `categories:${Math.max(0, page - 1)}`),
          cb('▶', `categories:${Math.min(Math.max(0, Math.ceil(cats.length / 20) - 1), page + 1)}`),
        ],
        [cb('返回商品', 'products:0')],
      ]);
    }
    if (name === 'product') {
      const p = this.service.products().find((x) => x.id === a);
      if (!p) return this.show(ctx, '商品暂不可见。', [[cb('返回', 'products:0')]]);
      const e = this.edited().products[p.id] ?? {};
      const sortIndex = orderProducts(this.service.products(), this.edited()).findIndex(
        (item) => item.id === p.id,
      );
      return this.show(
        ctx,
        `<b>${escapeHTML(e.name || p.name)}</b>\nID：${p.id} · ${escapeHTML(stockText(p.stock))}\n${escapeHTML(p.categoryName)}\n图标：${escapeHTML(e.emoji ?? c.appearance.emoji)}；自定义 ID：${escapeHTML(e.customEmojiId ?? '继承')}\n颜色：${styleNames[e.style ?? c.appearance.style]}；排序值：${e.order ?? 0}\n全店位置：第 ${sortIndex + 1} 位（草稿）；保存后生效。`,
        [
          [cb(`${onoff(isEnabled(c, p.id))} 监测此商品`, `product-toggle:${p.id}`)],
          [cb('显示名称', `pinput:${p.id}:name`), cb('普通表情', `pinput:${p.id}:emoji`)],
          [cb('自定义表情／ID', `pinput:${p.id}:customEmojiId`), cb('按钮颜色', `pstyle:${p.id}`)],
          [cb('排序数字', `pinput:${p.id}:order`), cb('购买链接', `pinput:${p.id}:url`)],
          [cb('⬆️ 上移', `pmove:${p.id}:up`), cb('⬇️ 下移', `pmove:${p.id}:down`)],
          [cb('⏫ 置顶', `pmove:${p.id}:top`), cb('⏬ 置底', `pmove:${p.id}:bottom`)],
          [cb(`${onoff(e.expandSkus ?? false)} 展开规格按钮`, `expand:${p.id}`)],
          [cb('独立通知规则', `prules:${p.id}`), cb('恢复外观继承', `pinherit:${p.id}`)],
          [cb('👁 预览', 'preview:notification'), cb('💾 保存草稿', 'draft:save')],
          [
            cb('返回商品', 'products:0'),
            cb('查看排序列表', `sort:${Math.floor(Math.max(0, sortIndex) / 8)}`),
          ],
        ],
      );
    }
    if (name === 'prules') {
      if (!a || !this.service.products().some((p) => p.id === a)) throw new Error('商品不存在');
      const p = c.products[a] ?? {},
        r = rules(c, a);
      return this.show(
        ctx,
        `<b>商品 ${a} 独立规则</b>\n事件点击循环：继承 → 开启 → 关闭 → 继承。\n数量门槛 ${r.threshold}；确认 ${r.confirmations} 次。`,
        [
          ...eventNames.map((k) => [
            cb(
              `${p.events?.[k] === undefined ? '↪ 继承' : onoff(p.events[k]!)} ${eventLabels[k]}`,
              `pevent:${a}:${k}`,
            ),
          ]),
          [
            cb('数量门槛', `prnumber:${a}:threshold`),
            cb('确认次数', `prnumber:${a}:confirmations`),
          ],
          [cb('全部恢复全局规则', `prreset:${a}`)],
          [cb('返回商品', `product:${a}`)],
        ],
      );
    }
    if (name === 'templates')
      return this.show(
        ctx,
        '<b>📝 消息排版</b>\n所有编辑先进入草稿，预览后保存。\n支持 Telegram HTML，普通 &amp; 字符在模板中写为 &amp;amp;。',
        [
          [cb('变化通知模板', 'format:notification'), cb('库存看板模板', 'format:board')],
          [cb('模板变量说明', 'variables')],
          [cb('👁 预览通知', 'preview:notification'), cb('👁 预览看板', 'preview:board')],
          [cb('💾 保存草稿', 'draft:save'), cb('丢弃草稿', 'draft:discard')],
          homeRow,
        ],
      );
    if (name === 'format') {
      const kind = a === 'board' ? 'board' : 'notification',
        f = this.edited().appearance[kind];
      return this.show(
        ctx,
        `<b>${kind === 'board' ? '库存看板' : '变化通知'}排版</b>\n顺序：${f.order.join(' → ')}\n${f.bodyTemplate ? '高级整段模板正在覆盖栏目顺序。' : '使用菜单栏目拼装。'}`,
        Object.entries(formatFields)
          .map(([k, label]) => [
            cb(
              `${label}：${String(f[k as keyof typeof f]).slice(0, 24) || '空'}`,
              `finput:${kind}:${k}`,
            ),
          ])
          .concat([
            [cb('恢复此模板默认值', `format-reset:${kind}`)],
            [cb('👁 预览', `preview:${kind}`), cb('💾 保存草稿', 'draft:save')],
            [cb('返回', 'templates')],
          ]),
      );
    }
    if (name === 'variables')
      return this.show(
        ctx,
        `<b>模板变量</b>\n栏目文字：{site} {time} {page} {pages}\n变化明细：{product} {spec} {spec_line} {price} {stock} {before} {after} {delta} {delta_text} {event} {url} {emoji}\n高级整段：{header} {top} {details_title} {details} {divider} {stock_title} {time} {footer} {site} {page} {pages}\n按钮：{emoji} {product} {spec} {price} {stock}\n\n输入 - 清空可选文字或高级模板。栏目順序使用 header,top,details,divider,stock,time,footer，允许删去栏目。`,
        [[cb('返回', 'templates')]],
      );
    if (name === 'buttons') {
      const ap = this.edited().appearance;
      return this.show(
        ctx,
        `<b>🎨 全局按钮样式</b>\n格式：${escapeHTML(ap.buttonTemplate)}\n默认表情：${escapeHTML(ap.emoji)}；ID：${escapeHTML(ap.customEmojiId || '无')}\n颜色：${styleNames[ap.style]}\n展示：${{ all: '全部监测商品', available: '仅有货', changed: '本次变化商品（看板仍显示全部）' }[ap.filter]}`,
        [
          [cb('按钮文字模板', 'ainput:buttonTemplate')],
          [cb('普通表情', 'ainput:emoji'), cb('自定义表情／ID', 'ainput:customEmojiId')],
          [cb('切换颜色', 'astyle'), cb('切换展示范围', 'afilter')],
          [cb('底部链接按钮', 'links')],
          [cb('👁 预览', 'preview:notification'), cb('💾 保存草稿', 'draft:save')],
          homeRow,
        ],
      );
    }
    if (name === 'links') {
      const ap = this.edited().appearance;
      return this.show(
        ctx,
        `<b>底部链接按钮</b>\n共 ${ap.links.length}/12 个，每行 ${ap.footerColumns} 个。`,
        [
          ...ap.links.map((l) => [cb(l.text, `link:${l.id}`)]),
          [cb('➕ 添加链接', 'link-add'), cb('切换每行数量', 'link-columns')],
          [cb('💾 保存草稿', 'draft:save'), cb('返回', 'buttons')],
        ],
      );
    }
    if (name === 'link') {
      const ap = this.edited().appearance,
        l = ap.links.find((x) => x.id === a);
      if (!l) throw new Error('链接不存在');
      return this.show(
        ctx,
        `<b>${escapeHTML(l.text)}</b>\n${escapeHTML(l.url)}\n${escapeHTML(l.emoji)} ${styleNames[l.style]}\n自定义表情 ID：${escapeHTML(l.customEmojiId || '无')}`,
        [
          [cb('文字', `linput:${a}:text`), cb('地址', `linput:${a}:url`)],
          [cb('普通表情', `linput:${a}:emoji`), cb('自定义表情', `linput:${a}:customEmojiId`)],
          [cb('切换颜色', `lstyle:${a}`)],
          [cb('上移', `lmove:${a}:-1`), cb('下移', `lmove:${a}:1`)],
          [cb('删除', `ldelete:${a}`), cb('返回', 'links')],
        ],
      );
    }
    if (name === 'targets')
      return this.show(
        ctx,
        '<b>📣 通知目标</b>\n直接输入频道／群组用户名，例如 my_shop（不用加 @）。也支持 @用户名、t.me 公开链接或数字 ID。\n先把机器人加入目标并设为管理员；频道还需允许发布消息。绑定后启用该目标，按当前监测设置推送。',
        [
          [cb('➕ 输入频道／群用户名', 'input:target')],
          [cb('➕ 管理员私聊', 'target-admin')],
          ...c.targets.map((t) => [cb(`${onoff(t.enabled)} ${t.title}`, `target:${t.id}`)]),
          homeRow,
        ],
      );
    if (name === 'target') {
      const t = c.targets.find((t) => t.id === a);
      if (!t) throw new Error('目标不存在');
      const fallback = this.store.get(`emoji-disabled:${t.id}`, false);
      return this.show(
        ctx,
        `<b>${escapeHTML(t.title)}</b>\nID：${t.id}\n${fallback ? '自定义表情已回退为普通 emoji' : '自定义表情按 Telegram 权限尝试发送'}\n测试会向此目标发送一条消息。`,
        [
          [
            cb(`${onoff(t.enabled)} 启用`, `target-toggle:${t.id}`),
            cb('检查权限', `target-rights:${t.id}`),
          ],
          [cb('发送测试通知', `target-test:${t.id}`)],
          [cb('自定义表情重新测试', `emoji-test:${t.id}`)],
          [cb('删除目标', `target-remove:${t.id}`), cb('返回', 'targets')],
        ],
      );
    }
    if (name === 'boards')
      return this.show(
        ctx,
        '<b>📊 库存看板</b>\n同一条消息持续编辑，翻页对频道所有读者生效。内容未变不重复编辑，更新时间代表展示快照。\n重建可能产生新消息，旧看板需自行清理。',
        [
          [cb(`${onoff(c.board)} 开启看板`, 'toggle:board'), cb('每页数量', 'number:pageSize')],
          ...c.targets.filter((t) => t.enabled).map((t) => [cb(t.title, `board-manage:${t.id}`)]),
          [cb('编辑看板模板', 'format:board')],
          homeRow,
        ],
      );
    if (name === 'board-manage')
      return this.show(
        ctx,
        `<b>看板 ${escapeHTML(a)}</b>\n${escapeHTML(this.store.get(`board-error:${a}`, ''))}`,
        [
          [cb('立即刷新', `board-refresh:${a}`), cb('置顶看板', `board-pin:${a}`)],
          [cb('确认重建看板', `confirm:board-reset:${a}`)],
          [cb('返回', 'boards')],
        ],
      );
    if (name === 'status') {
      const fmt = (n: number) =>
        n ? new Date(n).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚无';
      const counts = this.store.jobCounts() as { status: string; count: number }[];
      return this.show(
        ctx,
        `<b>🛠 运行状态</b>\n最近成功：${fmt(rt.lastSuccess)}\n最近尝试：${fmt(rt.lastAttempt)}\n商品：${rt.productCount}；分页：${rt.pages}\n连续失败：${rt.failures}\n最近错误：${escapeHTML(rt.lastError || '无')}\n服务错误：${escapeHTML(this.store.get('service-error', '无'))}\n队列：${counts.map((x) => `${x.status} ${x.count}`).join('，') || '空'}\n结果不确定的消息不会自动重发。`,
        [
          [cb('🔎 立即检查', 'check'), cb('失败／不确定详情', 'failures')],
          [cb('确认重试失败消息', 'confirm:retry')],
          homeRow,
        ],
      );
    }
    if (name === 'failures') {
      const list = [
        ...this.store.jobs('failed', Number.MAX_SAFE_INTEGER),
        ...this.store.jobs('uncertain', Number.MAX_SAFE_INTEGER),
      ].slice(0, 8);
      return this.show(
        ctx,
        '<b>发送异常（最近最多 8 项）</b>\n' +
          (list.map((j) => `#${j.id} → ${j.target}\n${escapeHTML(j.lastError)}`).join('\n\n') ||
            '无'),
        [[cb('丢弃这些失败／不确定消息', 'confirm:discard-failed')], [cb('返回', 'status')]],
      );
    }
    if (name === 'backup')
      return this.show(
        ctx,
        '<b>💾 配置备份</b>\n导出包含网站、目标和自定义配置，不包含 Bot Token、管理员 ID 或运行快照。\n导入会先校验并显示摘要，确认后应用。\n完整灾备请备份 Docker 数据卷。',
        [
          [cb('📤 导出配置', 'export'), cb('📥 导入 JSON', 'input:import')],
          [cb('恢复全部默认配置', 'confirm:reset')],
          homeRow,
        ],
      );
    throw new Error('菜单已过期，请发送 /start');
  }
  private async bind(ctx: Context, input: string) {
    try {
      const chat = await this.bot.api.getChat(normalizeTarget(input));
      if (chat.type === 'private' && String(chat.id) !== this.service.adminId)
        throw new Error('该目标是个人账号，只允许绑定管理员自己的私聊；请填写频道或群组用户名。');
      if (chat.type !== 'private') await this.rights(String(chat.id));
      const c = this.config();
      const title = ('title' in chat ? chat.title : chat.first_name) || String(chat.id);
      const target = c.targets.find((t) => t.id === String(chat.id));
      if (target) {
        target.title = title;
        target.enabled = true;
      } else c.targets.push({ id: String(chat.id), title, enabled: true });
      this.save(c);
      const note = !c.siteUrl
        ? '请先在“网站连接”中接入店铺。'
        : c.paused
          ? '当前全局监测已暂停，请在主菜单恢复监测。'
          : !c.notifications && !c.board
            ? '当前通知和看板均已关闭，请在通知规则中开启。'
            : `后续${c.notifications ? '库存变化会推送到此目标' : ''}${c.notifications && c.board ? '，' : ''}${c.board ? '库存看板会自动创建或更新' : ''}。`;
      await ctx.reply(`已绑定并启用：${title}\n目标 ID：${chat.id}\n${note}`, {
        reply_markup: { remove_keyboard: true },
      });
    } catch (e) {
      throw targetError(e);
    }
  }
  private async rights(id: string) {
    if (id === this.service.adminId) return;
    try {
      const chat = await this.bot.api.getChat(id),
        member = await this.bot.api.getChatMember(id, this.bot.botInfo.id);
      if (member.status === 'left' || member.status === 'kicked')
        throw new Error('机器人尚未加入此目标，请先加入并设为管理员。');
      if (member.status !== 'administrator' && member.status !== 'creator')
        throw new Error('请先将机器人设为该频道／群的管理员，再重新绑定。');
      if (chat.type === 'channel' && member.status === 'administrator' && !member.can_post_messages)
        throw new Error(
          '机器人已是频道管理员，但未允许发布消息。请在频道管理员权限中开启“发布消息”。',
        );
    } catch (e) {
      throw targetError(e);
    }
  }
  private async onCallback(ctx: Context, data: string) {
    const parts = data.split(':'),
      [action, a, b] = parts;
    const c = this.config();
    if (action === 'update') {
      if (!this.updates) throw new Error('更新服务未启用，请使用新版 Docker 镜像或 npm start');
      if (a === 'check') {
        const update = await this.updates.check();
        if (!update)
          return this.show(ctx, `当前 v${VERSION}，暂未发现更高版本的正式发行版。`, [
            [cb('返回设置', 'settings')],
          ]);
        return this.show(
          ctx,
          `<b>发现 v${update.version}</b>\n${escapeHTML(update.notes)}\n\n点击更新后会校验更新包、备份数据库并短暂停止 Bot，新版启动失败会自动恢复。`,
          [
            ...(this.updates.supported
              ? [[cb(`⬆️ 一键更新至 v${update.version}`, `update:install:${update.version}`)]]
              : []),
            [{ text: '查看发行说明', url: update.url }],
            [cb('返回设置', 'settings')],
          ],
        );
      }
      if (a === 'install' && b) {
        if (!this.updates.supported)
          throw new Error('请用新版 Docker 镜像或 npm start 启动以启用一键更新');
        await ctx.reply(`正在下载并校验 v${b}，当前版本继续运行…`);
        const release = await this.updates.prepare(b);
        await ctx.reply('更新包已校验。开始备份并切换版本，Bot 将短暂重启，完成或回退后会通知你。');
        this.updates.requestInstall(release);
        return;
      }
      throw new Error('更新操作已过期，请重新检查');
    }
    if (action === 'noop') return;
    if (action === 'cancel') {
      this.store.delete('pending');
      return this.menu(ctx, parts.slice(1).join(':'));
    }
    if (action === 'check') {
      await ctx.reply('正在读取网站接口…');
      const result = await this.service.check(true);
      await ctx.reply(result);
      return this.menu(ctx, 'status');
    }
    if (action === 'toggle') {
      if (!['paused', 'notifications', 'board', 'autoMonitorNew'].includes(a!))
        throw new Error('无效设置');
      const key = a as 'paused' | 'notifications' | 'board' | 'autoMonitorNew';
      c[key] = !c[key];
      this.save(c);
      return this.menu(ctx, key === 'paused' ? 'home' : 'rules');
    }
    if (action === 'number') {
      const key = a as keyof typeof numericFields,
        v = numericFields[key];
      if (!v) throw new Error('无效设置');
      return this.prompt(
        ctx,
        'number',
        [key],
        'timing',
        `输入${v.label}：${v.min}～${v.max}\n当前 ${c.timing[key]}，默认 ${v.default}。输入 default 恢复此项。`,
      );
    }
    if (action === 'event') {
      if (!eventNames.includes(a as (typeof eventNames)[number])) throw new Error('无效事件');
      c.events[a as (typeof eventNames)[number]] = !c.events[a as (typeof eventNames)[number]];
      this.save(c);
      return this.menu(ctx, 'rules');
    }
    if (action === 'input') {
      if (a === 'target') return this.targetInput(ctx);
      const prompts: Record<string, string> = {
        site: '发送店铺完整网址，如 https://shop.example.com。更换网站会重建基线。',
        api: '发送完整 API 基址，如 https://api.example.com/api/v1。输入 - 恢复同源 API。',
        search: '发送商品名称或 ID 关键词。',
        import: '发送配置 JSON 文件（最大 1MB），或粘贴完整 JSON。',
      };
      if (!prompts[a!]) throw new Error('无效输入');
      return this.prompt(
        ctx,
        a!,
        [],
        a === 'site' || a === 'api'
          ? 'site'
          : a === 'search'
            ? 'products:0'
            : a === 'target'
              ? 'targets'
              : 'backup',
        prompts[a!]!,
      );
    }
    if (action === 'filter') {
      this.store.set('filters', { search: '', category: '' });
      return this.menu(ctx, 'products:0');
    }
    if (action === 'category') {
      const f = this.store.get<Filters>('filters', { search: '', category: '' });
      f.category = a === 'all' ? '' : a!;
      this.store.set('filters', f);
      return this.menu(ctx, 'products:0');
    }
    if (action === 'bulk') {
      const f = this.store.get<Filters>('filters', { search: '', category: '' });
      const edited = this.edited();
      for (const p of this.service.products())
        if (
          (!f.search ||
            `${edited.products[p.id]?.name || p.name} ${p.name} ${p.id}`
              .toLowerCase()
              .includes(f.search.toLowerCase())) &&
          (!f.category || p.categoryId === f.category)
        )
          c.products[p.id] = { ...c.products[p.id], enabled: a === 'on' };
      this.save(c);
      return this.menu(ctx, 'products:0');
    }
    if (action === 'product-toggle') {
      if (!a || !c.products[a]) throw new Error('商品不存在');
      c.products[a]!.enabled = !isEnabled(c, a);
      this.save(c);
      return this.menu(ctx, `product:${a}`);
    }
    if (action === 'pinput') {
      if (!visualKeys.includes(b as (typeof visualKeys)[number])) throw new Error('无效外观设置');
      return this.prompt(
        ctx,
        'product',
        [a!, b!],
        `product:${a}`,
        b === 'order'
          ? '输入排序值（-100000～100000 的整数），数字越小越靠前；同值按原商品名称排序。\n输入 inherit 恢复默认。修改先进入草稿，保存后生效。'
          : `设置${visualLabels[b as (typeof visualKeys)[number]]}。自定义表情可以直接发送表情或数字 ID。\n输入 inherit 恢复继承；输入 - 清空表情或名称。`,
      );
    }
    if (action === 'pmove') {
      if (!moveDirections.includes(b as MoveDirection) || !a) throw new Error('无效的排序操作。');
      const order = movedProductOrder(
        this.service.products(),
        this.edited(),
        a,
        b as MoveDirection,
      );
      if (order) {
        const draft = this.draft();
        order.forEach((id, index) => {
          draft.products[id] ??= {};
          draft.products[id]!.order = index;
        });
        this.store.set('draft', draft);
      }
      return this.menu(ctx, `product:${a}`);
    }
    if (action === 'pstyle') {
      const current = this.edited().products[a!]?.style ?? 'auto';
      this.patchVisual(a!, 'style', styles[(styles.indexOf(current) + 1) % styles.length]);
      return this.menu(ctx, `product:${a}`);
    }
    if (action === 'expand') {
      this.patchVisual(a!, 'expandSkus', !this.edited().products[a!]?.expandSkus);
      return this.menu(ctx, `product:${a}`);
    }
    if (action === 'pinherit') {
      for (const key of visualKeys) this.patchVisual(a!, key, null);
      return this.menu(ctx, `product:${a}`);
    }
    if (action === 'pevent') {
      const key = b as (typeof eventNames)[number];
      if (!eventNames.includes(key) || !c.products[a!]) throw new Error('无效事件');
      const p = c.products[a!]!;
      p.events ??= {};
      const val = p.events[key];
      if (val === undefined) p.events[key] = true;
      else if (val) p.events[key] = false;
      else delete p.events[key];
      this.save(c);
      return this.menu(ctx, `prules:${a}`);
    }
    if (action === 'prnumber')
      return this.prompt(
        ctx,
        'prnumber',
        [a!, b!],
        `prules:${a}`,
        `发送 ${b === 'threshold' ? '数量门槛（正整数）' : '确认次数（1～5）'}，输入 inherit 恢复全局。`,
      );
    if (action === 'prreset') {
      const p = c.products[a!];
      if (p) {
        delete p.events;
        delete p.threshold;
        delete p.confirmations;
      }
      this.save(c);
      return this.menu(ctx, `prules:${a}`);
    }
    if (action === 'finput') {
      const key = b as keyof typeof formatFields;
      if (!formatFields[key]) throw new Error('无效模板字段');
      const f = this.edited().appearance[a === 'board' ? 'board' : 'notification'];
      let hint = '允许 Telegram HTML。输入 - 清空。';
      if (key === 'order')
        hint = '用逗号分隔：header,top,details,divider,stock,time,footer，可删去栏目。';
      if (key === 'timeFormat') hint = '可选：MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss 或 HH:mm:ss';
      if (key === 'timezone') hint = '输入 IANA 时区，如 Asia/Shanghai。';
      return this.prompt(
        ctx,
        'format',
        [a!, key],
        `format:${a}`,
        `编辑${formatFields[key]}\n当前：<code>${escapeHTML(String(f[key]))}</code>\n${hint}\n可从“模板变量说明”查看可用变量。`,
      );
    }
    if (action === 'format-reset') {
      this.editAppearance((ap) => {
        ap[a === 'board' ? 'board' : 'notification'] =
          defaults().appearance[a === 'board' ? 'board' : 'notification'];
      });
      return this.menu(ctx, `format:${a}`);
    }
    if (action === 'ainput')
      return this.prompt(
        ctx,
        'appearance',
        [a!],
        'buttons',
        a === 'buttonTemplate'
          ? '发送按钮模板，可用 {emoji} {product} {spec} {price} {stock}。按钮为纯文字。'
          : '发送普通表情、自定义表情或数字 ID；输入 - 清空。',
      );
    if (action === 'astyle') {
      this.editAppearance((ap) => {
        ap.style = styles[(styles.indexOf(ap.style) + 1) % styles.length]!;
      });
      return this.menu(ctx, 'buttons');
    }
    if (action === 'afilter') {
      this.editAppearance((ap) => {
        const choices = ['all', 'available', 'changed'] as const;
        ap.filter = choices[(choices.indexOf(ap.filter) + 1) % 3]!;
      });
      return this.menu(ctx, 'buttons');
    }
    if (action === 'link-add')
      return this.prompt(
        ctx,
        'link-add',
        [],
        'links',
        '第一行按钮文字，第二行链接。例如：\n店铺首页\nhttps://shop.example.com',
      );
    if (action === 'link-columns') {
      this.editAppearance((ap) => {
        ap.footerColumns = ap.footerColumns === 1 ? 2 : 1;
      });
      return this.menu(ctx, 'links');
    }
    if (action === 'linput')
      return this.prompt(
        ctx,
        'link',
        [a!, b!],
        `link:${a}`,
        '发送新值。自定义表情可直接发送表情或数字 ID；输入 - 清空图标。',
      );
    if (action === 'lstyle') {
      this.editAppearance((ap) => {
        const l = ap.links.find((x) => x.id === a);
        if (l) l.style = styles[(styles.indexOf(l.style) + 1) % styles.length]!;
      });
      return this.menu(ctx, `link:${a}`);
    }
    if (action === 'lmove') {
      this.editAppearance((ap) => {
        const index = ap.links.findIndex((x) => x.id === a),
          next = Math.min(Math.max(index + Number(b), 0), ap.links.length - 1);
        if (index >= 0) {
          const [l] = ap.links.splice(index, 1);
          ap.links.splice(next, 0, l!);
        }
      });
      return this.menu(ctx, `link:${a}`);
    }
    if (action === 'ldelete') {
      this.editAppearance((ap) => {
        ap.links = ap.links.filter((l) => l.id !== a);
      });
      return this.menu(ctx, 'links');
    }
    if (action === 'draft') {
      if (a === 'save') {
        const edited = this.edited();
        this.validateDraft(edited);
        this.save(edited);
        this.store.delete('draft');
        await ctx.reply('样式已保存。新通知将使用新样式，看板将在更新周期内刷新。');
      } else this.store.delete('draft');
      return this.menu(ctx, 'home');
    }
    if (action === 'preview') {
      const edited = this.edited();
      this.validateDraft(edited);
      const p = this.previewData(edited);
      const messages =
        a === 'board'
          ? [renderBoard(p.c, p.products, p.site, p.currency, p.at, 0).payload]
          : renderNotification(p.c, p.products, p.events, p.site, p.currency, p.at);
      await ctx.reply('以下为草稿预览，变化数据为演示，不会发往频道：');
      for (const message of messages.slice(0, 3))
        await this.service.transport.send(this.service.adminId, message);
      if (messages.length > 3)
        await ctx.reply(`完整内容共 ${messages.length} 条，预览展示前 3 条。`);
      return this.show(ctx, '预览完成。', [
        [cb('💾 保存草稿', 'draft:save'), cb('继续编辑', 'templates')],
      ]);
    }
    if (action === 'target-picker') {
      // Old inline menus remain clickable after an application upgrade.
      return this.targetInput(ctx);
    }
    if (action === 'target-admin') {
      await this.bind(ctx, this.service.adminId);
      return this.menu(ctx, 'targets');
    }
    if (action === 'target-toggle') {
      const t = c.targets.find((t) => t.id === a);
      if (t) {
        if (!t.enabled) await this.rights(t.id);
        t.enabled = !t.enabled;
      }
      this.save(c);
      if (t && !t.enabled) this.store.cancelTarget(t.id);
      return this.menu(ctx, `target:${a}`);
    }
    if (action === 'target-remove') {
      c.targets = c.targets.filter((t) => t.id !== a);
      this.save(c);
      this.store.cancelTarget(a!);
      return this.menu(ctx, 'targets');
    }
    if (action === 'target-rights') {
      await this.rights(a!);
      await ctx.reply('目标权限检查通过。');
      return this.menu(ctx, `target:${a}`);
    }
    if (action === 'target-test' || action === 'emoji-test') {
      if (!c.targets.some((t) => t.id === a)) throw new Error('目标不存在');
      await this.rights(a!);
      if (action === 'emoji-test') this.store.delete(`emoji-disabled:${a}`);
      const p = this.previewData(this.edited());
      const message = renderNotification(p.c, p.products, p.events, p.site, p.currency, p.at)[0]!;
      await this.service.transport.send(a!, {
        ...message,
        text: '<b>🧪 管理员测试消息</b>\n\n' + message.text,
      });
      await ctx.reply('测试消息已发送，请在目标中查看效果。');
      return this.menu(ctx, `target:${a}`);
    }
    if (action === 'board-refresh') {
      await ctx.reply(await this.service.board(a!, undefined, true));
      return this.menu(ctx, `board-manage:${a}`);
    }
    if (action === 'board-pin') {
      const record = this.store.get<Record<string, BoardRecord>>('boards', {})[a!];
      if (!record) throw new Error('请先创建看板');
      await this.bot.api.pinChatMessage(a!, record.messageId, { disable_notification: true });
      await ctx.reply('看板已置顶。');
      return;
    }
    if (action === 'export') {
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(JSON.stringify(c, null, 2)), 'dujiao-config.json'),
        { caption: '配置备份，不含 Bot Token。' },
      );
      return;
    }
    if (action === 'confirm') {
      const labels: Record<string, string> = {
        'timing-reset': '恢复全部速度设置默认值？',
        retry: '重试全部失败／结果不确定的消息？结果不确定的消息可能已经送达，重试可能重复。',
        'discard-failed': '丢弃全部失败／不确定消息？它们之后不会重试。',
        reset:
          '恢复全部默认配置？将暂停监测并清除网站、目标、自定义配置和运行基线。已发送消息不会删除。',
        'board-reset': '重新创建看板？旧消息不会删除，如果上次创建已成功，可能出现两条看板。',
        import: '应用已校验的配置？将重建库存基线，旧的待发通知会取消。',
      };
      if (!labels[a!]) throw new Error('无效操作');
      return this.show(ctx, labels[a!]!, [
        [cb('确认', `do:${parts.slice(1).join(':')}`), cb('取消', 'home')],
      ]);
    }
    if (action === 'do') {
      if (a === 'timing-reset') {
        c.timing = defaults().timing;
        this.save(c);
        return this.menu(ctx, 'timing');
      }
      if (a === 'retry') {
        this.store.retryUncertain();
        return this.menu(ctx, 'status');
      }
      if (a === 'discard-failed') {
        this.store.db.exec(
          "UPDATE jobs SET status='cancelled' WHERE status IN ('failed','uncertain')",
        );
        return this.menu(ctx, 'status');
      }
      if (a === 'board-reset') {
        this.service.resetBoard(b!);
        await ctx.reply(await this.service.board(b!, 0, true));
        return this.menu(ctx, 'boards');
      }
      if (a === 'reset' || a === 'import') {
        const imported = this.store.get<Config | null>('import', null);
        if (a === 'import' && !imported) throw new Error('没有待导入配置');
        const next = a === 'reset' ? { ...defaults(), paused: true } : parseConfig(imported);
        this.validateDraft(next);
        this.store.transaction(() => {
          this.save(next);
          for (const key of [
            'engine',
            'catalog',
            'batch',
            'boards',
            'draft',
            'pending',
            'runtime',
            'import',
          ])
            this.store.delete(key);
          this.store.db.exec("UPDATE jobs SET status='cancelled' WHERE status='pending'");
        });
        return this.menu(ctx, 'home');
      }
      throw new Error('操作不存在');
    }
    return this.menu(ctx, data);
  }
  private async accept(ctx: Context, text: string) {
    const p = this.store.get<Pending | null>('pending', null);
    if (!p || p.expires < Date.now()) {
      this.store.delete('pending');
      return this.menu(ctx, 'home');
    }
    const c = this.config(),
      value = text.trim(),
      [a, b] = p.args;
    const custom = () => {
      const entity = (ctx.message?.entities ?? ctx.message?.caption_entities ?? []).find(
        (e) => e.type === 'custom_emoji',
      );
      return entity?.type === 'custom_emoji' ? entity.custom_emoji_id : value === '-' ? '' : value;
    };
    if (p.kind === 'number') {
      const key = a as keyof typeof numericFields;
      c.timing[key] = value === 'default' ? numericFields[key].default : Number(value);
      this.save(c);
    } else if (p.kind === 'site' || p.kind === 'api') {
      if (p.kind === 'site') httpUrl.parse(value);
      else if (value !== '-') httpUrl.parse(value);
      if (p.kind === 'api' && !c.siteUrl) throw new Error('请先设置店铺网址');
      await ctx.reply('正在检测公开接口，请稍候…');
      const scan = await this.service.connect(
        p.kind === 'site' ? value : c.siteUrl,
        p.kind === 'api' ? (value === '-' ? '' : value) : '',
      );
      this.store.delete('draft');
      await ctx.reply(
        `连接成功：${scan.siteName}，${scan.products.length} 个商品。已建立初始基线，不会补发历史变化。`,
      );
    } else if (p.kind === 'target') {
      await this.bind(ctx, value);
      this.store.delete('pending');
      await this.menu(ctx, 'targets');
      return;
    } else if (p.kind === 'search') {
      const filters = this.store.get<Filters>('filters', { search: '', category: '' });
      filters.search = value === '-' ? '' : value.slice(0, 100);
      this.store.set('filters', filters);
    } else if (p.kind === 'product') {
      if (b === 'order' && value !== 'inherit' && !/^-?\d+$/.test(value))
        throw new Error('排序值必须是 -100000～100000 的整数，或输入 inherit 恢复默认。');
      const val =
        value === 'inherit'
          ? null
          : b === 'customEmojiId'
            ? custom()
            : b === 'order'
              ? Number(value)
              : value === '-'
                ? ''
                : value;
      const previous = this.draft();
      this.patchVisual(a!, b!, val);
      try {
        this.edited();
      } catch (e) {
        this.store.set('draft', previous);
        throw e;
      }
    } else if (p.kind === 'prnumber') {
      if (b !== 'threshold' && b !== 'confirmations') throw new Error('无效设置');
      c.products[a!] ??= {};
      if (value === 'inherit') delete c.products[a!]![b];
      else c.products[a!]![b] = Number(value);
      this.save(c);
    } else if (
      p.kind === 'format' ||
      p.kind === 'appearance' ||
      p.kind === 'link' ||
      p.kind === 'link-add'
    ) {
      const previous = this.draft();
      try {
        this.editAppearance((ap) => {
          if (p.kind === 'format') {
            const f = ap[a === 'board' ? 'board' : 'notification'];
            const val =
              b === 'order'
                ? value
                    .split(/[,，]/)
                    .map((x) => x.trim())
                    .filter(Boolean)
                : value === '-'
                  ? ''
                  : text;
            (f as unknown as Record<string, unknown>)[b!] = val;
          } else if (p.kind === 'appearance') {
            if (!['buttonTemplate', 'emoji', 'customEmojiId'].includes(a!))
              throw new Error('无效外观设置');
            (ap as unknown as Record<string, unknown>)[a!] =
              a === 'customEmojiId' ? custom() : value === '-' ? '' : text;
          } else if (p.kind === 'link-add') {
            const [label, url] = text.split('\n').map((s) => s.trim());
            if (!label || !url) throw new Error('需要两行：文字和链接');
            buttonUrl.parse(url);
            ap.links.push({
              id: randomUUID().slice(0, 8),
              text: label,
              url,
              emoji: '',
              customEmojiId: '',
              style: 'default',
            });
          } else {
            if (!['text', 'url', 'emoji', 'customEmojiId'].includes(b!))
              throw new Error('无效链接设置');
            const l = ap.links.find((x) => x.id === a);
            if (!l) throw new Error('链接不存在');
            (l as unknown as Record<string, unknown>)[b!] =
              b === 'customEmojiId' ? custom() : value === '-' ? '' : text;
          }
        });
        this.validateDraft(this.edited());
      } catch (e) {
        this.store.set('draft', previous);
        throw e;
      }
    } else if (p.kind === 'import') {
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('配置不能超过 1MB');
      const imported = parseConfig(JSON.parse(text));
      this.validateDraft(imported);
      this.store.set('import', imported);
      this.store.delete('pending');
      return this.show(
        ctx,
        `<b>配置校验通过</b>\n网站：${escapeHTML(imported.siteUrl || '未设置')}\n目标：${imported.targets.length} 个；商品设置：${Object.keys(imported.products).length} 个\n检查间隔：${imported.timing.interval} 秒\n请确认这些网址及目标都属于你的配置。`,
        [[cb('应用此配置', 'confirm:import'), cb('取消', 'home')]],
      );
    } else throw new Error('输入流程已过期，请发送 /start');
    this.store.delete('pending');
    await ctx.reply(
      ['product', 'format', 'appearance', 'link', 'link-add'].includes(p.kind)
        ? '已写入草稿，预览并保存后生效。'
        : '设置已生效。',
    );
    await this.menu(ctx, p.back);
  }
  private register() {
    this.bot.use(async (ctx, next) => {
      if (ctx.callbackQuery?.data?.startsWith('board:')) {
        const chat = ctx.callbackQuery.message?.chat;
        const id = ctx.callbackQuery.message?.message_id;
        const record = this.store.get<Record<string, BoardRecord>>('boards', {})[String(chat?.id)];
        if (record && record.messageId === id) {
          await ctx.answerCallbackQuery();
          const key = `board-click:${chat!.id}`;
          if (Date.now() - this.store.get(key, 0) < 2000) return;
          this.store.set(key, Date.now());
          await this.service.board(
            String(chat!.id),
            Number(ctx.callbackQuery.data.split(':')[1]) || 0,
            true,
          );
          return;
        }
        await ctx.answerCallbackQuery({ text: '这是预览或旧看板，请使用当前频道看板。' });
        return;
      }
      if (!canManage(ctx.from?.id, ctx.chat?.type, this.service.adminId)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '仅管理员可操作。' });
        return;
      }
      await next();
    });
    this.bot.command(['start', 'menu'], async (ctx) => {
      this.store.delete('pending');
      await this.menu(ctx);
    });
    this.bot.command(['version', 'settings'], (ctx) => this.menu(ctx, 'settings'));
    this.bot.command('cancel', async (ctx) => {
      const p = this.store.get<Pending | null>('pending', null);
      this.store.delete('pending');
      await this.menu(ctx, p?.back || 'home');
    });
    this.bot.command('help', (ctx) =>
      ctx.reply(
        '发送 /start 打开中文菜单。配置只允许管理员私聊操作。网站不需放文件；使用 /cancel 取消输入。',
      ),
    );
    this.bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await this.onCallback(ctx, ctx.callbackQuery.data);
      } catch (e) {
        await ctx.reply(this.errorMessage(e));
      }
    });
    this.bot.on('message:chat_shared', async (ctx) => {
      try {
        await this.bind(ctx, String(ctx.message.chat_shared.chat_id));
        await this.menu(ctx, 'targets');
      } catch (e) {
        await ctx.reply(this.errorMessage(e));
      }
    });
    this.bot.on('message:document', async (ctx) => {
      const p = this.store.get<Pending | null>('pending', null);
      if (p?.kind !== 'import' || p.expires < Date.now())
        return ctx.reply('请先在备份菜单选择“导入 JSON”。');
      try {
        if ((ctx.message.document.file_size ?? 0) > 1024 * 1024)
          throw new Error('配置文件不能超过 1MB');
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error('文件暂不可下载');
        // Download URL contains the bot token and must never be logged.
        const response = await fetch(
          `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!response.ok || !response.body) throw new Error('配置下载失败');
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let count = 0;
        try {
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            count += r.value.length;
            if (count > 1024 * 1024) throw new Error('配置文件不能超过 1MB');
            chunks.push(r.value);
          }
        } finally {
          await reader.cancel();
        }
        await this.accept(ctx, Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        await ctx.reply(this.errorMessage(e));
      }
    });
    this.bot.on('message:text', async (ctx) => {
      try {
        await this.accept(ctx, ctx.message.text);
      } catch (e) {
        await ctx.reply(this.errorMessage(e) + '\n可重新输入，或 /cancel 取消。');
      }
    });
  }
  private errorMessage(e: unknown) {
    const message = e instanceof Error ? e.message : '操作失败';
    return message.replaceAll(this.bot.token, '[TOKEN]').slice(0, 1500);
  }
}
