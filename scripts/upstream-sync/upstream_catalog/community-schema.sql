-- designs：按功能设计主题保存中文判断资料与当前来源版本
CREATE TABLE designs (
 id INTEGER PRIMARY KEY, -- 稳定主题ID，改名保持
 repo_id INTEGER NOT NULL REFERENCES sources(repo_id), -- 来源仓库
 path TEXT NOT NULL, -- 当前设计路径
 title TEXT NOT NULL, -- 中文功能名称
 kind TEXT NOT NULL DEFAULT 'design', -- design或index
 document_state TEXT NOT NULL DEFAULT 'active', -- active或deleted
 blob_sha TEXT NOT NULL, -- 当前设计内容对象
 source_sha TEXT NOT NULL, -- 固定来源提交
 changed_at TEXT NOT NULL, -- 上游变更时间
 synced_at TEXT NOT NULL, -- 实际入库时间
 purpose TEXT, -- 功能用途与价值
 scenario TEXT, -- 具体使用场景
 limitations TEXT, -- 前置及限制
 upstream_stage TEXT NOT NULL DEFAULT '待核实', -- 上游实现阶段，独立于本地状态
 stage_evidence TEXT, -- 阶段判断依据
 local_notes TEXT, -- 本地适配注意事项
 scope TEXT NOT NULL DEFAULT 'plugin', -- plugin或excluded或mixed
 reviewed_blob_sha TEXT, -- 解释所核对的源内容
 needs_review INTEGER NOT NULL DEFAULT 1, -- 新版解释待补或待重审
 UNIQUE(repo_id,path)
);
-- design_versions：按内容去重的固定版本全文
CREATE TABLE design_versions (
 design_id INTEGER NOT NULL REFERENCES designs(id), -- 设计主题
 blob_sha TEXT NOT NULL, -- 内容版本
 source_sha TEXT NOT NULL, -- 可定位该全文的来源提交
 path TEXT NOT NULL, -- 该版本路径
 body TEXT NOT NULL, -- 不执行的原始Markdown全文
 captured_at TEXT NOT NULL, -- 首次缓存时间
 PRIMARY KEY(design_id,blob_sha)
);
-- pr_designs：设计变化与具体实现PR分开关联
CREATE TABLE pr_designs (
 repo_id INTEGER NOT NULL, -- 来源仓库
 pr_number INTEGER NOT NULL, -- PR号
 design_id INTEGER NOT NULL REFERENCES designs(id), -- 主题
 role TEXT NOT NULL, -- design_change或implementation
 change_kind TEXT NOT NULL, -- A/M/D/R或related
 path TEXT NOT NULL, -- 该PR中的路径
 previous_path TEXT, -- 重命名前路径
 source_sha TEXT NOT NULL, -- PR合入SHA
 blob_sha TEXT NOT NULL, -- PR设计全文版本
 PRIMARY KEY(repo_id,pr_number,design_id,role),
 FOREIGN KEY(repo_id,pr_number) REFERENCES prs(repo_id,number)
);
CREATE INDEX pr_designs_by_design ON pr_designs(design_id);
