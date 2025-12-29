"""Agent readiness status tracking for the orchestrator."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING, Dict, Iterable, Optional

if TYPE_CHECKING:
    from .orchestrator import AgentRole


class AgentState(str, Enum):
    READY = "READY"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"


@dataclass
class AgentStatus:
    state: AgentState
    details: Optional[str] = None
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def mark(self, state: AgentState, details: Optional[str] = None) -> None:
        self.state = state
        self.details = details
        self.updated_at = datetime.now(timezone.utc)


class StatusStore:
    """Central store for agent readiness information."""

    def __init__(self) -> None:
        self._statuses: Dict["AgentRole", AgentStatus] = {}

    def set_status(
        self, role: "AgentRole", state: AgentState, details: Optional[str] = None
    ) -> None:
        if role not in self._statuses:
            self._statuses[role] = AgentStatus(state=state, details=details)
        else:
            self._statuses[role].mark(state, details)

    def get_status(self, role: "AgentRole") -> AgentStatus:
        if role not in self._statuses:
            self._statuses[role] = AgentStatus(state=AgentState.READY)
        return self._statuses[role]

    def ensure_ready(
        self, roles: Iterable["AgentRole"]
    ) -> Dict["AgentRole", AgentStatus]:
        """Returns subset of roles whose state is NOT READY."""
        failing: Dict["AgentRole", AgentStatus] = {}
        for role in roles:
            status = self.get_status(role)
            if status.state != AgentState.READY:
                failing[role] = status
        return failing

    def snapshot(self) -> Dict[str, Dict[str, Optional[str]]]:
        """Returns a serializable snapshot of all agent statuses."""
        return {
            role.value: {
                "state": status.state.value,
                "details": status.details,
                "updated_at": status.updated_at.isoformat(),
            }
            for role, status in self._statuses.items()
        }

