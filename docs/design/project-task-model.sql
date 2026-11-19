-- 项目任务拟采用的 SQLite 表结构，可在空库中验证。现有插件读取 state.json 和消息账本。
-- 原文和附件按群消息序号引用。共享待办沿用群记录，不在本模型内。
PRAGMA foreign_keys = ON;

-- 群、收件、需求主卡和实际派工沿用 DS Bot 标识，时间均为 Unix 毫秒。
CREATE TABLE project_room (
    room_id       TEXT PRIMARY KEY NOT NULL,
    admin_bot_id  TEXT
);

CREATE TABLE project_card (
    task_id     TEXT PRIMARY KEY NOT NULL,
    room_id     TEXT NOT NULL REFERENCES project_room(room_id),
    title       TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    acceptance  TEXT NOT NULL CHECK (length(trim(acceptance)) BETWEEN 1 AND 2000),
    UNIQUE (room_id, task_id)
);

-- 待受理时 task_id 为空。复合外键保证追加需求时，原消息和卡属于同一个群。
CREATE TABLE project_intake (
    room_id    TEXT NOT NULL REFERENCES project_room(room_id),
    intake_id  TEXT NOT NULL,
    task_id    TEXT,
    disposition TEXT NOT NULL DEFAULT 'received'
        CHECK (disposition IN ('received', 'clarify', 'linked', 'dismissed')),
    handling_note TEXT, -- 等待澄清的问题、无需派工或转交失败的说明
    PRIMARY KEY (room_id, intake_id),
    FOREIGN KEY (room_id, task_id) REFERENCES project_card(room_id, task_id),
    CHECK ((disposition = 'linked') = (task_id IS NOT NULL))
);

-- 此行仅定位群账本里的用户原消息。原文与 images/files 附件引用从该行读取。
CREATE TABLE intake_message (
    room_id    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    intake_id  TEXT NOT NULL,
    PRIMARY KEY (room_id, seq),
    FOREIGN KEY (room_id, intake_id) REFERENCES project_intake(room_id, intake_id)
);

-- 管理员受理时与主卡、节点、依赖一起提交第一版计划。后续改计划留版本和原因。
CREATE TABLE project_plan (
    task_id       TEXT NOT NULL REFERENCES project_card(task_id),
    plan_version  INTEGER NOT NULL CHECK (plan_version >= 1),
    planned_by    TEXT NOT NULL,
    planned_at    INTEGER NOT NULL,
    change_reason TEXT,
    PRIMARY KEY (task_id, plan_version),
    CHECK (plan_version = 1 OR nullif(trim(change_reason), '') IS NOT NULL)
);

-- 一个节点是一项能独立派给 Bot、能核对交付物的工作。预定负责人在受理时填写。
CREATE TABLE project_plan_node (
    task_id       TEXT NOT NULL,
    plan_version  INTEGER NOT NULL,
    node_no       INTEGER NOT NULL CHECK (typeof(node_no) = 'integer' AND node_no > 0),
    title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
    owner_bot_id  TEXT NOT NULL,
    instructions  TEXT NOT NULL CHECK (length(trim(instructions)) > 0),
    deliverable   TEXT NOT NULL CHECK (length(trim(deliverable)) > 0),
    acceptance    TEXT NOT NULL CHECK (length(trim(acceptance)) > 0),
    repository    TEXT,   -- 工程节点的仓库、基线、工作分支／检出版本、工作目录和环境
    base_ref      TEXT,
    work_ref      TEXT,
    work_dir      TEXT,
    environment   TEXT,
    context_gap   TEXT,   -- 管理员已知尚须确认的条件，挂起此节点
    PRIMARY KEY (task_id, plan_version, node_no),
    UNIQUE (task_id, plan_version, node_no, owner_bot_id),
    FOREIGN KEY (task_id, plan_version) REFERENCES project_plan(task_id, plan_version)
);

-- 同卡同版内按拓扑顺序编号，所有边由小号指向大号，从而排除自环和间接环。
-- 编号相邻不构成依赖；仅此表中的边要求交付前置产物。
CREATE TABLE project_plan_dependency (
    task_id        TEXT NOT NULL,
    plan_version   INTEGER NOT NULL,
    predecessor_no INTEGER NOT NULL,
    successor_no   INTEGER NOT NULL,
    PRIMARY KEY (task_id, plan_version, predecessor_no, successor_no),
    FOREIGN KEY (task_id, plan_version, predecessor_no)
        REFERENCES project_plan_node(task_id, plan_version, node_no),
    FOREIGN KEY (task_id, plan_version, successor_no)
        REFERENCES project_plan_node(task_id, plan_version, node_no),
    CHECK (predecessor_no < successor_no)
);

CREATE TABLE project_round (
    task_id       TEXT NOT NULL REFERENCES project_card(task_id),
    round_no      INTEGER NOT NULL CHECK (round_no >= 1),
    owner_bot_id  TEXT NOT NULL,
    plan          TEXT NOT NULL CHECK (length(trim(plan)) BETWEEN 1 AND 4000),
    dispatch_id   TEXT NOT NULL UNIQUE,  -- 指派时预留，派工落账后可关联真实 exchangeId
    assigned_at   INTEGER NOT NULL,
    sent_at       INTEGER,
    started_at    INTEGER,
    submitted_at  INTEGER,
    result        TEXT,
    plan_version  INTEGER,  -- 导入的旧轮次缺少计划归属；新派工须指定完整节点
    node_no       INTEGER,
    expected_commit TEXT,   -- 派工时由计划基线或上游交付解析的具体提交
    actual_repo   TEXT,     -- 开工检查所见，和节点上受理时填写的预期值分开
    actual_ref    TEXT,
    actual_commit TEXT,
    actual_dir    TEXT,
    actual_env    TEXT,
    progress      TEXT,
    progress_at   INTEGER,
    blocked_reason TEXT,
    waiting_for   TEXT,
    accepted_at   INTEGER,  -- 管理员核实本轮产物可交下游的时间；人工终验见 project_acceptance
    PRIMARY KEY (task_id, round_no),
    FOREIGN KEY (task_id, plan_version, node_no, owner_bot_id)
        REFERENCES project_plan_node(task_id, plan_version, node_no, owner_bot_id),
    CHECK ((plan_version IS NULL) = (node_no IS NULL)),
    CHECK (accepted_at IS NULL OR submitted_at IS NOT NULL),
    CHECK ((progress IS NULL) = (progress_at IS NULL)),
    CHECK ((result IS NULL AND submitted_at IS NULL) OR
           (result IS NOT NULL AND length(trim(result)) BETWEEN 1 AND 4000
            AND started_at IS NOT NULL AND submitted_at IS NOT NULL))
);

-- 重试与终验沿用原模型。经派工轮次可查回其所属计划版本和节点。
-- 每行代表实际开始的一次尝试。再次执行同一步才增加 attempt_no。
CREATE TABLE project_attempt (
    task_id           TEXT NOT NULL,
    round_no          INTEGER NOT NULL,
    step_key          TEXT NOT NULL,
    attempt_no        INTEGER NOT NULL CHECK (attempt_no >= 1),
    execution_id      TEXT NOT NULL UNIQUE,  -- 标记一次步骤执行，重复回执沿用同一 ID
    started_at        INTEGER NOT NULL,
    retry_reason      TEXT,                 -- 本次再次执行的依据
    ended_at          INTEGER,
    outcome           TEXT CHECK (outcome IN ('succeeded', 'failed')),
    error_text        TEXT,
    evidence_ref      TEXT,                 -- 该次执行记录、日志或产物的定位信息
    follow_up         TEXT CHECK (follow_up IN ('retry_planned', 'blocked')),
    follow_up_reason  TEXT,                 -- 失败后为什么待重试或交由管理员
    PRIMARY KEY (task_id, round_no, step_key, attempt_no),
    FOREIGN KEY (task_id, round_no) REFERENCES project_round(task_id, round_no),
    CHECK ((attempt_no = 1 AND retry_reason IS NULL) OR
           (attempt_no > 1 AND retry_reason IS NOT NULL AND length(trim(retry_reason)) > 0)),
    CHECK ((ended_at IS NULL AND outcome IS NULL AND error_text IS NULL) OR
           (ended_at IS NOT NULL AND outcome IS NOT NULL AND
            ((outcome = 'succeeded' AND error_text IS NULL) OR
             (outcome = 'failed' AND error_text IS NOT NULL AND length(trim(error_text)) > 0)))),
    CHECK ((follow_up IS NULL AND follow_up_reason IS NULL) OR
           (follow_up IS NOT NULL AND outcome IS NOT NULL AND outcome = 'failed'
            AND follow_up_reason IS NOT NULL AND length(trim(follow_up_reason)) > 0))
);

-- 管理员为已交付的一轮送验，把人的决定绑定到当次展示的版本或产物。
-- 退回后在原卡开新轮。宿主核对当前轮及用户身份，并以仅首次决定可写的条件更新。
CREATE TABLE project_acceptance (
    task_id       TEXT NOT NULL,
    round_no      INTEGER NOT NULL,
    requested_by  TEXT NOT NULL,  -- 送验时的管理员 Bot ID
    requested_at  INTEGER NOT NULL,
    artifact_ref  TEXT NOT NULL CHECK (length(trim(artifact_ref)) > 0),
    verify_steps  TEXT NOT NULL CHECK (length(trim(verify_steps)) > 0),
    decision      TEXT CHECK (decision IN ('accepted', 'returned')),
    decided_at    INTEGER,
    return_reason TEXT,
    PRIMARY KEY (task_id, round_no),
    FOREIGN KEY (task_id, round_no) REFERENCES project_round(task_id, round_no),
    CHECK ((decision IS NULL AND decided_at IS NULL AND return_reason IS NULL) OR
           (decision IS NOT NULL AND decided_at IS NOT NULL AND
            ((decision = 'accepted' AND return_reason IS NULL) OR
             (decision = 'returned' AND return_reason IS NOT NULL AND length(trim(return_reason)) > 0))))
);
