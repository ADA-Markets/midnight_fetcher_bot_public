'use client';

import React, { useEffect, useState, Suspense, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Alert } from '@/components/ui/alert';
import { Modal } from '@/components/ui/modal';
import { Play, Square, Home, Loader2, Activity, Clock, Target, Hash, CheckCircle2, Wallet, Terminal, ChevronDown, ChevronUp, Pause, Play as PlayIcon, Maximize2, Minimize2, Cpu, ListChecks, TrendingUp, TrendingDown, Calendar, Copy, Check, XCircle, Users, Award, Zap, MapPin, AlertCircle, Gauge, MemoryStick as Memory, RefreshCw, Settings, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkerStats {
  workerId: number;
  addressIndex: number;
  address: string;
  hashesComputed: number;
  hashRate: number;
  solutionsFound: number;
  startTime: number;
  lastUpdateTime: number;
  status: 'idle' | 'mining' | 'submitting' | 'completed';
  currentChallenge: string | null;
}

interface MiningStats {
  active: boolean;
  challengeId: string | null;
  solutionsFound: number;
  registeredAddresses: number;
  totalAddresses: number;
  hashRate: number;
  uptime: number;
  startTime: number | null;
  cpuUsage: number;
  addressesProcessedCurrentChallenge: number;
  solutionsThisHour: number;
  solutionsPreviousHour: number;
  solutionsToday: number;
  solutionsYesterday: number;
  workerThreads: number;
}

interface LogEntry {
  timestamp: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

interface ReceiptEntry {
  ts: string;
  address: string;
  addressIndex?: number;
  challenge_id: string;
  nonce: string;
  hash?: string;
}

interface ErrorEntry {
  ts: string;
  address: string;
  addressIndex?: number;
  challenge_id: string;
  nonce: string;
  hash?: string;
  error: string;
}

interface AddressHistory {
  addressIndex: number;
  address: string;
  challengeId: string;
  successCount: number;
  failureCount: number;
  totalAttempts: number;
  status: 'success' | 'failed' | 'pending';
  lastAttempt: string;
  failures: Array<{
    ts: string;
    nonce: string;
    hash: string;
    error: string;
  }>;
  successTimestamp?: string;
}

interface HistoryData {
  receipts: ReceiptEntry[];
  errors: ErrorEntry[];
  addressHistory: AddressHistory[];
  summary: {
    totalSolutions: number;
    totalErrors: number;
    successRate: string;
  };
}

function MiningDashboardContent() {
  const router = useRouter();
  const [password, setPassword] = useState<string | null>(null);

  const [stats, setStats] = useState<MiningStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationProgress, setRegistrationProgress] = useState<{
    current: number;
    total: number;
    currentAddress: string;
    message: string;
  } | null>(null);
  const [showLogs, setShowLogs] = useState(true);
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'success' | 'error' | 'warning'>('all');
  const [autoFollow, setAutoFollow] = useState(true); // Auto-scroll to bottom
  const [logHeight, setLogHeight] = useState<'small' | 'medium' | 'large'>('medium');
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history' | 'rewards' | 'workers' | 'addresses' | 'logs' | 'scale' | 'devfee' | 'consolidate'>('dashboard');
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'success' | 'error'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [failureModalOpen, setFailureModalOpen] = useState(false);
  const [selectedAddressHistory, setSelectedAddressHistory] = useState<AddressHistory | null>(null);

  // Workers state
  const [workers, setWorkers] = useState<Map<number, WorkerStats>>(new Map());

  // Scale tab state
  const [scaleSpecs, setScaleSpecs] = useState<any>(null);
  const [scaleRecommendations, setScaleRecommendations] = useState<any>(null);
  const [scaleLoading, setScaleLoading] = useState(false);
  const [scaleError, setScaleError] = useState<string | null>(null);
  const [editedWorkerThreads, setEditedWorkerThreads] = useState<number | null>(null);
  const [editedBatchSize, setEditedBatchSize] = useState<number | null>(null);
  const [applyingChanges, setApplyingChanges] = useState(false);
  const [showApplyConfirmation, setShowApplyConfirmation] = useState(false);

  // Addresses state
  const [addressesData, setAddressesData] = useState<any | null>(null);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [addressFilter, setAddressFilter] = useState<'all' | 'solved' | 'unsolved' | 'registered' | 'unregistered'>('all');

  // Rewards state
  const [rewardsData, setRewardsData] = useState<any | null>(null);
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [rewardsView, setRewardsView] = useState<'hourly' | 'daily'>('daily');
  const [rewardsLastRefresh, setRewardsLastRefresh] = useState<number | null>(null);

  // Consolidate state
  const [consolidateLoading, setConsolidateLoading] = useState(false);
  const consolidateRunningRef = useRef(false); // Ref to track running state in async loop
  const [consolidateProgress, setConsolidateProgress] = useState<{
    current: number;
    total: number;
    successCount: number;
    failCount: number;
    currentAddress: string;
  } | null>(null);
  const [destinationAddressIndex, setDestinationAddressIndex] = useState<number>(0);
  const [consolidatePassword, setConsolidatePassword] = useState<string>('');
  const [consolidateResults, setConsolidateResults] = useState<Array<{
    index: number;
    address: string;
    status: 'success' | 'failed' | 'pending' | 'skipped';
    message?: string;
    solutionsConsolidated?: number;
  }>>([]);

  // DevFee state
  const [devFeeEnabled, setDevFeeEnabled] = useState<boolean>(true);
  const [devFeeLoading, setDevFeeLoading] = useState(false);
  const [devFeeData, setDevFeeData] = useState<any | null>(null);
  const [historyLastRefresh, setHistoryLastRefresh] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    // Retrieve password from sessionStorage
    const storedPassword = sessionStorage.getItem('walletPassword');
    if (!storedPassword) {
      // Redirect to wallet load page if no password found
      router.push('/wallet/load');
      return;
    }
    setPassword(storedPassword);

    // Check mining status on load
    checkStatus();
  }, []);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    // Only add logs if not paused
    if (!autoFollow) return;
    setLogs(prev => [...prev, { timestamp: Date.now(), message, type }].slice(-200)); // Keep last 200 logs
  };

  // Auto-scroll effect
  useEffect(() => {
    if (autoFollow && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoFollow]);

  useEffect(() => {
    if (!stats?.active) return;

    // Connect to SSE stream for real-time updates
    const eventSource = new EventSource('/api/mining/stream');

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'stats') {
        setStats(data.stats);

        // Update registration status based on stats
        if (data.stats.registeredAddresses < data.stats.totalAddresses) {
          setIsRegistering(true);
        } else {
          setIsRegistering(false);
          setRegistrationProgress(null); // Clear progress when done
        }

        // Don't log generic stats - let the specific events (solution_submit, mining_start, etc.) handle logging
      } else if (data.type === 'registration_progress') {
        // Update registration progress state
        setRegistrationProgress({
          current: data.current,
          total: data.total,
          currentAddress: data.address,
          message: data.message,
        });

        // Log registration events
        if (data.success) {
          addLog(`✅ ${data.message}`, 'success');
        } else if (data.message.includes('Failed')) {
          addLog(`❌ ${data.message}`, 'error');
        } else {
          addLog(`🔄 ${data.message}`, 'info');
        }
      } else if (data.type === 'mining_start') {
        addLog(`🔨 Worker ${data.addressIndex}: Starting mining for challenge ${data.challengeId.slice(0, 12)}...`, 'info');
      } else if (data.type === 'hash_progress') {
        addLog(`⚡ Worker ${data.addressIndex}: ${data.hashesComputed.toLocaleString()} hashes computed`, 'info');
      } else if (data.type === 'solution_submit') {
        addLog(`💎 Worker ${data.addressIndex}: Solution found! Submitting nonce ${data.nonce}...`, 'success');
      } else if (data.type === 'solution_result') {
        if (data.success) {
          addLog(`✅ Solution for address ${data.addressIndex} ACCEPTED! ${data.message}`, 'success');
        } else {
          addLog(`❌ Solution for address ${data.addressIndex} REJECTED: ${data.message}`, 'error');
        }
      } else if (data.type === 'worker_update') {
        // Update worker stats
        setWorkers(prev => {
          const newWorkers = new Map(prev);
          newWorkers.set(data.workerId, {
            workerId: data.workerId,
            addressIndex: data.addressIndex,
            address: data.address,
            hashesComputed: data.hashesComputed,
            hashRate: data.hashRate,
            solutionsFound: data.solutionsFound,
            startTime: prev.get(data.workerId)?.startTime || Date.now(),
            lastUpdateTime: Date.now(),
            status: data.status,
            currentChallenge: data.currentChallenge,
          });
          return newWorkers;
        });
      } else if (data.type === 'error') {
        setError(data.message);
        addLog(`Error: ${data.message}`, 'error');
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      addLog('Stream connection closed', 'warning');
    };

    return () => {
      eventSource.close();
    };
  }, [stats?.active]);

  const checkStatus = async () => {
    try {
      const response = await fetch('/api/mining/status');
      const data = await response.json();
      if (data.success) {
        setStats(data.stats);
      }
    } catch (err: any) {
      console.error('Failed to check status:', err);
    }
  };

  const handleStartMining = async () => {
    if (!password) {
      setError('Password not provided');
      return;
    }

    setLoading(true);
    setError(null);
    setLogs([]); // Clear previous logs
    addLog('Initializing hash engine...', 'info');
    setIsRegistering(true);

    try {
      addLog('Loading wallet addresses...', 'info');
      const response = await fetch('/api/mining/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start mining');
      }

      addLog('Mining started successfully', 'success');
      addLog(`Starting registration of ${data.stats.totalAddresses} addresses...`, 'info');
      setStats(data.stats);
    } catch (err: any) {
      setError(err.message);
      addLog(`Failed to start mining: ${err.message}`, 'error');
      setIsRegistering(false);
    } finally {
      setLoading(false);
    }
  };

  const handleStopMining = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/mining/stop', {
        method: 'POST',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to stop mining');
      }

      await checkStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const fetchHistory = async () => {
    try {
      setHistoryLoading(true);
      const response = await fetch('/api/mining/history');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch history');
      }

      setHistory(data);
      setHistoryLastRefresh(Date.now());
    } catch (err: any) {
      console.error('Failed to fetch history:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchRewards = async () => {
    try {
      setRewardsLoading(true);
      const response = await fetch('/api/stats');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch rewards');
      }

      setRewardsData(data.stats);
      setRewardsLastRefresh(Date.now());
    } catch (err: any) {
      console.error('Failed to fetch rewards:', err);
      addLog(`Failed to load rewards: ${err.message}`, 'error');
    } finally {
      setRewardsLoading(false);
    }
  };

  const fetchAddresses = async () => {
    try {
      setAddressesLoading(true);
      const response = await fetch('/api/mining/addresses');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch addresses');
      }

      setAddressesData(data);
    } catch (err: any) {
      console.error('Failed to fetch addresses:', err);
    } finally {
      setAddressesLoading(false);
    }
  };

  const fetchScaleData = async () => {
    setScaleLoading(true);
    setScaleError(null);

    try {
      const response = await fetch('/api/system/specs');
      const data = await response.json();

      if (data.success) {
        setScaleSpecs(data.specs);
        setScaleRecommendations(data.recommendations);
        // Initialize edited values with current values
        setEditedWorkerThreads(data.recommendations.workerThreads.current);
        setEditedBatchSize(data.recommendations.batchSize.current);
      } else {
        setScaleError(data.error || 'Failed to load system specifications');
      }
    } catch (err: any) {
      setScaleError(err.message || 'Failed to connect to API');
    } finally {
      setScaleLoading(false);
    }
  };

  const fetchDevFeeStatus = async () => {
    setDevFeeLoading(true);
    try {
      const response = await fetch('/api/devfee/status');
      const data = await response.json();

      if (data.success) {
        setDevFeeEnabled(data.enabled);
        setDevFeeData(data);
      } else {
        console.error('Failed to fetch dev fee status:', data.error);
      }
    } catch (err: any) {
      console.error('Failed to fetch dev fee status:', err.message);
    } finally {
      setDevFeeLoading(false);
    }
  };

  const toggleDevFee = async (enabled: boolean) => {
    setDevFeeLoading(true);
    try {
      const response = await fetch('/api/devfee/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json();

      if (data.success) {
        setDevFeeEnabled(data.enabled);
        console.log(data.message);
      } else {
        console.error('Failed to update dev fee status:', data.error);
        // Revert toggle on error
        setDevFeeEnabled(!enabled);
      }
    } catch (err: any) {
      console.error('Failed to update dev fee status:', err.message);
      // Revert toggle on error
      setDevFeeEnabled(!enabled);
    } finally {
      setDevFeeLoading(false);
    }
  };

  const applyPerformanceChanges = async () => {
    if (!editedWorkerThreads || !editedBatchSize) {
      return;
    }

    setApplyingChanges(true);
    try {
      const response = await fetch('/api/mining/update-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerThreads: editedWorkerThreads,
          batchSize: editedBatchSize,
        }),
      });

      const data = await response.json();

      if (data.success) {
        // Close confirmation dialog
        setShowApplyConfirmation(false);

        // Restart mining with new configuration
        await handleStopMining();
        await new Promise(resolve => setTimeout(resolve, 1000));
        await handleStartMining();

        // Refresh scale data to show updated values
        await fetchScaleData();
      } else {
        setScaleError(data.error || 'Failed to apply changes');
      }
    } catch (err: any) {
      setScaleError(err.message || 'Failed to apply changes');
    } finally {
      setApplyingChanges(false);
    }
  };

  const hasChanges = () => {
    if (!scaleRecommendations) return false;
    return (
      editedWorkerThreads !== scaleRecommendations.workerThreads.current ||
      editedBatchSize !== scaleRecommendations.batchSize.current
    );
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const formatTimeSince = (timestamp: number | null) => {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((currentTime - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  };

  // Load history when switching to history tab and auto-refresh every 30 seconds
  useEffect(() => {
    if (activeTab === 'history') {
      // Always fetch when switching to history tab
      fetchHistory();

      // Set up auto-refresh interval
      const intervalId = setInterval(() => {
        fetchHistory();
      }, 30000); // Refresh every 30 seconds

      // Cleanup interval when tab changes or component unmounts
      return () => clearInterval(intervalId);
    }
  }, [activeTab]);

  // Load rewards when switching to rewards tab
  useEffect(() => {
    if (activeTab === 'rewards') {
      fetchRewards();
    }
  }, [activeTab]);

  // Load addresses when switching to addresses tab
  useEffect(() => {
    if (activeTab === 'addresses') {
      fetchAddresses();
    }
  }, [activeTab]);

  // Load scale data when switching to scale tab
  useEffect(() => {
    if (activeTab === 'scale') {
      fetchScaleData();
    }
  }, [activeTab]);

  // Load dev fee status when switching to devfee tab
  useEffect(() => {
    if (activeTab === 'devfee') {
      fetchDevFeeStatus();
    }
  }, [activeTab]);

  // Update refresh time display every second
  useEffect(() => {
    const interval = setInterval(() => {
      // Force re-render to update time display
      setCurrentTime(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <Loader2 className="w-12 h-12 animate-spin text-blue-500 mx-auto" />
          <p className="text-lg text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen p-4 md:p-8 overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/10 via-blue-900/10 to-gray-900 pointer-events-none" />
      <div className="absolute top-20 left-20 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-20 right-20 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
              Mining Dashboard
            </h1>
            <div className="flex items-center gap-2">
              {stats.active ? (
                <>
                  <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                  <span className="text-green-400 font-semibold">Mining Active</span>
                </>
              ) : (
                <>
                  <div className="w-3 h-3 bg-gray-500 rounded-full" />
                  <span className="text-gray-400">Mining Stopped</span>
                </>
              )}
            </div>
          </div>
          <div className="flex gap-3">
            {!stats.active ? (
              <Button
                onClick={handleStartMining}
                disabled={loading}
                variant="success"
                size="md"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Initializing...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Start Mining
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={handleStopMining}
                disabled={loading}
                variant="danger"
                size="md"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square className="w-4 h-4" />
                    Stop Mining
                  </>
                )}
              </Button>
            )}
            <Button
              onClick={() => {
                // Clear password from sessionStorage when leaving
                sessionStorage.removeItem('walletPassword');
                router.push('/');
              }}
              variant="outline"
              size="md"
            >
              <Home className="w-4 h-4" />
              Back to Home
            </Button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-2 border-b border-gray-700">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'dashboard'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Activity className="w-4 h-4 inline mr-2" />
            Dashboard
            {activeTab === 'dashboard' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'history'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Calendar className="w-4 h-4 inline mr-2" />
            History
            {activeTab === 'history' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('rewards')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'rewards'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <TrendingUp className="w-4 h-4 inline mr-2" />
            Rewards
            {activeTab === 'rewards' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('workers')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'workers'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Users className="w-4 h-4 inline mr-2" />
            Workers
            {activeTab === 'workers' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('addresses')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'addresses'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <MapPin className="w-4 h-4 inline mr-2" />
            Addresses
            {activeTab === 'addresses' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('scale')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'scale'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Gauge className="w-4 h-4 inline mr-2" />
            Scale
            {activeTab === 'scale' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('devfee')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'devfee'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Award className="w-4 h-4 inline mr-2" />
            Dev Fee
            {activeTab === 'devfee' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('consolidate')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'consolidate'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Wallet className="w-4 h-4 inline mr-2" />
            Consolidate
            {activeTab === 'consolidate' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={cn(
              'px-6 py-3 font-medium transition-colors relative',
              activeTab === 'logs'
                ? 'text-blue-400'
                : 'text-gray-400 hover:text-gray-300'
            )}
          >
            <Terminal className="w-4 h-4 inline mr-2" />
            Logs
            {activeTab === 'logs' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
            )}
          </button>
        </div>

        {/* Error Display */}
        {error && <Alert variant="error">{error}</Alert>}

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <>
            {/* Redesigned Stats - Compact Hero Section */}
            <>
              {/* Primary Stats - Hero Cards */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Current Challenge Card with Mining Status */}
                <Card variant="bordered" className="bg-gradient-to-br from-blue-900/20 to-blue-800/10 border-blue-700/50">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-3 bg-blue-500/20 rounded-lg">
                          <Target className="w-6 h-6 text-blue-400" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm text-gray-400 font-medium">Current Challenge</p>
                            {stats.active && (
                              <span className="flex items-center gap-1.5 text-xs font-semibold text-green-400">
                                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                                Mining
                              </span>
                            )}
                          </div>
                          <p className="text-2xl font-bold text-white mt-1">
                            {stats.challengeId ? stats.challengeId.slice(2, 10) : 'Waiting...'}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">Progress</span>
                        <span className="font-semibold text-white">
                          {stats.addressesProcessedCurrentChallenge} / {stats.totalAddresses}
                        </span>
                      </div>
                      <div className="w-full bg-gray-700/50 rounded-full h-2">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${stats.active ? 'bg-blue-500' : 'bg-gray-500'}`}
                          style={{ width: `${(stats.addressesProcessedCurrentChallenge / stats.totalAddresses) * 100}%` }}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Solutions Found Card */}
                <Card variant="bordered" className="bg-gradient-to-br from-green-900/20 to-green-800/10 border-green-700/50">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-3 bg-green-500/20 rounded-lg">
                          <CheckCircle2 className="w-6 h-6 text-green-400" />
                        </div>
                        <div>
                          <p className="text-sm text-gray-400 font-medium">Solutions Found</p>
                          <p className="text-4xl font-bold text-white mt-1">{stats.solutionsFound}</p>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-gray-400">This Hour</p>
                        <p className="text-lg font-semibold text-white">{stats.solutionsThisHour}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Today</p>
                        <p className="text-lg font-semibold text-white">{stats.solutionsToday}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Hash Rate & Performance Card */}
                <Card variant="bordered" className="bg-gradient-to-br from-purple-900/20 to-purple-800/10 border-purple-700/50">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-3 bg-purple-500/20 rounded-lg">
                          <Hash className="w-6 h-6 text-purple-400" />
                        </div>
                        <div>
                          <p className="text-sm text-gray-400 font-medium">Hash Rate</p>
                          <p className="text-2xl font-bold text-white mt-1">
                            {stats.hashRate > 0 ? `${stats.hashRate.toFixed(0)}` : '---'}
                            <span className="text-lg text-gray-400 ml-1">H/s</span>
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-gray-400">Workers</p>
                        <p className="text-lg font-semibold text-white">{stats.workerThreads}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">CPU</p>
                        <p className="text-lg font-semibold text-white">
                          {stats.cpuUsage != null ? `${stats.cpuUsage.toFixed(0)}%` : 'N/A'}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Secondary Stats Row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card variant="bordered">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <Clock className="w-5 h-5 text-gray-400" />
                      <div>
                        <p className="text-xs text-gray-500">Uptime</p>
                        <p className="text-base font-semibold text-white">{formatUptime(stats.uptime)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card variant="bordered">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <Wallet className="w-5 h-5 text-gray-400" />
                      <div>
                        <p className="text-xs text-gray-500">Addresses</p>
                        <p className="text-base font-semibold text-white">
                          {stats.registeredAddresses} / {stats.totalAddresses}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card variant="bordered">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <TrendingUp className={`w-5 h-5 ${stats.solutionsThisHour >= stats.solutionsPreviousHour ? 'text-green-400' : 'text-gray-400'}`} />
                      <div>
                        <p className="text-xs text-gray-500">Hourly Trend</p>
                        <p className="text-base font-semibold text-white">
                          {stats.solutionsThisHour >= stats.solutionsPreviousHour ? '+' : ''}
                          {stats.solutionsThisHour - stats.solutionsPreviousHour}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card variant="bordered">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <Calendar className={`w-5 h-5 ${stats.solutionsToday >= stats.solutionsYesterday ? 'text-green-400' : 'text-gray-400'}`} />
                      <div>
                        <p className="text-xs text-gray-500">Daily Trend</p>
                        <p className="text-base font-semibold text-white">
                          {stats.solutionsToday >= stats.solutionsYesterday ? '+' : ''}
                          {stats.solutionsToday - stats.solutionsYesterday}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Registration Progress Alert - Only show when mining is active */}
              {stats.active && isRegistering && stats.registeredAddresses < stats.totalAddresses && (
                <Alert variant="info" title="Registering Addresses">
                  <div className="space-y-3">
                    <p>Registering mining addresses with the network...</p>

                    {/* Progress Bar */}
                    <div className="flex items-center gap-3">
                      <div className="flex-1 bg-gray-700 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-blue-500 h-full transition-all duration-300 ease-out"
                          style={{ width: `${(stats.registeredAddresses / stats.totalAddresses) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-semibold tabular-nums">
                        {stats.registeredAddresses} / {stats.totalAddresses}
                      </span>
                    </div>

                    {/* Current Registration Status */}
                    {registrationProgress && (
                      <div className="flex items-center gap-2 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                        <span className="text-gray-300">{registrationProgress.message}</span>
                      </div>
                    )}

                    {/* Estimated Time Remaining */}
                    {registrationProgress && registrationProgress.total > 0 && (
                      <div className="text-xs text-gray-400">
                        {registrationProgress.current > 0 && (
                          <>
                            Estimated time remaining: ~
                            {Math.ceil(
                              (registrationProgress.total - registrationProgress.current) * 1.5
                            )}s
                            <span className="text-gray-500 ml-2">(~1.5s per address)</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </Alert>
              )}
            </>
          </>
        )}


        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="space-y-6">
            {historyLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
              </div>
            ) : history ? (
              <>
                {/* Summary Stats - Hero Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Total Solutions Card */}
                  <Card variant="bordered" className="bg-gradient-to-br from-green-900/20 to-green-800/10 border-green-700/50">
                    <CardContent className="p-6">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-green-500/20 rounded-lg">
                          <CheckCircle2 className="w-6 h-6 text-green-400" />
                        </div>
                        <div>
                          <p className="text-sm text-gray-400 font-medium">Total Solutions</p>
                          <p className="text-4xl font-bold text-white mt-1">{history.summary.totalSolutions}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Failed Submissions Card */}
                  <Card variant="bordered" className={cn(
                    "bg-gradient-to-br border-red-700/50",
                    history.summary.totalErrors > 0
                      ? "from-red-900/20 to-red-800/10"
                      : "from-gray-900/20 to-gray-800/10 border-gray-700/50"
                  )}>
                    <CardContent className="p-6">
                      <div className="flex items-center gap-3 mb-2">
                        <div className={cn(
                          "p-3 rounded-lg",
                          history.summary.totalErrors > 0 ? "bg-red-500/20" : "bg-gray-500/20"
                        )}>
                          <XCircle className={cn(
                            "w-6 h-6",
                            history.summary.totalErrors > 0 ? "text-red-400" : "text-gray-400"
                          )} />
                        </div>
                        <div>
                          <p className="text-sm text-gray-400 font-medium">Failed Submissions</p>
                          <p className="text-4xl font-bold text-white mt-1">{history.summary.totalErrors}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Success Rate Card */}
                  <Card variant="bordered" className="bg-gradient-to-br from-blue-900/20 to-blue-800/10 border-blue-700/50">
                    <CardContent className="p-6">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-blue-500/20 rounded-lg">
                          <TrendingUp className="w-6 h-6 text-blue-400" />
                        </div>
                        <div>
                          <p className="text-sm text-gray-400 font-medium">Success Rate</p>
                          <p className="text-4xl font-bold text-white mt-1">{history.summary.successRate}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Filter Buttons with improved styling */}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setHistoryFilter('all')}
                    className={cn(
                      'px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                      historyFilter === 'all'
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
                    )}
                  >
                    All ({history.addressHistory.length})
                  </button>
                  <button
                    onClick={() => setHistoryFilter('success')}
                    className={cn(
                      'px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                      historyFilter === 'success'
                        ? 'bg-green-600 text-white shadow-lg shadow-green-500/30'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
                    )}
                  >
                    Success ({history.addressHistory.filter(h => h.status === 'success').length})
                  </button>
                  <button
                    onClick={() => setHistoryFilter('error')}
                    className={cn(
                      'px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                      historyFilter === 'error'
                        ? 'bg-red-600 text-white shadow-lg shadow-red-500/30'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
                    )}
                  >
                    Failed ({history.addressHistory.filter(h => h.status === 'failed').length})
                  </button>
                  <div className="ml-auto flex items-center gap-3">
                    <span className="text-sm text-gray-400">
                      <Clock className="w-4 h-4 inline mr-1" />
                      {formatTimeSince(historyLastRefresh)}
                    </span>
                    <Button
                      onClick={fetchHistory}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                    >
                      <Activity className="w-4 h-4" />
                      Refresh
                    </Button>
                  </div>
                </div>

                {/* Address History Table */}
                <Card variant="bordered" className="bg-gradient-to-br from-gray-900/40 to-gray-800/20">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <ListChecks className="w-5 h-5 text-blue-400" />
                      <CardTitle className="text-xl">Solution History by Address</CardTitle>
                    </div>
                    <CardDescription>
                      Each row represents one address's attempt at a challenge
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[600px] overflow-y-auto">
                      {history.addressHistory.length === 0 ? (
                        <div className="text-center py-12 text-gray-500">
                          <Calendar className="w-16 h-16 mx-auto mb-4 opacity-50" />
                          <p className="text-lg">No mining history yet</p>
                          <p className="text-sm">Start mining to see your solutions here</p>
                        </div>
                      ) : (
                        history.addressHistory
                          .filter(h => {
                            // Filter out dev fee addresses (index -1)
                            if (h.addressIndex === -1) return false;

                            if (historyFilter === 'all') return true;
                            if (historyFilter === 'success') return h.status === 'success';
                            if (historyFilter === 'error') return h.status === 'failed';
                            return true;
                          })
                          .map((addressHistory, index) => (
                            <div
                              key={`${addressHistory.addressIndex}-${addressHistory.challengeId}`}
                              className={cn(
                                'p-5 rounded-lg border-2 transition-all duration-200 cursor-pointer',
                                addressHistory.status === 'success'
                                  ? 'bg-gradient-to-r from-green-900/20 to-green-800/10 border-green-700/50 hover:border-green-600/70 hover:shadow-lg hover:shadow-green-500/10'
                                  : 'bg-gradient-to-r from-red-900/20 to-red-800/10 border-red-700/50 hover:border-red-600/70 hover:shadow-lg hover:shadow-red-500/10'
                              )}
                              onClick={() => {
                                if (addressHistory.failureCount > 0) {
                                  setSelectedAddressHistory(addressHistory);
                                  setFailureModalOpen(true);
                                }
                              }}
                            >
                              <div className="flex items-center justify-between gap-4">
                                {/* Left: Address Info */}
                                <div className="flex items-center gap-4 flex-1">
                                  <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-gray-800 flex items-center justify-center">
                                    <span className="text-xl font-bold text-gray-300">#{addressHistory.addressIndex}</span>
                                  </div>

                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      <span className="text-white font-mono text-sm truncate">
                                        {addressHistory.address.slice(0, 24)}...
                                      </span>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          copyToClipboard(addressHistory.address, `addr-hist-${index}`);
                                        }}
                                        className="text-gray-400 hover:text-white transition-colors"
                                      >
                                        {copiedId === `addr-hist-${index}` ? (
                                          <Check className="w-3 h-3 text-green-400" />
                                        ) : (
                                          <Copy className="w-3 h-3" />
                                        )}
                                      </button>
                                    </div>
                                    <div className="text-xs text-gray-500">
                                      Challenge: {addressHistory.challengeId.slice(0, 16)}...
                                    </div>
                                  </div>
                                </div>

                                {/* Middle: Stats */}
                                <div className="flex items-center gap-6">
                                  <div className="text-center">
                                    <div className="text-xs text-gray-400">Attempts</div>
                                    <div className="text-lg font-bold text-white">{addressHistory.totalAttempts}</div>
                                  </div>

                                  {addressHistory.failureCount > 0 && (
                                    <div className="text-center">
                                      <div className="text-xs text-gray-400">Failures</div>
                                      <div className="text-lg font-bold text-red-400">{addressHistory.failureCount}</div>
                                    </div>
                                  )}

                                  {addressHistory.successCount > 0 && (
                                    <div className="text-center">
                                      <div className="text-xs text-gray-400">Success</div>
                                      <div className="text-lg font-bold text-green-400">{addressHistory.successCount}</div>
                                    </div>
                                  )}

                                  <div className="text-center">
                                    <div className="text-xs text-gray-400">Last Attempt</div>
                                    <div className="text-sm font-medium text-white">
                                      {new Date(addressHistory.lastAttempt).toLocaleDateString('en-US', {
                                        month: 'short',
                                        day: 'numeric',
                                        year: 'numeric'
                                      })}
                                    </div>
                                    <div className="text-xs text-gray-500">
                                      {new Date(addressHistory.lastAttempt).toLocaleTimeString('en-US', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit'
                                      })}
                                    </div>
                                  </div>
                                </div>

                                {/* Right: Status Badge */}
                                <div className="flex items-center gap-3">
                                  {addressHistory.status === 'success' ? (
                                    <div className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-500/20 border-2 border-green-500/50 shadow-lg shadow-green-500/20">
                                      <CheckCircle2 className="w-5 h-5 text-green-400" />
                                      <span className="text-green-400 font-bold">Success</span>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-red-500/20 border-2 border-red-500/50 shadow-lg shadow-red-500/20">
                                      <XCircle className="w-5 h-5 text-red-400" />
                                      <span className="text-red-400 font-bold">Failed</span>
                                    </div>
                                  )}

                                  {addressHistory.failureCount > 0 && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedAddressHistory(addressHistory);
                                        setFailureModalOpen(true);
                                      }}
                                      className="p-3 rounded-lg bg-yellow-500/20 border border-yellow-500/50 hover:bg-yellow-500/30 transition-all duration-200 hover:shadow-lg hover:shadow-yellow-500/20"
                                      title="View failure details"
                                    >
                                      <AlertCircle className="w-5 h-5 text-yellow-400" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Failure Details Modal */}
                <Modal
                  isOpen={failureModalOpen}
                  onClose={() => setFailureModalOpen(false)}
                  title={`Failure Details - Address #${selectedAddressHistory?.addressIndex}`}
                  size="lg"
                >
                  {selectedAddressHistory && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4 p-4 bg-gray-800 rounded-lg">
                        <div>
                          <div className="text-sm text-gray-400">Address</div>
                          <div className="text-white font-mono text-sm">{selectedAddressHistory.address}</div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400">Challenge</div>
                          <div className="text-white font-mono text-sm">{selectedAddressHistory.challengeId}</div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400">Total Attempts</div>
                          <div className="text-white text-lg font-bold">{selectedAddressHistory.totalAttempts}</div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400">Failures</div>
                          <div className="text-red-400 text-lg font-bold">{selectedAddressHistory.failureCount}</div>
                        </div>
                      </div>

                      <div>
                        <h3 className="text-lg font-semibold text-white mb-3">Failure Log</h3>
                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                          {selectedAddressHistory.failures.map((failure, idx) => (
                            <div key={idx} className="p-3 bg-red-900/10 border border-red-700/50 rounded-lg">
                              <div className="flex items-start justify-between gap-4 mb-2">
                                <span className="text-xs text-gray-400">{formatDate(failure.ts)}</span>
                                <span className="text-xs text-gray-500 font-mono">Nonce: {failure.nonce}</span>
                              </div>
                              <div className="text-sm text-red-300">
                                <span className="text-red-400 font-semibold">Error: </span>
                                {failure.error}
                              </div>
                              {failure.hash && (
                                <div className="text-xs text-gray-500 font-mono mt-1">
                                  Hash: {failure.hash}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </Modal>
              </>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <p>No history data available</p>
              </div>
            )}
          </div>
        )}

        {/* Rewards Tab */}
        {activeTab === 'rewards' && (
          <div className="space-y-6">
            {rewardsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
              </div>
            ) : !rewardsData ? (
              <Card variant="bordered">
                <CardContent className="text-center py-12">
                  <Award className="w-16 h-16 mx-auto mb-4 opacity-50 text-gray-500" />
                  <p className="text-gray-400 text-lg">No rewards data available yet</p>
                  <p className="text-gray-500 text-sm mt-2">Start mining to earn rewards</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* View Toggle with improved styling */}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setRewardsView('hourly')}
                    className={cn(
                      'px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                      rewardsView === 'hourly'
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
                    )}
                  >
                    <Clock className="w-4 h-4 inline mr-2" />
                    Hourly
                  </button>
                  <button
                    onClick={() => setRewardsView('daily')}
                    className={cn(
                      'px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                      rewardsView === 'daily'
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
                    )}
                  >
                    <Calendar className="w-4 h-4 inline mr-2" />
                    Daily
                  </button>
                  <div className="ml-auto flex items-center gap-3">
                    <span className="text-sm text-gray-400">
                      <Clock className="w-4 h-4 inline mr-1" />
                      {formatTimeSince(rewardsLastRefresh)}
                    </span>
                    <Button
                      onClick={fetchRewards}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                    >
                      <Activity className="w-4 h-4" />
                      Refresh
                    </Button>
                  </div>
                </div>

                {/* Hourly View */}
                {rewardsView === 'hourly' && rewardsData.last8Hours && (
                  <Card variant="bordered" className="bg-gradient-to-br from-gray-900/40 to-gray-800/20">
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <Clock className="w-5 h-5 text-blue-400" />
                        <CardTitle className="text-xl">Last 8 Hours Rewards</CardTitle>
                      </div>
                      <CardDescription>
                        Hourly breakdown of mining rewards
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left">
                          <thead className="border-b-2 border-gray-700">
                            <tr className="text-gray-400 text-xs font-semibold uppercase tracking-wider">
                              <th className="py-4 px-4">Time Period</th>
                              <th className="py-4 px-4">Receipts</th>
                              <th className="py-4 px-4">Addresses</th>
                              <th className="py-4 px-4">STAR</th>
                              <th className="py-4 px-4">NIGHT</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-800">
                            {rewardsData.last8Hours.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="py-12 text-center text-gray-500">
                                  <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                  <p>No hourly data available yet</p>
                                </td>
                              </tr>
                            ) : (
                              rewardsData.last8Hours.map((hourData: any, index: number) => {
                                const hourStart = new Date(hourData.hour);
                                const hourEnd = new Date(hourStart.getTime() + 3600000);

                                return (
                                  <tr key={index} className="text-white hover:bg-blue-500/5 transition-colors">
                                    <td className="py-4 px-4">
                                      <div className="text-sm font-medium">
                                        {hourStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        {' - '}
                                        {hourEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                      </div>
                                      <div className="text-xs text-gray-500 mt-1">
                                        {hourStart.toLocaleDateString()}
                                      </div>
                                    </td>
                                    <td className="py-4 px-4 font-semibold">{hourData.receipts.toLocaleString()}</td>
                                    <td className="py-4 px-4">{hourData.addresses}</td>
                                    <td className="py-4 px-4">
                                      <span className="text-blue-400 font-semibold">{hourData.star.toLocaleString()}</span>
                                    </td>
                                    <td className="py-4 px-4">
                                      <span className="text-purple-400 font-semibold font-mono">{hourData.night.toFixed(6)}</span>
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Daily View */}
                {rewardsView === 'daily' && rewardsData.global && (
                  <>
                    {/* Grand Total - Hero Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      {/* Total Receipts Card */}
                      <Card variant="bordered" className="bg-gradient-to-br from-green-900/20 to-green-800/10 border-green-700/50">
                        <CardContent className="p-6">
                          <div className="flex items-center gap-3 mb-2">
                            <div className="p-3 bg-green-500/20 rounded-lg">
                              <CheckCircle2 className="w-6 h-6 text-green-400" />
                            </div>
                            <div>
                              <p className="text-sm text-gray-400 font-medium">Total Receipts</p>
                              <p className="text-4xl font-bold text-white mt-1">
                                {rewardsData.global.grandTotal.receipts.toLocaleString()}
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      {/* Total STAR Card */}
                      <Card variant="bordered" className="bg-gradient-to-br from-blue-900/20 to-blue-800/10 border-blue-700/50">
                        <CardContent className="p-6">
                          <div className="flex items-center gap-3 mb-2">
                            <div className="p-3 bg-blue-500/20 rounded-lg">
                              <Award className="w-6 h-6 text-blue-400" />
                            </div>
                            <div>
                              <p className="text-sm text-gray-400 font-medium">Total STAR</p>
                              <p className="text-4xl font-bold text-blue-400 mt-1">
                                {rewardsData.global.grandTotal.star.toLocaleString()}
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      {/* Total NIGHT Card */}
                      <Card variant="bordered" className="bg-gradient-to-br from-purple-900/20 to-purple-800/10 border-purple-700/50">
                        <CardContent className="p-6">
                          <div className="flex items-center gap-3 mb-2">
                            <div className="p-3 bg-purple-500/20 rounded-lg">
                              <Zap className="w-6 h-6 text-purple-400" />
                            </div>
                            <div>
                              <p className="text-sm text-gray-400 font-medium">Total NIGHT</p>
                              <p className="text-4xl font-bold text-purple-400 mt-1">
                                {rewardsData.global.grandTotal.night.toFixed(6)}
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Daily Breakdown Table */}
                    <Card variant="bordered" className="bg-gradient-to-br from-gray-900/40 to-gray-800/20">
                      <CardHeader>
                        <div className="flex items-center gap-2">
                          <Calendar className="w-5 h-5 text-blue-400" />
                          <CardTitle className="text-xl">Daily Breakdown</CardTitle>
                        </div>
                        <CardDescription>
                          STAR and NIGHT rewards by day
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="border-b-2 border-gray-700">
                              <tr className="text-gray-400 text-xs font-semibold uppercase tracking-wider">
                                <th className="py-4 px-4">Day</th>
                                <th className="py-4 px-4">Date</th>
                                <th className="py-4 px-4">Receipts</th>
                                <th className="py-4 px-4">Addresses</th>
                                <th className="py-4 px-4">STAR</th>
                                <th className="py-4 px-4">NIGHT</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                              {rewardsData.global.days.length === 0 ? (
                                <tr>
                                  <td colSpan={6} className="py-12 text-center text-gray-500">
                                    <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                    <p>No daily data available yet</p>
                                  </td>
                                </tr>
                              ) : (
                                rewardsData.global.days.map((day: any) => (
                                  <tr key={day.day} className="text-white hover:bg-blue-500/5 transition-colors">
                                    <td className="py-4 px-4">
                                      <span className="font-bold text-lg text-blue-400">#{day.day}</span>
                                    </td>
                                    <td className="py-4 px-4 text-gray-300 font-medium">{day.date}</td>
                                    <td className="py-4 px-4 font-semibold">{day.receipts.toLocaleString()}</td>
                                    <td className="py-4 px-4">{day.addresses || 0}</td>
                                    <td className="py-4 px-4">
                                      <span className="text-blue-400 font-semibold">{day.star.toLocaleString()}</span>
                                    </td>
                                    <td className="py-4 px-4">
                                      <span className="text-purple-400 font-semibold font-mono">{day.night.toFixed(6)}</span>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Workers Tab */}
        {activeTab === 'workers' && (
          <div className="space-y-6">
            {workers.size === 0 ? (
              <Card variant="bordered">
                <CardContent className="text-center py-12">
                  <Users className="w-16 h-16 mx-auto mb-4 opacity-50 text-gray-500" />
                  <p className="text-gray-400 text-lg mb-2">No active workers</p>
                  <p className="text-gray-500 text-sm">Workers will appear here when mining starts</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Workers Summary */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <StatCard
                    label="Total Workers"
                    value={`${workers.size} / ${stats?.workerThreads || 10}`}
                    icon={<Users />}
                    variant="success"
                  />
                  <StatCard
                    label="Total Hashes"
                    value={Array.from(workers.values()).reduce((sum, w) => sum + w.hashesComputed, 0).toLocaleString()}
                    icon={<Hash />}
                    variant="primary"
                  />
                  <StatCard
                    label="Avg Hash Rate"
                    value={`${Math.round(Array.from(workers.values()).reduce((sum, w) => sum + w.hashRate, 0) / workers.size).toLocaleString()} H/s`}
                    icon={<Zap />}
                    variant="default"
                  />
                  <StatCard
                    label="Solutions Found"
                    value={Array.from(workers.values()).reduce((sum, w) => sum + w.solutionsFound, 0)}
                    icon={<Award />}
                    variant="success"
                  />
                </div>

                {/* Workers Race View */}
                <Card variant="bordered">
                  <CardHeader>
                    <CardTitle className="text-xl flex items-center gap-2">
                      <Users className="w-5 h-5 text-blue-400" />
                      Worker Performance Race
                    </CardTitle>
                    <CardDescription>
                      Real-time worker performance tracking - fastest workers at the top
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {Array.from(workers.values())
                        .sort((a, b) => {
                          // Sort by solutions found (descending) - winners always on top
                          if (b.solutionsFound !== a.solutionsFound) {
                            return b.solutionsFound - a.solutionsFound;
                          }
                          // Then by worker ID for stable sort (no jumping)
                          return a.workerId - b.workerId;
                        })
                        .map((worker, index) => {
                          const maxHashes = Math.max(...Array.from(workers.values()).map(w => w.hashesComputed));
                          const percentage = maxHashes > 0 ? (worker.hashesComputed / maxHashes) * 100 : 0;
                          const uptime = Date.now() - worker.startTime;
                          const uptimeSeconds = Math.floor(uptime / 1000);

                          return (
                            <div
                              key={worker.workerId}
                              className={cn(
                                'p-4 rounded-lg border transition-all duration-300',
                                worker.status === 'mining' && 'bg-blue-900/10 border-blue-700/50',
                                worker.status === 'submitting' && 'bg-yellow-900/10 border-yellow-700/50 animate-pulse',
                                worker.status === 'completed' && 'bg-green-900/10 border-green-700/50',
                                worker.status === 'idle' && 'bg-gray-900/10 border-gray-700/50'
                              )}
                            >
                              <div className="flex items-center gap-4">
                                {/* Rank Badge */}
                                <div className={cn(
                                  'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg',
                                  index === 0 && 'bg-yellow-500/20 text-yellow-400 border-2 border-yellow-500',
                                  index === 1 && 'bg-gray-400/20 text-gray-300 border-2 border-gray-400',
                                  index === 2 && 'bg-orange-500/20 text-orange-400 border-2 border-orange-500',
                                  index > 2 && 'bg-gray-700 text-gray-400'
                                )}>
                                  {index === 0 && '🥇'}
                                  {index === 1 && '🥈'}
                                  {index === 2 && '🥉'}
                                  {index > 2 && `#${index + 1}`}
                                </div>

                                {/* Worker Info */}
                                <div className="flex-1 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <span className="text-white font-semibold">Worker {worker.workerId}</span>
                                      <span className={cn(
                                        'px-2 py-1 rounded text-xs font-medium',
                                        worker.status === 'mining' && 'bg-blue-500/20 text-blue-400',
                                        worker.status === 'submitting' && 'bg-yellow-500/20 text-yellow-400',
                                        worker.status === 'completed' && 'bg-green-500/20 text-green-400',
                                        worker.status === 'idle' && 'bg-gray-500/20 text-gray-400'
                                      )}>
                                        {worker.status === 'mining' && '⚡ Mining'}
                                        {worker.status === 'submitting' && '📤 Submitting'}
                                        {worker.status === 'completed' && '✅ Completed'}
                                        {worker.status === 'idle' && '💤 Idle'}
                                      </span>
                                      {worker.solutionsFound > 0 && (
                                        <span className="px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400">
                                          🏆 {worker.solutionsFound} solution{worker.solutionsFound > 1 ? 's' : ''}
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-right">
                                      <div className="text-sm text-gray-400">Address #{worker.addressIndex}</div>
                                      <div className="text-xs text-gray-500 font-mono">
                                        {worker.address.slice(0, 12)}...
                                      </div>
                                    </div>
                                  </div>

                                  {/* Progress Bar */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between text-xs text-gray-400">
                                      <span>{worker.hashesComputed.toLocaleString()} hashes</span>
                                      <span>{worker.hashRate.toLocaleString()} H/s</span>
                                    </div>
                                    <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                                      <div
                                        className={cn(
                                          'h-full transition-all duration-500',
                                          worker.status === 'mining' && 'bg-gradient-to-r from-blue-500 to-cyan-400',
                                          worker.status === 'submitting' && 'bg-gradient-to-r from-yellow-500 to-orange-400',
                                          worker.status === 'completed' && 'bg-gradient-to-r from-green-500 to-emerald-400',
                                          worker.status === 'idle' && 'bg-gray-600'
                                        )}
                                        style={{ width: `${percentage}%` }}
                                      />
                                    </div>
                                  </div>

                                  {/* Stats Row */}
                                  <div className="grid grid-cols-3 gap-2 text-xs">
                                    <div>
                                      <span className="text-gray-500">Uptime: </span>
                                      <span className="text-gray-300">{uptimeSeconds}s</span>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Avg: </span>
                                      <span className="text-gray-300">
                                        {uptimeSeconds > 0 ? Math.round(worker.hashesComputed / uptimeSeconds).toLocaleString() : '0'} H/s
                                      </span>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Challenge: </span>
                                      <span className="text-gray-300 font-mono">
                                        {worker.currentChallenge ? worker.currentChallenge.slice(0, 8) + '...' : 'N/A'}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        )}

        {/* Addresses Tab */}
        {activeTab === 'addresses' && (
          <div className="space-y-6">
            {addressesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
              </div>
            ) : !addressesData ? (
              <Card variant="bordered">
                <CardContent className="text-center py-12">
                  <p className="text-gray-400">No address data available yet</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Summary Stats */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <StatCard
                    label="Total Addresses"
                    value={addressesData.summary.totalAddresses}
                    icon={<MapPin />}
                    variant="primary"
                  />
                  <StatCard
                    label="Registered"
                    value={addressesData.summary.registeredAddresses}
                    icon={<CheckCircle2 />}
                    variant="success"
                  />
                  <StatCard
                    label="Solved Current Challenge"
                    value={addressesData.summary.solvedCurrentChallenge}
                    icon={<Award />}
                    variant="success"
                  />
                  <StatCard
                    label="Not Yet Solved"
                    value={addressesData.summary.totalAddresses - addressesData.summary.solvedCurrentChallenge}
                    icon={<Target />}
                    variant="default"
                  />
                </div>

                {/* Filter Buttons */}
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => setAddressFilter('all')}
                    className={cn(
                      'px-4 py-2 rounded text-sm font-medium transition-colors',
                      addressFilter === 'all'
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    )}
                  >
                    All ({addressesData.addresses.length})
                  </button>
                  <button
                    onClick={() => setAddressFilter('solved')}
                    className={cn(
                      'px-4 py-2 rounded text-sm font-medium transition-colors',
                      addressFilter === 'solved'
                        ? 'bg-green-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    )}
                  >
                    Solved ({addressesData.summary.solvedCurrentChallenge})
                  </button>
                  <button
                    onClick={() => setAddressFilter('unsolved')}
                    className={cn(
                      'px-4 py-2 rounded text-sm font-medium transition-colors',
                      addressFilter === 'unsolved'
                        ? 'bg-yellow-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    )}
                  >
                    Unsolved ({addressesData.summary.totalAddresses - addressesData.summary.solvedCurrentChallenge})
                  </button>
                  <button
                    onClick={() => setAddressFilter('registered')}
                    className={cn(
                      'px-4 py-2 rounded text-sm font-medium transition-colors',
                      addressFilter === 'registered'
                        ? 'bg-purple-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    )}
                  >
                    Registered ({addressesData.summary.registeredAddresses})
                  </button>
                  <button
                    onClick={() => setAddressFilter('unregistered')}
                    className={cn(
                      'px-4 py-2 rounded text-sm font-medium transition-colors',
                      addressFilter === 'unregistered'
                        ? 'bg-gray-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    )}
                  >
                    Unregistered ({addressesData.summary.totalAddresses - addressesData.summary.registeredAddresses})
                  </button>
                  <div className="ml-auto">
                    <Button
                      onClick={fetchAddresses}
                      variant="outline"
                      size="sm"
                    >
                      Refresh
                    </Button>
                  </div>
                </div>

                {/* Current Challenge Info */}
                {addressesData.currentChallenge && (
                  <Alert variant="info">
                    <div className="flex items-center gap-2">
                      <Target className="w-4 h-4" />
                      <span className="font-semibold">Current Challenge:</span>
                      <span className="font-mono text-sm">{addressesData.currentChallenge.slice(0, 24)}...</span>
                      <button
                        onClick={() => copyToClipboard(addressesData.currentChallenge, 'current-challenge')}
                        className="text-gray-400 hover:text-white transition-colors"
                      >
                        {copiedId === 'current-challenge' ? (
                          <Check className="w-3 h-3 text-green-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  </Alert>
                )}

                {/* Address List */}
                <Card variant="bordered">
                  <CardHeader>
                    <CardTitle className="text-xl">Address Status</CardTitle>
                    <CardDescription>
                      {addressFilter === 'all' && `Showing all ${addressesData.addresses.filter((addr: any) => {
                        if (addressFilter === 'all') return true;
                        if (addressFilter === 'solved') return addr.solvedCurrentChallenge;
                        if (addressFilter === 'unsolved') return !addr.solvedCurrentChallenge;
                        if (addressFilter === 'registered') return addr.registered;
                        if (addressFilter === 'unregistered') return !addr.registered;
                        return true;
                      }).length} addresses`}
                      {addressFilter === 'solved' && `Addresses that solved the current challenge`}
                      {addressFilter === 'unsolved' && `Addresses that haven't solved the current challenge yet`}
                      {addressFilter === 'registered' && `Registered addresses`}
                      {addressFilter === 'unregistered' && `Unregistered addresses`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[600px] overflow-y-auto">
                      {addressesData.addresses
                        .filter((addr: any) => {
                          if (addressFilter === 'all') return true;
                          if (addressFilter === 'solved') return addr.solvedCurrentChallenge;
                          if (addressFilter === 'unsolved') return !addr.solvedCurrentChallenge;
                          if (addressFilter === 'registered') return addr.registered;
                          if (addressFilter === 'unregistered') return !addr.registered;
                          return true;
                        })
                        .map((address: any, index: number) => (
                          <div
                            key={address.index}
                            className={cn(
                              'p-3 rounded-lg border transition-colors',
                              address.solvedCurrentChallenge
                                ? 'bg-green-900/10 border-green-700/50'
                                : 'bg-gray-900/10 border-gray-700/50'
                            )}
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div className="flex items-center gap-3 flex-1">
                                {/* Index Badge */}
                                <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gray-800 flex items-center justify-center">
                                  <span className="text-lg font-bold text-gray-300">#{address.index}</span>
                                </div>

                                {/* Address Info */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-white font-mono text-sm truncate">
                                      {address.bech32}
                                    </span>
                                    <button
                                      onClick={() => copyToClipboard(address.bech32, `address-${address.index}`)}
                                      className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
                                    >
                                      {copiedId === `address-${address.index}` ? (
                                        <Check className="w-3 h-3 text-green-400" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="text-gray-500">
                                      Total Solutions: <span className="text-white font-semibold">{address.totalSolutions}</span>
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Status Badges */}
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {address.registered ? (
                                  <span className="px-2 py-1 rounded text-xs font-medium bg-purple-500/20 text-purple-400">
                                    Registered
                                  </span>
                                ) : (
                                  <span className="px-2 py-1 rounded text-xs font-medium bg-gray-500/20 text-gray-400">
                                    Not Registered
                                  </span>
                                )}
                                {address.solvedCurrentChallenge ? (
                                  <span className="px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400 flex items-center gap-1">
                                    <CheckCircle2 className="w-3 h-3" />
                                    Solved
                                  </span>
                                ) : (
                                  <span className="px-2 py-1 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400">
                                    Pending
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      {addressesData.addresses.filter((addr: any) => {
                        if (addressFilter === 'all') return true;
                        if (addressFilter === 'solved') return addr.solvedCurrentChallenge;
                        if (addressFilter === 'unsolved') return !addr.solvedCurrentChallenge;
                        if (addressFilter === 'registered') return addr.registered;
                        if (addressFilter === 'unregistered') return !addr.registered;
                        return true;
                      }).length === 0 && (
                          <div className="text-center py-12 text-gray-500">
                            <MapPin className="w-16 h-16 mx-auto mb-4 opacity-50" />
                            <p className="text-lg">No addresses match this filter</p>
                          </div>
                        )}
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        )}

        {/* Scale Tab */}
        {activeTab === 'scale' && (
          <div className="space-y-6">
            {scaleLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="text-center space-y-4">
                  <RefreshCw className="w-12 h-12 animate-spin text-blue-500 mx-auto" />
                  <p className="text-lg text-gray-400">Analyzing system specifications...</p>
                </div>
              </div>
            ) : scaleError || !scaleSpecs || !scaleRecommendations ? (
              <div className="space-y-4">
                <Alert variant="error">
                  <AlertCircle className="w-5 h-5" />
                  <span>{scaleError || 'Failed to load system specifications'}</span>
                </Alert>
                <Button onClick={fetchScaleData} variant="primary">
                  <RefreshCw className="w-4 h-4" />
                  Load System Specs
                </Button>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-2xl font-bold mb-2">Performance Scaling</h2>
                    <p className="text-gray-400">
                      Optimize BATCH_SIZE and workerThreads based on your hardware
                    </p>
                  </div>
                  <Button onClick={fetchScaleData} variant="outline">
                    <RefreshCw className="w-4 h-4" />
                    Refresh
                  </Button>
                </div>

                {/* System Tier Badge */}
                <div className="flex justify-center">
                  <div className={cn(
                    'inline-flex items-center gap-3 px-6 py-3 rounded-full border',
                    scaleRecommendations.systemTier === 'high-end' && 'text-green-400 bg-green-900/20 border-green-700/50',
                    scaleRecommendations.systemTier === 'mid-range' && 'text-blue-400 bg-blue-900/20 border-blue-700/50',
                    scaleRecommendations.systemTier === 'entry-level' && 'text-yellow-400 bg-yellow-900/20 border-yellow-700/50',
                    scaleRecommendations.systemTier === 'low-end' && 'text-orange-400 bg-orange-900/20 border-orange-700/50'
                  )}>
                    <Zap className="w-5 h-5" />
                    <span className="text-lg font-semibold">
                      System Tier: {scaleRecommendations.systemTier.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </span>
                  </div>
                </div>

                {/* System Specifications */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card variant="bordered">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Cpu className="w-5 h-5 text-blue-400" />
                        CPU
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Model:</span>
                        <span className="font-mono text-white truncate ml-2" title={scaleSpecs.cpu.model}>
                          {scaleSpecs.cpu.model.substring(0, 25)}...
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Cores:</span>
                        <span className="font-mono text-white">{scaleSpecs.cpu.cores}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Speed:</span>
                        <span className="font-mono text-white">{scaleSpecs.cpu.speed} MHz</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Load (1m):</span>
                        <span className="font-mono text-white">{scaleSpecs.cpu.loadAverage[0].toFixed(2)}</span>
                      </div>
                    </CardContent>
                  </Card>

                  <Card variant="bordered">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Memory className="w-5 h-5 text-purple-400" />
                        Memory
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Total:</span>
                        <span className="font-mono text-white">{scaleSpecs.memory.total} GB</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Used:</span>
                        <span className="font-mono text-white">{scaleSpecs.memory.used} GB</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Free:</span>
                        <span className="font-mono text-white">{scaleSpecs.memory.free} GB</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Usage:</span>
                        <span className="font-mono text-white">{scaleSpecs.memory.usagePercent}%</span>
                      </div>
                    </CardContent>
                  </Card>

                  <Card variant="bordered">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Settings className="w-5 h-5 text-green-400" />
                        System
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Platform:</span>
                        <span className="font-mono text-white">{scaleSpecs.system.platform}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Architecture:</span>
                        <span className="font-mono text-white">{scaleSpecs.system.arch}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Uptime:</span>
                        <span className="font-mono text-white">
                          {Math.floor(scaleSpecs.system.uptime / 3600)}h {Math.floor((scaleSpecs.system.uptime % 3600) / 60)}m
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Warnings */}
                {scaleRecommendations.warnings.length > 0 && (
                  <div className="space-y-2">
                    {scaleRecommendations.warnings.map((warning: string, index: number) => (
                      <Alert
                        key={index}
                        variant={warning.startsWith('✅') ? 'success' : warning.startsWith('💡') ? 'info' : 'warning'}
                      >
                        <span>{warning}</span>
                      </Alert>
                    ))}
                  </div>
                )}

                {/* Recommendations - Visual Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Worker Threads Card */}
                  <Card variant="elevated">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Cpu className="w-6 h-6 text-blue-400" />
                        Worker Threads
                      </CardTitle>
                      <CardDescription>
                        Number of parallel mining threads
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg border-2 border-yellow-500/50">
                          <span className="text-gray-400 font-semibold">Edit Value:</span>
                          <input
                            type="number"
                            min="1"
                            max={scaleRecommendations.workerThreads.max}
                            value={editedWorkerThreads || ''}
                            onChange={(e) => setEditedWorkerThreads(parseInt(e.target.value) || 1)}
                            className="w-24 px-3 py-2 text-2xl font-bold text-center bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-yellow-500 text-white"
                          />
                        </div>

                        <div className="flex items-center justify-between p-3 bg-green-900/20 border border-green-700/50 rounded-lg cursor-pointer hover:bg-green-900/30 transition-colors"
                          onClick={() => setEditedWorkerThreads(scaleRecommendations.workerThreads.optimal)}>
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-5 h-5 text-green-400" />
                            <span className="text-green-400 font-semibold">Optimal:</span>
                          </div>
                          <span className="text-2xl font-bold text-green-400">
                            {scaleRecommendations.workerThreads.optimal}
                          </span>
                        </div>

                        <div className="flex items-center justify-between p-3 bg-blue-900/20 border border-blue-700/50 rounded-lg cursor-pointer hover:bg-blue-900/30 transition-colors"
                          onClick={() => setEditedWorkerThreads(scaleRecommendations.workerThreads.conservative)}>
                          <span className="text-blue-400">Conservative:</span>
                          <span className="text-xl font-bold text-blue-400">
                            {scaleRecommendations.workerThreads.conservative}
                          </span>
                        </div>

                        <div className="flex items-center justify-between p-3 bg-orange-900/20 border border-orange-700/50 rounded-lg cursor-pointer hover:bg-orange-900/30 transition-colors"
                          onClick={() => setEditedWorkerThreads(scaleRecommendations.workerThreads.max)}>
                          <span className="text-orange-400">Maximum:</span>
                          <span className="text-xl font-bold text-orange-400">
                            {scaleRecommendations.workerThreads.max}
                          </span>
                        </div>
                      </div>

                      <Alert variant="info">
                        <Info className="w-4 h-4" />
                        <span className="text-sm">{scaleRecommendations.workerThreads.explanation}</span>
                      </Alert>

                      <div className="text-xs text-gray-500 space-y-1">
                        <p><strong>Location:</strong> lib/mining/orchestrator.ts:42</p>
                        <p><strong>Variable:</strong> <code className="bg-gray-800 px-1 py-0.5 rounded">private workerThreads = 12;</code></p>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Batch Size Card */}
                  <Card variant="elevated">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Gauge className="w-6 h-6 text-purple-400" />
                        Batch Size
                      </CardTitle>
                      <CardDescription>
                        Number of hashes computed per batch
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg border-2 border-yellow-500/50">
                          <span className="text-gray-400 font-semibold">Edit Value:</span>
                          <input
                            type="number"
                            min="50"
                            max={scaleRecommendations.batchSize.max}
                            step="50"
                            value={editedBatchSize || ''}
                            onChange={(e) => setEditedBatchSize(parseInt(e.target.value) || 50)}
                            className="w-24 px-3 py-2 text-2xl font-bold text-center bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-yellow-500 text-white"
                          />
                        </div>

                        <div className="flex items-center justify-between p-3 bg-green-900/20 border border-green-700/50 rounded-lg cursor-pointer hover:bg-green-900/30 transition-colors"
                          onClick={() => setEditedBatchSize(scaleRecommendations.batchSize.optimal)}>
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-5 h-5 text-green-400" />
                            <span className="text-green-400 font-semibold">Optimal:</span>
                          </div>
                          <span className="text-2xl font-bold text-green-400">
                            {scaleRecommendations.batchSize.optimal}
                          </span>
                        </div>

                        <div className="flex items-center justify-between p-3 bg-blue-900/20 border border-blue-700/50 rounded-lg cursor-pointer hover:bg-blue-900/30 transition-colors"
                          onClick={() => setEditedBatchSize(scaleRecommendations.batchSize.conservative)}>
                          <span className="text-blue-400">Conservative:</span>
                          <span className="text-xl font-bold text-blue-400">
                            {scaleRecommendations.batchSize.conservative}
                          </span>
                        </div>

                        <div className="flex items-center justify-between p-3 bg-orange-900/20 border border-orange-700/50 rounded-lg cursor-pointer hover:bg-orange-900/30 transition-colors"
                          onClick={() => setEditedBatchSize(scaleRecommendations.batchSize.max)}>
                          <span className="text-orange-400">Maximum:</span>
                          <span className="text-xl font-bold text-orange-400">
                            {scaleRecommendations.batchSize.max}
                          </span>
                        </div>
                      </div>

                      <Alert variant="info">
                        <Info className="w-4 h-4" />
                        <span className="text-sm">{scaleRecommendations.batchSize.explanation}</span>
                      </Alert>

                      <div className="text-xs text-gray-500 space-y-1">
                        <p><strong>Location:</strong> lib/mining/orchestrator.ts:597</p>
                        <p><strong>Variable:</strong> <code className="bg-gray-800 px-1 py-0.5 rounded">const BATCH_SIZE = 350;</code></p>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Apply Changes Button */}
                {hasChanges() && (
                  <div className="flex justify-center">
                    <Button
                      onClick={() => setShowApplyConfirmation(true)}
                      variant="primary"
                      className="px-8 py-4 text-lg"
                      disabled={applyingChanges}
                    >
                      {applyingChanges ? (
                        <>
                          <RefreshCw className="w-5 h-5 animate-spin" />
                          Applying Changes...
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-5 h-5" />
                          Apply Changes & Restart Mining
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {/* Confirmation Dialog */}
                {showApplyConfirmation && (
                  <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <Card variant="elevated" className="max-w-lg w-full">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-xl">
                          <AlertCircle className="w-6 h-6 text-yellow-400" />
                          Confirm Performance Changes
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <p className="text-gray-300">
                          You are about to apply the following performance configuration changes:
                        </p>

                        <div className="space-y-2 bg-gray-800/50 p-4 rounded-lg border border-gray-700">
                          <div className="flex items-center justify-between">
                            <span className="text-gray-400">Worker Threads:</span>
                            <div className="flex items-center gap-2">
                              <span className="text-white font-mono">{scaleRecommendations.workerThreads.current}</span>
                              <span className="text-gray-500">→</span>
                              <span className="text-green-400 font-mono font-bold">{editedWorkerThreads}</span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-gray-400">Batch Size:</span>
                            <div className="flex items-center gap-2">
                              <span className="text-white font-mono">{scaleRecommendations.batchSize.current}</span>
                              <span className="text-gray-500">→</span>
                              <span className="text-green-400 font-mono font-bold">{editedBatchSize}</span>
                            </div>
                          </div>
                        </div>

                        <Alert variant="warning">
                          <AlertCircle className="w-4 h-4" />
                          <span className="text-sm">
                            Mining will be stopped and restarted automatically with the new configuration.
                            This may take a few seconds.
                          </span>
                        </Alert>

                        <div className="flex gap-3 justify-end">
                          <Button
                            onClick={() => setShowApplyConfirmation(false)}
                            variant="outline"
                            disabled={applyingChanges}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={applyPerformanceChanges}
                            variant="primary"
                            disabled={applyingChanges}
                          >
                            {applyingChanges ? (
                              <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                Applying...
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="w-4 h-4" />
                                Apply & Restart
                              </>
                            )}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Performance Notes */}
                <Card variant="glass">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-yellow-400" />
                      Performance Tuning Tips
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm text-gray-300">
                      {scaleRecommendations.performanceNotes.map((note: string, index: number) => (
                        <li key={index} className="flex items-start gap-2">
                          <span className="text-blue-400 mt-0.5">•</span>
                          <span>{note}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        )}

        {/* Consolidate Tab */}
        {activeTab === 'consolidate' && (
          <div className="space-y-6">
            {/* Configuration Card */}
            <Card variant="bordered">
              <CardHeader>
                <CardTitle className="text-xl flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-blue-400" />
                  Consolidate Rewards
                </CardTitle>
                <CardDescription>
                  Consolidate all rewards to address index {destinationAddressIndex} - Runs continuously until stopped
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        Destination Address Index
                      </label>
                      <input
                        type="number"
                        min="0"
                        max={stats?.totalAddresses ? stats.totalAddresses - 1 : 199}
                        value={destinationAddressIndex}
                        onChange={(e) => setDestinationAddressIndex(parseInt(e.target.value) || 0)}
                        disabled={consolidateLoading}
                        className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                        placeholder="0"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        All rewards consolidate here
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        Wallet Password
                      </label>
                      <input
                        type="password"
                        value={consolidatePassword}
                        onChange={(e) => setConsolidatePassword(e.target.value)}
                        disabled={consolidateLoading}
                        className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                        placeholder="Enter password"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Required to sign transactions
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">


                    <Button
                      onClick={async () => {
                      }} disabled={true}
                      className="flex-1"
                    >
                      <>
                        <Play className="w-4 h-4 mr-2" />
                        DISABLED - Start Continuous Consolidation
                      </>
                    </Button>

                    {/* <Button
                      onClick={async () => {
                        if (!consolidatePassword) {
                          alert('Please enter your wallet password');
                          return;
                        }

                        setConsolidateLoading(true);
                        consolidateRunningRef.current = true;
                        setConsolidateResults([]);

                        try {
                          console.log('[Consolidate] Loading wallet addresses...');
                          // Load wallet addresses with password
                          const statusResponse = await fetch('/api/consolidate/status', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: consolidatePassword }),
                          });

                          const statusData = await statusResponse.json();

                          if (!statusData.addresses) {
                            throw new Error(statusData.error || 'Failed to load addresses');
                          }

                          const addresses = statusData.addresses;
                          console.log(`[Consolidate] Loaded ${addresses.length} addresses`);

                          // Initialize all addresses as pending (except destination)
                          setConsolidateResults(addresses.map((addr: any) => ({
                            index: addr.index,
                            address: addr.bech32,
                            status: addr.index === destinationAddressIndex ? 'skipped' : 'pending',
                            message: addr.index === destinationAddressIndex ? 'Destination address' : '',
                          })));

                          // Continuous loop using ref
                          let cycleCount = 0;
                          while (consolidateRunningRef.current) {
                            cycleCount++;
                            console.log(`[Consolidate] Starting cycle ${cycleCount}`);

                            let successCount = 0;
                            let failCount = 0;
                            let current = 0;
                            const total = addresses.length - 1;

                            for (const addr of addresses) {
                              // Check if user stopped using ref
                              if (!consolidateRunningRef.current) break;

                              // Skip destination
                              if (addr.index === destinationAddressIndex) {
                                continue;
                              }

                              current++;
                              setConsolidateProgress({
                                current,
                                total,
                                successCount,
                                failCount,
                                currentAddress: addr.bech32,
                              });

                              try {
                                console.log(`[Consolidate] Processing address ${addr.index}...`);
                                const donateResponse = await fetch('/api/consolidate/donate', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    password: consolidatePassword,
                                    sourceIndex: addr.index,
                                    destinationIndex: destinationAddressIndex,
                                  }),
                                });

                                const donateData = await donateResponse.json();

                                if (donateData.success) {
                                  successCount++;
                                  setConsolidateResults(prev =>
                                    prev.map(r =>
                                      r.index === addr.index
                                        ? {
                                            ...r,
                                            status: 'success',
                                            message: donateData.message,
                                            solutionsConsolidated: donateData.solutionsConsolidated
                                          }
                                        : r
                                    )
                                  );
                                } else {
                                  failCount++;
                                  setConsolidateResults(prev =>
                                    prev.map(r =>
                                      r.index === addr.index
                                        ? { ...r, status: 'failed', message: donateData.error }
                                        : r
                                    )
                                  );
                                }
                              } catch (err: any) {
                                failCount++;
                                console.error(`[Consolidate] Error for address ${addr.index}:`, err);
                                setConsolidateResults(prev =>
                                  prev.map(r =>
                                    r.index === addr.index
                                      ? { ...r, status: 'failed', message: err.message }
                                      : r
                                  )
                                );
                              }

                              setConsolidateProgress({
                                current,
                                total,
                                successCount,
                                failCount,
                                currentAddress: addr.bech32,
                              });

                              // 2 second delay between requests
                              await new Promise(resolve => setTimeout(resolve, 2000));
                            }

                            console.log(`[Consolidate] Cycle ${cycleCount} complete. Success: ${successCount}, Failed: ${failCount}`);

                            // Wait 5 seconds before next cycle (only if still running)
                            if (consolidateRunningRef.current) {
                              await new Promise(resolve => setTimeout(resolve, 5000));
                            }
                          }
                        } catch (error: any) {
                          console.error('[Consolidate] Error:', error);
                          alert(`Error: ${error.message}`);
                        } finally {
                          setConsolidateLoading(false);
                          consolidateRunningRef.current = false;
                          setConsolidateProgress(null);
                        }
                      }}
                      disabled={consolidateLoading || !consolidatePassword}
                      className="flex-1"
                    >
                      {consolidateLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Running...
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 mr-2" />
                          Start Continuous Consolidation
                        </>
                      )}
                    </Button> */}

                    {consolidateLoading && (
                      <Button
                        onClick={() => {
                          consolidateRunningRef.current = false;
                          setConsolidateLoading(false);
                          setConsolidateProgress(null);
                        }}
                        variant="default"
                        className="bg-red-600 hover:bg-red-700"
                      >
                        <Square className="w-4 h-4 mr-2" />
                        Stop
                      </Button>
                    )}
                  </div>

                  {/* Progress */}
                  {consolidateProgress && (
                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-gray-300">Progress</span>
                        <span className="text-sm text-gray-400">
                          {consolidateProgress.current} / {consolidateProgress.total}
                        </span>
                      </div>
                      <div className="w-full bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${(consolidateProgress.current / consolidateProgress.total) * 100}%` }}
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="text-center">
                          <div className="text-xs text-gray-500">Success</div>
                          <div className="text-lg font-bold text-green-400">{consolidateProgress.successCount}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-xs text-gray-500">Failed</div>
                          <div className="text-lg font-bold text-red-400">{consolidateProgress.failCount}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-xs text-gray-500">Remaining</div>
                          <div className="text-lg font-bold text-gray-400">
                            {consolidateProgress.total - consolidateProgress.current}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        Current: {consolidateProgress.currentAddress.slice(0, 20)}...
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Address Table */}
            <Card variant="bordered">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <MapPin className="w-5 h-5 text-blue-400" />
                  Address Status ({consolidateResults.length} addresses)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-700">
                        <th className="text-left p-3 text-gray-400 font-medium">Index</th>
                        <th className="text-left p-3 text-gray-400 font-medium">Address</th>
                        <th className="text-center p-3 text-gray-400 font-medium">Status</th>
                        <th className="text-left p-3 text-gray-400 font-medium">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consolidateResults.map((result) => (
                        <tr
                          key={result.index}
                          className={cn(
                            'border-b border-gray-800 hover:bg-gray-800/50 transition-colors',
                            result.index === destinationAddressIndex && 'bg-blue-900/10'
                          )}
                        >
                          <td className="p-3 font-mono text-gray-300">#{result.index}</td>
                          <td className="p-3 font-mono text-xs text-gray-400">
                            {result.address.slice(0, 12)}...{result.address.slice(-8)}
                          </td>
                          <td className="p-3 text-center">
                            {result.status === 'success' && (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-900/30 text-green-400 text-xs">
                                <CheckCircle2 className="w-3 h-3" />
                                Success
                              </span>
                            )}
                            {result.status === 'failed' && (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-900/30 text-red-400 text-xs">
                                <XCircle className="w-3 h-3" />
                                Failed
                              </span>
                            )}
                            {result.status === 'pending' && (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-800 text-gray-400 text-xs">
                                <Clock className="w-3 h-3" />
                                Pending
                              </span>
                            )}
                            {result.status === 'skipped' && (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-900/30 text-blue-400 text-xs">
                                <Info className="w-3 h-3" />
                                Destination
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-xs text-gray-400">
                            {result.solutionsConsolidated !== undefined && result.solutionsConsolidated > 0 && (
                              <span className="text-green-400">{result.solutionsConsolidated} solutions</span>
                            )}
                            {result.message && result.status === 'failed' && (
                              <span className="text-red-400">{result.message}</span>
                            )}
                            {result.status === 'pending' && <span className="text-gray-500">Waiting...</span>}
                            {result.status === 'skipped' && <span className="text-blue-400">Skip</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Info Card */}
            <Card variant="bordered">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="w-4 h-4 text-blue-400" />
                  How Continuous Consolidation Works
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-xs text-gray-400">
                  <p>• Runs in a continuous loop, consolidating all addresses to index {destinationAddressIndex}</p>
                  <p>• Each cycle processes all addresses with 2-second delays between requests</p>
                  <p>• After completing a cycle, waits 5 seconds before starting the next cycle</p>
                  <p>• The table updates in real-time showing the status of each address</p>
                  <p>• Click Stop to halt the consolidation process at any time</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Logs Tab */}
        {activeTab === 'logs' && (
          <div className="space-y-6">
            <Card variant="bordered">
              <CardHeader>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xl flex items-center gap-2">
                      <Terminal className="w-5 h-5 text-blue-400" />
                      Mining Log
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      {/* Follow/Unfollow Toggle */}
                      <Button
                        variant={autoFollow ? "default" : "ghost"}
                        size="sm"
                        onClick={() => setAutoFollow(!autoFollow)}
                        className="h-8 gap-1.5"
                        title={autoFollow ? "Auto-scroll enabled" : "Auto-scroll disabled"}
                      >
                        {autoFollow ? <PlayIcon className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        <span className="text-xs">{autoFollow ? 'Following' : 'Paused'}</span>
                      </Button>

                      {/* Size Toggle */}
                      <div className="flex gap-1 bg-gray-800 rounded p-1">
                        <button
                          onClick={() => setLogHeight('small')}
                          className={cn(
                            'px-2 py-1 rounded text-xs transition-colors',
                            logHeight === 'small' ? 'bg-blue-500 text-white' : 'text-gray-400 hover:text-white'
                          )}
                          title="Small (200px)"
                        >
                          S
                        </button>
                        <button
                          onClick={() => setLogHeight('medium')}
                          className={cn(
                            'px-2 py-1 rounded text-xs transition-colors',
                            logHeight === 'medium' ? 'bg-blue-500 text-white' : 'text-gray-400 hover:text-white'
                          )}
                          title="Medium (400px)"
                        >
                          M
                        </button>
                        <button
                          onClick={() => setLogHeight('large')}
                          className={cn(
                            'px-2 py-1 rounded text-xs transition-colors',
                            logHeight === 'large' ? 'bg-blue-500 text-white' : 'text-gray-400 hover:text-white'
                          )}
                          title="Large (600px)"
                        >
                          L
                        </button>
                      </div>

                      {/* Collapse Toggle */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowLogs(!showLogs)}
                        className="h-8 w-8 p-0"
                      >
                        {showLogs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </Button>
                    </div>
                  </div>
                  {showLogs && (
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => setLogFilter('all')}
                        className={cn(
                          'px-3 py-1 rounded text-xs font-medium transition-colors',
                          logFilter === 'all'
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        )}
                      >
                        All ({logs.length})
                      </button>
                      <button
                        onClick={() => setLogFilter('error')}
                        className={cn(
                          'px-3 py-1 rounded text-xs font-medium transition-colors',
                          logFilter === 'error'
                            ? 'bg-red-500 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        )}
                      >
                        Errors ({logs.filter(l => l.type === 'error').length})
                      </button>
                      <button
                        onClick={() => setLogFilter('warning')}
                        className={cn(
                          'px-3 py-1 rounded text-xs font-medium transition-colors',
                          logFilter === 'warning'
                            ? 'bg-yellow-500 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        )}
                      >
                        Warnings ({logs.filter(l => l.type === 'warning').length})
                      </button>
                      <button
                        onClick={() => setLogFilter('success')}
                        className={cn(
                          'px-3 py-1 rounded text-xs font-medium transition-colors',
                          logFilter === 'success'
                            ? 'bg-green-500 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        )}
                      >
                        Success ({logs.filter(l => l.type === 'success').length})
                      </button>
                      <button
                        onClick={() => setLogFilter('info')}
                        className={cn(
                          'px-3 py-1 rounded text-xs font-medium transition-colors',
                          logFilter === 'info'
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        )}
                      >
                        Info ({logs.filter(l => l.type === 'info').length})
                      </button>
                    </div>
                  )}
                </div>
              </CardHeader>
              {showLogs && (
                <CardContent>
                  <div
                    ref={logContainerRef}
                    className={cn(
                      "bg-gray-950 rounded-lg p-4 overflow-y-auto font-mono text-sm space-y-1 scroll-smooth transition-all",
                      logHeight === 'small' && 'h-[200px]',
                      logHeight === 'medium' && 'h-[400px]',
                      logHeight === 'large' && 'h-[600px]'
                    )}
                  >
                    {logs.length === 0 ? (
                      <p className="text-gray-500 text-center py-8">No logs yet. Start mining to see activity.</p>
                    ) : (
                      logs
                        .filter(log => logFilter === 'all' || log.type === logFilter)
                        .map((log, index) => (
                          <div key={index} className="flex items-start gap-2 animate-in fade-in duration-200">
                            <span className="text-gray-600 shrink-0">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </span>
                            <span className={cn(
                              log.type === 'error' && 'text-red-400',
                              log.type === 'success' && 'text-green-400',
                              log.type === 'warning' && 'text-yellow-400',
                              log.type === 'info' && 'text-blue-400'
                            )}>
                              {log.message}
                            </span>
                          </div>
                        ))
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          </div>
        )}

        {/* Dev Fee Tab */}
        {activeTab === 'devfee' && (
          <div className="space-y-6">
            {/* Dev Fee Explanation Card */}
            <Card variant="bordered" className="bg-gradient-to-br from-blue-900/20 to-purple-900/20">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Award className="w-6 h-6 text-blue-400" />
                  <div>
                    <CardTitle className="text-2xl">Development Fee</CardTitle>
                    <CardDescription>Support continued maintenance and improvements</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* What is Dev Fee */}
                <div className="p-6 rounded-lg bg-gray-800/50 border border-gray-700">
                  <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                    <Info className="w-5 h-5 text-blue-400" />
                    What is the Development Fee?
                  </h3>
                  <p className="text-gray-300 leading-relaxed mb-4">
                    The development fee is a small percentage of mining rewards that supports the ongoing maintenance,
                    updates, and improvements of this mining application. It helps ensure the software remains secure,
                    efficient, and up-to-date with the latest features.
                  </p>
                  <p className="text-gray-300 leading-relaxed">
                    When enabled, <span className="text-blue-400 font-semibold">1 out of every 17 solutions</span> you mine
                    will be submitted to a development address instead of your wallet. This represents approximately
                    <span className="text-blue-400 font-semibold"> 5.88% of your mining rewards</span>.
                  </p>
                </div>

                {/* How It Works */}
                <div className="p-6 rounded-lg bg-gray-800/50 border border-gray-700">
                  <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                    <Settings className="w-5 h-5 text-purple-400" />
                    How It Works
                  </h3>
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-1 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-400 font-bold text-sm">1</span>
                      </div>
                      <div>
                        <p className="text-gray-300 leading-relaxed">
                          You mine solutions normally using your wallet addresses
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="mt-1 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-400 font-bold text-sm">2</span>
                      </div>
                      <div>
                        <p className="text-gray-300 leading-relaxed">
                          Every 17th solution is automatically mined for a development address
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="mt-1 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-400 font-bold text-sm">3</span>
                      </div>
                      <div>
                        <p className="text-gray-300 leading-relaxed">
                          The cycle repeats: 16 solutions for you, 1 for development, and so on
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Enable/Disable Toggle */}
                <div className="p-6 rounded-lg bg-gradient-to-r from-blue-900/30 to-purple-900/30 border-2 border-blue-500/30">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-white mb-2">Enable Development Fee</h3>
                      <p className="text-gray-400 text-sm">
                        Choose whether to contribute to the development of this application
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        const newValue = !devFeeEnabled;
                        toggleDevFee(newValue);
                      }}
                      disabled={devFeeLoading}
                      className={cn(
                        'relative w-16 h-8 rounded-full transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-900',
                        devFeeEnabled ? 'bg-blue-500' : 'bg-gray-600',
                        devFeeLoading && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform duration-300',
                          devFeeEnabled ? 'translate-x-8' : 'translate-x-0'
                        )}
                      />
                    </button>
                  </div>

                  <div className={cn(
                    'p-4 rounded-lg border-2 transition-all',
                    devFeeEnabled
                      ? 'bg-green-900/20 border-green-500/50'
                      : 'bg-red-900/20 border-red-500/50'
                  )}>
                    <div className="flex items-center gap-3">
                      {devFeeEnabled ? (
                        <>
                          <CheckCircle2 className="w-6 h-6 text-green-400 flex-shrink-0" />
                          <div>
                            <p className="text-green-400 font-semibold">Development Fee Enabled</p>
                            <p className="text-gray-300 text-sm mt-1">
                              Thank you for supporting the development of this application!
                              1 in 17 solutions will contribute to continued improvements.
                            </p>
                          </div>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-6 h-6 text-red-400 flex-shrink-0" />
                          <div>
                            <p className="text-red-400 font-semibold">Development Fee Disabled</p>
                            <p className="text-gray-300 text-sm mt-1">
                              Development fee is currently disabled. All solutions will be mined for your wallet addresses.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Current Ratio Display */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 rounded-lg bg-gray-800/50 border border-gray-700 text-center">
                    <div className="text-3xl font-bold text-blue-400 mb-1">1:17</div>
                    <div className="text-sm text-gray-400">Ratio</div>
                  </div>
                  <div className="p-4 rounded-lg bg-gray-800/50 border border-gray-700 text-center">
                    <div className="text-3xl font-bold text-purple-400 mb-1">5.88%</div>
                    <div className="text-sm text-gray-400">Dev Fee Rate</div>
                  </div>
                  <div className="p-4 rounded-lg bg-gray-800/50 border border-gray-700 text-center">
                    <div className="text-3xl font-bold text-green-400 mb-1">94.12%</div>
                    <div className="text-sm text-gray-400">Your Rewards</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div >
  );
}

export default function MiningDashboard() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="text-xl">Loading...</div></div>}>
      <MiningDashboardContent />
    </Suspense>
  );
}
