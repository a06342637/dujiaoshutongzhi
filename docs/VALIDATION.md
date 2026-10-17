# 本次交付验证记录

日期：2026-10-18（Asia/Shanghai）

已完成：

- TypeScript 严格类型检查，包括未使用变量检查。
- `npm run build` 编译成功。
- 基础版本在 Node.js **24.22.0** 下 42 项测试通过；v0.1.0 新增版本更新及回退测试。最新完整结果以本仓库 Actions 对应提交为准。
- 默认本地 Node.js 26 环境的核心测试通过；项目运行基线仍为 Node.js 24。
- `npm audit --omit=dev`：0 个已知漏洞。
- 使用本项目 `DujiaoAdapter` 只读访问官方演示站 `https://demo.dujiaoka.com`，成功读取 CNY 币种、2 个商品、1 页数据；未写入店铺或创建订单。
- 编译产物在缺少必填环境变量时正常拒绝启动，并显示中文说明，不调用 Telegram。
- 自动化测试使用本地 HTTP 测试服务器、临时 SQLite 数据库及模拟 Telegram API，不需要真实 Bot Token。

尚未完成：

- 当前本地开发环境未安装 Docker；amd64／arm64 镜像构建在 GitHub Actions 执行，结果请查看对应提交及 v0.1.0 标签的流水线。
- 未提供真实 Bot Token、管理员 ID、目标频道／群和实际店铺，未做实机 Telegram 显示、权限、频道置顶及端到端联调。
- 真实 Telegram 客户端的渲染和权限不能通过模拟 API 或 CI 证明。

v0.1.0 更新测试使用真实 Node.js 子进程和临时 SQLite：验证成功切换、失败启动回退、恢复旧数据库、切换中断后下次启动恢复、下载校验失败及解压路径限制。更新程序只安装固定仓库的正式 Release，旧版本不会在下载期间停止。

以上未验证项不能由单元测试代替。上线前请完成 [实机验收清单](ACCEPTANCE.md)。
