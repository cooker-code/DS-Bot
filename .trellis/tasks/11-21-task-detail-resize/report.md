# 节点2开发候选与自测

## 版本与交付边界

- task：8d0b7a5f-ea53-43da-b643-a577d25986b9，v2节点2，round 2。
- feat/task-detail-resize，基线7d7821e3bc7f966abdbdc60fc114efe7f05b680a，开工tracked/untracked干净。
- 此报告与源码/生成物同提交；最终完整候选SHA记于本卡round2 submit，避免文档自引用提交hash。
- 未合dev、未推送PR、未安装日用profile、未发布/重启。当前GUI未更新；未核对其watcher或网络加载，不能声称当前GUI已生效。

## 实现

- panel-width.js统一默认值、范围、钳制、方向计算；仅details解除520限制。room1200时范围320..780；browser/side原范围保持。
- browser-pane.js沿用真实BotPanel入口、原共享localStorage键、即时inline拖动；加入活动拖动引用及当前布局引用，layout effect在view/room/leaving/overlay/pane.id变化与卸载时主动收尾。
- trackPanelResize统一pointerup/cancel/lostcapture及主动取消；过滤其他pointer，幂等移除监听和释放capture，capture失败也结束。收尾按当前范围钳制，移除临时panel width/column margin/transition，解除hold和拖动态。
- styles.js将grip从8px扩至16px、左右各约8px，保留2px主题细线、separator语义、触摸行为。未重写任务字段或其现有wrap样式。
- client.js由npm run build生成，未手改。

## 实际验证

Node v24.21.0、npm 11.12.1。

在ds-bot目录：

1. `npm test -- test/panel-width.test.js test/frame-layout.test.js`：39/39通过。
2. `DSH_HARNESS=/Users/<user>/wangliang/gitcode/DS-Bot/ds-bot/dev/harness npm test -- test/panel-width.test.js test/frame-layout.test.js test/browser-pane.test.js test/right-panel.test.js test/side-panel.test.js`：49/49通过，0 fail/skip。
3. `npm run build`：通过。
4. `node scripts/build-client.mjs --check`：通过。
5. `DSH_HARNESS=/Users/<user>/wangliang/gitcode/DS-Bot/ds-bot/dev/harness npm run lint`：exit0；仓库原有其他文件warning，不混改。
6. 针对lint：根目录运行 `node /Users/<user>/wangliang/gitcode/DS-Bot/ds-bot/dev/harness/node_modules/oxlint/bin/oxlint -c ds-bot/.oxlintrc.json ds-bot/src/client/browser-pane.js ds-bot/src/client/styles.js ds-bot/src/client/panel-width.js ds-bot/test/panel-width.test.js`：exit0，无输出。
7. `git diff --check`：通过。

新增7例覆盖：details超过旧520/420余宽、browser与side保留原范围、最小/最大及四舍五入、左增右减；pointerup最终位置；cancel/lostcapture/主动layout-unmount结束的幂等监听清理、释放capture、其他pointer过滤；capture失败无监听泄漏。

环境修复记录：首次构建因工作树无esbuild失败，`npm ci --no-audit --no-fund`安装69包后恢复。首次lint缺oxlint；尝试npm run harness因用户npm cache权限EPERM失败，未修改用户缓存权限；复用主工作区已有dev/harness后lint及回归通过。未引入依赖/锁文件改动。

## 未完成的运行时验收（交独立测试，不冒称通过）

本节点完成源码入口核对、范围/事件控制器自测、构建和静态检查，未完成真实DSH Web从群详情→任务看板→任务详情的鼠标端到端验证。因此不能把上述自动测试当成页面实际交互或长内容验收通过，也不能确定原截图唯一运行原因。

独立测试须固定本卡submit候选SHA，记录viewport/room/overlay和client.js网络产物：左拖超过520及反向缩小/主聊天420、宽度保存、重复/取消/lostcapture、拖中缩窗、关闭/卸载及overlay恢复；确认临时margin/transition/shield无残留。复验长中文/英文路径换行、编辑取消、滚动/点击/返回、browser/side/左导航无回归、pageErrors为空；附同版真实Web截图与报告。独立测试只读，不合dev。
