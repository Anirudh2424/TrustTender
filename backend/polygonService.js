const { ethers } = require('ethers');
const { requireEnv } = require('./env');

// Polygon Amoy Testnet Configuration (Free public RPCs)
const POLYGON_RPC_URLS = [
    'https://rpc-amoy.polygon.technology',
    'https://polygon-amoy-bor-rpc.publicnode.com',
    'https://rpc.ankr.com/polygon_amoy'
];

const POLYGON_CHAIN_ID = 80002;
const POLYGON_EXPLORER = 'https://amoy.polygonscan.com';
const NETWORK_LABEL = 'Polygon Amoy Testnet (Chain ID 80002)';
const TX_CONFIRM_TIMEOUT_MS = 90_000;
const RPC_TIMEOUT_MS = 10_000;
const MIN_GAS_BALANCE = ethers.parseEther('0.0001');

// Operator wallet for anchoring bid hashes on Polygon
const OPERATOR_PRIVATE_KEY = requireEnv('POLYGON_PRIVATE_KEY');
new ethers.Wallet(OPERATOR_PRIVATE_KEY); // validate format at startup; throws if malformed

let provider = null;
let operatorWallet = null;

function getPolygonProvider() {
    if (!provider) {
        // staticNetwork + request timeout so an unreachable RPC fails fast instead of retrying forever;
        // any one healthy endpoint is enough (quorum 1).
        const providers = POLYGON_RPC_URLS.map((url, i) => {
            const req = new ethers.FetchRequest(url);
            req.timeout = RPC_TIMEOUT_MS;
            return {
                provider: new ethers.JsonRpcProvider(req, POLYGON_CHAIN_ID, { staticNetwork: true }),
                priority: i + 1,
                stallTimeout: 2000,
                weight: 1
            };
        });
        provider = new ethers.FallbackProvider(providers, POLYGON_CHAIN_ID, { quorum: 1 });
        operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
    }
    return { provider, operatorWallet };
}

/**
 * Calculates a cryptographic Keccak-256 bid hash matching Solidity:
 * keccak256(abi.encodePacked(uint256(bidAmountINR), string(salt)))
 */
function computeBidHash(bidAmountINR, salt) {
    const amountBigInt = BigInt(Math.floor(Number(bidAmountINR)));
    return ethers.solidityPackedKeccak256(['uint256', 'string'], [amountBigInt, salt.toString()]);
}

/**
 * Anchors the sealed bid hash on Polygon Amoy by broadcasting a zero-value data transaction.
 *
 * Only real, mined transactions are reported: polygonTxHash and polygonBlock come from the
 * receipt returned by tx.wait(). Nothing is ever fabricated. On any failure (RPC error, no gas,
 * revert, confirmation timeout) it returns { anchored: false, error } so the caller can persist
 * the bid as PENDING_ANCHOR with NULL tx fields.
 *
 * @returns {Promise<{anchored: true, bidHash, polygonTxHash, polygonBlock, polygonscanUrl, network}
 *   | {anchored: false, bidHash, error: string}>}
 */
async function anchorBidOnPolygon(tenderId, contractorId, bidAmountINR, salt) {
    const bidHash = computeBidHash(bidAmountINR, salt);
    let pendingTxHash = null;

    try {
        const { provider, operatorWallet } = getPolygonProvider();

        const balance = await provider.getBalance(operatorWallet.address);
        if (balance < MIN_GAS_BALANCE) {
            return { anchored: false, bidHash, error: 'Operator wallet has insufficient POL for gas' };
        }

        const payloadData = ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify({
            app: 'etendering-polygon',
            tenderId,
            contractorId,
            bidHash,
            timestamp: Date.now()
        })));

        const tx = await operatorWallet.sendTransaction({
            to: operatorWallet.address,
            data: payloadData,
            gasLimit: 60000
        });
        pendingTxHash = tx.hash; // broadcast only: NOT stored until mined

        const receipt = await tx.wait(1, TX_CONFIRM_TIMEOUT_MS);
        if (!receipt || receipt.status !== 1) {
            return { anchored: false, bidHash, error: 'Anchor transaction reverted on-chain' };
        }

        console.log(`[Polygon Amoy] Anchored in block ${receipt.blockNumber}: ${receipt.hash}`);
        return {
            anchored: true,
            bidHash,
            polygonTxHash: receipt.hash,
            polygonBlock: receipt.blockNumber,
            polygonscanUrl: `${POLYGON_EXPLORER}/tx/${receipt.hash}`,
            network: NETWORK_LABEL
        };
    } catch (err) {
        const detail = err.shortMessage || err.message;
        console.warn(`[Polygon Anchor Failed] ${detail}${pendingTxHash ? ` (unconfirmed broadcast tx: ${pendingTxHash})` : ''}`);
        return { anchored: false, bidHash, error: detail };
    }
}

module.exports = {
    computeBidHash,
    anchorBidOnPolygon,
    POLYGON_CHAIN_ID,
    POLYGON_EXPLORER
};
