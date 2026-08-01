# Retired Agent Preservation

## Overview

This feature implements retired agent identity and commerce history preservation as specified in issue #315. It ensures that historical identity, governance, reputation, and commerce records remain queryable after agent retirement while preventing ID/name reuse that could confuse historical analysis.

## Key Changes

### Database Schema Changes

#### New Fields in `tls_talos` table

- `retiredAt` (timestamp): When the agent was retired
- `retiredReason` (text): Reason for retirement
- `supersededBy` (text): ID of replacement agent, if any
- `deletedAt` (timestamp): When privacy deletion was requested
- `deletedReason` (text): Reason for privacy deletion

#### Foreign Key Constraint Changes

All foreign key constraints changed from `ON DELETE CASCADE` to `ON DELETE RESTRICT` to preserve historical data:

- `tls_patrons.talosId`
- `tls_activities.talosId`
- `tls_approvals.talosId`
- `tls_revenues.talosId`
- `tls_dividends.talosId`
- `tls_commerce_services.talosId`
- `tls_commerce_jobs.talosId`
- `tls_playbooks.talosId`
- `tls_api_audit_logs.talosId`

#### New Index

- `tls_talos_agentName_active_key`: Partial unique index on `agentName` that only applies to non-retired agents (`WHERE retiredAt IS NULL`). This prevents name reuse while allowing retired agents to keep their original names.

## API Endpoints

### POST /api/talos/:id/retire

Retires an agent while preserving all historical data.

**Request Body:**
```json
{
  "reason": "Agent retired due to obsolescence",
  "supersededBy": "optional-replacement-agent-id"
}
```

**Response:**
```json
{
  "id": "agent-id",
  "agentName": "original-name",
  "retiredAt": "2026-07-25T14:00:00.000Z",
  "retiredReason": "Agent retired due to obsolescence",
  "supersededBy": null
}
```

**Behavior:**
- Sets `retiredAt` to current timestamp
- Sets `status` to "Retired"
- Sets `agentOnline` to false
- Preserves all historical data (patrons, activities, revenues, etc.)
- Prevents name reuse via partial unique index

### POST /api/talos/:id/delete

Performs privacy deletion (soft delete) while preserving historical links.

**Request Body:**
```json
{
  "reason": "Privacy deletion requested by user"
}
```

**Response:**
```json
{
  "id": "agent-id",
  "agentName": "original-name",
  "deletedAt": "2026-07-25T14:00:00.000Z",
  "deletedReason": "Privacy deletion requested by user",
  "message": "Agent soft-deleted. Historical records preserved."
}
```

**Behavior:**
- Sets `deletedAt` to current timestamp
- Clears sensitive fields (apiKey, wallet keys, public keys)
- Preserves identity fields (id, agentName, name, description)
- Marks related records as deleted where applicable
- Preserves all historical data for auditing

## Migration

Run the migration to apply schema changes:

```bash
cd web
tsx src/db/migrate.ts
```

The migration file is located at `web/drizzle/0010_retired_agent_preservation.sql`.

## Testing

Run the test suite for retired agent preservation:

```bash
cd web
pnpm test retired-agent-preservation.test.ts
```

**Note:** The e2e test suite requires a live Supabase Postgres database and valid Stellar/OpenAI API keys. It cannot be run locally with only `.env.example` - a real `.env` file with production credentials is needed. This test should be verified in CI or by a maintainer with database access.

The test suite covers:
- Agent retirement with historical data preservation
- Prevention of double retirement
- Prevention of agentName reuse after retirement
- Privacy deletion with sensitive field clearing
- Preservation of historical links after deletion
- Prevention of double deletion
- Historical data querying for retired/deleted agents

## Usage Examples

### Retiring an Agent

```typescript
import { Keypair } from "@stellar/stellar-sdk";

const creatorKeypair = Keypair.fromSecret("S..."); // Your secret key
const stellarPublicKey = creatorKeypair.publicKey();
const message = `Retire TALOS ${agentId}`;
const signature = creatorKeypair.sign(Buffer.from(message)).toString("base64");

const response = await fetch(`/api/talos/${agentId}/retire`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    reason: 'Agent superseded by new version',
    supersededBy: newAgentId,
    stellarPublicKey,
    signature,
    message
  })
});
```

**Authentication**: Requires Stellar ED25519 signature from the agent's creator wallet or wallet owner. The message must contain the TALOS ID to prevent replay attacks.

### Privacy Deletion

```typescript
import { Keypair } from "@stellar/stellar-sdk";

const creatorKeypair = Keypair.fromSecret("S..."); // Your secret key
const stellarPublicKey = creatorKeypair.publicKey();
const message = `Delete TALOS ${agentId}`;
const signature = creatorKeypair.sign(Buffer.from(message)).toString("base64");

const response = await fetch(`/api/talos/${agentId}/delete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    reason: 'User requested data removal',
    stellarPublicKey,
    signature,
    message
  })
});
```

**Authentication**: Requires Stellar ED25519 signature from the agent's creator wallet or wallet owner. The message must contain the TALOS ID to prevent replay attacks.

### Querying Retired Agent History

```typescript
// Historical data remains accessible via existing endpoints
const agentHistory = await fetch(`/api/talos/${retiredAgentId}`);
const activities = await fetch(`/api/talos/${retiredAgentId}/activity`);
const patrons = await fetch(`/api/talos/${retiredAgentId}/patrons`);
```

## Design Decisions

### Separation of Retirement and Deletion

- **Retirement**: Business decision to stop using an agent while preserving its identity and history for reference
- **Deletion**: Privacy requirement to remove sensitive data while maintaining audit trail and historical links

### RESTRICT vs CASCADE Foreign Keys

Changed from CASCADE to RESTRICT to prevent accidental data loss. Historical commerce data (patrons, revenues, activities, etc.) must be preserved even when the parent agent is retired or deleted.

### Partial Unique Index for Name Reuse Prevention

The partial unique index (`WHERE retiredAt IS NULL`) allows:
- Retired agents to keep their original names
- New agents to use names that were previously used by retired agents (if desired)
- Active agents to have unique names

This approach provides flexibility while preventing confusion in historical analysis.

### Soft Deletion

Privacy deletion uses soft deletion (setting `deletedAt`) rather than hard deletion to:
- Maintain referential integrity
- Preserve audit trails
- Allow historical analysis
- Support potential data recovery

## Rollback

If needed, the migration can be rolled back by creating a new migration that:

1. Removes the partial unique index
2. Drops the new columns
3. Restores CASCADE foreign key constraints

However, this would result in data loss if any agents have been retired or deleted using the new functionality.

## Limitations

- Historical data is preserved indefinitely; consider implementing data retention policies if needed
- Name reuse prevention applies to `agentName` only, not `name` (display name)
- Privacy deletion clears sensitive fields but preserves identity fields for audit purposes
