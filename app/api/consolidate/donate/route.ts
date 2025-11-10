/**
 * API endpoint to consolidate rewards from one address to another
 * POST /api/consolidate/donate
 */

import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';
import axios from 'axios';

const API_BASE = 'https://scavenger.prod.gd.midnighttge.io';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password, sourceIndex, destinationIndex } = body;

    if (!password || sourceIndex === undefined || destinationIndex === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: password, sourceIndex, destinationIndex' },
        { status: 400 }
      );
    }

    const walletManager = new WalletManager();

    // Load wallet with password
    const addresses = await walletManager.loadWallet(password);

    const sourceAddr = addresses.find(a => a.index === sourceIndex);
    const destinationAddr = addresses.find(a => a.index === destinationIndex);

    if (!sourceAddr || !destinationAddr) {
      return NextResponse.json(
        { error: 'Invalid source or destination address index' },
        { status: 400 }
      );
    }

    // Skip if source and destination are the same
    if (sourceIndex === destinationIndex) {
      return NextResponse.json(
        { error: 'Source and destination cannot be the same' },
        { status: 400 }
      );
    }

    // Create donation signature
    const signature = await walletManager.makeDonationSignature(
      sourceIndex,
      sourceAddr.bech32,
      destinationAddr.bech32
    );

    // POST /donate_to/{destination}/{source}/{signature}
    const url = `${API_BASE}/donate_to/${destinationAddr.bech32}/${sourceAddr.bech32}/${signature}`;

    console.log('[Consolidate API] Making donation request:', {
      url,
      sourceIndex,
      destinationIndex,
      sourceAddress: sourceAddr.bech32,
      destinationAddress: destinationAddr.bech32,
    });

    try {
      const response = await axios.post(url, {}, {
        timeout: 30000,
        validateStatus: (status) => status < 500,
      });

      console.log('[Consolidate API] Server response:', {
        status: response.status,
        statusText: response.statusText,
        data: response.data,
      });

      if (response.status >= 200 && response.status < 300) {
        console.log('[Consolidate API] ✓ Success:', response.data);
        return NextResponse.json({
          success: true,
          message: response.data.message || 'Rewards consolidated successfully',
          solutionsConsolidated: response.data.solutions_consolidated || 0,
          sourceAddress: sourceAddr.bech32,
          destinationAddress: destinationAddr.bech32,
        });
      } else {
        console.error('[Consolidate API] ✗ Server rejected consolidation:', {
          status: response.status,
          statusText: response.statusText,
          responseData: response.data,
          message: response.data.message,
          fullResponse: JSON.stringify(response.data, null, 2),
        });

        return NextResponse.json(
          {
            success: false,
            error: response.data.message || 'Server rejected consolidation request',
            status: response.status,
            details: response.data, // Include full response for debugging
          },
          { status: response.status }
        );
      }
    } catch (axiosError: any) {
      const errorMsg = axiosError.response?.data?.message || axiosError.message;
      const statusCode = axiosError.response?.status || 500;

      console.error('[Consolidate API] ✗ Request failed:', {
        error: axiosError.message,
        status: statusCode,
        responseData: axiosError.response?.data,
        responseText: axiosError.response?.statusText,
        fullError: JSON.stringify({
          message: axiosError.message,
          code: axiosError.code,
          response: axiosError.response?.data,
        }, null, 2),
      });

      return NextResponse.json(
        {
          success: false,
          error: errorMsg,
          status: statusCode,
          details: axiosError.response?.data, // Include full response for debugging
        },
        { status: statusCode }
      );
    }
  } catch (error: any) {
    console.error('[API] Consolidate donate error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to consolidate rewards' },
      { status: 500 }
    );
  }
}
