# Testing HTTP-backed communication adapters

`DiscordAdapter`, `TelegramAdapter`, and `MastodonAdapter` accept an optional
`http` argument implementing the public `AdapterHTTPClient` protocol. The
default remains `DirectHTTPClient`; production behavior is unchanged.

Tests should inject a local fake client that implements asynchronous `get` and
`post`, returns explicit `httpx.Response` fixtures (or raises a scripted
exception), and records calls. A fake must fail when its response script is
exhausted so an unexpected request cannot silently reach a real service.
Cancellation should be exercised by blocking a scripted retry wait or request
on an `asyncio.Event`, then cancelling the task and checking that no subsequent
request is made.

The fake is test-only and does not add a runtime setting or a route to external
services. For an example contract and coverage of publishing, retries, retry
exhaustion, and cancellation, see
`tests/test_communication_adapter_transport.py`.
