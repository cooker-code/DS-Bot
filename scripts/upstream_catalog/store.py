"""SQLite owns structured assessments; user choices survive every source refresh."""
import hashlib
import html
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

GUIDE = {int(n): (purpose, scenario) for n, purpose, scenario in (line.split('|', 2) for line in Path(__file__).with_name('explanations.tsv').read_text().splitlines() if line)}
REPO_ID = 1409013846
SOURCE_URL = 'https://github.com/Fei-Craft/DS-Bot'
STATUSES = ('采用', '需讨论', '暂缓', '跳过')
RANK = "CASE p.status WHEN '采用' THEN 0 WHEN '需讨论' THEN 1 WHEN '暂缓' THEN 2 ELSE 3 END"
SCHEMA = '''
CREATE TABLE sources(repo_id INTEGER PRIMARY KEY,canonical_url TEXT NOT NULL,branch TEXT NOT NULL,checkpoint_sha TEXT,scanned_at TEXT);
CREATE TABLE prs(repo_id INTEGER NOT NULL REFERENCES sources(repo_id),number INTEGER NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,purpose TEXT,scenario TEXT,effect TEXT,category TEXT,status TEXT NOT NULL CHECK(status IN ('采用','需讨论','暂缓','跳过')),weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 10),dependency_group TEXT,dependencies_json TEXT NOT NULL DEFAULT '[]',merge_sha TEXT,upstream_json TEXT,local_sha TEXT,reason TEXT,local_difference TEXT,solution TEXT,verification TEXT,legacy_deployed_json TEXT NOT NULL DEFAULT '[]',first_seen_at TEXT,analyzed_at TEXT,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,needs_review INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(repo_id,number));
CREATE TABLE preferences(repo_id INTEGER NOT NULL,pr_number INTEGER NOT NULL,wanted INTEGER CHECK(wanted IN (0,1)),reason TEXT,decided_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(repo_id,pr_number),FOREIGN KEY(repo_id,pr_number) REFERENCES prs(repo_id,number));
CREATE TABLE sync_runs(id INTEGER PRIMARY KEY,repo_id INTEGER NOT NULL REFERENCES sources(repo_id),from_sha TEXT,to_sha TEXT NOT NULL,local_branch TEXT NOT NULL,local_sha TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,outcome TEXT NOT NULL CHECK(outcome IN ('running','complete','failed','needs_analysis')),error TEXT);
CREATE TABLE events(id INTEGER PRIMARY KEY,repo_id INTEGER NOT NULL,pr_number INTEGER NOT NULL,kind TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor TEXT NOT NULL,recorded_at TEXT NOT NULL,run_id INTEGER REFERENCES sync_runs(id),FOREIGN KEY(repo_id,pr_number) REFERENCES prs(repo_id,number));
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE INDEX prs_status_weight ON prs(status,weight DESC,number);
CREATE INDEX prs_group ON prs(dependency_group);
'''

class CatalogError(Exception):
    pass

class Conflict(CatalogError):
    pass


def now():
    return datetime.now(ZoneInfo('Asia/Taipei')).isoformat(timespec='seconds')


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def plain(text):
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return re.sub(r'[*`]|<br\s*/?>', '', text).strip()


class Store:
    def __init__(self, path, readonly=False):
        self.path = Path(path)
        if readonly and not self.path.exists():raise CatalogError('台账不存在')
        if not readonly:self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=10) if readonly else sqlite3.connect(self.path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA busy_timeout=10000')
        version = self.db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, 1):
            self.db.close()
            raise CatalogError('Unsupported catalog schema version')
        if version == 0:
            if readonly:
                self.db.close()
                raise CatalogError('台账尚未初始化')
            if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").fetchone():
                self.db.close()
                raise CatalogError('目标不是上游台账，拒绝向已有数据库创建表')
            self.db.executescript('BEGIN;\n' + SCHEMA + '\nPRAGMA user_version=1;\nCOMMIT;')
        tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'sources','prs','preferences','events','sync_runs','metadata'}.issubset(tables):
            self.db.close()
            raise CatalogError('目标不符合上游台账结构，拒绝修改')
        if not readonly:self.db.execute('PRAGMA journal_mode=WAL')

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.db.close()

    def meta(self, key, fallback=None):
        row = self.db.execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else fallback

    def set_meta(self, key, value):
        self.db.execute('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value, ensure_ascii=False)))

    def event(self, number, kind, before, after, actor='sync', run_id=None):
        self.db.execute('INSERT INTO events(repo_id,pr_number,kind,before_json,after_json,actor,recorded_at,run_id) VALUES(?,?,?,?,?,?,?,?)', (REPO_ID, number, kind, json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False), actor, now(), run_id))

    def bootstrap(self, markdown, snapshots, local_sha, checkpoint, groups):
        text = Path(markdown).read_text()
        rows = []
        batch_date = None
        for line in text.splitlines():
            heading = re.match(r'^## (20\d{2}-\d{2}-\d{2})', line)
            if heading:batch_date = heading[1]
            match = re.match(r'^\| \[#(\d+)\]\(', line)
            if not match:
                continue
            cells = [c.strip() for c in line.strip('|').split('|')]
            if len(cells) != 7 or cells[1] not in STATUSES:
                raise CatalogError('Invalid canonical ledger row: ' + match[1])
            rows.append((int(match[1]), cells, batch_date))
        if not rows or len(rows) != len({n for n, _, _ in rows}):
            raise CatalogError('Ledger has no sources or duplicate PR keys')
        changed = 0
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?)', (REPO_ID, SOURCE_URL, 'dev', checkpoint, now()))
            for number, c, batch_date in rows:
                old = self.db.execute('SELECT * FROM prs WHERE repo_id=? AND number=?', (REPO_ID, number)).fetchone()
                if old and old['status'] == c[1] and old['title'] == c[3] and old['reason'] == c[4] and old['local_difference'] == c[5] and old['solution'] == c[6]:
                    if not old['analyzed_at'] and number in GUIDE and (old['purpose'], old['scenario']) != GUIDE[number]:
                        purpose, scenario = GUIDE[number]
                        self.db.execute('UPDATE prs SET purpose=?,scenario=?,effect=? WHERE repo_id=? AND number=?', (purpose, scenario, purpose + '\n本地适用性：' + plain(c[4]), REPO_ID, number))
                    continue
                snap = snapshots.get(number, {})
                # Preserve human-written assessments on a repeat import. Import is not a source refresh.
                if old:
                    raise Conflict(f'PR {number} differs from the catalog; review/import the changes explicitly')
                details = plain(c[5])
                original = re.split(r'历史登记依据|原始(?:登记|说明)|上游以', details)[-1]
                purpose = GUIDE.get(number, (c[3] + '。' + original[:260], None))[0]
                scenario = plain(c[6])
                scenario = GUIDE.get(number, (None, scenario.split('通过条件：')[-1][:420]))[1]
                category = 'feature' if re.search('新增|支持|设置|工具|入口|功能|后台任务', c[3]) else 'fix'
                if re.search('文档|翻译|测试|发布|依赖|升级', c[3]):
                    category = 'maintenance'
                dates = re.findall(r'20\d{2}-\d{2}-\d{2}(?: \d{2}:\d{2} \+0800)?', c[5])
                historical = re.findall(r'(?:0\.\d+\.\d+(?:[-.]\w+)*(?:[-.]\d+)?(?:-upstream)?)', c[5])
                values = dict(repo_id=REPO_ID, number=number, url=f'{SOURCE_URL}/pull/{number}', title=c[3], purpose=purpose, scenario=scenario, effect=purpose + '\n本地适用性：' + plain(c[4]), category=category, status=c[1], weight=int(c[2]), dependency_group=groups.get(number), dependencies_json=json.dumps(sorted(set(int(n) for n in re.findall(r'(?:PR\s*#|\[#)(\d+)', c[6])) - {number})), merge_sha=snap.get('sha'), upstream_json=json.dumps(snap, ensure_ascii=False), local_sha=local_sha, reason=c[4], local_difference=c[5], solution=c[6], verification=plain(c[5]) if c[1] == '采用' else None, legacy_deployed_json=json.dumps(sorted(set(historical)), ensure_ascii=False), first_seen_at=batch_date, analyzed_at=None, updated_at=now(), needs_review=0)
                keys = ','.join(values)
                self.db.execute(f'INSERT INTO prs({keys}) VALUES({",".join("?" for _ in values)})', tuple(values.values()))
                self.event(number, 'import', None, {'status': c[1], 'source': 'upstream-changelog.md'})
                changed += 1
            self.set_meta('ledger_digest', digest(text))
            self.set_meta('ledger_file', str(Path(markdown).resolve()))
        return {'imported': changed, 'total': len(rows), 'preferencesPreserved': True}

    def stats(self):
        counts = dict(self.db.execute('SELECT status,count(*) FROM prs GROUP BY status').fetchall())
        choices = self.db.execute('SELECT count(*) FROM preferences WHERE wanted=0').fetchone()[0]
        direct = self.meta('direct_commits', {})
        direct_pending = sum(1 for item in direct.values() if item.get('reviewed') and not item.get('exported'))
        return {'directCommits': len(direct), 'total': sum(counts.values()), 'statuses': {s: counts.get(s, 0) for s in STATUSES}, 'notWanted': choices, 'needsReview': self.db.execute('SELECT count(*) FROM prs WHERE needs_review=1').fetchone()[0], 'pendingExport': self.db.execute("SELECT count(*) FROM events WHERE id>? AND kind IN ('preference','analysis','source')", (self.meta('exported_event', 0),)).fetchone()[0] + direct_pending, 'source': dict(self.db.execute('SELECT * FROM sources WHERE repo_id=?', (REPO_ID,)).fetchone() or {})}

    def list(self, args):
        conditions, params = ['p.repo_id=?'], [REPO_ID]
        for field, value in [('status', args.get('status')), ('dependency_group', args.get('group')), ('category', args.get('category'))]:
            if value:
                if field == 'status' and value not in STATUSES:
                    raise CatalogError('Invalid status')
                conditions.append(f'p.{field}=?');params.append(value)
        if args.get('wanted') in ('0', '1', 'unset'):
            conditions.append('c.wanted IS NULL' if args['wanted'] == 'unset' else 'c.wanted=?')
            if args['wanted'] != 'unset':params.append(int(args['wanted']))
        for field, op, fallback in [('min', '>=', 1), ('max', '<=', 10)]:
            try:value = int(args.get(field) or fallback)
            except ValueError:raise CatalogError('Invalid weight')
            if not 1 <= value <= 10:raise CatalogError('Invalid weight')
            conditions.append('p.weight' + op + '?');params.append(value)
        if args.get('stale') == '1':conditions.append('p.needs_review=1')
        for term in str(args.get('q', '')).strip().split():
            conditions.append("(CAST(p.number AS TEXT)||' '||p.title||' '||coalesce(p.purpose,'')||' '||coalesce(p.scenario,'')||' '||coalesce(p.local_difference,'')||' '||coalesce(p.upstream_json,'')) LIKE ?")
            params.append('%' + term.lstrip('#') + '%')
        try:limit, offset = int(args.get('limit') or 50), int(args.get('offset') or 0)
        except ValueError:raise CatalogError('Invalid pagination')
        if not 1 <= limit <= 100 or offset < 0:raise CatalogError('Invalid pagination')
        join = ' FROM prs p LEFT JOIN preferences c ON c.repo_id=p.repo_id AND c.pr_number=p.number WHERE ' + ' AND '.join(conditions)
        total = self.db.execute('SELECT count(*)' + join, params).fetchone()[0]
        order = 'p.updated_at DESC,p.number' if args.get('sort') == 'time' else RANK + ',p.weight DESC,p.number'
        rows = self.db.execute('SELECT p.*,c.wanted,c.reason choice_reason,c.decided_at,c.revision choice_revision' + join + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', [*params, limit, offset]).fetchall()
        return {'total': total, 'offset': offset, 'rows': [dict(r) for r in rows]}

    def detail(self, number):
        row = self.db.execute('SELECT p.*,c.wanted,c.reason choice_reason,c.decided_at,c.revision choice_revision FROM prs p LEFT JOIN preferences c ON c.repo_id=p.repo_id AND c.pr_number=p.number WHERE p.repo_id=? AND p.number=?', (REPO_ID, number)).fetchone()
        if not row:raise CatalogError('PR not found')
        out = dict(row)
        out['history'] = [dict(r) for r in self.db.execute('SELECT * FROM events WHERE repo_id=? AND pr_number=? ORDER BY id DESC', (REPO_ID, number))]
        return out

    def preference(self, number, wanted, reason, revision):
        if wanted not in (None, 0, 1) or (wanted is not None and type(wanted) is not int) or not isinstance(reason, str) or len(reason) > 4000:
            raise CatalogError('Invalid choice')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.detail(number)
            before = self.db.execute('SELECT * FROM preferences WHERE repo_id=? AND pr_number=?', (REPO_ID, number)).fetchone()
            current = before['revision'] if before else 0
            if revision != current:raise Conflict('选择已在另一页面更新，请重新加载后保存')
            after = {'wanted': wanted, 'reason': reason.strip()}
            if before and before['wanted'] == wanted and before['reason'] == reason.strip():return self.detail(number)
            self.db.execute('INSERT INTO preferences VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,pr_number) DO UPDATE SET wanted=excluded.wanted,reason=excluded.reason,decided_at=excluded.decided_at,revision=excluded.revision', (REPO_ID, number, wanted, reason.strip(), now(), current + 1))
            self.event(number, 'preference', dict(before) if before else None, after, 'user')
        return self.detail(number)

    def annotate(self, number, values, local_sha):
        allowed = {'purpose', 'scenario', 'effect', 'category', 'status', 'weight', 'dependency_group', 'reason', 'local_difference', 'solution', 'verification', 'dependencies_json'}
        if not values or set(values) - allowed:raise CatalogError('Unsupported annotation fields')
        if any(k != 'weight' and not isinstance(v, str) for k,v in values.items()):raise CatalogError('评估字段必须为文本，weight必须为整数')
        if 'dependencies_json' in values:
            dependencies = json.loads(values['dependencies_json'])
            if not isinstance(dependencies,list) or any(type(n) is not int or n<=0 for n in dependencies):raise CatalogError('依赖必须是PR号数组')
        current = self.detail(number)
        after = {**current, **values}
        if after['status'] not in STATUSES or type(after['weight']) is not int or not 1 <= after['weight'] <= 10:raise CatalogError('Invalid status or weight')
        if not all(isinstance(after.get(f), str) and after[f].strip() for f in ['purpose', 'scenario', 'effect', 'reason', 'solution']):raise CatalogError('功能、场景、效果、原因和解法不能为空')
        if after['status'] == '采用' and not after.get('verification'):raise CatalogError('采用必须有验证证据')
        if all(current.get(k) == v for k, v in values.items()) and current['local_sha'] == local_sha and not current['needs_review']:
            return current
        update = {**values, 'local_sha': local_sha, 'analyzed_at': now(), 'updated_at': now(), 'needs_review': 0}
        with self.db:
            self.db.execute('UPDATE prs SET ' + ','.join(k + '=?' for k in update) + ',revision=revision+1 WHERE repo_id=? AND number=?', [*update.values(), REPO_ID, number])
            self.event(number, 'analysis', {k: current[k] for k in values}, values)
        return self.detail(number)

    def export(self, markdown):
        path = Path(markdown);text = path.read_text()
        if digest(text) != self.meta('ledger_digest'):raise Conflict('Markdown已变化，请先对账；未覆盖文件')
        lines = text.splitlines();seen = set();exported_details = {}
        pending = self.db.execute("SELECT * FROM events WHERE id>? AND kind IN ('preference','analysis','source') ORDER BY id", (self.meta('exported_event', 0),)).fetchall()
        direct = self.meta('direct_commits', {})
        direct_pending = [item for item in direct.values() if item.get('reviewed') and not item.get('exported')]
        if not pending and not direct_pending:return {'changed': 0}
        affected = {r['pr_number'] for r in pending}
        for i, line in enumerate(lines):
            m = re.match(r'^\| \[#(\d+)\]\(', line)
            if not m:continue
            number = int(m[1]);seen.add(number)
            if number not in affected:continue
            r = self.detail(number);c = line.split('|');c[2] = ' ' + r['status'] + ' ';c[3] = ' ' + str(r['weight']) + ' '
            # Keep the entire dated ledger history; prefix the latest assessment/choice only once.
            decision = '待评估' if r['wanted'] is None else '需要' if r['wanted'] else '不需要，后续同步跳过（不自动回滚代码）'
            latest = f' **{now()} · 台账更新**。我的选择：{decision}；{r["choice_reason"] or "未填写理由"}。功能：{r["purpose"]} 场景：{r["scenario"]} <br>'
            if any(event['pr_number'] == number and event['kind'] == 'analysis' for event in pending):
                latest += f' 本次采用结果：{r["status"]}；本地差异：{r["local_difference"]}；验证：{r["verification"] or "尚未验证"}。 <br>'
            c[5] = ' ' + r['reason'].replace('|', '&#124;') + ' '
            c[6] = html.escape(latest, quote=False).replace('&lt;br&gt;', '<br>').replace('|', '&#124;') + c[6]
            c[7] = ' ' + r['solution'].replace('|', '&#124;') + ' '
            c[6] = c[6].replace('\n', '<br>')
            lines[i] = '|'.join(c)
            exported_details[number] = c[6].strip()
        for number in sorted(affected - seen):
            r = self.detail(number)
            if not lines[-1].startswith('| [#'):lines += ['', '| PR | 状态 | 权重 | 上游改动 | 原因类型 | 实际差异与采用范围 | 解决方式与通过条件 |', '| --- | --- | --- | --- | --- | --- | --- |']
            cells = [f'[#'+str(number)+f']({r["url"]})', r['status'], str(r['weight']), r['title'], r['reason'] or '待评估', r['purpose'] or '说明尚待补齐', r['solution'] or '需完成评估与验证']
            lines.append('| ' + ' | '.join(str(c).replace('|', '&#124;').replace('\n', '<br>') for c in cells) + ' |')
        for item in direct_pending:
            key = f'[{item["sha"][:7]}]'
            line = '| ' + ' | '.join(str(value).replace('|','&#124;').replace('\n','<br>') for value in [f'{key}({SOURCE_URL}/commit/{item["sha"]})', item['status'], item.get('weight',5), item.get('purpose',''), item.get('reason',''), item.get('verification',''), item.get('solution','')]) + ' |'
            existing = next((at for at,value in enumerate(lines) if f'({SOURCE_URL}/commit/{item["sha"]})' in value and value.startswith('| ')),None)
            if existing is None:
                lines += ['', '| 直接提交 | 状态 | 权重 | 功能作用 | 原因 | 验证 | 方案 |', '| --- | --- | --- | --- | --- | --- | --- |', line]
            else:lines[existing] = line
            item['exported'] = True
        pattern = re.compile(r'^\| \[#(\d+)\]\(');i = 0
        while i < len(lines):
            if not pattern.match(lines[i]):i += 1;continue
            end = i
            while end < len(lines) and pattern.match(lines[end]):end += 1
            lines[i:end] = sorted(lines[i:end], key=lambda l: (STATUSES.index(l.split('|')[2].strip()), -int(l.split('|')[3]), int(pattern.match(l)[1])))
            i = end
        updated = '\n'.join(lines) + '\n'
        # Files cannot share a transaction with SQLite. Replace atomically; an interrupted retry detects digest mismatch.
        temp = path.with_suffix('.md.tmp');temp.write_text(updated);temp.replace(path)
        with self.db:
            self.db.executemany('UPDATE prs SET local_difference=? WHERE repo_id=? AND number=?', [(value, REPO_ID, number) for number, value in exported_details.items()])
            self.set_meta('ledger_digest', digest(updated))
            if pending:self.set_meta('exported_event', max(r['id'] for r in pending))
            self.set_meta('direct_commits', direct)
        return {'changed': len(affected) + len(direct_pending), 'path': str(path)}

    def backup(self, target):
        out = sqlite3.connect(target)
        try:self.db.backup(out)
        finally:out.close()
