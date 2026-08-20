// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {ConditionalMarket} from "./ConditionalMarket.sol";

/// @title Creates markets and holds the protocol's only two privileges.
/// @notice The factory is the role registry and the pause switch. It is not a
///         treasury, a custodian, or an escape hatch.
///
/// **There is no function on this contract that can move a market's funds.**
/// That is not an omission to be corrected later; it is the property the
/// security model rests on. An administrator here can stop new risk from being
/// created and can rotate the resolver. That is the whole of it.
///
/// Markets are EIP-1167 clones of one implementation, so each condition
/// custodies its own balance. A defect in one market's accounting cannot reach
/// another market's money.
contract MarketFactory is AccessControl, Pausable {
    /// @notice May propose resolutions on every market this factory created.
    /// @dev Held by the backend resolver wallet. Confers no ability to move,
    ///      hold or redirect funds. Rotating it is one transaction here rather
    ///      than one per market, which is why markets read their roles from the
    ///      factory instead of storing their own.
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

    /// @notice The `ConditionalMarket` logic every clone delegates to.
    address public immutable implementation;

    /// @notice Number of markets created. Also the id of the most recent one.
    uint256 public marketCount;

    /// @notice marketId => clone address. Ids start at 1; 0 means "no market".
    mapping(uint256 => address) public marketById;

    /// @notice rulesHash => clone address.
    /// @dev The off-chain specification store is keyed by `rulesHash` and the
    ///      indexer joins on it (ADR-0006). Enforcing uniqueness here makes that
    ///      join total instead of ambiguous. The specification schema carries a
    ///      per-approval nonce, so two honest markets never collide.
    mapping(bytes32 => address) public marketByRulesHash;

    event MarketCreated(
        uint256 indexed marketId,
        address indexed market,
        address indexed creator,
        bytes32 rulesHash,
        address token,
        uint64 tradingEndsAt,
        uint64 conditionDeadline,
        uint32 challengeWindow,
        uint32 resolutionWindow,
        uint256 challengeBond,
        uint64 createdAt
    );

    error RulesHashAlreadyUsed(bytes32 rulesHash, address existingMarket);
    error UnknownMarket(uint256 marketId);
    error ZeroAddress();

    /// @param admin Holds `DEFAULT_ADMIN_ROLE`: may grant and revoke roles and
    ///        may pause. May not touch funds.
    /// @param resolver Initial holder of `PROPOSER_ROLE`.
    /// @param implementation_ Deployed `ConditionalMarket` logic contract, whose
    ///        own constructor has already disabled its initializers.
    constructor(address admin, address resolver, address implementation_) {
        if (admin == address(0) || implementation_ == address(0)) revert ZeroAddress();
        implementation = implementation_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (resolver != address(0)) _grantRole(PROPOSER_ROLE, resolver);
    }

    /// @notice Parameters of a market, as approved off-chain.
    /// @dev Every field is committed to by `rulesHash`: the specification's
    ///      `settlement` block carries the token, the trading end, the challenge
    ///      window, the bond and the resolution window. Anyone can therefore
    ///      check that the market they are looking at matches the rules that
    ///      were approved, which is the point of committing the hash at all.
    struct CreateMarketParams {
        address token;
        bytes32 rulesHash;
        uint64 tradingEndsAt;
        uint64 conditionDeadline;
        uint32 challengeWindow;
        uint32 resolutionWindow;
        uint256 challengeBond;
    }

    /// @notice Deploy and initialize a market.
    /// @dev Called by the creator's own wallet, not by the backend (ADR-0006):
    ///      the person who approved the rules is the person who commits them,
    ///      and opening a market therefore depends on no backend liveness and no
    ///      backend gas budget.
    ///
    ///      Parameter validation lives in `ConditionalMarket.initialize`, not
    ///      here, so it cannot be bypassed by initializing a clone another way.
    function createMarket(CreateMarketParams calldata params)
        external
        whenNotPaused
        returns (uint256 marketId, address market)
    {
        address existing = marketByRulesHash[params.rulesHash];
        if (existing != address(0)) revert RulesHashAlreadyUsed(params.rulesHash, existing);

        marketId = ++marketCount;
        market = Clones.clone(implementation);

        marketById[marketId] = market;
        marketByRulesHash[params.rulesHash] = market;

        ConditionalMarket(market).initialize(
            ConditionalMarket.InitParams({
                marketId: marketId,
                creator: msg.sender,
                token: params.token,
                rulesHash: params.rulesHash,
                tradingEndsAt: params.tradingEndsAt,
                conditionDeadline: params.conditionDeadline,
                challengeWindow: params.challengeWindow,
                resolutionWindow: params.resolutionWindow,
                challengeBond: params.challengeBond
            })
        );

        emit MarketCreated(
            marketId,
            market,
            msg.sender,
            params.rulesHash,
            params.token,
            params.tradingEndsAt,
            params.conditionDeadline,
            params.challengeWindow,
            params.resolutionWindow,
            params.challengeBond,
            uint64(block.timestamp)
        );
    }

    /// @notice Whether `account` may propose resolutions. Read by every market.
    function isProposer(address account) external view returns (bool) {
        return hasRole(PROPOSER_ROLE, account);
    }

    /// @notice Halt creation of new markets and new stakes in existing ones.
    ///
    /// @dev The full extent of the pause, per ADR-0007. It reaches
    ///      `createMarket` here and `ConditionalMarket.stake` there, and nothing
    ///      else. `claim`, `withdrawRefund`, `claimChallengeBond`, `close`,
    ///      `finalize` and `cancel` are all deliberately outside its reach: a
    ///      pause that could stop a withdrawal would be a fund freeze wearing a
    ///      safety label, and this protocol grants nobody that power.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Resolve a market id to its address.
    function requireMarket(uint256 marketId) external view returns (address market) {
        market = marketById[marketId];
        if (market == address(0)) revert UnknownMarket(marketId);
    }

    /// @notice Page through created markets, oldest first.
    /// @param start One-based market id to begin at.
    /// @param limit Maximum number of addresses to return.
    function listMarkets(uint256 start, uint256 limit)
        external
        view
        returns (address[] memory markets)
    {
        if (start == 0) start = 1;
        uint256 last = marketCount;
        if (start > last || limit == 0) return new address[](0);

        uint256 available = last - start + 1;
        uint256 size = available < limit ? available : limit;
        markets = new address[](size);
        for (uint256 i = 0; i < size; ++i) {
            markets[i] = marketById[start + i];
        }
    }
}
