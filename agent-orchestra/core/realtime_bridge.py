"""Realtime bridge utilities for GrantFlow Orchestra.

This module exposes a lightweight WebSocket bridge that allows external
clients to subscribe to orchestrator events and inject commands in
real-time. It relies on the `websockets` package and stays intentionally
minimal so it can run inside the existing asyncio loop.
"""

from __future__ import annotations

import asyncio
import errno
import json
from typing import Any, Awaitable, Callable, Dict, Optional, Set

from websockets.exceptions import ConnectionClosed
from websockets.server import WebSocketServerProtocol, serve

CommandHandler = Callable[[Dict[str, Any]], Awaitable[None]]


class RealtimeBridge:
    """WebSocket bridge broadcasting orchestrator events."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        *,
        command_handler: Optional[CommandHandler] = None,
    ) -> None:
        self.host = host
        self.port = port
        self._command_handler = command_handler
        self._clients: Set[WebSocketServerProtocol] = set()
        self._clients_lock = asyncio.Lock()
        self._server: Optional[Any] = None

    async def start(self) -> None:
        """Start the WebSocket server."""

        if self._server is not None:
            return

        try:
            self._server = await self._start_server(self.port)
        except OSError as exc:
            if exc.errno == errno.EADDRINUSE and self.port != 0:
                print(
                    f"[BRIDGE] Port {self.port} busy; retrying with an ephemeral port."
                )
                self._server = await self._start_server(0)
            else:
                raise
        print(f"[BRIDGE] Bridge active on ws://{self.host}:{self.port}")

    async def stop(self) -> None:
        """Stop the bridge and close all active client connections."""

        async with self._clients_lock:
            clients = list(self._clients)

        for client in clients:
            await client.close(code=1001, reason="Server shutdown")

        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def publish(self, event: Dict[str, Any]) -> None:
        """Broadcast an event payload to every connected client."""

        payload = json.dumps(event, default=str)

        async with self._clients_lock:
            clients = list(self._clients)

        if not clients:
            return

        await asyncio.gather(
            *(self._safe_send(client, payload) for client in clients),
            return_exceptions=True,
        )

    async def _on_connect(self, websocket: WebSocketServerProtocol) -> None:
        async with self._clients_lock:
            self._clients.add(websocket)

        try:
            async for raw_message in websocket:
                await self._handle_message(raw_message)
        finally:
            async with self._clients_lock:
                self._clients.discard(websocket)

    async def _handle_message(self, raw_message: str) -> None:
        if self._command_handler is None:
            return

        try:
            command = json.loads(raw_message)
        except json.JSONDecodeError:
            return

        result = self._command_handler(command)
        if asyncio.iscoroutine(result):
            await result

    async def _safe_send(
        self,
        websocket: WebSocketServerProtocol,
        payload: str,
    ) -> None:
        if websocket.closed:
            async with self._clients_lock:
                self._clients.discard(websocket)
            return

        try:
            await websocket.send(payload)
        except ConnectionClosed:
            async with self._clients_lock:
                self._clients.discard(websocket)

    async def _start_server(self, port: int) -> Any:
        server = await serve(self._on_connect, self.host, port)
        actual_port = self._extract_port(server)
        if actual_port:
            self.port = actual_port
        return server

    def _extract_port(self, server: Any) -> Optional[int]:
        ws_server = getattr(server, "ws_server", None)
        sockets = None
        if ws_server is not None:
            sockets = getattr(ws_server, "sockets", None)
        if sockets is None:
            sockets = getattr(server, "sockets", None)
        if sockets:
            sockname = sockets[0].getsockname()
            return sockname[1]
        return None

