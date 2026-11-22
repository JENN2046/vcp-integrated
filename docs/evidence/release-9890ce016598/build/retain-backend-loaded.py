import hashlib
import json
import sys
import time
from pathlib import Path

candidate, run, receipt = (Path(name).resolve() for name in sys.argv[1:])
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        report = json.loads((run / 'backend-loaded.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        time.sleep(0.002)
        continue
    assert report
    for entry in report:
        loaded_file = candidate / entry['file']
        assert loaded_file.is_relative_to(candidate / 'apps/server')
        assert hashlib.sha256(loaded_file.read_bytes()).hexdigest() == entry['sha256'], entry['file']
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    break
else:
    raise SystemExit('ToolBox did not produce a loaded module receipt before cleanup.')
