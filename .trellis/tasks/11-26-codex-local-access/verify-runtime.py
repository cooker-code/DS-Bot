"""Exercise only explicitly supplied isolated mock teams; never print login material."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / '.agents/skills/ds-bot-doc/scripts'
sys.path.insert(0, str(SCRIPTS))
from request import LocalOperator, Operator, RequestError


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['baseline-view', 'exercise', 'after-restart'])
    parser.add_argument('--test-home', required=True, type=Path)
    parser.add_argument('--base', required=True)
    args = parser.parse_args()
    home = args.test_home.resolve()
    assert any(part.startswith('.dsh-test-') for part in home.parts)
    api = Operator(args.base, web_log=home / 'web.log')
    team_home = home / 'bot'

    def control(action):
        proc = subprocess.run(['python3', str(SCRIPTS / 'local_access.py'), action,
                               '--team-home', str(team_home)], capture_output=True, timeout=10)
        assert proc.returncode == 0, 'control failed'
        return json.loads(proc.stdout)['value']

    def quiet():
        for _ in range(120):
            current = api.call('state', {})
            if not current.get('activity'):
                time.sleep(1)
                if not api.call('state', {}).get('activity'):
                    return
            time.sleep(0.5)
        raise AssertionError('mock team did not settle')

    if args.mode == 'baseline-view':
        current = api.call('state', {})
        chosen = next(m['ref'] for m in current['models'] if 'deepseek' in m['ref'])
        writer = api.call('create-bot', {'name': 'Writer', 'model': chosen})
        quiet()
        api.call('send', {'sessionId': writer['id'], 'text': '大视图'})
        quiet()
        page = api.call('chat', {'botId': writer['id']})
        found = any(item.get('kind') == 'view' and item.get('title') == 'A long note' for item in page.get('items', []))
        print(json.dumps({'baseline_big_view_found': found, 'page_item_count': len(page.get('items', []))}))
        return

    record_path = home / 'local-check.json'
    intro = '本机接口验证\n第二行：只修改简介。'
    notice = '群公告验证\n仅限本机管理。'
    if args.mode == 'exercise':
        control('disable')
        assert control('status') == {'enabled': False, 'active': False}
        assert control('enable')['active'] is True
        local = LocalOperator(team_home)
        state = api.call('state', {})
        for room in state['rooms']:
            if room['name'] == 'Local Operator Check':
                api.call('delete-room', {'id': room['id']})
        for bot in state['bots']:
            if bot['name'] == 'Local Operator Check':
                api.call('delete-bot', {'id': bot['id']})
        chief = state['mainBotIds'][0]
        worker = api.call('create-bot', {'name': 'Local Operator Check', 'instructions': 'Original instructions.'})
        room = api.call('create-room', {'name': 'Local Operator Check', 'members': [chief, worker['id']]})
        local.call('update-bot', {'id': worker['id'], 'instructions': '  ' + intro + '\n'})
        local.call('update-room', {'id': room['id'], 'notice': '\n' + notice + '  '})
        state = local.call('state', {})
        assert next(b for b in state['bots'] if b['id'] == worker['id'])['instructions'] == intro
        assert next(r for r in state['rooms'] if r['id'] == room['id'])['notice'] == notice
        full = api.call('state', {})
        assert next(b for b in full['bots'] if b['id'] == worker['id'])['instructions'] == intro
        assert next(r for r in full['rooms'] if r['id'] == room['id'])['notice'] == notice
        assert 'providers' not in state and 'secrets' not in state
        assert local.call('project-task-list', {'roomId': room['id']})['tasks'] == []
        api.call('send', {'sessionId': room['id'], 'text': 'native-project-handoff-smoke'})
        quiet()
        tasks = local.call('project-task-list', {'roomId': room['id']})['tasks']
        assert tasks, 'mock did not register the original project card'
        detail = local.call('project-task-detail', {'roomId': room['id'], 'taskId': tasks[0]['taskId']})
        assert detail['taskId'] == tasks[0]['taskId']
        for endpoint, payload in [('dsh-update-install', {}), ('update-bot', {'id': worker['id'], 'instructions': intro, 'permission': 'full'})]:
            try:
                local.call(endpoint, payload)
            except RequestError:
                pass
            else:
                raise AssertionError('out-of-scope request admitted')
        control('disable')
        try:
            local.call('state', {})
        except (OSError, RequestError):
            pass
        else:
            raise AssertionError('revoked request admitted')
        assert control('enable')['active'] is True
        manifest = json.loads((team_home / 'local-access/connection.json').read_text())
        record_path.write_text(json.dumps({'bot': worker['id'], 'room': room['id'], 'oldPid': manifest['pid'], 'oldSocket': manifest['socket']}))
        print(json.dumps({'real_intro_exact': True, 'real_notice_exact': True, 'task_list_and_detail': True,
                          'scope_refusal': True, 'revocation_and_reenable': True}))
    else:
        record = json.loads(record_path.read_text())
        local = LocalOperator(team_home)
        for _ in range(100):
            if control('status')['active']:
                break
            time.sleep(0.05)
        state = local.call('state', {})
        assert next(b for b in state['bots'] if b['id'] == record['bot'])['instructions'] == intro
        assert next(r for r in state['rooms'] if r['id'] == record['room'])['notice'] == notice
        manifest = json.loads((team_home / 'local-access/connection.json').read_text())
        assert manifest['pid'] != record['oldPid']
        assert manifest['socket'] != record['oldSocket']
        assert not Path(record['oldSocket']).exists()
        print(json.dumps({'restart_restored_access': True, 'persisted_intro_exact': True,
                          'persisted_notice_exact': True, 'old_socket_cleaned': True}))


if __name__ == '__main__':
    main()
