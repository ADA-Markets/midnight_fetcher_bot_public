import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { receiptsLogger } from '@/lib/storage/receipts-logger';

interface DerivedAddressEntry {
  index: number;
  bech32: string;
  publicKeyHex: string;
  registered?: boolean;
}

const SECURE_DIR = path.join(process.cwd(), 'secure');
const DERIVED_ADDRESSES_FILE = path.join(SECURE_DIR, 'derived-addresses.json');

export async function GET() {
  try {
    if (!fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      return NextResponse.json({ success: false, error: 'No wallet addresses found' }, { status: 404 });
    }

    const addrs: DerivedAddressEntry[] = JSON.parse(fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8'));

    const receipts = receiptsLogger.readReceipts();
    const userSolutionsPerAddress = new Map<string, number>();
    for (const r of receipts) {
      if (r && r.address && !r.isDevFee) {
        userSolutionsPerAddress.set(r.address, (userSolutionsPerAddress.get(r.address) || 0) + 1);
      }
    }

    const addresses = addrs.map(a => ({
      index: a.index,
      address: a.bech32,
      publicKeyHex: a.publicKeyHex,
      registered: !!a.registered,
      totalUserSolutions: userSolutionsPerAddress.get(a.bech32) || 0,
    }));

    const donors = addresses.filter(a => a.totalUserSolutions > 0);
    const suggestedRecipient = donors.length > 0
      ? donors.reduce((max, cur) => cur.totalUserSolutions > max.totalUserSolutions ? cur : max, donors[0])
      : null;

    return NextResponse.json({ success: true, addresses, donors, suggestedRecipient });
  } catch (error: any) {
    console.error('[API] addresses error:', error?.message || error);
    return NextResponse.json({ success: false, error: error?.message || 'Internal error' }, { status: 500 });
  }
}
