# Two sessions of one Bot running at once

- Date: 2026-11-13
- Related: Issue #1501

## Why

Today a Bot has one chat window. When a long job runs there, the user cannot start a
second job on the same Bot; the next request waits for the first to finish. The issue
asks for two parallel sessions of one Bot.

## Two views are not two sessions (decision)

"Open the same part in two windows" would share one DSH Session, and DSH runs one turn
at a time in a Session: a second send from either view is queued or steered into the
running turn. It looks like two windows but still works one job at a time, so it is not
what the issue asks for. The parallel behavior needs a second Session (a second part of
the Bot's own chat) with its own context. This note records that so a later change does
not quietly fall back to the two-view shape.

## Decided behavior

- A Bot's own chat is one or more **threads**. The current thread is `sessionId` with
  its earlier parts in `segments`; a thread opened while the Bot is busy stays live in
  `openParts`, with its own earlier parts.
- **New session** starts an empty, independent conversation in the Bot's current
  working folder. The previous thread keeps its history and any turn in progress.
  Automatic context rollover still hands the conversation on within its own thread.
- The details panel shows one list ordered by the session's last activity. Each
  row uses the group name and part number (such as `Design-2`) or the Bot's
  own name and private session number (such as `Chief-1`). Current and earlier
  parts both show their creation and last activity times. A group row opens that member’s selected session transcript in the main conversation area. Opening a member from a group shows that member’s current session in the same area. Its Bot details stay alongside the transcript when the window fits both. The panel’s session list selects another group segment or returns to the private conversation. Group work appears in the group and its member session, while the private composer shows only its own activity.
  Viewing a current or archived part leaves the group delivery session in place. New session and Edit manage the Bot's private sessions.
- **Edit** shows a checkbox on each private row. **Delete** shows the selected count and
  asks for confirmation. Cancel returns to the selection. Confirm removes the
  selected sessions from the Bot and archives their DSH history. Running sessions
  must finish or be stopped first. Other sessions keep their history. When all
  sessions are removed the Bot gets an empty conversation in its working folder.
- Opening a background part makes it current; the two threads swap and both keep their
  own earlier parts. Nothing is archived or stopped by the swap. Opening a **running**
  part is read-only: the composer takes no input (Enter and the send button are
  blocked) until its turn ends, and a **Stop** action ends it. Two live sessions mean
  two model calls; the list says so.
- `chatOf(botId)` still returns the current part. Private deliveries use that
  part. Group deliveries use the current member session in their own room.

## Run mode

A Bot runs on one thing, so every thread of its own chat moves together: an idle part
moves at once, a running one moves at its next step, and one that cannot follow takes
no step until it has moved. A background part can never stay on the other run mode.

## Busy checks

A manual new conversation can start while the current session is idle or running.
Selecting any listed private Session can happen during another Session’s turn. Selecting an archived Session reopens its original transcript as a live thread. Other sessions keep their turns, history, pending cards and schedules.

## Archiving

A background part is
archived when the user deletes it or when its own thread moves on (context line, failed turn, run-mode change),
after its input has moved to the fresh part. Making another part current never archives
or stops it. Deleting a Bot releases every thread's sessions.

## Who is running

The host reads `rt.live` per session and exposes `running` for the current part and for
each background part. The client shows the mark from that state; it does not infer a
running turn from the transcript.

## A part is a thread everywhere, not only in the chat view

A second live Session must not become a side door. Everything that used to treat the
Bot's chat as one place follows the thread a part belongs to instead:

- **Permissions**: a preset change reaches every live part, and a change that fails
  halfway puts every part back on the preset the Bot had before it — not only the
  field. A stricter preset that misses the running background part would tell the user
  the Bot is strict while one part still runs wider.
- **Replies and requests**: a Bot writes to another Bot from the part it works in, so
  the answer comes back to that part's thread. The part is recorded with the request
  (the delivery source and the work record in `state.json`) and kept across a restart.
- **Resume and kept input**: work a restart cut off goes on in the part it ran in, and
  input a failed switch kept goes back to that part's thread. Only a part that is gone
  falls back to the Bot's current chat.
- **History**: a thread's earlier parts are the Bot's, and reading one reads that
  thread. `read_own_chat`, search and "load earlier" resolve a session to the thread it
  belongs to, including when the session is an earlier part that has already moved on.
- **Privacy**: a private Bot's background parts are closed to other Bots exactly like its
  chat.

## Out of scope

- Two windows side by side (the next step; this change is "parallel work", not "two
  visible windows"), and the two-view shape above.
- Group membership is managed in group settings.
- The Bot identity model: still one Bot, one identity, one memory.

## 变更

- 2026-11-20：个人详情用一个列表显示所有会话，每行直接写「群名-段号」或「Bot 名-段号」，按最后活跃时间排序。当前段与历史段都显示创建时间和最后活跃时间。旧时间不可取得时显示「—」。
