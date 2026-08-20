// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrancyTarget {
    function claim() external returns (uint256);
    function withdrawRefund() external returns (uint256);
    function stake(uint8 side, uint256 amount) external;
}

/// @title A token that calls back into the market during `transfer`. Test only.
/// @notice Stands in for the ERC777-style hooks and callback tokens that make
///         real reentrancy possible. Arming it and then claiming should hit the
///         reentrancy guard, not a second payout.
///
///         The re-entrant call is made from within `_update`, i.e. part-way
///         through the market's own outbound transfer — the exact moment a naive
///         implementation would still have stale accounting.
contract ReentrantToken is ERC20 {
    enum Attack {
        NONE,
        CLAIM,
        WITHDRAW_REFUND
    }

    address public target;
    Attack public attack;
    bool public attempted;
    bool public reentryReverted;
    /// @notice Revert payload from the re-entrant call, so a test can assert it
    ///         was the reentrancy guard that stopped it and not some incidental
    ///         check further down.
    bytes public lastRevertData;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, Attack attack_) external {
        target = target_;
        attack = attack_;
        attempted = false;
        reentryReverted = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        // Fire only on funds leaving the market, and only once.
        if (attack == Attack.NONE || attempted || from != target || target == address(0)) return;
        attempted = true;

        if (attack == Attack.CLAIM) {
            try IReentrancyTarget(target).claim() returns (uint256) {
                reentryReverted = false;
            } catch (bytes memory reason) {
                reentryReverted = true;
                lastRevertData = reason;
            }
        } else {
            try IReentrancyTarget(target).withdrawRefund() returns (uint256) {
                reentryReverted = false;
            } catch (bytes memory reason) {
                reentryReverted = true;
                lastRevertData = reason;
            }
        }
    }
}
