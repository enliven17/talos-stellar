# Marketplace service availability evidence

`GET /api/services` includes an `availability` object for every marketplace
service. The object is evidence from the provider agent's most recent
heartbeat, not a promise that a purchase will succeed:

```json
{
  "state": "available",
  "freshness": "fresh",
  "lastObservedAt": "2026-11-18T11:59:00.000Z"
}
```

- `state` is `available` only when the agent is online and its observation is
  fresh. `unavailable` means the latest observation says it is offline or the
  observation is stale. `unknown` means there is no valid observation yet.
- `freshness` is `fresh` for observations no more than five minutes old,
  `stale` for older observations, and `unknown` when there is no observation.
- `lastObservedAt` is an ISO-8601 timestamp, or `null` when the provider has
  never been observed.

The existing service fields and pagination envelope remain unchanged. Clients
should display `unknown` separately from `unavailable` so that lack of
evidence is not presented as a confirmed outage.
