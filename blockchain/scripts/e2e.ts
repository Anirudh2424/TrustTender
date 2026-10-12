import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * End-to-end flow for TenderContract with 4 wallets (issuer/deployer, 2 bidders, auditor).
 *  - hardhat:     deploys a fresh contract, uses built-in signers, time-travels past the deadline
 *  - polygonAmoy: loads the deployed address from ../src/contracts/TenderContract.json, creates
 *                 random bidder/auditor wallets (never printed or saved) and funds them from the deployer
 * Results go to ../docs/test-results.md and ../docs/test-results.json.
 */

const EXPLORER = "https://amoy.polygonscan.com";
const FUND_AMOUNT = ethers.parseEther("0.02");
const DEADLINE_SECS = 90;

type Row = {
  step: number;
  function: string;
  callerRole: string;
  caller: string;
  input: string;
  txHash: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  result: string;
  ok: boolean;
};

const rows: Row[] = [];
const isAmoy = network.name === "polygonAmoy";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function record(row: Omit<Row, "step">) {
  const full: Row = { step: rows.length + 1, ...row };
  rows.push(full);
  console.log(
    `${String(full.step).padStart(2)} | ${full.function.padEnd(22)} | ${full.callerRole.padEnd(9)} | ` +
      `${full.input.padEnd(44)} | ${(full.txHash ?? "-").padEnd(66)} | ` +
      `${String(full.blockNumber ?? "-").padStart(8)} | ${String(full.gasUsed ?? "-").padStart(8)} | ${full.result}`
  );
}

/** Sends a transaction, waits for it, and records a row. */
async function sendTx(
  fn: string,
  role: string,
  caller: string,
  input: string,
  send: () => Promise<{ hash: string; wait: () => Promise<any> }>
) {
  const tx = await send();
  const receipt = await tx.wait();
  const ok = receipt.status === 1;
  record({
    function: fn,
    callerRole: role,
    caller,
    input,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    result: ok ? "SUCCESS" : "FAILED",
    ok,
  });
  if (!ok) throw new Error(`${fn} failed on-chain`);
  return receipt;
}

/** Simulates a call that must revert with the given custom error. No transaction is sent (no gas spent). */
async function expectRevert(
  contract: any,
  fn: string,
  role: string,
  caller: string,
  input: string,
  call: () => Promise<unknown>,
  expectedError: string
) {
  let actual = "NO REVERT";
  try {
    await call();
  } catch (e: any) {
    actual = e?.revert?.name ?? contract.interface.parseError(e?.data)?.name ?? e?.shortMessage ?? "unknown error";
  }
  const ok = actual === expectedError;
  record({
    function: fn,
    callerRole: role,
    caller,
    input,
    txHash: null,
    blockNumber: null,
    gasUsed: null,
    result: ok ? `REVERTED as expected (${actual})` : `UNEXPECTED: got ${actual}, wanted ${expectedError}`,
    ok,
  });
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp;
}

async function main() {
  const [deployer, ...hhSigners] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY in blockchain/.env");
  const { chainId } = await ethers.provider.getNetwork();

  // ---- wallets + contract ----
  let bidder1: any, bidder2: any, auditor: any;
  let tender: any;
  let contractAddress: string;

  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`#  | function               | caller    | input                                        | tx hash                                                            | block    | gas      | result`);

  if (isAmoy) {
    const deployedFile = path.join(__dirname, "..", "..", "src", "contracts", "TenderContract.json");
    if (!fs.existsSync(deployedFile)) throw new Error("src/contracts/TenderContract.json not found: run `npm run deploy:amoy` first");
    const deployed = JSON.parse(fs.readFileSync(deployedFile, "utf8"));
    contractAddress = deployed.address;
    if ((await ethers.provider.getCode(contractAddress)) === "0x") throw new Error(`No contract code at ${contractAddress} on this network`);
    tender = await ethers.getContractAt("TenderContract", contractAddress, deployer);
    if ((await tender.admin()).toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error("Deployer wallet is not the contract admin; addAuditor would fail");
    }

    bidder1 = ethers.Wallet.createRandom().connect(ethers.provider);
    bidder2 = ethers.Wallet.createRandom().connect(ethers.provider);
    auditor = ethers.Wallet.createRandom().connect(ethers.provider);
    for (const [role, w] of [["bidder1", bidder1], ["bidder2", bidder2], ["auditor", auditor]] as const) {
      await sendTx("fund (native transfer)", "deployer", deployer.address, `0.02 POL -> ${role} ${short(w.address)}`, () =>
        deployer.sendTransaction({ to: w.address, value: FUND_AMOUNT })
      );
    }
  } else {
    [bidder1, bidder2, auditor] = hhSigners;
    const factory = await ethers.getContractFactory("TenderContract", deployer);
    tender = await factory.deploy();
    const deployTx = tender.deploymentTransaction()!;
    const receipt = await deployTx.wait();
    contractAddress = await tender.getAddress();
    record({
      function: "deploy",
      callerRole: "deployer",
      caller: deployer.address,
      input: `TenderContract -> ${short(contractAddress)}`,
      txHash: deployTx.hash,
      blockNumber: receipt!.blockNumber,
      gasUsed: receipt!.gasUsed.toString(),
      result: "SUCCESS",
      ok: true,
    });
  }

  const issuer = deployer;
  const t = (signer: any) => tender.connect(signer) as any;

  // ---- bids ----
  const tenderId = `E2E-${Date.now()}`;
  const budget = 450_000_000n;
  const bids = [
    { signer: bidder1, role: "bidder1", amount: 400_000_000n, salt: crypto.randomBytes(16).toString("hex") },
    { signer: bidder2, role: "bidder2", amount: 420_000_000n, salt: crypto.randomBytes(16).toString("hex") },
  ];
  const winner = bids.reduce((a, b) => (b.amount < a.amount ? b : a)); // lower bid wins
  const hashOf = (amount: bigint, salt: string) => ethers.solidityPackedKeccak256(["uint256", "string"], [amount, salt]);

  // ---- createTender ----
  const deadline = (await latestTimestamp()) + DEADLINE_SECS;
  await sendTx("createTender", "issuer", issuer.address, `${tenderId}, budget ${budget}, deadline +${DEADLINE_SECS}s`, () =>
    t(issuer).createTender(tenderId, "E2E test tender", budget, deadline)
  );

  // ---- sealed bids ----
  for (const b of bids) {
    await sendTx("submitSealedBid", b.role, b.signer.address, `${tenderId}, hash(${b.amount}, salt=<hidden>)`, () =>
      t(b.signer).submitSealedBid(tenderId, hashOf(b.amount, b.salt))
    );
  }

  // ---- wait for the deadline ----
  if (isAmoy) {
    console.log(`... waiting for chain time to pass the deadline (~${DEADLINE_SECS}s)`);
    while ((await latestTimestamp()) <= deadline + 2) await sleep(3000);
  } else {
    await time.increaseTo(deadline + 1);
  }

  // ---- negative: bid after the deadline ----
  await expectRevert(tender, "submitSealedBid", "bidder1", bidder1.address, `${tenderId}, after deadline`,
    () => t(bidder1).submitSealedBid.staticCall(tenderId, hashOf(1n, "late")), "BiddingClosed");

  // ---- negative: wrong salt on reveal ----
  await expectRevert(tender, "revealBid", "bidder1", bidder1.address, `${tenderId}, ${bids[0].amount}, salt=<wrong>`,
    () => t(bidder1).revealBid.staticCall(tenderId, bids[0].amount, "wrong-salt"), "HashMismatch");

  // ---- reveals ----
  for (const b of bids) {
    await sendTx("revealBid", b.role, b.signer.address, `${tenderId}, ${b.amount}, salt=<hidden>`, () =>
      t(b.signer).revealBid(tenderId, b.amount, b.salt)
    );
  }

  // ---- award to the lower bid ----
  await sendTx("awardContract", "issuer", issuer.address, `${tenderId}, ${winner.role} ${short(winner.signer.address)}, ${winner.amount}`, () =>
    t(issuer).awardContract(tenderId, winner.signer.address, winner.amount)
  );

  // ---- auditor role + milestone ----
  await sendTx("addAuditor", "admin", deployer.address, `${short(auditor.address)}`, () => t(deployer).addAuditor(auditor.address));
  const milestoneId = `${tenderId}-M1`;
  await sendTx("createMilestone", "issuer", issuer.address, `${milestoneId}, ${winner.amount / 4n}`, () =>
    t(issuer).createMilestone(tenderId, milestoneId, "Phase 1", winner.amount / 4n)
  );

  // ---- negative: non-auditor verify ----
  await expectRevert(tender, "verifyMilestone", "bidder2", bidder2.address, `${milestoneId}`,
    () => t(bidder2).verifyMilestone.staticCall(tenderId, milestoneId), "NotAuditor");

  await sendTx("verifyMilestone", "auditor", auditor.address, `${milestoneId}`, () => t(auditor).verifyMilestone(tenderId, milestoneId));
  await sendTx("releaseMilestonePayment", "issuer", issuer.address, `${milestoneId}`, () =>
    t(issuer).releaseMilestonePayment(tenderId, milestoneId)
  );

  // ---- save results ----
  const allOk = rows.every((r) => r.ok);
  const docsDir = path.join(__dirname, "..", "..", "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const meta = {
    network: network.name,
    chainId: Number(chainId),
    contract: contractAddress,
    tenderId,
    runAt: new Date().toISOString(),
    allPassed: allOk,
  };
  fs.writeFileSync(path.join(docsDir, "test-results.json"), JSON.stringify({ ...meta, rows }, null, 2) + "\n");

  const txCell = (r: Row) =>
    r.txHash ? (isAmoy ? `[\`${r.txHash.slice(0, 10)}…\`](${EXPLORER}/tx/${r.txHash})` : `\`${r.txHash}\``) : "—";
  const md = [
    "# TenderContract E2E results",
    "",
    `- **Network:** ${meta.network} (chainId ${meta.chainId})`,
    `- **Contract:** ${isAmoy ? `[\`${contractAddress}\`](${EXPLORER}/address/${contractAddress})` : `\`${contractAddress}\` (ephemeral local deployment)`}`,
    `- **Tender ID:** \`${tenderId}\``,
    `- **Run at:** ${meta.runAt}`,
    `- **Overall:** ${allOk ? "PASS" : "FAIL"}`,
    "",
    "Negative cases are simulated with `staticCall`, so they confirm the revert reason without sending a transaction (no tx hash / gas).",
    "",
    "| # | Function | Caller role | Input | Tx hash | Block | Gas used | Result |",
    "|---|----------|-------------|-------|---------|-------|----------|--------|",
    ...rows.map(
      (r) =>
        `| ${r.step} | ${r.function} | ${r.callerRole} | ${r.input.replace(/\|/g, "\\|")} | ${txCell(r)} | ${r.blockNumber ?? "—"} | ${r.gasUsed ?? "—"} | ${r.result} |`
    ),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "test-results.md"), md);

  console.log(`\nOverall: ${allOk ? "PASS" : "FAIL"}  (${rows.length} rows)`);
  console.log(`Saved: ${path.relative(process.cwd(), path.join(docsDir, "test-results.md"))}, test-results.json`);
  if (!allOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
