"""Message schema validation utilities for the orchestrator table."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Literal, Optional


class MessageType(str, Enum):
    INTENT = "INTENT"
    UPDATE = "UPDATE"
    ERROR = "ERROR"
    REQUEST_REVIEW = "REQUEST_REVIEW"
    DONE = "DONE"
    DISAGREEMENT = "DISAGREEMENT"
    APPROVAL = "APPROVAL"


ALLOWED_AGENTS = {"cursor", "claude", "chatgpt", "orchestrator", "human"}


def _ensure_iso8601(value: str) -> None:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:  # pragma: no cover - defensive
        raise ValueError(f"Invalid ISO timestamp: {value}") from exc


def validate_message(message: Dict[str, Any]) -> MessageType:
    if not isinstance(message, dict):
        raise ValueError("Message must be a JSON object")

    type_value = message.get("type")
    if not isinstance(type_value, str):
        raise ValueError("Message type must be provided as string")
    try:
        msg_type = MessageType(type_value)
    except ValueError as exc:
        raise ValueError(f"Unsupported message type: {type_value}") from exc

    agent = message.get("agent")
    if not isinstance(agent, str) or agent.lower() not in ALLOWED_AGENTS:
        raise ValueError("Agent must be one of: " + ", ".join(sorted(ALLOWED_AGENTS)))

    timestamp = message.get("timestamp")
    if not isinstance(timestamp, str):
        raise ValueError("Timestamp must be provided as ISO-8601 string")
    _ensure_iso8601(timestamp)

    payload = message.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("Payload must be an object")

    return msg_type


def build_message(
    agent: Literal["cursor", "claude", "chatgpt", "orchestrator", "human"],
    msg_type: MessageType,
    payload: Dict[str, Any],
    timestamp: Optional[str] = None,
) -> Dict[str, Any]:
    if timestamp is None:
        timestamp = datetime.utcnow().isoformat() + "Z"
    message = {
        "type": msg_type.value,
        "agent": agent,
        "timestamp": timestamp,
        "payload": payload,
    }
    # Validate to ensure correctness before sending
    validate_message(message)
    return message

