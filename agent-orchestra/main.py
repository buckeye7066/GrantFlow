"""
GRANTFLOW ORCHESTRA - Entry Point
Cursor is the execution spine. Claude thinks. Cursor builds.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional

from core.actions import ActionRegistry
from core.agents import build_default_agents
from core.mailbox import Mailbox
from core.memory import MemoryStore
from core.messages import MessageType, validate_message
from core.orchestrator import OrchestratorConfig, RoleAwareOrchestrator
from core.realtime_bridge import RealtimeBridge
from core.status import StatusStore, AgentState

# ENFORCE STRICT MODE
os.environ["STRICT_COMPLETION_MODE"] = "True"
os.environ["MAX_AGENT_RETRIES"] = "1"
os.environ["DISABLE_INFRA_PROVISIONING"] = "True"
os.environ["LOCAL_SUCCESS_IS_AUTHORITY"] = "True"

STRICT_BANNER = """
============================================================
  GRANTFLOW ORCHESTRA - STRICT ROLE ENFORCEMENT
============================================================
  Claude  -> Architect (thinks, generates code)
  Cursor  -> Executor (implements, builds, tests) <- YOU
  Anya    -> Validator (domain logic)
  ChatGPT -> Debug Analyst (fallback)

  RULE: Local build must pass before any deploy.
  RULE: If Cursor didn't do it, it doesn't exist.
============================================================
"""

print(STRICT_BANNER)

PROJECT_ROOT = Path(
    os.getenv("GRANTFLOW_PROJECT_ROOT", Path(__file__).resolve().parent.parent)
).resolve()

DEFAULT_MEMORY_ID = "default"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GrantFlow Orchestrator CLI")
    parser.add_argument(
        "--goal",
        help="Run a single orchestrator workflow for the provided goal then exit.",
    )
    parser.add_argument(
        "--no-bridge",
        action="store_true",
        help="Disable the realtime bridge even if a goal is provided.",
    )
    parser.add_argument(
        "--bridge-host",
        default=os.getenv("BRIDGE_HOST", "127.0.0.1"),
        help="Host interface for the realtime bridge (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--bridge-port",
        type=int,
        default=int(os.getenv("BRIDGE_PORT", "8765")),
        help="Port for the realtime bridge (default: 8765).",
    )
    parser.add_argument(
        "--bridge-timeout",
        type=int,
        help="Optional number of seconds to keep the bridge alive before shutting down.",
    )
    parser.add_argument(
        "--mailbox-dir",
        default=str(PROJECT_ROOT / "agent-orchestra" / "mailbox"),
        help="Directory for mailbox files used for offline communication.",
    )
    parser.add_argument(
        "--disable-mailbox",
        action="store_true",
        help="Disable mailbox integration.",
    )
    parser.add_argument(
        "--mailbox-poll-interval",
        type=float,
        default=0.5,
        help="Polling interval (seconds) for processing mailbox commands.",
    )
    parser.add_argument(
        "--memory-dir",
        default=str(PROJECT_ROOT / "agent-orchestra" / "memory"),
        help="Directory for orchestrator memory transcripts.",
    )
    parser.add_argument(
        "--disable-memory",
        action="store_true",
        help="Disable persistent memory logging.",
    )
    parser.add_argument(
        "--memory-id",
        help="Memory identifier to associate with single-goal runs (default: 'default').",
    )
    parser.add_argument(
        "--allowed-actions",
        default=str(PROJECT_ROOT / "agent-orchestra" / "config" / "allowed_actions.json"),
        help="Path to allowed actions registry JSON file.",
    )
    return parser.parse_args()


def _handle_command_factory(
    orchestrator: RoleAwareOrchestrator,
) -> Callable[[Dict[str, Any]], Awaitable[None]]:
    run_lock = asyncio.Lock()

    async def handle_command(message: Dict[str, Any]) -> None:
        try:
            msg_type = validate_message(message)
        except ValueError as exc:
            print(f"[TABLE] Invalid message discarded: {exc}")
            return

        agent_label = message["agent"]
        payload = message["payload"]
        memory_id = payload.get("memory_id") or DEFAULT_MEMORY_ID

        orchestrator.log_memory_event(
            "command_received",
            memory_id=memory_id,
            message_type=msg_type.value,
            agent=agent_label,
            origin="bridge",
        )

        if msg_type == MessageType.INTENT:
            action = payload.get("action")
            if action == "run_goal":
                goal = payload.get("goal")
                if not goal:
                    print("[BRIDGE] INTENT missing goal text.")
                    return
                print(f"[BRIDGE] Running orchestrator for goal: {goal}")
                async with run_lock:
                    orchestrator.set_active_memory(memory_id)
                    orchestrator.log_memory_event(
                        "goal_requested",
                        memory_id=memory_id,
                        goal=goal,
                        origin="bridge",
                    )
                    success = False
                    try:
                        await orchestrator.run(goal)
                        success = True
                    except Exception as exc:
                        orchestrator.log_memory_event(
                            "goal_failed",
                            memory_id=memory_id,
                            goal=goal,
                            error=str(exc),
                        )
                        raise
                    finally:
                        orchestrator.log_memory_event(
                            "goal_completed",
                            memory_id=memory_id,
                            goal=goal,
                            success=success,
                        )
                        orchestrator.set_active_memory(None)
                return

            if action == "approve_action":
                action_id = payload.get("action_id")
                if not action_id:
                    print("[BRIDGE] Approval intent missing action_id.")
                    return
                orchestrator.approve_action(action_id)
                return

            print(f"[BRIDGE] Unknown INTENT action: {action}")
            return

        if msg_type == MessageType.UPDATE:
            action = payload.get("action")
            if action == "chat":
                message_text = payload.get("message")
                sender = payload.get("sender", agent_label)
                channel = payload.get("channel", "general")
                if not message_text:
                    print("[BRIDGE] Chat update missing message text.")
                    return
                orchestrator.set_active_memory(memory_id)
                try:
                    orchestrator.record_chat(
                        sender, message_text, channel, memory_id=memory_id
                    )
                finally:
                    orchestrator.set_active_memory(None)
                return
            if action == "advisor_review":
                orchestrator.record_advisor_review(
                    agent_label,
                    payload,
                    memory_id=memory_id,
                )
                return

            print(f"[BRIDGE] Ignoring UPDATE action: {action}")
            return

        if msg_type == MessageType.ERROR:
            orchestrator.log_memory_event(
                "external_error",
                memory_id=memory_id,
                agent=agent_label,
                details=payload,
            )
            return

        if msg_type == MessageType.REQUEST_REVIEW:
            orchestrator.log_memory_event(
                "external_request_review",
                memory_id=memory_id,
                agent=agent_label,
                details=payload,
            )
            return

        if msg_type == MessageType.DONE:
            orchestrator.log_memory_event(
                "external_done",
                memory_id=memory_id,
                agent=agent_label,
                details=payload,
            )
            return

        if msg_type == MessageType.APPROVAL:
            action_id = payload.get("action_id")
            if action_id:
                orchestrator.approve_action(action_id)
            return

        if msg_type == MessageType.DISAGREEMENT:
            orchestrator.log_memory_event(
                "disagreement_packet",
                memory_id=memory_id,
                packet=payload,
            )
            print("[TABLE] Disagreement packet received; awaiting human decision.")
            return

        print(f"[BRIDGE] Message type {msg_type.value} not handled.")

    return handle_command


async def _run_single_goal(args: argparse.Namespace) -> None:
    config = OrchestratorConfig()
    mailbox = _build_mailbox(args)
    memory_store = _build_memory_store(args)
    action_registry = _build_action_registry(args)
    status_store = _build_status_store(config)
    orchestrator = RoleAwareOrchestrator(
        config,
        mailbox=mailbox,
        memory_store=memory_store,
        status_store=status_store,
        action_registry=action_registry,
    )
    _register_default_agents(orchestrator)
    memory_id = args.memory_id or DEFAULT_MEMORY_ID
    bridge: Optional[RealtimeBridge] = None

    if not args.no_bridge:
        handler = _handle_command_factory(orchestrator)
        bridge = RealtimeBridge(
            host=args.bridge_host, port=args.bridge_port, command_handler=handler
        )
        orchestrator.attach_realtime_bridge(bridge)
        await bridge.start()
        print(
            f"[BRIDGE] WebSocket listening on ws://{bridge.host}:{bridge.port} "
            "- streaming events during execution."
        )

    orchestrator.set_active_memory(memory_id)
    orchestrator.log_memory_event(
        "goal_requested", memory_id=memory_id, goal=args.goal, origin="cli"
    )
    success = False
    try:
        await orchestrator.run(args.goal)
        success = True
    except Exception as exc:
        orchestrator.log_memory_event(
            "goal_failed", memory_id=memory_id, goal=args.goal, error=str(exc)
        )
        raise
    finally:
        orchestrator.log_memory_event(
            "goal_completed", memory_id=memory_id, goal=args.goal, success=success
        )
        orchestrator.set_active_memory(None)

    if bridge is not None:
        await bridge.stop()


async def _run_daemon(args: argparse.Namespace) -> None:
    mailbox = _build_mailbox(args)
    memory_store = _build_memory_store(args)
    config = OrchestratorConfig()
    action_registry = _build_action_registry(args)
    status_store = _build_status_store(config)
    orchestrator = RoleAwareOrchestrator(
        config,
        mailbox=mailbox,
        memory_store=memory_store,
        status_store=status_store,
        action_registry=action_registry,
    )
    _register_default_agents(orchestrator)
    handler = _handle_command_factory(orchestrator)
    bridge = RealtimeBridge(
        host=args.bridge_host, port=args.bridge_port, command_handler=handler
    )
    orchestrator.attach_realtime_bridge(bridge)

    mailbox_task: Optional[asyncio.Task[None]] = None
    if mailbox is not None:
        mailbox_task = asyncio.create_task(
            _mailbox_dispatch_loop(mailbox, handler, args.mailbox_poll_interval)
        )

    await bridge.start()
    print(
        f"[BRIDGE] WebSocket listening on ws://{bridge.host}:{bridge.port} "
        "- send run_goal commands to trigger workflows."
    )

    try:
        if args.bridge_timeout:
            await asyncio.sleep(args.bridge_timeout)
        else:
            while True:
                await asyncio.sleep(3600)
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\n[BRIDGE] Shutting down...")
    finally:
        if mailbox_task is not None:
            mailbox_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await mailbox_task
        await bridge.stop()


def main() -> None:
    """CLI entry point launching the realtime bridge or running a single goal."""
    args = _parse_args()
    try:
        if args.goal:
            asyncio.run(_run_single_goal(args))
        else:
            asyncio.run(_run_daemon(args))
    except KeyboardInterrupt:
        print("\n[EXIT] GrantFlow Orchestra stopped.")


def _register_default_agents(orchestrator: RoleAwareOrchestrator) -> None:
    for role, agent in build_default_agents(PROJECT_ROOT).items():
        orchestrator.register_agent(role, agent)


def _build_mailbox(args: argparse.Namespace) -> Optional[Mailbox]:
    if getattr(args, "disable_mailbox", False):
        return None
    mailbox_dir = Path(args.mailbox_dir).expanduser()
    mailbox = Mailbox(mailbox_dir)
    print(f"[MAILBOX] Using mailbox at {mailbox.root}")
    return mailbox


def _build_memory_store(args: argparse.Namespace) -> Optional[MemoryStore]:
    if getattr(args, "disable_memory", False):
        return None
    memory_dir = Path(args.memory_dir).expanduser()
    store = MemoryStore(memory_dir)
    print(f"[MEMORY] Using memory store at {store.root}")
    return store


def _build_action_registry(args: argparse.Namespace) -> ActionRegistry:
    path = Path(args.allowed_actions).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Allowed actions registry not found: {path}")
    try:
        return ActionRegistry.from_file(path)
    except Exception as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"Failed to load allowed actions registry: {exc}") from exc


def _build_status_store(config: OrchestratorConfig) -> StatusStore:
    store = StatusStore()
    for role in config.required_agents:
        store.set_status(role, AgentState.READY, "Initialized by orchestrator")
    return store


async def _mailbox_dispatch_loop(
    mailbox: Mailbox,
    handler: Callable[[Dict[str, Any]], Awaitable[None]],
    interval: float,
) -> None:
    print(f"[MAILBOX] Watching outbox for commands (interval={interval}s)")
    while True:
        entries = mailbox.consume_outbox()
        for entry in entries:
            payload = entry.get("payload")
            if not isinstance(payload, dict):
                continue
            try:
                await handler(payload)
            except Exception as exc:  # pragma: no cover - defensive logging
                print(f"[MAILBOX] Failed to process payload {payload}: {exc}")
        await asyncio.sleep(interval)


if __name__ == "__main__":
    main()

