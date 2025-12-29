"""Persistent memory store for orchestrator interactions."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional

ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


class MemoryStore:
    """Append-only JSONL store keyed by memory ID."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def append(self, memory_id: str, record: Dict[str, Any]) -> None:
        entry = {
            "timestamp": _utcnow(),
            "record": record,
        }
        path = self._path(memory_id)
        line = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")

    def read(self, memory_id: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        return list(_tail_jsonl(self._path(memory_id), limit))

    def _path(self, memory_id: str) -> Path:
        safe_id = memory_id.replace("/", "_")
        return self.root / f"{safe_id}.jsonl"


def _tail_jsonl(path: Path, limit: Optional[int]) -> Iterable[Dict[str, Any]]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    if limit is not None:
        lines = lines[-limit:]
    result: List[Dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result


def _utcnow() -> str:
    return datetime.utcnow().strftime(ISO_FORMAT)

