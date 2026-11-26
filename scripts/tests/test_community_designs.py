"""Design information must support adoption decisions without changing PR facts."""
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from upstream_catalog.store import Store, CatalogError, SCHEMA
from upstream_catalog.source import sync, snapshot
from upstream_catalog import community

NOTE=dict(title='会话能力包',purpose='按当前会话装卸能力，减少无关工具开销',scenario='需要工具时加载能力包，换段后清理',limitations='管理能力只给Main，执行仍校验权限',upstream_stage='已实现',stage_evidence='固定实现PR与设计正文',local_notes='保留并行会话、项目卡与本地权限',scope='plugin')

class CommunityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='ds-community-test-');self.addCleanup(self.tmp.cleanup)
        self.repo=Path(self.tmp.name)/'repo';self.repo.mkdir()
        self.git('init','-b','catalog-test');self.git('config','user.name','Test');self.git('config','user.email','test@example.invalid')
        self.git('remote','add','upstream','https://github.com/Fei-Craft/DS-Bot.git')
        (self.repo/'plugin.js').write_text('initial');self.git('add','.');self.git('commit','-m','Initial')
        self.base=self.git('rev-parse','HEAD');self.dbpath=Path(self.tmp.name)/'catalog.sqlite3';self.store=Store(self.dbpath);self.addCleanup(self.store.db.close)
        self.ledger=self.repo/'upstream-changelog.md';self.ledger.write_text('## 2026-11-26\n\n| [#1](https://example.invalid/1) | 采用 | 9 | 修复 | 已验证 | 原始证据 | 原通过条件 |\n| [#2](https://example.invalid/2) | 暂缓 | 7 | 设置 | 适配待完成 | 本地差异 | 完整适配 |\n')
        self.store.bootstrap(self.ledger,{},self.base,self.base,{})
        self.metadata=patch('upstream_catalog.source.github_metadata',side_effect=lambda ns:{n:{'createdAt':'2026-11-20T01:00:00Z','githubMergedAt':'2026-11-21T01:00:00Z'} for n in ns});self.metadata.start();self.addCleanup(self.metadata.stop)
    def git(self,*args):return subprocess.check_output(['git','-C',str(self.repo),*args],text=True,stderr=subprocess.DEVNULL).strip()
    def plan(self,path='docs/plans/feature.md',body='# 会话能力包\n\n## 为什么\n按需装卸工具。',number=9001):
        p=self.repo/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(body)
        (self.repo/'ds-bot').mkdir(exist_ok=True);(self.repo/'ds-bot/tool.js').write_text(body)
        self.git('add','.');self.git('commit','-m',f'Merge pull request #{number} from fixture/design');return self.git('rev-parse','HEAD')
    def apply(self,sha,number=1,historical=False):
        bundle=community.prepare(self.store,self.repo,[(number,snapshot(self.repo,sha))],sha,historical)
        with self.store.db:return community.apply(self.store,bundle)
    def test_design_versions_repeat_and_local_decisions_remain_separate(self):
        sha=self.plan();result=self.apply(sha);identity=result['changedDesigns'][0]
        self.assertEqual(result['pendingDesigns'],[identity])
        with self.assertRaises(CatalogError):community.annotate(self.store,identity,{'title':'只改标题'})
        community.annotate(self.store,identity,NOTE)
        first=community.design_detail(self.store,identity);self.assertEqual(first['counts']['采用'],1)
        self.assertIn('blob/',first['url']);self.assertIn('按需装卸工具',first['body'])
        self.store.preference(1,0,'用户不需要',0)
        self.assertEqual(self.apply(sha)['changedDesigns'],[])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM design_versions').fetchone()[0],1)
        self.assertEqual(community.design_detail(self.store,identity)['synced_at'],first['synced_at'])
        self.assertEqual(self.store.detail(1)['wanted'],0);self.assertEqual(self.store.detail(1)['status'],'采用')
        self.assertTrue(self.store.detail(1)['designs'][0]['pr_body'])
    def test_incremental_checkpoint_waits_for_pr_and_design_explanations(self):
        end=self.plan();result=sync(self.store,self.repo,end);identity=result['pendingDesigns'][0]
        self.assertFalse(result['checkpointAdvanced']);self.assertEqual(self.store.stats()['source']['checkpoint_sha'],self.base)
        self.store.annotate(9001,dict(purpose='按需工具',scenario='加载工具',effect='减少开销',reason='适配待完成',solution='保留权限后验证',status='暂缓'),end)
        self.assertFalse(sync(self.store,self.repo,end)['checkpointAdvanced'])
        community.annotate(self.store,identity,NOTE)
        self.assertTrue(sync(self.store,self.repo,end)['checkpointAdvanced'])
        self.assertEqual(sync(self.store,self.repo,end)['commitsExamined'],0)
    def test_design_failure_rolls_back_pr_source_and_document(self):
        end=self.plan();original=community.apply
        def fail(*args):original(*args);raise RuntimeError('controlled design failure')
        with patch('upstream_catalog.community.apply',side_effect=fail):
            with self.assertRaises(RuntimeError):sync(self.store,self.repo,end)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM designs').fetchone()[0],0)
        self.assertEqual(self.store.stats()['total'],2);self.assertEqual(self.store.stats()['source']['checkpoint_sha'],self.base)
    def test_rename_delete_and_source_changes_preserve_identity(self):
        sha=self.plan();identity=self.apply(sha)['changedDesigns'][0];community.annotate(self.store,identity,NOTE)
        self.git('mv','docs/plans/feature.md','docs/plans/renamed.md');self.git('commit','-m','Rename design')
        renamed=self.git('rev-parse','HEAD');self.apply(renamed,2)
        row=community.design_detail(self.store,identity);self.assertEqual(row['path'],'docs/plans/renamed.md');self.assertEqual(row['effective_stage'],'待核实')
        p=self.repo/'docs/plans/renamed.md';p.write_text('# 新能力包\n新增行为');self.git('add','.');self.git('commit','-m','Change design');self.apply(self.git('rev-parse','HEAD'),2)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM designs').fetchone()[0],1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM design_versions').fetchone()[0],2)
        self.git('rm','docs/plans/renamed.md');self.git('commit','-m','Remove design');self.apply(self.git('rev-parse','HEAD'),2)
        self.assertEqual(community.design_detail(self.store,identity)['document_state'],'deleted')
        self.assertIn('新增行为',community.design_detail(self.store,identity)['body'])
    def test_index_is_not_a_feature_and_doc_only_change_is_not_adoption(self):
        sha=self.plan(path='docs/plans/README.md',body='# 设计目录');result=self.apply(sha)
        self.assertEqual(result['pendingDesigns'],[]);self.assertEqual(community.list_entries(self.store,{'kind':'design'})['total'],0)
        self.assertTrue(any(r['key']=='pr:1' for r in community.list_entries(self.store,{'kind':'pr'})['rows']))
        path=self.repo/'docs/plans/doc-only.md';path.write_text('# 群目标\n调整说明');self.git('add','.');self.git('commit','-m','Docs only')
        identity=self.apply(self.git('rev-parse','HEAD'),2)['changedDesigns'][0]
        self.assertEqual(sum(community.design_detail(self.store,identity)['counts'].values()),0)
        self.assertEqual(community.design_detail(self.store,identity)['designChanges'][0]['status'],'暂缓')
    def test_historical_hydration_is_repeatable(self):
        first=self.plan();p=self.repo/'docs/plans/feature.md';p.write_text('# 能力包\n新版');self.git('add','.');self.git('commit','-m','Docs update');end=self.git('rev-parse','HEAD')
        items=[(1,snapshot(self.repo,first)),(2,snapshot(self.repo,end))]
        with self.store.db:result=community.apply(self.store,community.prepare(self.store,self.repo,items,end,True))
        before=[tuple(r) for r in self.store.db.execute('SELECT * FROM designs')]
        bundle=community.prepare(self.store,self.repo,items,end,True);self.assertEqual(bundle['documents'],[])
        with self.store.db:self.assertEqual(community.apply(self.store,bundle)['changedDesigns'],[])
        self.assertEqual([tuple(r) for r in self.store.db.execute('SELECT * FROM designs')],before)
    def test_unchanged_blob_rename_keeps_every_fixed_source_link_valid(self):
        from urllib.parse import unquote
        first=self.plan();self.git('mv','docs/plans/feature.md','docs/plans/renamed.md');self.git('commit','-m','Rename unchanged design');end=self.git('rev-parse','HEAD')
        items=[(1,snapshot(self.repo,first)),(2,snapshot(self.repo,end))]
        with self.store.db:community.apply(self.store,community.prepare(self.store,self.repo,items,end,True))
        identity=self.store.db.execute('SELECT id FROM designs').fetchone()[0]
        current=community.design_detail(self.store,identity)
        links=[current['url']]+[r['pr_url'] for n in (1,2) for r in community.for_pr(self.store,n)]
        for url in links:
            sha,path=unquote(url.split('/blob/',1)[1]).split('/',1)
            self.assertEqual(self.git('rev-parse',sha+':'+path),current['blob_sha'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM designs').fetchone()[0],1)

    def test_direct_design_commit_waits_for_both_reviews(self):
        path=self.repo/'docs/plans/direct.md';path.parent.mkdir(parents=True);path.write_text('# 新功能设计\n直接提交说明')
        self.git('add','.');self.git('commit','-m','Add a direct design change');end=self.git('rev-parse','HEAD')
        result=sync(self.store,self.repo,end);identity=result['pendingDesigns'][0]
        self.assertFalse(result['checkpointAdvanced']);self.assertEqual(result['directCommits'],[end])
        records=self.store.meta('direct_commits');records[end].update(reviewed=True,status='暂缓',purpose='新增设计',reason='待本地适配',solution='保持原逻辑并评估')
        with self.store.db:self.store.set_meta('direct_commits',records)
        self.assertFalse(sync(self.store,self.repo,end)['checkpointAdvanced'])
        community.annotate(self.store,identity,{**NOTE,'upstream_stage':'设计/计划','stage_evidence':'仅设计提交，尚无实现PR'})
        self.assertTrue(sync(self.store,self.repo,end)['checkpointAdvanced'])
        self.assertEqual(community.design_detail(self.store,identity)['relatedPRs'],[])
    def test_failed_schema_upgrade_rolls_back_without_changing_v1_data(self):
        target=Path(self.tmp.name)/'failed-v1.sqlite3';self.store.backup(target)
        raw=sqlite3.connect(target)
        try:raw.executescript('DROP TABLE pr_designs;DROP TABLE design_versions;DROP TABLE designs;PRAGMA user_version=1;')
        finally:raw.close()
        original=Path.read_text
        def read(path,*args,**kwargs):return 'CREATE TABLE broken(;' if path.name=='community-schema.sql' else original(path,*args,**kwargs)
        with patch('upstream_catalog.store.Path.read_text',read):
            with self.assertRaises(CatalogError):Store(target)
        raw=sqlite3.connect(target)
        try:
            self.assertEqual(raw.execute('PRAGMA user_version').fetchone()[0],1)
            self.assertEqual(raw.execute('SELECT count(*) FROM prs').fetchone()[0],2)
            self.assertEqual(raw.execute("SELECT count(*) FROM sqlite_master WHERE name='broken'").fetchone()[0],0)
        finally:raw.close()

    def test_schema_v1_upgrade_preserves_existing_rows_and_choices(self):
        self.store.preference(1,0,'保留选择',0);target=Path(self.tmp.name)/'v1.sqlite3';self.store.backup(target)
        raw=sqlite3.connect(target)
        try:raw.executescript('DROP TABLE pr_designs;DROP TABLE design_versions;DROP TABLE designs;PRAGMA user_version=1;')
        finally:raw.close()
        with Store(target) as migrated:
            self.assertEqual(migrated.stats()['schemaVersion'],2);self.assertEqual(migrated.stats()['total'],2)
            self.assertEqual(migrated.detail(1)['choice_reason'],'保留选择');self.assertEqual(migrated.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        with Store(target,readonly=True) as reopened:self.assertEqual(reopened.detail(1)['wanted'],0)

if __name__=='__main__':unittest.main()
