# SQLite 核查与离线维护

## 找到数据归属

先从已认证的 `state` 取得工作区 ID、Bot ID、群 ID 和 `readOnly`。库的位置以目标宿主实际的插件团队目录为准。下面路径相对该目录。测试使用独立的 `.dsh-test-<name>/bot/`。只需回答谁负责、是否启用技能或改动是否落库时，只选必要字段。

| 数据 | 所在位置与关联 |
| --- | --- |
| 团队与共享设置 | `state/catalog.sqlite` 的 `team_state` 单行保存 `revision,workspace_id,main_bot_ids_json,prefs_json,sections_json,capabilities_json`，也保存连接器、IM 与本地智能体配置。`room_catalog(room_id,storage_key,position)` 给出群库目录。 |
| Bot 基础资料 | `state/bots.sqlite` 的 `bots` 按 `bot_id` 定位。`name,role,instructions,model,work_dir,permission,capabilities_json` 分别是名称、标签、持久说明、默认模型、目录、权限及能力名列表。 |
| 群、成员与项目 task | 通过目录中的 storage_key 打开 `state/rooms/<storage_key>/room.sqlite`，按 `rooms.room_id` 再核对。`room_members` 存成员次序；`room_member_settings` 存群内模型与目录覆盖。`tasks,task_rounds` 及计划、收件和恢复明细保存执行证据。群改名后使用原目录键。 |
| SQLite 之外的内容 | 导入的技能和头像有实际文件；密钥由密钥存储管理；供应商模型配置、会话和定时任务分别使用 DSH 服务。群消息正文、附件、记忆正文、检索索引与统计有各自存储。数据库配置标记只证明已记录，操作者授权或实际运行要从相应服务核对。 |

[字段映射](../../../../ds-bot/src/host/team-storage/fields.js) · [建表及群库升级](../../../../ds-bot/src/host/team-storage/split-schema.sql) · [按群拆库设计](../../../../docs/plans/2026-11-19-team-sqlite-storage.md)

### 只读查询

下例中的 `team_dir` 指向获准核查的插件团队目录。先查目录键，再选具体群；同名群用 ID 区分。`-readonly` 会让文件不存在时直接失败。对运行中的团队应保持查询短小；以 API 返回的一次状态回答跨库的同一时点问题。

```sh
sqlite3 -readonly "$team_dir/state/catalog.sqlite" \
  'SELECT room_id,storage_key FROM room_catalog ORDER BY position;'
sqlite3 -readonly "$team_dir/state/bots.sqlite" \
  'SELECT bot_id,name,role,length(instructions) AS intro_length FROM bots ORDER BY position;'
sqlite3 -readonly "$team_dir/state/bots.sqlite" \
  'SELECT b.bot_id,b.name,j.value AS skill FROM bots b JOIN json_each(b.capabilities_json) j ORDER BY b.position,j.key;'
sqlite3 -readonly "$team_dir/state/catalog.sqlite" \
  "SELECT j.key AS name,json_extract(j.value,'$.kind') AS kind FROM team_state t JOIN json_each(t.capabilities_json,'$.items') j ORDER BY j.key;"
```

```sql
SELECT room_id, name, admin_bot_id, mode FROM rooms;
SELECT bot_id, work_dir_rule, work_dir, model_override FROM room_member_settings;
SELECT task_pk, round_no, owner_bot_id, assigned_at, started_at, submitted_at
FROM task_rounds ORDER BY task_pk, round_no;
```

## 锁与一致性

- **宿主写锁**为 `bot/state.lock`。持有者在内存中维护团队，服务会保存整体快照。宿主负责通过身份、进程和心跳确认所有权及接管。在线配置由写锁宿主的 API 提交。`state.readOnly` 有原因时切到持锁宿主。不要删除或伪造锁，也不要读取或输出锁里的随机值。[home-lock.js](../../../../ds-bot/src/host/home-lock.js) · [store.js](../../../../ds-bot/src/host/store.js)
- **SQLite 事务锁**由数据库引擎管理。当前分库增量写使用 `ATTACH`、`journal_mode=DELETE`、`synchronous=FULL` 与 `BEGIN IMMEDIATE`，可在同一事务修改目录库、Bot 库及若干群库。群集合改变或一次变更超过八个群时，存储层会发布一整套新库。在线读遇到 `SQLITE_BUSY/LOCKED` 结束长事务，短暂等待后重试只读请求，或回到宿主 API。`busy_timeout` 只影响等待时间，不能授予宿主写权。[split.js](../../../../ds-bot/src/host/team-storage/split.js)
- **备份和副本**应包含同一时间点的整套 `state/`。离线维护先经授权停止所有会写该团队的宿主，确认所有权已正常释放，保留原目录并复制一致副本。单独复制正在写入的某个 SQLite 文件，或删除 `-journal/-wal/-shm`，可能丢失数据。历史单库或其他索引的日志模式可能不同。只读核查使用引擎打开，保留它需要的日志。
- **离线修复**先检查 `PRAGMA user_version` 与目标表结构，在维护副本上用参数化条件锁定唯一业务 ID，预先读取旧值，变更使用事务并核对命中行数。跨库变化通过项目存储适配器保留 `shape_json/extra_json`、目录键、修订号、关联和完整提交。修改失败时回滚，保留原备份。操作完对相关库分别运行 `PRAGMA integrity_check`（应返回 ok）、`PRAGMA foreign_key_check`（应为空），再在隔离宿主启动副本，按同一 ID 回读业务结果。正式替换需对应维护授权及可用回退点。用户的日用团队与隔离测试严格分开。

离线备份可在可写副本的目录内进行事务演练。以下例子仅适用于**已停机的一致副本**，它检查唯一匹配并回滚，不发布任何更改。正式岗位变更使用 `update-bot`。

```python
import sqlite3
from pathlib import Path

def rehearse_intro(copy_root, bot_id, proposed_intro):
    db_path = (Path(copy_root) / "state" / "bots.sqlite").resolve()
    db = sqlite3.connect(db_path.as_uri() + "?mode=rw", uri=True, timeout=2)
    try:
        db.execute("BEGIN IMMEDIATE")
        rows = db.execute("UPDATE bots SET instructions=? WHERE bot_id=?",
                          (proposed_intro, bot_id)).rowcount
        if rows != 1:
            raise ValueError("expected one existing Bot")
        actual, = db.execute("SELECT instructions FROM bots WHERE bot_id=?", (bot_id,)).fetchone()
        if actual != proposed_intro:
            raise ValueError("unexpected readback")
    finally:
        try:
            db.rollback()
        finally:
            db.close()
```


## 任务解释的派生缓存

插件 home 下 `task-explanations/<群与卡的 SHA-256>/<消息 key 与语言的 SHA-256>.json` 保存 `{messageKey,sourceHash,language,text,generatedAt}`。sourceHash 包含原文、说话人上下文、语言与规则版本；生成成功才原子替换，失败不保存。不参与任务状态、模型输入输出或 SQLite 修订。只读宿主可读有效缓存，生成受团队写锁约束。宿主停止后可仅删除此派生目录，下次点击重新生成，原消息不受影响。
