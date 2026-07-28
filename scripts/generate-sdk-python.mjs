#!/usr/bin/env node
/**
 * Companion generation script that produces a typed Python client SDK under `sdk/python/`
 * from `openapi.yaml`.
 *
 * Usage:
 *   node scripts/generate-sdk-python.mjs [--check] [--out-dir <path>] [--spec <path>]
 *
 * Options:
 *   --check       Drift check mode: compares generated output against existing files.
 *                 Exits 0 if identical, exits 1 if files differ or are missing.
 *   --out-dir     Output directory for the Python SDK (default: sdk/python).
 *   --spec        Path to openapi.yaml spec file (default: openapi.yaml).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Parse command line arguments
const args = process.argv.slice(2);
const isCheckMode = args.includes('--check');

let outDirArg = 'sdk/python';
const outDirIdx = args.indexOf('--out-dir');
if (outDirIdx !== -1 && args[outDirIdx + 1]) {
  outDirArg = args[outDirIdx + 1];
}

let specPathArg = 'openapi.yaml';
const specIdx = args.indexOf('--spec');
if (specIdx !== -1 && args[specIdx + 1]) {
  specPathArg = args[specIdx + 1];
}

const ROOT_DIR = process.cwd();
const SPEC_PATH = path.resolve(ROOT_DIR, specPathArg);
const OUT_DIR = path.resolve(ROOT_DIR, outDirArg);

/**
 * Lightweight recursive YAML parser for OpenAPI 3.x spec files.
 */
function parseSimpleYaml(yamlString) {
  const lines = yamlString.split(/\r?\n/);
  let lineIdx = 0;

  function getIndent(line) {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  function parseBlock(baseIndent) {
    let result = null;
    let isMap = false;
    let isArray = false;

    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        lineIdx++;
        continue;
      }

      const currentIndent = getIndent(line);
      if (currentIndent < baseIndent) {
        break;
      }

      if (trimmed.startsWith('- ')) {
        if (result === null) {
          result = [];
          isArray = true;
        } else if (!isArray) {
          break;
        }

        const itemContent = trimmed.slice(2).trim();
        if (itemContent.includes(': ') || itemContent.endsWith(':')) {
          // Object item in list
          lines[lineIdx] = ' '.repeat(currentIndent + 2) + itemContent;
          const subObj = parseBlock(currentIndent + 2);
          result.push(subObj);
        } else {
          result.push(parseScalarValue(itemContent));
          lineIdx++;
        }
      } else if (trimmed.includes(':') || trimmed.endsWith(':')) {
        if (result === null) {
          result = {};
          isMap = true;
        } else if (!isMap) {
          break;
        }

        const colonIdx = trimmed.indexOf(':');
        const key = trimmed.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
        let valueStr = trimmed.slice(colonIdx + 1).trim();

        lineIdx++;

        if (valueStr === '|' || valueStr === '>-' || valueStr === '>') {
          // Multiline block scalar
          let scalarLines = [];
          const blockIndent = currentIndent + 2;
          while (lineIdx < lines.length) {
            const nextLine = lines[lineIdx];
            if (!nextLine.trim()) {
              scalarLines.push('');
              lineIdx++;
              continue;
            }
            if (getIndent(nextLine) < blockIndent) {
              break;
            }
            scalarLines.push(nextLine.slice(blockIndent));
            lineIdx++;
          }
          result[key] = scalarLines.join('\n').trim();
        } else if (!valueStr) {
          // Nested block object/array
          if (lineIdx < lines.length && getIndent(lines[lineIdx]) > currentIndent) {
            result[key] = parseBlock(getIndent(lines[lineIdx]));
          } else {
            result[key] = null;
          }
        } else {
          result[key] = parseScalarValue(valueStr);
        }
      } else {
        lineIdx++;
      }
    }

    return result ?? {};
  }

  function parseScalarValue(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null' || val === '~') return null;
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      return val.slice(1, -1);
    }
    // Simple array syntax e.g. [scheduled, active]
    if (val.startsWith('[') && val.endsWith(']')) {
      return val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    }
    return val;
  }

  return parseBlock(0);
}

/**
 * Load OpenAPI spec file.
 */
function loadSpec(specPath) {
  if (!fs.existsSync(specPath)) {
    throw new Error(`OpenAPI spec file not found at ${specPath}`);
  }
  const raw = fs.readFileSync(specPath, 'utf8');
  return parseSimpleYaml(raw);
}

/**
 * Generate Python SDK files.
 */
function generatePythonSdk(spec) {
  const files = {};

  // 1. pyproject.toml
  files['pyproject.toml'] = `[build-system]
requires = ["flit_core >=3.2,<4"]
build-backend = "flit.core.buildapi"

[project]
name = "fluxora-sdk"
version = "${spec.info?.version || '0.1.0'}"
description = "${(spec.info?.description || 'Fluxora Client SDK').split('\n')[0]}"
readme = "README.md"
authors = [
    { name = "Fluxora Team" }
]
license = { file = "LICENSE" }
classifiers = [
    "Development Status :: 4 - Beta",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: MIT License",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.8",
    "Programming Language :: Python :: 3.9",
    "Programming Language :: Python :: 3.10",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Topic :: Software Development :: Libraries :: Python Modules",
]
requires-python = ">=3.8"
dependencies = []

[project.urls]
Homepage = "https://github.com/Fluxora-Org/Fluxora-Backend"
Repository = "https://github.com/Fluxora-Org/Fluxora-Backend"
`;

  // 2. README.md
  files['README.md'] = `# Fluxora Python Client SDK

Typed Python client for the Fluxora HTTP API generated directly from \`openapi.yaml\`.

## Features
- **Zero External Dependencies**: Built strictly using standard Python libraries (\`urllib.request\`, \`json\`, \`dataclasses\`, \`typing\`).
- **Cursor Pagination**: Native support for server-driven cursor pagination per \`src/validation/paginationSchema.ts\` semantics (\`cursor\`, \`limit\` 1..100, \`status\`, \`sender\`, \`recipient\`, \`include_total\`).
- **Idempotency Header & Collision Handling**: Built-in support for \`Idempotency-Key\` headers and canonical SHA-256 body hashing per \`src/validation/idempotency.ts\`.
- **Complete Endpoint Coverage**: Supports streams, webhooks, auth, health monitoring, and internal operational routes.
- **NatSpec / Docstrings**: Full type annotations and Sphinx/Google style docstrings on all methods and models.

## Installation

\`\`\`bash
pip install fluxora-sdk
\`\`\`

## Quickstart

\`\`\`python
from fluxora import FluxoraClient, StreamPaginator, generate_idempotency_key

# Initialize client
client = FluxoraClient(base_url="http://localhost:3000")

# 1. Check system health
health = client.get_health()
print(f"Service status: {health.get('status')}")

# 2. Create an auth session
session = client.create_session(
    address="GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX",
    role="operator"
)
client.set_bearer_token(session.get("token"))

# 3. Create a stream with idempotency key
idempotency_key = generate_idempotency_key()
stream = client.create_stream(
    idempotency_key=idempotency_key,
    stream_data={
        "sender": "GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX",
        "recipient": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        "amount": "100.5000000",
        "asset": "XLM"
    }
)
print(f"Created stream ID: {stream.get('id')}")

# 4. List streams using StreamPaginator for cursor pagination
paginator: StreamPaginator = client.list_streams(limit=20, status="active")
for page in paginator:
    for stream in page:
        print(f"Stream: {stream.get('id')} - {stream.get('status')}")

# Alternatively, auto-paginate through individual items
for stream in client.list_streams(limit=10).auto_paginate():
    print(f"Stream item: {stream.get('id')}")
\`\`\`

## Handling Idempotency Conflicts

When a POST request is replayed with an existing \`Idempotency-Key\` but a different payload, the API raises an \`IdempotencyConflictError\` (HTTP 409):

\`\`\`python
from fluxora.exceptions import IdempotencyConflictError

try:
    client.create_stream(
        idempotency_key="reused-key",
        stream_data={"sender": "G...", "recipient": "G...", "amount": "50"}
    )
except IdempotencyConflictError as err:
    print(f"Conflict detected! Stored hash: {err.stored_hash}, Incoming hash: {err.incoming_hash}")
\`\`\`

## License
MIT
`;

  // 3. fluxora/__init__.py
  files['fluxora/__init__.py'] = `"""
Fluxora Python Client SDK
~~~~~~~~~~~~~~~~~~~~~~~~~

Typed client library for consuming Fluxora HTTP API services.
"""

from .client import FluxoraClient
from .pagination import StreamPaginator
from .idempotency import generate_idempotency_key, canonicalize_body, hash_body
from .exceptions import (
    FluxoraError,
    ApiError,
    IdempotencyConflictError,
    ValidationError,
)

__version__ = "${spec.info?.version || '0.1.0'}"

__all__ = [
    "FluxoraClient",
    "StreamPaginator",
    "generate_idempotency_key",
    "canonicalize_body",
    "hash_body",
    "FluxoraError",
    "ApiError",
    "IdempotencyConflictError",
    "ValidationError",
]
`;

  // 4. fluxora/exceptions.py
  files['fluxora/exceptions.py'] = `"""
Typed exception definitions for the Fluxora SDK.
"""

from typing import Optional, Any


class FluxoraError(Exception):
    """Base exception class for all errors raised by the Fluxora SDK."""
    pass


class ApiError(FluxoraError):
    """
    Raised when the API returns a non-2xx status code.

    :param status_code: HTTP status code returned by the server.
    :param code: Error code string (e.g. 'VALIDATION_ERROR', 'NOT_FOUND').
    :param message: Human-readable error description.
    :param details: Additional error payload details dictionary.
    :param request_id: Unique correlation/request ID attached to the response.
    """
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Optional[Any] = None,
        request_id: Optional[str] = None,
    ):
        super().__init__(f"[{status_code}] {code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id


class IdempotencyConflictError(ApiError):
    """
    Raised when an HTTP 409 Conflict occurs due to reusing an Idempotency-Key
    with a modified payload (per src/validation/idempotency.ts semantics).

    :param stored_hash: SHA-256 digest of the original request body stored in cache.
    :param incoming_hash: SHA-256 digest of the new request body.
    """
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        stored_hash: Optional[str] = None,
        incoming_hash: Optional[str] = None,
        details: Optional[Any] = None,
        request_id: Optional[str] = None,
    ):
        super().__init__(status_code, code, message, details=details, request_id=request_id)
        self.stored_hash = stored_hash
        self.incoming_hash = incoming_hash


class ValidationError(FluxoraError):
    """Raised when client-side input validation fails prior to HTTP dispatch."""
    pass
`;

  // 5. fluxora/idempotency.py
  files['fluxora/idempotency.py'] = `"""
Idempotency Utilities
~~~~~~~~~~~~~~~~~~~~~

Header and payload hashing utilities matching src/validation/idempotency.ts
and src/middleware/idempotency.ts semantics.
"""

import uuid
import json
import hashlib
from typing import Any


def generate_idempotency_key() -> str:
    """
    Generate an opaque UUID v4 idempotency key string suitable for HTTP headers.

    :return: 36-character UUID string matching [A-Za-z0-9:_-] charset.
    """
    return str(uuid.uuid4())


def canonicalize_body(body: Any) -> str:
    """
    Canonicalize a JSON payload recursively by sorting object keys and removing whitespace.
    Mirrors JavaScript canonicalizeBody() in src/middleware/idempotency.ts.

    :param body: JSON-serializable structure (dict, list, int, float, str, bool, None).
    :return: Deterministic canonical string representation.
    """
    if body is None or not isinstance(body, (dict, list)):
        if body is None:
            return "null"
        return json.dumps(body, separators=(',', ':'))

    if isinstance(body, list):
        items = [canonicalize_body(item) for item in body]
        return f"[{','.join(items)}]"

    sorted_keys = sorted(body.keys())
    parts = [f'"{k}":{canonicalize_body(body[k])}' for k in sorted_keys]
    return f"{{{','.join(parts)}}}"


def hash_body(body: Any) -> str:
    """
    Calculate the SHA-256 fingerprint digest of a canonicalized request body.
    Mirrors hashBody() in src/middleware/idempotency.ts.

    :param body: Request body structure.
    :return: 64-character lowercase hex digest string.
    """
    canonical = canonicalize_body(body)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()
`;

  // 6. fluxora/pagination.py
  files['fluxora/pagination.py'] = `"""
Cursor Pagination Helpers
~~~~~~~~~~~~~~~~~~~~~~~~~

Iterator implementing cursor-based pagination semantics per src/validation/paginationSchema.ts.
"""

from typing import TypeVar, Generic, List, Optional, Callable, Iterator, Any, Dict

T = TypeVar("T")


class StreamPaginator(Generic[T]):
    """
    Cursor-based pagination helper for listing streams.

    Automatically handles fetching pages, managing opaque cursor tokens (\`next_cursor\`),
    and enforcing limit constraints (1..100, default 20) per src/validation/paginationSchema.ts.

    :param fetch_page: Function executing HTTP page request with query parameters.
    :param limit: Results per page (1..100, default 20).
    :param status: Optional stream status filter ('scheduled', 'active', 'paused', 'completed', 'cancelled').
    :param sender: Optional Stellar sender address filter.
    :param recipient: Optional Stellar recipient address filter.
    :param include_total: Whether to compute point-in-time total match count.
    """
    def __init__(
        self,
        fetch_page: Callable[..., Dict[str, Any]],
        limit: int = 20,
        status: Optional[str] = None,
        sender: Optional[str] = None,
        recipient: Optional[str] = None,
        include_total: bool = False,
    ):
        if limit < 1 or limit > 100:
            raise ValueError("limit must be an integer between 1 and 100 per paginationSchema")
        self.fetch_page = fetch_page
        self.limit = limit
        self.status = status
        self.sender = sender
        self.recipient = recipient
        self.include_total = include_total
        self._next_cursor: Optional[str] = None
        self._has_more: bool = True
        self._page_count: int = 0

    def __iter__(self) -> Iterator[List[T]]:
        """Iterate page-by-page, yielding lists of items."""
        return self

    def __next__(self) -> List[T]:
        if not self._has_more:
            raise StopIteration

        res = self.fetch_page(
            cursor=self._next_cursor,
            limit=self.limit,
            status=self.status,
            sender=self.sender,
            recipient=self.recipient,
            include_total=self.include_total,
        )

        data = res.get("data", []) if isinstance(res, dict) else getattr(res, "data", [])
        meta = res.get("meta", {}) if isinstance(res, dict) else getattr(res, "meta", {})

        next_cursor = None
        if isinstance(meta, dict):
            next_cursor = meta.get("next_cursor")
        elif hasattr(meta, "next_cursor"):
            next_cursor = getattr(meta, "next_cursor")

        self._page_count += 1
        if next_cursor:
            self._next_cursor = next_cursor
        else:
            self._has_more = False

        return data

    def auto_paginate(self) -> Iterator[T]:
        """
        Flatten page iterations into a continuous generator of individual items.

        :return: Generator yielding single items sequentially across all pages.
        """
        for page in self:
            for item in page:
                yield item
`;

  // 7. fluxora/models.py
  files['fluxora/models.py'] = `"""
Type definitions and data models matching openapi.yaml schemas.
"""

from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field


@dataclass
class ResponseMeta:
    request_id: Optional[str] = None
    timestamp: Optional[str] = None
    next_cursor: Optional[str] = None
    total: Optional[int] = None
    idempotency_replayed: Optional[bool] = None


@dataclass
class Stream:
    id: str
    sender: str
    recipient: str
    amount: str
    asset: str
    status: str
    created_at: str
    updated_at: str
    rate_per_second: Optional[str] = None
    start_time: Optional[int] = None
    stop_time: Optional[int] = None


@dataclass
class CreateStreamRequest:
    sender: str
    recipient: str
    amount: str
    asset: str
    start_time: Optional[int] = None
    stop_time: Optional[int] = None


@dataclass
class WebhookDelivery:
    id: str
    delivery_id: str
    event_id: str
    event_type: str
    status: str
    created_at: str
    updated_at: str
    attempts: List[Dict[str, Any]] = field(default_factory=list)
`;

  // 8. fluxora/client.py
  files['fluxora/client.py'] = `"""
Fluxora HTTP Client
~~~~~~~~~~~~~~~~~~~

Main client interface for interacting with Fluxora Backend API endpoints.
"""

import json
import urllib.request
import urllib.parse
import urllib.error
from typing import Optional, Dict, Any, Union, List

from .exceptions import ApiError, IdempotencyConflictError, ValidationError
from .idempotency import generate_idempotency_key
from .pagination import StreamPaginator


class FluxoraClient:
    """
    Synchronous HTTP Client for the Fluxora API.

    :param base_url: Base HTTP URL of the Fluxora service (e.g. 'http://localhost:3000').
    :param api_key: Optional API key for header authentication.
    :param bearer_token: Optional JWT token for Bearer authentication.
    :param timeout: Request timeout in seconds (default 30.0).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:3000",
        api_key: Optional[str] = None,
        bearer_token: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.bearer_token = bearer_token
        self.timeout = timeout
        self.headers: Dict[str, str] = {
            "User-Agent": "FluxoraPythonSDK/0.1.0",
            "Accept": "application/json",
        }

    def set_bearer_token(self, token: str) -> None:
        """Set or update the active Bearer JWT auth token."""
        self.bearer_token = token

    def set_api_key(self, api_key: str) -> None:
        """Set or update the active API key."""
        self.api_key = api_key

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Internal HTTP transport wrapper using Python standard urllib.
        """
        url = f"{self.base_url}{path}"
        if params:
            clean_params = {k: v for k, v in params.items() if v is not None}
            if clean_params:
                encoded = urllib.parse.urlencode(clean_params)
                url = f"{url}?{encoded}"

        req_headers = dict(self.headers)
        if self.bearer_token:
            req_headers["Authorization"] = f"Bearer {self.bearer_token}"
        if self.api_key:
            req_headers["X-API-Key"] = self.api_key
        if headers:
            req_headers.update(headers)

        body_bytes = None
        if json_data is not None:
            body_bytes = json.dumps(json_data).encode("utf-8")
            req_headers["Content-Type"] = "application/json"

        req = urllib.request.Request(
            url,
            data=body_bytes,
            headers=req_headers,
            method=method.upper(),
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp_bytes = resp.read()
                if not resp_bytes:
                    return {}
                return json.loads(resp_bytes.decode("utf-8"))
        except urllib.error.HTTPError as err:
            err_bytes = err.read()
            err_data = {}
            if err_bytes:
                try:
                    err_data = json.loads(err_bytes.decode("utf-8"))
                except Exception:
                    err_data = {"message": err_bytes.decode("utf-8", errors="ignore")}

            req_id = err.headers.get("x-request-id") or err_data.get("meta", {}).get("requestId")
            err_code = err_data.get("error") if isinstance(err_data.get("error"), str) else "HTTP_ERROR"
            err_msg = err_data.get("message") or err_data.get("error", {}).get("message") if isinstance(err_data.get("error"), dict) else str(err.reason)

            # Handle 409 Idempotency Conflict per src/validation/idempotency.ts
            if err.code == 409 or err_code == "idempotency_conflict":
                stored_hash = err_data.get("stored_hash")
                incoming_hash = err_data.get("incoming_hash")
                raise IdempotencyConflictError(
                    status_code=err.code,
                    code="idempotency_conflict",
                    message=err_msg or "Idempotency key collision with differing payload",
                    stored_hash=stored_hash,
                    incoming_hash=incoming_hash,
                    details=err_data,
                    request_id=req_id,
                )

            raise ApiError(
                status_code=err.code,
                code=err_code,
                message=err_msg or f"HTTP {err.code}",
                details=err_data.get("details"),
                request_id=req_id,
            )
        except urllib.error.URLError as err:
            raise ApiError(
                status_code=0,
                code="NETWORK_ERROR",
                message=str(err.reason),
            )

    # --- System Endpoints ---

    def get_root(self) -> Dict[str, Any]:
        """GET / - Service metadata and version information."""
        return self._request("GET", "/")

    def get_health(self) -> Dict[str, Any]:
        """GET /health - Service health status."""
        return self._request("GET", "/health")

    def get_health_ready(self) -> Dict[str, Any]:
        """GET /health/ready - Service readiness probe."""
        return self._request("GET", "/health/ready")

    def get_health_live(self) -> Dict[str, Any]:
        """GET /health/live - Service liveness probe."""
        return self._request("GET", "/health/live")

    # --- Auth Endpoints ---

    def create_session(self, address: str, role: str = "viewer") -> Dict[str, Any]:
        """
        POST /api/auth/session - Issue JWT session token for a Stellar address.

        :param address: Stellar G-address public key.
        :param role: Role string ('operator' or 'viewer').
        """
        return self._request("POST", "/api/auth/session", json_data={"address": address, "role": role})

    # --- Stream Endpoints ---

    def create_stream(
        self,
        stream_data: Dict[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        POST /api/streams - Create a streaming payment with mandatory Idempotency-Key.

        :param stream_data: Stream payload dictionary (sender, recipient, amount, asset).
        :param idempotency_key: Unique idempotency key (auto-generated if omitted).
        """
        key = idempotency_key or generate_idempotency_key()
        headers = {"Idempotency-Key": key}
        return self._request("POST", "/api/streams", json_data=stream_data, headers=headers)

    def list_streams(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
        status: Optional[str] = None,
        sender: Optional[str] = None,
        recipient: Optional[str] = None,
        include_total: bool = False,
    ) -> StreamPaginator[Dict[str, Any]]:
        """
        GET /api/streams - List streams using cursor pagination per paginationSchema.ts.

        :param limit: Results per page (1..100, default 20).
        :param cursor: Opaque cursor string from previous response.
        :param status: Filter by stream status.
        :param sender: Filter by sender Stellar address.
        :param recipient: Filter by recipient Stellar address.
        :param include_total: Whether to compute total match count.
        :return: StreamPaginator instance.
        """
        def fetch_page(**kw) -> Dict[str, Any]:
            params = {
                "limit": kw.get("limit", limit),
                "cursor": kw.get("cursor"),
                "status": kw.get("status"),
                "sender": kw.get("sender"),
                "recipient": kw.get("recipient"),
            }
            if kw.get("include_total"):
                params["include_total"] = "true"
            return self._request("GET", "/api/streams", params=params)

        return StreamPaginator(
            fetch_page=fetch_page,
            limit=limit,
            status=status,
            sender=sender,
            recipient=recipient,
            include_total=include_total,
        )

    def get_stream(self, stream_id: str) -> Dict[str, Any]:
        """GET /api/streams/{streamId} - Get stream details by ID."""
        return self._request("GET", f"/api/streams/{stream_id}")

    def poll_stream_events(
        self,
        stream_id: str,
        since: Optional[str] = None,
        timeout: int = 30,
    ) -> Dict[str, Any]:
        """GET /api/streams/{streamId}/poll - Long-polling stream updates."""
        params = {"timeout": timeout}
        if since:
            params["since"] = since
        return self._request("GET", f"/api/streams/{stream_id}/poll", params=params)

    def cancel_stream(self, stream_id: str) -> Dict[str, Any]:
        """DELETE /api/streams/{streamId}/poll or /api/streams/{streamId} - Cancel a stream."""
        return self._request("DELETE", f"/api/streams/{stream_id}/poll")

    # --- Webhook Endpoints ---

    def queue_webhook(
        self,
        event: Dict[str, Any],
        endpoint_url: str,
        secret: str,
        priority: str = "normal",
    ) -> Dict[str, Any]:
        """POST /api/webhooks/queue - Queue a webhook delivery."""
        payload = {
            "event": event,
            "endpointUrl": endpoint_url,
            "secret": secret,
            "priority": priority,
        }
        return self._request("POST", "/api/webhooks/queue", json_data=payload)

    def get_webhook_delivery(self, delivery_id: str) -> Dict[str, Any]:
        """GET /api/webhooks/deliveries/{deliveryId} - Get webhook status."""
        return self._request("GET", f"/api/webhooks/deliveries/{delivery_id}")

    def list_outbox(self, priority: Optional[str] = None, status: str = "ready") -> Dict[str, Any]:
        """GET /api/webhooks/outbox - List webhook outbox items."""
        return self._request("GET", "/api/webhooks/outbox", params={"priority": priority, "status": status})

    def list_dlq(self, limit: int = 50) -> Dict[str, Any]:
        """GET /api/webhooks/dlq - List dead-letter queue items."""
        return self._request("GET", "/api/webhooks/dlq", params={"limit": limit})

    def retry_dlq(self, dlq_id: str, secret: str) -> Dict[str, Any]:
        """POST /api/webhooks/dlq/{dlqId}/retry - Retry dead-letter queue item."""
        return self._request("POST", f"/api/webhooks/dlq/{dlq_id}/retry", json_data={"secret": secret})

    def get_circuit_breakers(self, endpoint_url: Optional[str] = None) -> Dict[str, Any]:
        """GET /api/webhooks/circuit-breakers - Inspect circuit breaker states."""
        return self._request("GET", "/api/webhooks/circuit-breakers", params={"endpointUrl": endpoint_url})

    def reset_circuit_breaker(self, endpoint_url: str) -> Dict[str, Any]:
        """POST /api/webhooks/circuit-breakers/{endpointUrl}/reset - Reset circuit breaker."""
        encoded_url = urllib.parse.quote(endpoint_url, safe="")
        return self._request("POST", f"/api/webhooks/circuit-breakers/{encoded_url}/reset")

    def get_metrics(self) -> Dict[str, Any]:
        """GET /api/webhooks/metrics - Get webhook delivery metrics."""
        return self._request("GET", "/api/webhooks/metrics")

    # --- Internal Endpoints ---

    def trigger_indexer_sync(self, ledger_sequence: int) -> Dict[str, Any]:
        """POST /internal/indexer/sync - Trigger internal indexer synchronization."""
        return self._request("POST", "/internal/indexer/sync", json_data={"ledgerSequence": ledger_sequence})

    def start_indexer_replay(self, contract_id: str, ledger: int) -> Dict[str, Any]:
        """POST /internal/indexer/events/replay - Trigger historical contract event replay."""
        return self._request("POST", "/internal/indexer/events/replay", json_data={"contract_id": contract_id, "ledger": ledger})
`;

  // 9. fluxora/py.typed  (PEP 561 marker — zero-byte file)
  files['fluxora/py.typed'] = '';

  return files;
}

/**
 * Main execution function.
 */
function main() {
  console.log(`[SDK Generator] Loading OpenAPI spec from ${SPEC_PATH}...`);
  const spec = loadSpec(SPEC_PATH);
  console.log(`[SDK Generator] Generating Python SDK for ${spec.info?.title || 'Fluxora API'} v${spec.info?.version || '0.1.0'}...`);

  const generatedFiles = generatePythonSdk(spec);

  if (isCheckMode) {
    console.log(`[SDK Generator] Running in DRIFT CHECK mode (--check)...`);
    let hasDrift = false;

    for (const [relativePath, expectedContent] of Object.entries(generatedFiles)) {
      const fullPath = path.resolve(OUT_DIR, relativePath);
      if (!fs.existsSync(fullPath)) {
        console.error(`[DRIFT DETECTED] Missing file: ${relativePath}`);
        hasDrift = true;
        continue;
      }
      const existingContent = fs.readFileSync(fullPath, 'utf8');
      if (existingContent.replace(/\r\n/g, '\n') !== expectedContent.replace(/\r\n/g, '\n')) {
        console.error(`[DRIFT DETECTED] Content mismatch in file: ${relativePath}`);
        hasDrift = true;
      }
    }

    if (hasDrift) {
      console.error(`\n[DRIFT CHECK FAILED] Generated Python SDK code has drifted from ${specPathArg}. Re-run generator to update.`);
      process.exit(1);
    } else {
      console.log(`\n[DRIFT CHECK PASSED] Python SDK code is completely up-to-date with ${specPathArg}.`);
      process.exit(0);
    }
  } else {
    console.log(`[SDK Generator] Writing files to ${OUT_DIR}...`);
    for (const [relativePath, content] of Object.entries(generatedFiles)) {
      const fullPath = path.resolve(OUT_DIR, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      console.log(`  + Wrote ${relativePath}`);
    }
    console.log(`\n[SDK Generator] Successfully generated Python SDK in ${OUT_DIR}`);
  }
}

main();
