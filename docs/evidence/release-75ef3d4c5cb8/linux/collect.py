import json, os, shutil, subprocess, sys, time
from pathlib import Path

candidate = Path.cwd()
run = next((candidate / '.runs/hardware').glob('run-*'))
stage = sys.argv[1]
evidence = Path(sys.argv[2])
log = candidate / '.runs' / ('linux-' + stage + '.stdout')
fifo = candidate / '.runs' / ('linux-' + stage + '.fifo')
def events():
    return [json.loads(line) for line in log.read_text().splitlines() if line.startswith('{"event":') and line.endswith('}')]
def send(cmd, name):
    offset = len(events())
    with fifo.open('w') as stream: print(cmd, file=stream)
    for _ in range(100):
        for event in events()[offset:]:
            if event['event'] == name: return event
            if event['event'] == 'linux-command-failed': raise RuntimeError(event['value'])
        time.sleep(.15)
    raise RuntimeError(name)
def save(rel,obj):
    (evidence/rel).write_text(json.dumps(obj, ensure_ascii=False,indent=2)+'\n')
readback=send('readback','linux-readback')
save('linux/'+('reopened-readback' if stage=='reopened' else 'initial-readback')+'.json', readback)
send('capture','linux-captured')
shutil.copyfile(run/'linux-topic.png',evidence/'linux'/('reopened.png' if stage=='reopened' else 'initial-completed.png'))
send('sources','linux-sources')
rows=json.loads((run/'linux-loaded.json').read_text())
import hashlib
for group in (rows['main'], rows['renderer']):
    for row in group: assert row['sha256']==hashlib.sha256((candidate/row['file']).read_bytes()).hexdigest()
save('build/linux-'+stage+'-loaded-js.json',rows)
native=subprocess.check_output(['python3','docs/evidence/release-9890ce016598/build/verify-loaded-native.py', str(candidate), str(run)],text=True)
save('build/linux-'+stage+'-native.json',json.loads(native))
close=send('stop','linux-exited')
assert close['value']['code']==0
save('linux/'+stage+'-exit.json', close)
if stage=='initial':
    lifecycle=[e for e in events() if e['event'] in ['linux-submitted','linux-exited']]
    assert [e['event'] for e in lifecycle]==['linux-submitted','linux-exited']
    (evidence/'linux/initial-lifecycle.ndjson').write_text(''.join(json.dumps(e)+'\n' for e in lifecycle))
print(stage, readback['value']['work']['state'], readback['value']['pid'])
