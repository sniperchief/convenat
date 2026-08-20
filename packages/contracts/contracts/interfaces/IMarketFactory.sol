// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title The two questions a market asks its factory.
/// @notice Markets hold no roles and no pause flag of their own. Both live on
///         the factory so that rotating a compromised resolver, or halting new
///         risk, is one transaction that covers every market at once instead of
///         one transaction per market.
interface IMarketFactory {
    /// @return True if `account` may propose resolutions.
    function isProposer(address account) external view returns (bool);

    /// @return True while new risk is halted. Per ADR-0007 this may block new
    ///         stakes and new markets; it may never block a claim, a refund or a
    ///         cancellation.
    function paused() external view returns (bool);
}
