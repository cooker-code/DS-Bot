#!/usr/bin/env python3
"""Usage: python3 scripts/upstream-catalog.py --help. No global installation."""
import argparse
import json
import sys
from pathlib import Path
from upstream_catalog.store import Store, CatalogError, REPO_ID, now
from upstream_catalog.source import database_path, bootstrap, sync, reassess, git, writable, complete_metadata, validate_source
from upstream_catalog.web import server
from upstream_catalog import community


def main(argv=None):
    parser = argparse.ArgumentParser(description='DS Bot上游增量台账：独立分支写入，不操作DSH数据。输出JSON；进度到stderr。')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent, help='专用同步工作树，默认脚本所属仓库')
    parser.add_argument('--database', type=Path, help='SQLite路径，默认公共Git目录/upstream-sync/upstream.sqlite3；测试传临时路径')
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('bootstrap', help='一次性导入已有Markdown与固定Git来源，重复运行去重')
    init.add_argument('--to', default='bb1b1592472084c32278c12287944ee40b8087c5', help='既有完整盘点终点，不能用新终点冒充历史已覆盖区间')
    update = sub.add_parser('sync', help='只读新区间并更新来源缓存；不合并代码、不覆盖用户选择')
    update.add_argument('--to', default='upstream/dev')
    update.add_argument('--fetch', action='store_true', help='显式刷新upstream/dev；默认只用本地引用')
    sub.add_parser('metadata', help='只补缓存缺失的GitHub PR提交时间，保留状态/选择/游标；需要gh登录')
    sub.add_parser('community-sync', help='从已缓存来源补齐设计全文、PR关联与社区说明，不fetch/不合代码')
    browse = sub.add_parser('community', help='只读社区功能和设计判断')
    for field in ['q','kind','stage','status','scope','recent','limit','offset']:browse.add_argument('--'+field)
    design = sub.add_parser('design', help='只读某设计主题的说明与固定版本原文');design.add_argument('id',type=int)
    note = sub.add_parser('design-annotate', help='为新版设计补完整中文评估后才能推进游标');note.add_argument('id',type=int);note.add_argument('file',type=Path)
    sub.add_parser('inspect', help='只读统计和游标，不联网')
    query = sub.add_parser('list', help='只读筛选缓存PR摘要，不重新检索上游')
    for field in ['q','status','wanted','group','category','min','max','stale','sort','limit','offset']:
        query.add_argument('--'+field, default='20' if field=='limit' else None)
    show = sub.add_parser('show', help='只读单个PR的功能、差异、方案、验证和缓存来源')
    show.add_argument('number',type=int)
    sub.add_parser('reassess', help='按本地改动路径标记需重审的PR')
    sub.add_parser('export', help='将当前分析和用户选择更新到本分支upstream-changelog.md')
    annotate = sub.add_parser('annotate', help='从JSON文件更新指定PR的功能、判断与验证')
    annotate.add_argument('number', type=int);annotate.add_argument('file', type=Path)
    direct = sub.add_parser('review-commit', help='登记直接提交的完整评估，不自动采用')
    direct.add_argument('sha');direct.add_argument('file', type=Path)
    backup = sub.add_parser('backup', help='SQLite一致性备份');backup.add_argument('target', type=Path)
    page = sub.add_parser('serve', help='启动可筛选/标记管理页，只监听127.0.0.1；先bootstrap')
    page.add_argument('--port', type=int, default=4179)
    args = parser.parse_args(argv);repo = args.repo.resolve()
    database = args.database.resolve() if args.database else database_path(repo)
    try:
        if args.command not in ('inspect','list','show','community','design'):writable(repo)
        if args.command in ('bootstrap','sync','metadata','community-sync'):validate_source(repo)
        if args.command != 'bootstrap' and not database.exists():raise CatalogError('台账不存在，请先运行bootstrap')
        if args.command == 'serve':
            host = server(repo, database, args.port)
            print(json.dumps({'url':f'http://127.0.0.1:{host.server_port}', 'branch':writable(repo),'database':str(database)},ensure_ascii=False),flush=True)
            try:host.serve_forever()
            except KeyboardInterrupt:pass
            finally:host.server_close()
            return 0
        with Store(database, readonly=args.command in ('inspect','list','show','community','design','backup')) as db:
            if args.command == 'bootstrap':result = bootstrap(db, repo, args.to, lambda m: print(m, file=sys.stderr, flush=True))
            elif args.command == 'metadata':result = complete_metadata(db,repo)
            elif args.command == 'sync':result = sync(db, repo, args.to, args.fetch)
            elif args.command == 'community-sync':result = community.sync_cached(db,repo)
            elif args.command == 'community':result = community.list_entries(db,vars(args))
            elif args.command == 'design':result = community.design_detail(db,args.id)
            elif args.command == 'design-annotate':result = community.annotate(db,args.id,json.loads(args.file.read_text()))
            elif args.command == 'inspect':result = db.stats()
            elif args.command == 'show':result = db.detail(args.number)
            elif args.command == 'list':
                result = db.list(vars(args))
                result['rows'] = [{key:row[key] for key in ['number','title','purpose','status','weight','dependency_group','wanted','needs_review','url','pr_created_at','synced_at']} for row in result['rows']]
            elif args.command == 'reassess':result = {'affectedPRs':reassess(db,repo)}
            elif args.command == 'export':result = db.export(repo / 'upstream-changelog.md')
            elif args.command == 'annotate':result = db.annotate(args.number,json.loads(args.file.read_text()),git(repo,'rev-parse','HEAD'))
            elif args.command == 'backup':db.backup(args.target);result = {'backup':str(args.target)}
            elif args.command == 'review-commit':
                records = db.meta('direct_commits', {});record = records.get(args.sha)
                if not record:raise CatalogError('直接提交未登记')
                note = json.loads(args.file.read_text())
                if note.get('status') not in ('采用','需讨论','暂缓','跳过') or not all(note.get(k) for k in ['purpose','reason','solution']):raise CatalogError('直接提交必须有状态、功能、原因和解法')
                if note['status'] == '采用' and not note.get('verification'):raise CatalogError('采用必须有验证证据')
                record.update(note, reviewed=True, exported=False, reviewedAt=now())
                with db.db:db.set_meta('direct_commits',records)
                result = record
            print(json.dumps(result,ensure_ascii=False,indent=2))
            return 0
    except (CatalogError, OSError, ValueError) as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False),file=sys.stderr);return 1


if __name__ == '__main__':
    sys.exit(main())
