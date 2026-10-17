# 本次交付验证记录

日期：2026-10-18（Asia/Shanghai）

已完成：

- TypeScript 严格类型检查，包括未使用变量检查。
- `npm run build` 编译成功。
- Node.js **24.22.0** 下 **50 项测试全部通过**，覆盖基础功能和版本更新回退。
- 默认本地 Node.js 26 环境的核心测试通过；项目运行基线仍为 Node.js 24。
- `npm audit --omit=dev`：0 个已知漏洞。
- 使用本项目 `DujiaoAdapter` 只读访问官方演示站 `https://demo.dujiaoka.com`，成功读取 CNY 币种、2 个商品、1 页数据；未写入店铺或创建订单。
- 编译产物在缺少必填环境变量时正常拒绝启动，并显示中文说明，不调用 Telegram。
- 自动化测试使用本地 HTTP 测试服务器、临时 SQLite 数据库及模拟 Telegram API，不需要真实 Bot Token。

GitHub 与部署验证：

- [首次完整 CI](https://github.com/a06342637/dujiaoshutongzhi/actions/runs/39060919134) 的测试、编译、应用包生成和 amd64／arm64 镜像构建全部成功。
- 实际 CI 更新包已下载，通过大小与 SHA-256 校验，解压后在 Node.js 24 成功导入 Bot、更新监督程序及 SQLite，确认发布包不依赖开发依赖。
- [正式发布验证](https://github.com/a06342637/dujiaoshutongzhi/actions/runs/39061504102) 已全部通过：两个架构的实际镜像均以非 root 用户和只读根文件系统运行，成功读写 SQLite 数据卷和更新状态文件。
- [v0.1.0 正式版](https://github.com/a06342637/dujiaoshutongzhi/releases/tag/v0.1.0) 已公开，包含应用更新包和 SHA-256 清单；镜像已验证支持匿名拉取。
- 已通过程序自身的更新逻辑读取正式版、下载校验并解压更新包，且当前版本不会误提示重复安装。早期发布脚本的循环语法错误已修复，以上正式发布验证为成功重跑结果。
- 未提供真实 Bot Token、管理员 ID、目标频道／群和实际店铺，未做实机 Telegram 显示、权限、频道置顶及端到端联调。
- 真实 Telegram 客户端的渲染和权限不能通过模拟 API 或 CI 证明。

v0.1.0 更新测试使用真实 Node.js 子进程和临时 SQLite：验证成功切换、失败启动回退、恢复旧数据库、切换中断后下次启动恢复、下载校验失败及解压路径限制。更新程序只安装固定仓库的正式 Release，旧版本不会在下载期间停止。

以上未验证项不能由单元测试代替。上线前请完成 [实机验收清单](ACCEPTANCE.md)。
