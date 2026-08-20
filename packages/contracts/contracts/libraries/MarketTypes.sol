// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title Shared vocabularies for the market lifecycle.
/// @notice Every enum here is closed. Widening one is a protocol change, not a
///         refactor, because off-chain indexing decodes these values by ordinal.
library MarketTypes {
    /// @notice Lifecycle position of a market.
    ///
    /// There is no separate `CHALLENGE_PERIOD` member. The challenge period is
    /// exactly `RESOLUTION_PROPOSED` before `challengeEndsAt()`; representing it
    /// as its own state would require a transaction to enter it at a timestamp,
    /// and nothing can transition a contract without one. Deriving it from the
    /// clock is the honest encoding.
    ///
    /// `CANCELLED` is terminal and never becomes `SETTLED`: a cancelled market
    /// is unwound, not settled, and collapsing the two would erase why the
    /// funds came back.
    enum State {
        OPEN, // 0 - accepting stakes
        CLOSED, // 1 - trading ended, awaiting a resolution proposal
        RESOLUTION_PROPOSED, // 2 - proposal standing; challenge window running
        CHALLENGED, // 3 - awaiting the single permitted second proposal
        FINALIZED, // 4 - outcome fixed, winnings claimable
        SETTLED, // 5 - every winning stake has been withdrawn
        CANCELLED // 6 - unwound; stakes and bond refundable
    }

    /// @notice A market outcome, and also the side a stake backs.
    ///
    /// One enum serves both roles on purpose: a separate `Side { YES, NO }`
    /// would have YES at ordinal 0 while `Outcome.YES` sits at 1, and every
    /// conversion between them would be a place to introduce an off-by-one that
    /// pays the wrong side.
    ///
    /// `INVALID` is a definite determination that the condition cannot be
    /// decided on approved evidence; it routes to refunds. There is no
    /// `UNRESOLVED` member — an unresolved condition must leave the contract
    /// untouched, so the resolver expresses that by proposing nothing at all.
    enum Outcome {
        UNSET, // 0 - no outcome recorded
        YES, // 1
        NO, // 2
        INVALID // 3 - undecidable; refund everyone
    }

    /// @notice Why a market was unwound.
    enum CancellationReason {
        NONE, // 0
        NO_RESOLUTION, // 1 - no proposal before the resolution deadline
        NO_REVIEW, // 2 - challenged, but no second proposal before the review deadline
        RESOLVED_INVALID // 3 - a proposal of INVALID survived its challenge window
    }
}
