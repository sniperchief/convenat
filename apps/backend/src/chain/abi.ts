/**
 * Contract ABIs, as `as const` fragments.
 *
 * Declared here rather than imported from `packages/contracts/artifacts` for two
 * reasons: artifacts are build output and are not committed, and viem's type
 * inference needs literal types that a JSON import cannot carry.
 *
 * The obvious risk is drift — a fragment here quietly disagreeing with the
 * bytecode actually deployed, which would decode a log into confident nonsense.
 * That risk is closed by `test/abi-parity.test.ts`, which compiles the contracts
 * and asserts every fragment below is present, byte for byte, in the compiler's
 * own output. If a signature changes upstream, that test fails; it is not
 * possible for this file to be silently stale.
 *
 * Only what the backend uses is declared. The backend reads state and reads
 * logs; it never stakes, never claims, and never creates a market, so no
 * fund-moving function appears here at all. `proposeResolution` is the single
 * writable entry point the resolver key will ever reach (Milestone 5), and it
 * moves no money.
 */

export const marketFactoryAbi = [
  {
    type: 'event',
    name: 'MarketCreated',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'market', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'rulesHash', type: 'bytes32', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'tradingEndsAt', type: 'uint64', indexed: false },
      { name: 'conditionDeadline', type: 'uint64', indexed: false },
      { name: 'challengeWindow', type: 'uint32', indexed: false },
      { name: 'resolutionWindow', type: 'uint32', indexed: false },
      { name: 'challengeBond', type: 'uint256', indexed: false },
      { name: 'createdAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'marketById',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'marketByRulesHash',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'marketCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isProposer',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const conditionalMarketAbi = [
  // --- events ---------------------------------------------------------------
  {
    type: 'event',
    name: 'StakePlaced',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'staker', type: 'address', indexed: true },
      { name: 'side', type: 'uint8', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'totalYes', type: 'uint256', indexed: false },
      { name: 'totalNo', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'MarketClosed',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'closedAt', type: 'uint64', indexed: false },
      { name: 'totalYes', type: 'uint256', indexed: false },
      { name: 'totalNo', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ResolutionProposed',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'proposer', type: 'address', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: true },
      { name: 'evidenceHash', type: 'bytes32', indexed: false },
      { name: 'round', type: 'uint8', indexed: false },
      { name: 'proposedAt', type: 'uint64', indexed: false },
      { name: 'challengeEndsAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ResolutionChallenged',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'challenger', type: 'address', indexed: true },
      { name: 'challengedOutcome', type: 'uint8', indexed: true },
      { name: 'reasonHash', type: 'bytes32', indexed: false },
      { name: 'bond', type: 'uint256', indexed: false },
      { name: 'challengedAt', type: 'uint64', indexed: false },
      { name: 'reviewDeadline', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'MarketFinalized',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: true },
      { name: 'evidenceHash', type: 'bytes32', indexed: false },
      { name: 'pool', type: 'uint256', indexed: false },
      { name: 'refundMode', type: 'bool', indexed: false },
      { name: 'finalizedAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'MarketCancelled',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'reason', type: 'uint8', indexed: true },
      { name: 'refundablePool', type: 'uint256', indexed: false },
      { name: 'cancelledAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'WinningsClaimed',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'claimant', type: 'address', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RefundWithdrawn',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'claimant', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ChallengeBondReturned',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'challenger', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'MarketSettled',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'settledAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },

  // --- reads ----------------------------------------------------------------
  ...(
    [
      ['marketId', 'uint256'],
      ['rulesHash', 'bytes32'],
      ['creator', 'address'],
      ['token', 'address'],
      ['factory', 'address'],
      ['tradingEndsAt', 'uint64'],
      ['conditionDeadline', 'uint64'],
      ['challengeWindow', 'uint32'],
      ['resolutionWindow', 'uint32'],
      ['challengeBond', 'uint256'],
      ['state', 'uint8'],
      ['proposedOutcome', 'uint8'],
      ['finalOutcome', 'uint8'],
      ['cancellationReason', 'uint8'],
      ['proposalRound', 'uint8'],
      ['refundMode', 'bool'],
      ['proposedAt', 'uint64'],
      ['challengedAt', 'uint64'],
      ['finalizedAt', 'uint64'],
      ['evidenceHash', 'bytes32'],
      ['challenger', 'address'],
      ['challengeReasonHash', 'bytes32'],
      ['challengedOutcome', 'uint8'],
      ['bondOutstanding', 'bool'],
      ['bondRefundable', 'bool'],
      ['totalYes', 'uint256'],
      ['totalNo', 'uint256'],
      ['forfeitedBond', 'uint256'],
      ['remainingClaimableStake', 'uint256'],
      ['challengeEndsAt', 'uint64'],
      ['resolutionDeadline', 'uint64'],
      ['reviewDeadline', 'uint64'],
      ['pool', 'uint256'],
    ] as const
  ).map(
    ([name, type]) =>
      ({
        type: 'function',
        name,
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type }],
      }) as const,
  ),
  {
    type: 'function',
    name: 'yesStake',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'noStake',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hasClaimed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'stakeOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'yes', type: 'uint256' },
      { name: 'no', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'previewClaim',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },

  // --- the one write the backend may ever perform ---------------------------
  // Resolver authority, exercised in Milestone 5. It records an outcome and an
  // evidence commitment; it transfers nothing and names no recipient.
  {
    type: 'function',
    name: 'proposeResolution',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'outcome', type: 'uint8' },
      { name: 'evidenceHash_', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** The ERC-20 surface the backend reads. No `transfer`, no `approve`. */
export const erc20ReadAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
