// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title A token that keeps 1% of every transfer. Test fixture only.
/// @notice Proves that `ConditionalMarket.stake` rejects fee-on-transfer tokens
///         rather than crediting a stake the market never received. Without the
///         balance-delta check, a market denominated in such a token would
///         promise more than it holds and the last claimant would find the
///         balance empty.
contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 100;

    constructor() ERC20("Fee On Transfer", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * FEE_BPS) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0xdead), fee);
    }
}
