# 实现与验证

1. 新增 model-fast 服务与 HTTP 转发，接入 providers / channel。
2. 复用 ProvidersPage 和 Switch，添加中文翻译；更新 API 和模型设计。
3. 测试真实本机 HTTP 转发、开关、保存失败、重启、清理及 UI 状态；运行受影响 provider / storage 测试、构建一致性、lint、API 覆盖。
4. 使用隔离 DSH 台架冒烟及界面核查，记录测试环境和清理。
5. 提交固定候选，独立测试者只读验收，将证据写回此任务；验证通过后合并 dev。
