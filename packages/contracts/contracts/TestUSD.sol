// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title A worthless test token. NOT A STABLECOIN.
///
/// @notice ############################################################
///         ##  THIS TOKEN IS NOT BACKED BY ANYTHING.                 ##
///         ##  ANYONE CAN MINT AN UNLIMITED SUPPLY, FOR FREE.        ##
///         ##  IT IS NOT A STABLECOIN AND HAS NO VALUE.              ##
///         ############################################################
///
/// It exists because no settlement-token address on X Layer testnet has been
/// confirmed by this project, and inventing one would be worse than shipping an
/// obviously fake token (ADR-0005). Six decimals, to match the stablecoins a
/// real deployment would use, so amounts in tests carry over unchanged.
///
/// Deployment is restricted to an explicit allowlist of development chains. A
/// denylist of known mainnets would fail open on every chain nobody thought of;
/// an allowlist fails closed, which is the correct direction for a contract that
/// mints free money.
///
/// The real settlement token is supplied to each market at creation from a
/// deployment manifest. Nothing in this protocol has a token address compiled
/// into it.
contract TestUSD is ERC20 {
    /// @notice Hardhat / local development.
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    /// @notice X Layer Testnet, as recorded in @covenant/shared. Still marked
    ///         `unverified` there; Milestone 4 confirms it against a live node.
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;

    /// @notice Ceiling per `mint` call. Not a security control — anyone may call
    ///         it again immediately. It exists so a fat-fingered test amount
    ///         fails loudly instead of producing a nonsensical balance.
    uint256 public constant MAX_MINT_PER_CALL = 1_000_000_000 * 1e6;

    error NotADevelopmentChain(uint256 chainId);
    error MintAmountTooLarge(uint256 amount, uint256 maximum);

    constructor() ERC20("Test USD (NOT A STABLECOIN)", "TUSD") {
        if (block.chainid != LOCAL_CHAIN_ID && block.chainid != XLAYER_TESTNET_CHAIN_ID) {
            revert NotADevelopmentChain(block.chainid);
        }
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Free money, for anyone, on development chains only.
    /// @dev Intentionally unpermissioned: a faucet with an owner is a faucet that
    ///      stops working the moment that key is lost. The constructor's chain
    ///      allowlist is what keeps this from ever mattering.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT_PER_CALL) revert MintAmountTooLarge(amount, MAX_MINT_PER_CALL);
        _mint(to, amount);
    }
}
