# 开发自测

2026-11-20，节点 1 / 轮次 1。基线 e0d0a43ba40721395efd50e644c38ffb76f59dd9。

## 实现

- GroupOverview 的成员区域接入 MembersSection，以 room.id 作为组件 key，跨群重置为默认展开。
- 使用已有原创向下/向右 chevron，原生按钮提供键盘激活、aria-expanded、aria-controls 与可见焦点。
- 仅隐藏列表外容器，成员行保持挂载；全部停止保留在外部。
- 不改宿主、API、存储、成员操作；client.js 由构建生成。

## 环境与命令

Node v24.21.0。工作树起初没有依赖，第一次测试因缺少 esbuild 失败；npm ci 补齐后通过。初次 lint 缺少 oxlint；npm run harness 遇默认 npm 缓存 EPERM，使用工作树 node_modules 下隔离缓存补齐成功，未更改用户缓存所有权。

在 ds-bot 下执行：

- `npm test -- test/members-section.test.js test/member-status.test.js test/right-panel.test.js`：19/19 通过，0 失败。
- 新增测试覆盖默认展开、连续八次切换、箭头身份、ARIA 与隐藏状态、停止按钮不隐藏、子组件保留、空列表及独立挂载状态。
- `npm run lint`：退出 0；76 条已有区域警告，0 errors；本次新文件无警告。
- `npm run build`：退出 0。
- `node scripts/build-client.mjs --check`：退出 0。
- `git diff --check`：退出 0。

## 尚未验证 / 部署

上述为组件树与相关回归测试，不是浏览器键盘或布局实测。隔离 Web 实际交互由后续独立节点验证。未启动服务、未操作日用实例、未打包安装、未加载新版、未推送或合并。生成产物包含 bundler 标识重排，已通过重新构建一致性检查。
