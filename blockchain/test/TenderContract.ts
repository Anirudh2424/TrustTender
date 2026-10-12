import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const TENDER_ID = "T-NHAI-2026";
const BUDGET = 450_000_000n;
const SALT = "s3cret-salt";

// withArgs predicate: accept any uint256 (used for block timestamps)
const anyUint = (v: unknown) => typeof v === "bigint";

const sealBid = (amount: bigint, salt: string) =>
  ethers.solidityPackedKeccak256(["uint256", "string"], [amount, salt]);

describe("TenderContract", () => {
  async function deployFixture() {
    const [admin, issuer, auditor, c1, c2, outsider] = await ethers.getSigners();
    const tender = await (await ethers.getContractFactory("TenderContract")).connect(admin).deploy();
    await tender.addAuditor(auditor.address);

    const deadline = (await time.latest()) + 24 * 3600;
    await tender.connect(issuer).createTender(TENDER_ID, "Smart Toll", BUDGET, deadline);
    return { tender, admin, issuer, auditor, c1, c2, outsider, deadline };
  }

  /** Both contractors seal bids, deadline passes, both reveal. c1 bids 400M, c2 bids 420M. */
  async function revealedFixture() {
    const ctx = await deployFixture();
    const { tender, c1, c2, deadline } = ctx;
    await tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(400_000_000n, SALT));
    await tender.connect(c2).submitSealedBid(TENDER_ID, sealBid(420_000_000n, SALT));
    await time.increaseTo(deadline + 1);
    await tender.connect(c1).revealBid(TENDER_ID, 400_000_000n, SALT);
    await tender.connect(c2).revealBid(TENDER_ID, 420_000_000n, SALT);
    return ctx;
  }

  async function awardedFixture() {
    const ctx = await revealedFixture();
    await ctx.tender.connect(ctx.issuer).awardContract(TENDER_ID, ctx.c1.address, 400_000_000n);
    await ctx.tender.connect(ctx.issuer).createMilestone(TENDER_ID, "M1", "Phase 1", 100_000_000n);
    return ctx;
  }

  describe("roles", () => {
    it("makes the deployer admin and lets only the admin add auditors", async () => {
      const { tender, admin, outsider, c1 } = await loadFixture(deployFixture);
      expect(await tender.admin()).to.equal(admin.address);
      await expect(tender.connect(outsider).addAuditor(c1.address)).to.be.revertedWithCustomError(tender, "NotAdmin");
      await expect(tender.addAuditor(ethers.ZeroAddress)).to.be.revertedWithCustomError(tender, "ZeroAddress");
      await expect(tender.addAuditor(c1.address)).to.emit(tender, "AuditorAdded").withArgs(c1.address, admin.address);
      expect(await tender.isAuditor(c1.address)).to.equal(true);
    });
  });

  describe("full happy path", () => {
    it("creates, seals, reveals, awards, verifies and pays", async () => {
      const { tender, issuer, auditor, c1, c2, deadline } = await loadFixture(deployFixture);

      await expect(tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(400_000_000n, SALT)))
        .to.emit(tender, "BidSealed");
      await tender.connect(c2).submitSealedBid(TENDER_ID, sealBid(420_000_000n, SALT));
      expect(await tender.getTenderContractors(TENDER_ID)).to.deep.equal([c1.address, c2.address]);

      await time.increaseTo(deadline + 1);
      await expect(tender.connect(c1).revealBid(TENDER_ID, 400_000_000n, SALT))
        .to.emit(tender, "BidRevealed").withArgs(TENDER_ID, c1.address, 400_000_000n, anyUint);
      await tender.connect(c2).revealBid(TENDER_ID, 420_000_000n, SALT);

      await expect(tender.connect(issuer).awardContract(TENDER_ID, c1.address, 400_000_000n))
        .to.emit(tender, "ContractAwarded");
      expect((await tender.bids(TENDER_ID, c1.address)).status).to.equal(2n); // WINNER
      expect((await tender.bids(TENDER_ID, c2.address)).status).to.equal(3n); // OUTBID
      expect((await tender.tenders(TENDER_ID)).awardedTo).to.equal(c1.address);

      await expect(tender.connect(issuer).createMilestone(TENDER_ID, "M1", "Phase 1", 100_000_000n))
        .to.emit(tender, "MilestoneCreated");
      await expect(tender.connect(auditor).verifyMilestone(TENDER_ID, "M1"))
        .to.emit(tender, "MilestoneVerified");
      await expect(tender.connect(issuer).releaseMilestonePayment(TENDER_ID, "M1"))
        .to.emit(tender, "PaymentReleased").withArgs(TENDER_ID, "M1", 100_000_000n, c1.address, anyUint);

      expect((await tender.milestones(TENDER_ID, "M1")).status).to.equal(2n); // PAID
      expect(await tender.getTenderMilestones(TENDER_ID)).to.deep.equal(["M1"]);
    });
  });

  describe("bidding window", () => {
    it("rejects a bid submitted after the deadline", async () => {
      const { tender, c1, deadline } = await loadFixture(deployFixture);
      await time.increaseTo(deadline + 1);
      await expect(tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(1n, SALT)))
        .to.be.revertedWithCustomError(tender, "BiddingClosed");
    });

    it("rejects reveal at or before the deadline", async () => {
      const { tender, c1, deadline } = await loadFixture(deployFixture);
      await tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(400_000_000n, SALT));
      await expect(tender.connect(c1).revealBid(TENDER_ID, 400_000_000n, SALT))
        .to.be.revertedWithCustomError(tender, "RevealNotOpen");
      // exactly at the deadline is still too early (needs block.timestamp > deadline)
      await time.setNextBlockTimestamp(deadline);
      await expect(tender.connect(c1).revealBid(TENDER_ID, 400_000_000n, SALT))
        .to.be.revertedWithCustomError(tender, "RevealNotOpen");
    });

    it("rejects reveal with the wrong salt or amount", async () => {
      const { tender, c1, deadline } = await loadFixture(deployFixture);
      await tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(400_000_000n, SALT));
      await time.increaseTo(deadline + 1);
      await expect(tender.connect(c1).revealBid(TENDER_ID, 400_000_000n, "wrong-salt"))
        .to.be.revertedWithCustomError(tender, "HashMismatch");
      await expect(tender.connect(c1).revealBid(TENDER_ID, 399_999_999n, SALT))
        .to.be.revertedWithCustomError(tender, "HashMismatch");
    });
  });

  describe("awarding", () => {
    it("rejects award by a non-issuer", async () => {
      const { tender, outsider, c1 } = await loadFixture(revealedFixture);
      await expect(tender.connect(outsider).awardContract(TENDER_ID, c1.address, 400_000_000n))
        .to.be.revertedWithCustomError(tender, "NotTenderIssuer");
    });

    it("rejects awarding an unrevealed bid", async () => {
      const { tender, issuer, c1, deadline } = await loadFixture(deployFixture);
      await tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(400_000_000n, SALT));
      await time.increaseTo(deadline + 1); // deadline passed but c1 never reveals
      await expect(tender.connect(issuer).awardContract(TENDER_ID, c1.address, 400_000_000n))
        .to.be.revertedWithCustomError(tender, "BidNotRevealed");
    });

    it("rejects awarding a contractor with no bid", async () => {
      const { tender, issuer, outsider } = await loadFixture(revealedFixture);
      await expect(tender.connect(issuer).awardContract(TENDER_ID, outsider.address, 1n))
        .to.be.revertedWithCustomError(tender, "NoSealedBid");
    });

    it("rejects a winning amount that differs from the revealed amount", async () => {
      const { tender, issuer, c1 } = await loadFixture(revealedFixture);
      await expect(tender.connect(issuer).awardContract(TENDER_ID, c1.address, 399_000_000n))
        .to.be.revertedWithCustomError(tender, "AmountMismatch");
    });
  });

  describe("milestones", () => {
    it("rejects verification by a non-auditor (including the issuer and admin)", async () => {
      const { tender, issuer, admin, outsider } = await loadFixture(awardedFixture);
      for (const who of [outsider, issuer, admin]) {
        await expect(tender.connect(who).verifyMilestone(TENDER_ID, "M1"))
          .to.be.revertedWithCustomError(tender, "NotAuditor");
      }
    });

    it("rejects paying an unverified milestone", async () => {
      const { tender, issuer } = await loadFixture(awardedFixture);
      await expect(tender.connect(issuer).releaseMilestonePayment(TENDER_ID, "M1"))
        .to.be.revertedWithCustomError(tender, "MilestoneNotVerified");
    });

    it("rejects double verification and unknown milestones", async () => {
      const { tender, auditor } = await loadFixture(awardedFixture);
      await tender.connect(auditor).verifyMilestone(TENDER_ID, "M1");
      await expect(tender.connect(auditor).verifyMilestone(TENDER_ID, "M1"))
        .to.be.revertedWithCustomError(tender, "MilestoneNotPending");
      await expect(tender.connect(auditor).verifyMilestone(TENDER_ID, "nope"))
        .to.be.revertedWithCustomError(tender, "MilestoneNotFound");
    });
  });

  describe("input validation", () => {
    it("validates tender creation and bid submission", async () => {
      const { tender, issuer, c1 } = await loadFixture(deployFixture);
      const future = (await time.latest()) + 1000;
      await expect(tender.connect(issuer).createTender(TENDER_ID, "dup", 1n, future))
        .to.be.revertedWithCustomError(tender, "TenderAlreadyExists");
      await expect(tender.connect(issuer).createTender("T-2", "x", 0n, future))
        .to.be.revertedWithCustomError(tender, "InvalidBudget");
      await expect(tender.connect(issuer).createTender("T-2", "x", 1n, 1))
        .to.be.revertedWithCustomError(tender, "DeadlineNotInFuture");
      await expect(tender.connect(c1).submitSealedBid("missing", sealBid(1n, SALT)))
        .to.be.revertedWithCustomError(tender, "TenderNotFound");
      await expect(tender.connect(c1).submitSealedBid(TENDER_ID, ethers.ZeroHash))
        .to.be.revertedWithCustomError(tender, "InvalidBidHash");
    });

    it("covers remaining reveal/award/milestone guards", async () => {
      const { tender, issuer, c1, c2 } = await loadFixture(revealedFixture);
      await expect(tender.connect(c1).revealBid("missing", 1n, SALT))
        .to.be.revertedWithCustomError(tender, "TenderNotFound");
      await expect(tender.connect(c1).revealBid(TENDER_ID, 400_000_000n, SALT))
        .to.be.revertedWithCustomError(tender, "BidNotSubmitted");
      await expect(tender.connect(issuer).createMilestone(TENDER_ID, "M1", "early", 1n))
        .to.be.revertedWithCustomError(tender, "NotAwarded");
      await tender.connect(issuer).awardContract(TENDER_ID, c1.address, 400_000_000n);
      await expect(tender.connect(issuer).awardContract(TENDER_ID, c2.address, 420_000_000n))
        .to.be.revertedWithCustomError(tender, "CannotAward");
      await expect(tender.connect(c2).submitSealedBid(TENDER_ID, sealBid(1n, SALT)))
        .to.be.revertedWithCustomError(tender, "TenderNotOpen");
      await tender.connect(issuer).createMilestone(TENDER_ID, "M1", "Phase 1", 1n);
      await expect(tender.connect(issuer).createMilestone(TENDER_ID, "M1", "again", 1n))
        .to.be.revertedWithCustomError(tender, "MilestoneAlreadyExists");
      await expect(tender.connect(issuer).releaseMilestonePayment(TENDER_ID, "nope"))
        .to.be.revertedWithCustomError(tender, "MilestoneNotFound");
    });

    it("rejects awarding an amount above the tender budget", async () => {
      const { tender, issuer, c1, deadline } = await loadFixture(deployFixture);
      const over = BUDGET + 1n;
      await tender.connect(c1).submitSealedBid(TENDER_ID, sealBid(over, SALT));
      await time.increaseTo(deadline + 1);
      await tender.connect(c1).revealBid(TENDER_ID, over, SALT);
      await expect(tender.connect(issuer).awardContract(TENDER_ID, c1.address, over))
        .to.be.revertedWithCustomError(tender, "ExceedsBudget");
    });
  });
});
