# SDK Versioning & Publication

The Fluxora HTTP API ships two generated client SDKs. Both are produced from
the checked-in OpenAPI document at the repository root and are published to
public package registries, so the SDK a consumer installs is always the one that
matches the API version it talks to.

| SDK | Package | Built from | Published to |
|-----|---------|------------|--------------|
| TypeScript | `@fluxora/sdk` | `sdk/typescript/` | npm — <https://www.npmjs.com/package/@fluxora/sdk> |
| Python | `fluxora-sdk` | `sdk/python/` | PyPI — <https://pypi.org/project/fluxora-sdk/> |

Consumers can also download the source archives for any release from the
[GitHub Releases page](https://github.com/Fluxora-Org/Fluxora-Backend/releases).

---

## Version relationship to the API

`openapi.yaml` → `info.version` is the **single source of truth** for the API
version. The generators do not invent a version of their own: each one copies
`info.version` into the SDK's own version field at generation time.

| Artefact | Where the version comes from |
|----------|------------------------------|
| API | `openapi.yaml` `info.version` |
| TypeScript SDK | `sdk/typescript/package.json` `version` (generated) |
| Python SDK distribution | `sdk/python/pyproject.toml` `[project] version` (generated) |
| Python SDK runtime | `sdk/python/fluxora/__init__.py` `__version__` (generated) |

Because every value is derived from the same field, the invariant is:

```
SDK version == API version == openapi.yaml info.version
```

This invariant is enforced, not merely documented:

- `scripts/check-sdk-version-sync.mjs` compares all four values and exits
  non-zero on any drift.
- The `test` job in `.github/workflows/ci.yml` runs that check on every push and
  pull request.
- `tests/sdk/sdk.versioning.test.ts` asserts the same invariant plus the
  release/version matches.

A breaking API change therefore cannot ship an SDK that still advertises the old
version — the generated artefacts must be regenerated (which updates their
version) and the check must pass before the branch is mergeable.

---

## Semantic versioning policy

Both SDKs follow [Semantic Versioning](https://semver.org/) and inherit the API
version. When a change lands on the API, bump `openapi.yaml` `info.version`
accordingly and regenerate both SDKs:

| API change | Version bump | Example |
|------------|--------------|---------|
| Additive, backward-compatible (new endpoint, new optional field) | patch or minor | `0.1.0` → `0.1.1` / `0.2.0` |
| Backward-compatible behaviour change | minor | `0.1.1` → `0.2.0` |
| Breaking change (removed/renamed field, changed type, stricter validation) | **major** | `0.2.0` → `1.0.0` |
| Documentation / comments only | patch | `0.1.0` → `0.1.1` |

A breaking API change *must* produce a correspondingly versioned SDK: because
the SDK version is copied from `info.version`, raising the API major version
raises the SDK major version in the same commit that regenerates the SDK. The
version-sync check fails until the SDK is regenerated, so the two can never
diverge.

Regenerate both SDKs after any spec change:

```bash
pnpm generate:sdk:ts
pnpm generate:sdk:python
pnpm check:sdk          # drift + version-sync gate
```

---

## Publication from a tagged release

Publication is fully automated by
[`.github/workflows/publish-sdk.yml`](../.github/workflows/publish-sdk.yml),
which runs on a `v*` tag push.

1. **Verify** — installs dependencies, runs the TypeScript and Python drift
   checks, then runs
   `node scripts/check-sdk-version-sync.mjs --tag "$GITHUB_REF_NAME"`. This fails
   the release if the tag does not equal `openapi.yaml` `info.version` or if an
   SDK version has drifted.
2. **Publish TypeScript** — `pnpm --filter @fluxora/sdk publish --access public`
   against the npm registry, authenticated with the `NPM_TOKEN` secret.
3. **Publish Python** — builds the sdist and wheel from `sdk/python/` and
   uploads them with `pypa/gh-action-pypi-publish`, authenticated with the
   `PYPI_API_TOKEN` secret.

The publish jobs `needs: [verify]`, so a version mismatch blocks publication
entirely.

### Required secrets

| Secret | Purpose |
|--------|---------|
| `NPM_TOKEN` | npm automation token with publish access to `@fluxora/sdk` |
| `PYPI_API_TOKEN` | PyPI API token scoped to the `fluxora-sdk` project |

### Release runbook

1. Make sure `main` is green and the SDKs have been regenerated
   (`pnpm generate:sdk:ts && pnpm generate:sdk:python`).
2. Set `openapi.yaml` `info.version` to the release version and regenerate the
   SDKs so their version fields follow.
3. Confirm the local gate passes: `pnpm check:sdk`.
4. Commit and merge the regenerated SDKs.
5. Tag the merge commit with the matching version and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "Fluxora API vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. The `Publish SDKs` workflow verifies the version and publishes both SDKs.
7. Create a GitHub Release from the tag so consumers can find the changelog and
   source archives.

### Verification

The workflow's `verify` job is the release gate: it re-derives every SDK version
from the tagged commit and refuses to publish on any mismatch. After a release,
confirm both packages are visible at the expected versions:

- npm: <https://www.npmjs.com/package/@fluxora/sdk?activeTab=versions>
- PyPI: <https://pypi.org/project/fluxora-sdk/#history>

---

## Consuming the SDKs

**TypeScript**

```bash
npm install @fluxora/sdk
# or
pnpm add @fluxora/sdk
```

**Python**

```bash
pip install fluxora-sdk
```

Both packages are versioned in lockstep with the API. Pin the SDK version that
matches the API version you target, and see
[API Versioning](./api/versioning.md) for how request version negotiation works.
