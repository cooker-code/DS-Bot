# 任务详情侧栏支持拖拽调整宽度

- DS Bot task：8d0b7a5f-ea53-43da-b643-a577d25986b9；计划v2节点2，round 2。
- 来源：原群消息 #123，intake-e29ce41c-1236-44d1-a9db-b9677ebe940e。
- 用户原文：「这个侧边栏不能拖动，我想要侧边栏 可以拖动变大」。
- 原截图只读，sha256：ce52a36ae52b01e2f017f82cb0167e8c84f75641d4aede885e0709825095d7de，246×865。图中任务详情左边界，不是应用左导航。
- 分支：feat/task-detail-resize；干净基线：7d7821e3bc7f966abdbdc60fc114efe7f05b680a。

## 当前行为与最小缺口

BotPanel已有左拖增宽/右拖缩小实现，不能声称原来没有拖动。静态证实details上限520、命中区8px、拖动中布局变化缺少主动清理；截图缺viewport/room/overlay/加载版本，不能确定唯一运行根因。

采用已批准的共享details容器方案：任务详情、群概览、Bot详情共同受益，不扩展父层taskId协议。默认320、MIN_CHAT=420；details范围320..max(320,room−420)。browser默认520、最小360和原上限不变；side保持原320..min(520,room−420)。窄屏overlay不显示拖动柄，保持既有行为和上游#1776本地差异。

扩大边界命中区，维持主题细线和separator语义。释放、取消、丢capture、关闭/卸载、room/view/overlay/会话变化均结束本轮拖动，清理临时margin/transition/shield及监听，并安全释放capture、按当前布局钳制宽度。

## 验收

- 宽屏任务详情左拖能明显超过520，反向缩小，主聊天保留420；最小320。
- 重复拖动、边界、取消、lostcapture、拖中缩窗、关闭及卸载稳定，无临时样式/shield残留。
- 长中文/英文路径需求和验收换行，点击、编辑取消、滚动和返回正常；browser/side/左导航无回归。
- 针对测试、构建、生成一致性、针对lint、diff检查通过；独立真实Web按固定候选复验并记录页面尺寸、加载版本、pageErrors。

## 明确不做

不改任务业务/API/存储/开始时间卡/左导航/公共布局，不整批移植上游。卡顶及v1中dev集成是旧模板，已被v2功能分支交付规则取代：不合dev、不推送PR、不日用安装、不打包发布、不重启当前GUI。独测固定功能候选，经管理者认可即结单，集成与发布另行安排。

## 规范来源

AGENTS.md、CONTRIBUTING.md、docs/vision.md、docs/design/ui-standard.md、docs/plans/2026-10-21-btw.md、upstream-changelog.md #1776、.trellis/spec/frontend及guides。规范模板中待填写部分不据此虚构产品设计。未加载适用teach技能，PRODUCT.md并非本次实现门禁，不创建无必要的产品文件。
