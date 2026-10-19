import { useState, useCallback, useEffect } from 'react'
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain,
} from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi, parseUnits, formatUnits } from 'viem'
import { toast } from 'sonner'
import { ArrowRight, Lock, TrendingUp, BarChart3, ExternalLink, RefreshCw } from 'lucide-react'
import { arcTestnet } from 'viem/chains'

// ─── Contract addresses (Arc Testnet) ─────────────────────────────────────
const VAULT_ADDRESS   = '0x1b4e782b2d95bcaa14f4e8e9b59787878470b4a4' as `0x${string}`
const ORACLE_ADDRESS  = '0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154' as `0x${string}`
const RATELOCK_ADDRESS = '0x372d0965f14dcd66263ee10941af08473a7149c3' as `0x${string}`
const USDC_ADDRESS    = '0x3600000000000000000000000000000000000001' as `0x${string}`
const ARC_CHAIN_ID    = arcTestnet.id   // 5042002

// bytes32("USD/NGN") — right-padded, 32 bytes
const USD_NGN_PAIR = '0x5553442f4e474e00000000000000000000000000000000000000000000000000' as `0x${string}`

// ─── ABIs (minimal) ────────────────────────────────────────────────────────
const VAULT_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'usdcAmount', type: 'uint256' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'sharesToBurn', type: 'uint256' }], outputs: [] },
  { name: 'shares', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalShares', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalReserved', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'availableBalance', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const ORACLE_ABI = [
  { name: 'latestData', type: 'function', stateMutability: 'view', inputs: [{ name: 'pair', type: 'bytes32' }], outputs: [{ name: 'rate1e8', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }] },
] as const

const RATELOCK_ABI = [
  { name: 'openLock', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'pair', type: 'bytes32' }, { name: 'usdcIn', type: 'uint256' }, { name: 'lockedRate1e8', type: 'uint256' }, { name: 'expiry', type: 'uint64' }, { name: 'payoutTo', type: 'address' }], outputs: [{ name: 'id', type: 'uint256' }] },
  { name: 'settle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }], outputs: [] },
  { name: 'quotePremium', type: 'function', stateMutability: 'view', inputs: [{ name: 'usdcIn', type: 'uint256' }, { name: 'pair', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { name: 'nextId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'locks', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: 'pair', type: 'bytes32' }, { name: 'usdcIn', type: 'uint256' }, { name: 'lockedRate1e8', type: 'uint256' }, { name: 'lockedLocal', type: 'uint256' }, { name: 'reserved', type: 'uint256' }, { name: 'expiry', type: 'uint64' }, { name: 'taker', type: 'address' }, { name: 'payoutTo', type: 'address' }, { name: 'status', type: 'uint8' }] },
] as const

// ─── Helpers ───────────────────────────────────────────────────────────────
const fmt6 = (v: bigint) => Number(formatUnits(v, 6)).toFixed(2)
const fmtRate = (r: bigint) => (Number(r) / 1e8).toFixed(2)
const explorerTx = (hash: string) => `https://explorer.arctest.io/tx/${hash}`

type Tab = 'vault' | 'lock' | 'settle'

// ─── WrongChain banner ─────────────────────────────────────────────────────
function WrongChainBanner() {
  const { chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  if (chainId === ARC_CHAIN_ID) return null
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium"
      style={{ background: 'rgba(186,43,76,0.18)', border: '1px solid var(--danger)', color: '#fca5a5' }}>
      <span style={{ color: 'var(--danger)' }}>Switch to Arc Testnet to use RateLock.</span>
      <button
        onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
        disabled={isPending}
        className="ml-auto rounded-lg px-3 py-1 text-xs font-semibold transition"
        style={{ background: 'var(--danger)', color: '#fff' }}>
        {isPending ? 'Switching…' : 'Switch Network'}
      </button>
    </div>
  )
}

// ─── Vault Panel ───────────────────────────────────────────────────────────
function VaultPanel() {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')

  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
    args: address ? [address] : undefined, chainId: ARC_CHAIN_ID,
    query: { enabled: !!address },
  })
  const { data: myShares, refetch: refetchShares } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: VAULT_ABI, functionName: 'shares',
    args: address ? [address] : undefined, chainId: ARC_CHAIN_ID,
    query: { enabled: !!address && !!VAULT_ADDRESS },
  })
  const { data: totalShares } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: VAULT_ABI, functionName: 'totalShares',
    chainId: ARC_CHAIN_ID, query: { enabled: !!VAULT_ADDRESS },
  })
  const { data: availBal } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: VAULT_ABI, functionName: 'availableBalance',
    chainId: ARC_CHAIN_ID, query: { enabled: !!VAULT_ADDRESS },
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance',
    args: address && VAULT_ADDRESS ? [address, VAULT_ADDRESS] : undefined,
    chainId: ARC_CHAIN_ID, query: { enabled: !!address && !!VAULT_ADDRESS },
  })

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  const parsedAmount = amount ? parseUnits(amount, 6) : 0n
  const needsApproval = mode === 'deposit' && allowance !== undefined && parsedAmount > allowance

  const handleAction = useCallback(() => {
    if (!address) return
    if (chainId !== ARC_CHAIN_ID) { switchChain({ chainId: ARC_CHAIN_ID }); return }
    if (!VAULT_ADDRESS) { toast.error('Vault address not set.'); return }

    try {
      if (mode === 'deposit') {
        if (needsApproval) {
          writeContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [VAULT_ADDRESS, parsedAmount] })
        } else {
          writeContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'deposit', args: [parsedAmount] })
        }
      } else {
        // withdraw: sharesToBurn = amount as share units (1e12 scale from 6-decimal USDC)
        const sharesToBurn = parsedAmount * 1_000_000_000_000n
        writeContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'withdraw', args: [sharesToBurn] })
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Transaction failed')
    }
  }, [address, chainId, mode, parsedAmount, needsApproval, switchChain, writeContract])

  if (isSuccess) {
    void refetchBalance(); void refetchShares(); void refetchAllowance()
    toast.success(
      <span>Done! <a href={explorerTx(txHash!)} target="_blank" rel="noopener" className="underline">View on explorer</a></span>
    )
    reset()
  }

  const lpShareValue = myShares && totalShares && availBal && totalShares > 0n
    ? (myShares * availBal) / totalShares : 0n

  return (
    <div className="space-y-4">
      {/* LP stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Your USDC" value={usdcBalance !== undefined ? `${fmt6(usdcBalance)} USDC` : '—'} />
        <StatCard label="Your Pool Value" value={myShares !== undefined ? `${fmt6(lpShareValue)} USDC` : '—'} />
      </div>
      {availBal !== undefined && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Pool available: <span className="tabular" style={{ color: 'var(--muted)' }}>{fmt6(availBal)} USDC</span>
        </p>
      )}

      {/* Mode toggle */}
      <div className="flex rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
        {(['deposit', 'withdraw'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className="flex-1 py-2 text-sm font-semibold capitalize transition"
            style={{ background: mode === m ? 'var(--accent)' : 'transparent', color: mode === m ? '#0d1b2f' : 'var(--muted)' }}>
            {m}
          </button>
        ))}
      </div>

      {/* Amount */}
      <AmountInput value={amount} onChange={setAmount} label="USDC amount" placeholder="0.00" />

      <ActionButton
        onClick={handleAction}
        isPending={isPending}
        isConfirming={isConfirming}
        disabled={!parsedAmount}
        label={needsApproval ? 'Approve USDC' : mode === 'deposit' ? 'Deposit to Pool' : 'Withdraw from Pool'}
      />
    </div>
  )
}

// ─── Lock Panel ────────────────────────────────────────────────────────────
function LockPanel() {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [usdcIn, setUsdcIn] = useState('')
  const [days, setDays] = useState('7')

  const { data: oracleData } = useReadContract({
    address: ORACLE_ADDRESS || undefined, abi: ORACLE_ABI, functionName: 'latestData',
    args: [USD_NGN_PAIR], chainId: ARC_CHAIN_ID,
    query: { enabled: !!ORACLE_ADDRESS, refetchInterval: 30_000 },
  })
  const currentRate = oracleData?.[0] ?? 0n
  const updatedAt = oracleData?.[1] ?? 0n

  const parsedUsdcIn = usdcIn ? parseUnits(usdcIn, 6) : 0n

  const { data: premium } = useReadContract({
    address: RATELOCK_ADDRESS || undefined, abi: RATELOCK_ABI, functionName: 'quotePremium',
    args: parsedUsdcIn > 0n ? [parsedUsdcIn, USD_NGN_PAIR] : undefined,
    chainId: ARC_CHAIN_ID, query: { enabled: !!RATELOCK_ADDRESS && parsedUsdcIn > 0n },
  })

  const lockedLocal = parsedUsdcIn > 0n && currentRate > 0n
    ? (parsedUsdcIn * currentRate) / 100_000_000n : 0n

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance',
    args: address && RATELOCK_ADDRESS ? [address, RATELOCK_ADDRESS] : undefined,
    chainId: ARC_CHAIN_ID, query: { enabled: !!address && !!RATELOCK_ADDRESS },
  })

  const totalNeeded = parsedUsdcIn + (premium ?? 0n)
  const needsApproval = allowance !== undefined && totalNeeded > allowance && totalNeeded > 0n

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  const handleAction = useCallback(() => {
    if (!address) return
    if (chainId !== ARC_CHAIN_ID) { switchChain({ chainId: ARC_CHAIN_ID }); return }
    if (!RATELOCK_ADDRESS) { toast.error('RateLock not deployed yet.'); return }

    if (needsApproval) {
      writeContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [RATELOCK_ADDRESS, totalNeeded] })
    } else {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + parseInt(days) * 86400)
      writeContract({
        address: RATELOCK_ADDRESS, abi: RATELOCK_ABI, functionName: 'openLock',
        args: [USD_NGN_PAIR, parsedUsdcIn, currentRate, expiry, address],
      })
    }
  }, [address, chainId, needsApproval, parsedUsdcIn, currentRate, days, totalNeeded, switchChain, writeContract])

  if (isSuccess) {
    void refetchAllowance()
    toast.success(
      <span>Lock opened! <a href={explorerTx(txHash!)} target="_blank" rel="noopener" className="underline">View on explorer</a></span>
    )
    reset()
  }

  const [clockSec, setClockSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setClockSec(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(t)
  }, [])
  const ageMinutes = updatedAt > 0n ? Math.floor((clockSec - Number(updatedAt)) / 60) : null

  return (
    <div className="space-y-4">
      {/* Oracle rate */}
      <div className="rounded-xl p-4" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>Live Rate · USD/NGN</p>
        <p className="display text-3xl font-semibold" style={{ color: 'var(--ink)' }}>
          {currentRate > 0n ? `₦${fmtRate(currentRate)}` : '—'}
          <span className="text-base font-normal ml-2" style={{ color: 'var(--subtle)' }}>per USDC</span>
        </p>
        {ageMinutes !== null && (
          <p className="text-xs mt-1" style={{ color: ageMinutes > 120 ? 'var(--danger)' : 'var(--subtle)' }}>
            Updated {ageMinutes < 1 ? '< 1 min' : `${ageMinutes} min`} ago
            {ageMinutes > 120 && ' · stale'}
          </p>
        )}
      </div>

      <AmountInput value={usdcIn} onChange={setUsdcIn} label="Amount to lock (USDC)" placeholder="0.00" />

      {/* Expiry */}
      <div>
        <label className="text-xs mb-1 block" style={{ color: 'var(--subtle)' }}>Lock duration</label>
        <div className="flex gap-2">
          {['1', '7', '30'].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition"
              style={{ background: days === d ? 'var(--accent)' : 'var(--surface-muted)', color: days === d ? '#0d1b2f' : 'var(--muted)', border: '1px solid var(--border)' }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Preview */}
      {parsedUsdcIn > 0n && currentRate > 0n && (
        <div className="rounded-xl p-4 space-y-2 text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <PreviewRow label="Guaranteed local value" value={`₦${fmt6(lockedLocal)}`} highlight />
          <PreviewRow label="Premium" value={premium !== undefined ? `${fmt6(premium)} USDC` : '…'} />
          <PreviewRow label="Total needed" value={premium !== undefined ? `${fmt6(totalNeeded)} USDC` : '…'} />
          <PreviewRow label="Locked rate" value={`₦${fmtRate(currentRate)}/USDC`} />
        </div>
      )}

      <ActionButton
        onClick={handleAction}
        isPending={isPending}
        isConfirming={isConfirming}
        disabled={!parsedUsdcIn || !currentRate}
        label={needsApproval ? 'Approve USDC' : 'Open Lock'}
      />
    </div>
  )
}

// ─── Settle Panel ──────────────────────────────────────────────────────────
function LockRow({ id }: { id: bigint }) {
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  // Refresh clock every minute so canSettle flips without page reload
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(t)
  }, [])

  const { data: lock } = useReadContract({
    address: RATELOCK_ADDRESS || undefined, abi: RATELOCK_ABI, functionName: 'locks',
    args: [id], chainId: ARC_CHAIN_ID, query: { enabled: !!RATELOCK_ADDRESS },
  })
  const { data: oracleData } = useReadContract({
    address: ORACLE_ADDRESS || undefined, abi: ORACLE_ABI, functionName: 'latestData',
    args: [USD_NGN_PAIR], chainId: ARC_CHAIN_ID,
    query: { enabled: !!ORACLE_ADDRESS, refetchInterval: 30_000 },
  })

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  if (isSuccess) {
    toast.success(
      <span>Lock #{id.toString()} settled! <a href={explorerTx(txHash!)} target="_blank" rel="noopener" className="underline">View on explorer <ExternalLink size={12} className="inline" /></a></span>
    )
    reset()
  }

  if (!lock) return null
  const [, usdcIn, lockedRate1e8, lockedLocal, , expiry, , , status] = lock
  if (status !== 0) return null // only show Open locks

  const canSettle = BigInt(nowSec) >= expiry
  const expiryDate = new Date(Number(expiry) * 1000).toLocaleDateString()

  const currentRate = oracleData?.[0] ?? 0n
  const projPayout = currentRate > 0n ? (lockedLocal * 100_000_000n) / currentRate : 0n
  const cap = usdcIn + ((usdcIn * 1000n) / 10000n) // approximate cap at 10% maxMove
  const cappedPayout = projPayout > cap ? cap : projPayout
  const lpGain = Number(usdcIn) - Number(cappedPayout)

  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium" style={{ color: 'var(--subtle)' }}>Lock #{id.toString()} · USD/NGN</p>
          <p className="display text-lg font-semibold mt-0.5" style={{ color: 'var(--ink)' }}>{fmt6(usdcIn)} USDC locked</p>
        </div>
        <span className="text-xs px-2 py-1 rounded-full font-medium"
          style={{ background: canSettle ? 'rgba(141,216,159,0.15)' : 'rgba(172,198,233,0.12)', color: canSettle ? 'var(--success)' : 'var(--accent)' }}>
          {canSettle ? 'Ready' : 'Pending'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p style={{ color: 'var(--subtle)' }}>Locked rate</p>
          <p className="tabular font-semibold mt-0.5" style={{ color: 'var(--ink-2)' }}>₦{fmtRate(lockedRate1e8)}</p>
        </div>
        <div>
          <p style={{ color: 'var(--subtle)' }}>Current rate</p>
          <p className="tabular font-semibold mt-0.5" style={{ color: 'var(--ink-2)' }}>
            {currentRate > 0n ? `₦${fmtRate(currentRate)}` : '—'}
          </p>
        </div>
        <div>
          <p style={{ color: 'var(--subtle)' }}>Expires</p>
          <p className="tabular font-semibold mt-0.5" style={{ color: 'var(--ink-2)' }}>{expiryDate}</p>
        </div>
        <div>
          <p style={{ color: 'var(--subtle)' }}>Est. payout</p>
          <p className="tabular font-semibold mt-0.5" style={{ color: lpGain < 0 ? 'var(--success)' : 'var(--danger)' }}>
            {currentRate > 0n ? `${fmt6(cappedPayout)} USDC` : '—'}
          </p>
        </div>
      </div>

      <ActionButton
        onClick={() => {
          if (chainId !== ARC_CHAIN_ID) { switchChain({ chainId: ARC_CHAIN_ID }); return }
          if (!RATELOCK_ADDRESS) { toast.error('RateLock not deployed yet.'); return }
          writeContract({ address: RATELOCK_ADDRESS, abi: RATELOCK_ABI, functionName: 'settle', args: [id] })
        }}
        isPending={isPending}
        isConfirming={isConfirming}
        disabled={!canSettle}
        label={canSettle ? 'Settle Lock' : `Settles ${expiryDate}`}
        compact
      />
    </div>
  )
}

function SettlePanel() {
  const { address } = useAccount()
  const [lockId, setLockId] = useState('')

  const { data: nextId } = useReadContract({
    address: RATELOCK_ADDRESS || undefined, abi: RATELOCK_ABI, functionName: 'nextId',
    chainId: ARC_CHAIN_ID, query: { enabled: !!RATELOCK_ADDRESS, refetchInterval: 10_000 },
  })

  const ids: bigint[] = nextId !== undefined
    ? Array.from({ length: Number(nextId) }, (_, i) => BigInt(i))
    : []

  // Filter to show only entered lock ID if provided, else show all
  const displayIds = lockId && !isNaN(parseInt(lockId))
    ? [BigInt(parseInt(lockId))]
    : ids

  if (!address) return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-center" style={{ color: 'var(--subtle)' }}>
      <Lock size={32} style={{ opacity: 0.4 }} />
      <p className="text-sm">Connect your wallet to see locks.</p>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Search by ID */}
      <div>
        <label className="text-xs mb-1 block" style={{ color: 'var(--subtle)' }}>Filter by lock ID (optional)</label>
        <input
          type="number" min="0" value={lockId} onChange={e => setLockId(e.target.value)}
          placeholder="0"
          className="w-full rounded-xl px-4 py-3 text-sm outline-none transition"
          style={{ background: 'var(--surface-muted)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        />
      </div>

      {!RATELOCK_ADDRESS ? (
        <div className="rounded-xl p-4 text-sm text-center" style={{ background: 'var(--surface)', color: 'var(--subtle)' }}>
          No contracts configured.
        </div>
      ) : displayIds.length === 0 ? (
        <div className="rounded-xl p-4 text-sm text-center" style={{ background: 'var(--surface)', color: 'var(--subtle)' }}>
          No open locks found.
        </div>
      ) : (
        <div className="space-y-3">
          {displayIds.map(id => <LockRow key={id.toString()} id={id} />)}
        </div>
      )}
    </div>
  )
}

// ─── Shared components ─────────────────────────────────────────────────────
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <p className="text-xs mb-1" style={{ color: 'var(--subtle)' }}>{label}</p>
      <p className="tabular font-semibold text-sm" style={{ color: 'var(--ink)' }}>{value}</p>
    </div>
  )
}

function PreviewRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--subtle)' }}>{label}</span>
      <span className="tabular font-semibold" style={{ color: highlight ? 'var(--success)' : 'var(--ink-2)' }}>{value}</span>
    </div>
  )
}

function AmountInput({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <div>
      <label className="text-xs mb-1 block" style={{ color: 'var(--subtle)' }}>{label}</label>
      <div className="flex items-center rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <input
          type="number" min="0" step="0.01" value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent px-4 py-3 text-lg font-semibold outline-none tabular"
          style={{ color: 'var(--ink)' }}
        />
        <span className="px-4 text-sm font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
      </div>
    </div>
  )
}

function ActionButton({ onClick, isPending, isConfirming, disabled, label, compact }: {
  onClick: () => void; isPending: boolean; isConfirming: boolean; disabled: boolean; label: string; compact?: boolean
}) {
  const busy = isPending || isConfirming
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`w-full ${compact ? 'py-2.5 text-sm' : 'py-3.5 text-base'} rounded-xl font-semibold transition flex items-center justify-center gap-2`}
      style={{
        background: disabled || busy ? 'var(--surface-muted)' : 'var(--accent)',
        color: disabled || busy ? 'var(--subtle)' : '#0d1b2f',
        cursor: disabled || busy ? 'not-allowed' : 'pointer',
      }}
    >
      {busy ? <RefreshCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
      {isPending ? 'Confirm in wallet…' : isConfirming ? 'Confirming…' : label}
    </button>
  )
}

// ─── App ────────────────────────────────────────────────────────────────────
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'vault', label: 'Fund Pool', icon: <BarChart3 size={16} /> },
  { id: 'lock', label: 'Open Lock', icon: <Lock size={16} /> },
  { id: 'settle', label: 'Settle', icon: <TrendingUp size={16} /> },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('lock')
  const { isConnected } = useAccount()

  return (
    <div className="min-h-dvh flex flex-col" style={{ background: 'var(--bg-gradient)' }}>
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-4 max-w-lg mx-auto w-full">
        <div>
          <h1 className="display text-xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>RateLock</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>FX rate protection · Arc Testnet</p>
        </div>
        <ConnectKitButton />
      </header>

      {/* Main card */}
      <main className="flex-1 flex flex-col items-center px-4 pb-8">
        <div className="w-full max-w-lg">
          {isConnected && <WrongChainBanner />}

          {/* Tabs */}
          <div className="flex gap-1 p-1 rounded-2xl mb-4" style={{ background: 'var(--surface-muted)' }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-semibold transition"
                style={{
                  background: tab === t.id ? 'var(--surface-strong)' : 'transparent',
                  color: tab === t.id ? 'var(--ink)' : 'var(--subtle)',
                  boxShadow: tab === t.id ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
                }}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* Panel */}
          <div className="rounded-2xl p-5" style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
            {!isConnected ? (
              <div className="flex flex-col items-center justify-center py-10 gap-4">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'var(--surface-muted)' }}>
                  <Lock size={24} style={{ color: 'var(--accent)' }} />
                </div>
                <div className="text-center">
                  <p className="display font-semibold text-lg" style={{ color: 'var(--ink)' }}>Connect to get started</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--subtle)' }}>Lock today's USD/NGN rate, guaranteed in USDC.</p>
                </div>
                <ConnectKitButton label="Connect Wallet" />
              </div>
            ) : (
              <>
                {tab === 'vault' && <VaultPanel />}
                {tab === 'lock' && <LockPanel />}
                {tab === 'settle' && <SettlePanel />}
              </>
            )}
          </div>

          {/* Footer note */}
          <p className="text-center text-xs mt-4" style={{ color: 'var(--subtle)', opacity: 0.6 }}>
            Contracts on Arc Testnet · demo with test USDC
          </p>
        </div>
      </main>
    </div>
  )
}
