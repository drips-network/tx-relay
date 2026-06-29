// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.35;

event Receipts(Receipt[] receipts);

struct Call {
    address target;
    bytes data;
}

struct Sequence {
    uint256 gasLimit;
    Call[][] batches;
}

struct Receipt {
    uint256 successes;
    uint256 gasUsed;
}

contract Executor {
    function execSequences(Sequence[] calldata bundle) external returns (Receipt[] memory receipts) {
        receipts = new Receipt[](bundle.length);
        for(uint256 i = 0; i < bundle.length; i++) {
            Sequence calldata sequence = bundle[i];
            uint256 gasLimit = sequence.gasLimit;
            bytes memory args = abi.encodeCall(this.execBatches, (sequence.batches));

            uint256 successes;
            uint256 gas = gasleft();
            assembly ("memory-safe") {
                let success := call(gasLimit, address(), 0, add(32, args), mload(args), 0, 32)
                // The first 32 bytes of return data is written to memory starting from index 0.
                // If there's a success, the data is the uint256 number of successes,
                // which is multiplied by 1 and unchanged.
                // If there's a revert, the data is either an error payload or junk if no data is
                // returned, in which case it's multiplied by 0 and always ends up as 0 successes.
                // This is a branchless implementation preventing sequences' results
                // from having any effect on gas usage of the bundle execution loop.
                successes := mul(mload(0), success)
            }
            receipts[i] = Receipt({ successes: successes, gasUsed: gas - gasleft()});
        }
        emit Receipts(receipts);
        return receipts;
    }

    function execBatches(Call[][] calldata batches) external returns (uint256 successes){
        if(tx.origin == address(bytes20("Executor - drain gas")))
            assembly("memory-safe") { invalid() }
        while(successes < batches.length) {
            try this.execCalls(batches[successes]) {
                successes++;
            }
            catch(bytes memory) {
                require(tx.origin != address(bytes20("Executor - no revert")));
                break;
            }
        }
    }

    function execCalls(Call[] calldata calls) external {
        for(uint256 i = 0; i < calls.length; i++) {
            Call calldata call = calls[i];
            (bool success,) = call.target.call(call.data);
            require(success);
        }
    }
}
