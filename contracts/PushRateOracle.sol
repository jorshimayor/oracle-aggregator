// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IPushRateOracleExternal {
    function rate(bytes32 pair, uint256 maxAge) external view returns (uint256 rate1e8, uint256 updatedAt);
    function latestData(bytes32 pair) external view returns (uint256 rate1e8, uint256 updatedAt);
}

contract PushRateOracle is IPushRateOracleExternal, Ownable {
    error StaleRate(bytes32 pair, uint256 updatedAt);
    error NotOperator();
    error ZeroRate();
    error UnknownPair(bytes32 pair);
    error ZeroOperator();
    error ZeroAddress();

    struct RateData {
        uint256 rate1e8;
        uint256 updatedAt;
    }

    address public operator;
    mapping(bytes32 => RateData) private _rates;

    event RateSet(bytes32 indexed pair, uint256 rate1e8, uint256 timestamp);
    event OperatorUpdated(address indexed newOperator);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address initialOperator, address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (initialOperator == address(0)) revert ZeroOperator();
        operator = initialOperator;
    }

    function set(bytes32 pair, uint256 rate1e8) external onlyOperator {
        if (rate1e8 == 0) revert ZeroRate();

        _rates[pair] = RateData({rate1e8: rate1e8, updatedAt: block.timestamp});

        emit RateSet(pair, rate1e8, block.timestamp);
    }

    function rate(bytes32 pair, uint256 maxAge) external view returns (uint256 rate1e8, uint256 updatedAt) {
        RateData memory data = _rates[pair];
        if (data.updatedAt < 1) revert UnknownPair(pair);
        if (block.timestamp - data.updatedAt > maxAge) revert StaleRate(pair, data.updatedAt);

        return (data.rate1e8, data.updatedAt);
    }

    function latestData(bytes32 pair) external view returns (uint256 rate1e8, uint256 updatedAt) {
        RateData memory data = _rates[pair];
        return (data.rate1e8, data.updatedAt);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroOperator();
        operator = newOperator;

        emit OperatorUpdated(newOperator);
    }
}
