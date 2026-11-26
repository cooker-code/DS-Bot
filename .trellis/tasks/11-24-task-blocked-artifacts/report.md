# 阻塞状态、已有文档与企微发送验收记录

2026-11-24，代码候选 `ebb2031cd5fa3438dd8b99a5fcf1d6606a5938f5`。来源原卡 `51847c2b-fba6-460b-80a1-8c9d208a7f70`。独立测试者只读复核通过；用户验收及真实企微接收仍由用户判断。

## 1. 普通任务的阻塞状态

真实 React 19.2.0 渲染候选 TaskHandoffs、TaskExecutionStatus 和 TaskResults，Chrome 中标题下可见 Blocked、节点名称、原因和等待条件；不依赖独立测试节点或展开交接。当前计划绑定轮次的投影测试覆盖并行仍 active 但某节点阻塞、历史阻塞不覆盖已恢复节点。

## 2. 已有文档进入验收结果

Chrome 中点击实际 TaskResults 的 Markdown disclosure，真实 useEffect 回读本地 mock receipt 并展开正文，同时显示 Available files · task not completed。该交互使用候选实际组件和临时 React runtime，仅 API 内容为明确标注的 mock；不作为日用原卡或企微证据。CUA 已生成内联截图，但该接口未提供本地截图导出路径。

原卡保存证据的路径另经主会话只读核对：百科赠送会员讨论整理.md 完整读取 13,296 字节，企微交付核验.md 完整读取 3,024 字节，均为 partial，不生成验收条目或提交时间。历史“同目录/”记录沿唯一报告目录解析，文件读取边界保持原状。

## 3. 向已配置企微交付 Markdown

新增 send_im_document / im-send-document，复用本群唯一启用的企微绑定，私聊必须已配对；多个目标须明确指定既有连接及聊天。只发送原卡登记的 Markdown，Bot 权限限本群当前管理员或原卡当前派工执行者。

隔离真实 WebSocket 适配器测试校验了完整多分片文件字节、上传顺序、media_id 和匹配 msgid。同一请求并发只上传并投递一次；成功回执离线可回放；回执丢失标为 uncertain 且不重发；上传中解绑、上传明确被拒、未配对、多目标、未登记文件、旧管理员会话及未派工成员均拒绝投递。

真实文件尚未发到企微。用户已明确授权现有目标，无需再询问收件人。日用 Desktop 操作者 API 返回 login_http_401，且尚未核实运行实例已加载本次新增入口；未改写团队库、冒充 IM 来源、接管日用长连接或重启 Desktop。已准备可复用的发送请求，保存在功能分支工作树 ignored 的 .playwright-mcp/requested-wecom-document.json。

## 检查与清理

- 状态、产物、任务时序、悬浮框首轮 21 项通过；独立测试包含 group-work 的 180 项组合通过。
- 既有 im / im-wecom 92 项回归通过；新增文件交付多分支用例通过，独立复核 WeCom 相关 3 项通过。
- agents / scoped-tools 44 项通过。lint 退出 0（仅既有 warning），客户端生成一致性检查通过，183 个操作者 API 均恰好登记一次。
- 最终候选的隔离宿主 57 步冒烟全部通过。Web 与 mock 进程组 37570 / 37573 已退出，58795 / 58796 无监听。此前失败启动的进程组也已清理。
- 独立测试者的真实 React 预览服务已停止，41739 无监听，owned build/server 进程已退出；临时依赖移至可恢复的 Trash 目录，临时 node_modules 链接已移除。没有使用日用浏览器或修改 tracked 依赖清单。

## 日用安装

已将固定候选合入 dev，分配版本 0.3.10.25（npm 0.3.10-local.25），从 dev 构建并打包。安装包为 `<repo>/ds-bot/ds-bot-0.3.10-local.25.tgz`。日用 desktop profile 已由 0.3.10-local.24 更新，包内全部 171 个文件与安装目录逐字节一致，包括客户端构建产物和本次宿主文件。原 DSH 后端仍运行，未重启或中断会话。当前窗口加载状态未核实；用户从 Dock 正常重启后可加载新版。此安装回执不代表已向企微发送文件。
