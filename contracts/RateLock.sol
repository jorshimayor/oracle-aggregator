// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILiquidityVault {
    function reserve(uint256 amount) external;
    function release(uint256 amount, address to) external;
}

interface IPushRateOracle {
    function rate(bytes32 pair, uint256 maxAge) external view returns (uint256 rate1e8, uint256 updatedAt);
    function latestData(bytes32 pair) external view returns (uint256 rate1e8, uint256 updatedAt);
}

contract RateLock is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error CorridorNotConfigured();
    error InvalidUsdcIn();
    error InvalidRate();
    error InvalidExpiry();
    error ZeroPayoutTo();
    error NotOpen();
    error NotExpired();
    error NotRefundable();
    error OracleAvailable();
    error ExcessiveGap();
    error RateSlippageExceeded();
    error OracleUnavailableAtOpen();
    error RescueTooEarly();
    error ZeroAddress();
    error NotAContract();
    error CorridorTimelockRequired();
    error CorridorNotReady();

    IERC20 public immutable usdc;
    ILiquidityVault public immutable vault;
    uint256 public nextId;
    uint256 public constant CORRIDOR_TIMELOCK = 24 hours;

    struct CorridorParams {
        IPushRateOracle oracle;
        uint32 premiumBps;
        uint32 maxMoveBps;
        uint32 slippageBps;
        uint256 maxUsdcIn;
        uint64 maxExpiry;
        uint64 oracleMaxAge;
        uint64 graceWindow;
    }

    struct PendingCorridor {
        CorridorParams params;
        uint256 validAt;
    }

    mapping(bytes32 => CorridorParams) public corridors;
    mapping(bytes32 => PendingCorridor) public pendingCorridors;

    enum LockStatus {
        Open,
        Settled,
        Refunded
    }

    struct Lock {
        bytes32 pair;
        uint256 usdcIn;
        uint256 lockedRate1e8;
        uint256 lockedLocal;
        uint256 reserved;
        uint64 expiry;
        address taker;
        address payoutTo;
        LockStatus status;
    }

    mapping(uint256 => Lock) public locks;

    event LockOpened(
        uint256 indexed id,
        bytes32 indexed pair,
        uint256 usdcIn,
        uint256 lockedRate1e8,
        uint256 lockedLocal,
        uint256 reserved,
        uint64 expiry,
        address payoutTo
    );
    event LockSettled(uint256 indexed id, uint256 realizedRate1e8, uint256 payoutUsdc, int256 lpPnl);
    event LockRefunded(uint256 indexed id);
    event CorridorSet(bytes32 indexed pair, CorridorParams params);
    event CorridorProposed(bytes32 indexed pair, uint256 validAt);

    constructor(address _vault, address _usdc, address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (_vault == address(0) || _usdc == address(0)) revert ZeroAddress();
        if (_vault.code.length == 0) revert NotAContract();
        if (_usdc.code.length == 0) revert NotAContract();

        vault = ILiquidityVault(_vault);
        usdc = IERC20(_usdc);
    }

    function quotePremium(uint256 usdcIn, bytes32 pair) external view returns (uint256) {
        CorridorParams memory params = corridors[pair];
        return (uint256(params.premiumBps) * usdcIn) / 10_000;
    }

    function openLock(
        bytes32 pair,
        uint256 usdcIn,
        uint256 lockedRate1e8,
        uint64 expiry,
        address payoutTo
    ) external nonReentrant returns (uint256 id) {
        CorridorParams memory params = corridors[pair];

        if (address(params.oracle) == address(0)) revert CorridorNotConfigured();
        if (usdcIn == 0 || usdcIn > params.maxUsdcIn) revert InvalidUsdcIn();
        if (lockedRate1e8 == 0) revert InvalidRate();
        if (expiry <= block.timestamp || expiry > block.timestamp + params.maxExpiry) revert InvalidExpiry();
        if (payoutTo == address(0)) revert ZeroPayoutTo();

        // Check oracle freshness via latestData (no revert), then read via rate() for staleness enforcement
        (, uint256 latestUpdatedAt) = params.oracle.latestData(pair);
        if (latestUpdatedAt < 1 || block.timestamp - latestUpdatedAt > params.oracleMaxAge) {
            revert OracleUnavailableAtOpen();
        }
        (uint256 oracleRate1e8,) = params.oracle.rate(pair, params.oracleMaxAge);

        uint256 rateDelta = lockedRate1e8 > oracleRate1e8 ? lockedRate1e8 - oracleRate1e8 : oracleRate1e8 - lockedRate1e8;
        if (rateDelta * 10_000 > oracleRate1e8 * uint256(params.slippageBps)) revert RateSlippageExceeded();

        uint256 premium = (usdcIn * uint256(params.premiumBps)) / 10_000;
        uint256 reserved = (usdcIn * uint256(params.maxMoveBps)) / 10_000;
        uint256 lockedLocal = (usdcIn * lockedRate1e8) / 1e8;

        usdc.safeTransferFrom(msg.sender, address(this), usdcIn + premium);
        usdc.safeTransfer(address(vault), premium);

        vault.reserve(reserved);

        id = nextId;
        nextId = id + 1;

        locks[id] = Lock({
            pair: pair,
            usdcIn: usdcIn,
            lockedRate1e8: lockedRate1e8,
            lockedLocal: lockedLocal,
            reserved: reserved,
            expiry: expiry,
            taker: msg.sender,
            payoutTo: payoutTo,
            status: LockStatus.Open
        });

        emit LockOpened(id, pair, usdcIn, lockedRate1e8, lockedLocal, reserved, expiry, payoutTo);

        return id;
    }

    function settle(uint256 id) external nonReentrant {
        Lock storage lockData = locks[id];

        if (lockData.status != LockStatus.Open) revert NotOpen();
        if (block.timestamp < lockData.expiry) revert NotExpired();

        CorridorParams memory params = corridors[lockData.pair];
        (uint256 realizedRate1e8,) = params.oracle.rate(lockData.pair, params.oracleMaxAge);

        uint256 payoutUsdc = (lockData.lockedLocal * 1e8) / realizedRate1e8;
        uint256 cap = lockData.usdcIn + lockData.reserved;
        if (payoutUsdc > cap) {
            payoutUsdc = cap;
        }

        lockData.status = LockStatus.Settled;

        int256 lpPnl = int256(lockData.usdcIn) - int256(payoutUsdc);

        if (payoutUsdc > lockData.usdcIn) {
            uint256 gap = payoutUsdc - lockData.usdcIn;
            if (gap > lockData.reserved) revert ExcessiveGap();

            uint256 surplusReserve = lockData.reserved - gap;

            vault.release(gap, address(this));
            if (surplusReserve > 0) {
                vault.release(surplusReserve, address(vault));
            }

            usdc.safeTransfer(lockData.payoutTo, payoutUsdc);
        } else {
            uint256 surplus = lockData.usdcIn - payoutUsdc;

            if (lockData.reserved > 0) {
                vault.release(lockData.reserved, address(vault));
            }

            usdc.safeTransfer(lockData.payoutTo, payoutUsdc);
            if (surplus > 0) {
                usdc.safeTransfer(address(vault), surplus);
            }
        }

        emit LockSettled(id, realizedRate1e8, payoutUsdc, lpPnl);
    }

    function refund(uint256 id) external nonReentrant {
        Lock storage lockData = locks[id];

        if (lockData.status != LockStatus.Open) revert NotOpen();

        CorridorParams memory params = corridors[lockData.pair];
        if (block.timestamp < lockData.expiry + params.graceWindow) revert NotRefundable();

        (, uint256 updatedAt) = params.oracle.latestData(lockData.pair);
        if (updatedAt >= 1 && block.timestamp - updatedAt <= params.oracleMaxAge) revert OracleAvailable();

        lockData.status = LockStatus.Refunded;

        if (lockData.reserved > 0) {
            vault.release(lockData.reserved, address(vault));
        }
        usdc.safeTransfer(lockData.taker, lockData.usdcIn);

        emit LockRefunded(id);
    }

    function rescueStuckLock(uint256 id) external onlyOwner nonReentrant {
        Lock storage lockData = locks[id];

        if (lockData.status != LockStatus.Open) revert NotOpen();

        CorridorParams memory params = corridors[lockData.pair];
        if (block.timestamp < uint256(lockData.expiry) + uint256(params.graceWindow) + 7 days) revert RescueTooEarly();

        lockData.status = LockStatus.Refunded;

        if (lockData.reserved > 0) {
            vault.release(lockData.reserved, address(vault));
        }
        usdc.safeTransfer(lockData.payoutTo, lockData.usdcIn);

        emit LockRefunded(id);
    }

    function proposeCorridor(bytes32 pair, CorridorParams calldata params) external onlyOwner {
        if (address(params.oracle) == address(0)) revert CorridorNotConfigured();
        if (params.slippageBps > 500) revert InvalidRate();

        uint256 validAt = block.timestamp + CORRIDOR_TIMELOCK;
        pendingCorridors[pair] = PendingCorridor({params: params, validAt: validAt});

        emit CorridorProposed(pair, validAt);
    }

    function executeCorridor(bytes32 pair) external onlyOwner {
        PendingCorridor memory pending = pendingCorridors[pair];
        if (pending.validAt == 0 || block.timestamp < pending.validAt) revert CorridorNotReady();

        corridors[pair] = pending.params;
        delete pendingCorridors[pair];

        emit CorridorSet(pair, pending.params);
    }

    function setCorridor(bytes32 pair, CorridorParams calldata params) external onlyOwner {
        if (address(params.oracle) == address(0)) revert CorridorNotConfigured();
        if (params.slippageBps > 500) revert InvalidRate();

        if (address(corridors[pair].oracle) != address(0)) revert CorridorTimelockRequired();

        corridors[pair] = params;

        emit CorridorSet(pair, params);
    }
}
