# TenderContract E2E results

- **Network:** hardhat (chainId 31337)
- **Contract:** `0x5FbDB2315678afecb367f032d93F642f64180aa3` (ephemeral local deployment)
- **Tender ID:** `E2E-1791815388142`
- **Run at:** 2026-10-12T14:29:48.174Z
- **Overall:** PASS

Negative cases are simulated with `staticCall`, so they confirm the revert reason without sending a transaction (no tx hash / gas).

| # | Function | Caller role | Input | Tx hash | Block | Gas used | Result |
|---|----------|-------------|-------|---------|-------|----------|--------|
| 1 | deploy | deployer | TenderContract -> 0x5FbD…0aa3 | `0x7d26b862a0bfc841a4c473415cbe87b3dd69cc7e50e79fa6f2c570548738ddcb` | 1 | 2020382 | SUCCESS |
| 2 | createTender | issuer | E2E-1791815388142, budget 450000000, deadline +90s | `0x865d2f4f7b6f2ffa9d110a354486c5940904f81256c856fca178f7c034453bcb` | 2 | 160709 | SUCCESS |
| 3 | submitSealedBid | bidder1 | E2E-1791815388142, hash(400000000, salt=<hidden>) | `0x8421ce71989559113f326f5447b3c1c9b3bbcc15cf9a647d896495b098848ecc` | 3 | 145784 | SUCCESS |
| 4 | submitSealedBid | bidder2 | E2E-1791815388142, hash(420000000, salt=<hidden>) | `0xf08e4bcbc8af52f8408e75105c0d5d9ccb72a66b06ec433709fc0e5c58ced232` | 4 | 128684 | SUCCESS |
| 5 | submitSealedBid | bidder1 | E2E-1791815388142, after deadline | — | — | — | REVERTED as expected (BiddingClosed) |
| 6 | revealBid | bidder1 | E2E-1791815388142, 400000000, salt=<wrong> | — | — | — | REVERTED as expected (HashMismatch) |
| 7 | revealBid | bidder1 | E2E-1791815388142, 400000000, salt=<hidden> | `0x821314f665dd83bd1bc9d8e49fe9ea05a46a10cf2fda16af09178fe2458ed414` | 6 | 60202 | SUCCESS |
| 8 | revealBid | bidder2 | E2E-1791815388142, 420000000, salt=<hidden> | `0xbd85a358d5df0d7c179f80e44e2531e9db440ab956cb7dd3cbdd853fa99411ce` | 7 | 60202 | SUCCESS |
| 9 | awardContract | issuer | E2E-1791815388142, bidder1 0x7099…79C8, 400000000 | `0xb9acd6b3e93b255840ffef0605b5f2eb51b646168775a573e971fb502a83653b` | 8 | 100395 | SUCCESS |
| 10 | addAuditor | admin | 0x90F7…b906 | `0x9c12cc36c3221bd250a8aebcccafe248a207c1a196fe65422d9af68251bc32b6` | 9 | 45567 | SUCCESS |
| 11 | createMilestone | issuer | E2E-1791815388142-M1, 100000000 | `0xf6f84fcf1e545aa3225f8ed059b826fbbc5a9d4c3102b592081380d41682ebb6` | 10 | 174861 | SUCCESS |
| 12 | verifyMilestone | bidder2 | E2E-1791815388142-M1 | — | — | — | REVERTED as expected (NotAuditor) |
| 13 | verifyMilestone | auditor | E2E-1791815388142-M1 | `0x215ba82c9d03f49effe74a455020d2d074b60b8e35f6c6844923bdb9a3e1eeff` | 11 | 75188 | SUCCESS |
| 14 | releaseMilestonePayment | issuer | E2E-1791815388142-M1 | `0xc5087e3b22549068a6385840b786ff8ea11e81e2bbf27b6f5bd8f68f2968f399` | 12 | 65118 | SUCCESS |
