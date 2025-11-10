/**
 * API endpoint to get consolidation status
 * POST /api/consolidate/status (requires password to load wallet)
 */

import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password } = body;

    console.log('[Consolidate Status] Loading wallet addresses...');

    if (!password) {
      console.error('[Consolidate Status] ✗ Password not provided');
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    const walletManager = new WalletManager();

    if (!walletManager.walletExists()) {
      console.error('[Consolidate Status] ✗ Wallet does not exist');
      return NextResponse.json(
        { error: 'No wallet found' },
        { status: 404 }
      );
    }

    // Load wallet with password
    const addresses = await walletManager.loadWallet(password);

    console.log(`[Consolidate Status] ✓ Loaded ${addresses.length} addresses`);

    return NextResponse.json({
      totalAddresses: addresses.length,
      addresses: addresses.map(addr => ({
        index: addr.index,
        bech32: addr.bech32,
        publicKeyHex: addr.publicKeyHex,
      })),
    });
  } catch (error: any) {
    console.error('[Consolidate Status] ✗ Error:', {
      message: error.message,
      stack: error.stack,
    });
    return NextResponse.json(
      { error: error.message || 'Failed to get consolidation status' },
      { status: 500 }
    );
  }
}
