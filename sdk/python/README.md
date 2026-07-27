# Fluxora Python Client SDK

Typed Python client for the Fluxora HTTP API generated directly from `openapi.yaml`.

## Features
- **Zero External Dependencies**: Built strictly using standard Python libraries (`urllib.request`, `json`, `dataclasses`, `typing`).
- **Cursor Pagination**: Native support for server-driven cursor pagination per `src/validation/paginationSchema.ts` semantics (`cursor`, `limit` 1..100, `status`, `sender`, `recipient`, `include_total`).
- **Idempotency Header & Collision Handling**: Built-in support for `Idempotency-Key` headers and canonical SHA-256 body hashing per `src/validation/idempotency.ts`.
- **Complete Endpoint Coverage**: Supports streams, webhooks, auth, health monitoring, and internal operational routes.
- **NatSpec / Docstrings**: Full type annotations and Sphinx/Google style docstrings on all methods and models.

## Installation

```bash
pip install fluxora-sdk
```

## Quickstart

```python
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
```

## Handling Idempotency Conflicts

When a POST request is replayed with an existing `Idempotency-Key` but a different payload, the API raises an `IdempotencyConflictError` (HTTP 409):

```python
from fluxora.exceptions import IdempotencyConflictError

try:
    client.create_stream(
        idempotency_key="reused-key",
        stream_data={"sender": "G...", "recipient": "G...", "amount": "50"}
    )
except IdempotencyConflictError as err:
    print(f"Conflict detected! Stored hash: {err.stored_hash}, Incoming hash: {err.incoming_hash}")
```

## License
MIT
