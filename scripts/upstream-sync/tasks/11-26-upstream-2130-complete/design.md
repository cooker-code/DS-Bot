# 技术设计

使用本地 works 树，补 ref/status/rounds/worked、原始会话和派工身份。后台采用既有 openParts 的独立链，不替换前台；项目 UUID 仍只表示卡，work ID 表示执行。正式 delegate 复用原 message_bot 派工校验及附件，只新增协议登记。投递与 inflight 保存协议和父轮信息；静默缓冲、结果 outbox 通过现有 SQLite extra_json 事务持久化。状态投影给现有 input dock，增量提供 Continue/Cancel/Answer，不改布局和项目卡。项目 submit/approve 仍用现有服务和权限。
