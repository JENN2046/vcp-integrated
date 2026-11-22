import hashlib
import json
import sys
from pathlib import Path

candidate, run = (Path(name).resolve() for name in sys.argv[1:])


def sha256(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def compare(process, actual, expected):
    loaded = sha256(actual)
    assert loaded == sha256(candidate / expected), (actual, expected)
    return {'pid': int(process.name), 'loadedFile': str(actual.resolve()), 'buildFile': expected, 'sha256': loaded}


cds = 'apps/desktop/modules/services/chatDataService/bin/linux-x64/vcp_chat_data_service'
electron = 'apps/desktop/node_modules/electron/dist/electron'
vexus = 'apps/server/rust-vexus-lite/vexus-lite.linux-x64-gnu.node'
sqlite = 'apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
supervisor = int((run / 'linux-supervisor.pid').read_text())
receipts = {}
cds_processes = []
for process in Path('/proc').glob('[0-9]*'):
    try:
        exe = (process / 'exe').resolve(strict=True)
        cwd = (process / 'cwd').resolve(strict=True)
        parent = int((process / 'stat').read_text().rsplit(')', 1)[1].split()[1])
    except OSError:
        continue
    if exe == candidate / electron and parent == supervisor:
        receipts['electron'] = compare(process, process / 'exe', electron)
    if exe == candidate / cds:
        cds_processes.append((process, parent))
    if cwd == run / 'runtime-box' and exe.name == 'node':
        mapped = {line.split(maxsplit=5)[-1] for line in (process / 'maps').read_text().splitlines()
                  if line.endswith(('.node',))}
        for key, expected in [('vexus', vexus), ('sqlite', sqlite)]:
            loaded = {Path(name) for name in mapped if Path(name).name == Path(expected).name}
            assert len(loaded) == 1, (key, loaded)
            receipts[key] = compare(process, loaded.pop(), expected)
for process, parent in cds_processes:
    if parent == receipts['electron']['pid']:
        assert 'cds' not in receipts
        receipts['cds'] = compare(process, process / 'exe', cds)
assert receipts.keys() == {'electron', 'cds', 'vexus', 'sqlite'}, receipts
print(json.dumps(receipts, indent=2))
