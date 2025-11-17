import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';
import { receiptsLogger } from '@/lib/storage/receipts-logger';

/**
 * POST /api/wallet/consolidation-proofs
 * Secure local endpoint to generate signed ownership proofs for derived addresses.
 *
 * Body:
 *  {
 *    password: string,               // wallet password (used locally to decrypt seed)
 *    challenge?: string,             // exact challenge text provided by the portal (preferred)
 *    targetAddress?: string,         // optional: if provided and no challenge, we generate a default challenge including this
 *    addressIndexes?: number[],      // optional subset of indexes; defaults to all derived addresses
 *    includePublicKey?: boolean      // optional: include publicKeyHex in response (default true)
 *  }
 *
 * Returns:
 *  {
 *    success: boolean,
 *    challenge: string,
 *    count: number,
 *    proofs: Array<{ index: number, address: string, signature: string, publicKeyHex?: string }>,
 *    note?: string
 *  }
 *
 * SECURITY NOTES:
 * - This runs locally and never stores the password.
 * - Do NOT expose this endpoint to the internet. Use on localhost only.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const password: unknown = body?.password;
    const userChallenge: unknown = body?.challenge;
    const targetAddress: unknown = body?.targetAddress;
  const addressIndexes: unknown = body?.addressIndexes;
    const includePublicKey: boolean = body?.includePublicKey !== false; // default true

    if (typeof password !== 'string' || password.length === 0) {
      return NextResponse.json({ success: false, error: 'Missing or invalid password' }, { status: 400 });
    }

    // Resolve challenge
    let challenge: string | null = null;
    if (typeof userChallenge === 'string' && userChallenge.trim().length > 0) {
      challenge = userChallenge.trim();
    } else if (typeof targetAddress === 'string' && targetAddress.trim().length > 0) {
      // Generate a conservative default challenge format (adjust on portal if they require a specific string)
      const ts = new Date().toISOString();
      challenge = `scavenger-consolidate|target=${targetAddress.trim()}|ts=${ts}`;
    }

    if (!challenge) {
      return NextResponse.json({ success: false, error: 'Provide challenge or targetAddress to build one' }, { status: 400 });
    }

  // Load wallet and derived addresses
    const wm = new WalletManager();
    const addresses = await wm.loadWallet(password);

    // Determine which indexes to sign for
    let indexes: number[];
    if (Array.isArray(addressIndexes) && addressIndexes.length > 0) {
      indexes = addressIndexes.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0);
    } else {
      indexes = addresses.map((a) => a.index);
    }

    // Validate indexes exist
    const available = new Set(addresses.map((a) => a.index));
    const invalid = indexes.filter((i) => !available.has(i));
    if (invalid.length > 0) {
      return NextResponse.json({ success: false, error: `Invalid address indexes: ${invalid.join(', ')}` }, { status: 400 });
    }

    // Build user solution counts per address from receipts (exclude dev fee)
    const receipts = receiptsLogger.readReceipts();
    const userSolutionsPerAddress = new Map<string, number>();
    for (const r of receipts) {
      if (r && r.address && !r.isDevFee) {
        userSolutionsPerAddress.set(r.address, (userSolutionsPerAddress.get(r.address) || 0) + 1);
      }
    }

    // Always filter out addresses with Total Solutions: 0 (user solutions only)
    indexes = indexes.filter((i) => {
      const addr = addresses.find((a) => a.index === i)!;
      const userCount = userSolutionsPerAddress.get(addr.bech32) || 0;
      return userCount > 0;
    });

    if (indexes.length === 0) {
      return NextResponse.json({ success: false, error: 'No eligible addresses to sign (no addresses with user solutions)' }, { status: 400 });
    }

    // Produce proofs
    const proofs: Array<{ index: number; address: string; signature: string; totalUserSolutions: number; publicKeyHex?: string }> = [];
    for (const i of indexes) {
      const addr = addresses.find((a) => a.index === i)!;
      const signature = await wm.signMessage(i, challenge);
      const entry: { index: number; address: string; signature: string; totalUserSolutions: number; publicKeyHex?: string } = {
        index: i,
        address: addr.bech32,
        signature,
        totalUserSolutions: userSolutionsPerAddress.get(addr.bech32) || 0,
      };
      if (includePublicKey) {
        entry.publicKeyHex = addr.publicKeyHex;
      }
      proofs.push(entry);
    }

    return NextResponse.json({
      success: true,
      challenge,
      count: proofs.length,
      proofs,
      note: 'Submit these proofs to the consolidation portal. If the portal provides its own challenge string, re-run with that exact value.'
    });
  } catch (error: any) {
    console.error('[API] consolidation-proofs error:', error?.message || error);
    return NextResponse.json({ success: false, error: error?.message || 'Internal error' }, { status: 500 });
  }
}
