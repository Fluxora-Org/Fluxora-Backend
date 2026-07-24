"""
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
