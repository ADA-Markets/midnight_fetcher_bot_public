/**
 * Simplified Mining Orchestrator
 * 6-worker architecture:
 * - Worker 1-4: Normal continuous mining (4 parallel mining workers)
 * - Worker 5: Dev fee mining (on-demand)
 * - Worker 6: Stats monitoring (every 10 seconds)
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { HashClient, StartMiningRequest, MiningStatsResponse } from '@/lib/hash/client';
import { WalletManager, DerivedAddress } from '@/lib/wallet/manager';
import Logger from '@/lib/utils/logger';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { challengeLogger } from '@/lib/storage/challenge-logger';
import { devFeeManager } from '@/lib/devfee/manager';
import { Challenge, MiningStats } from './types';

interface WorkerState {
  workerId: number;
  address: string;
  isRunning: boolean;
  challengeId: string | null;
}

export class SimplifiedOrchestrator extends EventEmitter {
  private hashEngine: HashClient;
  private apiBase: string = 'https://scavenger.prod.gd.midnighttge.io';
  private isRunning: boolean = false;
  private currentChallenge: Challenge | null = null;
  private walletManager: WalletManager | null = null;
  private addresses: DerivedAddress[] = [];
  private workers: WorkerState[] = [];
  private statsInterval: NodeJS.Timeout | null = null;
  private challengePollingInterval: NodeJS.Timeout | null = null;
  private solvedAddresses: Set<string> = new Set(); // Addresses that found solution for current challenge
  private inProgressAddresses: Set<string> = new Set(); // Addresses currently being mined (prevents duplicate mining)
  private userSolutionsCount: number = 0; // Track non-dev-fee solutions
  private isDevFeeMining: boolean = false; // Prevent duplicate dev fee mining
  private startTime: number | null = null;
  private lastHashEngineStats: MiningStatsResponse | null = null;
  private workerRunning: Map<number, boolean> = new Map(); // Track which workers are active
  private solutionTimestamps: Array<{ timestamp: number }> = []; // Track solution timestamps for stats
  private readonly NUM_MINING_WORKERS = 4; // Number of parallel mining workers (reduced to prevent hash engine overwhelm)
  private challengeTransitionStartTime: number | null = null; // When new challenge was first detected
  private pendingChallenge: Challenge | null = null; // New challenge waiting to be activated
  private readonly CHALLENGE_TRANSITION_BUFFER_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

  constructor() {
    super();
    this.hashEngine = new HashClient('http://127.0.0.1:9001');
    Logger.log('mining', `[SimplifiedOrchestrator] Initialized with ${this.NUM_MINING_WORKERS} mining workers + 1 dev fee + 1 stats (4 total workers)`);
  }


  /**
   * Start mining with password (matches old orchestrator API)
   */
  async start(password: string): Promise<void> {
    if (this.isRunning) {
      Logger.warn('mining','[SimplifiedOrchestrator] Already running');
      return;
    }

    // Initialize wallet
    this.walletManager = new WalletManager();
    this.addresses = await this.walletManager.loadWallet(password);

    Logger.log('mining', `[SimplifiedOrchestrator] Loaded wallet with ${this.addresses.length} addresses`);

    this.isRunning = true;
    this.startTime = Date.now();
    Logger.log('mining','[SimplifiedOrchestrator] Starting 6-worker orchestrator (4 mining + 1 dev fee + 1 stats)');

    // Start challenge polling (every 2 seconds)
    this.startChallengePolling();

    // Start stats monitoring (Worker 4 - every 10 seconds)
    this.startStatsMonitoring();

    Logger.log('mining','[SimplifiedOrchestrator] All workers started');
  }

  /**
   * Reinitialize orchestrator (matches old orchestrator API)
   */
  async reinitialize(password: string): Promise<void> {
    Logger.log('mining', '[SimplifiedOrchestrator] Reinitializing orchestrator...');

    // Stop current mining if running
    if (this.isRunning) {
      Logger.log('mining', '[SimplifiedOrchestrator] Stopping current mining session...');
      this.stop();
      await this.sleep(1000); // Give time for cleanup
    }

    // Reset state
    this.currentChallenge = null;
    this.solvedAddresses.clear();
    this.inProgressAddresses.clear();
    this.userSolutionsCount = 0;
    this.workers = [];
    this.workerRunning.clear();

    Logger.log('mining', '[SimplifiedOrchestrator] Reinitialization complete, starting fresh mining session...');

    // Start fresh
    await this.start(password);
  }

  /**
   * Stop mining
   */
  stop(): void {
    this.isRunning = false;

    if (this.challengePollingInterval) {
      clearInterval(this.challengePollingInterval);
      this.challengePollingInterval = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // Reset worker flags
    this.workerRunning.clear();

    Logger.log('mining','[SimplifiedOrchestrator] Stopped');
  }

  /**
   * Poll challenge API and update workers when challenge changes
   */
  private startChallengePolling(): void {
    this.challengePollingInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        // Get challenge from general API endpoint (matches old orchestrator)
        const response = await axios.get(`${this.apiBase}/challenge`);

        // Handle status codes (before/after/active)
        if (response.data.code === 'before') {
          Logger.log('mining', '[SimplifiedOrchestrator] Mining not started yet');
          return;
        }

        if (response.data.code === 'after') {
          Logger.log('mining', '[SimplifiedOrchestrator] Mining period ended');
          this.stop();
          return;
        }

        if (response.data.code !== 'active' || !response.data.challenge) {
          return;
        }

        const newChallenge: Challenge = {
          challenge_id: response.data.challenge.challenge_id,
          difficulty: response.data.challenge.difficulty,
          no_pre_mine: response.data.challenge.no_pre_mine,
          latest_submission: response.data.challenge.latest_submission || '',
          no_pre_mine_hour: response.data.challenge.no_pre_mine_hour || '',
        };

        // Don't skip challenges - we check per-address instead

        // Check if challenge changed
        const challengeChanged = !this.currentChallenge ||
          this.currentChallenge.challenge_id !== newChallenge.challenge_id;

        if (challengeChanged) {
          // If we have a current challenge, enter transition period
          if (this.currentChallenge) {
            // First time detecting new challenge - start transition buffer
            if (!this.pendingChallenge || this.pendingChallenge.challenge_id !== newChallenge.challenge_id) {
              this.pendingChallenge = newChallenge;
              this.challengeTransitionStartTime = Date.now();
              Logger.log('mining',`[SimplifiedOrchestrator] ⏰ New challenge detected: ${newChallenge.challenge_id}`);
              Logger.log('mining',`[SimplifiedOrchestrator] ⏰ Entering 15-minute transition buffer`);
              Logger.log('mining',`[SimplifiedOrchestrator] ⏰ Workers will finish current challenge: ${this.currentChallenge.challenge_id}`);
              Logger.log('mining',`[SimplifiedOrchestrator] ⏰ No new workers will start during this period`);
            }

            // Check if we're still in the transition buffer period
            const transitionElapsedMs = Date.now() - (this.challengeTransitionStartTime || 0);
            const transitionRemainingMs = this.CHALLENGE_TRANSITION_BUFFER_MS - transitionElapsedMs;

            if (transitionRemainingMs > 0) {
              // Still in buffer period - check worker status
              const activeWorkers = Array.from(this.workerRunning.entries())
                .filter(([id, running]) => running && id <= this.NUM_MINING_WORKERS)
                .length;

              // Log status every 30 seconds (every 15th poll at 2-second interval)
              const pollsElapsed = Math.floor(transitionElapsedMs / 2000);
              if (pollsElapsed % 15 === 0) {
                const minutesRemaining = Math.ceil(transitionRemainingMs / 60000);
                Logger.log('mining',`[SimplifiedOrchestrator] ⏰ Transition buffer: ${minutesRemaining} min remaining, ${activeWorkers} workers still active on old challenge`);
              }

              // Don't switch yet - still in buffer period
              return;
            }

            // Buffer period ended - force switch to new challenge
            // Workers will naturally exit their loops when they check currentChallenge
            const activeWorkers = Array.from(this.workerRunning.entries())
              .filter(([id, running]) => running && id <= this.NUM_MINING_WORKERS)
              .length;

            Logger.log('mining',`[SimplifiedOrchestrator] ⏰ Buffer period ended with ${activeWorkers} workers still active`);
            Logger.log('mining',`[SimplifiedOrchestrator] ⏰ Force switching to new challenge - workers will exit their loops`);

            // Mark current challenge as completed and switch immediately
            const completedCount = this.solvedAddresses.size;
            const totalCount = this.addresses.length;
            const completionPercentage = (completedCount / totalCount) * 100;
            Logger.log('mining',`[SimplifiedOrchestrator] ✓ All workers finished. ${completionPercentage.toFixed(1)}% addresses processed for challenge: ${this.currentChallenge.challenge_id}`);
            Logger.log('mining',`[SimplifiedOrchestrator] ✓ Switching to new challenge: ${newChallenge.challenge_id}`);
            challengeLogger.logChallenge({
              ts: new Date().toISOString(),
              challenge_id: this.currentChallenge.challenge_id,
              difficulty: this.currentChallenge.difficulty,
              no_pre_mine: this.currentChallenge.no_pre_mine,
              latest_submission: this.currentChallenge.latest_submission,
              no_pre_mine_hour: this.currentChallenge.no_pre_mine_hour,
              status: 'completed',
            });
          }

          Logger.log('mining',`[SimplifiedOrchestrator] New challenge: ${newChallenge.challenge_id}`);
          Logger.log('mining',`[SimplifiedOrchestrator] Difficulty: ${newChallenge.difficulty}`);

          // Log new challenge as started
          challengeLogger.logChallenge({
            ts: new Date().toISOString(),
            challenge_id: newChallenge.challenge_id,
            difficulty: newChallenge.difficulty,
            no_pre_mine: newChallenge.no_pre_mine,
            latest_submission: newChallenge.latest_submission,
            no_pre_mine_hour: newChallenge.no_pre_mine_hour,
            status: 'started',
          });

          // Initialize ROM in hash service
          await this.hashEngine.init(newChallenge.no_pre_mine);

          // Clear solved addresses and in-progress tracking for new challenge
          this.solvedAddresses.clear();
          this.inProgressAddresses.clear();

          // Update current challenge
          this.currentChallenge = newChallenge;

          // Clear transition tracking
          this.pendingChallenge = null;
          this.challengeTransitionStartTime = null;

          // Start all mining workers (they will process addresses sequentially)
          for (let workerId = 1; workerId <= this.NUM_MINING_WORKERS; workerId++) {
            if (!this.workerRunning.get(workerId)) {
              this.startMiningWorkerLoop(workerId, newChallenge);
            }
          }

          // Check if dev fee mining is needed
          this.checkDevFeeMining(newChallenge);
        }
      } catch (error: any) {
        Logger.error('mining','[SimplifiedOrchestrator] Failed to poll challenge:', error.message);
      }
    }, 2000); // Poll every 2 seconds
  }

  /**
   * Start a mining worker loop (Worker 1 or 2)
   * This loops through all addresses sequentially, mining one at a time
   */
  private async startMiningWorkerLoop(workerId: number, challenge: Challenge): Promise<void> {
    // Mark worker as running
    this.workerRunning.set(workerId, true);

    try {
      while (this.isRunning && this.currentChallenge?.challenge_id === challenge.challenge_id) {
        // CRITICAL: Don't pick up new work during transition buffer
        if (this.pendingChallenge) {
          Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId}: In transition buffer, not picking up new work`);
          break;
        }

        // Find next unsolved address (not solved and not currently being mined)
        // Check receipts to see if we already have a solution for this challenge+address combo
        const nextAddress = this.addresses.find(addr => {
          if (this.solvedAddresses.has(addr.bech32) || this.inProgressAddresses.has(addr.bech32)) {
            return false;
          }

          // Check if we have a receipt for this challenge+address combo
          try {
            const allReceipts = receiptsLogger.readReceipts();
            const hasReceipt = allReceipts.some((r: any) =>
              r.challenge_id === challenge.challenge_id && r.address === addr.bech32
            );
            if (hasReceipt) {
              Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId}: Skipping address ${addr.index} - already has receipt for challenge ${challenge.challenge_id}`);
              this.solvedAddresses.add(addr.bech32); // Mark as solved so we don't check again
              return false;
            }
          } catch (error) {
            // If we can't read receipts, assume not solved
          }

          return true;
        });

        if (!nextAddress) {
          Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId}: All addresses solved or in-progress for current challenge`);
          break;
        }

        // Check if challenge changed before starting new mining operation
        if (this.currentChallenge?.challenge_id !== challenge.challenge_id) {
          Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId}: Challenge changed, exiting loop`);
          break;
        }

        // Mark address as in-progress before mining (prevents other workers from picking it)
        this.inProgressAddresses.add(nextAddress.bech32);
        Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId}: Marked address ${nextAddress.index} as in-progress`);

        try {
          // Mine this address
          await this.startMiningWorker(workerId, nextAddress, challenge);
        } finally {
          // Remove from in-progress (it's now either solved or errored)
          this.inProgressAddresses.delete(nextAddress.bech32);
        }

        // Check again after mining operation completes
        if (this.currentChallenge?.challenge_id !== challenge.challenge_id) {
          Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId}: Challenge changed after mining, exiting loop`);
          break;
        }
      }
    } finally {
      // Mark worker as stopped
      this.workerRunning.set(workerId, false);
      Logger.log('mining', `[SimplifiedOrchestrator] Worker ${workerId} loop ended`);
    }
  }

  /**
   * Start a mining worker (Worker 1 or 2)
   * This runs continuously until a solution is found
   */
  private async startMiningWorker(
    workerId: number,
    addr: DerivedAddress,
    challenge: Challenge
  ): Promise<void> {
    const workerLabel = `Worker ${workerId} [Address ${addr.index}]`;
    Logger.log('mining',`[SimplifiedOrchestrator] Starting ${workerLabel}`);

    // Track worker state
    this.workers.push({
      workerId,
      address: addr.bech32,
      isRunning: true,
      challengeId: challenge.challenge_id,
    });

    let result: any = null;
    let solution: any = null;

    try {
      // Set 30-minute timeout for mining to prevent indefinite hangs
      const MINING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const miningPromise = this.hashEngine.startContinuousMining({
        worker_id: workerId,
        address: addr.bech32,
        challenge: {
          challenge_id: challenge.challenge_id,
          difficulty: challenge.difficulty,
          no_pre_mine: challenge.no_pre_mine,
          latest_submission: challenge.latest_submission,
          no_pre_mine_hour: challenge.no_pre_mine_hour,
        },
      });

      // Race between mining and timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Mining timeout after 30 minutes')), MINING_TIMEOUT_MS);
      });

      result = await Promise.race([miningPromise, timeoutPromise]);

      // Solution found!
      solution = result.solutions[0];
      Logger.log('mining',`[SimplifiedOrchestrator] ========== SOLUTION FOUND ==========`);
      Logger.log('mining',`[SimplifiedOrchestrator] ${workerLabel}`);
      Logger.log('mining',`[SimplifiedOrchestrator] Address: ${addr.bech32}`);
      Logger.log('mining',`[SimplifiedOrchestrator] Nonce: ${solution.nonce}`);
      Logger.log('mining',`[SimplifiedOrchestrator] Hash: ${solution.hash.slice(0, 32)}...`);
      Logger.log('mining',`[SimplifiedOrchestrator] Hashes computed: ${result.hashes_computed}`);
      Logger.log('mining',`[SimplifiedOrchestrator] ====================================`);

      // Check if challenge changed - only reject if it's genuinely a different challenge
      // NOTE: Solutions for old challenges CAN still be submitted and accepted by the server
      if (this.currentChallenge && this.currentChallenge.challenge_id !== challenge.challenge_id) {
        Logger.warn('mining',`[SimplifiedOrchestrator] ${workerLabel}: Challenge changed! Mined for ${challenge.challenge_id}, current is ${this.currentChallenge.challenge_id}`);
        Logger.warn('mining',`[SimplifiedOrchestrator] ${workerLabel}: Discarding solution - server will reject it`);
        // Don't mark as solved - let it retry with new challenge
        return;
      }

      // NOTE: During transition (pendingChallenge exists), we can STILL submit solutions
      // for the old challenge. The server accepts solutions for previous challenges.

      // Submit to Midnight API
      await this.submitSolution(addr, challenge.challenge_id, solution.nonce, false);

      // Mark address as solved
      this.solvedAddresses.add(addr.bech32);

      // Increment user solutions count
      this.userSolutionsCount++;

      // Emit event
      this.emit('solution_found', {
        address: addr.bech32,
        nonce: solution.nonce,
        hash: solution.hash,
      });

      Logger.log('mining',`[SimplifiedOrchestrator] ${workerLabel}: Solution submitted successfully`);
    } catch (error: any) {
      Logger.error('mining',`[SimplifiedOrchestrator] ${workerLabel} error:`, error.message);

      // Handle timeout - worker will retry this address in next loop iteration
      if (error.message?.includes('timeout')) {
        Logger.warn('mining',`[SimplifiedOrchestrator] ${workerLabel}: Mining timeout - will retry address later`);
        // Don't mark as solved - let it retry
        return;
      }

      // Check if solution already exists - if so, mark as solved to avoid retrying
      if ((error.message?.includes('Solution already exists') ||
          error.message?.includes('already exists')) && result && solution) {
        Logger.log('mining',`[SimplifiedOrchestrator] ${workerLabel}: Solution already exists, marking address as solved`);
        this.solvedAddresses.add(addr.bech32);

        // Log as receipt since it was previously accepted (just not by us in this session)
        receiptsLogger.logReceipt({
          ts: new Date().toISOString(),
          address: addr.bech32,
          addressIndex: addr.index,
          challenge_id: challenge.challenge_id,
          nonce: solution.nonce,
          hash: solution.hash,
          crypto_receipt: '(previously submitted)',
          note: 'Solution already exists on server',
        });

        // Increment user solutions count and emit events
        this.userSolutionsCount++;
        this.solutionTimestamps.push({ timestamp: Date.now() });

        this.emit('solution_result', {
          type: 'solution_result',
          address: addr.bech32,
          addressIndex: addr.index,
          success: true,
          message: 'Solution already exists',
        });

        this.emit('solution', {
          type: 'solution',
          address: addr.bech32,
          challengeId: challenge.challenge_id,
          preimage: solution.nonce,
          timestamp: new Date().toISOString(),
        });
      }

      // Don't retry - the worker loop will pick up the next address
      // If this address wasn't solved, it will be retried in the next loop iteration
    } finally {
      // Remove worker from tracking
      this.workers = this.workers.filter(w =>
        !(w.workerId === workerId && w.address === addr.bech32 && w.challengeId === challenge.challenge_id)
      );
    }
  }

  /**
   * Check if dev fee mining is needed (Worker 3)
   */
  private async checkDevFeeMining(challenge: Challenge): Promise<void> {
    if (this.isDevFeeMining) {
      Logger.debug('mining','[SimplifiedOrchestrator] Dev fee mining already in progress');
      return;
    }

    // Check if we should mine for dev fee (every 10 user solutions)
    const shouldMineDevFee = this.userSolutionsCount > 0 && this.userSolutionsCount % 10 === 0;

    if (!shouldMineDevFee) {
      return;
    }

    // Get dev fee address
    const devFeeAddress = await devFeeManager.getDevFeeAddress(challenge.challenge_id);
    if (!devFeeAddress) {
      return;
    }

    if (!this.solvedAddresses.has(devFeeAddress)) {
      Logger.log('mining','[SimplifiedOrchestrator] Starting dev fee mining (Worker 5)');
      this.startDevFeeWorker(challenge, devFeeAddress);
    }
  }

  /**
   * Start dev fee mining worker (Worker 5)
   */
  private async startDevFeeWorker(challenge: Challenge, devFeeAddress: string): Promise<void> {
    this.isDevFeeMining = true;

    const workerLabel = 'Worker 5 [DevFee]';
    Logger.log('mining',`[SimplifiedOrchestrator] Starting ${workerLabel}`);

    // Create fake address object for dev fee
    const devAddr: DerivedAddress = {
      index: -1,
      bech32: devFeeAddress,
      publicKeyHex: '',
      registered: true,
    };

    let result: any = null;
    let solution: any = null;

    try {
      // Set 30-minute timeout for mining to prevent indefinite hangs
      const MINING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const miningPromise = this.hashEngine.startContinuousMining({
        worker_id: 5,
        address: devFeeAddress,
        challenge: {
          challenge_id: challenge.challenge_id,
          difficulty: challenge.difficulty,
          no_pre_mine: challenge.no_pre_mine,
          latest_submission: challenge.latest_submission,
          no_pre_mine_hour: challenge.no_pre_mine_hour,
        },
      });

      // Race between mining and timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Mining timeout after 30 minutes')), MINING_TIMEOUT_MS);
      });

      result = await Promise.race([miningPromise, timeoutPromise]);

      // Solution found!
      solution = result.solutions[0];
      Logger.log('mining',`[SimplifiedOrchestrator] ========== DEV FEE SOLUTION FOUND ==========`);
      Logger.log('mining',`[SimplifiedOrchestrator] ${workerLabel}`);
      Logger.log('mining',`[SimplifiedOrchestrator] Nonce: ${solution.nonce}`);
      Logger.log('mining',`[SimplifiedOrchestrator] Hash: ${solution.hash.slice(0, 32)}...`);
      Logger.log('mining',`[SimplifiedOrchestrator] ============================================`);

      // Submit to Midnight API
      await this.submitSolution(devAddr, challenge.challenge_id, solution.nonce, true);

      // Mark dev fee address as solved
      this.solvedAddresses.add(devFeeAddress);

      // Record dev fee solution (matches old orchestrator)
      devFeeManager.recordDevFeeSolution();
      Logger.log('mining',`[SimplifiedOrchestrator] [DEV FEE] Dev fee solution submitted. Total dev fee solutions: ${devFeeManager.getTotalDevFeeSolutions()}`);

      Logger.log('mining',`[SimplifiedOrchestrator] ${workerLabel}: Dev fee solution submitted successfully`);
    } catch (error: any) {
      Logger.error('mining',`[SimplifiedOrchestrator] ${workerLabel} error:`, error.message);

      // Check if solution already exists - if so, mark as solved to avoid retrying
      if ((error.message?.includes('Solution already exists') ||
          error.message?.includes('already exists')) && result && solution) {
        Logger.log('mining',`[SimplifiedOrchestrator] ${workerLabel}: Dev fee solution already exists, marking address as solved`);
        this.solvedAddresses.add(devFeeAddress);
        devFeeManager.recordDevFeeSolution(); // Still count it

        // Log as receipt since it was previously accepted
        receiptsLogger.logReceipt({
          ts: new Date().toISOString(),
          address: devFeeAddress,
          addressIndex: -1,
          challenge_id: challenge.challenge_id,
          nonce: solution.nonce,
          hash: solution.hash,
          crypto_receipt: '(previously submitted)',
          isDevFee: true,
          note: 'Dev fee solution already exists on server',
        });

        // Emit events
        this.solutionTimestamps.push({ timestamp: Date.now() });

        this.emit('solution_result', {
          type: 'solution_result',
          address: devFeeAddress,
          addressIndex: -1,
          success: true,
          message: 'Dev fee solution already exists',
        });

        this.emit('solution', {
          type: 'solution',
          address: devFeeAddress,
          challengeId: challenge.challenge_id,
          preimage: solution.nonce,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      this.isDevFeeMining = false;
    }
  }

  /**
   * Submit solution to Midnight API
   */
  private async submitSolution(
    address: DerivedAddress,
    challengeId: string,
    nonce: string,
    isDevFee: boolean = false
  ): Promise<void> {
    const submitUrl = `${this.apiBase}/solution/${address.bech32}/${challengeId}/${nonce}`;

    try {
      const response = await axios.post(submitUrl, {}, {
        timeout: 30000,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200 || response.status === 201) {
        const logPrefix = isDevFee ? '[DEV FEE]' : '';
        Logger.log('mining',`[SimplifiedOrchestrator] ${logPrefix} ✓ Solution accepted by server`);

        if (response.data?.crypto_receipt) {
          // Handle crypto_receipt - could be string or object
          const cryptoReceipt = typeof response.data.crypto_receipt === 'string'
            ? response.data.crypto_receipt
            : JSON.stringify(response.data.crypto_receipt);

          Logger.log('mining',`[SimplifiedOrchestrator] ${logPrefix} Crypto receipt: ${cryptoReceipt.slice(0, 32)}...`);

          // Log receipt to file
          receiptsLogger.logReceipt({
            ts: new Date().toISOString(),
            address: address.bech32,
            addressIndex: address.index,
            challenge_id: challengeId,
            nonce: nonce,
            hash: '',
            crypto_receipt: cryptoReceipt,
            isDevFee: isDevFee, // Mark dev fee solutions (matches old orchestrator)
          });
        }

        // Record solution timestamp for stats tracking (matches old orchestrator)
        this.solutionTimestamps.push({ timestamp: Date.now() });

        // Emit solution_result event (matches old orchestrator)
        this.emit('solution_result', {
          type: 'solution_result',
          address: address.bech32,
          addressIndex: address.index,
          success: true,
          message: 'Solution accepted',
        });

        // Emit solution event (matches old orchestrator)
        this.emit('solution', {
          type: 'solution',
          address: address.bech32,
          challengeId: challengeId,
          preimage: nonce,
          timestamp: new Date().toISOString(),
        });

        // Emit solution_submitted event (for compatibility)
        this.emit('solution_submitted', {
          address: address.bech32,
          challengeId,
          nonce,
        });
      } else {
        Logger.warn('mining',`[SimplifiedOrchestrator] ⚠ Solution rejected: ${response.status} ${response.statusText}`);
        Logger.warn('mining',`[SimplifiedOrchestrator] Response:`, response.data);
        // Include the server's error message in the thrown error so we can detect "already exists"
        const serverMessage = response.data?.message || response.statusText;
        throw new Error(`Server rejected solution: ${serverMessage}`);
      }
    } catch (error: any) {
      Logger.error('mining',`[SimplifiedOrchestrator] Failed to submit solution:`, error.message);
      throw error;
    }
  }

  /**
   * Start stats monitoring (Worker 6)
   * Polls hash engine stats every 10 seconds
   */
  private startStatsMonitoring(): void {
    this.statsInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        const stats = await this.hashEngine.getStats();
        this.lastHashEngineStats = stats; // Save for getStats()

        // Calculate expected vs actual hashes
        const expectedHourlyHashes = stats.hash_rate * 3600; // hashes per hour based on current rate
        const actualHashesPerSecond = stats.uptime_seconds > 0
          ? stats.total_hashes / stats.uptime_seconds
          : 0;
        const performanceRatio = stats.hash_rate > 0
          ? (actualHashesPerSecond / stats.hash_rate) * 100
          : 0;

        // Calculate expected solutions per hour based on difficulty
        // Difficulty 6 requires approximately 16,777,216 hashes per solution (2^24)
        // This is an estimate - actual results will vary due to randomness
        const avgHashesPerSolution = 16_777_216; // Approximate for difficulty 6
        const expectedSolutionsPerHour = stats.hash_rate > 0
          ? (expectedHourlyHashes / avgHashesPerSolution)
          : 0;

        Logger.log('mining',`[HashEngine Stats] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        Logger.log('mining',`[HashEngine Stats] Hash Rate: ${this.formatHashRate(stats.hash_rate)}`);
        Logger.log('mining',`[HashEngine Stats] Expected/Hour: ${this.formatHashCount(expectedHourlyHashes)}`);
        Logger.log('mining',`[HashEngine Stats] Total Hashes: ${this.formatHashCount(stats.total_hashes)}`);
        Logger.log('mining',`[HashEngine Stats] Avg Rate: ${this.formatHashRate(actualHashesPerSecond)} (${performanceRatio.toFixed(0)}%)`);
        Logger.log('mining',`[HashEngine Stats] Solutions Found: ${stats.solutions_found}`);
        Logger.log('mining',`[HashEngine Stats] Est. Solutions/Hour: ${expectedSolutionsPerHour.toFixed(2)}`);
        Logger.log('mining',`[HashEngine Stats] Uptime: ${this.formatUptime(stats.uptime_seconds)}`);
        Logger.log('mining',`[HashEngine Stats] Mining Active: ${stats.mining_active ? 'YES' : 'NO'}`);
        Logger.log('mining',`[HashEngine Stats] CPU Mode: ${stats.cpu_mode}`);
        Logger.log('mining',`[HashEngine Stats] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // Emit stats event
        this.emit('stats_update', stats);
      } catch (error: any) {
        Logger.error('mining','[SimplifiedOrchestrator] Failed to get hash engine stats:', error.message);
      }
    }, 10000); // Every 10 seconds (Worker 4)
  }

  /**
   * Format hash rate for display
   */
  private formatHashRate(hashRate: number): string {
    if (hashRate >= 1_000_000) {
      return `${(hashRate / 1_000_000).toFixed(2)} MH/s`;
    } else if (hashRate >= 1_000) {
      return `${(hashRate / 1_000).toFixed(2)} KH/s`;
    } else {
      return `${hashRate.toFixed(0)} H/s`;
    }
  }

  /**
   * Format hash count for display
   */
  private formatHashCount(count: number): string {
    if (count >= 1_000_000_000) {
      return `${(count / 1_000_000_000).toFixed(2)}B`;
    } else if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(2)}M`;
    } else if (count >= 1_000) {
      return `${(count / 1_000).toFixed(2)}K`;
    } else {
      return `${count.toFixed(0)}`;
    }
  }

  /**
   * Format uptime for display
   */
  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get addresses data (matches old orchestrator API)
   */
  getAddressesData() {
    if (!this.isRunning || this.addresses.length === 0) {
      return null;
    }

    // Convert solvedAddresses Set to Map format for compatibility
    const solvedMap = new Map<string, Set<string>>();
    for (const addr of this.addresses) {
      const challengeSet = new Set<string>();
      if (this.solvedAddresses.has(addr.bech32) && this.currentChallenge) {
        challengeSet.add(this.currentChallenge.challenge_id);
      }
      if (challengeSet.size > 0) {
        solvedMap.set(addr.bech32, challengeSet);
      }
    }

    return {
      addresses: this.addresses,
      currentChallengeId: this.currentChallenge?.challenge_id || null,
      solvedAddressChallenges: solvedMap,
    };
  }

  /**
   * Get current configuration (matches old orchestrator API)
   */
  getCurrentConfiguration(): {
    workerThreads: number;
    batchSize: number;
    workerGroupingMode: 'auto' | 'all-on-one' | 'grouped';
    workersPerAddress: number;
  } {
    return {
      workerThreads: 6, // 4 mining + 1 dev fee + 1 stats
      batchSize: 10000, // Internal hash service batch size
      workerGroupingMode: 'auto',
      workersPerAddress: 4,
    };
  }

  /**
   * Update configuration (matches old orchestrator API - no-op in simplified version)
   */
  updateConfiguration(config: {
    workerThreads?: number;
    batchSize?: number;
    workerGroupingMode?: 'auto' | 'all-on-one' | 'grouped';
    workersPerAddress?: number;
    cpuMode?: 'max' | 'normal';
  }): void {
    Logger.log('mining', '[SimplifiedOrchestrator] Configuration update requested');

    // CPU mode is now handled via hash-config.json file (no longer runtime configurable)
    if (config.cpuMode) {
      Logger.log('mining', '[SimplifiedOrchestrator] Note: CPU mode changes require editing hashengine/hash-config.json and restarting hash engine');
    }

    // Other config options are ignored in simplified orchestrator (fixed architecture)
    if (config.workerThreads || config.batchSize || config.workerGroupingMode || config.workersPerAddress) {
      Logger.log('mining', '[SimplifiedOrchestrator] Note: Worker/batch config ignored (fixed 6-worker architecture: 4 mining + 1 dev fee + 1 stats)');
    }
  }

  /**
   * Get current mining stats (matches old orchestrator API)
   */
  getStats(): MiningStats {
    const registeredAddresses = this.addresses.filter(a => a.registered).length;
    const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;

    return {
      active: this.isRunning,
      challengeId: this.currentChallenge?.challenge_id || null,
      solutionsFound: this.userSolutionsCount,
      registeredAddresses: registeredAddresses,
      totalAddresses: this.addresses.length,
      addressesWithReceipts: this.solvedAddresses.size,
      hashRate: this.lastHashEngineStats?.hash_rate || 0,
      uptime: uptime,
      startTime: this.startTime,
      cpuUsage: 0, // Not tracked in simplified orchestrator
      addressesProcessedCurrentChallenge: this.solvedAddresses.size,
      solutionsThisHour: 0, // Not tracked in simplified orchestrator
      solutionsPreviousHour: 0,
      solutionsToday: 0,
      solutionsYesterday: 0,
      workerThreads: 6, // Fixed: 4 mining + 1 dev fee + 1 stats
      config: {
        workerThreads: 6,
        batchSize: 10000, // Internal hash service batch size
        workerGroupingMode: 'auto',
        workersPerAddress: 4,
        cpuMode: (this.lastHashEngineStats?.cpu_mode === 'max' ? 'max' : 'normal') as 'normal' | 'max',
      },
    };
  }
}

// Export singleton instance (using old name for compatibility)
export const miningOrchestrator = new SimplifiedOrchestrator();
