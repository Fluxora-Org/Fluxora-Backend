"""
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
