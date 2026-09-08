// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.35;

contract CallsLog {
    string[] private logs;
    mapping(string => bool) private reverts;
    mapping(string => uint256) private gasPenalties;

    function addLog(string calldata log) external {
        require(!reverts[log], "CallsLog: configured to revert");

        uint256 gasPenalty = gasPenalties[log];
        uint256 gas = gasleft();
        while (gas - gasleft() < gasPenalty) continue;

        logs.push(log);
    }

    function getLogs() external view returns (string[] memory) {
        return logs;
    }

    function setReverts(string calldata log) external {
        reverts[log] = true;
    }

    function setGasPenalty(string calldata log, uint256 gas) external {
        gasPenalties[log] = gas;
    }
}
