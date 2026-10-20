# 🦄 独角数卡库存通知 Bot · v0.1.1

面向 **Dujiao-Next v1.5.0** 的独立 Telegram 库存通知项目。服务器只配置 Bot Token、管理员数字 ID，店铺、频道、速度、商品、模板和按钮全部在 Telegram 中文菜单中管理。

**网站服务器不需要放任何文件，不改源码，不访问数据库。** Bot 通过现成的公开 API 获取商品。Bot 容器可以与网站同机，也可以放在另一台机器。

## 部署

要求：Linux Docker（amd64 或 arm64）；能访问 `api.telegram.org` 和店铺，应用更新还需访问 GitHub Releases；一个专门用于通知的 Bot。请先在 BotFather 创建 Bot，并获得自己的数字用户 ID。

### 直接运行发行镜像（推荐）

发行版镜像：`ghcr.io/a06342637/dujiaoshutongzhi:latest`。只有两个必填参数，不需要下载源码、建立目录或放置网站文件：

```sh
docker run -d --name dujiao-stock-bot --init --restart unless-stopped \
  --stop-timeout 90 \
  -e BOT_TOKEN='你的Token' \
  -e ADMIN_USER_ID='你的数字ID' \
  -v dujiao-stock-data:/data \
  --log-opt max-size=10m --log-opt max-file=3 \
  ghcr.io/a06342637/dujiaoshutongzhi:latest
```

`dujiao-stock-data` 是 Docker 自动创建的命名数据卷，不需要手动建立目录。以后换容器要继续挂载同一个数据卷。

### Compose（可选）

```sh
cp .env.example .env
# 编辑 .env，只填写 BOT_TOKEN 和 ADMIN_USER_ID
docker compose pull
docker compose up -d
docker compose logs -f --tail 100
```

Compose 默认数据卷与上方 `docker run` 的卷名不同。选定一种方式后保持一致；迁移部署方式时需显式挂载旧卷。`docker compose down` 保留数据，**不要加 `-v`**，否则会删除配置和库存记录。

### 从源码构建（可选）

```sh
git clone https://github.com/a06342637/dujiaoshutongzhi.git
cd dujiaoshutongzhi
docker build -t dujiao-stock-bot:local .
```

再运行上方启动命令，把最后的镜像名改为 `dujiao-stock-bot:local`。目录放在 Bot 服务器任意位置，例如 `/opt/dujiaoshutongzhi`，不必放进网站程序目录。

## Telegram 一键更新

主菜单显示当前版本，也可以发送 `/version` 或 `/settings`。管理员进入 **设置／版本更新 → 检查更新 → 一键更新**：

1. 只查询本仓库正式 GitHub Release，不安装预发行版或自动跟随 main 分支。
2. 下载更新清单和应用包，检查版本、大小、SHA-256、运行环境要求，以及解压路径安全。
3. 下载阶段旧程序继续运行。校验通过后停止旧程序，把 SQLite 数据库完整备份到数据卷。
4. 新版通过数据库和 Telegram 启动检查后才接管监测，并向管理员报告更新结果。
5. 新版未就绪就退出、超时，或切换期间容器中断，下次启动会恢复旧程序及更新前数据库。

**不需要挂载 `/var/run/docker.sock`，不需要额外密码或开放管理端口。** 应用和运行依赖更新到 `/data/releases`，容器重新创建后仍能继续使用已更新版本。

应用更新不更换 Node.js、Linux 基础系统或更新监督进程。遇到需要升级这些组件的新版本时，Bot 会提示按 Docker 方式更新镜像。程序正常就绪后的业务错误仍由运行状态菜单诊断，不因普通网络错误自动回退数据库。

更新文件：`/data/supervisor.json` 保存活动版本及中断恢复状态，`/data/update-backups` 保存切换前数据库，`/data/update-result.json` 保存结果。备份可能含网站、频道和业务配置，应按数据库保护；当前保留历史更新包及备份，不自动删除。磁盘空间不足时更新会失败并保留旧程序，可停容器后清理明确不再使用的旧备份。不要删除活动版本目录或未完成更新的备份。

源码开发模式 `npm run dev` 不启用版本切换；本地正式运行先 `npm run build`，再 `npm start`。

## Telegram 使用流程

1. 管理员私聊 Bot，发送 `/start`。
2. 点 **网站连接**，发送完整店铺网址。公开接口检查成功后建立库存基线，不发送历史补货通知。
3. 前后端域名分离时，在 **独立 API 基址** 填 `https://api.example.com/api/v1`。只有网站前台网址不同，购买链接仍使用店铺网址。
4. 把 Bot 加入频道或群并设为管理员；频道还需开启管理员的“发布消息”权限。
5. 在 **通知目标 → 输入频道／群用户名** 中发送 `my_shop`（直接填 @ 后面的字母即可），也支持 `@my_shop`、`https://t.me/my_shop` 或数字 ID。Bot 校验权限后绑定并启用目标，按当前监测设置推送。可添加多个目标。
6. 在 **商品管理** 搜索、分类筛选、批量启停；商品外观编辑进入草稿，监测开关和通知规则立即生效。
7. 在 **消息排版／按钮样式** 编辑，先私聊预览，再点 **保存草稿**。目标菜单支持主动发送测试消息。
8. 在 **监测速度** 输入数字；`default` 恢复单项默认，`/cancel` 取消输入。全局暂停、立即检查、看板开关均在菜单中。

只有启动时指定的管理员能在私聊中设置。频道里的其他人只可操作当前库存看板的翻页与刷新。第一版不提供顾客私聊订阅。

### 绑定频道／群的常见问题

- `my_shop` 指公开用户名，不是频道或群的中文显示名称。公开频道和公开群组都支持。
- 私有频道／群没有公开用户名，请使用数字 ID（通常以 `-100` 开头）。邀请链接 `t.me/+...` 和消息链接不能替代目标 ID。
- 机器人仅加入群但没有管理员身份时，新版会提示补齐权限，不会假装已启用。频道管理员还需要“发布消息”权限。
- v0.1.0 的选择器可能报 `USER_RIGHTS_MISSING`；v0.1.1 已改成直接输入。升级后发送 `/start` 打开新菜单；点击旧消息中的选择按钮也会转到输入流程。
- 重新输入同一目标会按数字聊天 ID 去重并重新启用，不会添加重复目标。全局暂停、通知关闭等设置保持原样；恢复监测或开启通知后才发送。
- 绑定后可点目标的 **发送测试通知**。库存看板开启时会自动创建或更新；变化通知只在检测到符合规则的新变化时发送，不补发历史库存。

### 商品排序

进入 **商品管理 → 调整商品顺序**，点选商品后可 **上移、下移、置顶、置底**，也能填写排序数字（越小越靠前，同值按原商品名排序）。

排序针对全店商品，包括暂停监测的商品；商品管理中的搜索和分类只用于查找。修改先进入草稿，管理列表会立即显示草稿顺序，点击 **保存排序草稿／保存草稿** 后，后续通知中的购买按钮和库存看板同步使用该顺序。丢弃草稿可撤销未保存的排序，不会改动监测开关、图标或价格。

## 修改 Bot Token 和管理员用户 ID

这两项是容器启动配置，需要在服务器修改；Telegram 的应用更新不会改动环境变量。`BOT_TOKEN` 是 BotFather 生成的密钥，`ADMIN_USER_ID` 是能管理机器人的 **个人数字用户 ID**，不是频道／群 ID，也不是 @用户名。

### Compose 部署

在**原来的 Compose 项目目录**编辑 `.env`：

```dotenv
BOT_TOKEN=新的机器人Token
ADMIN_USER_ID=新的个人数字用户ID
```

保存后重新创建 Bot 容器：

```sh
docker compose up -d --force-recreate bot
docker compose logs --tail 50 bot
```

保留原 Compose 项目名和数据卷。单独运行 `docker compose restart` 不会读取修改后的环境变量。不要运行 `docker compose down -v`，它会删除数据卷。

### docker run 部署

先核实正在使用的数据卷名称，下面的命令只显示挂载信息，不输出 Token：

```sh
docker inspect dujiao-stock-bot --format '{{range .Mounts}}{{if eq .Destination "/data"}}type={{.Type}} name={{.Name}} source={{.Source}}{{end}}{{end}}'
```

以下示例假设容器名为 `dujiao-stock-bot`、原命名卷为 `dujiao-stock-data`。如果你的名称不同，请替换为上一步查到的原名称；如果使用目录挂载，继续使用原目录。**不要新建一个不同的数据卷来代替旧卷。**

```sh
docker pull ghcr.io/a06342637/dujiaoshutongzhi:latest
docker stop --time 90 dujiao-stock-bot
docker rm dujiao-stock-bot
docker run -d --name dujiao-stock-bot --init --restart unless-stopped \
  --stop-timeout 90 \
  -e BOT_TOKEN='新的机器人Token' \
  -e ADMIN_USER_ID='新的个人数字用户ID' \
  -v dujiao-stock-data:/data \
  --log-opt max-size=10m --log-opt max-file=3 \
  ghcr.io/a06342637/dujiaoshutongzhi:latest
```

这里删除的是已停止的容器，命名数据卷不删除；沿用旧卷才能保留店铺、目标、排序、模板和库存记录。

### Token 重置与换管理员后的检查

- 如需撤销旧 Token，在官方 `@BotFather` 使用 `/revoke` 并选择对应 Bot，再把取得的新 Token 填到服务器。旧 Token 会立即失效，请不要把真实 Token 提交到 GitHub 或发在群里。
- 同一个 Bot 重置 Token，其机器人身份不变，频道权限和现有看板通常可继续使用。如果换成另一个 Bot 的 Token，需要把新 Bot 加入目标并设置管理员，再检查目标权限；新 Bot 不能编辑原 Bot 的消息，必要时在库存看板菜单重建看板。
- 更换管理员 ID 后，由新管理员私聊 Bot 发送 `/start`；旧管理员失去管理权限。如果“通知目标”中保存了旧管理员私聊，请由新管理员删除旧目标，并按需添加自己的私聊，否则旧目标仍按原配置接收库存通知。
- 如果仍提示 Token 无效，请检查 `.env` 或启动命令是否填写正确，确认容器已经重新创建，且同一个 Token 没有同时运行多个 Bot 实例。

本地源码运行时，修改终端中的 `BOT_TOKEN`、`ADMIN_USER_ID` 环境变量后重新执行 `npm start`；项目不会自动加载 `.env`。完整 Token 不应出现在排查截图或日志分享中。

## 自定义能力

| 项目             |      默认 | 可配置                   |
| ---------------- | --------: | ------------------------ |
| 检查间隔         |     15 秒 | 1～3600 秒               |
| HTTP 请求超时    |     10 秒 | 3～60 秒                 |
| 请求重试         |      2 次 | 0～5 次                  |
| 连续确认         |      1 次 | 1～5 次；单商品可覆盖    |
| 变化合并窗口     |     10 秒 | 0～300 秒，0 表示立即    |
| 看板最短更新间隔 |     15 秒 | 5～3600 秒               |
| 数量门槛         |      1 件 | 1～10 亿件；单商品可覆盖 |
| 商品消失确认     |      2 次 | 2～5 次完整成功扫描      |
| 看板每页         | 10 个按钮 | 5～20 个，展开规格也计入 |

正常扫描不重叠。间隔是计划频率，并非保证通知的端到端延迟；网络耗时、分页、确认和合并都会影响速度。低间隔会增加店铺负载。网站和 Telegram 返回限流时，等待其指定时间。

默认通知可售增加、减少、恢复有货、售罄、区间／展示状态变化。商品新增、不可见、价格变化默认不通知，均可开关。数量阈值按合并窗口净变化计算，状态事件不受阈值限制。恢复有货的单次增量不会再重复列为一条“增加”。

每件商品可设置名称、普通表情、自定义表情 ID、颜色、排序、购买链接、展开规格、独立事件规则与门槛。按钮默认跳转 `/products/{slug}`；规格按钮也打开商品页，由用户选择规格，不虚构网站没有的预选接口。

### 模板

通知和看板各自配置：标题、说明、变化明细、栏目名、分隔线、栏目顺序、时间格式和时区、底部文字。支持 Telegram HTML 子集（粗体、斜体、引用、链接、自定义表情等），不执行脚本。

- 栏目文字：`{site}`、`{time}`、`{page}`、`{pages}`。
- 变化明细：`{product}`、`{spec}`、`{spec_line}`、`{price}`、`{stock}`、`{before}`、`{after}`、`{delta}`、`{delta_text}`、`{event}`、`{url}`、`{emoji}`，以及栏目文字变量。
- 高级整段模板：`{header}`、`{top}`、`{details_title}`、`{details}`、`{divider}`、`{stock_title}`、`{time}`、`{footer}`、`{site}`、`{page}`、`{pages}`。设置后覆盖栏目顺序。
- 按钮模板（纯文字）：`{emoji} {product}｜{price}｜{stock}`，另支持 `{spec}`。

`-` 清空可选文字／高级模板；商品编辑中的 `inherit` 恢复继承。栏目顺序输入 `header,top,details,divider,stock,time,footer`，可删去栏目。HTML 中的 `&` 写为 `&amp;`；网站商品名等外部文字自动转义。

长商品按钮名会以省略号截断（保留完整购买链接），长通知自动拆成多条有效 HTML 消息。看板保持一条消息，过长的看板模板会在预览／保存时拒绝。历史通知不随模板变化重写。

### 颜色与自定义表情

Telegram 支持红（danger）、绿（success）、蓝（primary）及客户端默认色，不支持任意色值。自动模式：有货绿色、售罄红色、未知蓝色。

自定义图标可发送包含目标表情的消息提取 ID，也可手填数字 ID。根据 Telegram 当前文档，Bot 所有者 Premium 可用于 Bot 直接发送的私聊、群、超级群；**频道不在此放宽范围内**，需要 Bot 具备 Fragment 额外用户名资格。实际效果受 Telegram 权限和客户端支持影响，需在目标聊天测试。

API 明确拒绝自定义表情时自动回退普通 emoji，并通知管理员。目标菜单可重新测试。客户端自行忽略的图标无法仅靠 API 响应判断，请查看测试消息。

## 数据准确性与异常

- 兼容精确、区间、隐藏、无限、未知库存。只对精确数量计算差值；不会把隐藏数量字段中的占位零当成售罄。
- 覆盖人工、自动、上游映射与规格库存。多规格总数不变但规格之间增减也可检测。
- 缺失数值显示未知；比较器保存上次有效值。分页异常、重复 ID、总数变动或响应失败不提交半份库存，也不触发整站售罄。
- 商品连续从完整列表消失才通知“不可见”；这并不证明后台下架。
- “可售减少”不是“卖出”；“可售增加”也可能是订单取消释放库存。新版公开接口不保证预占数量，不能还原其未公开信息。
- 采样间隔内发生又恢复的变化可能无法观察到，上游映射库存也可能有网站自身的同步延迟。
- SQLite 事务同时保存库存变化和待发状态；各目标独立发送。明确的 API 拒绝显示 failed，网络响应丢失显示 uncertain，不盲目重发。管理员可选择重试或丢弃；重试 uncertain 有重复可能。
- 看板创建中断会暂停自动创建，管理员确认后才能重建；看板编辑失败可按已有消息 ID 重试。频道看板翻页是共享状态。
- 连续三次网站失败会提醒管理员，恢复提醒一次。无 Bot 私聊记录或管理员屏蔽 Bot 时，提醒无法送达，请先 `/start`。

## 数据与运维

容器 `/data/bot.sqlite` 保存配置、草稿、快照、通知窗口、看板 ID、发送队列；`/data/heartbeat` 用于容器健康检查。健康检查只表示进程事件循环工作，店铺和 Telegram 连通情况请看 Bot 运行状态。

同一个 Token 和数据卷只运行一个容器。不要用自动扩容运行多个长轮询实例，也不要与另一个 Bot 程序共用 Token。启动发现旧 Webhook 时会明确报错，不擅自删除。

更新 Compose 基础镜像：`docker compose pull && docker compose up -d`。备份完整数据卷前先停容器，以包含 SQLite WAL 的一致快照；日常可以在 Bot 导出不含 Token 的 JSON 配置。导入先校验并显示摘要，确认后重建库存基线，取消旧待发通知，已发送消息不删除。

## 发布新版本（维护者）

执行 `npm version 0.1.2 --no-git-tag-version`（替换为目标版本），更新发行说明后提交。先等待 main 分支验证通过，再推送对应的 `v0.1.2` 标签。GitHub Actions 将自动测试、构建两个架构的镜像，生成应用更新包及 SHA-256 清单，全部成功后才公开 Release。已部署的 Bot 在设置里检查到该正式版后即可更新，无需给每台服务器手动复制代码。

首次 GHCR 发布后需确认镜像包对外可见；镜像包地址为本仓库关联的 `dujiaoshutongzhi`，公开镜像可以匿名拉取。

## 开发与验证

```sh
npm ci
npm run check
npm test
npm run build
# 配置 BOT_TOKEN、ADMIN_USER_ID 后：
npm start
```

本地默认存储在 `./data`，可通过可选 `DATA_DIR` 指定。运行时仅需两个必填环境变量。

自动化测试覆盖库存归一化、规格变化、窗口合并、分页完整性、持久化、发送失败隔离、模板安全及 Bot 菜单交互。实机验收仍需要真实 Bot、频道／群和目标店铺，见 [验收清单](docs/ACCEPTANCE.md)。

参考：[Dujiao-Next v1.5.0](https://github.com/dujiao-next/dujiao-next/releases/tag/v1.5.0)、[公开 API](https://dujiao-next.com/api/frontend-api)、[Telegram 按钮规范](https://core.telegram.org/bots/api#inlinekeyboardbutton)、[tg_stock_notify_multi](https://github.com/Netflixxp/tg_stock_notify_multi)、[stock-notice](https://github.com/mastalee928/stock-notice)。本项目独立实现，没有复制参考仓库代码。
