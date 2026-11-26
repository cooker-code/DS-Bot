-- 团队状态拆库。main 为 catalog.sqlite，bot_base 为共享的 bots.sqlite，room 为某一个群的 room.sqlite。
-- 使用三个独立文件。先连接目录库，ATTACH 另两库后执行本稿。各段可独立应用，见存储计划。
-- 每次连接启用外键，在事务内执行所需建表段。文件选择由调用方绑定，DDL 不指定本地路径。
-- JSON 旧键与列的对应见行尾注释。时间为 Unix 毫秒，布尔值用 0/1。
-- shape_json 区分缺键、显式 null、已拆容器与派生项目状态。extra_json 只接收本层未知键。
PRAGMA foreign_keys = ON;

-- @database catalog
-- 一个团队目录一行。bots 和 rooms 的形态留在根行，各自的对象写进对应数据库。
CREATE TABLE main.team_state (
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

-- 群目录。群改名仅更新该群库的 rooms.name。
CREATE TABLE main.room_catalog (
    room_id TEXT PRIMARY KEY NOT NULL, -- rooms 的原映射键，也是跨库定位值。
    team_id INTEGER NOT NULL DEFAULT 1 REFERENCES team_state(singleton), -- 根记录。
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0), -- 原 rooms 映射中的位置。
    storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 80
        AND storage_key NOT GLOB '*[^a-z0-9_-]*') -- 由 room_id 编码，定位 rooms/<storage_key>/room.sqlite。
) STRICT;

-- 本库的已知原键，包含拆到明细表的键。
CREATE VIEW main.known_json_keys(entity, json_key) AS
WITH property_lists(entity, names) AS (VALUES
    ('team_state', '["version","revision","workspaceId","mainBotIds","privateArchives","agents","sections","capabilities","exchanges","exchangeTurns","works","abandonedWorks","requests","roomBatches","questions","views","closedCards","prefs","switching","computer","connectors","connectorRequests","mailRequests","secretRequests","im","localAgents","whaleStored","mainBotId","closedViews","btwCards","bots","rooms"]')
)
SELECT property_lists.entity, field.value FROM property_lists, json_each(property_lists.names) AS field;

CREATE TRIGGER main.team_state_extra_insert
BEFORE INSERT ON team_state WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped team_state key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'team_state';
END;

CREATE TRIGGER main.team_state_extra_update
BEFORE UPDATE OF extra_json ON team_state WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped team_state key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'team_state';
END;

-- @database bots
-- 每个 Bot 一行，在所有群间共享。position 保存原 bots 映射的位置。
CREATE TABLE bot_base.bots (
    bot_id TEXT PRIMARY KEY NOT NULL, -- 原 bots 映射键，继续用于成员及历史引用。
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0), -- 名册中的原枚举位置。
    source_id TEXT, -- id · Bot 对象内原有的 ID，独立保留它与映射键的差异。
    name TEXT, -- name · 显示名称。
    role TEXT, -- role · 角色标签。
    instructions TEXT, -- instructions · 角色指令。
    color TEXT, -- color · 角色颜色。
    avatar_json TEXT CHECK (avatar_json IS NULL OR json_valid(avatar_json)), -- avatar · 角色形象属性。
    model TEXT, -- model · Bot 的默认模型，群内覆盖值另存。
    effort TEXT, -- effort · 推理强度设置。
    applied_model TEXT, -- appliedModel · 会话上实际应用的模型。
    applied_effort TEXT, -- appliedEffort · 会话上实际应用的推理强度。
    section_id TEXT, -- sectionId · 侧边栏分组。
    work_dir TEXT, -- workDir · Bot 的默认工作目录。
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

-- 本库的已知原键，包含拆到明细表的键。
CREATE VIEW bot_base.known_json_keys(entity, json_key) AS
WITH property_lists(entity, names) AS (VALUES
    ('bots', '["id","name","role","instructions","color","avatar","model","effort","appliedModel","appliedEffort","sectionId","workDir","createdBy","createdAt","capabilities","permission","private","pinned","hidden","computer","browserGrants","sessionId","segments","openParts","kickoff","blocked","failures","lab"]')
)
SELECT property_lists.entity, field.value FROM property_lists, json_each(property_lists.names) AS field;

CREATE TRIGGER bot_base.bots_extra_insert
BEFORE INSERT ON bots WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped bots key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'bots';
END;

CREATE TRIGGER bot_base.bots_extra_update
BEFORE UPDATE OF extra_json ON bots WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped bots key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'bots';
END;

-- @database room
-- 本群唯一根记录。成员、成员配置、待办和任务在同一文件内。
CREATE TABLE room.rooms (
    room_id TEXT PRIMARY KEY NOT NULL, -- 原 rooms 映射键，群换段后仍使用。
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1), -- 限制此文件最多保存一个群。
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

-- 有序的原 members 数组，独立于成员配置，允许历史重复 ID。
CREATE TABLE room.room_members (
    room_id TEXT NOT NULL REFERENCES rooms(room_id), -- 成员所属群。
    position INTEGER NOT NULL CHECK (position >= 0), -- members 原数组下标。
    bot_id TEXT NOT NULL, -- 原成员 ID，跨库按 bots.bot_id 查基础资料。
    PRIMARY KEY (room_id, position)
) STRICT;

-- 一个群与一个 Bot 一行。历史 memberDirs 允许有已退群或已删除的 Bot。
CREATE TABLE room.room_member_settings (
    room_id TEXT NOT NULL REFERENCES rooms(room_id), -- 群设置的作用域。
    bot_id TEXT NOT NULL, -- 原 memberDirs 的映射键，跨库引用 Bot 基础资料。
    work_dir_rule TEXT NOT NULL DEFAULT 'inherit'
        CHECK (work_dir_rule IN ('inherit','legacy','override')), -- 继承、旧目录规则或显式群内覆盖。
    work_dir TEXT, -- 非继承时，路径为自选目录，NULL 表示显式使用团队工作区。
    dir_position INTEGER CHECK (dir_position >= 0), -- memberDirs 的键序；继承时没有该键。
    model_override TEXT CHECK (model_override IS NULL OR length(trim(model_override)) > 0), -- 本 Bot 在此群选用的模型引用，NULL 继承 Bot 默认模型。
    PRIMARY KEY (room_id, bot_id),
    UNIQUE (room_id, dir_position),
    CHECK ((work_dir_rule = 'inherit' AND work_dir IS NULL AND dir_position IS NULL)
        OR (work_dir_rule IN ('legacy','override') AND dir_position IS NOT NULL))
) STRICT;

-- 共享待办依原列表顺序保存。
CREATE TABLE room.room_todos (
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

-- 两类群任务。task_pk 只在本群文件内使用。
CREATE TABLE room.tasks (
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

-- 项目任务的收件号列表，允许重复。
CREATE TABLE room.task_intakes (
    task_pk INTEGER NOT NULL REFERENCES tasks(task_pk), -- 收件归属的任务。
    position INTEGER NOT NULL CHECK (position >= 0), -- intakes 原数组下标。
    intake_id TEXT NOT NULL, -- 联结 tasks 取 room_id 后，在该群账本定位原消息。
    PRIMARY KEY (task_pk, position)
) STRICT;

-- 项目任务的实际派工轮次。
CREATE TABLE room.task_rounds (
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

-- 成员任务的有序备注。
CREATE TABLE room.task_notes (
    task_pk INTEGER NOT NULL REFERENCES tasks(task_pk), -- 留言所属任务。
    position INTEGER NOT NULL CHECK (position >= 0), -- 原 notes 数组下标。
    noted_at INTEGER, -- at · 留言时间。
    author_id TEXT, -- by · 留言作者标识。
    text TEXT, -- text · 留言正文。
    shape_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(shape_json) AND json_type(shape_json) = 'object'), -- 旧属性形态，使用原 JSON 键名。
    extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object'), -- 仅本层未知扩展属性。
    PRIMARY KEY (task_pk, position)
) STRICT;

-- 成员任务的当前阻塞记录，包括旧空对象。
CREATE TABLE room.task_blocks (
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

-- 本库的已知原键，包含拆到明细表的键。
CREATE VIEW room.known_json_keys(entity, json_key) AS
WITH property_lists(entity, names) AS (VALUES
    ('rooms', '["id","name","pinned","hidden","named","notice","admin","mode","sectionId","workDir","permission","createdBy","createdAt","sessionId","seq","goal","pastGoals","parts","sessions","segments","memberDirs","seen","log","taskQueue","paused","idlePaused","idleRelays","folderNotice","botRounds","lateRounds","quietNoticed","quietShown","relays","relayLimit","members","todos","tasks","projectCards"]'),
    ('room_todos', '["id","text","done","createdBy","createdAt","doneBy","doneAt"]'),
    ('tasks', '["id","goal","title","botId","status","progress","startedAt","updatedAt","result","reason","acceptance","notes","blocked","rounds","intakes"]'),
    ('task_rounds', '["ownerId","plan","dispatchId","assignedAt","sentAt","startedAt","submittedAt","result"]'),
    ('task_notes', '["at","by","text"]'),
    ('task_blocks', '["by","cause","from","at","code","status"]')
)
SELECT property_lists.entity, field.value FROM property_lists, json_each(property_lists.names) AS field;

CREATE TRIGGER room.rooms_extra_insert
BEFORE INSERT ON rooms WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped rooms key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'rooms';
END;

CREATE TRIGGER room.rooms_extra_update
BEFORE UPDATE OF extra_json ON rooms WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped rooms key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'rooms';
END;

CREATE TRIGGER room.room_todos_extra_insert
BEFORE INSERT ON room_todos WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped room_todos key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'room_todos';
END;

CREATE TRIGGER room.room_todos_extra_update
BEFORE UPDATE OF extra_json ON room_todos WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped room_todos key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'room_todos';
END;

CREATE TRIGGER room.tasks_extra_insert
BEFORE INSERT ON tasks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped tasks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'tasks';
END;

CREATE TRIGGER room.tasks_extra_update
BEFORE UPDATE OF extra_json ON tasks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped tasks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'tasks';
END;

CREATE TRIGGER room.task_rounds_extra_insert
BEFORE INSERT ON task_rounds WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_rounds key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_rounds';
END;

CREATE TRIGGER room.task_rounds_extra_update
BEFORE UPDATE OF extra_json ON task_rounds WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_rounds key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_rounds';
END;

CREATE TRIGGER room.task_notes_extra_insert
BEFORE INSERT ON task_notes WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_notes key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_notes';
END;

CREATE TRIGGER room.task_notes_extra_update
BEFORE UPDATE OF extra_json ON task_notes WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_notes key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_notes';
END;

CREATE TRIGGER room.task_blocks_extra_insert
BEFORE INSERT ON task_blocks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_blocks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_blocks';
END;

CREATE TRIGGER room.task_blocks_extra_update
BEFORE UPDATE OF extra_json ON task_blocks WHEN NEW.extra_json <> '{}'
BEGIN
    SELECT RAISE(ABORT, 'extra_json contains a mapped task_blocks key')
    FROM json_each(NEW.extra_json) AS e JOIN known_json_keys AS k ON k.json_key = e.key
    WHERE k.entity = 'task_blocks';
END;

-- @room-upgrade 2
-- The original text and attachments remain in the group ledger at through_seq.
CREATE TABLE room.project_inbox (
    intake_id TEXT PRIMARY KEY,
    through_seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('pending','clarify','chat','accepted','attached')),
    reason TEXT
) STRICT;
CREATE TABLE room.task_plans (
    task_pk       INTEGER NOT NULL REFERENCES tasks(task_pk),
    plan_version  INTEGER NOT NULL CHECK (plan_version >= 1),
    planned_by    TEXT NOT NULL,
    planned_at    INTEGER NOT NULL,
    change_reason TEXT,
    PRIMARY KEY (task_pk, plan_version),
    CHECK (plan_version = 1 OR nullif(trim(change_reason), '') IS NOT NULL)
) STRICT;

-- 一个节点是一项能独立派给 Bot、能核对交付物的工作。预定负责人在受理时填写。
CREATE TABLE room.task_plan_nodes (
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
    reuse_round INTEGER,
    FOREIGN KEY (task_pk,reuse_round) REFERENCES task_rounds(task_pk,round_no),
    PRIMARY KEY (task_pk, plan_version, node_no),
    UNIQUE (task_pk, plan_version, node_no, owner_bot_id),
    FOREIGN KEY (task_pk, plan_version) REFERENCES task_plans(task_pk, plan_version)
) STRICT;

-- 同卡同版内按拓扑顺序编号，所有边由小号指向大号，从而排除自环和间接环。
-- 编号相邻不构成依赖；仅此表中的边要求交付前置产物。
CREATE TABLE room.task_plan_dependencies (
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
) STRICT;

CREATE TABLE room.task_round_plans (
    task_pk INTEGER NOT NULL,
    round_no INTEGER NOT NULL,
    plan_version INTEGER NOT NULL,
    node_no INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by TEXT,
    artifact_ref TEXT,
    PRIMARY KEY (task_pk,round_no),
    UNIQUE (task_pk,plan_version,node_no),
    FOREIGN KEY (task_pk,round_no) REFERENCES task_rounds(task_pk,round_no),
    FOREIGN KEY (task_pk,plan_version,node_no) REFERENCES task_plan_nodes(task_pk,plan_version,node_no),
    CHECK ((accepted_at IS NULL) = (artifact_ref IS NULL) AND (accepted_at IS NULL) = (accepted_by IS NULL))
) STRICT;

CREATE TABLE room.task_round_inputs (
    task_pk INTEGER NOT NULL,
    round_no INTEGER NOT NULL,
    predecessor_no INTEGER NOT NULL,
    source_round INTEGER NOT NULL CHECK (source_round < round_no),
    PRIMARY KEY (task_pk,round_no,predecessor_no),
    FOREIGN KEY (task_pk,round_no) REFERENCES task_round_plans(task_pk,round_no),
    FOREIGN KEY (task_pk,source_round) REFERENCES task_round_plans(task_pk,round_no)
) STRICT;

-- @room-upgrade 3
-- Rebuild both sides of the round/input FK within the same transaction.
ALTER TABLE room.task_round_inputs RENAME TO previous_round_inputs;
ALTER TABLE room.task_round_plans RENAME TO previous_round_plans;
CREATE TABLE room.task_round_plans (
    task_pk INTEGER NOT NULL,
    round_no INTEGER NOT NULL,
    plan_version INTEGER NOT NULL,
    node_no INTEGER NOT NULL,
    superseded_by INTEGER,
    writer_session TEXT,
    writer_dir TEXT,
    previous_round INTEGER,
    completed_checks TEXT,
    remaining_checks TEXT,
    checkpoint_artifact TEXT,
    checkpoint_at INTEGER,
    late_result TEXT,
    late_at INTEGER,
    accepted_at INTEGER,
    accepted_by TEXT,
    artifact_ref TEXT,
    PRIMARY KEY (task_pk,round_no),
    FOREIGN KEY (task_pk,previous_round) REFERENCES task_rounds(task_pk,round_no),
    CHECK (previous_round IS NULL OR previous_round < round_no),
    FOREIGN KEY (task_pk,superseded_by) REFERENCES task_rounds(task_pk,round_no),
    CHECK (superseded_by IS NULL OR superseded_by > round_no),
    FOREIGN KEY (task_pk,round_no) REFERENCES task_rounds(task_pk,round_no),
    FOREIGN KEY (task_pk,plan_version,node_no) REFERENCES task_plan_nodes(task_pk,plan_version,node_no),
    CHECK ((accepted_at IS NULL) = (artifact_ref IS NULL) AND (accepted_at IS NULL) = (accepted_by IS NULL))
) STRICT;

CREATE TABLE room.task_round_inputs (
    task_pk INTEGER NOT NULL,
    round_no INTEGER NOT NULL,
    predecessor_no INTEGER NOT NULL,
    source_round INTEGER NOT NULL CHECK (source_round < round_no),
    PRIMARY KEY (task_pk,round_no,predecessor_no),
    FOREIGN KEY (task_pk,round_no) REFERENCES task_round_plans(task_pk,round_no),
    FOREIGN KEY (task_pk,source_round) REFERENCES task_round_plans(task_pk,round_no)
) STRICT;
CREATE UNIQUE INDEX room.current_node_round ON task_round_plans(task_pk,plan_version,node_no) WHERE superseded_by IS NULL;
INSERT INTO room.task_round_plans(task_pk,round_no,plan_version,node_no,accepted_at,accepted_by,artifact_ref)
    SELECT task_pk,round_no,plan_version,node_no,accepted_at,accepted_by,artifact_ref FROM room.previous_round_plans;
INSERT INTO room.task_round_inputs SELECT * FROM room.previous_round_inputs;
DROP TABLE room.previous_round_inputs;
DROP TABLE room.previous_round_plans;

ALTER TABLE room.task_plan_nodes ADD COLUMN fixed_owner INTEGER CHECK (fixed_owner = 1);
ALTER TABLE room.task_plan_nodes ADD COLUMN independent_review INTEGER CHECK (independent_review = 1);

CREATE TABLE room.task_node_blocks (
    task_pk INTEGER NOT NULL, round_no INTEGER NOT NULL,
    blocked_at INTEGER NOT NULL, cause TEXT NOT NULL, reason TEXT NOT NULL,
    reported_by TEXT NOT NULL, waiting_for TEXT, evidence TEXT, resolved_at INTEGER,
    PRIMARY KEY (task_pk,round_no),
    FOREIGN KEY (task_pk,round_no) REFERENCES task_round_plans(task_pk,round_no)
) STRICT;

CREATE TABLE room.task_recovery_decisions (
    task_pk INTEGER NOT NULL, round_no INTEGER NOT NULL, decision_no INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('wait','resume','takeover','replan')),
    decided_at INTEGER NOT NULL, decided_by TEXT NOT NULL, reason TEXT NOT NULL,
    next_round INTEGER, owner_id TEXT, artifact TEXT, remaining_checks TEXT,
    inspection TEXT, eligibility TEXT, worktree_review TEXT, recovery_condition TEXT,
    source_tree TEXT CHECK (source_tree IS NULL OR json_valid(source_tree)),
    target_tree TEXT CHECK (target_tree IS NULL OR json_valid(target_tree)),
    PRIMARY KEY (task_pk,round_no,decision_no),
    FOREIGN KEY (task_pk,round_no) REFERENCES task_node_blocks(task_pk,round_no),
    FOREIGN KEY (task_pk,next_round) REFERENCES task_round_plans(task_pk,round_no),
    CHECK ((action IN ('resume','takeover')) = (next_round IS NOT NULL)),
    CHECK (next_round IS NULL OR next_round > round_no)
) STRICT;

-- @room-upgrade 4
ALTER TABLE room.project_inbox RENAME TO previous_project_inbox;
CREATE TABLE room.project_inbox (
    intake_id TEXT PRIMARY KEY,
    through_seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('pending','planning','clarify','chat','accepted','attached')),
    reason TEXT
) STRICT;
INSERT INTO room.project_inbox SELECT * FROM room.previous_project_inbox;
DROP TABLE room.previous_project_inbox;

-- @room-upgrade 5
ALTER TABLE room.task_plan_nodes ADD COLUMN workspace_mode TEXT CHECK (workspace_mode IN ('current','worktree','none'));
ALTER TABLE room.task_plan_nodes ADD COLUMN write_paths TEXT CHECK (write_paths IS NULL OR json_type(write_paths) = 'array');

CREATE TABLE room.project_branches (
    repository TEXT NOT NULL, branch TEXT NOT NULL, tip TEXT NOT NULL, commit_at INTEGER NOT NULL, ref_at INTEGER,
    target TEXT NOT NULL, target_commit TEXT NOT NULL, relation TEXT NOT NULL,
    work_dir TEXT, missing INTEGER, removed INTEGER, purpose TEXT, prepared_at INTEGER,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (repository, branch)
) STRICT;

-- @room-upgrade 6
ALTER TABLE room.project_inbox ADD COLUMN planning_at INTEGER;

-- @room-upgrade 7
ALTER TABLE room.task_plans ADD COLUMN workspace_policy TEXT CHECK (workspace_policy IN ('auto','current','worktree'));
ALTER TABLE room.task_plan_nodes ADD COLUMN workspace_reason TEXT;

-- @room-upgrade 8
ALTER TABLE room.task_plan_nodes ADD COLUMN merge_to_dev INTEGER CHECK (merge_to_dev = 1);
ALTER TABLE room.task_plan_nodes ADD COLUMN candidate_commit TEXT;
ALTER TABLE room.task_round_plans ADD COLUMN test_feedback TEXT;
