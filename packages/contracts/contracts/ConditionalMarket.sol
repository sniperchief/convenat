// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {IMarketFactory} from "./interfaces/IMarketFactory.sol";
import {MarketTypes} from "./libraries/MarketTypes.sol";

/// @title A single conditional agreement, custodying its own funds.
/// @notice One clone per condition. This contract is the source of truth for
///         every financial fact about that condition; the backend database is a
///         cache and may never override it.
///
/// What each actor can do here:
///
/// - Anyone with a stake: `stake`, `challenge`, `claim`, `withdrawRefund`.
/// - The resolver (`PROPOSER_ROLE` on the factory): `proposeResolution`, and
///   nothing else. It cannot move funds, alter `rulesHash`, change the token,
///   or finalize its own proposal early.
/// - The admin: nothing. There is no admin function on this contract at all.
///   The factory's pause can stop new stakes; it cannot touch money already
///   here, and it cannot block a claim, a refund or a cancellation.
/// - Anyone at all: `close`, `finalize`, `cancel`. Every liveness-critical
///   transition is permissionless, so an absent or broken backend can delay
///   settlement but can never strand funds.
///
/// Only two 32-byte commitments are stored: `rulesHash` for the approved
/// specification and `evidenceHash` for the resolution's evidence package. The
/// documents themselves stay off-chain — see docs/canonical-specification.md.
/// @dev Uses the non-upgradeable `ReentrancyGuard` even though this contract is
///      cloned. That is deliberate and safe: OpenZeppelin 5.x keeps the guard in
///      an ERC-7201 namespaced slot and tests it with `== ENTERED`, so a clone's
///      zero-initialised slot behaves exactly like `NOT_ENTERED` despite never
///      running the implementation's constructor. There is no
///      `ReentrancyGuardUpgradeable` in contracts-upgradeable 5.6 to use
///      instead, and `ReentrancyGuardTransient` is ruled out because it needs
///      TSTORE, which the `paris` EVM target excludes for zkEVM compatibility.
contract ConditionalMarket is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Protocol limits
    //
    // Mirrored from SPEC_LIMITS in @covenant/shared so a specification that
    // validates off-chain cannot be rejected on-chain, or vice versa.
    // -------------------------------------------------------------------------

    uint32 public constant MIN_CHALLENGE_WINDOW = 60;
    uint32 public constant MAX_CHALLENGE_WINDOW = 30 days;
    uint32 public constant MIN_RESOLUTION_WINDOW = 1 hours;
    uint32 public constant MAX_RESOLUTION_WINDOW = 90 days;

    /// @notice The hard cap that makes the challenge process terminate.
    /// One initial proposal, one permitted replacement, and no more.
    uint8 public constant MAX_PROPOSAL_ROUNDS = 2;

    // -------------------------------------------------------------------------
    // Configuration, immutable after initialization
    //
    // Not Solidity `immutable`, because this contract is a clone: `immutable`
    // values live in the implementation's bytecode and would be shared by every
    // market. Immutability is enforced instead by there being no function that
    // writes any of these after `initialize`.
    // -------------------------------------------------------------------------

    /// @notice The factory that created this market. Source of the proposer role
    ///         and the pause flag.
    address public factory;
    /// @notice The wallet that approved the rules and opened this market.
    ///         Holds no privileges here beyond those of any other participant.
    address public creator;
    /// @notice Sequential id assigned by the factory.
    uint256 public marketId;
    /// @notice The settlement token. Supplied from a deployment manifest, never
    ///         a compiled-in constant.
    IERC20 public token;

    /// @notice keccak256 of the canonical approved specification.
    /// @dev Written once in `initialize`. No function anywhere — admin, resolver,
    ///      creator or otherwise — can change it afterwards.
    bytes32 public rulesHash;

    /// @notice Last instant a stake is accepted.
    uint64 public tradingEndsAt;
    /// @notice The instant the real-world condition is measured against.
    uint64 public conditionDeadline;
    /// @notice Seconds a proposal stays contestable.
    uint32 public challengeWindow;
    /// @notice Seconds allowed to produce a proposal, measured from
    ///         `conditionDeadline` for the first and from `challengedAt` for the
    ///         replacement. Once elapsed, anyone may cancel into refunds.
    uint32 public resolutionWindow;
    /// @notice Bond a challenger must post, in token base units. May be zero.
    uint256 public challengeBond;

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    MarketTypes.State public state;
    MarketTypes.Outcome public proposedOutcome;
    MarketTypes.Outcome public finalOutcome;
    MarketTypes.CancellationReason public cancellationReason;

    /// @notice 0 before any proposal, 1 after the first, 2 after the replacement.
    uint8 public proposalRound;
    /// @notice When true, nobody wins: every participant withdraws their own
    ///         stake. Set by cancellation, and by a finalized outcome whose
    ///         winning side attracted no stake at all.
    bool public refundMode;

    uint64 public proposedAt;
    uint64 public challengedAt;
    uint64 public finalizedAt;

    /// @notice keccak256 of the canonical evidence package backing the standing
    ///         proposal. Replaced only by the one permitted second proposal;
    ///         once finalized it is the evidence for the final outcome.
    bytes32 public evidenceHash;

    // -------------------------------------------------------------------------
    // Challenge
    // -------------------------------------------------------------------------

    address public challenger;
    bytes32 public challengeReasonHash;
    /// @notice The outcome that was challenged, kept so finalization can decide
    ///         the bond without an arbiter: if the final outcome differs, the
    ///         challenge was informative.
    MarketTypes.Outcome public challengedOutcome;
    /// @notice True while a posted bond is still owed back to the challenger.
    bool public bondOutstanding;
    /// @notice Set at finalization. False means the bond was folded into the pool.
    bool public bondRefundable;

    // -------------------------------------------------------------------------
    // Money
    // -------------------------------------------------------------------------

    uint256 public totalYes;
    uint256 public totalNo;
    /// @notice A forfeited challenge bond, added to the distributable pool.
    uint256 public forfeitedBond;

    /// @notice Stake units still withdrawable.
    ///
    /// Tracked in *stake*, not payout, which is what lets `SETTLED` be exact:
    /// payouts floor and would never sum to the pool, but stakes always sum to
    /// the side total.
    uint256 public remainingClaimableStake;

    mapping(address => uint256) public yesStake;
    mapping(address => uint256) public noStake;
    /// @notice Set before any transfer, so a second attempt finds nothing.
    mapping(address => bool) public hasClaimed;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event StakePlaced(
        uint256 indexed marketId,
        address indexed staker,
        MarketTypes.Outcome indexed side,
        uint256 amount,
        uint256 totalYes,
        uint256 totalNo
    );
    event MarketClosed(uint256 indexed marketId, uint64 closedAt, uint256 totalYes, uint256 totalNo);
    event ResolutionProposed(
        uint256 indexed marketId,
        address indexed proposer,
        MarketTypes.Outcome indexed outcome,
        bytes32 evidenceHash,
        uint8 round,
        uint64 proposedAt,
        uint64 challengeEndsAt
    );
    event ResolutionChallenged(
        uint256 indexed marketId,
        address indexed challenger,
        MarketTypes.Outcome indexed challengedOutcome,
        bytes32 reasonHash,
        uint256 bond,
        uint64 challengedAt,
        uint64 reviewDeadline
    );
    event MarketFinalized(
        uint256 indexed marketId,
        MarketTypes.Outcome indexed outcome,
        bytes32 evidenceHash,
        uint256 pool,
        bool refundMode,
        uint64 finalizedAt
    );
    event MarketCancelled(
        uint256 indexed marketId,
        MarketTypes.CancellationReason indexed reason,
        uint256 refundablePool,
        uint64 cancelledAt
    );
    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed claimant,
        MarketTypes.Outcome indexed outcome,
        uint256 stake,
        uint256 payout
    );
    event RefundWithdrawn(uint256 indexed marketId, address indexed claimant, uint256 amount);
    event ChallengeBondReturned(uint256 indexed marketId, address indexed challenger, uint256 amount);
    event MarketSettled(uint256 indexed marketId, uint64 settledAt);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error AlreadyClaimed();
    error BondForfeited();
    error ChallengePeriodActive();
    error ChallengeRoundExhausted();
    error ChallengeWindowClosed();
    error ConditionNotDue();
    error DeadlineBeforeTradingEnd();
    error InvalidChallengeWindow();
    error InvalidOutcome();
    error InvalidResolutionWindow();
    error InvalidSide();
    error InvalidState(MarketTypes.State current);
    error MissingEvidenceHash();
    error MissingReason();
    error MissingRulesHash();
    error NotAParticipant();
    error NotChallenger();
    error NotInRefundMode();
    error NothingToClaim();
    error NotProposer();
    error ProposalRoundsExhausted();
    error RefundModeActive();
    error ResolutionWindowActive();
    error ReviewWindowActive();
    error StakingPaused();
    error TimestampOverflow();
    error TradingClosed();
    error TradingEndsInThePast();
    error TradingStillOpen();
    error UnsupportedToken();
    error ZeroAddress();
    error ZeroAmount();

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// @dev Locks the implementation. Without this, anyone could initialize the
    ///      implementation contract itself and, on an upgradeable pattern, use it
    ///      as a foothold. Clones are unaffected: they have their own storage.
    constructor() {
        _disableInitializers();
    }

    struct InitParams {
        uint256 marketId;
        address creator;
        address token;
        bytes32 rulesHash;
        uint64 tradingEndsAt;
        uint64 conditionDeadline;
        uint32 challengeWindow;
        uint32 resolutionWindow;
        uint256 challengeBond;
    }

    /// @notice One-time setup, called by the factory in the same transaction that
    ///         deploys the clone.
    /// @dev `initializer` makes a second call impossible. `factory` is set to the
    ///      caller, so a clone deployed by anyone other than our factory answers
    ///      to that deployer's role registry and is simply not part of this
    ///      protocol's registry.
    function initialize(InitParams calldata params) external initializer {
        if (params.creator == address(0) || params.token == address(0)) revert ZeroAddress();
        if (params.rulesHash == bytes32(0)) revert MissingRulesHash();
        if (params.tradingEndsAt <= block.timestamp) revert TradingEndsInThePast();
        if (params.conditionDeadline < params.tradingEndsAt) revert DeadlineBeforeTradingEnd();
        if (
            params.challengeWindow < MIN_CHALLENGE_WINDOW
                || params.challengeWindow > MAX_CHALLENGE_WINDOW
        ) revert InvalidChallengeWindow();
        if (
            params.resolutionWindow < MIN_RESOLUTION_WINDOW
                || params.resolutionWindow > MAX_RESOLUTION_WINDOW
        ) revert InvalidResolutionWindow();
        // Both deadlines are read as uint64 elsewhere; prove the sums cannot wrap.
        if (
            uint256(params.conditionDeadline) + uint256(params.resolutionWindow) > type(uint64).max
                || uint256(params.tradingEndsAt) + uint256(params.challengeWindow) > type(uint64).max
        ) revert TimestampOverflow();

        factory = msg.sender;
        marketId = params.marketId;
        creator = params.creator;
        token = IERC20(params.token);
        rulesHash = params.rulesHash;
        tradingEndsAt = params.tradingEndsAt;
        conditionDeadline = params.conditionDeadline;
        challengeWindow = params.challengeWindow;
        resolutionWindow = params.resolutionWindow;
        challengeBond = params.challengeBond;

        state = MarketTypes.State.OPEN;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice When the standing proposal stops being contestable. Zero before
    ///         any proposal exists.
    function challengeEndsAt() public view returns (uint64) {
        if (proposedAt == 0) return 0;
        return proposedAt + challengeWindow;
    }

    /// @notice After this, anyone may cancel a market that never received a
    ///         proposal.
    function resolutionDeadline() public view returns (uint64) {
        return conditionDeadline + resolutionWindow;
    }

    /// @notice After this, anyone may cancel a challenged market that never
    ///         received its replacement proposal. Zero before any challenge.
    function reviewDeadline() public view returns (uint64) {
        if (challengedAt == 0) return 0;
        return challengedAt + resolutionWindow;
    }

    /// @notice Everything distributable to winners: both sides' stakes plus any
    ///         forfeited bond.
    function pool() public view returns (uint256) {
        return totalYes + totalNo + forfeitedBond;
    }

    /// @notice What `account` would receive from `claim()` right now.
    /// @dev View only; returns 0 whenever a claim would revert.
    function previewClaim(address account) external view returns (uint256) {
        if (state != MarketTypes.State.FINALIZED && state != MarketTypes.State.SETTLED) return 0;
        if (refundMode || hasClaimed[account]) return 0;
        uint256 winningTotal = finalOutcome == MarketTypes.Outcome.YES ? totalYes : totalNo;
        if (winningTotal == 0) return 0;
        uint256 stakeAmount =
            finalOutcome == MarketTypes.Outcome.YES ? yesStake[account] : noStake[account];
        if (stakeAmount == 0) return 0;
        return Math.mulDiv(stakeAmount, pool(), winningTotal);
    }

    /// @notice Total stake `account` holds across both sides.
    function stakeOf(address account) external view returns (uint256 yes, uint256 no) {
        return (yesStake[account], noStake[account]);
    }

    // -------------------------------------------------------------------------
    // OPEN: funding
    // -------------------------------------------------------------------------

    /// @notice Back one side of the condition.
    /// @param side `Outcome.YES` or `Outcome.NO`.
    /// @param amount Token base units. Must be non-zero.
    ///
    /// @dev The transfer precedes the bookkeeping because the amount actually
    ///      received has to be measured before it can be credited. That inverts
    ///      checks-effects-interactions, so this function is `nonReentrant` and
    ///      moves no funds out; a token that calls back can only reach a
    ///      reverting entry point.
    ///
    ///      The balance-delta equality check rejects fee-on-transfer and
    ///      rebasing tokens outright (ADR-0005). Crediting a stake the contract
    ///      never received would silently dilute every other participant.
    function stake(MarketTypes.Outcome side, uint256 amount) external nonReentrant {
        _requireState(MarketTypes.State.OPEN);
        // Checked independently of `state`: nobody has to have called `close()`
        // yet for trading to be over.
        if (block.timestamp >= tradingEndsAt) revert TradingClosed();
        if (IMarketFactory(factory).paused()) revert StakingPaused();
        if (side != MarketTypes.Outcome.YES && side != MarketTypes.Outcome.NO) revert InvalidSide();
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - balanceBefore != amount) revert UnsupportedToken();

        if (side == MarketTypes.Outcome.YES) {
            yesStake[msg.sender] += amount;
            totalYes += amount;
        } else {
            noStake[msg.sender] += amount;
            totalNo += amount;
        }

        emit StakePlaced(marketId, msg.sender, side, amount, totalYes, totalNo);
    }

    // -------------------------------------------------------------------------
    // OPEN -> CLOSED
    // -------------------------------------------------------------------------

    /// @notice End trading. Permissionless: liveness must not depend on the
    ///         backend, and closing harms nobody.
    function close() public {
        _requireState(MarketTypes.State.OPEN);
        if (block.timestamp < tradingEndsAt) revert TradingStillOpen();
        state = MarketTypes.State.CLOSED;
        emit MarketClosed(marketId, uint64(block.timestamp), totalYes, totalNo);
    }

    /// @dev Applies the same guarded transition as `close()`, so a caller who
    ///      arrives at `proposeResolution` or `cancel` on an unclosed market is
    ///      not deadlocked behind someone else's transaction. This follows the
    ///      state machine rather than bypassing it: the guard is identical and
    ///      the event still fires.
    function _closeIfDue() internal {
        if (state == MarketTypes.State.OPEN && block.timestamp >= tradingEndsAt) {
            close();
        }
    }

    // -------------------------------------------------------------------------
    // CLOSED / CHALLENGED -> RESOLUTION_PROPOSED
    // -------------------------------------------------------------------------

    /// @notice Record a proposed outcome and its evidence commitment.
    /// @dev The only privileged function on this contract, and it moves no money.
    ///      A proposal never makes funds claimable — `finalize()` does, and only
    ///      after the challenge window has run.
    function proposeResolution(MarketTypes.Outcome outcome, bytes32 evidenceHash_)
        external
        nonReentrant
    {
        if (!IMarketFactory(factory).isProposer(msg.sender)) revert NotProposer();

        _closeIfDue();
        if (state != MarketTypes.State.CLOSED && state != MarketTypes.State.CHALLENGED) {
            revert InvalidState(state);
        }
        // The condition is measured at its deadline; before that there is
        // nothing to have observed.
        if (block.timestamp < conditionDeadline) revert ConditionNotDue();
        if (outcome == MarketTypes.Outcome.UNSET) revert InvalidOutcome();
        if (evidenceHash_ == bytes32(0)) revert MissingEvidenceHash();
        if (proposalRound >= MAX_PROPOSAL_ROUNDS) revert ProposalRoundsExhausted();

        unchecked {
            proposalRound += 1; // bounded by MAX_PROPOSAL_ROUNDS above
        }
        proposedOutcome = outcome;
        evidenceHash = evidenceHash_;
        proposedAt = uint64(block.timestamp);
        state = MarketTypes.State.RESOLUTION_PROPOSED;

        emit ResolutionProposed(
            marketId,
            msg.sender,
            outcome,
            evidenceHash_,
            proposalRound,
            uint64(block.timestamp),
            challengeEndsAt()
        );
    }

    // -------------------------------------------------------------------------
    // RESOLUTION_PROPOSED -> CHALLENGED
    // -------------------------------------------------------------------------

    /// @notice Contest the standing proposal.
    /// @param reasonHash keccak256 of the off-chain challenge document.
    ///
    /// @dev Only the first proposal is contestable. The replacement is final,
    ///      which is what makes the process terminate (ADR-0004). Eligibility is
    ///      having a stake in this market: someone with nothing at risk has
    ///      nothing to contest.
    function challenge(bytes32 reasonHash) external nonReentrant {
        _requireState(MarketTypes.State.RESOLUTION_PROPOSED);
        if (block.timestamp >= challengeEndsAt()) revert ChallengeWindowClosed();
        if (proposalRound != 1) revert ChallengeRoundExhausted();
        if (reasonHash == bytes32(0)) revert MissingReason();
        if (yesStake[msg.sender] == 0 && noStake[msg.sender] == 0) revert NotAParticipant();

        challenger = msg.sender;
        challengeReasonHash = reasonHash;
        challengedOutcome = proposedOutcome;
        challengedAt = uint64(block.timestamp);
        state = MarketTypes.State.CHALLENGED;

        uint256 bond = challengeBond;
        if (bond > 0) {
            bondOutstanding = true;
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), bond);
            if (token.balanceOf(address(this)) - balanceBefore != bond) revert UnsupportedToken();
        }

        emit ResolutionChallenged(
            marketId,
            msg.sender,
            challengedOutcome,
            reasonHash,
            bond,
            uint64(block.timestamp),
            reviewDeadline()
        );
    }

    // -------------------------------------------------------------------------
    // RESOLUTION_PROPOSED -> FINALIZED / CANCELLED
    // -------------------------------------------------------------------------

    /// @notice Make the standing proposal final once its challenge window has run.
    /// @dev Permissionless, and unavailable to anyone — resolver included —
    ///      before the window closes.
    ///
    ///      An `INVALID` proposal is finalized through this same window rather
    ///      than cancelling on sight. See ADR-0009: an immediate cancellation
    ///      would hand the resolver an unchallengeable unilateral unwind of any
    ///      market.
    function finalize() external nonReentrant {
        _requireState(MarketTypes.State.RESOLUTION_PROPOSED);
        if (block.timestamp < challengeEndsAt()) revert ChallengePeriodActive();

        MarketTypes.Outcome outcome = proposedOutcome;
        finalOutcome = outcome;
        finalizedAt = uint64(block.timestamp);

        if (outcome == MarketTypes.Outcome.INVALID) {
            _cancel(MarketTypes.CancellationReason.RESOLVED_INVALID);
            return;
        }

        uint256 winningTotal = outcome == MarketTypes.Outcome.YES ? totalYes : totalNo;
        if (winningTotal == 0) {
            // Nobody backed the winning side. There is no proportional share to
            // compute, so everyone takes their own stake back.
            refundMode = true;
            remainingClaimableStake = totalYes + totalNo;
        } else {
            remainingClaimableStake = winningTotal;
        }

        if (bondOutstanding) {
            // No arbiter needed: a challenge that changed the outcome was
            // informative and costs nothing. A bond is also returned rather than
            // forfeited in refund mode, where there is no pool for it to join
            // and it would otherwise be stranded here forever.
            bondRefundable = (outcome != challengedOutcome) || refundMode;
            if (!bondRefundable) {
                forfeitedBond = challengeBond;
                bondOutstanding = false;
            }
        }

        state = MarketTypes.State.FINALIZED;
        emit MarketFinalized(marketId, outcome, evidenceHash, pool(), refundMode, finalizedAt);
        _settleIfExhausted();
    }

    // -------------------------------------------------------------------------
    // -> CANCELLED
    // -------------------------------------------------------------------------

    /// @notice Unwind a market whose resolution never arrived.
    ///
    /// Permissionless by necessity. If only an administrator could do this, an
    /// administrator could hold every participant's funds hostage by declining
    /// to — exactly the privilege the security model forbids.
    ///
    /// Two timeouts reach here; the third cancellation trigger, a finalized
    /// `INVALID`, runs through `finalize()`.
    function cancel() external nonReentrant {
        _closeIfDue();

        MarketTypes.State current = state;
        if (current == MarketTypes.State.OPEN || current == MarketTypes.State.CLOSED) {
            if (block.timestamp < resolutionDeadline()) revert ResolutionWindowActive();
            _cancel(MarketTypes.CancellationReason.NO_RESOLUTION);
        } else if (current == MarketTypes.State.CHALLENGED) {
            if (block.timestamp < reviewDeadline()) revert ReviewWindowActive();
            _cancel(MarketTypes.CancellationReason.NO_REVIEW);
        } else {
            // RESOLUTION_PROPOSED has a standing proposal and a permissionless
            // `finalize()`; FINALIZED, SETTLED and CANCELLED are already resolved.
            revert InvalidState(current);
        }
    }

    function _cancel(MarketTypes.CancellationReason reason) internal {
        state = MarketTypes.State.CANCELLED;
        cancellationReason = reason;
        refundMode = true;
        remainingClaimableStake = totalYes + totalNo;
        if (bondOutstanding) bondRefundable = true;

        emit MarketCancelled(marketId, reason, remainingClaimableStake, uint64(block.timestamp));
    }

    // -------------------------------------------------------------------------
    // Withdrawals
    // -------------------------------------------------------------------------

    /// @notice Take a winner's proportional share of the pool.
    ///
    /// payout = stake * pool / totalWinningStake, floored.
    ///
    /// @dev Flooring guarantees the payouts sum to at most the pool. The
    ///      remainder — under one base unit per winner — stays in the contract
    ///      permanently. That is a deliberate choice over adding a sweep
    ///      function, because any sweep is an extraction surface, and this
    ///      protocol admits no privileged path to user funds. See
    ///      docs/security.md.
    function claim() external nonReentrant returns (uint256 payout) {
        // Refund mode is tested before the state, so that a caller who reaches
        // here on a cancelled or no-winner market is told which function to use
        // rather than just that the state is wrong. Both paths still revert.
        if (refundMode) revert RefundModeActive();
        if (state != MarketTypes.State.FINALIZED && state != MarketTypes.State.SETTLED) {
            revert InvalidState(state);
        }
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        MarketTypes.Outcome outcome = finalOutcome;
        uint256 stakeAmount =
            outcome == MarketTypes.Outcome.YES ? yesStake[msg.sender] : noStake[msg.sender];
        if (stakeAmount == 0) revert NothingToClaim();

        uint256 winningTotal = outcome == MarketTypes.Outcome.YES ? totalYes : totalNo;
        payout = Math.mulDiv(stakeAmount, pool(), winningTotal);

        hasClaimed[msg.sender] = true;
        remainingClaimableStake -= stakeAmount;
        _settleIfExhausted();

        token.safeTransfer(msg.sender, payout);
        emit WinningsClaimed(marketId, msg.sender, outcome, stakeAmount, payout);
    }

    /// @notice Take back your own stake when nobody won.
    /// @dev Reachable after a cancellation, or after a finalized outcome whose
    ///      winning side attracted no stake. Each participant recovers exactly
    ///      what they put in — never anyone else's.
    function withdrawRefund() external nonReentrant returns (uint256 amount) {
        if (!refundMode) revert NotInRefundMode();
        if (
            state != MarketTypes.State.CANCELLED && state != MarketTypes.State.FINALIZED
                && state != MarketTypes.State.SETTLED
        ) revert InvalidState(state);
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        amount = yesStake[msg.sender] + noStake[msg.sender];
        if (amount == 0) revert NothingToClaim();

        hasClaimed[msg.sender] = true;
        remainingClaimableStake -= amount;
        _settleIfExhausted();

        token.safeTransfer(msg.sender, amount);
        emit RefundWithdrawn(marketId, msg.sender, amount);
    }

    /// @notice Recover a challenge bond that was not forfeited.
    /// @dev Separate from stake accounting on purpose: the bond follows its own
    ///      rule, and entangling the two would make both harder to verify.
    function claimChallengeBond() external nonReentrant returns (uint256 amount) {
        if (msg.sender != challenger) revert NotChallenger();
        if (
            state != MarketTypes.State.CANCELLED && state != MarketTypes.State.FINALIZED
                && state != MarketTypes.State.SETTLED
        ) revert InvalidState(state);
        if (!bondOutstanding) revert AlreadyClaimed();
        if (!bondRefundable) revert BondForfeited();

        bondOutstanding = false;
        amount = challengeBond;
        _settleIfExhausted();

        token.safeTransfer(msg.sender, amount);
        emit ChallengeBondReturned(marketId, msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev `CANCELLED` never advances to `SETTLED`; it is terminal so the reason
    ///      a market was unwound is never erased.
    function _settleIfExhausted() internal {
        if (
            state == MarketTypes.State.FINALIZED && remainingClaimableStake == 0 && !bondOutstanding
        ) {
            state = MarketTypes.State.SETTLED;
            emit MarketSettled(marketId, uint64(block.timestamp));
        }
    }

    function _requireState(MarketTypes.State expected) internal view {
        if (state != expected) revert InvalidState(state);
    }
}
