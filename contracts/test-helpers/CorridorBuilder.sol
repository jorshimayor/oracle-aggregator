// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Global import to pull IPushRateOracle into scope without naming conflicts.
import {RateLock, IPushRateOracle} from "../RateLock.sol";

/// @dev Build a RateLock.CorridorParams struct from an oracle address.
///      Decouples the IPushRateOracle type cast from the test contract, which
///      cannot reference it directly due to name-collision rules in Solidity.
library CorridorBuilder {
    function build(
        address oracle,
        uint32 premiumBps,
        uint32 maxMoveBps,
        uint32 slippageBps,
        uint256 maxUsdcIn,
        uint64 maxExpiry,
        uint64 oracleMaxAge,
        uint64 graceWindow
    ) internal pure returns (RateLock.CorridorParams memory) {
        return RateLock.CorridorParams({
            oracle:       IPushRateOracle(oracle),
            premiumBps:   premiumBps,
            maxMoveBps:   maxMoveBps,
            slippageBps:  slippageBps,
            maxUsdcIn:    maxUsdcIn,
            maxExpiry:    maxExpiry,
            oracleMaxAge: oracleMaxAge,
            graceWindow:  graceWindow
        });
    }
}
