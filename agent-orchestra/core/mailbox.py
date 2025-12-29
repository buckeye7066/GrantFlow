"""File-backed mailbox for orchestrator bridge communication."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional, Tuple

ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


class Mailbox:
    """Simple append-only mailbox using JSONL files for inbox/outbox traffic."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.inbox_path = self.root / "incoming.jsonl"
        self.outbox_path = self.root / "outgoing.jsonl"
        self.outbox_offset_path = self.root / "outgoing.offset"
        self._lock = Lock()
        # Ensure files exist
        for path in (self.inbox_path, self.outbox_path):
            if not path.exists():
                path.write_text("", encoding="utf-8")
        if not self.outbox_offset_path.exists():
            self.outbox_offset_path.write_text("0", encoding="utf-8")

    def record_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Append an event to the inbox."""
        entry = {
            "timestamp": _utcnow(),
            "type": event_type,
            "data": data,
        }
        self._append_line(self.inbox_path, entry)

    def queue_command(self, payload: Dict[str, Any]) -> None:
        """Append an outgoing command."""
        entry = {
            "timestamp": _utcnow(),
            "payload": payload,
        }
        self._append_line(self.outbox_path, entry)

    def read_inbox(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Return inbox entries, optionally limited to the most recent `limit`."""
        return list(_tail_jsonl(self.inbox_path, limit))

    def read_outbox(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Return outbox entries, optionally limited to the most recent `limit`."""
        return list(_tail_jsonl(self.outbox_path, limit))

    def load_outbox_offset(self) -> int:
        try:
            return int(self.outbox_offset_path.read_text(encoding="utf-8").strip() or "0")
        except ValueError:
            return 0

    def save_outbox_offset(self, offset: int) -> None:
        self.outbox_offset_path.write_text(str(offset), encoding="utf-8")

    def read_outbox_since(self, offset: int) -> Tuple[List[Dict[str, Any]], int]:
        if not self.outbox_path.exists():
            return [], offset
        with self.outbox_path.open("r", encoding="utf-8") as handle:
            max_offset = handle.seek(0, 2)
            if offset > max_offset:
                offset = 0
            handle.seek(offset)
            lines = handle.readlines()
            new_offset = handle.tell()
        entries = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries, new_offset

    def consume_outbox(self) -> List[Dict[str, Any]]:
        offset = self.load_outbox_offset()
        entries, new_offset = self.read_outbox_since(offset)
        if new_offset != offset:
            self.save_outbox_offset(new_offset)
        return entries

    def _append_line(self, path: Path, payload: Dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False)
        with self._lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")


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

