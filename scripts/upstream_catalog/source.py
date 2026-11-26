"""Git is the source of inventory; cached content and decisions are separate."""
import json
import re
import subprocess
from pathlib import Path
from .store import CatalogError, REPO_ID, SOURCE_URL, now


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise CatalogError('Git operation failed: ' + ' '.join(args[:2]) + '; ' + result.stderr[:500])
    return result.stdout.strip()


def branch(repo):
    return git(repo, 'branch', '--show-current')


def writable(repo):
    current = branch(repo)
    if not current or current in ('dev', 'main', 'master'):
        raise CatalogError('写入必须从专用同步分支执行；当前分支：' + (current or 'detached'))
    return current


def validate_source(repo):
    url = git(repo, 'remote', 'get-url', 'upstream')
    if not re.fullmatch(r'(?:https://github\.com/|git@github\.com:)(?:Fei-Craft|Fei2411)/DS-Bot(?:\.git)?/?', url, re.I):
        raise CatalogError('upstream不是已确认的Fei-Craft/DS-Bot来源；未读取或推进该来源游标')


def database_path(repo):
    common = Path(git(repo, 'rev-parse', '--git-common-dir'))
    if not common.is_absolute():common = Path(repo) / common
    return common.resolve() / 'upstream-sync' / 'upstream.sqlite3'


def merges(repo, endpoint):
    out = {}
    for line in git(repo, 'log', '--first-parent', '--format=%H%x09%s', endpoint).splitlines():
        sha, subject = line.split('\t', 1)
        match = re.match(r'Merge pull request #(\d+)\b', subject) or re.search(r'\(#(\d+)\)$', subject)
        if match:out.setdefault(int(match[1]), sha)
    return out


def snapshot(repo, sha):
    parent = git(repo, 'rev-parse', sha + '^1')
    body = git(repo, 'show', '-s', '--format=%B', sha)
    paths = git(repo, '-c', 'core.quotepath=false', 'diff', '--name-status', '--find-renames', parent, sha).splitlines()
    files = sorted({path for line in paths for path in line.split('\t')[1:]})
    plan_files = [p for p in files if p.startswith('docs/plans/')]
    return {'sha': sha, 'parent': parent, 'body': body, 'files': files,
            'planFiles': plan_files,
            'designDiff': git(repo, 'diff', '--find-renames', parent, sha, '--', 'docs/plans/'),
            'mergedAt': git(repo, 'show', '-s', '--format=%cI', sha)}


def github_metadata(numbers):
    """Fetch only uncached PR timestamps; gh owns authentication."""
    from datetime import datetime
    out = {}
    numbers = sorted(set(numbers))
    for start in range(0, len(numbers), 50):
        batch = numbers[start:start + 50]
        fields = ' '.join(f'p{n}:pullRequest(number:{n}){{number createdAt mergedAt url}}' for n in batch)
        query = 'query { repository(owner:"Fei-Craft",name:"DS-Bot") { databaseId ' + fields + ' } }'
        try:
            result = subprocess.run(['gh','api','graphql','-f','query=' + query], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise CatalogError('读取GitHub PR时间失败；需要可用且已登录的gh，未补造时间') from exc
        if result.returncode:
            raise CatalogError('GitHub PR时间查询失败，请核对gh登录与网络；未补造时间')
        try:
            payload = json.loads(result.stdout)
            repo = payload['data']['repository']
            if payload.get('errors') or repo['databaseId'] != REPO_ID:raise ValueError('source mismatch')
            for number in batch:
                item = repo['p' + str(number)]
                if item['number'] != number or item['url'] != f'{SOURCE_URL}/pull/{number}':raise ValueError('PR mismatch')
                created = datetime.fromisoformat(item['createdAt'].replace('Z','+00:00'))
                if created.utcoffset() is None:raise ValueError('timezone missing')
                out[number] = {'createdAt':item['createdAt'], 'githubMergedAt':item['mergedAt']}
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise CatalogError('GitHub返回的PR来源或提交时间无效；本批时间未写入') from exc
    return out


def complete_metadata(store, repo):
    """One-time backfill. Repeat reads neither contact GitHub nor refresh dates."""
    writable(repo);validate_source(repo)
    numbers = [row['number'] for row in store.db.execute('SELECT number,upstream_json FROM prs') if not json.loads(row['upstream_json'] or '{}').get('createdAt')]
    if not numbers:return {'updatedPRs':[], 'githubPRsRead':0}
    details = github_metadata(numbers)
    changed = []
    with store.db:
        for number, extra in details.items():
            row = store.db.execute('SELECT upstream_json FROM prs WHERE repo_id=? AND number=?',(REPO_ID,number)).fetchone()
            item = json.loads(row[0] or '{}')
            if item.get('createdAt'):continue
            item.update(extra, sourceSyncedAt=now())
            store.db.execute('UPDATE prs SET upstream_json=? WHERE repo_id=? AND number=?',(json.dumps(item,ensure_ascii=False),REPO_ID,number))
            store.event(number,'metadata',None,extra | {'sourceSyncedAt':item['sourceSyncedAt']})
            changed.append(number)
    return {'updatedPRs':changed, 'githubPRsRead':len(numbers)}


def group_names(repo):
    """Display names follow the same review document as PR group membership."""
    file = Path(repo) / 'docs/upstream-remaining-review.md'
    if not file.exists():return {}
    names = {}
    for line in file.read_text().splitlines():
        match = re.match(r'^### (G\d+)\s+([^（(]+)',line)
        if match:names[match[1]] = match[2].strip()
    return names


def groups(repo):
    file = Path(repo) / 'docs/upstream-remaining-review.md'
    out = {};group = None
    if not file.exists():return out
    for line in file.read_text().splitlines():
        match = re.match(r'### (G\d+) ', line)
        if match:group = match[1]
        match = re.match(r'\| \[#(\d+) ', line)
        if match and group:out[int(match[1])] = group
    return out


def bootstrap(store, repo, endpoint, progress=lambda _: None):
    writable(repo)
    validate_source(repo)
    endpoint = git(repo, 'rev-parse', endpoint + '^{commit}')
    ledger = Path(repo) / 'upstream-changelog.md'
    numbers = [int(n) for n in re.findall(r'^\| \[#(\d+)\]\(', ledger.read_text(), re.M)]
    known = merges(repo, endpoint);cache = {}
    for at, number in enumerate(numbers):
        existing = store.db.execute('SELECT upstream_json FROM prs WHERE repo_id=? AND number=?', (REPO_ID, number)).fetchone()
        if existing:
            cache[number] = json.loads(existing[0] or '{}')
        elif number in known:
            cache[number] = snapshot(repo, known[number])
        if (at + 1) % 50 == 0:progress(f'缓存来源 {at + 1}/{len(numbers)}')
    missing = [number for number in numbers if not cache.get(number,{}).get('createdAt')]
    details = github_metadata(missing)
    for number,extra in details.items():cache.setdefault(number,{}).update(extra,sourceSyncedAt=now())
    from .community import prepare
    bundle = prepare(store,repo,list(cache.items()),endpoint,historical=True)
    result = store.bootstrap(ledger, cache, git(repo, 'rev-parse', 'HEAD'), endpoint, groups(repo),bundle)
    result['metadata'] = {'updatedPRs':missing, 'githubPRsRead':len(missing)}
    return result


def reassess(store, repo):
    """Local changes invalidate only intersecting cached PR paths, not every PR."""
    bases = {};affected = []
    dirty = set(git(repo, 'diff', '--name-only', 'HEAD').splitlines())
    dirty.update(git(repo, 'ls-files', '--others', '--exclude-standard').splitlines())
    for row in store.db.execute('SELECT p.number,p.local_sha,p.upstream_json FROM prs p LEFT JOIN preferences c ON c.repo_id=p.repo_id AND c.pr_number=p.number WHERE c.wanted IS NULL OR c.wanted=1'):
        base = row['local_sha']
        if not base:continue
        if base not in bases:bases[base] = set(git(repo, 'diff', '--name-only', base, 'HEAD').splitlines()) | dirty
        files = set(json.loads(row['upstream_json'] or '{}').get('files', []))
        if files & bases[base]:affected.append(row['number'])
    with store.db:
        store.db.executemany('UPDATE prs SET needs_review=1 WHERE repo_id=? AND number=?', [(REPO_ID, n) for n in affected])
    return affected


def _sync(store, repo, endpoint, fetch=False):
    current = writable(repo)
    validate_source(repo)
    if fetch:git(repo, 'fetch', 'upstream', 'dev')
    end = git(repo, 'rev-parse', endpoint + '^{commit}')
    source = store.db.execute('SELECT * FROM sources WHERE repo_id=?', (REPO_ID,)).fetchone()
    if not source:raise CatalogError('先运行 bootstrap 导入已有台账')
    start = source['checkpoint_sha']
    ancestry = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', start, end], capture_output=True)
    if ancestry.returncode:raise CatalogError('上游历史不连续；未推进游标，请先核对来源和祖先关系')
    commits = git(repo, 'rev-list', '--first-parent', '--reverse', start + '..' + end).splitlines()
    if not commits:
        return {'from':start,'to':end,'commitsExamined':0,'changedPRs':[],'pendingAnalysis':[],'directCommits':[],'checkpointAdvanced':False,'localAffectedPRs':reassess(store,repo),'preferencesPreserved':True,'unchanged':True}
    candidates = [];direct = []
    for sha in commits:
        subject = git(repo, 'show', '-s', '--format=%s', sha)
        match = re.match(r'Merge pull request #(\d+)\b', subject) or re.search(r'\(#(\d+)\)$', subject)
        cached = store.db.execute('SELECT upstream_json FROM prs WHERE repo_id=? AND merge_sha=?', (REPO_ID,sha)).fetchone()
        item = json.loads(cached[0]) if cached else store.meta('direct_commits',{}).get(sha) or snapshot(repo, sha)
        if match:candidates.append((int(match[1]), item))
        else:direct.append(item)
    missing = [number for number,item in candidates if not item.get('createdAt')]
    metadata = github_metadata(missing)
    for number,item in candidates:
        if number in metadata:item.update(metadata[number])
    from .community import prepare, apply
    design_bundle = prepare(store,repo,candidates+[(None,item) for item in direct],end)
    pending = [];changed = []
    with store.db:
        run = store.db.execute('INSERT INTO sync_runs(repo_id,from_sha,to_sha,local_branch,local_sha,started_at,outcome) VALUES(?,?,?,?,?,?,?)', (REPO_ID, start, end, current, git(repo, 'rev-parse', 'HEAD'), now(), 'running')).lastrowid
        for number, item in candidates:
            old = store.db.execute('SELECT * FROM prs WHERE repo_id=? AND number=?', (REPO_ID, number)).fetchone()
            if old is None:
                item['sourceSyncedAt'] = now()
                body_lines = [line.strip() for line in item['body'].splitlines() if line.strip()]
                title = body_lines[1] if len(body_lines)>1 else body_lines[0] if body_lines else 'PR ' + str(number)
                store.db.execute('INSERT INTO prs(repo_id,number,url,title,status,weight,merge_sha,upstream_json,reason,solution,first_seen_at,updated_at,needs_review) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)', (REPO_ID, number, f'{SOURCE_URL}/pull/{number}', title, '暂缓', 5, item['sha'], json.dumps(item, ensure_ascii=False), '新增来源，尚未完成本地评估', '补齐功能解释、本地差异和完整验证方案', now(), now()))
                store.event(number, 'source', None, {'sha': item['sha']}, run_id=run);changed.append(number)
            elif old['merge_sha'] != item['sha']:
                item['sourceSyncedAt'] = now()
                store.db.execute('UPDATE prs SET merge_sha=?,upstream_json=?,updated_at=?,needs_review=1 WHERE repo_id=? AND number=?', (item['sha'], json.dumps(item, ensure_ascii=False), now(), REPO_ID, number))
                store.event(number, 'source', {'sha': old['merge_sha']}, {'sha': item['sha']}, run_id=run);changed.append(number)
            elif not json.loads(old['upstream_json'] or '{}').get('createdAt'):
                item['sourceSyncedAt'] = now()
                store.db.execute('UPDATE prs SET upstream_json=? WHERE repo_id=? AND number=?',(json.dumps(item,ensure_ascii=False),REPO_ID,number))
                store.event(number,'metadata',None,metadata[number] | {'sourceSyncedAt':item['sourceSyncedAt']})
            row = store.db.execute('SELECT purpose,scenario,effect,needs_review FROM prs WHERE repo_id=? AND number=?', (REPO_ID, number)).fetchone()
            choice = store.db.execute('SELECT wanted FROM preferences WHERE repo_id=? AND pr_number=?', (REPO_ID, number)).fetchone()
            if not all(row[k] for k in ('purpose', 'scenario', 'effect')) or (row['needs_review'] and not (choice and choice['wanted'] == 0)):pending.append(number)
        direct_cache = store.meta('direct_commits', {})
        for item in direct:direct_cache.setdefault(item['sha'], {**item, 'status': '暂缓', 'reason': '直接提交已缓存，需记录评估后再推进完整盘点'})
        store.set_meta('direct_commits', direct_cache)
        unreviewed_direct = [d['sha'] for d in direct if not direct_cache[d['sha']].get('reviewed')]
        design_result = apply(store,design_bundle)
        complete = not pending and not unreviewed_direct and not design_result['pendingDesigns']
        store.db.execute('UPDATE sync_runs SET outcome=?,completed_at=?,error=? WHERE id=?', ('complete' if complete else 'needs_analysis', now(), None if complete else json.dumps({'prs': pending, 'commits': unreviewed_direct}), run))
        if changed or design_result['changedDesigns']:
            store.set_meta('community_last_update',{'kind':'上游增量','sourceSHA':end,'recordedAt':now(),'changedDesigns':design_result['changedDesigns'],'changedPRs':changed,'complete':complete})
        elif store.meta('community_last_update',{}).get('sourceSHA')==end:
            latest=store.meta('community_last_update');latest['complete']=complete;store.set_meta('community_last_update',latest)
        if complete:
            store.db.execute('UPDATE sources SET checkpoint_sha=?,scanned_at=? WHERE repo_id=?', (end, now(), REPO_ID))
            store.set_meta('community_cached_source',end)
    return {'from': start, 'to': end, 'commitsExamined': len(commits), 'changedPRs': changed, 'pendingAnalysis': pending, **design_result, 'directCommits': unreviewed_direct, 'checkpointAdvanced': complete, 'localAffectedPRs': reassess(store, repo), 'preferencesPreserved': True}


def sync(store, repo, endpoint, fetch=False):
    current = writable(repo)
    try:
        return _sync(store, repo, endpoint, fetch)
    except Exception as error:
        source = store.db.execute('SELECT checkpoint_sha FROM sources WHERE repo_id=?', (REPO_ID,)).fetchone()
        if source:
            with store.db:
                store.db.execute('INSERT INTO sync_runs(repo_id,from_sha,to_sha,local_branch,local_sha,started_at,completed_at,outcome,error) VALUES(?,?,?,?,?,?,?,?,?)', (REPO_ID,source[0],endpoint,current,git(repo,'rev-parse','HEAD'),now(),now(),'failed',str(error)[:1000]))
        raise
