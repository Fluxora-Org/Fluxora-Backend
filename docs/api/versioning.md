# API Versioning

Fluxora uses header-based API versioning to ensure backward compatibility for our integrators while allowing the platform to evolve. We prioritize header-based negotiation over URI-based versioning (e.g., `/v1/streams`) to keep our endpoint URLs clean, stable, and focused on resources.

## The `Accept-Version` Header

All API requests may specify their desired API version using the `Accept-Version` header.

```http
GET /api/streams HTTP/1.1
Host: api.fluxora.com
Accept-Version: v1
```

### Current Supported Version: `v1`

The current default and only supported stable version is `v1`. 

If a request specifies any of the following values in the `Accept-Version` header, it will be resolved to `v1`:
- `v1`
- `1.0`
- `1`

**Note:** The evaluation is case-insensitive.

### Default Behavior

If the `Accept-Version` header is omitted entirely or left blank, the API will safely default to **`v1`**. This ensures existing clients or simple scripts do not break without the header.

### Response Echo

Every accepted request echoes the version the server actually resolved in the `X-API-Version` response
header, so a client can assert which contract served it without re-deriving it from its own request:

```http
HTTP/1.1 200 OK
X-API-Version: v1
```

Requests that are refused carry no `X-API-Version` header, because no version was resolved.

## Error Handling

If a client requests a version that does not exist or is no longer supported (for example, `v2` or `beta`), the server will immediately reject the request with a `400 Bad Request` status.

The response payload will be a structured JSON error indicating the unsupported version and listing the currently available versions:

```json
{
  "error": "unsupported_version",
  "supported": ["v1"]
}
```

No `X-API-Version` header is set on the refusal response: the request was never bound to a served
contract.

## Programmatic Contract

The selection and refusal rules live in `src/middleware/apiVersion.ts` and are exported for callers and
tests that need to assert them without duplicating the strings:

| Export | Value | Meaning |
|---|---|---|
| `SUPPORTED_VERSIONS` | `["v1"]` | Versions the service currently serves |
| `DEFAULT_API_VERSION` | `"v1"` | Version resolved when `Accept-Version` is omitted or blank |
| `ACCEPT_VERSION_HEADER` | `"accept-version"` | Request header used for negotiation |
| `API_VERSION_RESPONSE_HEADER` | `"X-API-Version"` | Response header echoing the resolved version |

## Future Upgrade Path

When Fluxora introduces a `v2` of the API, the following strategy will be employed:

1. **Opt-in Phase:** `v2` will be released alongside `v1`. Clients *must* explicitly pass `Accept-Version: v2` to access the new behavior.
2. **Default Phase:** The default behavior for requests missing the header will eventually be changed to `v2` after ample communication.
3. **Deprecation Phase:** `v1` will be marked as deprecated but will continue to function for clients explicitly passing `Accept-Version: v1`.
4. **Sunset Phase:** `v1` will be removed, and requests for it will result in an `unsupported_version` error.

## Client SDKs

The generated TypeScript (`@fluxora/sdk`) and Python (`fluxora-sdk`) clients are
versioned in lockstep with the API: their version is copied from `openapi.yaml`
`info.version`, and `scripts/check-sdk-version-sync.mjs` fails CI if the two ever
drift. Publication of both SDKs is automated from a `v*` tagged release.

See [SDK Versioning & Publication](../sdk-publishing.md) for the versioning
policy, the release runbook, and where to obtain each SDK.
