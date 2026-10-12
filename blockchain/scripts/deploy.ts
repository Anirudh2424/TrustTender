import { ethers, network, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY in blockchain/.env (see .env.example)");
  }

  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const factory = await ethers.getContractFactory("TenderContract");
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`TenderContract deployed to: ${address}`);

  const artifact = await artifacts.readArtifact("TenderContract");
  const outFile = path.join(__dirname, "..", "..", "src", "contracts", "TenderContract.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify({ address, chainId: Number(chainId), network: network.name, abi: artifact.abi }, null, 2) + "\n"
  );
  console.log(`Wrote address + ABI to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
