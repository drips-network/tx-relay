// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.35;

struct Burst {
    bool needsPrev;
    uint256 gas;
    Call[] calls;
}

struct Call {
    address target;
    bytes data;
    uint256 gas;
}

// forge-lint: disable-next-line(unsafe-typecast)
address constant DRAIN_GAS_WALLET = address(bytes20("Executor - drain gas"));

contract Executor {
    event Receipt(int256[] gasReport);

    function exec(Burst[] calldata bursts) public returns (int256[] memory gasReport) {
        gasReport = new int256[](bursts.length + 1);
        bool success = true;
        // forge-lint: disable-next-item(boolean-cst)
        for (uint256 idx = 0; true; idx++) {
            // forge-lint: disable-next-item(unsafe-typecast)
            gasReport[idx] = success ? int256(gasleft()) : -int256(gasleft());
            if (idx == bursts.length) break;
            Burst calldata burst = bursts[idx];
            if (!success && burst.needsPrev) continue;
            // forge-lint: disable-next-item(return-bomb, calls-loop, low-level-calls)
            (success,) =
                address(this).call{gas: burst.gas}(abi.encodeCall(this.execSingle, (burst.calls)));
            // forge-lint: disable-next-line(tx-origin)
            if (tx.origin == DRAIN_GAS_WALLET) {
                // forge-lint: disable-next-item(
                //     require-revert-in-loop, literal-instead-of-constant, custom-errors)
                // Assert that there was enough gas to cover the burst gas limit in full
                require(gasleft() * 63 >= burst.gas);
                // Do not skip the next burst in the sequence
                success = true;
            }
        }
        // forge-lint: disable-next-item(reentrancy-events)
        emit Receipt(gasReport);
    }

    /// @param burstsGas The gas needed to execute `bursts`.
    /// It must be at least entire gas needed to call `exec`, including any leftover gas,
    /// but it may exclude the TX overhead, e.g. the calldata cost.
    function execNext(Burst[] calldata bursts, uint256 burstsGas, Call[] calldata nextBurstCalls)
        external
        returns (uint256 nextBurstGas)
    {
        // Assert that exec has as much gas as it requires.
        uint256 gasAfter = gasleft() - burstsGas;
        int256[] memory results = exec(bursts);
        // Burn any possible leftover gas to avoid it overshadowing the next call's gas requirement.
        while (gasleft() > gasAfter) continue;
        for (uint256 i = 0; i < results.length; i++) {
            // forge-lint: disable-next-item(require-revert-in-loop, custom-errors)
            require(results[i] > 0);
        }
        // forge-lint: disable-next-item(literal-instead-of-constant)
        // Measure gas passed into the burst.
        nextBurstGas = gasleft() * 63 / 64;
        this.execSingle(nextBurstCalls);
    }

    function execSingle(Call[] calldata calls) external {
        // forge-lint: disable-next-line(tx-origin)
        if (tx.origin == DRAIN_GAS_WALLET) {
            // Burn all available gas and revert
            while (true) continue;
        }
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata nextCall = calls[i];
            uint256 gasLimit = nextCall.gas;
            if (gasLimit == 0) gasLimit = gasleft();
            address target = nextCall.target;
            bytes memory data = nextCall.data;
            bool success;
            // forge-lint: disable-next-item(inline-assembly)
            assembly ("memory-safe") {
                success := call(gasLimit, target, 0, add(data, 32), mload(data), 0, 0)
            }
            // forge-lint: disable-next-item(require-revert-in-loop, custom-errors)
            require(success);
        }
    }
}
