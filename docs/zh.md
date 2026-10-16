# DSH 会话指标

[English](<../README.md>) | 中文

`dsh-session-metrics` 是社区 desktop 插件（非 DeepSeek 官方出品），兼容 DSH 0.2.0-rc.2。它替换输入框下方 DSH 自带的统计栏，一行依次显示累计计费 Token、上下文用量、缓存命中、模型耗时、工具耗时、轮次与步数；其余指标与明细收进悬浮弹窗。不修改核心、不写文件、不启动额外服务。

## 行为

- Host 订阅 `session/event`，把 durable 日志折叠成按 Session 分组的计数器：`turn/start` 与 `step/start` 驱动轮次与步数；`step/start` 到 `assistant/message` 是一个 step 的模型墙钟时间；`tool/call`/`tool/result` 配对给出按名称分组的调用次数与耗时。
- 所有数值都是日志提交时间戳之间的差值，不是观测者的墙钟。插件加载前已存在的 Session 会用 `session.snapshotEvents()` 补齐，之后每个 append 按 `seq` 只折叠一次；Host 中已 dispose 的 Session 会从内存移除。
- 这一行读取自带的 `contextPressure`、`sessionStats` 与 `tokenUsage` 投影，数值与 DSH 自身一致并实时更新。悬停（或聚焦、点击）打开与自带统计弹窗同款的面板：工具调用次数与失败、会话跨度、上下文用量及构成、Token 拆分，以及按累计耗时排序的工具 Top；Token 与上下文统一用 k/M 单位，各分项标注占比；Escape、点击外部或指针移开即关闭。
- Host 路由只补投影没有的数据（工具调用次数、逐工具耗时、失败、会话跨度）。仅在弹窗打开时、或投影不可用时每 2.5 秒轮询，页面隐藏时暂停。
- 投影与 Host 都没有数据时这一行不显示。
- 本机路由 `/myspace-session-metrics/api` 只接受 loopback、合法 Host、同源 Origin/Fetch Metadata 和 `X-DSH-Session-Metrics: 1` 请求头，且只处理带合法 `sessionId` 的 `GET`。计数器只在内存中，插件卸载或 DSH 重启即丢失，不写磁盘。
- 插件以 `id: stats`、`priority: -1` 注册到 `conversation.composer.dock`，遮蔽自带统计格；旁边的自带上下文环因数值已并入本行而隐藏。根节点保留自带的 `data-composer-stats` 钩子，主题只会绘制一条统计带、一条上沿线。禁用插件即恢复自带统计与上下文环。

## 开发与安装

在 DSH 插件管理器中安装 npm 包 `dsh-session-metrics`。仅支持 desktop profile；不要安装到 Web profile。

无需构建，原生 ModuleLoader Client 随包分发。开发时可安装 `link:/absolute/path/to/dsh-session-metrics`；改动 Host 后必须重启 DSH，刷新页面不会重载 Host 模块缓存。

```sh
npm test
node --check src/client.js
```

测试覆盖日志折叠（轮次/步数/模型/工具计量、未结束的工具调用、重放幂等、格式化）、Host 路由边界（Session id 校验、loopback/同源/请求头门禁、tracker 补齐、释放），以及 Client 半边（bundle 经 ModuleLoader 接缝加载、遮蔽自带统计格、无轮询地从自带投影渲染七项指标、回退到 Host 读数、空会话或 Host 不可达时不渲染、页面隐藏时停止轮询）。真实 DSH 桌面会话的运行验收——统计行与悬浮面板——必须单独执行；单元测试通过不等于运行验收。

## 限制

- Token 数量由 provider 上报；某一步没有 `usage` 记录时只贡献耗时、不贡献 Token，缓存命中占比显示 `—`，不会编造百分比。
- 工具耗时只覆盖在观测到的日志内开始并结束的调用；turn 关闭时仍打开的调用按一次失败调用计。
- 计数从 Host 能看到的 Session 日志开始。从存储恢复但未重放事件的 Session 只贡献其后的新 append。
- Host 读数是对本机计数器的轮询读取，不是链路追踪或计费依据，也不上传任何内容。

## 可信发布

`.github/workflows/publish.yml` 使用 GitHub Actions OIDC 发布，无需保存 npm Token。在 `main` 上手动触发，将已审核的完整提交 SHA 填入 `expected_sha`。`dry_run` 默认 true，仅在批准发布新版本时设为 false；提交 SHA 不匹配时工作流拒绝发布。提交工作流不等于配置 Trusted Publisher，需要在 npmjs.com 包设置中完成。

## License

MIT，见 LICENSE。
