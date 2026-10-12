# TenderContract E2E results

- **Network:** hardhat (chainId 31337)
- **Contract:** `0x5FbDB2315678afecb367f032d93F642f64180aa3` (ephemeral local deployment)
- **Tender ID:** `E2E-1791818208584`
- **Run at:** 2026-10-12T15:16:48.616Z
- **Overall:** PASS

Negative cases are simulated with `staticCall`, so they confirm the revert reason without sending a transaction (no tx hash / gas).

| # | Function | Caller role | Input | Tx hash | Block | Gas used | Result |
|---|----------|-------------|-------|---------|-------|----------|--------|
| 1 | deploy | deployer | TenderContract -> 0x5FbD…0aa3 | `0x7d26b862a0bfc841a4c473415cbe87b3dd69cc7e50e79fa6f2c570548738ddcb` | 1 | 2020382 | SUCCESS |
| 2 | createTender | issuer | E2E-1791818208584, budget 450000000, deadline +90s | `0xe596509b53aa89ec19ac25c355341399bb0bcdf94f0b9f9645771d739aed5763` | 2 | 160709 | SUCCESS |
| 3 | submitSealedBid | bidder1 | E2E-1791818208584, hash(400000000, salt=<hidden>) | `0x98aff1b5a5bf71c128e79ec7fa883d273797c422e091850c69f99de53fcf8c10` | 3 | 145784 | SUCCESS |
| 4 | submitSealedBid | bidder2 | E2E-1791818208584, hash(420000000, salt=<hidden>) | `0x4429d7fb154a9035502af80f6ad766a0a4245c259ab95022a9508b1850e846ca` | 4 | 128684 | SUCCESS |
| 5 | submitSealedBid | bidder1 | E2E-1791818208584, after deadline | — | — | — | REVERTED as expected (BiddingClosed) |
| 6 | revealBid | bidder1 | E2E-1791818208584, 400000000, salt=<wrong> | — | — | — | REVERTED as expected (HashMismatch) |
| 7 | revealBid | bidder1 | E2E-1791818208584, 400000000, salt=<hidden> | `0xb75d5efa6156a9c39a54472a46d8cdba6a7cb04ed4974b6c7f3934400bafce55` | 6 | 60202 | SUCCESS |
| 8 | revealBid | bidder2 | E2E-1791818208584, 420000000, salt=<hidden> | `0x4fa6d08ec273d52be7ef069ed14bdfb761b07f1ee2da0c60bbf8250a1415d6e2` | 7 | 60202 | SUCCESS |
| 9 | awardContract | issuer | E2E-1791818208584, bidder1 0x7099…79C8, 400000000 | `0x065c97a0838547ce0b93ca28513f854145f700aedd2f4c8053320d8a49b54e41` | 8 | 100395 | SUCCESS |
| 10 | addAuditor | admin | 0x90F7…b906 | `0x9c12cc36c3221bd250a8aebcccafe248a207c1a196fe65422d9af68251bc32b6` | 9 | 45567 | SUCCESS |
| 11 | createMilestone | issuer | E2E-1791818208584-M1, 100000000 | `0x49d960fcf26aee48411e29638ac09d238c46d48bac2edaacba0a2ffc0488440f` | 10 | 174861 | SUCCESS |
| 12 | verifyMilestone | bidder2 | E2E-1791818208584-M1 | — | — | — | REVERTED as expected (NotAuditor) |
| 13 | verifyMilestone | auditor | E2E-1791818208584-M1 | `0x9a5423b5c1d0dcff79bb6d409e5abdcc03ee4a082ad5d66013b6625e6de4cbb4` | 11 | 75188 | SUCCESS |
| 14 | releaseMilestonePayment | issuer | E2E-1791818208584-M1 | `0xdbdbbb9efa7fb2f2fd8c7bdda2428088cbba780a654229f35995ed0da42b1702` | 12 | 65118 | SUCCESS |
