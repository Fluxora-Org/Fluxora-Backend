#!/usr/bin/env bash
# Asserts the Fluxora Backend image satisfies issue #1508:
#   1. Runs as a non-root user
#   2. Filesystem is read-only except for declared writable paths
#   3. No secret is baked into any image layer
#
# Usage: scripts/assert-image-hardening.sh <image-ref>
set -euo pipefail

IMAGE="${1:?usage: $0 <image-ref>}"
FAIL=0

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAIL=1; }

# 1. Runtime user must not be root ----------------------------------------
log "Assert runtime user is non-root"

IMG_USER="$(docker inspect --format '{{.Config.User}}' "$IMAGE")"
echo "  Config.User = '${IMG_USER:-<empty>}'"
if [[ -z "${IMG_USER}" || "${IMG_USER}" == "root" || "${IMG_USER}" == "0" || "${IMG_USER}" == "0:0" ]]; then
  fail "image Config.User is root or unset"
else
  ok "image declares USER='${IMG_USER}'"
fi

RUN_UID="$(docker run --rm --entrypoint id "$IMAGE" -u 2>/dev/null || echo RUN_FAILED)"
echo "  runtime uid = ${RUN_UID}"
if [[ "$RUN_UID" == "0" ]]; then
  fail "container runtime uid is 0 (root)"
elif [[ "$RUN_UID" == "RUN_FAILED" ]]; then
  fail "could not run 'id -u' inside the image"
else
  ok "container runtime uid=${RUN_UID} (non-root)"
fi

# 2. Read-only filesystem is honoured -------------------------------------
log "Assert read-only filesystem support"

if docker run --rm --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,size=64m \
      --entrypoint sh "$IMAGE" \
      -c 'echo probe > /app/.ro-probe 2>/dev/null && exit 1 || exit 0'; then
  ok "write to /app rejected under --read-only"
else
  fail "/app is writable under --read-only"
fi

if docker run --rm --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,size=64m \
      --entrypoint sh "$IMAGE" \
      -c 'echo probe > /tmp/.rw-probe && rm /tmp/.rw-probe'; then
  ok "/tmp is writable when declared as tmpfs"
else
  fail "/tmp is not writable even when declared as tmpfs"
fi

# 3. No secrets baked into a layer ----------------------------------------
log "Assert no secrets in image layers"

FOUND_FILES="$(docker run --rm --entrypoint sh "$IMAGE" -c '
  find / -xdev \( \
      -name ".env" -o -name ".env.*" \
      -o -name "*.pem" -o -name "*.key" \
      -o -name "id_rsa" -o -name "id_ed25519" \
    \) -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null
')"
if [[ -n "$FOUND_FILES" ]]; then
  fail "secret-looking files present in image:"; echo "$FOUND_FILES" | sed 's/^/      /'
else
  ok "no .env/*.pem/*.key files present in image"
fi

HIST="$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE")"
if echo "$HIST" | grep -Eiq \
    '(api[_-]?key|secret|password|passwd|token|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^ $]{6,}'; then
  fail "layer history contains a value assigned to a secret-like key:"
  echo "$HIST" | grep -Ei \
    '(api[_-]?key|secret|password|passwd|token|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^ $]{6,}' \
    | sed 's/^/      /'
else
  ok "no secret-looking assignments found in layer history"
fi

IMG_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE")"
if echo "$IMG_ENV" | grep -Eiq \
    '^(API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE[_-]?KEY|JWT[_-]?SECRET)='; then
  fail "final image Config.Env contains secret-like variables:"
  echo "$IMG_ENV" | grep -Ei \
    '^(API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE[_-]?KEY|JWT[_-]?SECRET)=' \
    | sed 's/=.*/=<redacted>/' | sed 's/^/      /'
else
  ok "final image Config.Env has no secret-like variables"
fi

log "Result"
if [[ "$FAIL" -ne 0 ]]; then
  printf '  HARDENING ASSERTIONS FAILED\n'
  exit 1
fi
printf '  ALL HARDENING ASSERTIONS PASSED\n'
