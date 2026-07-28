"""
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
