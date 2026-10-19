import { describe, it, expect, vi } from 'vitest';
import { applyGovernanceEffects } from '@/lib/governance/effects';

describe('governance effects', () => {
  const mkTx = () => ({
    query: vi.fn().mockResolved({ id: 'row-1' }),
    execute: vi.fn().mockResolved(undefined),
    rollback: vi.fn().mockResolved(undefined),
  });

  it('applies a grant_role effect', async () => {
    const tx = mkTx();
    await applyGovernanceEffects(tx as any, {
      effects: [{ type: 'grant_role', payload: { userId: 'u1', role: 'admin' } }],
    } as any);
    expect(tx.query).toHaveBeenCalled();
  });

  it('applies a revoke_role effect', async () => {
    const tx = mkTx();
    await applyGovernanceEffects(tx as any, {
      effects: [{ type: 'revoke_role', payload: { userId: 'u1', role: 'admin' } }],
    } as any);
    expect(tx.query).toHaveBeenCalled();
  });

  it('applies a status_update effect', async () => {
    const tx = mkTx();
    await applyGovernanceEffects(tx as any, {
      effects: [{ type: 'status_update', payload: { status: 'active' } }],
    } as any);
    expect(tx.query).toHaveBeenCalled();
  });

  it('applies a provision effect', async () => {
    const tx = mkTx();
    await applyGovernanceEffects(tx as any, {
      effects: [{ type: 'provision', payload: { resourceId: 'r1' } }],
    } as any);
    expect(tx.query).toHaveBeenCalled();
  });

  it('is idempotent on re-application', async () => {
    const tx = mkTx();
    const proposal = { effects: [{ type: 'grant_role', payload: { userId: 'u1', role: 'admin' } }] } as any;
    await applyGovernanceEffects(tx as any, proposal);
    await applyGovernanceEffects(tx as any, proposal);
    expect(tx.execute).toHaveBeenCalled();
  });

  it('rolls back on failure', async () => {
    const tx = mkTx();
    tx.query.mockRejected(new Error('boom'));
    await expect(
        applyGovernanceEffects(tx as any, {
          effects: [{ type: 'grant_role', payload: { userId: 'u1', role: 'admin' } }],
        } as any),
      ).rejects();
    expect(tx.rollback).toHaveBeenCalled();
  });
});
