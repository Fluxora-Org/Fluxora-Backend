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

## Error Handling

If a client requests a version that does not exist or is no longer supported (for example, `v2` or `beta`), the server will immediately reject the request with a `400 Bad Request` status.

The response payload will be a structured JSON error indicating the unsupported version and listing the currently available versions:

```json
{
  "error": "unsupported_version",
  "supported": ["v1"]
}
```

## Future Upgrade Path

When Fluxora introduces a `v2` of the API, the following strategy will be employed:

1. **Opt-in Phase:** `v2` will be released alongside `v1`. Clients *must* explicitly pass `Accept-Version: v2` to access the new behavior.
2. **Default Phase:** The default behavior for requests missing the header will eventually be changed to `v2` after ample communication.
3. **Deprecation Phase:** `v1` will be marked as deprecated but will continue to function for clients explicitly passing `Accept-Version: v1`.
4. **Sunset Phase:** `v1` will be removed, and requests for it will result in an `unsupported_version` error.
