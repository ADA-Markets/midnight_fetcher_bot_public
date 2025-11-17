"use client";
import React, { useEffect, useState } from 'react';

interface AddressItem {
  index: number;
  address: string;
  publicKeyHex: string;
  registered: boolean;
  totalUserSolutions: number;
}

interface AddressesResponse {
  success: boolean;
  addresses: AddressItem[];
  donors: AddressItem[];
  suggestedRecipient: AddressItem | null;
  error?: string;
}

export default function ConsolidatePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<AddressItem[]>([]);
  const [donors, setDonors] = useState<AddressItem[]>([]);
  const [recipient, setRecipient] = useState<string>("");
  const [selectedDonors, setSelectedDonors] = useState<number[]>([]);
  const [password, setPassword] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<any | null>(null);
  const [dryRun, setDryRun] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/wallet/addresses', { cache: 'no-store' });
        const data: AddressesResponse = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to load addresses');
        setAddresses(data.addresses);
        setDonors(data.donors);
        if (data.suggestedRecipient) {
          setRecipient(data.suggestedRecipient.address);
        }
        setSelectedDonors(data.donors.map(d => d.index));
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const toggleDonor = (idx: number) => {
    setSelectedDonors(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]);
  };

  const submit = async () => {
    setError(null);
    setResults(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/wallet/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          recipientAddress: recipient,
          addressIndexes: selectedDonors,
          dryRun,
          maxRetries: 3,
          initialBackoffSeconds: 20,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Consolidation failed');
      }
      setResults(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-6 text-gray-100">Loading addresses…</div>;
  if (error) return <div className="p-6 text-red-400">{error}</div>;

  return (
    <div className="p-6 text-gray-100 space-y-6">
      <h1 className="text-2xl font-semibold">Consolidate NIGHT Allocations</h1>
      <p className="text-sm text-gray-400">Only addresses with &gt; 0 user solutions are eligible.</p>

      <div className="space-y-2">
        <label className="block text-sm text-gray-300">Recipient Address</label>
        <input
          className="w-full bg-gray-800 rounded px-3 py-2 text-gray-100 border border-gray-700"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="addr1..."
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-gray-300">Wallet Password</label>
        <input
          type="password"
          className="w-full bg-gray-800 rounded px-3 py-2 text-gray-100 border border-gray-700"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter wallet password"
        />
      </div>

      <div className="flex items-center gap-3">
        <input id="dryRun" type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        <label htmlFor="dryRun" className="text-sm text-gray-300">Dry run (don’t call donate_to; show signed curl instead)</label>
      </div>

      <div className="space-y-2">
        <div className="text-sm text-gray-300">Eligible Donor Addresses ({donors.length})</div>
        <div className="max-h-80 overflow-auto border border-gray-800 rounded">
          {donors.length === 0 && (
            <div className="p-3 text-gray-400">No addresses with user solutions found.</div>
          )}
          {donors.map(d => (
            <label key={d.index} className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <input type="checkbox" checked={selectedDonors.includes(d.index)} onChange={() => toggleDonor(d.index)} />
                <div>
                  <div className="text-sm">Index {d.index} — {d.address.slice(0, 24)}…</div>
                  <div className="text-xs text-gray-400">User solutions: {d.totalUserSolutions}</div>
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={submit}
          disabled={submitting || !password || !recipient || selectedDonors.length === 0}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded"
        >
          {submitting ? 'Submitting…' : (dryRun ? 'Preview (Dry Run)' : 'Consolidate Now')}
        </button>
      </div>

      {results && (
        <div className="space-y-3">
          <div className="text-lg font-semibold">Results</div>
          <div className="text-sm text-gray-300">Signed message:</div>
          <pre className="bg-gray-900 p-3 rounded text-xs overflow-auto">{results.message}</pre>
          <div className="text-sm text-gray-300">Per-donor status ({results.donors} donors):</div>
          <div className="space-y-2">
            {results.results?.map((r: any) => {
              const isSuccess = !dryRun && ((r?.response?.status === 'success') || (r?.status === 200 && typeof r?.response?.message === 'string'));
              return (
                <div key={r.index} className="bg-gray-900 p-3 rounded text-xs space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div><span className="text-gray-400">Index:</span> {r.index}</div>
                    {isSuccess && (
                      <span className="px-2 py-0.5 text-[10px] rounded bg-green-600/20 text-green-400 border border-green-600/40">
                        Complete
                      </span>
                    )}
                  </div>
                  <div><span className="text-gray-400">Donor:</span> {r.donor}</div>
                  <div><span className="text-gray-400">User solutions:</span> {r.totalUserSolutions}</div>
                  <div><span className="text-gray-400">Signed:</span> {String(r.signed)}</div>
                  {dryRun ? (
                    <>
                      <div className="text-gray-400">Curl:</div>
                      <pre className="bg-black/40 p-2 rounded overflow-auto">{r.curl}</pre>
                    </>
                  ) : (
                    <>
                      <div><span className="text-gray-400">HTTP status:</span> {r.status}</div>
                      <div className="text-gray-400">Response:</div>
                      <pre className="bg-black/40 p-2 rounded overflow-auto">{JSON.stringify(r.response, null, 2)}</pre>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
