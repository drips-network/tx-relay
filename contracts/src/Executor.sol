// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.35;

event Receipt(int256[] gasReport);

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

contract Executor {
    function exec(Burst[] calldata bursts) public returns (int256[] memory gasReport) {
        gasReport = new int256[](bursts.length + 1);
        bool success = true;
        for (uint256 idx = 0; true; idx++) {
            gasReport[idx] = success ? int256(gasleft()) : -int256(gasleft());
            if (idx == bursts.length) break;
            Burst calldata burst = bursts[idx];
            if (!success && burst.needsPrev) continue;
            (success,) =
                address(this).call{gas: burst.gas}(abi.encodeCall(this.execSingle, (burst.calls)));
            // forge-lint: disable-next-line(unsafe-typecast)
            if (tx.origin == address(bytes20("Executor - drain gas"))) {
                // Assert that there was enough gas to cover the burst gas limit in full
                require(gasleft() * 63 >= burst.gas);
                // Do not skip the next burst in the sequence
                success = true;
            }
        }
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
            require(results[i] > 0);
        }
        // Measure gas passed into the burst.
        nextBurstGas = gasleft() * 63 / 64;
        this.execSingle(nextBurstCalls);
    }

    function execSingle(Call[] calldata calls) external {
        // forge-lint: disable-next-line(unsafe-typecast)
        if (tx.origin == address(bytes20("Executor - drain gas"))) {
            // Burn all available gas and revert
            assembly ("memory-safe") { invalid() }
        }
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata call = calls[i];
            uint256 gas = call.gas;
            if (gas == 0) gas = gasleft();
            (bool success,) = call.target.call{gas: gas}(call.data);
            require(success);
        }
    }
}
