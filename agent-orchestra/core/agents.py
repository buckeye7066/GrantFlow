"""Minimal agent implementations for the GrantFlow orchestrator.

These agents provide a concrete `execute` coroutine so the orchestrator
can complete end-to-end workflows out of the box. They primarily log
their work and acknowledge success, but the cursor agent can optionally
run shell commands when environment variables are provided.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from .orchestrator import AgentRole, Task, TaskType


class BaseAgent:
    """Basic async agent that returns success after a short delay."""

    def __init__(self, role: AgentRole, *, latency: float = 0.05) -> None:
        self.role = role
        self.latency = latency

    async def execute(self, task: Task) -> Dict[str, Any]:  # pragma: no cover - interface
        raise NotImplementedError


class LoggingAgent(BaseAgent):
    """Agent that logs the task handling and returns success."""

    def __init__(
        self,
        role: AgentRole,
        *,
        latency: float = 0.05,
        responses: Optional[Mapping[TaskType, str]] = None,
    ) -> None:
        super().__init__(role, latency=latency)
        self._responses = dict(responses or {})

    async def execute(self, task: Task) -> Dict[str, Any]:
        await asyncio.sleep(self.latency)
        message = self._responses.get(
            task.task_type,
            f"{self.role.value} acknowledged {task.task_type.value}",
        )
        print(f"[AGENT:{self.role.value}] {message}")
        return {"success": True, "message": message}


class CursorAgent(LoggingAgent):
    """Cursor agent that can optionally run shell commands for build/test."""

    def __init__(
        self,
        project_root: Path,
        *,
        latency: float = 0.05,
        build_command: Optional[str] = None,
        lint_command: Optional[str] = None,
        test_command: Optional[str] = None,
    ) -> None:
        responses = {
            TaskType.FILE_CREATION: "Applied code changes locally",
            TaskType.BUILD: "Build completed locally",
            TaskType.TEST: "Tests executed locally",
            TaskType.LINT: "Lint check completed locally",
        }
        super().__init__(AgentRole.CURSOR, latency=latency, responses=responses)
        self.project_root = project_root
        self.build_command = build_command
        self.lint_command = lint_command
        self.test_command = test_command

    async def execute(self, task: Task) -> Dict[str, Any]:
        if task.task_type == TaskType.BUILD and self.build_command:
            return await self._run_command(self.build_command, "build")
        if task.task_type == TaskType.LINT and self.lint_command:
            return await self._run_command(self.lint_command, "lint")
        if task.task_type == TaskType.TEST and self.test_command:
            return await self._run_command(self.test_command, "test")
        return await super().execute(task)

    async def _run_command(self, command: str, label: str) -> Dict[str, Any]:
        print(f"[AGENT:cursor] Running {label} command: {command}")
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(self.project_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        success = process.returncode == 0
        if success:
            print(f"[AGENT:cursor] {label} command succeeded")
        else:
            print(f"[AGENT:cursor] {label} command failed: {stderr.decode().strip()}")
        return {
            "success": success,
            "stdout": stdout.decode().strip() or None,
            "stderr": stderr.decode().strip() or None,
            "message": f"{label} command {'succeeded' if success else 'failed'}",
        }


def build_default_agents(project_root: Path) -> Dict[AgentRole, BaseAgent]:
    """Create default agents covering every orchestrator role."""

    project_root = project_root.resolve()

    build_cmd = os.getenv("CURSOR_BUILD_COMMAND")
    lint_cmd = os.getenv("CURSOR_LINT_COMMAND")
    test_cmd = os.getenv("CURSOR_TEST_COMMAND")

    agents: Dict[AgentRole, BaseAgent] = {
        AgentRole.CLAUDE: LoggingAgent(
            AgentRole.CLAUDE,
            responses={
                TaskType.ARCHITECTURE: "Produced an architecture plan",
                TaskType.CODE_GENERATION: "Delivered implementation sketch",
                TaskType.DEBUG_ANALYSIS: "Provided debug analysis",
            },
        ),
        AgentRole.CURSOR: CursorAgent(
            project_root,
            build_command=build_cmd,
            lint_command=lint_cmd,
            test_command=test_cmd,
        ),
        AgentRole.ANYA: LoggingAgent(
            AgentRole.ANYA,
            responses={TaskType.DOMAIN_VALIDATION: "Validated domain logic"},
        ),
        AgentRole.CHATGPT: LoggingAgent(
            AgentRole.CHATGPT,
            responses={TaskType.DEBUG_ANALYSIS: "Delivered debugging suggestions"},
        ),
        AgentRole.VERCEL: LoggingAgent(
            AgentRole.VERCEL,
            responses={TaskType.DEPLOY_FRONTEND: "Queued frontend deployment"},
        ),
        AgentRole.RAILWAY: LoggingAgent(
            AgentRole.RAILWAY,
            responses={TaskType.DEPLOY_BACKEND: "Queued backend deployment"},
        ),
        AgentRole.CLOUDFLARE: LoggingAgent(
            AgentRole.CLOUDFLARE,
            responses={TaskType.DNS_ROUTING: "Updated DNS routing"},
        ),
        AgentRole.ELLIE: LoggingAgent(
            AgentRole.ELLIE,
            responses={},
        ),
    }

    return agents

