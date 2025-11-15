import { NextRequest, NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { WalletManager } from '@/lib/wallet/manager';
import * as fs from 'fs';
import * as path from 'path';

export async function GET(request: NextRequest) {
  try {
    // Check if we should include all registered addresses or just those with receipts
    const { searchParams } = new URL(request.url);
    const includeAll = searchParams.get('includeAll') === 'true';

    // Get all receipts first to build address list
    const receipts = receiptsLogger.readReceipts();

    // Count solutions per address and collect addresses from receipts (excluding dev fee)
    const solutionsByAddress = new Map<string, number>();
    const addressesByIndex = new Map<number, { bech32: string; solutions: number }>();

    receipts.forEach(receipt => {
      if (!receipt.isDevFee && receipt.addressIndex !== undefined) {
        const count = solutionsByAddress.get(receipt.address) || 0;
        solutionsByAddress.set(receipt.address, count + 1);

        // Track address info by index
        addressesByIndex.set(receipt.addressIndex, {
          bech32: receipt.address,
          solutions: count + 1
        });
      }
    });

    // Try to get additional data from orchestrator if mining is running
    const addressData = miningOrchestrator.getAddressesData();
    const currentChallengeId = addressData?.currentChallengeId || null;

    let enrichedAddresses;

    if (includeAll) {
      // If includeAll=true, load ALL addresses from wallet (not just from orchestrator)
      // This ensures we get all 200 addresses even if mining is stopped or storage folder was deleted

      // Determine wallet path (same logic as WalletManager)
      const oldWalletPath = path.join(process.cwd(), 'secure', '.wallet');
      const newWalletDir = path.join(
        process.env.USERPROFILE || process.env.HOME || process.cwd(),
        'Documents',
        'MidnightFetcherBot',
        'secure'
      );
      const newWalletPath = path.join(newWalletDir, '.wallet');

      let walletPath: string;
      if (fs.existsSync(oldWalletPath)) {
        walletPath = oldWalletPath;
      } else {
        walletPath = newWalletPath;
      }

      if (fs.existsSync(walletPath)) {
        try {
          const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
          const walletAddresses = walletData.addresses || [];

          // Build enriched addresses from ALL wallet addresses
          enrichedAddresses = walletAddresses.map((addr: any) => {
            const hasSolutions = (solutionsByAddress.get(addr.bech32) || 0) > 0;

            // Check orchestrator data if available
            let solvedCurrentChallenge = false;
            if (addressData) {
              const orchestratorAddr = addressData.addresses.find((a: any) => a.index === addr.index);
              if (orchestratorAddr) {
                solvedCurrentChallenge = currentChallengeId
                  ? addressData.solvedAddressChallenges.get(addr.bech32)?.has(currentChallengeId) || false
                  : false;
              }
            }

            return {
              index: addr.index,
              bech32: addr.bech32,
              registered: addr.registered || hasSolutions,
              solvedCurrentChallenge,
              totalSolutions: solutionsByAddress.get(addr.bech32) || 0,
            };
          }).sort((a: any, b: any) => a.index - b.index);
        } catch (err) {
          console.error('[API] Failed to read wallet file, falling back to orchestrator data:', err);
          // Fallback to orchestrator data if wallet read fails
          if (addressData) {
            enrichedAddresses = addressData.addresses.map((addr: any) => {
              const hasSolutions = (solutionsByAddress.get(addr.bech32) || 0) > 0;
              const solvedCurrentChallenge = currentChallengeId
                ? addressData.solvedAddressChallenges.get(addr.bech32)?.has(currentChallengeId) || false
                : false;

              return {
                index: addr.index,
                bech32: addr.bech32,
                registered: addr.registered || hasSolutions,
                solvedCurrentChallenge,
                totalSolutions: solutionsByAddress.get(addr.bech32) || 0,
              };
            }).sort((a: any, b: any) => a.index - b.index);
          } else {
            // No wallet file and no orchestrator data - use receipts only
            enrichedAddresses = [];
          }
        }
      } else if (addressData) {
        // No wallet file found, fallback to orchestrator
        enrichedAddresses = addressData.addresses.map((addr: any) => {
          const hasSolutions = (solutionsByAddress.get(addr.bech32) || 0) > 0;
          const solvedCurrentChallenge = currentChallengeId
            ? addressData.solvedAddressChallenges.get(addr.bech32)?.has(currentChallengeId) || false
            : false;

          return {
            index: addr.index,
            bech32: addr.bech32,
            registered: addr.registered || hasSolutions,
            solvedCurrentChallenge,
            totalSolutions: solutionsByAddress.get(addr.bech32) || 0,
          };
        }).sort((a: any, b: any) => a.index - b.index);
      } else {
        // No wallet file and no orchestrator data - return empty
        enrichedAddresses = [];
      }
    } else {
      // Build address list from receipts only
      enrichedAddresses = Array.from(addressesByIndex.entries())
      .map(([index, data]) => {
        // IMPORTANT: If an address has submitted solutions, it MUST be registered
        // We can't submit solutions without being registered first
        const hasSolutions = (solutionsByAddress.get(data.bech32) || 0) > 0;

        // Check if we have orchestrator data for additional info
        let registered = hasSolutions; // Default to true if address has solutions
        let solvedCurrentChallenge = false;

        if (addressData) {
          const orchestratorAddr = addressData.addresses.find((a: any) => a.index === index);
          if (orchestratorAddr) {
            // If orchestrator says registered, trust it; if not but we have solutions, we know it's registered
            registered = orchestratorAddr.registered || hasSolutions;
            solvedCurrentChallenge = currentChallengeId
              ? addressData.solvedAddressChallenges.get(data.bech32)?.has(currentChallengeId) || false
              : false;
          }
        }

        return {
          index,
          bech32: data.bech32,
          registered,
          solvedCurrentChallenge,
          totalSolutions: solutionsByAddress.get(data.bech32) || 0,
        };
      })
      .sort((a, b) => a.index - b.index); // Sort by index
    }

    // Calculate summary stats
    const summary = {
      totalAddresses: enrichedAddresses.length,
      registeredAddresses: enrichedAddresses.filter((a: any) => a.registered).length,
      solvedCurrentChallenge: enrichedAddresses.filter((a: any) => a.solvedCurrentChallenge).length,
    };

    return NextResponse.json({
      success: true,
      currentChallenge: currentChallengeId,
      addresses: enrichedAddresses,
      summary,
    });
  } catch (error: any) {
    console.error('[API] Addresses error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch address data' },
      { status: 500 }
    );
  }
}
