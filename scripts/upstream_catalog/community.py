"""Explain source changes using cached designs, versioned evidence and PR decisions."""
import json
import re
from pathlib import Path
from .store import CatalogError, REPO_ID, SOURCE_URL, STATUSES, now

STAGES = ('已实现','进行中','设计/计划','已废除','待核实')
GUIDE = json.loads(Path(__file__).with_name('community-guide.json').read_text()) if Path(__file__).with_name('community-guide.json').exists() else {}


def _title(body, path):
    match = re.search(r'^#\s+(.+)',body,re.M)
    return match[1].strip() if match else Path(path).stem


def _read(repo, sha, path):
    from .source import git
    return {'path':path,'blob_sha':git(repo,'rev-parse',f'{sha}:{path}'),'source_sha':sha,
            'body':git(repo,'show',f'{sha}:{path}'),'changed_at':git(repo,'log','-1','--format=%cI',sha,'--',path)}


def _changes(repo, item):
    from .source import git
    if not item.get('planFiles'):return []
    changes = []
    for line in git(repo,'diff','--name-status','--find-renames',item['parent'],item['sha'],'--','docs/plans/').splitlines():
        parts = line.split('\t');kind = parts[0][0]
        old = parts[1] if kind == 'R' else None;path = parts[-1]
        if not path.endswith('.md'):continue
        changes.append({'kind':kind,'path':path,'previous_path':old})
    return changes


def prepare(store, repo, items, endpoint, historical=False):
    """Read source before opening the write transaction; any read failure is atomic."""
    from .source import git
    if historical and store.meta('community_cached_source') == endpoint:return {'documents':[], 'endpoint':endpoint, 'historical':True}
    items = [(number,item) for number,item in items if item.get('planFiles') and item.get('sha')]
    positions = {sha:i for i,sha in enumerate(git(repo,'rev-list','--first-parent','--reverse',endpoint).splitlines())}
    documents = [];paths = set();cache = {}
    def read(sha,path):
        key = (sha,path)
        if key not in cache:cache[key] = _read(repo,sha,path)
        return cache[key]
    for number,item in sorted(items,key=lambda pair:positions.get(pair[1]['sha'],-1)):
        code = any(p.startswith('ds-bot/') and '/test/' not in p and '/dev/' not in p and p.endswith(('.js','.jsx','.ts','.css')) for p in item.get('files',[]))
        for change in _changes(repo,item):
            ref = item['parent'] if change['kind']=='D' else item['sha']
            data = read(ref,change['path'])
            if change['kind']=='D':data={**data,'changed_at':git(repo,'show','-s','--format=%cI',item['sha'])}
            documents.append({**data,**change,'number':number,'merge_sha':item['sha'],'implementation':code})
            paths.add(change['path'])
    if historical:
        # The current source can contain later edits than a particular PR version.
        import subprocess
        for path in sorted(paths):
            exists = subprocess.run(['git','-C',str(repo),'cat-file','-e',f'{endpoint}:{path}'],capture_output=True).returncode == 0
            if exists:documents.append({**read(endpoint,path),'kind':'current','previous_path':None,'number':None,'merge_sha':endpoint,'implementation':False})
    aliases = {d['previous_path']:d['path'] for d in documents if d.get('previous_path')}
    def canonical(path):
        seen = set()
        while path in aliases and path not in seen:seen.add(path);path = aliases[path]
        return path
    last = {}
    for i,data in enumerate(documents):
        data['identity_path'] = canonical(data['path'])
        data['aliases'] = sorted({p for p in paths if canonical(p)==data['identity_path']})
        data['is_current'] = False
        if not historical or data['kind']=='current':last[data['identity_path']] = i
    if historical:
        for i,data in enumerate(documents):
            if data['identity_path'] not in last and data['kind']=='D':last[data['identity_path']] = i
    for i in last.values():documents[i]['is_current'] = True
    return {'documents':documents,'endpoint':endpoint,'historical':historical}


def _assessment(record):
    return {k:record.get(k) for k in ('purpose','scenario','limitations','upstream_stage','stage_evidence','local_notes','scope','reviewed_blob_sha')}


def apply(store, bundle):
    """Caller owns the transaction, including the inventory checkpoint."""
    if not bundle['documents']:
        return {'changedDesigns':[], 'pendingDesigns':[r[0] for r in store.db.execute("SELECT id FROM designs WHERE needs_review=1 AND kind='design'")]}
    changed = set();touched = set()
    for data in bundle['documents']:
        path = data.get('identity_path',data['path']);oldpath = data.get('previous_path')
        old = store.db.execute('SELECT * FROM designs WHERE repo_id=? AND path=?',(REPO_ID,path)).fetchone()
        if old is None:
            for alias in data.get('aliases',[]) + ([oldpath] if oldpath else []):
                old = store.db.execute('SELECT * FROM designs WHERE repo_id=? AND path=?',(REPO_ID,alias)).fetchone()
                if old is not None:break
        seed = GUIDE.get(path,{})
        blob = data['blob_sha'];state = 'deleted' if data['kind']=='D' else 'active'
        if old is None:
            cursor = store.db.execute('INSERT INTO designs(repo_id,path,title,kind,document_state,blob_sha,source_sha,changed_at,synced_at) VALUES(?,?,?,?,?,?,?,?,?)',(REPO_ID,path,_title(data['body'],path),'index' if Path(path).name=='README.md' else 'design',state,blob,data['source_sha'],data['changed_at'],now()))
            identity = cursor.lastrowid;changed.add(identity)
        else:
            identity = old['id']
            if data['is_current'] and (old['path'],old['blob_sha'],old['document_state']) != (path,blob,state):
                store.db.execute('UPDATE designs SET path=?,title=?,document_state=?,blob_sha=?,source_sha=?,changed_at=?,synced_at=?,needs_review=1 WHERE id=?',(path,_title(data['body'],path),state,blob,data['source_sha'],data['changed_at'],now(),identity));changed.add(identity)
        touched.add(identity)
        store.db.execute('INSERT OR IGNORE INTO design_versions VALUES(?,?,?,?,?,?)',(identity,blob,data['source_sha'],data['path'],data['body'],now()))
        current = dict(store.db.execute('SELECT * FROM designs WHERE id=?',(identity,)).fetchone())
        if data['is_current'] and current['reviewed_blob_sha'] != blob and seed.get('blob_sha') == blob:
            values = {k:seed.get(k,'') for k in ('title','purpose','scenario','limitations','upstream_stage','stage_evidence','local_notes','scope')}
            store.db.execute('UPDATE designs SET '+','.join(k+'=?' for k in values)+',reviewed_blob_sha=?,needs_review=0 WHERE id=?',(*values.values(),blob,identity))
            store.set_meta(f'design_assessment:{identity}:{blob}',{**values,'reviewed_blob_sha':blob,'recordedAt':now()})
        if current['kind']=='index':store.db.execute('UPDATE designs SET needs_review=0 WHERE id=?',(identity,))
        number = data['number']
        if number is not None:
            roles = ['design_change'] + (['implementation'] if data['implementation'] else [])
            for role in roles:store.db.execute('INSERT INTO pr_designs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,pr_number,design_id,role) DO UPDATE SET change_kind=excluded.change_kind,path=excluded.path,previous_path=excluded.previous_path,source_sha=excluded.source_sha,blob_sha=excluded.blob_sha',(REPO_ID,number,identity,role,data['kind'],data['path'],oldpath,data['merge_sha'],blob))
    # Some implementing PRs do not edit the later combined design document.
    for design in store.db.execute('SELECT * FROM designs').fetchall():
        seed = GUIDE.get(design['path'],{})
        if seed.get('blob_sha') != design['blob_sha']:continue
        for number in seed.get('implementation_prs',[]):
            row = store.db.execute('SELECT merge_sha FROM prs WHERE repo_id=? AND number=?',(REPO_ID,number)).fetchone()
            if row:store.db.execute('INSERT OR IGNORE INTO pr_designs VALUES(?,?,?,?,?,?,?,?,?)',(REPO_ID,number,design['id'],'implementation','related',design['path'],None,row['merge_sha'],design['blob_sha']))
    pending = [r[0] for r in store.db.execute('SELECT id FROM designs WHERE needs_review=1 AND kind<>\'index\'') if r[0] in touched]
    if bundle['historical']:store.set_meta('community_cached_source',bundle['endpoint'])
    if changed:
        store.set_meta('community_last_update',{'kind':'历史补齐' if bundle['historical'] else '上游增量','sourceSHA':bundle['endpoint'],'recordedAt':now(),'changedDesigns':sorted(changed)})
    return {'changedDesigns':sorted(changed),'pendingDesigns':pending}


def sync_cached(store, repo):
    from .source import writable, validate_source
    writable(repo);validate_source(repo)
    source = store.stats()['source']
    if not source:raise CatalogError('先导入PR台账')
    items = [(r['number'],json.loads(r['upstream_json'] or '{}')) for r in store.db.execute('SELECT number,upstream_json FROM prs') if json.loads(r['upstream_json'] or '{}').get('planFiles')]
    bundle = prepare(store,repo,items,source['checkpoint_sha'],historical=True)
    with store.db:result = apply(store,bundle)
    return result


def annotate(store, identity, values):
    allowed = {'title','purpose','scenario','limitations','upstream_stage','stage_evidence','local_notes','scope'}
    if set(values)-allowed or not values or any(not isinstance(v,str) for v in values.values()):raise CatalogError('设计评估字段无效')
    row = store.db.execute('SELECT * FROM designs WHERE id=?',(identity,)).fetchone()
    if row is None:raise CatalogError('设计不存在')
    required = {'title','purpose','scenario','limitations','upstream_stage','stage_evidence','local_notes','scope'}
    if row['needs_review'] and not required.issubset(values):raise CatalogError('新版设计需要完整评估字段，不能只改标题就清除重审')
    after = {**dict(row),**values}
    if after['upstream_stage'] not in STAGES or after['scope'] not in ('plugin','excluded','mixed'):raise CatalogError('阶段或范围无效')
    if not all(after.get(k) for k in ('title','purpose','scenario','limitations','stage_evidence','local_notes')):raise CatalogError('用途、场景、限制、阶段依据和本地说明必须完整')
    if not row['needs_review'] and all(row[k]==v for k,v in values.items()):return design_detail(store,identity)
    with store.db:
        store.db.execute('UPDATE designs SET '+','.join(k+'=?' for k in values)+',reviewed_blob_sha=blob_sha,needs_review=0 WHERE id=?',(*values.values(),identity))
        store.set_meta(f"design_assessment:{identity}:{row['blob_sha']}",{**_assessment(after),'reviewed_blob_sha':row['blob_sha'],'recordedAt':now()})
    return design_detail(store,identity)


def _url(sha,path):
    from urllib.parse import quote
    return f'{SOURCE_URL}/blob/{sha}/'+quote(path,safe='/')


def _related(store, identity, role=None):
    sql = 'SELECT p.*,r.role,r.source_sha design_source_sha,r.path design_path,r.change_kind,r.previous_path,r.blob_sha design_blob_sha,c.wanted FROM pr_designs r JOIN prs p ON p.repo_id=r.repo_id AND p.number=r.pr_number LEFT JOIN preferences c ON c.repo_id=p.repo_id AND c.pr_number=p.number WHERE r.design_id=?'
    params = [identity]
    if role:sql+=' AND r.role=?';params.append(role)
    return [dict(r) for r in store.db.execute(sql+' ORDER BY p.weight DESC,p.number',params)]


def _summary(store, row):
    out = dict(row);related = _related(store,row['id'],'implementation')
    updates = _related(store,row['id'],'design_change')
    updates.sort(key=lambda r:json.loads(r['upstream_json'] or '{}').get('mergedAt',''),reverse=True)
    out['change_summary'] = '设计变化：' + ('；'.join('#'+str(r['number'])+' '+(r['purpose'] or r['title']) for r in updates[:3]) or '当前没有已登记设计变化PR') + '\n相关实现：' + ('；'.join('#'+str(r['number'])+' '+(r['purpose'] or r['title']) for r in related[:3]) or '尚未关联实现PR')
    out['change_label'] = {'A':'新增设计','M':'设计调整','R':'设计改名','D':'设计删除'}.get(updates[0]['change_kind'],'设计主题') if updates else '设计主题'
    out.update(key='design:'+str(row['id']),entry_kind='design',relatedPRs=related,counts={s:sum(r['status']==s for r in related) for s in STATUSES},weight=max([r['weight'] for r in related] or [1]),url=_url(row['source_sha'],row['path']),effective_stage='待核实' if row['needs_review'] else row['upstream_stage'])
    return out


def list_entries(store, args):
    entries = [_summary(store,r) for r in store.db.execute("SELECT * FROM designs WHERE kind='design'")]
    # A PR without a plan file must remain discoverable as a functional change.
    for row in store.db.execute("SELECT p.*,c.wanted,c.reason choice_reason FROM prs p LEFT JOIN preferences c ON c.repo_id=p.repo_id AND c.pr_number=p.number WHERE (p.category IS NULL OR p.category<>'maintenance') AND NOT EXISTS(SELECT 1 FROM pr_designs r JOIN designs d ON d.id=r.design_id WHERE r.repo_id=p.repo_id AND r.pr_number=p.number AND d.kind='design')"):
        r = dict(row);source=json.loads(r['upstream_json'] or '{}')
        files=source.get('files',[])
        excluded=bool(files) and all(p.startswith(('app/','mobile/','link/','docker/')) for p in files)
        scope='excluded' if excluded else 'plugin'
        r['change_summary']=r['purpose'] or r['title']
        r.update(key='pr:'+str(r['number']),entry_kind='pr',upstream_stage='待核实',effective_stage='待核实',stage_evidence='该PR已合入固定来源；没有设计文档，完整功能阶段需结合实现核实。',scope=scope,limitations='本PR未提供关联设计；限制与差异见本地评估。',local_notes=r['local_difference'],relatedPRs=[dict(row)],counts={s:int(r['status']==s) for s in STATUSES},changed_at=source.get('mergedAt') or r['updated_at'],synced_at=source.get('sourceSyncedAt') or r['updated_at'],needs_review=r['needs_review'],url=r['url'])
        entries.append(r)
    standalone_count = sum(r['entry_kind']=='pr' for r in entries)
    latest = store.meta('community_last_update',{})
    for field in ('kind','stage','status','q','recent','scope'):
        value = args.get(field)
        if not value:continue
        if field=='kind':entries=[r for r in entries if r['entry_kind']==value]
        elif field=='stage':entries=[r for r in entries if r['effective_stage']==value]
        elif field=='status':entries=[r for r in entries if r['counts'].get(value,0)]
        elif field=='scope':entries=[r for r in entries if r['scope']==value]
        elif field=='recent':entries=[r for r in entries if (r['entry_kind']=='design' and r['id'] in latest.get('changedDesigns',[])) or (r['entry_kind']=='pr' and r['number'] in latest.get('changedPRs',[]))]
        elif field=='q':entries=[r for r in entries if value.casefold() in ' '.join(str(r.get(k) or '') for k in ('title','purpose','scenario','local_notes','path')).casefold() or any(str(p['number'])==value.lstrip('#') for p in r['relatedPRs'])]
    entries.sort(key=lambda r:(not bool(r['needs_review']),-r['weight'],r['entry_kind']!='design',r['title']))
    try:offset=int(args.get('offset') or 0);limit=int(args.get('limit') or 50)
    except ValueError:raise CatalogError('分页无效')
    if offset<0 or not 1<=limit<=100:raise CatalogError('分页无效')
    return {'total':len(entries),'rows':entries[offset:offset+limit],'lastUpdate':latest,'standaloneCount':standalone_count,'designCount':store.db.execute("SELECT count(*) FROM designs WHERE kind='design'").fetchone()[0]}


def design_detail(store, identity):
    row = store.db.execute('SELECT * FROM designs WHERE id=?',(identity,)).fetchone()
    if row is None:raise CatalogError('设计不存在')
    out = _summary(store,row)
    version = store.db.execute('SELECT * FROM design_versions WHERE design_id=? AND blob_sha=?',(identity,row['blob_sha'])).fetchone()
    out['body'] = version['body'] if version else ''
    out['designChanges'] = _related(store,identity,'design_change')
    out['versions'] = [dict(r) for r in store.db.execute('SELECT blob_sha,source_sha,path,captured_at FROM design_versions WHERE design_id=? ORDER BY captured_at DESC',(identity,))]
    for version in out['versions']:version['assessment']=store.meta(f"design_assessment:{identity}:{version['blob_sha']}")
    return out


def for_pr(store, number):
    out = []
    for row in store.db.execute('SELECT d.*,r.role,r.change_kind,r.previous_path,r.path pr_path,r.source_sha pr_source_sha,r.blob_sha pr_blob_sha FROM pr_designs r JOIN designs d ON d.id=r.design_id WHERE r.repo_id=? AND r.pr_number=? ORDER BY d.id,r.role',(REPO_ID,number)):
        record=dict(row)
        if any(r['id']==record['id'] for r in out):continue
        version=store.db.execute('SELECT source_sha,path,body FROM design_versions WHERE design_id=? AND blob_sha=?',(record['id'],record['pr_blob_sha'])).fetchone()
        record.update(key='design:'+str(record['id']),url=_url(record['source_sha'],record['path']),pr_url=_url(version['source_sha'],record['pr_path']) if version else None,pr_body=version['body'] if version else '',effective_stage='待核实' if record['needs_review'] else record['upstream_stage'])
        out.append(record)
    return out
