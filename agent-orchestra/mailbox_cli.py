"""Mailbox CLI for interacting with the orchestrator bridge."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict

from core.mailbox import Mailbox
from core.messages import MessageType, build_message

DEFAULT_ROOT = Path(__file__).resolve().parent / "mailbox"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GrantFlow orchestrator mailbox utility")
    parser.add_argument(
        "--mailbox-dir",
        default=str(DEFAULT_ROOT),
        help="Mailbox directory (defaults to agent-orchestra/mailbox).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    pull = subparsers.add_parser("pull", help="Show recent messages from the mailbox inbox.")
    pull.add_argument("--limit", type=int, default=20, help="Maximum number of entries to display.")

    send = subparsers.add_parser("send", help="Send a chat message via the mailbox.")
    send.add_argument("--message", required=True, help="Message text to send.")
    send.add_argument("--sender", default="cursor", help="Sender identifier (default: cursor).")
    send.add_argument("--agent", default="cursor", help="Agent label emitting the message (default: cursor).")
    send.add_argument("--channel", default="general", help="Target channel (default: general).")
    send.add_argument(
        "--memory-id",
        help="Memory identifier to associate with the chat (default: none).",
    )

    goal = subparsers.add_parser("goal", help="Queue a run_goal command via the mailbox.")
    goal.add_argument("--goal", required=True, help="Goal description to run.")
    goal.add_argument("--agent", default="cursor", help="Agent label issuing the goal (default: cursor).")
    goal.add_argument(
        "--memory-id",
        help="Memory identifier to associate with the goal (default: 'default').",
    )

    raw = subparsers.add_parser("raw", help="Queue a raw JSON payload to the mailbox outbox.")
    raw.add_argument("--payload", required=True, help="JSON payload string.")

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    mailbox = Mailbox(Path(args.mailbox_dir).expanduser())

    if args.command == "pull":
        entries = mailbox.read_inbox(limit=args.limit)
        for entry in entries:
            print(json.dumps(entry, ensure_ascii=False))
        if not entries:
            print("[mailbox] Inbox empty.")
        return

    if args.command == "send":
        payload: Dict[str, Any] = {
            "action": "chat",
            "sender": args.sender,
            "channel": args.channel,
            "message": args.message,
        }
        if args.memory_id:
            payload["memory_id"] = args.memory_id
        message = build_message(
            agent=args.agent,
            msg_type=MessageType.UPDATE,
            payload=payload,
        )
        mailbox.queue_command(message)
        print("[mailbox] Chat message queued.")
        return

    if args.command == "goal":
        payload = {
            "action": "run_goal",
            "goal": args.goal,
        }
        if args.memory_id:
            payload["memory_id"] = args.memory_id
        else:
            payload["memory_id"] = "default"
        message = build_message(
            agent=args.agent,
            msg_type=MessageType.INTENT,
            payload=payload,
        )
        mailbox.queue_command(message)
        print("[mailbox] Goal command queued.")
        return

    if args.command == "raw":
        payload = json.loads(args.payload)
        if not isinstance(payload, dict):
            raise ValueError("Payload must be a JSON object")
        mailbox.queue_command(payload)
        print("[mailbox] Raw payload queued.")
        return


if __name__ == "__main__":
    main()

