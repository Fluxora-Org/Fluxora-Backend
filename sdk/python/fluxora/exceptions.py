"""
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
