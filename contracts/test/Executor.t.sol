// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.35;

import {TestBase} from "forge-std/Base.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {stdMath} from "forge-std/StdMath.sol";
import {Vm} from "forge-std/Vm.sol";
import {Executor} from "../src/Executor.sol";
import {CallsLog} from "./CallsLog.sol";

// Cheat code address, see `forge-std/Base.sol`'s `CommonBase` - duplicated here so the libraries
// below (which can't inherit `TestBase`) can also use Foundry's own `vm.assertX` cheatcodes
// instead of a plain `require`, matching the rest of this file.
Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

// Tracks progress consuming a `CallsLog.getLogs()` result.
struct LogsExpect {
    string[] logs;
    uint256 index;
}

using Logs for LogsExpect global;

// Consumes a `CallsLog.getLogs()` result entry by entry. Meant to be used via
// `using Logs for string[];`, e.g.:
//   callsLog.getLogs().expect().log("a").log("b").end();
library Logs {
    function expect(string[] memory logs) internal pure returns (LogsExpect memory) {
        return LogsExpect({logs: logs, index: 0});
    }

    function log(LogsExpect memory state, string memory expected)
        internal
        pure
        returns (LogsExpect memory)
    {
        vm.assertLt(state.index, state.logs.length, "Logs: no more entries");
        vm.assertEq(state.logs[state.index], expected, "Logs: unexpected entry");
        state.index++;
        return state;
    }

    // Asserts that every entry has been consumed by `log`.
    function end(LogsExpect memory state) internal pure {
        vm.assertEq(state.index, state.logs.length, "Logs: not fully consumed");
    }
}

// Tracks progress consuming an `Executor.exec` gas report - `report` is kept whole (unlike a
// shift-and-shrink approach) specifically so `success`/`failure` can compare each entry against
// the one before it.
struct GasReportExpect {
    int256[] report;
    uint256 index;
}

using GasReport for GasReportExpect global;

// Consumes an `Executor.exec` gas report entry by entry. Meant to be used via
// `using GasReport for int256[];`, e.g.:
//   gasReport.expect().success().success().failure().end();
library GasReport {
    // The 1st entry is always a success (the checkpoint before the 1st burst runs, when nothing's
    // failed yet), so it's checked immediately, rather than needing its own `success()` call.
    function expect(int256[] memory report) internal pure returns (GasReportExpect memory) {
        vm.assertGt(report.length, 0, "GasReport: empty");
        vm.assertGt(report[0], int256(0), "GasReport: expected a success entry");
        return GasReportExpect({report: report, index: 1});
    }

    function success(GasReportExpect memory state) internal pure returns (GasReportExpect memory) {
        vm.assertLt(state.index, state.report.length, "GasReport: no more entries");
        vm.assertGt(state.report[state.index], int256(0), "GasReport: expected a success entry");
        advance(state);
        return state;
    }

    function failure(GasReportExpect memory state) internal pure returns (GasReportExpect memory) {
        vm.assertLt(state.index, state.report.length, "GasReport: no more entries");
        vm.assertLt(state.report[state.index], int256(0), "GasReport: expected a failure entry");
        advance(state);
        return state;
    }

    // Asserts that every entry has been consumed by `success`/`failure`.
    function end(GasReportExpect memory state) internal pure {
        vm.assertEq(state.index, state.report.length, "GasReport: not fully consumed");
    }

    // Each entry is `gasleft()` at a later checkpoint than the last, so - regardless of sign - it
    // must be lower.
    function advance(GasReportExpect memory state) private pure {
        vm.assertGt(
            stdMath.abs(state.report[state.index - 1]),
            stdMath.abs(state.report[state.index]),
            "GasReport: gas left didn't strictly decrease"
        );
        state.index++;
    }
}

// A batch under construction for `Executor.exec`, carrying along its target `CallsLog` so it
// doesn't need to be repeated on every `pushCallLog` call.
struct BatchBuilder {
    Executor.Burst[] bursts;
    CallsLog callsLog;
}

using BatchBuilderImpl for BatchBuilder global;

// Incrementally builds a `BatchBuilder` - `Executor.Burst[] memory` has no `push`, so each call
// here allocates a new, 1-larger array and copies the old one into it. E.g.:
//   BatchBuilder memory builder = BatchBuilderImpl.create(callsLog);
//   builder = builder.pushBurst(false).pushCallLog("a").pushBurst(true).pushCallLog("b");
library BatchBuilderImpl {
    // `new` is a reserved keyword in Solidity, so this can't be named that.
    function create(CallsLog callsLog) internal pure returns (BatchBuilder memory) {
        return BatchBuilder({bursts: new Executor.Burst[](0), callsLog: callsLog});
    }

    function pushBurst(BatchBuilder memory builder, bool needsPrev)
        internal
        pure
        returns (BatchBuilder memory)
    {
        return pushBurst(builder, needsPrev, 500_000);
    }

    function pushBurst(BatchBuilder memory builder, bool needsPrev, uint256 gas)
        internal
        pure
        returns (BatchBuilder memory)
    {
        Executor.Burst[] memory newBursts = new Executor.Burst[](builder.bursts.length + 1);
        for (uint256 i = 0; i < builder.bursts.length; i++) {
            newBursts[i] = builder.bursts[i];
        }
        newBursts[builder.bursts.length] =
            Executor.Burst({needsPrev: needsPrev, gas: gas, calls: new Executor.Call[](0)});
        builder.bursts = newBursts;
        return builder;
    }

    // Appends a `CallsLog.addLog(log)` call to the last burst.
    function pushCallLog(BatchBuilder memory builder, string memory log)
        internal
        pure
        returns (BatchBuilder memory)
    {
        return pushCallLog(builder, log, 0);
    }

    function pushCallLog(BatchBuilder memory builder, string memory log, uint256 gas)
        internal
        pure
        returns (BatchBuilder memory)
    {
        Executor.Burst memory lastBurst = builder.bursts[builder.bursts.length - 1];
        Executor.Call[] memory newCalls = new Executor.Call[](lastBurst.calls.length + 1);
        for (uint256 i = 0; i < lastBurst.calls.length; i++) {
            newCalls[i] = lastBurst.calls[i];
        }
        newCalls[lastBurst.calls.length] = Executor.Call({
            target: address(builder.callsLog),
            data: abi.encodeCall(builder.callsLog.addLog, (log)),
            gas: gas
        });
        lastBurst.calls = newCalls;
        builder.bursts[builder.bursts.length - 1] = lastBurst;
        return builder;
    }
}

// `forge-std/Test.sol` pulls in `StdCheats`, which uses the `chainid` opcode - unavailable under
// this project's `evm_version = 'constantinople'` (see foundry.toml) - so only the pieces actually
// needed here (cheatcodes via `vm`, plus assertion helpers) are used instead.
contract ExecutorTest is TestBase, StdAssertions {
    using Logs for string[];
    using GasReport for int256[];

    Executor private executor;
    CallsLog private callsLog;

    function setUp() public {
        executor = new Executor();
        callsLog = new CallsLog();
    }

    function testExecRunsAllBurstsChecksReport() public {
        BatchBuilder memory builder = BatchBuilderImpl.create(callsLog);
        builder = builder.pushBurst(false).pushCallLog("a");
        builder = builder.pushBurst(true).pushCallLog("b1").pushCallLog("b2");
        builder = builder.pushBurst(true).pushCallLog("c1").pushCallLog("c2").pushCallLog("c3");

        int256[] memory gasReport = executor.exec(builder.bursts);

        // 1 report entry before the 1st burst, plus 1 after each burst - all successes, each with
        // strictly less gas left than the one before.
        gasReport.expect().success().success().success().end();

        callsLog.getLogs().expect().log("a").log("b1").log("b2").log("c1").log("c2").log("c3").end();
    }

    function testExecSkipsNeedsPrevBurstsAfterRevertThenContinues() public {
        callsLog.setReverts("bad");

        BatchBuilder memory builder = BatchBuilderImpl.create(callsLog);
        builder = builder.pushBurst(false).pushCallLog("a");
        // Reverts - its 2nd call, `bad`, is configured to revert on `CallsLog` - proving the whole
        // burst is atomic, since its 1st call's own effect never lands either.
        builder = builder.pushBurst(true).pushCallLog("not-reverted").pushCallLog("bad");
        // Skipped entirely - `needsPrev` and the previous burst failed - its call never runs.
        builder = builder.pushBurst(true).pushCallLog("skipped");
        // Runs anyway - `needsPrev` is false, so it's attempted despite the earlier failure.
        builder = builder.pushBurst(false).pushCallLog("c");
        // Runs normally - the previous burst succeeded, so this needs-prev burst isn't skipped.
        builder = builder.pushBurst(true).pushCallLog("d");

        int256[] memory gasReport = executor.exec(builder.bursts);

        // Each entry reflects the outcome of whichever burst last actually ran before it - carried
        // forward unchanged across a skip, since skipping never updates the success flag. Gas is
        // only ever spent, so - regardless of sign - each entry has strictly less left than the one
        // before it, whether the burst in between succeeded, reverted, or was skipped.
        gasReport.expect().success().failure().failure().success().success().end();

        // Neither of the reverted burst's calls land (not even its 1st, `not-reverted`) and
        // "skipped" never runs at all.
        callsLog.getLogs().expect().log("a").log("c").log("d").end();
    }

    function testExecDoesNotRunBurstsWhenSenderIsDrainGas() public {
        BatchBuilder memory builder = BatchBuilderImpl.create(callsLog);
        builder = builder.pushBurst(false).pushCallLog("a");
        builder = builder.pushBurst(true).pushCallLog("b");

        // `execSingle` burns all its gas and reverts immediately when `tx.origin` is this address
        // (see `Executor.sol`) - used by the relay to measure a batch's worst-case gas cost without
        // its calls' side effects actually landing.
        address drainGas = address(bytes20("Executor - drain gas"));
        vm.prank(address(this), drainGas);
        int256[] memory gasReport = executor.exec(builder.bursts);

        // Every burst is forced back to "success" regardless, so a real batch keeps being measured
        // in full, rather than stopping early as if the 1st burst had actually failed.
        gasReport.expect().success().success().end();
        callsLog.getLogs().expect().end();
    }
}
