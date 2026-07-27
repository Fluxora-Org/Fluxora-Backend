"""
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

__version__ = "0.1.0"

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
