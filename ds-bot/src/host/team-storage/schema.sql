-- 团队状态数据库。每个团队一个 team.sqlite，建库与历史导入在同一事务内提交。
-- 由旧属性映射的列，注释以原 JSON 键名开头。导入和还原规则见团队 SQLite 存储设计。
-- 时间为 Unix 毫秒；布尔列 0/1；*_json 业务列完整保存对应原键的结构化值。
-- shape_json 仅记录显式 null、已拆容器的类型及项目状态的派生标记。
-- extra_json 仅保存本层未建模的原键。下方约束禁止它与普通列或子表重名。
PRAGMA foreign_keys = ON;

-- 团队根记录。只把 bots 和 rooms 两个映射拆到各自的表。
CREATE TABLE team_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), -- 本库唯一团队，固定为 1。
    version INTEGER, -- version · 团队状态格式版本。
    revision INTEGER, -- revision · 团队状态修订号，随保存推进。
    workspace_id TEXT, -- workspaceId · DSH 工作区 ID。
    main_bot_ids_json TEXT CHECK (main_bot_ids_json IS NULL OR json_valid(main_bot_ids_json)), -- mainBotIds · 有序主 Bot 编号列表。
    private_archives_json TEXT CHECK (private_archives_json IS NULL OR json_valid(private_archives_json)), -- privateArchives · 私有 Bot 的归档及历史会话。
    agents_json TEXT CHECK (agents_json IS NULL OR json_valid(agents_json)), -- agents · 独立智能体名册。
    sections_json TEXT CHECK (sections_json IS NULL OR json_valid(sections_json)), -- sections · 侧边栏分组及原排列。
    capabilities_json TEXT CHECK (capabilities_json IS NULL OR json_valid(capabilities_json)), -- capabilities · 团队能力和条目配置。
    exchanges_json TEXT CHECK (exchanges_json IS NULL OR json_valid(exchanges_json)), -- exchanges · 旧 Bot 往来记录及缓存。
    exchange_turns_json TEXT CHECK (exchange_turns_json IS NULL OR json_valid(exchange_turns_json)), -- exchangeTurns · 会话与往来轮次的索引。
    works_json TEXT CHECK (works_json IS NULL OR json_valid(works_json)), -- works · 已登记的工作交接。
    abandoned_works_json TEXT CHECK (abandoned_works_json IS NULL OR json_valid(abandoned_works_json)), -- abandonedWorks · 已放弃的工作交接。
    requests_json TEXT CHECK (requests_json IS NULL OR json_valid(requests_json)), -- requests · 请求去重记录和回执。
    room_batches_json TEXT CHECK (room_batches_json IS NULL OR json_valid(room_batches_json)), -- roomBatches · 群内批次及恢复信息。
    questions_json TEXT CHECK (questions_json IS NULL OR json_valid(questions_json)), -- questions · 各会话的提问记录。
    views_json TEXT CHECK (views_json IS NULL OR json_valid(views_json)), -- views · 各会话展示的视图。
    closed_cards_json TEXT CHECK (closed_cards_json IS NULL OR json_valid(closed_cards_json)), -- closedCards · 已关闭的界面卡片。
    prefs_json TEXT CHECK (prefs_json IS NULL OR json_valid(prefs_json)), -- prefs · 团队偏好设置。
    switching_json TEXT CHECK (switching_json IS NULL OR json_valid(switching_json)), -- switching · 会话分段切换中的状态。
    computer_json TEXT CHECK (computer_json IS NULL OR json_valid(computer_json)), -- computer · 团队电脑操作配置。
    connectors_json TEXT CHECK (connectors_json IS NULL OR json_valid(connectors_json)), -- connectors · 连接器设置。
    connector_requests_json TEXT CHECK (connector_requests_json IS NULL OR json_valid(connector_requests_json)), -- connectorRequests · 连接器授权请求。
    mail_requests_json TEXT CHECK (mail_requests_json IS NULL OR json_valid(mail_requests_json)), -- mailRequests · 邮件操作请求。
    secret_requests_json TEXT CHECK (secret_requests_json IS NULL OR json_valid(secret_requests_json)), -- secretRequests · 凭证使用请求记录。
    im_json TEXT CHECK (im_json IS NULL OR json_valid(im_json)), -- im · 即时通信连接设置。
    local_agents_json TEXT CHECK (local_agents_json IS NULL OR json_valid(local_agents_json)), -- localAgents · 本地智能体及其会话路由。
    whale_stored INTEGER CHECK (whale_stored IN (0, 1)), -- whaleStored · 初始角色形象是否已经保存。
    legacy_main_bot_id TEXT, -- mainBotId · 旧版单主 Bot 编号。
    legacy_closed_views_json TEXT CHECK (legacy_closed_views_json IS NULL OR json_valid(legacy_closed_views_json)), -- closedViews · 旧版已关闭视图。
    legacy_btw_cards_json TEXT CHECK (legacy_btw_cards_json IS NULL OR json_valid(legacy_btw_cards_json)), -- btwCards · 旧版旁支对话卡片。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object') -- 仅本层未知扩展属性。
) STRICT;

-- Bot 名册。保留原映射键和原对象的 id，即使两者不同。
CREATE TABLE bots (
    bot_id TEXT PRIMARY KEY NOT NULL, -- 原 bots 映射键，继续用于成员及历史引用。
    team_id INTEGER NOT NULL DEFAULT 1 REFERENCES team_state(singleton), -- 所属团队。
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0), -- 名册中的原枚举位置。
    source_id TEXT, -- id · Bot 对象内原有的 ID，独立保留它与映射键的差异。
    name TEXT, -- name · 显示名称。
    role TEXT, -- role · 角色标签。
    instructions TEXT, -- instructions · 角色指令。
    color TEXT, -- color · 角色颜色。
    avatar_json TEXT CHECK (avatar_json IS NULL OR json_valid(avatar_json)), -- avatar · 角色形象属性。
    model TEXT, -- model · 设置的模型引用。
    effort TEXT, -- effort · 推理强度设置。
    applied_model TEXT, -- appliedModel · 会话上实际应用的模型。
    applied_effort TEXT, -- appliedEffort · 会话上实际应用的推理强度。
    section_id TEXT, -- sectionId · 侧边栏分组。
    work_dir TEXT, -- workDir · Bot 的工作目录。
    created_by TEXT, -- createdBy · 创建者 Bot ID。
    created_at INTEGER, -- createdAt · 创建时间。
    capabilities_json TEXT CHECK (capabilities_json IS NULL OR json_valid(capabilities_json)), -- capabilities · Bot 使用的能力列表。
    permission TEXT, -- permission · 权限预设。
    pinned INTEGER CHECK (pinned IN (0, 1)), -- pinned · 侧边栏置顶标记。
    is_private INTEGER CHECK (is_private IN (0, 1)), -- private · 私有 Bot 标记。
    hidden INTEGER CHECK (hidden IN (0, 1)), -- hidden · 隐藏标记。
    computer_json TEXT CHECK (computer_json IS NULL OR json_valid(computer_json)), -- computer · 电脑操作权限和应用授权。
    browser_grants_json TEXT CHECK (browser_grants_json IS NULL OR json_valid(browser_grants_json)), -- browserGrants · 浏览器授权。
    session_id TEXT, -- sessionId · 当前私聊会话段 ID。
    segments_json TEXT CHECK (segments_json IS NULL OR json_valid(segments_json)), -- segments · 已归档的会话分段。
    open_parts_json TEXT CHECK (open_parts_json IS NULL OR json_valid(open_parts_json)), -- openParts · 其他已打开的会话分段。
    kickoff_json TEXT CHECK (kickoff_json IS NULL OR json_valid(kickoff_json)), -- kickoff · 待投递的首次或变更指令。
    blocked_json TEXT CHECK (blocked_json IS NULL OR json_valid(blocked_json)), -- blocked · 模型调用阻塞信息。
    failures_json TEXT CHECK (failures_json IS NULL OR json_valid(failures_json)), -- failures · 记录的会话失败。
    legacy_lab_json TEXT CHECK (legacy_lab_json IS NULL OR json_valid(legacy_lab_json)), -- lab · 旧版实验室设置。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object') -- 仅本层未知扩展属性。
) STRICT;

-- 一个群一行。members、todos、tasks、projectCards 拆成有序子记录。
CREATE TABLE rooms (
    room_id TEXT PRIMARY KEY NOT NULL, -- 原 rooms 映射键，群换段后仍使用。
    team_id INTEGER NOT NULL DEFAULT 1 REFERENCES team_state(singleton), -- 群所属团队。
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0), -- 群的原枚举位置。
    source_id TEXT, -- id · 群对象内原有的 ID。
    name TEXT, -- name · 当前群名。
    pinned INTEGER CHECK (pinned IN (0, 1)), -- pinned · 侧边栏置顶标记。
    hidden INTEGER CHECK (hidden IN (0, 1)), -- hidden · 侧边栏隐藏标记。
    named INTEGER CHECK (named IN (0, 1)), -- named · 是否自定义群名，未指定时按成员自动命名。
    notice TEXT, -- notice · 群公告全文，保留原有路由标记。
    admin_bot_id TEXT, -- admin · 群管理员 Bot ID，可为空。
    mode TEXT, -- mode · 普通消息的回复方式，admin 为管理员优先，everyone 为成员轮流回复。
    section_id TEXT, -- sectionId · 侧边栏分组 ID。
    work_dir TEXT, -- workDir · 群共用工作目录。
    permission TEXT, -- permission · 群会话权限预设。
    created_by TEXT, -- createdBy · 建群 Bot ID；用户建群时可为 null。
    created_at INTEGER, -- createdAt · 建群时间。
    session_id TEXT, -- sessionId · 群当前会话段 ID，宿主在缺键时用群 ID。
    last_seq INTEGER, -- seq · 群状态已记录的最新消息序号。
    goal_json TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)), -- goal · 当前群目标及阶段、分工和条件。
    past_goals_json TEXT CHECK (past_goals_json IS NULL OR json_valid(past_goals_json)), -- pastGoals · 历史群目标，保留顺序。
    parts_json TEXT CHECK (parts_json IS NULL OR json_valid(parts_json)), -- parts · 群自身的历史会话分段。
    sessions_json TEXT CHECK (sessions_json IS NULL OR json_valid(sessions_json)), -- sessions · 成员 Bot ID 到当前群会话的映射。
    segments_json TEXT CHECK (segments_json IS NULL OR json_valid(segments_json)), -- segments · 各成员的历史群会话分段。
    member_dirs_json TEXT CHECK (member_dirs_json IS NULL OR json_valid(member_dirs_json)), -- memberDirs · 各成员在本群的工作目录。
    seen_json TEXT CHECK (seen_json IS NULL OR json_valid(seen_json)), -- seen · 各成员已读的群消息序号。
    log_json TEXT CHECK (log_json IS NULL OR json_valid(log_json)), -- log · 近期群消息缓存，原文仍可查账本。
    task_queue_json TEXT CHECK (task_queue_json IS NULL OR json_valid(task_queue_json)), -- taskQueue · 本群等待处理的任务消息。
    paused_json TEXT CHECK (paused_json IS NULL OR json_valid(paused_json)), -- paused · 暂挂的群调用。
    idle_paused_json TEXT CHECK (idle_paused_json IS NULL OR json_valid(idle_paused_json)), -- idlePaused · 空闲自动暂停信息。
    idle_relays INTEGER, -- idleRelays · 空闲期间的转发次数。
    folder_notice TEXT, -- folderNotice · 已通知过成员的工作目录。
    legacy_bot_rounds_json TEXT CHECK (legacy_bot_rounds_json IS NULL OR json_valid(legacy_bot_rounds_json)), -- botRounds · 旧版 Bot 回合记录。
    legacy_late_rounds_json TEXT CHECK (legacy_late_rounds_json IS NULL OR json_valid(legacy_late_rounds_json)), -- lateRounds · 旧版延迟回合记录。
    legacy_quiet_noticed_json TEXT CHECK (legacy_quiet_noticed_json IS NULL OR json_valid(legacy_quiet_noticed_json)), -- quietNoticed · 旧版安静状态通知标记。
    legacy_quiet_shown_json TEXT CHECK (legacy_quiet_shown_json IS NULL OR json_valid(legacy_quiet_shown_json)), -- quietShown · 旧版安静状态展示标记。
    legacy_relays_json TEXT CHECK (legacy_relays_json IS NULL OR json_valid(legacy_relays_json)), -- relays · 旧版转发记录。
    legacy_relay_limit_json TEXT CHECK (legacy_relay_limit_json IS NULL OR json_valid(legacy_relay_limit_json)), -- relayLimit · 旧版转发上限。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object') -- 仅本层未知扩展属性。
) STRICT;

-- 成员列表是有序的 Bot ID 数组，原元素没有对象属性。
CREATE TABLE room_members (
    room_id TEXT NOT NULL REFERENCES rooms(room_id), -- 成员所属群。
    position INTEGER NOT NULL CHECK (position >= 0), -- members 原数组下标。
    bot_id TEXT NOT NULL, -- 原成员 ID，通过左连接可查当前名册。
    PRIMARY KEY (room_id, position)
) STRICT;

-- 共享待办保持自己的列表、编号和勾选状态。
CREATE TABLE room_todos (
    room_id TEXT NOT NULL REFERENCES rooms(room_id), -- 待办所属群。
    position INTEGER NOT NULL CHECK (position >= 0), -- 原待办数组下标。
    todo_id TEXT, -- id · 清单上的原编号。
    text TEXT, -- text · 一行待办内容。
    done INTEGER CHECK (done IN (0, 1)), -- done · 完成标记，1 为已勾选，0 为未完成。
    created_by TEXT, -- createdBy · 创建者标识。
    created_at INTEGER, -- createdAt · 创建时间。
    done_by TEXT, -- doneBy · 最后勾选的成员或用户标识。
    done_at INTEGER, -- doneAt · 勾选时间。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object'), -- 仅本层未知扩展属性。
    PRIMARY KEY (room_id, position)
) STRICT;

-- 群中两类任务。保留原业务键与本库行键；成员的 goal 和项目的 title 分列。
CREATE TABLE tasks (
    task_pk INTEGER PRIMARY KEY, -- 库内任务连接键。
    room_id TEXT NOT NULL REFERENCES rooms(room_id), -- 任务所属群。
    source_kind TEXT NOT NULL CHECK (source_kind IN ('member', 'project')), -- member 由成员登记，project 由管理员指派。
    task_id TEXT NOT NULL, -- 原任务映射键，消息和工具继续用它定位。
    position INTEGER NOT NULL CHECK (position >= 0), -- 在本群同来源映射中的原位置。
    source_id TEXT, -- id · 任务对象中的原 ID。
    goal TEXT, -- goal · 成员登记的工作目标或用户编辑后的项目需求。
    title TEXT, -- title · 项目任务标题。
    bot_id TEXT, -- botId · 成员任务的登记者及执行者；项目执行者记录在实际轮次。
    status TEXT, -- status · 当前状态；成员按原值，项目的迁移取值和持久化语义见存储计划。
    progress TEXT, -- progress · 最近进展文字。
    started_at INTEGER, -- startedAt · 成员任务开始时间。
    updated_at INTEGER, -- updatedAt · 成员任务最近更新时间或项目正文最近编辑时间。
    result TEXT, -- result · 成员任务完成结果。
    reason TEXT, -- reason · 取消原因。
    acceptance TEXT, -- acceptance · 项目任务的验收条件。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object'), -- 仅本层未知扩展属性。
    UNIQUE (room_id, source_kind, task_id),
    UNIQUE (room_id, source_kind, position)
) STRICT;

-- 原 projectCards[id].intakes 数组，每项为一个收件号，允许多个位置保留同一原值。
CREATE TABLE task_intakes (
    task_pk INTEGER NOT NULL REFERENCES tasks(task_pk), -- 收件归属的任务。
    position INTEGER NOT NULL CHECK (position >= 0), -- intakes 原数组下标。
    intake_id TEXT NOT NULL, -- 联结 tasks 取 room_id 后，在该群账本定位原消息。
    PRIMARY KEY (task_pk, position)
) STRICT;

-- 实际项目派工轮次，每轮独立读写，复合主键沿用原有轮次接口。
CREATE TABLE task_rounds (
    task_pk INTEGER NOT NULL REFERENCES tasks(task_pk), -- 派工轮次所属任务。
    round_no INTEGER NOT NULL CHECK (round_no >= 1), -- 从 1 开始，对应原数组下标加一。
    owner_bot_id TEXT, -- ownerId · 本轮实际执行 Bot 的编号。
    plan TEXT, -- plan · 本轮方案和交接要求，原值为文字。
    dispatch_id TEXT, -- dispatchId · 派工编号，关联往来记录的 exchangeId。
    assigned_at INTEGER, -- assignedAt · 管理员指派的时间。
    sent_at INTEGER, -- sentAt · 系统记录派工送达的时间。
    started_at INTEGER, -- startedAt · 执行 Bot 明确确认开工的时间。
    submitted_at INTEGER, -- submittedAt · 执行 Bot 提交本轮结果的时间。
    result TEXT, -- result · 本轮产物说明与核验结果。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object'), -- 仅本层未知扩展属性。
    PRIMARY KEY (task_pk, round_no)
) STRICT;

-- 原 tasks[id].notes 数组中的一条备注。
CREATE TABLE task_notes (
    task_pk INTEGER NOT NULL REFERENCES tasks(task_pk), -- 留言所属任务。
    position INTEGER NOT NULL CHECK (position >= 0), -- 原 notes 数组下标。
    noted_at INTEGER, -- at · 留言时间。
    author_id TEXT, -- by · 留言作者标识。
    text TEXT, -- text · 留言正文。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object'), -- 仅本层未知扩展属性。
    PRIMARY KEY (task_pk, position)
) STRICT;

-- 原 tasks[id].blocked 对象。只在有阻塞对象（包括空对象）时建行。
CREATE TABLE task_blocks (
    task_pk INTEGER PRIMARY KEY REFERENCES tasks(task_pk), -- 一个任务至多有一份当前阻塞记录。
    reported_by TEXT, -- by · 阻塞记录来源，如 system。
    cause TEXT, -- cause · 停止、重启或调用失败等原因。
    previous_status TEXT, -- from · 阻塞前的任务状态。
    blocked_at INTEGER, -- at · 发生阻塞的时间。
    error_code TEXT, -- code · 错误代码。
    error_status ANY CHECK (typeof(error_status) IN ('null', 'integer', 'text')), -- status · 调用失败返回的原始状态码，保留原类型。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object') -- 仅本层未知扩展属性。
) STRICT;

-- 导入、导出和直接写 extra_json 共用的已定义原键集合，含归入子表的键。
CREATE VIEW known_json_keys(entity, json_key) AS
WITH property_lists(entity, names) AS (VALUES
    ('team_state', '["version","revision","workspaceId","mainBotIds","privateArchives","agents","sections","capabilities","exchanges","exchangeTurns","works","abandonedWorks","requests","roomBatches","questions","views","closedCards","prefs","switching","computer","connectors","connectorRequests","mailRequests","secretRequests","im","localAgents","whaleStored","mainBotId","closedViews","btwCards","bots","rooms"]'),
    ('bots', '["id","name","role","instructions","color","avatar","model","effort","appliedModel","appliedEffort","sectionId","workDir","createdBy","createdAt","capabilities","permission","private","pinned","hidden","computer","browserGrants","sessionId","segments","openParts","kickoff","blocked","failures","lab"]'),
    ('rooms', '["id","name","pinned","hidden","named","notice","admin","mode","sectionId","workDir","permission","createdBy","createdAt","sessionId","seq","goal","pastGoals","parts","sessions","segments","memberDirs","seen","log","taskQueue","paused","idlePaused","idleRelays","folderNotice","botRounds","lateRounds","quietNoticed","quietShown","relays","relayLimit","members","todos","tasks","projectCards"]'),
    ('room_todos', '["id","text","done","createdBy","createdAt","doneBy","doneAt"]'),
    ('tasks', '["id","goal","title","botId","status","progress","startedAt","updatedAt","result","reason","acceptance","notes","blocked","rounds","intakes"]'),
    ('task_rounds', '["ownerId","plan","dispatchId","assignedAt","sentAt","startedAt","submittedAt","result"]'),
    ('task_notes', '["at","by","text"]'),
    ('task_blocks', '["by","cause","from","at","code","status"]')
)
SELECT property_lists.entity, field.value
FROM property_lists, json_each(property_lists.names) AS field;

CREATE TRIGGER team_state_extra_insert
BEFORE INSERT ON team_state WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped team_state key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'team_state';
END;

CREATE TRIGGER team_state_extra_update
BEFORE UPDATE OF extra_json ON team_state WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped team_state key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'team_state';
END;

CREATE TRIGGER bots_extra_insert
BEFORE INSERT ON bots WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped bots key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'bots';
END;

CREATE TRIGGER bots_extra_update
BEFORE UPDATE OF extra_json ON bots WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped bots key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'bots';
END;

CREATE TRIGGER rooms_extra_insert
BEFORE INSERT ON rooms WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped rooms key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'rooms';
END;

CREATE TRIGGER rooms_extra_update
BEFORE UPDATE OF extra_json ON rooms WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped rooms key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'rooms';
END;

CREATE TRIGGER room_todos_extra_insert
BEFORE INSERT ON room_todos WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped room_todos key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'room_todos';
END;

CREATE TRIGGER room_todos_extra_update
BEFORE UPDATE OF extra_json ON room_todos WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped room_todos key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'room_todos';
END;

CREATE TRIGGER tasks_extra_insert
BEFORE INSERT ON tasks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped tasks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'tasks';
END;

CREATE TRIGGER tasks_extra_update
BEFORE UPDATE OF extra_json ON tasks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped tasks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'tasks';
END;

CREATE TRIGGER task_rounds_extra_insert
BEFORE INSERT ON task_rounds WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_rounds key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_rounds';
END;

CREATE TRIGGER task_rounds_extra_update
BEFORE UPDATE OF extra_json ON task_rounds WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_rounds key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_rounds';
END;

CREATE TRIGGER task_notes_extra_insert
BEFORE INSERT ON task_notes WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_notes key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_notes';
END;

CREATE TRIGGER task_notes_extra_update
BEFORE UPDATE OF extra_json ON task_notes WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_notes key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_notes';
END;

CREATE TRIGGER task_blocks_extra_insert
BEFORE INSERT ON task_blocks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_blocks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_blocks';
END;

CREATE TRIGGER task_blocks_extra_update
BEFORE UPDATE OF extra_json ON task_blocks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_blocks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_blocks';
END;
