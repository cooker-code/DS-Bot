# 在命令行调用设置 API

## 本机受限访问（Codex）

本功能名称为“后门”（Backdoor）。设计、代码入口及后续扩展位置见[后门设计](../../../../docs/plans/2026-11-26-backdoor.md)。保留 `local_access.py`、`--local` 和 `local-access/` 等已有命令与路径名称。

macOS 上可选择 DS Bot 自己的 Unix socket，只授权下表中的操作。此入口默认关闭，不占用 TCP 端口，不生成、保存或使用 DSH 的登录地址、Cookie、模型密钥。Desktop 仍从 Dock 正常启动。以下命令从仓库根目录执行；其他目录使用脚本的绝对路径。

```sh
python3 .agents/skills/ds-bot-doc/scripts/local_access.py enable --desktop
python3 .agents/skills/ds-bot-doc/scripts/local_access.py status --desktop
python3 .agents/skills/ds-bot-doc/scripts/request.py state --local --desktop --jq '{revision,readOnly,bots,rooms}'
python3 .agents/skills/ds-bot-doc/scripts/local_access.py disable --desktop
```

`enable/status/disable` 输出 `{"ok":true,"value":{"enabled":布尔值,"active":布尔值}}`。启用时多返回 `restartRequired`，活动入口还返回 `operations`。`enabled` 表示当前账户的授权文件已保存；`active` 由真实 socket 的状态请求确认。已运行的新版插件会立即响应启用；旧版或尚未运行的插件返回 `active:false,restartRequired:true`，由用户在合适时间从 Dock 重开。脚本不会重启宿主。退出码沿用 0 成功、1 运行失败、2 参数错误，错误 JSON 只写 stderr。

| 本机操作 | 允许的完整 payload | 返回值及回读 |
| --- | --- | --- |
| `state` | `{}` | `revision,workspaceId,mainBotIds,readOnly`；Bot 仅 `id,name,role,instructions`；群仅 `id,name,notice,members,admin`。不返回供应商、密钥、连接器、浏览器或会话配置。 |
| `update-bot` | `id:string,instructions:string`，两项必填 | 仅回传上述 Bot 字段；按 ID 用 `state` 回读 `instructions` 全文。省略、附加其他字段均拒绝，不支持改模型、权限或工作目录。 |
| `update-room` | `id:string,notice:string`，两项必填 | `{room}` 仅上述群字段；按 ID 用 `state` 回读 `notice` 全文。其他群设置不在此授权内。 |
| `project-task-list` | `roomId:string` | 沿用[项目工作接口](runtime-api.md)的任务列表、待处理收件与修订号。 |
| `project-task-detail` | `roomId:string,taskId:string` | 沿用项目卡详情，只查询，不派工或改变卡状态。 |

两项正文修改继续调用 `channel.js` 的 `channelCall` 和原服务，保留字段校验、团队写锁、修订及运行时通知。数据仍在[原团队库](storage.md)。例如修改简介时，沿用下文的 jq 管道，在 `request.py` 调用增加 `--local --desktop`。正文通过 stdin/文件传入，不放在命令参数或日志里。写超时后先回读原 ID，不能仅因连接中断就重试。

原简介和公告服务都会去掉正文首尾空白，内部换行保持原值。准备待保存的完整正文时先明确这一既有规则；回读应与预期保存正文逐字比较，不能把首尾空白的规范化说成原始文件字节完全保留。

实现位于 `ds-bot/src/host/local-operator.js`。授权标记 `<团队目录>/local-access/access.json` 仅含 `{version:1,enabled:true}`，发现文件 `connection.json` 仅含 `{version:1,pid,socket}`，二者均为 0600，目录为 0700。socket 位于当前账户专属的 `/tmp/ds-bot-operator-<uid>/`，其目录为 0700、socket 为 0600。客户端拒绝不安全权限、符号链接、不同写锁 PID 和未知 socket 路径；服务端对每个请求重新核实授权及写锁状态。删除授权立即拒绝尚未进入业务服务的请求，监听和发现文件随后关闭；已进入保存的请求可以完成。插件停止时清理本进程的监听、socket 和发现文件，授权选择保留供下次启动使用。

**权限授予当前 macOS 账户，不能区分同一账户下的 Codex 与其他程序。** 其他用户、网页与网络客户端不能通过此 Unix socket 接入；它不构成针对已经控制当前账户的恶意程序的隔离。范围外动作一律拒绝，服务端不会把请求代理到 DSH 的其他接口。启停由本机文件授权，不修改团队 SQLite。

授权目录监视报错时，本次入口停止并等待已有连接清理，不自动重新开放。再次启用会返回 `active:false,restartRequired:true`，由用户择时重开宿主。

隔离实例或明确的 Web 团队可用 `--team-home '<插件团队目录>'` 替代 `--desktop`。两种目标互斥；请求仍须 `--local`，不得回退到 HTTP 登录。`--local` 忽略 HTTP 登录环境变量，显式登录文件/Cookie 参数不能与它混用。测试不得指向日用团队。

## 识别宿主与认证

所有插件操作共用宿主的 `POST <挂载路径>/api/bot`。请求是 JSON 对象 `{"endpoint":"state","payload":{}}`。同一宿主的 Desktop 前端使用已认证转发，Web 使用宿主签发的会话 Cookie。一个监听端口只说明进程在运行。先确认正在维护哪个团队、哪个宿主持有写锁。

DSH Web 启动时给操作者一个含 `token` 参数的**登录地址**。客户端向该地址的同一根路径发 GET，接受服务器返回的重定向和绑定到该地址的会话 Cookie，再向同源插件 API 发 POST。主机名、端口、协议及代理挂载路径保持一致。开发环境可在自己刚启动的隔离 Web 实例的启动输出取得地址。桌面应用的进程间认证由宿主管理。对于现有 Desktop 实例，先查操作者明确配置的程序化入口或该实例已经签发的登录材料。公开 API 只接受合规会话。其他端口的登录、未认证探测和旧测试实例都不能证明已接入本团队。不要把登录地址、响应头、Cookie 或整个 state 放进日志。接口注册见 [channel.js](../../../../ds-bot/src/host/channel.js)，客户端协议见 [api.js](../../../../ds-bot/src/client/api.js)。

使用随技能提供的 [request.py](../scripts/request.py)。需要 Python 3，选择响应字段时另用 jq。用 `--base` 或 `DS_BOT_BASE_URL` 指定目标应用地址。按该实例已有的登录方式从下表选一项。脚本只为目标来源使用凭据，默认只打印成功回执。

| 操作者已具备的入口 | 参数或环境变量 | 如何确定 |
| --- | --- | --- |
| DSH Web 的启动输出 | `--web-log` / `DS_BOT_WEB_LOG` | 使用启动该实例时保存的私有输出文件。脚本只取同协议、主机、端口和挂载路径的最后一条 `dsh web:` 公告。隔离测试的文件为仓库根目录下的 `.dsh-test-<name>/web.log`。 |
| 已正式签发的 Web 登录地址 | `--login-file` / `DS_BOT_LOGIN_FILE` | 文件内只存该实例的登录 URL，限制为本人可读。登录 URL 不放入命令行参数、仓库或对话。 |
| 同一来源已有的操作者会话 | `--cookie-jar` / `DS_BOT_COOKIE_JAR` | 使用操作者为脚本准备的 Netscape 格式 Cookie 文件，经作用域匹配后使用。 |

Desktop 通常由操作系统启动，Electron 在 `dsh-app://app/` 内转发已认证请求。查当前桌面实例应先识别监听端口和启动方式，再找为操作者公开的同一实例登录材料。若 Desktop 没有发布该入口，单凭端口不能完成认证。需要长期程序化管理时，在正常维护交接中以持锁的 DSH Web 运行团队，保留本人可读的启动输出。日用宿主正在工作时不要为拿登录地址另起同目录写宿主。

### macOS 日用 Desktop（Dock 启动）

用户照常打开应用。命令无须预先加载 `operator.env`：

```sh
python3 .agents/skills/ds-bot-doc/scripts/request.py state --desktop --jq '{readOnly,revision}'
```

`--desktop` 每次从默认团队写锁取得 PID，以 `ps` 核对后端及其 Desktop 父进程属于当前用户，用 `lsof` 枚举该后端的本机监听。脚本向候选端口发送无凭据的只读 `state` 请求；只有唯一返回 401 的候选才进入正式认证。多个候选、未知进程或无可用监听均停止。本机配置的固定端口是 31450；该命令按进程实况选端口。

有操作者配置的官方启动公告、登录文件或 Cookie jar 时，脚本按原有认证方式接入。未指定来源时尝试本机预先配置的私有公告文件。Dock 启动不保证刷新它。旧进程的登录令牌会失效；同源且仍有效的已授权会话可通过 `--cookie-jar` 使用。正常认证失败即停止 API 操作；查询持久资料可用[只读 SQLite](storage.md)，需写入时报告缺少哪种正式登录材料。不从应用或浏览器内部提取 Cookie，不使用调试端口或界面自动化。脚本不改变 Desktop 的启动方式。

在已完成写锁交接的本机维护时段，可以自行准备 Web 登录入口。选择一个空闲端口，使用目标团队已安装 DS Bot 的 Web profile，在目标终端启动。下面的例子把宿主输出留在本人可读的临时目录中。启动后，下一条 `state` 成功且 `readOnly` 为空，才表明该宿主能接受设置。结束临时维护时正常停止该宿主并释放写锁，再恢复原宿主。

```sh
operator_dir=$(mktemp -d)
export DS_BOT_BASE_URL=http://127.0.0.1:31450
export DS_BOT_WEB_LOG="$operator_dir/web.log"
(
  umask 077
  exec dsh --profile web --host 127.0.0.1 --port 31450 --no-open >"$DS_BOT_WEB_LOG" 2>&1
) &
operator_pid=$!
```

```sh
api=.agents/skills/ds-bot-doc/scripts/request.py
python3 "$api" state --jq '{revision,readOnly,bots:[.bots[]|{id,name}],rooms:[.rooms[]|{id,name}]}'
```

临时宿主的启动终端可用 `kill -TERM "$operator_pid"` 发起正常退出，再用 `wait "$operator_pid"` 等待。确认该实例已释放写锁后清理本次临时启动输出。日常长驻 Web 的启动与停止由实际服务管理方式负责。

成功响应为 `{"ok":true,"value":...}`，`value` 由操作决定。插件以 HTTP 200 返回业务拒绝，形如 `{"ok":false,"error":{"code":"bot/refused","message":"…","details":{}}}`。HTTP 401/403 在插件外发生。脚本默认仅输出成功回执。`--jq` 作用于成功的 `value`，按需选择字段。退出码 0 表示成功，1 表示传输或业务失败，2 表示输入参数错误。错误写入标准错误并隐去可能含凭据或用户原文的错误信息。写请求超时先回读对象，尤其是创建、导入、发送与发布操作。

查一个项目的积压时，用已选项目群的 ID 作为 `room_id`。同一 task 有多个轮次仍只算一项，待处理收件另行统计。用户询问某个 Bot 的错误或返工时，再读有关 task 的轮次和复核记录。

```sh
jq -n --arg room "$room_id" '{roomId:$room}' |
  python3 "$api" project-task-list --payload - --jq '{revision,pending:(.pendingIntakes|length),byStatus:(.tasks|group_by(.status)|map({status:.[0].status,count:length}))}'
```

## 更新简介、登记并绑定技能

从上一次 `state` 的结果选择唯一 Bot ID，赋给 `bot_id`。同名或来源不确定时先核对群成员 ID。`intro_file` 是仅含该岗位说明的 UTF-8 Markdown 文件。`update-bot` 传差量，省略的字段保留原值。`instructions` 是持久简介，`brief` 只用于创建时的首轮说明。一次改资料可能触发宿主的资料变更通知。

```sh
jq -n --arg id "$bot_id" --rawfile instructions "$intro_file" '{id:$id,instructions:$instructions}' |
  python3 "$api" update-bot --payload - --jq '{id,name}'
```

用 `capability-save` 登记或更新同名文本技能。文件夹技能（带子目录、引用或脚本）用 `capability-import`。以下示例同时适用于本仓库的单文件进度技能和含参考文档、Python 脚本的 ds-bot-doc，将 `skill_dir` 指向相应包即可。文件清单只包含本次需要交给 Bot 的资源。本机 Diffmap 技能还需要 `agents/openai.yaml`，其他包按自身资源目录补全清单。

```sh
skill_dir=.agents/skills/analyze-task-progress
python3 - "$skill_dir" <<'PY' | python3 "$api" capability-import --payload -
import base64, json, sys
from pathlib import Path
root = Path(sys.argv[1])
files = [root / "SKILL.md"]
for pattern in ("references/*.md", "scripts/*.py", "agents/*.yaml"):
    files.extend(sorted(root.glob(pattern)))
print(json.dumps({"files": [
    {"path": path.relative_to(root).as_posix(), "bytes": base64.b64encode(path.read_bytes()).decode("ascii")}
    for path in files
]}))
PY
jq -n --arg bot "$bot_id" '{botId:$bot,name:"analyze-task-progress",attached:true}' |
  python3 "$api" bot-capability --payload - --jq '.'
```

首次导入成功返回技能名。重名时先回读现有类型与内容，内容相同就复用。`bot-capability` 返回更新后的技能名数组，再通过 `state.bots[].capabilities` 核对绑定。导入目录的现有接口拒绝同名覆盖，删除会解除其他 Bot 和能力包的引用。不要为更新说明直接删除共享目录。文本技能用 `capability-save` 可保留绑定。对于本地 Codex，绑定从下一次符合条件的消息生效。API 回读证明配置保存，实际加载还需要相应会话的运行证据。

项目提供了[预置岗位简介](../../../../docs/bot-role-profiles.zh.md)。用 [provision_role.py](../scripts/provision_role.py) 在已认证团队按需创建、更新或补绑定。脚本先核对目标和共享技能是否存在，按同名复用 Bot，逐项补差异，最后按 ID 回读。中断后可重跑。它沿用已配模型、目录、其他技能和权限。成员入群由群管理员按具体项目单独配置。

```sh
roles=.agents/skills/ds-bot-doc/scripts/provision_role.py
python3 "$roles" --ensure-name '架构工程师' --role '架构工程师' --skill verify-gitnexus-context
python3 "$roles" --bot-id "$bot_id" --skill analyze-task-progress
```

第一个命令把选中岗位的说明写入 `role,instructions`，适合初始化与明确要求覆盖简介的变更。第二个只补给现有 Bot 的技能，适合保有定制说明的团队。`--role` 对应 Markdown 中的岗位名，`--ensure-name` 是目标团队自选的显示名。可重复传 `--skill`，登录环境变量与 request.py 相同。

## 定位未完成的链路

| 观察结果 | 下一步 |
| --- | --- |
| 401 / 403 | 核对目标宿主、挂载路径和同一来源的正式登录入口。Web 启动地址只在登录交换使用。不要用其他服务的密钥或会话替代。 |
| `state.readOnly` 有值，或 `bot/read-only` | 向持有写锁的宿主发请求。另启同目录 Web 可能只能读。正常交接前留住正在运行的工作。 |
| `bot/not-found` | 根据具体业务错误区分操作未注册、Bot 或 task 已不存在。核对运行版本及分派器。对象不存在时用稳定 ID 重新定位。 |
| `bot/stale`、版本冲突或响应中断 | 回读当前版本和回执。对照前置条件重新决定是否需要写入。 |
| API 写入成功，但实际表现仍旧 | 分别核对返回值、状态回读、作用域（团队、Bot、群成员）以及下一个会话或轮次是否重新选择配置。 |
| 找不到对应业务动作 | 先查宿主公开服务和插件现有动作能否组合完成。若缺少业务入口，补服务与通道契约、文档和隔离回归。需操作系统同意、第三方账号验证等步骤保留其授权流程。 |
