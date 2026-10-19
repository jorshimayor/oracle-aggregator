// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILiquidityVaultExternal {
    function reserve(uint256 amount) external;
    function release(uint256 amount, address to) external;
}

contract LiquidityVault is ILiquidityVaultExternal, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotRateLock();
    error InsufficientAvailable();
    error InsufficientShares();
    error RateLockAlreadySet();
    error ZeroAmount();
    error ZeroAddress();
    error NotAContract();

    IERC20 public immutable usdc;
    address public rateLock;
    uint256 public totalShares;
    uint256 public totalReserved;
    mapping(address => uint256) public shares;

    event Deposited(address indexed lp, uint256 usdcAmount, uint256 shares);
    event Withdrawn(address indexed lp, uint256 shares, uint256 usdcAmount);
    event Reserved(uint256 amount);
    event Released(uint256 amount, address indexed to);
    event RateLockSet(address rateLock);

    modifier onlyRateLock() {
        if (msg.sender != rateLock) revert NotRateLock();
        _;
    }

    constructor(address _usdc, address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_usdc.code.length == 0) revert NotAContract();
        usdc = IERC20(_usdc);
    }

    function setRateLock(address _rateLock) external onlyOwner {
        if (_rateLock == address(0)) revert ZeroAddress();
        if (rateLock != address(0)) revert RateLockAlreadySet();
        rateLock = _rateLock;
        emit RateLockSet(_rateLock);
    }

    function totalBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function availableBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this)) - totalReserved;
    }

    function deposit(uint256 usdcAmount) external nonReentrant {
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 mintShares;
        uint256 balanceBefore = usdc.balanceOf(address(this));

        if (totalShares < 1) {
            mintShares = usdcAmount * 1e12;
        } else {
            mintShares = (usdcAmount * totalShares) / balanceBefore;
        }

        shares[msg.sender] += mintShares;
        totalShares += mintShares;

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        emit Deposited(msg.sender, usdcAmount, mintShares);
    }

    function withdraw(uint256 sharesToBurn) external nonReentrant {
        if (sharesToBurn == 0) revert ZeroAmount();

        uint256 userShares = shares[msg.sender];
        if (sharesToBurn > userShares) revert InsufficientShares();

        uint256 balance = usdc.balanceOf(address(this));
        uint256 usdcOut = (sharesToBurn * balance) / totalShares;

        if (usdcOut > availableBalance()) revert InsufficientAvailable();

        shares[msg.sender] = userShares - sharesToBurn;
        totalShares -= sharesToBurn;

        usdc.safeTransfer(msg.sender, usdcOut);

        emit Withdrawn(msg.sender, sharesToBurn, usdcOut);
    }

    function reserve(uint256 amount) external nonReentrant onlyRateLock {
        if (amount == 0) revert ZeroAmount();
        if (amount > availableBalance()) revert InsufficientAvailable();

        totalReserved += amount;

        emit Reserved(amount);
    }

    function release(uint256 amount, address to) external nonReentrant onlyRateLock {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalReserved) revert InsufficientAvailable();

        totalReserved -= amount;

        if (to != address(this)) {
            usdc.safeTransfer(to, amount);
        }

        emit Released(amount, to);
    }
}
