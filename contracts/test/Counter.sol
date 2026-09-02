// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.35;

contract Counter {
    uint256 public count;

    function add(uint256 value) external {
        require(value != 0, "value must be non-zero");
        count += value;
    }
}
