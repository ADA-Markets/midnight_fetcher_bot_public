import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';
import { receiptsLogger } from '@/lib/storage/receipts-logger';

interface ConsolidateRequest {
  password: string;
  recipientAddress: string; // Destination address to receive NIGHT
  addressIndexes?: number[]; // Optional subset of donor indexes
  dryRun?: boolean; // If true, do not call remote API; just return signed data and curl commands
  maxRetries?: number; // Retries for 429/408
  initialBackoffSeconds?: number; // Initial backoff for retry-able errors
}

const API_BASE = 'https://scavenger.prod.gd.midnighttge.io';

function isValidAddr(addr: string): boolean {
  return typeof addr === 'string' && (addr.startsWith('addr1') || addr.startsWith('tnight1')) && addr.length > 20;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function postDonateTo(url: string, maxRetries: number, backoffSec: number) {
  let attempt = 0;
  let wait = Math.max(1, backoffSec);
  while (true) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const text = await res.text();
      // Try to parse JSON; fall back to text
      let data: any = null;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (res.ok) return { status: res.status, data };

      // Retry on 429 or 408
      if ((res.status === 429 || res.status === 408) && attempt <= maxRetries) {
        await sleep(wait * 1000);
        wait *= 2; // exponential backoff
        continue;
      }

      return { status: res.status, data };
    } catch (err: any) {
      if (attempt <= maxRetries) {
        await sleep(wait * 1000);
        wait *= 2;
        continue;
      }
      return { status: 0, data: { error: err?.message || 'Network error' } };
    }
  }
}

/**
 * POST /api/wallet/consolidate
 * Body: ConsolidateRequest
 * For each donor address (with >0 user solutions), signs the required message and calls donate_to.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ConsolidateRequest;
    const { password, recipientAddress } = body;
    const dryRun = body.dryRun === true;
    const maxRetries = Number.isInteger(body.maxRetries) ? Math.max(0, body.maxRetries!) : 3;
    const initialBackoffSeconds = Number.isFinite(body.initialBackoffSeconds) ? Math.max(1, body.initialBackoffSeconds!) : 20;

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing password' }, { status: 400 });
    }
    if (!isValidAddr(recipientAddress)) {
      return NextResponse.json({ success: false, error: 'Invalid recipientAddress' }, { status: 400 });
    }

    // Load wallet and addresses
    const wm = new WalletManager();
    const addresses = await wm.loadWallet(password);

    // Build user solution counts per address from receipts (exclude dev fee)
    const receipts = receiptsLogger.readReceipts();
    const userSolutionsPerAddress = new Map<string, number>();
    for (const r of receipts) {
      if (r && r.address && !r.isDevFee) {
        userSolutionsPerAddress.set(r.address, (userSolutionsPerAddress.get(r.address) || 0) + 1);
      }
    }

    // Determine donor indexes
    let donorIndexes: number[];
    if (Array.isArray(body.addressIndexes) && body.addressIndexes.length > 0) {
      donorIndexes = body.addressIndexes.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0);
    } else {
      donorIndexes = addresses.map((a) => a.index);
    }

    // Filter donors: must have >0 user solutions and not be the recipient address
    const donors = donorIndexes
      .map((i) => addresses.find((a) => a.index === i))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .filter((a) => a.bech32 !== recipientAddress)
      .filter((a) => (userSolutionsPerAddress.get(a.bech32) || 0) > 0);

    if (donors.length === 0) {
      return NextResponse.json({ success: false, error: 'No donor addresses with user solutions' }, { status: 400 });
    }

    const message = `Assign accumulated Scavenger rights to: ${recipientAddress}`;

    const results: Array<{
      index: number;
      donor: string;
      totalUserSolutions: number;
      signed: boolean;
      signature?: string;
      curl?: string;
      status?: number;
      response?: any;
    }> = [];

    for (const donor of donors) {
      try {
        const signature = await wm.signMessage(donor.index, message);
        const encodedSig = encodeURIComponent(signature);
        const url = `${API_BASE}/donate_to/${recipientAddress}/${donor.bech32}/${encodedSig}`;
        const curl = `curl -L -X POST "${url}" -d "{}"`;

        const entry: any = {
          index: donor.index,
          donor: donor.bech32,
          totalUserSolutions: userSolutionsPerAddress.get(donor.bech32) || 0,
          signed: true,
          signature,
          curl,
        };

        if (!dryRun) {
          const res = await postDonateTo(url, maxRetries, initialBackoffSeconds);
          entry.status = res.status;
          entry.response = res.data;
        }

        results.push(entry);
      } catch (err: any) {
        results.push({
          index: donor.index,
          donor: donor.bech32,
          totalUserSolutions: userSolutionsPerAddress.get(donor.bech32) || 0,
          signed: false,
          signature: undefined,
          status: 0,
          response: { error: err?.message || 'Signing failed' },
        });
      }
    }

    return NextResponse.json({
      success: true,
      dryRun,
      message,
      recipientAddress,
      donors: results.length,
      results,
      note: dryRun
        ? 'Dry run only: use the provided curl commands to submit manually.'
        : 'Completed. Check per-donor status/response for success or errors.',
    });
  } catch (error: any) {
    console.error('[API] consolidate error:', error?.message || error);
    return NextResponse.json({ success: false, error: error?.message || 'Internal error' }, { status: 500 });
  }
}
