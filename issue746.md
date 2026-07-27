Description
Add a concurrency test in tests/ws/ws.concurrency.test.ts that subscribes several clients to a stream, begins a StreamHub.broadcast() call, and forcibly terminates one client's socket while fan-out to the remaining clients is still in progress, asserting the broadcast promise resolves cleanly, no exception escapes src/ws/hub.ts, and remaining clients still receive the event.

Requirements and context
Must assert BackpressureMetrics counters in src/ws/hub.ts are updated consistently (no double-count, no undercount) when a client disappears mid-fan-out.
Must cover both abrupt socket termination and a clean ws.close() occurring during the same tick as the broadcast loop.
Must be secure, tested, and documented
Should be efficient and easy to review
Suggested execution
Fork the repo and create a branch

git checkout -b feature/ws-mid-broadcast-disconnect-test
Implement changes

Update/Write: tests/ws/ws.concurrency.test.ts
Update/Write: src/ws/hub.ts
Write comprehensive tests: tests/ws/ws.concurrency.test.ts
Add documentation: docs/websocket.md
Include NatSpec / doc-comment style
Validate security assumptions
Test and commit
Run tests: pnpm test
Cover edge cases
Include test output and security notes
Example commit message

test: verify StreamHub.broadcast tolerates mid-fan-out client disconnects
Guidelines
Minimum 95 percent test coverage
Clear documentation
