"""Compare the retained upgrade and independent device receipts (no running service needed)."""
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
def read(relative):
    return json.loads((root / relative).read_bytes())

def message(row):
    return [row['id'], row['role'], row['content']]

def journal(rows):
    return [message(row['message']) for row in rows]

def phone(file):
    record = read('android/' + file)
    assert record['secure'] and record['standalone'] and record['workerControlled']
    assert not record['isPrivate'] and record['readback']['status'] == 200
    values = record['observed']['messages']
    for value in values:
        assert hashlib.sha256(value['body'].encode()).hexdigest() == value['sha256']
    return [[v['id'], v['role'], v['body']] for v in values]

candidate = 'a2a13b53555c55ca79844544d8802d61fc0cf3e0'
build = read('build/source.json')
assert build['candidate'] == read('windows/build-and-vm.json')['candidate'] == candidate
assert hashlib.sha256((root/'build/build-sha256.txt').read_bytes()).hexdigest() == build['manifestSha256']
final = read('central/final-status.json')
ready = read('central/ready.json')
original = read('upgrade/upgrade.json')
recovery = read('upgrade/rollback-final.json')
assert original['upgradedHash'] == ready['restoredDbSha256']
assert original['backupHash'] == recovery['backupHash']
cold = read('central/final-database-check.json')
assert cold['integrity'] == 'ok' and cold['coldNoSidecars'] and cold['toolCalls'] == 0
assert cold['sha256'] == recovery['schema4BackupSha256']
assert original['before'] == recovery['restored']['uponOpen']
retained = next(t for t in final['retained'] if t['admissions'][0]['id'] == original['work']['id'])
assert retained['admissions'][0]['state'] == original['after']['work']['state'] == 'completed'
assert [row['msg_id'] for row in retained['journal']] == [row['msg_id'] for row in original['after']['journal']]
assert final['schemaVersion'] == 4 and recovery['rejected'] == 'SHARED_SCHEMA_UPGRADE_REQUIRED'

g = final['group']
gid = g['admissions'][0]['id']
expected = journal(g['journal'])
assert [message(v) for v in read('linux/linux-group-complete.json')['history']] == expected
for filename in ['history-live.json', 'history-reopened.json']:
    assert [message(v) for v in read('windows/' + filename)['histories']['group']['rows']] == expected
for filename in ['08-group-final', '09-group-cold']:
    assert phone(filename + '.json') == expected
    snapshot = read('android/' + filename + '-work.json')
    assert snapshot['executionId'] == snapshot['request']['id'] == gid
    assert snapshot['request']['state'] == 'completed'
    assert snapshot['request']['groupHandoff']['confirmedReplies'] == [r['seq'] for r in g['journal'][1:]]
assert len(g['native']) == len(g['slots']) == 3

single = final['single']
orig, new = single['work']
assert orig['state'] == 'cancelled' and orig['reply_message_id'] is None and orig['attempts'] == 1
assert new['state'] == 'completed' and new['attempts'] == 1
assert [(r['msg_id'], r['action']) for r in single['journal'][:2]] == [(orig['user_message_id'], 'upsert'), (orig['user_message_id'], 'delete')]
assert phone('14-single-deleted.json') == []
expectedSingle = journal(single['journal'][2:])
assert [message(v) for v in read('linux/linux-single-next.json')['history']] == expectedSingle
assert [message(v) for v in read('windows/history-single.json')['histories']['single']['rows']] == expectedSingle
for filename in ['15-single-final.json', '16-single-cold.json']:
    assert phone(filename) == expectedSingle
    states = {w['id']:w['state'] for w in read('android/'+filename)['observed']['executions']}
    assert states[orig['id']] == 'cancelled' and states[new['id']] == 'completed'
assert len(final['calls']) == 5
assert final['mobileScopes'] == [['shared:sharedAB:read']]
print(json.dumps({'result':'PASS','commit':candidate,'buildManifestSha256':build['manifestSha256'],
    'restoredOldWork':original['work']['id'],'restorableBackupAt':original['before']['control']['state'],
    'restorableJournalSeqs':[r['seq'] for r in original['before']['journal']],
    'sameDatabaseThroughHardwareRun':True, 'schema':final['schemaVersion'],
    'groupWork':gid,'groupMessages':expected,'single502':orig['id'],'singleNext':new['id'],
    'singleMessages':expectedSingle,'providerCalls':len(final['calls'])},indent=2,ensure_ascii=False))
