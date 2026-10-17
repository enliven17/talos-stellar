# Telegram send queue

Opt-in, durable pacing for the Telegram adapter. Telegram allows a bot roughly
one message per second per chat and twenty per minute per group, and answers
excess traffic with HTTP 429 and a `retry_after` hint. With the queue enabled,
`post` and `reply` write to SQLite first and messages are released in FIFO
order at a paced rate.

## Enabling

```bash
TALOS_TELEGRAM_RATE_LIMIT_ENABLED=true
```

Disabled (the default) the adapter behaves exactly as before. The queue is
wired where the Telegram adapter is registered (the adapter-sandbox path), and
a `telegram_queue` worker task runs beside the other scheduler tasks.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TALOS_TELEGRAM_MIN_INTERVAL_SECONDS` | `1` | Minimum gap between sends to a chat |
| `TALOS_TELEGRAM_MAX_PER_MINUTE` | `20` | Sends per rolling 60 s per chat |
| `TALOS_TELEGRAM_QUEUE_MAX_SIZE` | `1000` | Unsent messages allowed (`pending` + `sending`) |
| `TALOS_TELEGRAM_QUEUE_MAX_ATTEMPTS` | `5` | Delivery attempts before a message fails |
| `TALOS_TELEGRAM_QUEUE_MAX_AGE_SECONDS` | `3600` | A pending message older than this is dropped as `expired` |
| `TALOS_TELEGRAM_QUEUE_DRAIN_INTERVAL_SECONDS` | `1` | Worker poll interval when idle |

## What callers see

`post()` and `reply()` keep their signatures and return a `PublishResult`:

| Situation | `status` | Notes |
| --- | --- | --- |
| Sent immediately | `posted` | Same `post_id` / `url` as before |
| Queued (pacing, backlog, or 429) | `pending` | `metadata.queue_id`, `metadata.retry_in_seconds` |
| Queue full | `failed` | `metadata.queue_full = true`; nothing is stored |
| Permanent Telegram rejection | `failed` | `error` is `Telegram send failed (http_400)`; never the response body |

Passing the same `operation_id` twice returns the original message instead of
sending again; reusing it with different content fails. Under the adapter
sandbox the sandbox's own operation ID plays this role, so its internal retries
of a `failed` result return the stored outcome and never send a second time.

## Behaviour by input

- **429**: the chat is blocked for `parameters.retry_after` (or the
  `Retry-After` header). A missing, non-numeric, zero or negative hint falls
  back to exponential backoff; values are capped at 24 h. A 429 does not use
  up an attempt; `MAX_AGE_SECONDS` bounds it instead.
- **5xx / connection refused**: retried with backoff until `MAX_ATTEMPTS`,
  then `failed` (`max_attempts`).
- **Other 4xx**: `failed` immediately (`http_<status>`).
- **Unknown outcome** (read timeout, unreadable 200 body, crash mid-send, or
  lease expiry): `indeterminate`. These are never re-sent automatically
  because `sendMessage` is not idempotent. Reconcile them by hand.
- **Ordering**: strict FIFO. A message in backoff holds the ones behind it.
- **Restart**: pending messages survive; interrupted sends become
  `indeterminate`.

## Privacy

Rows hold message text and the chat target only. The bot token, request URL
and Telegram error bodies are never stored, logged or returned; failures are
kept as short codes such as `rate_limited` or `http_400`.

## Operating

```sql
SELECT state, COUNT(*) FROM telegram_send_queue GROUP BY state;
SELECT id, attempt_count, last_error_code FROM telegram_send_queue
WHERE state = 'indeterminate';   -- needs a human decision
```

`TelegramSendQueue.stats()` returns the same counts, the age of the oldest
unsent message, and any active rate-limit block, without message content.

## Rollout and rollback

Migration 11 adds `telegram_send_queue` and `telegram_rate_state`. It only
creates tables, so rolling back means setting the flag to `false`; the tables
can stay. Messages still `pending` at that moment are not sent while the flag
is off.
