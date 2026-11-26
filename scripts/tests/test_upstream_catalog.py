"""Behavioral checks use temporary SQLite and a separate fixture Git repository."""
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from upstream_catalog.store import Store, Conflict, CatalogError, REPO_ID
from upstream_catalog.source import sync, reassess, writable, database_path
from upstream_catalog.web import server


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ds-upstream-catalog-test-')
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo';self.repo.mkdir()
        self.run_git('init', '-b', 'sync-test')
        self.run_git('remote','add','upstream','https://github.com/Fei-Craft/DS-Bot.git')
        self.run_git('config', 'user.name', 'Test User')
        self.run_git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'plugin.js').write_text('initial\n')
        self.run_git('add', '.');self.run_git('commit', '-m', 'Initial fixture')
        self.base = self.run_git('rev-parse', 'HEAD')
        self.ledger = self.repo / 'upstream-changelog.md'
        self.ledger.write_text('''# fixture

## 2026-11-25

| PR | 状态 | 权重 | 上游改动 | 原因类型 | 实际差异与采用范围 | 解决方式与通过条件 |
| --- | --- | --- | --- | --- | --- | --- |
| [#1](https://example.invalid/1) | 采用 | 8 | 修复投递 | 已验证 | 历史代码与证据 | 通过条件：同一消息只发送一次 |
| [#2](https://example.invalid/2) | 暂缓 | 9 | 增加搜索 | 缺少适配 | 原历史 | 补齐搜索和返回入口 |
''')
        self.path = self.root / 'catalog.sqlite3'
        self.store = Store(self.path)
        self.snapshots = {1: {'sha': self.base, 'files': ['plugin.js']}, 2: {'sha': self.base, 'files': ['other.js']}}
        self.store.bootstrap(self.ledger, self.snapshots, self.base, self.base, {})

    def tearDown(self):
        self.store.db.close();self.tmp.cleanup()

    def run_git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True, stderr=subprocess.DEVNULL).strip()

    def test_import_repeat_and_choices_survive_reopen(self):
        first = self.store.preference(2, 0, '保留本地行为', 0)
        with Store(self.path) as second:
            result = second.bootstrap(self.ledger, {}, self.base, self.base, {})
            self.assertEqual(result['imported'], 0)
            self.assertEqual(second.stats()['total'], 2)
            self.assertEqual(second.detail(2)['wanted'], 0)
            self.assertEqual(second.detail(2)['choice_reason'], '保留本地行为')
        self.assertEqual(first['choice_revision'], 1)

    def test_optimistic_choice_conflict_and_undo(self):
        self.store.preference(1, 0, '', 0)
        with self.assertRaises(Conflict):self.store.preference(1, 1, 'stale tab', 0)
        self.assertEqual(self.store.detail(1)['wanted'], 0)
        self.store.preference(1, None, '撤销', 1)
        self.assertIsNone(self.store.detail(1)['wanted'])
        self.assertEqual(self.store.detail(1)['status'], '采用')

    def test_filters_sort_pagination_and_sql_input(self):
        self.store.preference(2, 0, '选择', 0)
        self.assertEqual([r['number'] for r in self.store.list({})['rows']], [1, 2])
        self.assertEqual(self.store.list({'wanted': '0','min':'9'})['rows'][0]['number'], 2)
        self.assertEqual(self.store.list({'q': "' OR 1=1 --"})['total'], 0)
        self.assertEqual(self.store.list({'limit': '1','offset':'1'})['rows'][0]['number'], 2)
        with self.assertRaises(CatalogError):self.store.list({'status': '部分采用'})
        with self.assertRaises(CatalogError):self.store.list({'limit': '-1'})

    def test_export_retains_history_and_is_repeatable(self):
        self.store.preference(1, 0, '已装过，停止跟进', 0)
        out = self.store.export(self.ledger)
        text = self.ledger.read_text()
        self.assertEqual(out['changed'], 1)
        self.assertIn('历史代码与证据', text)
        self.assertIn('不自动回滚代码', text)
        self.assertIn('| 采用 |', text)
        self.assertEqual(self.store.export(self.ledger)['changed'], 0)
        self.assertEqual(self.store.bootstrap(self.ledger, {}, self.base, self.base, {})['imported'], 0)
        self.assertEqual(self.store.stats()['pendingExport'], 0)

    def test_export_refuses_concurrent_markdown_change(self):
        self.store.preference(2, 1, '', 0)
        self.ledger.write_text(self.ledger.read_text() + '\n另一个会话的内容\n')
        original = self.ledger.read_bytes()
        with self.assertRaises(Conflict):self.store.export(self.ledger)
        self.assertEqual(self.ledger.read_bytes(), original)
        self.assertEqual(self.store.detail(2)['wanted'], 1)

    def test_incremental_inventory_does_not_advance_before_analysis(self):
        (self.repo / 'new.js').write_text('new')
        self.run_git('add', 'new.js');self.run_git('commit', '-m', 'Merge pull request #9001 from fixture/feature\n\nAdd bounded search')
        end = self.run_git('rev-parse', 'HEAD')
        result = sync(self.store, self.repo, end)
        self.assertEqual(result['commitsExamined'], 1)
        self.assertEqual(result['pendingAnalysis'], [9001])
        self.assertFalse(result['checkpointAdvanced'])
        self.assertEqual(self.store.stats()['source']['checkpoint_sha'], self.base)
        self.store.preference(9001, 0, '当前不需要', 0)
        result = sync(self.store, self.repo, end)
        self.assertEqual(result['changedPRs'], [])
        self.assertEqual(result['pendingAnalysis'], [9001])
        self.store.annotate(9001,dict(purpose='按范围搜索',scenario='输入关键词定位结果',effect='减少查找时间',reason='用户不需要',solution='跳过并保留来源',status='跳过'),end)
        result = sync(self.store,self.repo,end)
        self.assertTrue(result['checkpointAdvanced'])
        self.assertEqual(self.store.detail(9001)['wanted'], 0)
        self.assertEqual(sync(self.store, self.repo, end)['commitsExamined'], 0)
        self.assertEqual(self.store.stats()['total'], 3)

    def test_annotation_completes_pending_inventory_and_rejects_half_status(self):
        self.run_git('commit', '--allow-empty', '-m', 'Merge pull request #9002 from fixture/fix\n\nFix pending work')
        end = self.run_git('rev-parse', 'HEAD');sync(self.store,self.repo,end)
        values = dict(purpose='修复等待投递', scenario='重启后检查原队列', effect='避免丢失消息', status='暂缓', weight=7, reason='需本地适配', solution='适配后验证一次投递')
        with self.assertRaises(CatalogError):self.store.annotate(9002,{**values,'status':'部分采用'},end)
        self.store.annotate(9002,values,end)
        self.assertTrue(sync(self.store,self.repo,end)['checkpointAdvanced'])
        events = len(self.store.detail(9002)['history'])
        self.store.annotate(9002,values,end)
        self.assertEqual(len(self.store.detail(9002)['history']),events)

    def test_failed_source_scan_keeps_checkpoint_and_data(self):
        before = self.store.stats()
        with self.assertRaises(CatalogError):sync(self.store,self.repo,'missing-commit')
        self.assertEqual(self.store.stats()['source'],before['source'])
        self.assertEqual(self.store.stats()['total'],before['total'])

    def test_local_reassessment_is_scoped_and_respects_not_wanted(self):
        (self.repo / 'plugin.js').write_text('changed')
        self.assertEqual(reassess(self.store,self.repo),[1])
        self.store.preference(1,0,'不再跟进',0)
        self.assertEqual(reassess(self.store,self.repo),[])
        self.assertEqual(self.store.detail(2)['needs_review'],0)

    def test_failed_transaction_records_failure_without_partial_inventory(self):
        self.run_git('commit','--allow-empty','-m','Merge pull request #9010 from fixture/failure')
        end = self.run_git('rev-parse','HEAD')
        original = self.store.event
        def fail(*args, **kwargs):raise RuntimeError('controlled write failure')
        self.store.event = fail
        try:
            with self.assertRaises(RuntimeError):sync(self.store,self.repo,end)
        finally:self.store.event = original
        self.assertEqual(self.store.stats()['total'],2)
        self.assertEqual(self.store.stats()['source']['checkpoint_sha'],self.base)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM sync_runs WHERE outcome='failed'").fetchone()[0],1)

    def test_direct_commit_review_is_cached_and_exported_once(self):
        self.run_git('commit','--allow-empty','-m','Refresh source documentation')
        end = self.run_git('rev-parse','HEAD')
        result = sync(self.store,self.repo,end)
        self.assertEqual(result['directCommits'],[end])
        records = self.store.meta('direct_commits')
        records[end].update(reviewed=True,purpose='更新来源文档',reason='仅文档',solution='核对链接',status='暂缓')
        with self.store.db:self.store.set_meta('direct_commits',records)
        self.assertTrue(sync(self.store,self.repo,end)['checkpointAdvanced'])
        self.assertEqual(self.store.export(self.ledger)['changed'],1)
        self.assertEqual(self.store.export(self.ledger)['changed'],0)
        self.assertEqual(self.ledger.read_text().count('/commit/'+end),1)

    def test_source_identity_is_not_silently_replaced(self):
        self.run_git('remote','set-url','upstream','https://github.com/example/other.git')
        with self.assertRaises(CatalogError):sync(self.store,self.repo,self.base)
        self.assertEqual(self.store.stats()['source']['checkpoint_sha'],self.base)

    def test_shared_path_and_dev_write_guard(self):
        self.assertEqual(database_path(self.repo),(self.repo / '.git/upstream-sync/upstream.sqlite3').resolve())
        self.run_git('switch','-c','dev')
        with self.assertRaises(CatalogError):writable(self.repo)

    def test_rejects_unrelated_database_without_mutating_it(self):
        path = self.root / 'unrelated.sqlite3'
        connection = sqlite3.connect(path)
        connection.execute('CREATE TABLE user_data(value TEXT)');connection.commit();connection.close()
        with self.assertRaises(CatalogError):Store(path)
        connection = sqlite3.connect(path)
        try:self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(),[('user_data',)])
        finally:connection.close()

    def test_backup_is_consistent(self):
        self.store.preference(2,0,'持久化',0)
        target = self.root / 'backup.sqlite3';self.store.backup(target)
        with Store(target) as copy:
            self.assertEqual(copy.detail(2)['wanted'],0)
            self.assertEqual(copy.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')

    def test_http_real_reads_writes_origin_and_allowlist(self):
        host = server(self.repo,self.path,0)
        thread = threading.Thread(target=host.serve_forever);thread.start()
        origin = f'http://127.0.0.1:{host.server_port}'
        def call(path,body=None,origin_header=None):
            headers = {} if body is None else {'Content-Type':'application/json'}
            if origin_header:headers['Origin'] = origin_header
            req = urllib.request.Request(origin+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
            with urllib.request.urlopen(req,timeout=5) as response:return response.status,response.read()
        try:
            self.assertEqual(json.loads(call('/api/prs?status='+urllib.parse.quote('暂缓'))[1])['total'],1)
            with self.assertRaises(urllib.error.HTTPError) as error:call('/api/preference',{'number':2,'wanted':0,'revision':0})
            self.assertEqual(error.exception.code,403);error.exception.close()
            response = json.loads(call('/api/preference',{'number':2,'wanted':0,'revision':0},origin)[1])
            self.assertEqual(response['wanted'],0)
            with self.assertRaises(urllib.error.HTTPError) as error:call('/api/preference',[],origin)
            self.assertEqual(error.exception.code,400);error.exception.close()
            with self.assertRaises(urllib.error.HTTPError) as error:call('/.git/config')
            self.assertEqual(error.exception.code,404);error.exception.close()
            self.assertIn(b'upstream',call('/')[1])
        finally:
            host.shutdown();host.server_close();thread.join(5)
            self.assertFalse(thread.is_alive())


if __name__ == '__main__':unittest.main()
