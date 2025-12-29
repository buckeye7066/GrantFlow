"""Allowed action registry for orchestrator enforcement."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Optional, Set, Dict

ROLE_SYNONYMS = {
    "web_automation": "ellie",
    "system_automation": "ellie",
    "local_automation": "ellie",
}


class ActionDefinition:
    def __init__(
        self,
        action_id: str,
        allowed_roles: Iterable[str],
        human_gated: bool,
        description: Optional[str] = None,
    ) -> None:
        self.id = action_id
        self.allowed_roles: Set[str] = {role.lower() for role in allowed_roles}
        self.human_gated = human_gated
        self.description = description or ""


class ActionRegistry:
    def __init__(self) -> None:
        self._actions: Dict[str, ActionDefinition] = {}
        self._task_mapping: Dict[str, str] = {}

    @classmethod
    def from_file(cls, path: Path) -> "ActionRegistry":
        data = json.loads(path.read_text(encoding="utf-8"))
        registry = cls()
        actions_obj = data.get("actions", {})
        if isinstance(actions_obj, dict):
            iterator = (
                (action_id, meta)
                for action_id, meta in actions_obj.items()
                if isinstance(meta, dict)
            )
        else:
            iterator = (
                (action.get("id"), action)
                for action in actions_obj
                if isinstance(action, dict)
            )

        for action_id, meta in iterator:
            if not action_id:
                continue
            roles = meta.get("allowed_roles") or meta.get("role") or []
            description = meta.get("description")
            human_gated = bool(meta.get("human_gated"))
            definition = ActionDefinition(
                action_id=action_id,
                allowed_roles=roles,
                human_gated=human_gated,
                description=description,
            )
            registry._actions[definition.id] = definition

        for task_type_str, action_id in data.get("task_mapping", {}).items():
            if isinstance(task_type_str, str) and isinstance(action_id, str):
                registry._task_mapping[task_type_str] = action_id
        return registry

    def get_action_for_task(self, task_type: str) -> Optional[ActionDefinition]:
        action_id = self._task_mapping.get(task_type)
        if not action_id:
            return None
        return self._actions.get(action_id)

    def is_role_allowed(self, role: str, action_id: str) -> bool:
        definition = self._actions.get(action_id)
        if not definition:
            return False
        role_key = role.lower()
        role_key = ROLE_SYNONYMS.get(role_key, role_key)
        return role_key in definition.allowed_roles

    def requires_approval(self, action_id: str) -> bool:
        definition = self._actions.get(action_id)
        return bool(definition and definition.human_gated)

    def known_action(self, action_id: str) -> bool:
        return action_id in self._actions

    def all_actions(self) -> Dict[str, ActionDefinition]:
        return self._actions

