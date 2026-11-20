-- 二期早期设计草案。已交付的计划、节点派工、阻塞和恢复表以 project-task-model.sql 为准。
-- 本稿用于讨论后续尝试与终验字段，不是现有群库上的升级脚本。
-- 当前 JSON 导入不生成以下记录。task_pk 引用 tasks 的数据库行键，群里仍用原任务 ID。
PRAGMA foreign_keys = ON;

CREATE TABLE task_plans (
    task_pk       INTEGER NOT NULL REFERENCES tasks(task_pk),
    plan_version  INTEGER NOT NULL CHECK (plan_version >= 1),
    planned_by    TEXT NOT NULL,
    planned_at    INTEGER NOT NULL,
    change_reason TEXT,
    PRIMARY KEY (task_pk, plan_version),
    CHECK (plan_version = 1 OR nullif(trim(change_reason), '') IS NOT NULL)
);

-- 一个节点是一项能独立派给 Bot、能核对交付物的工作。预定负责人在受理时填写。
CREATE TABLE task_plan_nodes (
    task_pk       INTEGER NOT NULL,
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
    PRIMARY KEY (task_pk, plan_version, node_no),
    UNIQUE (task_pk, plan_version, node_no, owner_bot_id),
    FOREIGN KEY (task_pk, plan_version) REFERENCES task_plans(task_pk, plan_version)
);

-- 同卡同版内按拓扑顺序编号，所有边由小号指向大号，从而排除自环和间接环。
-- 编号相邻不构成依赖；仅此表中的边要求交付前置产物。
CREATE TABLE task_plan_dependencies (
    task_pk        INTEGER NOT NULL,
    plan_version   INTEGER NOT NULL,
    predecessor_no INTEGER NOT NULL,
    successor_no   INTEGER NOT NULL,
    PRIMARY KEY (task_pk, plan_version, predecessor_no, successor_no),
    FOREIGN KEY (task_pk, plan_version, predecessor_no)
        REFERENCES task_plan_nodes(task_pk, plan_version, node_no),
    FOREIGN KEY (task_pk, plan_version, successor_no)
        REFERENCES task_plan_nodes(task_pk, plan_version, node_no),
    CHECK (predecessor_no < successor_no)
);

-- 一条真正派出的轮次可关联到一个计划节点。原轮次（包括结果与负责人）只存于 task_rounds。
-- 正式派工时，宿主还须核对轮次上的实际接手人及节点的预定人选。
CREATE TABLE task_round_plans (
    task_pk         INTEGER NOT NULL,
    round_no        INTEGER NOT NULL,
    plan_version    INTEGER NOT NULL,
    node_no         INTEGER NOT NULL,
    expected_commit TEXT,
    actual_repo     TEXT,
    actual_ref      TEXT,
    actual_commit   TEXT,
    actual_dir      TEXT,
    actual_env      TEXT,
    progress        TEXT,
    progress_at     INTEGER,
    blocked_reason  TEXT,
    waiting_for     TEXT,
    accepted_at     INTEGER,
    PRIMARY KEY (task_pk, round_no),
    FOREIGN KEY (task_pk, round_no) REFERENCES task_rounds(task_pk, round_no),
    FOREIGN KEY (task_pk, plan_version, node_no)
        REFERENCES task_plan_nodes(task_pk, plan_version, node_no),
    CHECK ((progress IS NULL) = (progress_at IS NULL))
);

-- 步骤执行与人工验收沿用第二阶段草案，均引用同一实际轮次。
CREATE TABLE task_attempts (
    task_pk           INTEGER NOT NULL,
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
    PRIMARY KEY (task_pk, round_no, step_key, attempt_no),
    FOREIGN KEY (task_pk, round_no) REFERENCES task_rounds(task_pk, round_no),
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
CREATE TABLE task_acceptances (
    task_pk       INTEGER NOT NULL,
    round_no      INTEGER NOT NULL,
    requested_by  TEXT NOT NULL,  -- 送验时的管理员 Bot ID
    requested_at  INTEGER NOT NULL,
    artifact_ref  TEXT NOT NULL CHECK (length(trim(artifact_ref)) > 0),
    verify_steps  TEXT NOT NULL CHECK (length(trim(verify_steps)) > 0),
    decision      TEXT CHECK (decision IN ('accepted', 'returned')),
    decided_at    INTEGER,
    return_reason TEXT,
    PRIMARY KEY (task_pk, round_no),
    FOREIGN KEY (task_pk, round_no) REFERENCES task_rounds(task_pk, round_no),
    CHECK ((decision IS NULL AND decided_at IS NULL AND return_reason IS NULL) OR
           (decision IS NOT NULL AND decided_at IS NOT NULL AND
            ((decision = 'accepted' AND return_reason IS NULL) OR
             (decision = 'returned' AND return_reason IS NOT NULL AND length(trim(return_reason)) > 0))))
);
