// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TenderContract
 * @dev Decentralized e-Tendering Smart Contract deployed on the Polygon Network.
 * Handles sealed bidding (commit-reveal scheme), automated award evaluation,
 * milestone verification by auditors, and transparent payment releases.
 * The deployer is the admin and registers auditors; only auditors may verify milestones.
 */
contract TenderContract {

    enum TenderStatus { OPEN, EVALUATING, AWARDED, COMPLETED, CANCELLED }
    enum BidStatus { SUBMITTED, REVEALED, WINNER, OUTBID }
    enum MilestoneStatus { PENDING, VERIFIED, PAID }

    struct SealedBid {
        bytes32 bidHash;        // keccak256(abi.encodePacked(bidAmount, salt))
        uint256 submittedAt;
        uint256 revealedAmount;
        BidStatus status;
        bool exists;
    }

    struct Milestone {
        string milestoneId;
        string description;
        uint256 amountINR;
        MilestoneStatus status;
        address verifiedBy;
        uint256 verifiedAt;
        uint256 paidAt;
        bool exists;
    }

    struct Tender {
        string tenderId;
        string title;
        uint256 budgetINR;
        uint256 deadline;       // Unix timestamp in seconds
        address issuer;
        TenderStatus status;
        address awardedTo;
        uint256 winningAmount;
        string[] milestoneIds;
        bool exists;
    }

    // Custom errors
    error NotAdmin();
    error NotAuditor();
    error ZeroAddress();
    error TenderNotFound();
    error TenderAlreadyExists();
    error NotTenderIssuer();
    error InvalidBudget();
    error DeadlineNotInFuture();
    error TenderNotOpen();
    error BiddingClosed();
    error InvalidBidHash();
    error RevealNotOpen();
    error NoSealedBid();
    error BidNotSubmitted();
    error HashMismatch();
    error CannotAward();
    error BidNotRevealed();
    error AmountMismatch();
    error ExceedsBudget();
    error NotAwarded();
    error MilestoneAlreadyExists();
    error MilestoneNotFound();
    error MilestoneNotPending();
    error MilestoneNotVerified();

    // Roles
    /// @notice Deployer of the contract; may register auditors
    address public immutable admin;
    /// @notice Whether an address holds the AUDITOR role
    mapping(address => bool) public isAuditor;

    // Storage Mappings
    mapping(string => Tender) public tenders;
    mapping(string => mapping(address => SealedBid)) public bids; // tenderId => contractor => SealedBid
    mapping(string => mapping(string => Milestone)) public milestones; // tenderId => milestoneId => Milestone
    mapping(string => address[]) private tenderContractors;

    // Events emitted on the Polygon blockchain
    event TenderCreated(string indexed tenderId, string title, uint256 budgetINR, uint256 deadline, address indexed issuer);
    event BidSealed(string indexed tenderId, address indexed contractor, bytes32 bidHash, uint256 timestamp);
    event BidRevealed(string indexed tenderId, address indexed contractor, uint256 bidAmountINR, uint256 timestamp);
    event ContractAwarded(string indexed tenderId, address indexed contractor, uint256 winningAmountINR, uint256 timestamp);
    event MilestoneCreated(string indexed tenderId, string milestoneId, string description, uint256 amountINR);
    event MilestoneVerified(string indexed tenderId, string milestoneId, address indexed auditor, uint256 timestamp);
    event AuditorAdded(address indexed auditor, address indexed addedBy);
    event PaymentReleased(string indexed tenderId, string milestoneId, uint256 amountINR, address indexed recipient, uint256 timestamp);

    // Modifiers
    modifier onlyIssuer(string calldata tenderId) {
        if (!tenders[tenderId].exists) revert TenderNotFound();
        if (msg.sender != tenders[tenderId].issuer) revert NotTenderIssuer();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAuditor() {
        if (!isAuditor[msg.sender]) revert NotAuditor();
        _;
    }

    /// @notice The deployer becomes the admin
    constructor() {
        admin = msg.sender;
    }

    // ==========================================
    // 0. ROLE MANAGEMENT
    // ==========================================

    /**
     * @notice Grants the AUDITOR role to an address (admin only)
     * @param auditor Address to be registered as an auditor
     */
    function addAuditor(address auditor) external onlyAdmin {
        if (auditor == address(0)) revert ZeroAddress();
        isAuditor[auditor] = true;
        emit AuditorAdded(auditor, msg.sender);
    }

    // ==========================================
    // 1. TENDER MANAGEMENT
    // ==========================================

    /**
     * @notice Creates a new government tender on the Polygon blockchain
     * @param tenderId Unique tender identifier
     * @param title Project title
     * @param budgetINR Project budget in Indian Rupees (INR)
     * @param deadline Unix timestamp for bid submissions close
     */
    function createTender(
        string calldata tenderId,
        string calldata title,
        uint256 budgetINR,
        uint256 deadline
    ) external {
        if (tenders[tenderId].exists) revert TenderAlreadyExists();
        if (budgetINR == 0) revert InvalidBudget();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture();

        Tender storage t = tenders[tenderId];
        t.tenderId = tenderId;
        t.title = title;
        t.budgetINR = budgetINR;
        t.deadline = deadline;
        t.issuer = msg.sender;
        t.status = TenderStatus.OPEN;
        t.exists = true;

        emit TenderCreated(tenderId, title, budgetINR, deadline, msg.sender);
    }

    // ==========================================
    // 2. SEALED BID SUBMISSION & COMMITMENT
    // ==========================================

    /**
     * @notice Submits a sealed cryptographic bid commitment (keccak256 hash)
     * @param tenderId Unique tender identifier
     * @param bidHash keccak256(abi.encodePacked(bidAmountINR, salt))
     */
    function submitSealedBid(
        string calldata tenderId,
        bytes32 bidHash
    ) external {
        Tender storage t = tenders[tenderId];
        if (!t.exists) revert TenderNotFound();
        if (t.status != TenderStatus.OPEN) revert TenderNotOpen();
        if (block.timestamp > t.deadline) revert BiddingClosed();
        if (bidHash == bytes32(0)) revert InvalidBidHash();

        if (!bids[tenderId][msg.sender].exists) {
            tenderContractors[tenderId].push(msg.sender);
        }

        bids[tenderId][msg.sender] = SealedBid({
            bidHash: bidHash,
            submittedAt: block.timestamp,
            revealedAmount: 0,
            status: BidStatus.SUBMITTED,
            exists: true
        });

        emit BidSealed(tenderId, msg.sender, bidHash, block.timestamp);
    }

    // ==========================================
    // 3. BID REVEAL SCHEME
    // ==========================================

    /**
     * @notice Reveals a previously sealed bid using the original amount and secret salt.
     * Reverts unless the bidding deadline has passed (block.timestamp > deadline).
     * @param tenderId Unique tender identifier
     * @param bidAmountINR Revealed bid amount in INR
     * @param salt Secret salt phrase used to generate original seal
     */
    function revealBid(
        string calldata tenderId,
        uint256 bidAmountINR,
        string calldata salt
    ) external {
        Tender storage t = tenders[tenderId];
        if (!t.exists) revert TenderNotFound();
        if (block.timestamp <= t.deadline) revert RevealNotOpen();

        SealedBid storage bid = bids[tenderId][msg.sender];
        if (!bid.exists) revert NoSealedBid();
        if (bid.status != BidStatus.SUBMITTED) revert BidNotSubmitted();

        // Verify cryptographic hash integrity on Polygon
        bytes32 computedHash = keccak256(abi.encodePacked(bidAmountINR, salt));
        if (computedHash != bid.bidHash) revert HashMismatch();

        bid.revealedAmount = bidAmountINR;
        bid.status = BidStatus.REVEALED;

        emit BidRevealed(tenderId, msg.sender, bidAmountINR, block.timestamp);
    }

    // ==========================================
    // 4. CONTRACT AWARDING
    // ==========================================

    /**
     * @notice Awards the contract to the winning contractor.
     * The contractor's bid must be REVEALED and winningAmountINR must equal its revealed amount.
     * @param tenderId Unique tender identifier
     * @param contractor Winning contractor wallet address
     * @param winningAmountINR Winning contract price
     */
    function awardContract(
        string calldata tenderId,
        address contractor,
        uint256 winningAmountINR
    ) external onlyIssuer(tenderId) {
        Tender storage t = tenders[tenderId];
        if (t.status != TenderStatus.OPEN && t.status != TenderStatus.EVALUATING) revert CannotAward();
        SealedBid storage winningBid = bids[tenderId][contractor];
        if (!winningBid.exists) revert NoSealedBid();
        if (winningBid.status != BidStatus.REVEALED) revert BidNotRevealed();
        if (winningAmountINR != winningBid.revealedAmount) revert AmountMismatch();
        if (winningAmountINR > t.budgetINR) revert ExceedsBudget();

        t.status = TenderStatus.AWARDED;
        t.awardedTo = contractor;
        t.winningAmount = winningAmountINR;

        winningBid.status = BidStatus.WINNER;

        // Mark all other bids as OUTBID
        address[] memory allContractors = tenderContractors[tenderId];
        for (uint256 i = 0; i < allContractors.length; i++) {
            if (allContractors[i] != contractor && bids[tenderId][allContractors[i]].exists) {
                bids[tenderId][allContractors[i]].status = BidStatus.OUTBID;
            }
        }

        emit ContractAwarded(tenderId, contractor, winningAmountINR, block.timestamp);
    }

    // ==========================================
    // 5. MILESTONE MANAGEMENT & PAYMENTS
    // ==========================================

    /**
     * @notice Creates an execution milestone phase for an awarded tender
     * @param tenderId Unique tender identifier
     * @param milestoneId Unique milestone identifier (e.g. T-101-M1)
     * @param description Scope of work for milestone
     * @param amountINR INR payment released upon verification
     */
    function createMilestone(
        string calldata tenderId,
        string calldata milestoneId,
        string calldata description,
        uint256 amountINR
    ) external onlyIssuer(tenderId) {
        Tender storage t = tenders[tenderId];
        if (t.status != TenderStatus.AWARDED) revert NotAwarded();
        if (milestones[tenderId][milestoneId].exists) revert MilestoneAlreadyExists();

        milestones[tenderId][milestoneId] = Milestone({
            milestoneId: milestoneId,
            description: description,
            amountINR: amountINR,
            status: MilestoneStatus.PENDING,
            verifiedBy: address(0),
            verifiedAt: 0,
            paidAt: 0,
            exists: true
        });

        t.milestoneIds.push(milestoneId);
        emit MilestoneCreated(tenderId, milestoneId, description, amountINR);
    }

    /**
     * @notice Auditor verifies that milestone deliverables meet requirements (auditors only)
     * @param tenderId Unique tender identifier
     * @param milestoneId Milestone identifier
     */
    function verifyMilestone(
        string calldata tenderId,
        string calldata milestoneId
    ) external onlyAuditor {
        Milestone storage m = milestones[tenderId][milestoneId];
        if (!m.exists) revert MilestoneNotFound();
        if (m.status != MilestoneStatus.PENDING) revert MilestoneNotPending();

        m.status = MilestoneStatus.VERIFIED;
        m.verifiedBy = msg.sender;
        m.verifiedAt = block.timestamp;

        emit MilestoneVerified(tenderId, milestoneId, msg.sender, block.timestamp);
    }

    /**
     * @notice Issuer releases verified funds to the contractor
     * @param tenderId Unique tender identifier
     * @param milestoneId Milestone identifier
     */
    function releaseMilestonePayment(
        string calldata tenderId,
        string calldata milestoneId
    ) external onlyIssuer(tenderId) {
        Tender storage t = tenders[tenderId];
        Milestone storage m = milestones[tenderId][milestoneId];
        if (!m.exists) revert MilestoneNotFound();
        if (m.status != MilestoneStatus.VERIFIED) revert MilestoneNotVerified();

        m.status = MilestoneStatus.PAID;
        m.paidAt = block.timestamp;

        emit PaymentReleased(tenderId, milestoneId, m.amountINR, t.awardedTo, block.timestamp);
    }

    // ==========================================
    // 6. VIEW GETTERS
    // ==========================================

    function getTenderMilestones(string calldata tenderId) external view returns (string[] memory) {
        return tenders[tenderId].milestoneIds;
    }

    function getTenderContractors(string calldata tenderId) external view returns (address[] memory) {
        return tenderContractors[tenderId];
    }
}
