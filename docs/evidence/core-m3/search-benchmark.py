import json
import resource
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import jieba

sample = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="vcp-m3-fts-") as temp:
    filename = Path(temp) / "search.sqlite"
    db = sqlite3.connect(filename)
    db.execute("CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, body)")
    start = time.perf_counter()
    jieba.initialize()
    startup = time.perf_counter() - start
    start = time.perf_counter()
    db.executemany("INSERT INTO search VALUES (?,?)", (
        (message["id"], " ".join(jieba.cut(message["content"], HMM=False)))
        for message in sample["history"]
    ))
    db.commit()
    rebuild = time.perf_counter() - start
    hits = []
    for query, expected in sample["queries"]:
        start = time.perf_counter()
        expression = '"' + " ".join(jieba.cut(query, HMM=False)) + '"'
        ids = [item[0] for item in db.execute(
            "SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search) LIMIT 50",
            (expression,),
        )]
        hits.append({"query": query, "expected": expected, "ids": ids,
                     "ms": (time.perf_counter() - start) * 1000})
    print(json.dumps({"sqliteVersion": sqlite3.sqlite_version, "jiebaVersion": jieba.__version__,
                      "startMs": startup * 1000, "rebuildMs": rebuild * 1000, "hits": hits,
                      "peakRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                      "databaseBytes": filename.stat().st_size}, ensure_ascii=False))
