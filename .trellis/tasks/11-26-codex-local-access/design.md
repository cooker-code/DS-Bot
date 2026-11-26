# 后门（Backdoor）· 设计

产品行为与后续扩展入口见 [后门设计](../../../docs/plans/2026-11-26-backdoor.md)。

调用链为 Codex → Python 请求脚本 → 账户私有 Unix socket → 操作/字段白名单 → `rt.channelCall` → 现有服务和团队存储。新增宿主模块在原 channel 安装后注册受上下文管理的资源，不改变原 HTTP 认证。

授权文件和发现文件位于团队 `local-access/`，发现文件指向短路径 `/tmp/ds-bot-operator-<uid>/<pid>-<uuid>.sock`，避免 macOS Unix socket 路径长度限制。启停文件变化串行处理；每个请求在正文读取后再检查授权。客户端以写锁 PID 核实发现文件。

当前范围不依赖上游 #2016 的 Run/MCP/推理接口，也不恢复 #1919 的旧网关；二者保持既有状态。允许的管理动作复用原分派，避免新建另一套业务存储或写锁。
