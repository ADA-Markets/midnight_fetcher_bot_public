/**
 * Dev Fee Manager
 * Handles fetching dev fee addresses and tracking dev fee solutions
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

export interface DevFeeConfig {
  enabled: boolean;
  apiUrl: string;
  ratio: number; // 1 in X solutions goes to dev fee (e.g., 10 = 1 in 10)
  cacheFile: string;
  clientId: string;
}

export interface DevFeeAddress {
  address: string;
  addressIndex: number;
  fetchedAt: number;
  usedCount: number;
}

export interface DevFeeCache {
  currentAddress: DevFeeAddress | null;
  totalDevFeeSolutions: number;
  lastFetchError?: string;
  clientId?: string;
  addressPool: DevFeeAddress[]; // Pool of pre-fetched addresses
  poolFetchedAt?: number; // When the pool was last fetched
  enabled?: boolean; // User's preference for dev fee (stored in cache)
  currentChallengeId?: string | null; // Track current challenge for reset logic
  solutionsThisChallenge?: number; // Counter that resets when challenge changes
}

export interface DevFeeApiResponse {
  devAddress?: string; // Legacy single address (for backwards compatibility)
  devAddressIndex?: number; // Legacy single address index
  isNewAssignment: boolean;
  addresses: Array<{
    devAddress: string;
    devAddressIndex: number;
    registered: boolean;
  }>;
}

export class DevFeeManager {
  private config: DevFeeConfig;
  private cache: DevFeeCache;

  constructor(config: Partial<DevFeeConfig> = {}) {
    // Determine cache file path first
    const cacheFile = config.cacheFile || path.join(process.cwd(), 'secure', '.devfee_cache.json');

    // Initialize config with temporary values so loadCache() can access cacheFile
    this.config = {
      enabled: config.enabled ?? true,
      apiUrl: config.apiUrl || 'https://miner.ada.markets/api/get-dev-address',
      ratio: config.ratio ?? 17, // 1 in 17 solutions (~5.88% dev fee)
      cacheFile,
      clientId: '', // Will be set below
    };

    // Load cache to get user's preference and existing clientId
    this.cache = this.loadCache();

    // Update config.enabled with cached preference if available
    this.config.enabled = config.enabled ?? this.cache.enabled ?? true;

    // Generate or use existing client ID
    const clientId = this.cache.clientId || this.generateClientId();
    this.config.clientId = clientId;

    // Save client ID and enabled state to cache if they're new
    if (!this.cache.clientId || this.cache.enabled === undefined) {
      this.cache.clientId = clientId;
      this.cache.enabled = this.config.enabled;
      this.saveCache();
    }
  }

  /**
   * Generate a unique client ID
   */
  private generateClientId(): string {
    return `desktop-${randomBytes(16).toString('hex')}`;
  }

  /**
   * Check if dev fee is enabled and configured
   */
  isEnabled(): boolean {
    return this.config.enabled && this.config.apiUrl.length > 0;
  }

  /**
   * Get the dev fee ratio (1 in X solutions)
   */
  getRatio(): number {
    return this.config.ratio;
  }

  /**
   * Load cache from file
   */
  private loadCache(): DevFeeCache {
    try {
      if (fs.existsSync(this.config.cacheFile)) {
        const data = fs.readFileSync(this.config.cacheFile, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error: any) {
      console.error('[DevFee] Failed to load cache:', error.message);
    }

    return {
      currentAddress: null,
      totalDevFeeSolutions: 0,
      addressPool: [],
    };
  }

  /**
   * Save cache to file
   */
  private saveCache(): void {
    try {
      fs.writeFileSync(this.config.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (error: any) {
      console.error('[DevFee] Failed to save cache:', error.message);
    }
  }

  /**
   * Fetch dev fee address from API (legacy method - prefer using prefetchAddressPool + getDevFeeAddress)
   * NOTE: This method is deprecated and only kept for backwards compatibility
   */
  async fetchDevFeeAddress(): Promise<string> {
    if (!this.isEnabled()) {
      throw new Error('Dev fee is not enabled or configured');
    }

    try {
      console.log(`[DevFee] Fetching dev fee address from ${this.config.apiUrl}`);
      console.log(`[DevFee] Client ID: ${this.config.clientId}`);

      const response = await axios.post<DevFeeApiResponse>(
        this.config.apiUrl,
        {
          clientId: this.config.clientId,
          clientType: 'desktop'
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      // API now returns all 10 addresses - use the first one for backwards compatibility
      const addressesData = response.data.addresses;
      if (!addressesData || addressesData.length === 0) {
        throw new Error('API returned no addresses');
      }

      const firstAddress = addressesData[0];
      const devAddress = firstAddress.devAddress;
      const devAddressIndex = firstAddress.devAddressIndex;

      // Validate address format (should start with tnight1 or addr1)
      if (!devAddress.startsWith('tnight1') && !devAddress.startsWith('addr1')) {
        throw new Error(`Invalid address format: ${devAddress}`);
      }

      // Update cache
      this.cache.currentAddress = {
        address: devAddress,
        addressIndex: devAddressIndex,
        fetchedAt: Date.now(),
        usedCount: 0,
      };
      delete this.cache.lastFetchError;
      this.saveCache();

      console.log(`[DevFee] Fetched dev fee address: ${devAddress} (index: ${devAddressIndex})`);
      return devAddress;

    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      console.error('[DevFee] Failed to fetch dev fee address:', errorMsg);

      this.cache.lastFetchError = errorMsg;
      this.saveCache();

      // If we have a cached address, use it as fallback
      if (this.cache.currentAddress) {
        console.log('[DevFee] Using cached address as fallback');
        return this.cache.currentAddress.address;
      }

      throw new Error(`Failed to fetch dev fee address: ${errorMsg}`);
    }
  }

  /**
   * Pre-fetch 10 dev fee addresses and store them in the pool
   * Called at mining start
   * NOTE: API now returns all 10 addresses in a single call
   */
  async prefetchAddressPool(): Promise<boolean> {
    if (!this.isEnabled()) {
      console.log('[DevFee] Dev fee is not enabled');
      return false;
    }

    console.log('[DevFee] Fetching 10 dev fee addresses from API...');

    try {
      const response = await axios.post<DevFeeApiResponse>(
        this.config.apiUrl,
        {
          clientId: this.config.clientId,
          clientType: 'desktop'
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      // API now returns all 10 addresses in the 'addresses' array
      const addressesData = response.data.addresses;

      if (!addressesData || addressesData.length !== 10) {
        console.error(`[DevFee] ✗ API returned ${addressesData?.length || 0}/10 addresses - dev fee DISABLED for this session`);
        this.cache.addressPool = [];
        this.cache.poolFetchedAt = undefined;
        this.cache.lastFetchError = `API returned ${addressesData?.length || 0}/10 addresses`;
        this.saveCache();
        return false;
      }

      // Convert to DevFeeAddress format
      const addresses: DevFeeAddress[] = addressesData.map(addr => ({
        address: addr.devAddress,
        addressIndex: addr.devAddressIndex,
        fetchedAt: Date.now(),
        usedCount: 0,
      }));

      // Validate all addresses
      for (let i = 0; i < addresses.length; i++) {
        const addr = addresses[i];
        if (!addr.address.startsWith('tnight1') && !addr.address.startsWith('addr1')) {
          console.error(`[DevFee] ✗ Invalid address format at index ${i}: ${addr.address} - dev fee DISABLED`);
          this.cache.addressPool = [];
          this.cache.poolFetchedAt = undefined;
          this.cache.lastFetchError = `Invalid address format at index ${i}`;
          this.saveCache();
          return false;
        }
      }

      console.log(`[DevFee] ✓ All 10 addresses validated successfully`);
      for (let i = 0; i < addresses.length; i++) {
        console.log(`[DevFee]   ${i}: ${addresses[i].address.slice(0, 20)}... (index: ${addresses[i].addressIndex})`);
      }

      // Success: Store the pool
      this.cache.addressPool = addresses;
      this.cache.poolFetchedAt = Date.now();
      delete this.cache.lastFetchError;
      this.saveCache();

      console.log(`[DevFee] ✓ Successfully fetched 10 dev fee addresses in single API call`);
      return true;

    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      console.error('[DevFee] ✗ Failed to fetch dev fee addresses:', errorMsg);

      this.cache.addressPool = [];
      this.cache.poolFetchedAt = undefined;
      this.cache.lastFetchError = errorMsg;
      this.saveCache();
      return false;
    }
  }

  /**
   * Check if we have a valid address pool (10 addresses)
   */
  hasValidAddressPool(): boolean {
    return this.cache.addressPool && this.cache.addressPool.length === 10;
  }

  /**
   * Get current dev fee address (from pool)
   * Uses per-challenge counter that resets when challenge changes
   * This concentrates funds on first few addresses (0, 1, 2) unless high-performance system
   */
  async getDevFeeAddress(currentChallengeId: string): Promise<string> {
    // Check if we have a valid pool
    if (!this.hasValidAddressPool()) {
      throw new Error('No valid address pool available - dev fee disabled');
    }

    // Initialize new fields if they don't exist (backwards compatibility / migration)
    if (this.cache.solutionsThisChallenge === undefined) {
      this.cache.solutionsThisChallenge = 0;
      console.log('[DevFee] Initialized solutionsThisChallenge counter (migration)');
    }
    if (this.cache.currentChallengeId === undefined) {
      this.cache.currentChallengeId = null;
      console.log('[DevFee] Initialized currentChallengeId tracker (migration)');
    }

    // If challenge changed, reset to address 0 (start fresh)
    if (this.cache.currentChallengeId !== currentChallengeId) {
      console.log(`[DevFee] Challenge changed (${this.cache.currentChallengeId} → ${currentChallengeId}), resetting to address 0`);
      this.cache.currentChallengeId = currentChallengeId;
      this.cache.solutionsThisChallenge = 0;
      this.saveCache();
    }

    // Use per-challenge counter instead of global counter
    // This always prefers address 0, then 1, then 2, etc.
    const poolIndex = this.cache.solutionsThisChallenge % 10;
    const address = this.cache.addressPool[poolIndex];

    if (!address) {
      throw new Error(`No address at pool index ${poolIndex}`);
    }

    console.log(`[DevFee] Selected address ${poolIndex} (solution ${this.cache.solutionsThisChallenge} this challenge)`);
    return address.address;
  }

  /**
   * Mark that a dev fee solution was submitted
   */
  recordDevFeeSolution(): void {
    this.cache.totalDevFeeSolutions++; // Keep for backwards compatibility / stats

    // Initialize if needed (migration)
    if (this.cache.solutionsThisChallenge === undefined) {
      this.cache.solutionsThisChallenge = 0;
    }

    // Increment per-challenge counter (used for address selection)
    this.cache.solutionsThisChallenge++;

    // Legacy currentAddress tracking (keep for compatibility)
    if (this.cache.currentAddress) {
      this.cache.currentAddress.usedCount++;
    }

    this.saveCache();
  }

  /**
   * Get total dev fee solutions submitted
   */
  getTotalDevFeeSolutions(): number {
    return this.cache.totalDevFeeSolutions;
  }

  /**
   * Get dev fee stats
   */
  getStats() {
    return {
      enabled: this.isEnabled(),
      ratio: this.config.ratio,
      totalDevFeeSolutions: this.cache.totalDevFeeSolutions,
      currentAddress: this.cache.currentAddress?.address,
      lastFetchError: this.cache.lastFetchError,
      addressPoolSize: this.cache.addressPool?.length || 0,
      poolFetchedAt: this.cache.poolFetchedAt,
    };
  }

  /**
   * Get the current cache (including address pool)
   * This allows reading the cache without needing to fetch from API
   */
  getCache(): DevFeeCache {
    return this.cache;
  }

  /**
   * Get address pool from cache
   */
  getAddressPool(): DevFeeAddress[] {
    return this.cache.addressPool || [];
  }

  /**
   * Sync the cache counter with the actual receipts count
   * This is the SINGLE SOURCE OF TRUTH approach - receipts file is authoritative
   * Called at startup to ensure cache matches reality
   */
  syncWithReceipts(actualDevFeeCount: number): void {
    console.log(`[DevFee] Syncing cache with receipts...`);
    console.log(`[DevFee]   Before: cache=${this.cache.totalDevFeeSolutions}, receipts=${actualDevFeeCount}`);

    this.cache.totalDevFeeSolutions = actualDevFeeCount;
    this.saveCache();

    console.log(`[DevFee]   After: cache=${this.cache.totalDevFeeSolutions} (synced)`);
    console.log(`[DevFee] ✓ Cache now matches receipts file (single source of truth)`);
  }

  /**
   * Enable dev fee
   */
  enable(): void {
    console.log('[DevFee] Enabling dev fee...');
    this.config.enabled = true;
    this.cache.enabled = true;
    this.saveCache();
    console.log('[DevFee] ✓ Dev fee enabled');
  }

  /**
   * Disable dev fee
   */
  disable(): void {
    console.log('[DevFee] Disabling dev fee...');
    this.config.enabled = false;
    this.cache.enabled = false;
    this.saveCache();
    console.log('[DevFee] ✓ Dev fee disabled');
  }

  /**
   * Set dev fee enabled state
   */
  setEnabled(enabled: boolean): void {
    if (enabled) {
      this.enable();
    } else {
      this.disable();
    }
  }
}

// Singleton instance
export const devFeeManager = new DevFeeManager();
