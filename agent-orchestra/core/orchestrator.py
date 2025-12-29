"""
GRANTFLOW ORCHESTRA - Role-Aware Task Router
Enforces strict agent hierarchy. No agent does more than its natural strength.
"""

import asyncio
import os
from enum import Enum
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set
from datetime import datetime

from .actions import ActionRegistry
from .status import StatusStore, AgentState, AgentStatus

if TYPE_CHECKING:
    from .realtime_bridge import RealtimeBridge
    from .mailbox import Mailbox
    from .memory import MemoryStore


class AgentRole(Enum):
    CLAUDE = "claude"           # Architect - thinks, generates code
    CURSOR = "cursor"           # Executor - implements, builds, tests
    ANYA = "anya"               # Validator - domain logic checks
    CHATGPT = "chatgpt"         # Fallback - debug analysis
    VERCEL = "vercel"           # Frontend deploy only
    RAILWAY = "railway"         # Backend deploy only
    CLOUDFLARE = "cloudflare"   # DNS/routing only
    DIGITALOCEAN = "digitalocean"  # Emergency fallback only
    ELLIE = "ellie"             # Web & local automation

    @classmethod
    def _missing_(cls, value):
        if isinstance(value, str):
            alias = ROLE_ALIASES.get(value.lower())
            if alias:
                return alias
        raise ValueError(f"{value!r} is not a valid AgentRole")

ROLE_ALIASES: Dict[str, AgentRole] = {
    AgentRole.CLAUDE.value: AgentRole.CLAUDE,
    AgentRole.CURSOR.value: AgentRole.CURSOR,
    AgentRole.ANYA.value: AgentRole.ANYA,
    AgentRole.CHATGPT.value: AgentRole.CHATGPT,
    AgentRole.VERCEL.value: AgentRole.VERCEL,
    AgentRole.RAILWAY.value: AgentRole.RAILWAY,
    AgentRole.CLOUDFLARE.value: AgentRole.CLOUDFLARE,
    AgentRole.DIGITALOCEAN.value: AgentRole.DIGITALOCEAN,
    AgentRole.ELLIE.value: AgentRole.ELLIE,
    "web_automation": AgentRole.ELLIE,
    "system_automation": AgentRole.ELLIE,
    "local_automation": AgentRole.ELLIE,
}

class TaskType(Enum):
    ARCHITECTURE = "architecture"
    CODE_GENERATION = "code_generation"
    FILE_CREATION = "file_creation"
    BUILD = "build"
    TEST = "test"
    LINT = "lint"
    DOMAIN_VALIDATION = "domain_validation"
    DEBUG_ANALYSIS = "debug_analysis"
    DEPLOY_FRONTEND = "deploy_frontend"
    DEPLOY_BACKEND = "deploy_backend"
    DNS_ROUTING = "dns_routing"


class PreconditionError(RuntimeError):
    """Raised when hard preconditions are not met before execution."""


class ActionValidationError(RuntimeError):
    """Raised when an agent attempts an unauthorized action."""


class ApprovalRequiredError(RuntimeError):
    """Raised when a human approval is required before continuing."""


# STRICT ROLE ASSIGNMENTS - NEVER VIOLATE
ROLE_PERMISSIONS: Dict[AgentRole, List[TaskType]] = {
    AgentRole.CLAUDE: [
        TaskType.ARCHITECTURE,
        TaskType.CODE_GENERATION,
        TaskType.DEBUG_ANALYSIS,  # reasoning only, no file edits
    ],
    AgentRole.CURSOR: [
        TaskType.FILE_CREATION,
        TaskType.BUILD,
        TaskType.TEST,
        TaskType.LINT,
    ],
    AgentRole.ANYA: [
        TaskType.DOMAIN_VALIDATION,
    ],
    AgentRole.CHATGPT: [
        TaskType.DEBUG_ANALYSIS,
    ],
    AgentRole.VERCEL: [
        TaskType.DEPLOY_FRONTEND,
    ],
    AgentRole.RAILWAY: [
        TaskType.DEPLOY_BACKEND,
    ],
    AgentRole.CLOUDFLARE: [
        TaskType.DNS_ROUTING,
    ],
    AgentRole.DIGITALOCEAN: [],  # Emergency only - manually triggered
    AgentRole.ELLIE: [],  # Automation tasks handled outside pipeline
}


# FORBIDDEN ACTIONS - HARD BLOCKS
FORBIDDEN_ACTIONS: Dict[AgentRole, List[str]] = {
    AgentRole.CLAUDE: [
        "run_command",
        "create_repo",
        "deploy",
        "retry_infra",
        "provision_database",
        "edit_file_directly",
    ],
    AgentRole.CURSOR: [
        "architectural_decision",
        "api_design",
        "deploy_to_cloud",
        "provision_infrastructure",
    ],
    AgentRole.ANYA: [
        "write_code",
        "edit_file",
        "run_test",
        "deploy",
    ],
    AgentRole.RAILWAY: [
        "create_database",
        "design_schema",
        "retry_graphql",
        "provision_infrastructure",
    ],
    AgentRole.CLOUDFLARE: [
        "run_worker",
        "kv_storage",
        "auth_logic",
    ],
    AgentRole.ELLIE: [
        "deploy",
        "dns_change",
        "provision_infrastructure",
    ],
}


@dataclass
class OrchestratorConfig:
    """Configuration flags - set these in your environment"""
    STRICT_COMPLETION_MODE: bool = True
    MAX_AGENT_RETRIES: int = 1
    DISABLE_INFRA_PROVISIONING: bool = True
    LOCAL_SUCCESS_IS_AUTHORITY: bool = True
    REQUIRE_BUILD_BEFORE_DEPLOY: bool = True
    required_agents: List[AgentRole] = field(
        default_factory=lambda: [
            AgentRole.CLAUDE,
            AgentRole.CURSOR,
            AgentRole.ANYA,
            AgentRole.CHATGPT,
        ]
    )
    required_env_keys: List[str] = field(
        default_factory=lambda: ["REPO_FULL_NAME", "BASE_BRANCH", "WORKSPACE_PATH"]
    )


@dataclass
class Task:
    id: str
    task_type: TaskType
    description: str
    assigned_to: Optional[AgentRole] = None
    status: str = "pending"
    dependencies: List[str] = field(default_factory=list)
    result: Optional[Any] = None
    attempts: int = 0
    created_at: datetime = field(default_factory=datetime.now)


class RoleAwareOrchestrator:
    """
    Orchestrator that enforces strict role hierarchy.
    One agent thinks. One agent touches files. One agent deploys. One agent validates.
    """

    def __init__(
        self,
        config: Optional[OrchestratorConfig] = None,
        mailbox: Optional["Mailbox"] = None,
        memory_store: Optional["MemoryStore"] = None,
        status_store: Optional[StatusStore] = None,
        action_registry: Optional[ActionRegistry] = None,
    ):
        self.config = config or OrchestratorConfig()
        self.tasks: Dict[str, Task] = {}
        self.local_build_passed: bool = False
        self.agents: Dict[AgentRole, Any] = {}
        self._bridge: Optional["RealtimeBridge"] = None
        self._mailbox: Optional["Mailbox"] = mailbox
        self._memory_store: Optional["MemoryStore"] = memory_store
        self._active_memory_id: Optional[str] = None
        self.status_store: StatusStore = status_store or StatusStore()
        self.action_registry = action_registry
        self.approved_actions: Set[str] = set()
        self.repo_context = {
            key: os.getenv(key) for key in self.config.required_env_keys
        }
        self.paused: bool = False
        self.advisor_reviews: Dict[str, Dict[str, Any]] = {}

    def _resolve_role(self, role: Any) -> AgentRole:
        if isinstance(role, AgentRole):
            return role
        if isinstance(role, str):
            lowered = role.lower()
            if lowered in ROLE_ALIASES:
                return ROLE_ALIASES[lowered]
        raise ValueError(f"Unrecognized agent role: {role}")

    def register_agent(self, role: Any, agent: Any):
        """Register an agent with its designated role."""
        resolved_role = self._resolve_role(role)
        self.agents[resolved_role] = agent
        self.status_store.set_status(
            resolved_role, AgentState.READY, "Agent registered"
        )
        self._emit_event(
            "agent_registered",
            agent_role=resolved_role.value,
        )

    def attach_realtime_bridge(self, bridge: "RealtimeBridge") -> None:
        """Attach a realtime bridge for broadcasting events."""
        self._bridge = bridge

    def attach_mailbox(self, mailbox: "Mailbox") -> None:
        """Attach mailbox used for persistent event logging and queued commands."""
        self._mailbox = mailbox

    def attach_memory_store(self, memory_store: "MemoryStore") -> None:
        """Attach a memory store used for contextual persistence."""
        self._memory_store = memory_store

    def approve_action(self, action_id: str) -> None:
        """Mark an action as approved by a human operator."""
        self.approved_actions.add(action_id)
        self._emit_event("action_approved", action_id=action_id)

    def set_active_memory(self, memory_id: Optional[str]) -> None:
        """Set the current active memory context."""
        self._active_memory_id = memory_id

    def record_advisor_review(
        self,
        agent: str,
        payload: Dict[str, Any],
        memory_id: Optional[str] = None,
    ) -> None:
        agent_key = agent.lower()
        if agent_key not in {"claude", "chatgpt"}:
            return

        if agent_key == "claude":
            verdict = payload.get("verdict")
            risk = payload.get("risk") or payload.get("risk_level")
            if verdict not in {"SAFE", "UNSAFE"}:
                self._emit_event(
                    "advisor_review_invalid",
                    agent=agent_key,
                    details="Missing or invalid verdict",
                    payload=payload,
                )
                return
            review = {
                "verdict": verdict,
                "risk": risk or "UNKNOWN",
                "reason": payload.get("reason"),
                "preconditions": payload.get("preconditions"),
            }
        else:
            decision = payload.get("decision")
            if decision not in {"APPROVE", "BLOCK"}:
                self._emit_event(
                    "advisor_review_invalid",
                    agent=agent_key,
                    details="Missing or invalid decision",
                    payload=payload,
                )
                return
            review = {
                "decision": decision,
                "reason": payload.get("reason"),
                "required_changes": payload.get("required_changes"),
            }

        self.advisor_reviews[agent_key] = review
        self._emit_event(
            "advisor_review_recorded",
            agent=agent_key,
            review=review,
            memory_id=memory_id,
        )
        self.log_memory_event(
            "advisor_review",
            memory_id=memory_id,
            agent=agent_key,
            review=review,
        )

        if "claude" in self.advisor_reviews and "chatgpt" in self.advisor_reviews:
            self._evaluate_disagreement(memory_id)

    def _evaluate_disagreement(self, memory_id: Optional[str]) -> None:
        claude_review = self.advisor_reviews.get("claude", {})
        chatgpt_review = self.advisor_reviews.get("chatgpt", {})
        claude_verdict = claude_review.get("verdict")
        chatgpt_decision = chatgpt_review.get("decision")

        if not claude_verdict or not chatgpt_decision:
            return

        conflict = False
        conflict_reason = ""

        if claude_verdict == "UNSAFE" and chatgpt_decision == "APPROVE":
            conflict = True
            conflict_reason = "Claude UNSAFE vs ChatGPT APPROVE"
        elif claude_verdict == "SAFE" and chatgpt_decision == "BLOCK":
            conflict = True
            conflict_reason = "Claude SAFE vs ChatGPT BLOCK"

        if not conflict:
            return

        packet = {
            "type": "DISAGREEMENT",
            "claude": {
                "verdict": claude_review.get("verdict"),
                "risk": claude_review.get("risk"),
                "reason": claude_review.get("reason"),
            },
            "chatgpt": {
                "decision": chatgpt_review.get("decision"),
                "reason": chatgpt_review.get("reason"),
            },
            "conflict": conflict_reason,
            "options": [
                "FOLLOW_CLAUDE",
                "FOLLOW_CHATGPT",
                "MODIFY",
                "ABORT",
            ],
        }

        self.paused = True
        self._emit_event(
            "disagreement_detected",
            packet=packet,
            memory_id=memory_id,
        )
        self.log_memory_event(
            "disagreement_packet",
            memory_id=memory_id,
            packet=packet,
        )

    def log_memory_event(
        self,
        event_type: str,
        *,
        memory_id: Optional[str] = None,
        **data: Any,
    ) -> None:
        target = memory_id or self._active_memory_id
        if self._memory_store is None or not target:
            return
        record = {"type": event_type, **data}
        self._memory_store.append(target, record)

    def verify_preconditions(self, goal: str) -> None:
        """Ensure required agents are READY and configuration is present before starting."""
        failing = self.status_store.ensure_ready(self.config.required_agents)
        if failing:
            failing_summary = [
                f"{role.value}: {status.state.value} ({status.details or 'no details'})"
                for role, status in failing.items()
            ]
            message = "Preconditions failed: agents not READY"
            self._emit_event(
                "precondition_failed",
                goal=goal,
                reason=message,
                failing_agents=failing_summary,
            )
            raise PreconditionError(message)

        self.repo_context.update(
            {key: os.getenv(key) for key in self.config.required_env_keys}
        )
        missing_env = [key for key, value in self.repo_context.items() if not value]
        if missing_env:
            message = f"CONFIG MISSING: {', '.join(missing_env)}"
            self._emit_event(
                "precondition_failed",
                goal=goal,
                reason=message,
                missing_env=missing_env,
            )
            raise PreconditionError(message)

        self._emit_event("preconditions_passed", goal=goal)

    def _validate_action(self, role: AgentRole, task: Task) -> None:
        if not self.action_registry:
            return
        task_key = task.task_type.value
        action = self.action_registry.get_action_for_task(task_key)
        if action is None:
            reason = f"No action mapping defined for task '{task_key}'"
            self._emit_event(
                "action_validation_failed",
                task_id=task.id,
                task_type=task_key,
                reason=reason,
            )
            raise ActionValidationError(reason)

        if not self.action_registry.is_role_allowed(role.value, action.id):
            reason = (
                f"Role '{role.value}' is not permitted to execute action '{action.id}'"
            )
            self._emit_event(
                "action_validation_failed",
                task_id=task.id,
                task_type=task_key,
                action_id=action.id,
                reason=reason,
            )
            raise ActionValidationError(reason)

        if self.action_registry.requires_approval(action.id) and action.id not in self.approved_actions:
            self._emit_event(
                "approval_required",
                task_id=task.id,
                task_type=task_key,
                action_id=action.id,
                reason="Human approval required before execution",
            )
            raise ApprovalRequiredError(
                f"Approval required before executing action '{action.id}'"
            )

    def can_agent_do_task(self, role: AgentRole, task_type: TaskType) -> bool:
        """Check if agent is permitted to perform task type."""
        return task_type in ROLE_PERMISSIONS.get(role, [])

    def is_action_forbidden(self, role: AgentRole, action: str) -> bool:
        """Check if action is forbidden for this agent."""
        return action in FORBIDDEN_ACTIONS.get(role, [])

    def route_task(self, task: Task) -> AgentRole:
        """Route task to correct agent based on type. No exceptions."""
        routing = {
            TaskType.ARCHITECTURE: AgentRole.CLAUDE,
            TaskType.CODE_GENERATION: AgentRole.CLAUDE,
            TaskType.FILE_CREATION: AgentRole.CURSOR,
            TaskType.BUILD: AgentRole.CURSOR,
            TaskType.TEST: AgentRole.CURSOR,
            TaskType.LINT: AgentRole.CURSOR,
            TaskType.DOMAIN_VALIDATION: AgentRole.ANYA,
            TaskType.DEBUG_ANALYSIS: AgentRole.CHATGPT,
            TaskType.DEPLOY_FRONTEND: AgentRole.VERCEL,
            TaskType.DEPLOY_BACKEND: AgentRole.RAILWAY,
            TaskType.DNS_ROUTING: AgentRole.CLOUDFLARE,
        }
        return routing.get(task.task_type, AgentRole.CURSOR)

    async def execute_task(self, task: Task) -> Dict[str, Any]:
        """Execute task with strict role enforcement."""

        # Route to correct agent
        assigned_role = self.route_task(task)
        task.assigned_to = assigned_role
        self._emit_event(
            "task_routed",
            task_id=task.id,
            task_type=task.task_type.value,
            assigned_role=assigned_role.value,
        )

        try:
            self._validate_action(assigned_role, task)
        except ApprovalRequiredError as exc:
            self._emit_event(
                "task_paused",
                task_id=task.id,
                reason=str(exc),
                assigned_role=assigned_role.value,
            )
            return {"success": False, "error": str(exc), "fallback": "awaiting_approval"}
        except ActionValidationError as exc:
            return {"success": False, "error": str(exc)}

        # Check if agent is available
        if assigned_role not in self.agents:
            # Fallback logic
            if assigned_role in [AgentRole.VERCEL, AgentRole.RAILWAY]:
                self._emit_event(
                    "task_blocked",
                    task_id=task.id,
                    reason="agent_unavailable",
                    assigned_role=assigned_role.value,
                )
                return {
                    "success": False,
                    "error": f"{assigned_role.value} not available - LOCAL SUCCESS IS AUTHORITY",
                    "fallback": "local_success",
                }
            self._emit_event(
                "task_failed",
                task_id=task.id,
                error=f"Agent {assigned_role.value} not registered",
            )
            return {"success": False, "error": f"Agent {assigned_role.value} not registered"}

        # ENFORCE: No deploy before local build
        if task.task_type in [TaskType.DEPLOY_FRONTEND, TaskType.DEPLOY_BACKEND]:
            if self.config.REQUIRE_BUILD_BEFORE_DEPLOY and not self.local_build_passed:
                self._emit_event(
                    "task_blocked",
                    task_id=task.id,
                    reason="local_build_missing",
                    assigned_role=assigned_role.value,
                )
                return {
                    "success": False,
                    "error": "BLOCKED: npm run build must pass locally before deploy",
                    "action_required": "Run local build first",
                }

        # Execute with retry limit
        task.attempts += 1
        if task.attempts > self.config.MAX_AGENT_RETRIES:
            self._emit_event(
                "task_failed",
                task_id=task.id,
                error=f"Max retries ({self.config.MAX_AGENT_RETRIES}) exceeded",
            )
            return {
                "success": False,
                "error": f"Max retries ({self.config.MAX_AGENT_RETRIES}) exceeded",
                "fallback": "local_success",
            }

        try:
            agent = self.agents[assigned_role]
            result = await agent.execute(task)

            # Track local build success
            if task.task_type == TaskType.BUILD and result.get("success"):
                self.local_build_passed = True
                self._emit_event("build_passed")

            return result
        except Exception as e:
            self._emit_event(
                "task_failed",
                task_id=task.id,
                error=str(e),
            )
            return {"success": False, "error": str(e)}

    def create_execution_plan(self, goal: str) -> List[Task]:
        """
        Create linear execution plan.
        Flow: Claude thinks -> Cursor implements -> Anya validates -> Cursor confirms -> Deploy
        NEVER loops back upward.
        """
        tasks = [
            Task(
                id="1_architecture",
                task_type=TaskType.ARCHITECTURE,
                description=f"Design architecture for: {goal}",
            ),
            Task(
                id="2_code_generation",
                task_type=TaskType.CODE_GENERATION,
                description="Generate code blocks from architecture",
                dependencies=["1_architecture"],
            ),
            Task(
                id="3_file_creation",
                task_type=TaskType.FILE_CREATION,
                description="Implement generated code in files",
                dependencies=["2_code_generation"],
            ),
            Task(
                id="4_lint",
                task_type=TaskType.LINT,
                description="Format and lint all files",
                dependencies=["3_file_creation"],
            ),
            Task(
                id="5_build",
                task_type=TaskType.BUILD,
                description="Run npm run build - MUST PASS",
                dependencies=["4_lint"],
            ),
            Task(
                id="6_test",
                task_type=TaskType.TEST,
                description="Run tests",
                dependencies=["5_build"],
            ),
            Task(
                id="7_domain_validation",
                task_type=TaskType.DOMAIN_VALIDATION,
                description="Validate grant domain logic",
                dependencies=["6_test"],
            ),
            Task(
                id="8_deploy_frontend",
                task_type=TaskType.DEPLOY_FRONTEND,
                description="Deploy to Vercel (only if build passed)",
                dependencies=["7_domain_validation"],
            ),
            Task(
                id="9_deploy_backend",
                task_type=TaskType.DEPLOY_BACKEND,
                description="Deploy to Railway (only if build passed)",
                dependencies=["7_domain_validation"],
            ),
            Task(
                id="10_dns",
                task_type=TaskType.DNS_ROUTING,
                description="Configure Cloudflare routing",
                dependencies=["8_deploy_frontend", "9_deploy_backend"],
            ),
        ]

        for task in tasks:
            self.tasks[task.id] = task

        return tasks

    async def run(self, goal: str):
        """Execute the full pipeline with strict role enforcement."""
        self.verify_preconditions(goal)
        print(f"\n{'='*60}")
        print("GRANTFLOW ORCHESTRA - STRICT MODE")
        print(f"{'='*60}")
        print(f"Goal: {goal}")
        print(f"Config: STRICT_COMPLETION_MODE={self.config.STRICT_COMPLETION_MODE}")
        print(f"Config: MAX_AGENT_RETRIES={self.config.MAX_AGENT_RETRIES}")
        print(f"Config: LOCAL_SUCCESS_IS_AUTHORITY={self.config.LOCAL_SUCCESS_IS_AUTHORITY}")
        print(f"{'='*60}\n")

        tasks = self.create_execution_plan(goal)
        self._emit_event("workflow_started", goal=goal)

        for task in tasks:
            if self.paused:
                print("[PAUSED] Workflow halted due to pending human decision.")
                break
            # Check dependencies
            deps_met = all(
                self.tasks[dep_id].status == "completed"
                for dep_id in task.dependencies
                if dep_id in self.tasks
            )

            if not deps_met:
                print(f"[SKIP] {task.id}: Dependencies not met")
                task.status = "blocked"
                continue

            assigned = self.route_task(task)
            print(f"[{assigned.value.upper()}] {task.id}: {task.description}")
            self._emit_event(
                "task_started",
                task_id=task.id,
                description=task.description,
                assigned_role=assigned.value,
            )

            result = await self.execute_task(task)

            if result.get("success"):
                task.status = "completed"
                print(f"  [OK] Completed")
                self._emit_event("task_completed", task_id=task.id)
            else:
                task.status = "failed"
                error = result.get("error", "Unknown error")
                print(f"  [FAIL] {error}")
                self._emit_event(
                    "task_failed",
                    task_id=task.id,
                    error=error,
                    fallback=result.get("fallback"),
                )

                # LOCAL_SUCCESS_IS_AUTHORITY: Don't block on deploy failures
                if result.get("fallback") == "local_success":
                    print(f"  [INFO] Local success is authority - continuing")
                    task.status = "completed"  # Mark as done anyway
                else:
                    print(f"  [STOP] Pipeline halted")
                    break

        # Summary
        completed = sum(1 for t in self.tasks.values() if t.status == "completed")
        failed = sum(1 for t in self.tasks.values() if t.status == "failed")
        print(f"\n{'='*60}")
        print(f"COMPLETE: {completed}/{len(self.tasks)} tasks")
        print(f"FAILED: {failed}")
        print(f"LOCAL BUILD PASSED: {self.local_build_passed}")
        print(f"{'='*60}\n")
        self._emit_event(
            "workflow_completed",
            completed=completed,
            failed=failed,
            local_build_passed=self.local_build_passed,
        )

    def record_chat(
        self,
        sender: str,
        message: str,
        channel: str = "general",
        *,
        memory_id: Optional[str] = None,
    ) -> None:
        """Record and broadcast a chat message from an external agent."""
        data = {
            "sender": sender,
            "message": message,
            "channel": channel,
        }
        print(f"[CHAT:{channel}] {sender}: {message}")
        self._emit_event("chat_message", **data, memory_id=memory_id)

    def _emit_event(self, event_type: str, **data: Any) -> None:
        memory_id = data.get("memory_id") or self._active_memory_id
        if memory_id:
            data = {**data, "memory_id": memory_id}
        payload = {
            "type": event_type,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "data": data,
        }
        if memory_id:
            payload["memory_id"] = memory_id

        if self._mailbox is not None:
            self._mailbox.record_event(event_type, data)

        if memory_id:
            filtered = {k: v for k, v in data.items() if k != "memory_id"}
            self.log_memory_event(event_type, memory_id=memory_id, **filtered)

        if self._bridge is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self._bridge.publish(payload))


