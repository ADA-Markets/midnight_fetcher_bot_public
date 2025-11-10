/**
 * Mining Orchestrator
 * Manages mining process, challenge polling, and worker coordination
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { ChallengeResponse, MiningStats, MiningEvent, Challenge, WorkerStats } from './types';
import { hashEngine } from '@/lib/hash/engine';
import { WalletManager, DerivedAddress } from '@/lib/wallet/manager';
import Logger from '@/lib/utils/logger';
import { matchesDifficulty, getDifficultyZeroBits } from './difficulty';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { generateNonce } from './nonce';
import { buildPreimage } from './preimage';
import { devFeeManager } from '@/lib/devfee/manager';
import * as os from 'os';

interface SolutionTimestamp {
  timestamp: number;
}

class MiningOrchestrator extends EventEmitter {
  private isRunning = false;
  private currentChallengeId: string | null = null;
  private apiBase: string = 'https://scavenger.prod.gd.midnighttge.io';
  private pollInterval = 2000; // 2 seconds - frequent polling to keep latest_submission fresh (it updates with every network solution)
  private pollTimer: NodeJS.Timeout | null = null;
  private walletManager: WalletManager | null = null;
  private isDevFeeMining = false; // Flag to prevent multiple simultaneous dev fee mining operations
  private addresses: DerivedAddress[] = [];
  private solutionsFound = 0;
  private startTime: number | null = null;
  private isMining = false;
  private currentChallenge: Challenge | null = null;
  private totalHashesComputed = 0;
  private lastHashRateUpdate = Date.now();
  private cpuUsage = 0;
  private lastCpuCheck: { idle: number; total: number } | null = null;
  private addressesProcessedCurrentChallenge = new Set<number>(); // Track which address indexes have processed current challenge
  private solutionTimestamps: SolutionTimestamp[] = []; // Track all solution timestamps for hourly/daily stats
  private workerThreads = 11; // Number of parallel mining threads
  private submittedSolutions = new Set<string>(); // Track submitted solution hashes to avoid duplicates
  private solvedAddressChallenges = new Map<string, Set<string>>(); // Map: address -> Set of solved challenge_ids
  private userSolutionsCount = 0; // Track non-dev-fee solutions for dev fee trigger
  private submittingAddresses = new Set<string>(); // Track addresses currently submitting solutions (address+challenge key)
  private pausedAddresses = new Set<string>(); // Track addresses that are paused while submission is in progress
  private workerStats = new Map<number, WorkerStats>(); // Track stats for each worker (workerId -> WorkerStats)
  private hourlyRestartTimer: NodeJS.Timeout | null = null; // Timer for hourly restart
  private stoppedWorkers = new Set<number>(); // Track workers that should stop immediately
  private currentMiningAddress: string | null = null; // Track which address we're currently mining
  private addressSubmissionFailures = new Map<string, number>(); // Track submission failures per address (address+challenge key)
  private customBatchSize: number | null = null; // Custom batch size override

  /**
   * Update orchestrator configuration dynamically
   */
  updateConfiguration(config: { workerThreads?: number; batchSize?: number }): void {
    if (config.workerThreads !== undefined) {
      console.log(`[Orchestrator] Updating workerThreads: ${this.workerThreads} -> ${config.workerThreads}`);
      this.workerThreads = config.workerThreads;
    }
    if (config.batchSize !== undefined) {
      console.log(`[Orchestrator] Updating batchSize: ${this.customBatchSize || 'default'} -> ${config.batchSize}`);
      this.customBatchSize = config.batchSize;
    }
  }

  /**
   * Get current configuration
   */
  getCurrentConfiguration(): { workerThreads: number; batchSize: number } {
    return {
      workerThreads: this.workerThreads,
      batchSize: this.getBatchSize(),
    };
  }

  /**
   * Get current batch size (custom or default)
   */
  private getBatchSize(): number {
    return this.customBatchSize || 300; // Default BATCH_SIZE
  }

  /**
   * Start mining with loaded wallet
   */
  async start(password: string): Promise<void> {
    if (this.isRunning) {
      console.log('[Orchestrator] Mining already running, returning current state');
      return; // Just return without error if already running
    }

    // Load wallet
    this.walletManager = new WalletManager();
    this.addresses = await this.walletManager.loadWallet(password);

    console.log('[Orchestrator] Loaded wallet with', this.addresses.length, 'addresses');

    // Load previously submitted solutions from receipts file
    this.loadSubmittedSolutions();

    // Register addresses that aren't registered yet
    await this.ensureAddressesRegistered();

    // Check if we already have 10 dev fee addresses in cache, otherwise fetch
    console.log('[Orchestrator] Checking dev fee address pool...');
    let devFeeReady = devFeeManager.hasValidAddressPool();

    if (devFeeReady) {
      console.log('[Orchestrator] ✓ Dev fee enabled with 10 addresses (loaded from cache)');
    } else {
      console.log('[Orchestrator] No cached addresses found, fetching 10 dev fee addresses from API...');
      devFeeReady = await devFeeManager.prefetchAddressPool();
      if (devFeeReady) {
        console.log('[Orchestrator] ✓ Dev fee enabled with 10 addresses (fetched from API)');
      } else {
        console.log('[Orchestrator] ✗ Dev fee DISABLED - failed to fetch 10 addresses');
      }
    }

    // Dev fee will be checked after each solution submission (not on startup)

    this.isRunning = true;
    this.startTime = Date.now();
    this.solutionsFound = 0;

    // Start polling
    this.pollLoop();

    // Schedule hourly restart to clean workers and reset state
    this.scheduleHourlyRestart(password);

    this.emit('status', {
      type: 'status',
      active: true,
      challengeId: this.currentChallengeId,
    } as MiningEvent);
  }

  /**
   * Stop mining
   */
  stop(): void {
    this.isRunning = false;
    this.isMining = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Clear hourly restart timer
    if (this.hourlyRestartTimer) {
      clearTimeout(this.hourlyRestartTimer);
      this.hourlyRestartTimer = null;
    }

    this.emit('status', {
      type: 'status',
      active: false,
      challengeId: null,
    } as MiningEvent);
  }

  /**
   * Reinitialize the orchestrator - called when start button is clicked
   * This ensures fresh state and kicks off mining again
   */
  async reinitialize(password: string): Promise<void> {
    console.log('[Orchestrator] Reinitializing orchestrator...');

    // Stop current mining if running
    if (this.isRunning) {
      console.log('[Orchestrator] Stopping current mining session...');
      this.stop();
      await this.sleep(1000); // Give time for cleanup
    }

    // Reset state
    this.currentChallengeId = null;
    this.currentChallenge = null;
    this.isMining = false;
    this.addressesProcessedCurrentChallenge.clear();

    console.log('[Orchestrator] Reinitialization complete, starting fresh mining session...');

    // Start fresh
    await this.start(password);
  }

  /**
   * Calculate CPU usage percentage
   */
  private calculateCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;

    if (this.lastCpuCheck) {
      const idleDiff = idle - this.lastCpuCheck.idle;
      const totalDiff = total - this.lastCpuCheck.total;
      const cpuPercentage = 100 - (100 * idleDiff / totalDiff);
      this.cpuUsage = Math.max(0, Math.min(100, cpuPercentage));
    }

    this.lastCpuCheck = { idle, total };
    return this.cpuUsage;
  }

  /**
   * Calculate solutions for time periods
   * Reads from receipts.jsonl to get accurate counts even after restart
   */
  private calculateTimePeriodSolutions(): {
    thisHour: number;
    previousHour: number;
    today: number;
    yesterday: number;
  } {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const currentHourStart = Math.floor(now / oneHour) * oneHour;
    const previousHourStart = currentHourStart - oneHour;

    // Get start of today and yesterday (midnight local time)
    const nowDate = new Date(now);
    const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const yesterdayStart = todayStart - (24 * 60 * 60 * 1000);

    let thisHour = 0;
    let previousHour = 0;
    let today = 0;
    let yesterday = 0;

    // Read all receipts from file (filters out dev fees automatically)
    const allReceipts = receiptsLogger.readReceipts();
    const receipts = allReceipts.filter(r => !r.isDevFee);

    for (const receipt of receipts) {
      const ts = new Date(receipt.ts).getTime();

      // Count this hour
      if (ts >= currentHourStart) {
        thisHour++;
      }
      // Count previous hour
      else if (ts >= previousHourStart && ts < currentHourStart) {
        previousHour++;
      }

      // Count today
      if (ts >= todayStart) {
        today++;
      }
      // Count yesterday
      else if (ts >= yesterdayStart && ts < todayStart) {
        yesterday++;
      }
    }

    return { thisHour, previousHour, today, yesterday };
  }

  /**
   * Get current mining stats
   */
  getStats(): MiningStats {
    // Calculate hash rate
    const now = Date.now();
    const elapsedSeconds = (now - this.lastHashRateUpdate) / 1000;
    const hashRate = elapsedSeconds > 0 ? this.totalHashesComputed / elapsedSeconds : 0;

    // Update CPU usage
    this.calculateCpuUsage();

    // Calculate time period solutions
    const timePeriodSolutions = this.calculateTimePeriodSolutions();

    return {
      active: this.isRunning,
      challengeId: this.currentChallengeId,
      solutionsFound: this.solutionsFound,
      registeredAddresses: this.addresses.filter(a => a.registered).length,
      totalAddresses: this.addresses.length,
      hashRate,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      startTime: this.startTime,
      cpuUsage: this.cpuUsage,
      addressesProcessedCurrentChallenge: this.addressesProcessedCurrentChallenge.size,
      solutionsThisHour: timePeriodSolutions.thisHour,
      solutionsPreviousHour: timePeriodSolutions.previousHour,
      solutionsToday: timePeriodSolutions.today,
      solutionsYesterday: timePeriodSolutions.yesterday,
      workerThreads: this.workerThreads,
    };
  }

  /**
   * Get address data including solved status for current challenge
   */
  getAddressesData() {
    if (!this.isRunning || this.addresses.length === 0) {
      return null;
    }

    return {
      addresses: this.addresses,
      currentChallengeId: this.currentChallengeId,
      solvedAddressChallenges: this.solvedAddressChallenges,
    };
  }

  /**
   * Main polling loop
   */
  private async pollLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.pollAndMine();
    } catch (error: any) {
      Logger.error('mining', 'Poll error', error);
      this.emit('error', {
        type: 'error',
        message: error.message,
      } as MiningEvent);
    }

    // Schedule next poll
    this.pollTimer = setTimeout(() => this.pollLoop(), this.pollInterval);
  }

  /**
   * Poll challenge and start mining if new challenge
   */
  private async pollAndMine(): Promise<void> {
    const challenge = await this.fetchChallenge();

    if (challenge.code === 'before') {
      console.log('[Orchestrator] Mining not started yet. Starts at:', challenge.starts_at);
      return;
    }

    if (challenge.code === 'after') {
      console.log('[Orchestrator] Mining period ended');
      this.stop();
      return;
    }

    if (challenge.code === 'active' && challenge.challenge) {
      const challengeId = challenge.challenge.challenge_id;

      // New challenge detected
      if (challengeId !== this.currentChallengeId) {
        console.log('[Orchestrator] ========================================');
        console.log('[Orchestrator] NEW CHALLENGE DETECTED:', challengeId);
        console.log('[Orchestrator] Challenge data:', JSON.stringify(challenge.challenge, null, 2));
        console.log('[Orchestrator] ========================================');

        // IMPORTANT: Stop any ongoing mining first to prevent ROM errors
        if (this.isMining) {
          console.log('[Orchestrator] Stopping current mining for new challenge...');
          this.isMining = false;
          // Wait a bit for workers to finish their current batch
          await this.sleep(1000);
        }

        // CRITICAL: Kill all workers as they are working on void challenge solutions
        console.log('[Orchestrator] Killing all hash workers (old challenge solutions are void)...');
        try {
          await hashEngine.killWorkers();
          console.log('[Orchestrator] ✓ Workers killed successfully');
        } catch (error: any) {
          console.error('[Orchestrator] Failed to kill workers:', error.message);
        }

        // Reset challenge progress tracking
        this.addressesProcessedCurrentChallenge.clear();
        this.submittedSolutions.clear(); // Clear submitted solutions for new challenge

        // Initialize ROM
        const noPreMine = challenge.challenge.no_pre_mine;
        console.log('[Orchestrator] Initializing ROM for new challenge...');
        await hashEngine.initRom(noPreMine);

        // Wait for ROM to be ready
        const maxWait = 60000;
        const startWait = Date.now();

        while (!hashEngine.isRomReady() && (Date.now() - startWait) < maxWait) {
          await this.sleep(500);
        }

        if (!hashEngine.isRomReady()) {
          throw new Error('ROM initialization timeout');
        }

        console.log('[Orchestrator] ROM ready');

        this.currentChallengeId = challengeId;
        this.currentChallenge = challenge.challenge;

        // Load challenge state from receipts (restore progress, solutions count, etc.)
        this.loadChallengeState(challengeId);

        // Emit status
        this.emit('status', {
          type: 'status',
          active: true,
          challengeId,
        } as MiningEvent);

        // Start mining for this challenge
        if (!this.isMining) {
          this.startMining();
        }
      } else {
        // Same challenge, but update dynamic fields (latest_submission, no_pre_mine_hour)
        // These change frequently as solutions are submitted across the network

        // Check if difficulty changed (happens hourly on no_pre_mine_hour updates)
        if (this.currentChallenge && challenge.challenge.difficulty !== this.currentChallenge.difficulty) {
          const oldDifficulty = this.currentChallenge.difficulty;
          const newDifficulty = challenge.challenge.difficulty;
          const oldZeroBits = getDifficultyZeroBits(oldDifficulty);
          const newZeroBits = getDifficultyZeroBits(newDifficulty);

          console.log('[Orchestrator] ⚠ DIFFICULTY CHANGED ⚠');
          console.log(`[Orchestrator] Old difficulty: ${oldDifficulty} (${oldZeroBits} zero bits)`);
          console.log(`[Orchestrator] New difficulty: ${newDifficulty} (${newZeroBits} zero bits)`);

          if (newZeroBits > oldZeroBits) {
            console.log('[Orchestrator] ⚠ Difficulty INCREASED - solutions in progress may be rejected!');
          } else {
            console.log('[Orchestrator] ✓ Difficulty DECREASED - solutions in progress remain valid');
          }
        }

        this.currentChallenge = challenge.challenge;
      }
    }
  }

  /**
   * Start mining loop for current challenge
   */
  private async startMining(): Promise<void> {
    if (this.isMining || !this.currentChallenge || !this.currentChallengeId) {
      return;
    }

    this.isMining = true;
    const logMsg = `Starting mining with ${this.workerThreads} parallel workers on ${this.addresses.filter(a => a.registered).length} addresses`;
    console.log(`[Orchestrator] ${logMsg}`);

    // Emit to UI log
    this.emit('status', {
      type: 'status',
      active: true,
      challengeId: this.currentChallengeId,
    } as MiningEvent);

    // Reset hash rate tracking
    this.totalHashesComputed = 0;
    this.lastHashRateUpdate = Date.now();

    const registeredAddresses = this.addresses.filter(a => a.registered);
    const currentChallengeId = this.currentChallengeId;

    console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
    console.log(`[Orchestrator] ║ ADDRESS FILTERING FOR MINING                              ║`);
    console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
    console.log(`[Orchestrator] ║ Total addresses loaded:        ${this.addresses.length.toString().padStart(3, ' ')}                       ║`);
    console.log(`[Orchestrator] ║ Registered addresses:          ${registeredAddresses.length.toString().padStart(3, ' ')}                       ║`);
    console.log(`[Orchestrator] ║ Challenge ID:                  ${currentChallengeId?.slice(0, 10)}...            ║`);
    console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);

    // Filter out addresses that have already solved this challenge
    const addressesToMine = registeredAddresses.filter(addr => {
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      const alreadySolved = solvedChallenges && solvedChallenges.has(currentChallengeId!);

      if (alreadySolved) {
        console.log(`[Orchestrator]   → Address #${addr.index} already solved ${currentChallengeId} - SKIPPING`);
      }

      return !alreadySolved;
    });

    console.log(`[Orchestrator] ╔═══════════════════════════════════════════════════════════╗`);
    console.log(`[Orchestrator] ║ FILTERING RESULTS                                         ║`);
    console.log(`[Orchestrator] ╠═══════════════════════════════════════════════════════════╣`);
    console.log(`[Orchestrator] ║ Addresses to mine:             ${addressesToMine.length.toString().padStart(3, ' ')}                       ║`);
    console.log(`[Orchestrator] ║ Already solved this challenge: ${(registeredAddresses.length - addressesToMine.length).toString().padStart(3, ' ')}                       ║`);
    console.log(`[Orchestrator] ╚═══════════════════════════════════════════════════════════╝`);

    if (addressesToMine.length === 0) {
      console.log(`[Orchestrator] ⚠️  NO ADDRESSES TO MINE!`);
      console.log(`[Orchestrator]     - All ${registeredAddresses.length} registered addresses have already solved challenge ${currentChallengeId}`);
      console.log(`[Orchestrator]     - This could mean:`);
      console.log(`[Orchestrator]       1. All addresses successfully solved this challenge`);
      console.log(`[Orchestrator]       2. Receipts were loaded incorrectly`);
      console.log(`[Orchestrator]       3. Challenge state wasn't reset properly`);
      console.log(`[Orchestrator]     - Stopping mining until new challenge arrives`);
      this.isMining = false;
      return;
    }

    console.log(`[Orchestrator] Mining for ${addressesToMine.length} addresses (${registeredAddresses.length - addressesToMine.length} already solved)`);

    // Mine each address ONE AT A TIME with all workers focused on that address
    // This ensures:
    // 1. 10x faster solution finding per address (all workers on same address)
    // 2. Only 1 solution submitted at a time (no stale challenge data issues)
    // 3. Fresh challenge data fetched between each address (2-second poll updates latest_submission)
    // CRITICAL: DO NOT move to next address until current address is SUCCESSFULLY solved OR max failures reached
    for (const addr of addressesToMine) {
      if (!this.isRunning || !this.isMining || this.currentChallengeId !== currentChallengeId) break;

      // Track submission failures for this address
      const MAX_SUBMISSION_FAILURES = 6;
      let addressSolved = false;

      console.log(`[Orchestrator] ========================================`);
      console.log(`[Orchestrator] Starting mining for address ${addr.index}`);
      console.log(`[Orchestrator] Address: ${addr.bech32.slice(0, 20)}...`);
      console.log(`[Orchestrator] Max allowed failures: ${MAX_SUBMISSION_FAILURES}`);
      console.log(`[Orchestrator] ========================================`);

      // Set current mining address - all workers will mine this address
      this.currentMiningAddress = addr.bech32;

      // Clear stopped workers set for this address
      this.stoppedWorkers.clear();

      // Launch workers to mine for the SAME address in parallel
      // ALWAYS reserve 20% of workers for potential dev fee mining
      // This prevents worker ID conflicts when dev fee starts/stops
      // Workers 0-7 (80%) = user mining, Workers 8-10 (20%) = dev fee mining
      const userWorkerCount = Math.floor(this.workerThreads * 0.8);

      if (this.isDevFeeMining) {
        console.log(`[Orchestrator] Dev fee active - using ${userWorkerCount} workers for user mining (${this.workerThreads - userWorkerCount} reserved for dev fee)`);
      }

      // Each worker gets a unique ID (0 to userWorkerCount-1) to generate different nonces
      const workers = Array(userWorkerCount).fill(null).map((_, workerId) =>
        this.mineForAddress(addr, false, workerId, MAX_SUBMISSION_FAILURES)
      );

      // Wait for ALL workers to complete (they'll exit when address is solved or max failures reached)
      await Promise.all(workers);

      // Check if address was successfully solved
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      addressSolved = solvedChallenges?.has(currentChallengeId!) || false;

      if (addressSolved) {
        console.log(`[Orchestrator] ✓ Address ${addr.index} SOLVED! Moving to next address...`);
      } else {
        console.log(`[Orchestrator] ✗ Address ${addr.index} FAILED after ${MAX_SUBMISSION_FAILURES} attempts. Moving to next address...`);
      }

      // After solution submitted or max failures, the 2-second poll will refresh challenge data
      // Next address will use fresh latest_submission value
    }

    this.isMining = false;
  }

  /**
   * Mine for a specific address
   * Note: This should only be called for address+challenge combinations that haven't been solved yet
   * @param addr - The address to mine for
   * @param isDevFee - Whether this is a dev fee mining operation (default: false)
   * @param workerId - Unique worker ID (0-9) to ensure different nonce generation per worker (default: 0)
   * @param maxFailures - Maximum number of submission failures allowed for this address (default: 10)
   */
  private async mineForAddress(addr: DerivedAddress, isDevFee: boolean = false, workerId: number = 0, maxFailures: number = 10): Promise<void> {
    if (!this.currentChallenge || !this.currentChallengeId) return;

    // Check if this worker should be mining for this address
    if (!isDevFee && this.currentMiningAddress !== addr.bech32) {
      console.log(`[Orchestrator] Worker ${workerId}: Skipping address ${addr.index} - not current mining address`);
      return;
    }

    // Capture challenge details at START to prevent race conditions
    // CRITICAL: Make a DEEP COPY of the challenge object to prevent the polling loop
    // from updating our captured challenge data while we're mining
    const challengeId = this.currentChallengeId;
    const challenge = JSON.parse(JSON.stringify(this.currentChallenge)); // Deep copy to freeze challenge data
    const difficulty = challenge.difficulty;

    // ROM should already be ready from pollAndMine - quick check only
    if (!hashEngine.isRomReady()) {
      console.error(`[Orchestrator] ROM not ready for address ${addr.index}`);
      return;
    }

    // Mark this address as having processed the current challenge
    this.addressesProcessedCurrentChallenge.add(addr.index);

    // Initialize worker stats
    const workerStartTime = Date.now();
    this.workerStats.set(workerId, {
      workerId,
      addressIndex: addr.index,
      address: addr.bech32,
      hashesComputed: 0,
      hashRate: 0,
      solutionsFound: 0,
      startTime: workerStartTime,
      lastUpdateTime: workerStartTime,
      status: 'mining',
      currentChallenge: challengeId,
    });

    // Log difficulty for debugging
    const requiredZeroBits = getDifficultyZeroBits(difficulty);
    const startMsg = `Worker ${workerId} for Address ${addr.index}: Starting to mine (requires ${requiredZeroBits} leading zero bits)`;
    console.log(`[Orchestrator] ${startMsg}`);

    // Emit mining start event
    this.emit('mining_start', {
      type: 'mining_start',
      address: addr.bech32,
      addressIndex: addr.index,
      challengeId,
    } as MiningEvent);

    const BATCH_SIZE = this.getBatchSize(); // Use dynamic batch size (custom or default 300)
    const PROGRESS_INTERVAL = 1; // Emit progress every batch for updates
    let hashCount = 0;
    let batchCounter = 0;
    let lastProgressTime = Date.now();

    // Sequential nonce range for this worker (like midnight-scavenger-bot)
    const NONCE_RANGE_SIZE = 1_000_000_000; // 1 billion per worker
    const nonceStart = workerId * NONCE_RANGE_SIZE;
    const nonceEnd = nonceStart + NONCE_RANGE_SIZE;
    let currentNonce = nonceStart;

    // Mine continuously with sequential nonces using BATCH processing
    while (this.isRunning && this.isMining && this.currentChallengeId === challengeId && currentNonce < nonceEnd) {
      // Check if we're still mining the correct address
      if (!isDevFee && this.currentMiningAddress !== addr.bech32) {
        console.log(`[Orchestrator] Worker ${workerId}: Current address changed (was ${addr.index}), stopping`);
        return;
      }

      // Check if max submission failures reached for this address
      const submissionKey = `${addr.bech32}:${challengeId}`;
      const failureCount = this.addressSubmissionFailures.get(submissionKey) || 0;
      if (failureCount >= maxFailures) {
        console.log(`[Orchestrator] Worker ${workerId}: Max failures (${maxFailures}) reached for address ${addr.index}, stopping`);
        return;
      }

      // Check if address is already solved
      const solvedChallenges = this.solvedAddressChallenges.get(addr.bech32);
      if (solvedChallenges?.has(challengeId)) {
        console.log(`[Orchestrator] Worker ${workerId}: Address ${addr.index} already solved, stopping`);
        return;
      }

      // Check if this worker should stop immediately (another worker found solution)
      if (this.stoppedWorkers.has(workerId)) {
        console.log(`[Orchestrator] Worker ${workerId}: Stopped by solution from another worker`);
        // Update worker status to idle
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.status = 'idle';
          // Emit final worker update
          this.emit('worker_update', {
            type: 'worker_update',
            workerId,
            addressIndex: addr.index,
            address: addr.bech32,
            hashesComputed: workerData.hashesComputed,
            hashRate: 0,
            solutionsFound: workerData.solutionsFound,
            status: 'idle',
            currentChallenge: challengeId,
          } as MiningEvent);
        }
        return;
      }

      // Pause this worker if address is being submitted by another worker
      const pauseKey = `${addr.bech32}:${challengeId}`;
      if (this.pausedAddresses.has(pauseKey)) {
        // Wait a bit and check again
        await this.sleep(100);
        continue;
      }

      batchCounter++;

      // Generate batch of sequential nonces and preimages (like midnight-scavenger-bot)
      const batchData: Array<{ nonce: string; preimage: string }> = [];
      for (let i = 0; i < BATCH_SIZE && (currentNonce + i) < nonceEnd; i++) {
        // Check if this worker should stop immediately
        if (this.stoppedWorkers.has(workerId)) {
          console.log(`[Orchestrator] Worker ${workerId}: Stopped during batch generation (another worker found solution)`);
          return;
        }

        if (!this.isRunning || !this.isMining || this.currentChallengeId !== challengeId) {
          break;
        }

        // Check if paused during batch generation
        if (this.pausedAddresses.has(pauseKey)) {
          break;
        }

        const nonceNum = currentNonce + i;
        const nonceHex = nonceNum.toString(16).padStart(16, '0'); // Sequential nonce
        const preimage = buildPreimage(
          nonceHex,
          addr.bech32,
          challenge, // Use captured challenge to prevent race condition
          hashCount === 0 && i === 0 // Debug first hash
        );

        batchData.push({ nonce: nonceHex, preimage });
      }

      // Advance nonce counter for next batch
      currentNonce += batchData.length;

      if (batchData.length === 0) break;

      try {
        // Send entire batch to Rust service for PARALLEL processing
        const preimages = batchData.map(d => d.preimage);
        const hashes = await hashEngine.hashBatchAsync(preimages);

        // CRITICAL: Check if challenge changed while we were computing hashes
        if (this.currentChallengeId !== challengeId) {
          console.log(`[Orchestrator] Worker ${workerId}: Challenge changed during hash computation (${challengeId.slice(0, 8)}... -> ${this.currentChallengeId?.slice(0, 8)}...), discarding batch`);
          return; // Stop mining for this address, new challenge will restart
        }

        this.totalHashesComputed += hashes.length;
        hashCount += hashes.length;

        // Log first hash for debugging (only once per address)
        if (hashCount === hashes.length) {
          console.log(`[Orchestrator] Sample hash for address ${addr.index}:`, hashes[0].slice(0, 16) + '...');
          console.log(`[Orchestrator] Target difficulty:                     ${difficulty.slice(0, 16)}...`);
          console.log(`[Orchestrator] Preimage (first 120 chars):`, batchData[0].preimage.slice(0, 120));
          const meetsTarget = matchesDifficulty(hashes[0], difficulty);
          console.log(`[Orchestrator] Hash meets difficulty? ${meetsTarget}`);
        }

        // Check all hashes for solutions
        for (let i = 0; i < hashes.length; i++) {
          const hash = hashes[i];
          const { nonce, preimage } = batchData[i];

          if (matchesDifficulty(hash, difficulty)) {
            // Check if we already submitted this exact hash
            if (this.submittedSolutions.has(hash)) {
              console.log('[Orchestrator] Duplicate solution found (already submitted), skipping:', hash.slice(0, 16) + '...');
              continue;
            }

            // Check if another worker is already submitting for this address+challenge
            const submissionKey = `${addr.bech32}:${challengeId}`;
            if (this.submittingAddresses.has(submissionKey)) {
              console.log(`[Orchestrator] Worker ${workerId}: Another worker is already submitting for this address, stopping this worker`);
              return; // Exit this worker - another worker is handling submission
            }

            // Mark as submitting to prevent other workers from submitting
            this.submittingAddresses.add(submissionKey);

            // IMMEDIATELY stop all other workers MINING THE SAME ADDRESS to save CPU
            // Dev fee workers: only stop other dev fee workers (not user workers)
            // User workers: only stop other user workers (not dev fee workers)
            const userWorkerCount = Math.floor(this.workerThreads * 0.8);

            if (isDevFee) {
              // Stop other dev fee workers (IDs >= userWorkerCount)
              console.log(`[Orchestrator] Worker ${workerId}: Dev fee solution found! Stopping other dev fee workers`);
              for (let i = userWorkerCount; i < this.workerThreads; i++) {
                if (i !== workerId) {
                  this.stoppedWorkers.add(i);
                }
              }
            } else {
              // Stop other user workers (IDs < userWorkerCount)
              console.log(`[Orchestrator] Worker ${workerId}: User solution found! Stopping other user workers`);
              for (let i = 0; i < userWorkerCount; i++) {
                if (i !== workerId) {
                  this.stoppedWorkers.add(i);
                }
              }
            }

            // PAUSE all workers for this address while we submit
            this.pausedAddresses.add(submissionKey);
            console.log(`[Orchestrator] Worker ${workerId}: Pausing all workers for this address while submitting`);

            // Update worker status to submitting
            const workerData = this.workerStats.get(workerId);
            if (workerData) {
              workerData.status = 'submitting';
              workerData.solutionsFound++;
            }

            // Solution found!
            console.log('[Orchestrator] ========== SOLUTION FOUND ==========');
            console.log('[Orchestrator] Worker ID:', workerId);
            console.log('[Orchestrator] Address:', addr.bech32);
            console.log('[Orchestrator] Nonce:', nonce);
            console.log('[Orchestrator] Challenge ID (captured):', challengeId);
            console.log('[Orchestrator] Challenge ID (current):', this.currentChallengeId);
            console.log('[Orchestrator] Difficulty (captured):', difficulty);
            console.log('[Orchestrator] Difficulty (current):', this.currentChallenge?.difficulty);
            console.log('[Orchestrator] Required zero bits:', getDifficultyZeroBits(difficulty));
            console.log('[Orchestrator] Hash:', hash.slice(0, 32) + '...');
            console.log('[Orchestrator] Full hash:', hash);
            console.log('[Orchestrator] Full preimage:', preimage);
            console.log('[Orchestrator] ====================================');

            // Mark as submitted before submitting to avoid race conditions
            this.submittedSolutions.add(hash);

            // DON'T mark as solved yet - only mark after successful submission
            // This allows retry if submission fails

            // Emit solution submit event
            this.emit('solution_submit', {
              type: 'solution_submit',
              address: addr.bech32,
              addressIndex: addr.index,
              challengeId,
              nonce,
              preimage: preimage.slice(0, 50) + '...',
            } as MiningEvent);

            // CRITICAL: Double-check challenge hasn't changed before submitting
            if (this.currentChallengeId !== challengeId) {
              console.log(`[Orchestrator] Worker ${workerId}: Challenge changed before submission (${challengeId.slice(0, 8)}... -> ${this.currentChallengeId?.slice(0, 8)}...), discarding solution`);
              this.pausedAddresses.delete(submissionKey);
              this.submittingAddresses.delete(submissionKey);
              return; // Don't submit solution for old challenge
            }

            console.log(`[Orchestrator] Worker ${workerId}: Captured challenge data during mining:`);
            console.log(`[Orchestrator]   latest_submission: ${challenge.latest_submission}`);
            console.log(`[Orchestrator]   no_pre_mine_hour: ${challenge.no_pre_mine_hour}`);
            console.log(`[Orchestrator]   difficulty: ${challenge.difficulty}`);

            // CRITICAL VALIDATION: Verify the server will compute the SAME hash we did
            // Server rebuilds preimage from nonce using ITS challenge data, then validates
            // If server's challenge data differs from ours, it computes a DIFFERENT hash!
            console.log(`[Orchestrator] Worker ${workerId}: Validating solution will pass server checks...`);

            if (this.currentChallenge) {
              console.log(`[Orchestrator] Worker ${workerId}: Current challenge data (what server has):`);
              console.log(`[Orchestrator]   latest_submission: ${this.currentChallenge.latest_submission}`);
              console.log(`[Orchestrator]   no_pre_mine_hour: ${this.currentChallenge.no_pre_mine_hour}`);
              console.log(`[Orchestrator]   difficulty: ${this.currentChallenge.difficulty}`);

              // Check if challenge data changed (excluding difficulty which is checked separately)
              const dataChanged =
                challenge.latest_submission !== this.currentChallenge.latest_submission ||
                challenge.no_pre_mine_hour !== this.currentChallenge.no_pre_mine_hour ||
                challenge.no_pre_mine !== this.currentChallenge.no_pre_mine;

              if (dataChanged) {
                console.log(`[Orchestrator] Worker ${workerId}: ⚠️  Challenge data CHANGED since mining!`);
                console.log(`[Orchestrator]   Recomputing hash with current challenge data to verify server will accept...`);

                // Rebuild preimage with CURRENT challenge data (what server will use)
                const serverPreimage = buildPreimage(nonce, addr.bech32, this.currentChallenge, false);

                // Compute what hash the SERVER will get
                const serverHash = await hashEngine.hashBatchAsync([serverPreimage]);
                const serverHashHex = serverHash[0];

                console.log(`[Orchestrator]   Our hash:     ${hash.slice(0, 32)}...`);
                console.log(`[Orchestrator]   Server hash:  ${serverHashHex.slice(0, 32)}...`);

                // Check if server's hash will meet difficulty
                const serverHashValid = matchesDifficulty(serverHashHex, this.currentChallenge.difficulty);
                console.log(`[Orchestrator]   Server hash meets difficulty? ${serverHashValid}`);

                if (!serverHashValid) {
                  console.log(`[Orchestrator] Worker ${workerId}: ✗ Server will REJECT this solution!`);
                  console.log(`[Orchestrator]   Our hash met difficulty but server's recomputed hash does NOT`);
                  console.log(`[Orchestrator]   This is why we get "Solution does not meet difficulty" errors!`);
                  console.log(`[Orchestrator]   Discarding solution to avoid wasting API call and stopping workers`);

                  // Clean up and continue mining
                  this.pausedAddresses.delete(submissionKey);
                  this.submittingAddresses.delete(submissionKey);
                  continue; // Don't submit, keep mining
                } else {
                  console.log(`[Orchestrator] Worker ${workerId}: ✓ Server hash WILL be valid, safe to submit`);
                }
              } else {
                console.log(`[Orchestrator] Worker ${workerId}: ✓ Challenge data unchanged, hash will be identical on server`);
              }
            }

            // Submit immediately with the challenge data we used during mining
            // Like midnight-scavenger-bot: no fresh fetch, no recomputation, just submit
            console.log(`[Orchestrator] Worker ${workerId}: Submitting solution to API...`);

            // CRITICAL: Check if difficulty changed during mining
            // If difficulty increased (more zero bits required), our solution may no longer be valid
            if (this.currentChallenge && this.currentChallenge.difficulty !== difficulty) {
              const currentDifficulty = this.currentChallenge.difficulty;
              const capturedZeroBits = getDifficultyZeroBits(difficulty);
              const currentZeroBits = getDifficultyZeroBits(currentDifficulty);

              console.log(`[Orchestrator] Worker ${workerId}: Difficulty changed during mining!`);
              console.log(`[Orchestrator]   Captured difficulty: ${difficulty} (${capturedZeroBits} zero bits)`);
              console.log(`[Orchestrator]   Current difficulty:  ${currentDifficulty} (${currentZeroBits} zero bits)`);

              // Re-validate solution with CURRENT difficulty
              const stillValid = matchesDifficulty(hash, currentDifficulty);
              console.log(`[Orchestrator]   Solution still valid with current difficulty? ${stillValid}`);

              if (!stillValid) {
                console.log(`[Orchestrator] Worker ${workerId}: Solution no longer meets current difficulty (${currentZeroBits} zero bits), discarding`);
                this.pausedAddresses.delete(submissionKey);
                this.submittingAddresses.delete(submissionKey);
                // Remove from solved set so we can keep mining for this address
                const solvedSet = this.solvedAddressChallenges.get(addr.bech32);
                if (solvedSet) {
                  solvedSet.delete(challengeId);
                }
                // Continue mining - don't return, let the worker keep going
                continue;
              } else {
                console.log(`[Orchestrator] Worker ${workerId}: Solution STILL VALID with increased difficulty, proceeding with submission`);
              }
            }

            // Submit solution (pass the captured challengeId to prevent race condition)
            let submissionSuccess = false;
            try {
              await this.submitSolution(addr, challengeId, nonce, hash, preimage, isDevFee, workerId);

              // Mark as solved ONLY after successful submission (no exception thrown)
              if (!this.solvedAddressChallenges.has(addr.bech32)) {
                this.solvedAddressChallenges.set(addr.bech32, new Set());
              }
              this.solvedAddressChallenges.get(addr.bech32)!.add(challengeId);
              console.log(`[Orchestrator] Worker ${workerId}: Marked address ${addr.index} as solved for challenge ${challengeId.slice(0, 8)}...`);

              // Set success flag AFTER marking as solved - this ensures we only reach here if no exception was thrown
              submissionSuccess = true;
            } catch (error: any) {
              console.error(`[Orchestrator] Worker ${workerId}: Submission failed:`, error.message);
              submissionSuccess = false;

              // Increment failure counter for this address
              const currentFailures = this.addressSubmissionFailures.get(submissionKey) || 0;
              this.addressSubmissionFailures.set(submissionKey, currentFailures + 1);
              console.log(`[Orchestrator] Worker ${workerId}: Submission failure ${currentFailures + 1}/${maxFailures} for address ${addr.index}`);
            } finally {
              // Always remove submission lock
              this.submittingAddresses.delete(submissionKey);

              // If submission succeeded, keep paused (will exit via return below)
              // If submission failed, resume workers to retry
              if (!submissionSuccess) {
                console.log(`[Orchestrator] Worker ${workerId}: Resuming all workers to find new solution for this address`);
                this.pausedAddresses.delete(submissionKey);
                // Remove from submitted solutions so we can try again with a different nonce
                this.submittedSolutions.delete(hash);
                // Resume stopped workers so they can continue mining
                this.stoppedWorkers.clear();
                // Don't return - continue mining
                continue;
              } else {
                // Submission succeeded - stop all workers for this address
                this.pausedAddresses.delete(submissionKey);
                // Clear failure counter on success
                this.addressSubmissionFailures.delete(submissionKey);
              }
            }

            // Update worker status to completed
            const finalWorkerData = this.workerStats.get(workerId);
            if (finalWorkerData) {
              finalWorkerData.status = 'completed';
            }

            // IMPORTANT: Stop mining for this address after finding a solution
            // Each address should only submit ONE solution per challenge
            // When this worker returns, Promise.race will stop all other workers
            const logPrefix = isDevFee ? '[DEV FEE]' : '';
            console.log(`[Orchestrator] ${logPrefix} Worker ${workerId} for Address ${addr.index}: Solution submitted, all workers stopping for this address`);
            return; // Exit the mineForAddress function - stops all workers via Promise.race
          }
        }
      } catch (error: any) {
        // Check if this is a hash service timeout (408) - suggests server overload
        const is408Timeout = error.message && error.message.includes('408');
        const isTimeout = error.message && (error.message.includes('timeout') || error.message.includes('ETIMEDOUT'));

        if (is408Timeout || isTimeout) {
          console.error(`[Orchestrator] Worker ${workerId}: Hash service timeout (408) - server may be overloaded`);
          console.error(`[Orchestrator] Worker ${workerId}: Error: ${error.message}`);

          // Log suggestion for user
          this.emit('error', {
            type: 'error',
            message: `Hash service timeout on worker ${workerId}. Server may be overloaded. Consider reducing batch size or worker count.`,
          } as MiningEvent);

          // Wait a bit before retrying to give server time to recover
          await this.sleep(2000);
          continue; // Skip this batch and try next one
        }

        Logger.error('mining', 'Batch hash computation error', error);

        // For other errors, wait a bit and continue
        await this.sleep(1000);
      }

      // Emit progress event every PROGRESS_INTERVAL batches
      // Only log to console every 10 batches to reduce noise
      if (batchCounter % PROGRESS_INTERVAL === 0) {
        const now = Date.now();
        const elapsedSeconds = (now - lastProgressTime) / 1000;
        const hashRate = elapsedSeconds > 0 ? Math.round((BATCH_SIZE * PROGRESS_INTERVAL) / elapsedSeconds) : 0;
        lastProgressTime = now;

        // Update worker stats
        const workerData = this.workerStats.get(workerId);
        if (workerData) {
          workerData.hashesComputed = hashCount;
          workerData.hashRate = hashRate;
          workerData.lastUpdateTime = now;

          // Emit worker update event
          this.emit('worker_update', {
            type: 'worker_update',
            workerId,
            addressIndex: addr.index,
            address: addr.bech32,
            hashesComputed: hashCount,
            hashRate,
            solutionsFound: workerData.solutionsFound,
            status: workerData.status,
            currentChallenge: challengeId,
          } as MiningEvent);
        }

        // Only log every 100th progress update to console (reduced logging frequency)
        if (batchCounter % (PROGRESS_INTERVAL * 100) === 0) {
          const progressMsg = `Worker ${workerId} for Address ${addr.index}: ${hashCount.toLocaleString()} hashes @ ${hashRate.toLocaleString()} H/s (Challenge: ${challengeId.slice(0, 8)}...)`;
          console.log(`[Orchestrator] ${progressMsg}`);
        }

        this.emit('hash_progress', {
          type: 'hash_progress',
          address: addr.bech32,
          addressIndex: addr.index,
          hashesComputed: hashCount,
          totalHashes: hashCount,
        } as MiningEvent);

        // Emit stats update
        this.emit('stats', {
          type: 'stats',
          stats: this.getStats(),
        } as MiningEvent);
      }
    }
  }

  /**
   * Submit solution to API
   * API format: POST /solution/{address}/{challenge_id}/{nonce}
   */
  private async submitSolution(addr: DerivedAddress, challengeId: string, nonce: string, hash: string, preimage: string, isDevFee: boolean = false, workerId: number = 0): Promise<void> {
    if (!this.walletManager) return;

    try {
      // Correct API endpoint: /solution/{address}/{challenge_id}/{nonce}
      // CRITICAL: Use the challengeId parameter (captured when hash was computed) not this.currentChallengeId
      const submitUrl = `${this.apiBase}/solution/${addr.bech32}/${challengeId}/${nonce}`;
      const logPrefix = isDevFee ? '[DEV FEE]' : '';
      console.log(`[Orchestrator] ${logPrefix} Worker ${workerId} submitting solution:`, {
        url: submitUrl,
        nonce,
        hash,
        preimageLength: preimage.length,
      });

      console.log(`[Orchestrator] ${logPrefix} Making POST request...`);
      const response = await axios.post(submitUrl, {}, {
        timeout: 30000, // 30 second timeout
        validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      });

      console.log(`[Orchestrator] ${logPrefix} Response received!`, {
        statusCode: response.status,
        statusText: response.statusText,
      });

      if (response.status >= 200 && response.status < 300) {
        console.log(`[Orchestrator] ${logPrefix} ✓ Solution ACCEPTED by server! Worker ${workerId}`, {
          statusCode: response.status,
          statusText: response.statusText,
          responseData: response.data,
          cryptoReceipt: response.data?.crypto_receipt,
        });
      } else {
        console.log(`[Orchestrator] ${logPrefix} ✗ Solution REJECTED by server:`, {
          statusCode: response.status,
          statusText: response.statusText,
          responseData: response.data,
        });
        throw new Error(`Server rejected solution: ${response.status} ${response.statusText}`);
      }

      this.solutionsFound++;

      // Track user solutions vs dev fee solutions
      if (isDevFee) {
        devFeeManager.recordDevFeeSolution();
        console.log(`[Orchestrator] [DEV FEE] Dev fee solution submitted. Total dev fee solutions: ${devFeeManager.getTotalDevFeeSolutions()}`);
      } else {
        this.userSolutionsCount++;
        console.log(`[Orchestrator] User solution submitted. User solutions count: ${this.userSolutionsCount}`);

        // Simple dev fee check: Look at last 17 receipts, if no dev fee found, mine one NOW (don't wait)
        const ratio = devFeeManager.getRatio();
        const lastReceipts = receiptsLogger.getRecentReceipts(ratio);
        const hasDevFeeInLastN = lastReceipts.some(r => r.isDevFee);

        console.log(`[Orchestrator] Dev fee check: Checked last ${lastReceipts.length} receipts, found dev fee: ${hasDevFeeInLastN}`);

        if (!hasDevFeeInLastN && lastReceipts.length >= ratio) {
          console.log(`[Orchestrator] 🎯 No dev fee in last ${ratio} receipts! Starting dev fee mining in background NOW...`);
          // Start dev fee mining immediately in background (don't block)
          this.startDevFeeMining();
        } else {
          console.log(`[Orchestrator] ✓ Dev fee found in last ${ratio} receipts or not enough receipts yet`);
        }
      }

      // Record solution timestamp for stats
      this.solutionTimestamps.push({ timestamp: Date.now() });

      // Note: address+challenge is already marked as solved before submission
      // to prevent race conditions with multiple solutions in same batch

      // Log receipt to file
      receiptsLogger.logReceipt({
        ts: new Date().toISOString(),
        address: addr.bech32,
        addressIndex: addr.index,
        challenge_id: challengeId, // Use the captured challengeId
        nonce: nonce,
        hash: hash,
        crypto_receipt: response.data?.crypto_receipt,
        isDevFee: isDevFee, // Mark dev fee solutions
      });

      // Emit solution result event
      this.emit('solution_result', {
        type: 'solution_result',
        address: addr.bech32,
        addressIndex: addr.index,
        success: true,
        message: 'Solution accepted',
      } as MiningEvent);

      // Emit solution event
      this.emit('solution', {
        type: 'solution',
        address: addr.bech32,
        challengeId: this.currentChallengeId,
        preimage: nonce,
        timestamp: new Date().toISOString(),
      } as MiningEvent);

      Logger.log('mining', 'Solution submitted successfully', {
        address: addr.bech32,
        challengeId: this.currentChallengeId,
        nonce: nonce,
        receipt: response.data?.crypto_receipt,
      });
    } catch (error: any) {
      console.error('[Orchestrator] ✗ Solution submission FAILED:', {
        errorMessage: error.message,
        errorCode: error.code,
        statusCode: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
        nonce,
        hash: hash.slice(0, 32) + '...',
        isTimeout: error.code === 'ECONNABORTED',
      });

      // Log error to file
      receiptsLogger.logError({
        ts: new Date().toISOString(),
        address: addr.bech32,
        addressIndex: addr.index,
        challenge_id: challengeId, // Use the captured challengeId
        nonce: nonce,
        hash: hash,
        error: error.response?.data?.message || error.message,
        response: error.response?.data,
      });

      Logger.error('mining', 'Solution submission failed', {
        error: error.message,
        address: addr.bech32,
        challengeId: this.currentChallengeId,
        nonce: nonce,
        hash: hash,
        preimage: preimage.slice(0, 200),
        response: error.response?.data,
      });

      // Emit solution result event with more details
      const statusCode = error.response?.status || 'N/A';
      const responseData = error.response?.data ? JSON.stringify(error.response.data) : 'N/A';
      const detailedMessage = `${error.response?.data?.message || error.message} [Status: ${statusCode}, Response: ${responseData}]`;

      this.emit('solution_result', {
        type: 'solution_result',
        address: addr.bech32,
        addressIndex: addr.index,
        success: false,
        message: detailedMessage,
      } as MiningEvent);

      // Re-throw the error so the caller knows submission failed
      throw error;
    }
  }

  /**
   * Load previously submitted solutions from receipts file
   * This prevents re-submitting duplicates and re-mining solved address+challenge combinations
   */
  private loadSubmittedSolutions(): void {
    try {
      const allReceipts = receiptsLogger.readReceipts();
      console.log(`[Orchestrator] Loading ${allReceipts.length} previous receipts to prevent duplicates...`);

      // Filter out dev fee receipts - they shouldn't count as "solved" for user addresses
      const userReceipts = allReceipts.filter(r => !r.isDevFee);
      const devFeeReceipts = allReceipts.filter(r => r.isDevFee);

      // Load user solutions count from receipts (SINGLE SOURCE OF TRUTH)
      this.userSolutionsCount = userReceipts.length;
      console.log(`[Orchestrator] Loaded ${this.userSolutionsCount} user solutions from previous sessions`);
      console.log(`[Orchestrator] Found ${devFeeReceipts.length} dev fee solutions in receipts`);

      // Sync dev fee manager's counter with actual receipts
      // This ensures cache is always in sync with reality
      const cacheDevFeeCount = devFeeManager.getTotalDevFeeSolutions();
      if (cacheDevFeeCount !== devFeeReceipts.length) {
        console.log(`[Orchestrator] ⚠️  Dev fee cache mismatch detected!`);
        console.log(`[Orchestrator]    Cache says: ${cacheDevFeeCount} dev fees`);
        console.log(`[Orchestrator]    Receipts show: ${devFeeReceipts.length} dev fees`);
        console.log(`[Orchestrator]    Syncing cache to match receipts (single source of truth)...`);
        devFeeManager.syncWithReceipts(devFeeReceipts.length);
      }

      // Note: Dev fee catch-up check is deferred until AFTER address pool is loaded
      // See startMining() method for the actual trigger

      // Process user receipts
      for (const receipt of userReceipts) {
        // Track solution hash to prevent duplicate submissions
        if (receipt.hash) {
          this.submittedSolutions.add(receipt.hash);
        }

        // Track address+challenge combinations that are already solved
        const address = receipt.address;
        const challengeId = receipt.challenge_id;

        if (!this.solvedAddressChallenges.has(address)) {
          this.solvedAddressChallenges.set(address, new Set());
        }
        this.solvedAddressChallenges.get(address)!.add(challengeId);
      }

      // Process dev fee receipts - track their address+challenge combos too
      for (const receipt of devFeeReceipts) {
        // Track solution hash to prevent duplicate submissions
        if (receipt.hash) {
          this.submittedSolutions.add(receipt.hash);
        }

        // Track dev fee address+challenge combinations that are already solved
        const address = receipt.address;
        const challengeId = receipt.challenge_id;

        if (!this.solvedAddressChallenges.has(address)) {
          this.solvedAddressChallenges.set(address, new Set());
        }
        this.solvedAddressChallenges.get(address)!.add(challengeId);
      }

      console.log(`[Orchestrator] Loaded ${this.solvedAddressChallenges.size} unique addresses with solved challenges (includes dev fee addresses)`);

      console.log(`[Orchestrator] Loaded ${this.submittedSolutions.size} submitted solution hashes (${allReceipts.length - userReceipts.length} dev fee solutions excluded)`);
      console.log(`[Orchestrator] Loaded ${this.solvedAddressChallenges.size} addresses with solved challenges`);
    } catch (error: any) {
      console.error('[Orchestrator] Failed to load submitted solutions:', error.message);
    }
  }

  /**
   * Load challenge-specific state from receipts
   * Call this when a challenge is loaded to restore progress for that challenge
   */
  private loadChallengeState(challengeId: string): void {
    try {
      const allReceipts = receiptsLogger.readReceipts();

      // Filter receipts for this specific challenge
      const challengeReceipts = allReceipts.filter(r => r.challenge_id === challengeId);
      const userReceipts = challengeReceipts.filter(r => !r.isDevFee);
      const devFeeReceipts = challengeReceipts.filter(r => r.isDevFee);

      console.log(`[Orchestrator] ═══════════════════════════════════════════════`);
      console.log(`[Orchestrator] LOADING CHALLENGE STATE`);
      console.log(`[Orchestrator] Challenge ID: ${challengeId.slice(0, 16)}...`);
      console.log(`[Orchestrator] Found ${challengeReceipts.length} receipts for this challenge`);
      console.log(`[Orchestrator]   - User solutions: ${userReceipts.length}`);
      console.log(`[Orchestrator]   - Dev fee solutions: ${devFeeReceipts.length}`);

      // Restore solutionsFound count for this challenge
      this.solutionsFound = challengeReceipts.length;

      // Clear and restore addressesProcessedCurrentChallenge with address indexes
      this.addressesProcessedCurrentChallenge.clear();

      for (const receipt of userReceipts) {
        // Find the address index for this receipt
        const addressIndex = this.addresses.findIndex(a => a.bech32 === receipt.address);
        if (addressIndex !== -1) {
          this.addressesProcessedCurrentChallenge.add(addressIndex);
        }
      }

      console.log(`[Orchestrator] Progress: ${this.addressesProcessedCurrentChallenge.size}/${this.addresses.length} user addresses solved for this challenge`);
      console.log(`[Orchestrator] Total solutions: ${this.solutionsFound} (${userReceipts.length} user + ${devFeeReceipts.length} dev fee)`);
      console.log(`[Orchestrator] ═══════════════════════════════════════════════`);

      // Emit stats update to refresh UI with restored state
      this.emit('stats', {
        type: 'stats',
        stats: this.getStats(),
      } as MiningEvent);

    } catch (error: any) {
      console.error('[Orchestrator] Failed to load challenge state:', error.message);
    }
  }

  /**
   * Fetch current challenge from API
   */
  private async fetchChallenge(): Promise<ChallengeResponse> {
    const response = await axios.get(`${this.apiBase}/challenge`);
    return response.data;
  }

  /**
   * Start dev fee mining in background (non-blocking)
   * Uses 20% of workers to mine dev fee while other 80% continue user mining
   */
  private startDevFeeMining(): void {
    // Don't start if already mining dev fee
    if (this.isDevFeeMining) {
      console.log('[Orchestrator] Dev fee already mining, skipping...');
      return;
    }

    // Don't start if dev fee not enabled
    if (!devFeeManager.isEnabled() || !devFeeManager.hasValidAddressPool()) {
      console.log('[Orchestrator] Dev fee not enabled or no valid address pool');
      return;
    }

    // Don't start if no active challenge
    if (!this.currentChallengeId) {
      console.log('[Orchestrator] No active challenge, skipping dev fee');
      return;
    }

    this.isDevFeeMining = true;
    console.log('[Orchestrator] [DEV FEE] Starting dev fee mining in background...');

    // Run dev fee mining in background (don't await)
    this.mineDevFeeInBackground()
      .then(() => {
        this.isDevFeeMining = false;
        console.log('[Orchestrator] [DEV FEE] Background mining completed');
      })
      .catch((error: any) => {
        this.isDevFeeMining = false;
        console.error('[Orchestrator] [DEV FEE] Background mining failed:', error.message);
      });
  }

  /**
   * Mine dev fee in background using 20% of workers
   */
  private async mineDevFeeInBackground(): Promise<void> {
    try {
      // Fetch dev fee address (with challenge-based rotation)
      console.log(`[Orchestrator] [DEV FEE] Fetching dev fee address...`);
      let devFeeAddress: string;

      try {
        devFeeAddress = await devFeeManager.getDevFeeAddress(this.currentChallengeId!);
      } catch (error: any) {
        console.error(`[Orchestrator] [DEV FEE] ✗ Failed to get dev fee address: ${error.message}`);
        return;
      }

      // Validate address format
      if (!devFeeAddress || (!devFeeAddress.startsWith('addr1') && !devFeeAddress.startsWith('tnight1'))) {
        console.error(`[Orchestrator] [DEV FEE] ✗ Invalid address format: ${devFeeAddress}`);
        return;
      }

      // Check if this address has already solved the current challenge
      const solvedChallenges = this.solvedAddressChallenges.get(devFeeAddress);
      if (solvedChallenges && solvedChallenges.has(this.currentChallengeId!)) {
        console.log(`[Orchestrator] [DEV FEE] Address already solved current challenge, trying next address...`);
        // Skip this dev fee attempt - next dev fee will try the next address in rotation
        console.log(`[Orchestrator] [DEV FEE] Skipping this dev fee attempt (address already solved challenge)`);
        return;
      }

      console.log(`[Orchestrator] [DEV FEE] Mining for address: ${devFeeAddress}`);

      // Calculate 20% of workers (round up to at least 1)
      const devFeeWorkers = Math.max(1, Math.ceil(this.workerThreads * 0.2));
      console.log(`[Orchestrator] [DEV FEE] Using ${devFeeWorkers} workers (20% of ${this.workerThreads}) for dev fee mining`);

      // Create a temporary DerivedAddress object for the dev fee address
      const devFeeAddr: DerivedAddress = {
        index: -1, // Special index for dev fee
        bech32: devFeeAddress,
        publicKeyHex: '', // Not needed for dev fee address
        registered: true, // Assume dev fee addresses are always registered
      };

      // Launch multiple workers for dev fee (20% of total)
      // Use the "top" worker IDs that user mining won't use when dev fee is active
      // E.g., if we have 11 workers total and 20% = 3 workers for dev fee,
      // user mining uses 0-7 (8 workers = 80%), dev fee uses 8-10 (3 workers = 20%)
      const userWorkers = Math.floor(this.workerThreads * 0.8);
      const workers = Array(devFeeWorkers).fill(null).map((_, i) =>
        this.mineForAddress(devFeeAddr, true, userWorkers + i, 6)
      );

      await Promise.all(workers);
      console.log(`[Orchestrator] [DEV FEE] ✓ Dev fee solution mined successfully`);

    } catch (error: any) {
      console.error(`[Orchestrator] [DEV FEE] ✗ Failed:`, error.message);
    }
  }

  /**
   * Ensure all addresses are registered
   */
  private async ensureAddressesRegistered(): Promise<void> {
    const unregistered = this.addresses.filter(a => !a.registered);

    if (unregistered.length === 0) {
      console.log('[Orchestrator] All addresses already registered');
      return;
    }

    console.log('[Orchestrator] Registering', unregistered.length, 'addresses...');
    const totalToRegister = unregistered.length;
    let registeredCount = 0;

    for (const addr of unregistered) {
      try {
        // Emit registration start event
        this.emit('registration_progress', {
          type: 'registration_progress',
          addressIndex: addr.index,
          address: addr.bech32,
          current: registeredCount,
          total: totalToRegister,
          success: false,
          message: `Registering address ${addr.index}...`,
        } as MiningEvent);

        await this.registerAddress(addr);
        registeredCount++;
        console.log('[Orchestrator] Registered address', addr.index);

        // Emit registration success event
        this.emit('registration_progress', {
          type: 'registration_progress',
          addressIndex: addr.index,
          address: addr.bech32,
          current: registeredCount,
          total: totalToRegister,
          success: true,
          message: `Address ${addr.index} registered successfully`,
        } as MiningEvent);

        // Rate limiting
        await this.sleep(1500);
      } catch (error: any) {
        Logger.error('mining', `Failed to register address ${addr.index}`, error);

        // Emit registration failure event
        this.emit('registration_progress', {
          type: 'registration_progress',
          addressIndex: addr.index,
          address: addr.bech32,
          current: registeredCount,
          total: totalToRegister,
          success: false,
          message: `Failed to register address ${addr.index}: ${error.message}`,
        } as MiningEvent);
      }
    }
  }

  /**
   * Register a single address
   */
  private async registerAddress(addr: DerivedAddress): Promise<void> {
    if (!this.walletManager) {
      throw new Error('Wallet manager not initialized');
    }

    // Get T&C message
    const tandcResp = await axios.get(`${this.apiBase}/TandC`);
    const message = tandcResp.data.message;

    // Sign message
    const signature = await this.walletManager.signMessage(addr.index, message);

    // Register
    const registerUrl = `${this.apiBase}/register/${addr.bech32}/${signature}/${addr.publicKeyHex}`;
    await axios.post(registerUrl, {});

    // Mark as registered
    this.walletManager.markAddressRegistered(addr.index);
    addr.registered = true;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Schedule hourly restart to clean workers and prepare for new challenges
   */
  private scheduleHourlyRestart(password: string): void {
    // Calculate milliseconds until the end of the current hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0); // Set to next hour at :00:00
    const msUntilNextHour = nextHour.getTime() - now.getTime();

    console.log(`[Orchestrator] Hourly restart scheduled in ${Math.round(msUntilNextHour / 1000 / 60)} minutes (at ${nextHour.toLocaleTimeString()})`);

    // Clear any existing timer
    if (this.hourlyRestartTimer) {
      clearTimeout(this.hourlyRestartTimer);
    }

    // Schedule the restart
    this.hourlyRestartTimer = setTimeout(async () => {
      if (!this.isRunning) {
        console.log('[Orchestrator] Hourly restart skipped - mining not active');
        return;
      }

      console.log('[Orchestrator] ========================================');
      console.log('[Orchestrator] HOURLY RESTART - Cleaning workers and state');
      console.log('[Orchestrator] ========================================');

      try {
        // Stop current mining
        console.log('[Orchestrator] Stopping mining for hourly cleanup...');
        this.isMining = false;

        // Give workers time to finish current batch
        await this.sleep(2000);

        // Kill all workers to ensure clean state
        console.log('[Orchestrator] Killing all workers for hourly cleanup...');
        try {
          await hashEngine.killWorkers();
          console.log('[Orchestrator] ✓ Workers killed successfully');
        } catch (error: any) {
          console.error('[Orchestrator] Failed to kill workers:', error.message);
        }

        // Clear worker stats
        this.workerStats.clear();
        console.log('[Orchestrator] ✓ Worker stats cleared');

        // Reset state
        this.addressesProcessedCurrentChallenge.clear();
        this.pausedAddresses.clear();
        this.submittingAddresses.clear();
        console.log('[Orchestrator] ✓ State reset complete');

        // Wait a bit before restarting
        await this.sleep(1000);

        // Reinitialize ROM if we have a challenge
        if (this.currentChallenge) {
          console.log('[Orchestrator] Reinitializing ROM...');
          const noPreMine = this.currentChallenge.no_pre_mine;
          await hashEngine.initRom(noPreMine);

          const maxWait = 60000;
          const startWait = Date.now();
          while (!hashEngine.isRomReady() && (Date.now() - startWait) < maxWait) {
            await this.sleep(500);
          }

          if (hashEngine.isRomReady()) {
            console.log('[Orchestrator] ✓ ROM reinitialized successfully');
          } else {
            console.error('[Orchestrator] ROM initialization timeout after hourly restart');
          }
        }

        console.log('[Orchestrator] ========================================');
        console.log('[Orchestrator] HOURLY RESTART COMPLETE - Resuming mining');
        console.log('[Orchestrator] ========================================');

        // Resume mining if still running
        if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
          this.startMining();
        }

        // Schedule next hourly restart
        this.scheduleHourlyRestart(password);

      } catch (error: any) {
        console.error('[Orchestrator] Hourly restart failed:', error.message);
        // Try to resume mining anyway
        if (this.isRunning && this.currentChallenge && this.currentChallengeId) {
          this.startMining();
        }
        // Still schedule next restart
        this.scheduleHourlyRestart(password);
      }
    }, msUntilNextHour);
  }
}

// Singleton instance
export const miningOrchestrator = new MiningOrchestrator();
