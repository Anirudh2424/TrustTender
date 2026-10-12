const crypto = require('crypto');
const { getPool } = require('./db');

/**
 * Appends an entry to the off-chain audit ledger (MySQL).
 *
 * `ledgerRef` is an internal reference for the row, NOT a blockchain transaction hash. It is
 * deliberately not 0x-prefixed. A real Polygon tx hash may be passed in `details`
 * (details.polygonTxHash) and is only present when an on-chain transaction actually exists.
 */
async function logAudit(action, performedBy, details = {}) {
    try {
        const pool = getPool();
        const txNumber = Math.floor(1000 + Math.random() * 9000);
        const txId = `TX-${txNumber}`;

        const payloadToHash = JSON.stringify({
            txId,
            action,
            performedBy,
            details,
            timestamp: Date.now(),
            salt: crypto.randomBytes(8).toString('hex')
        });
        const ledgerRef = 'LR-' + crypto.createHash('sha256').update(payloadToHash).digest('hex').substring(0, 40);

        await pool.query(
            `INSERT INTO audit_logs (txId, action, performedBy, ledgerRef, status, details)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [txId, action, performedBy, ledgerRef, 'Verified', JSON.stringify(details)]
        );

        return { txId, ledgerRef };
    } catch (err) {
        console.error('[Audit Log Error]:', err);
        // Non-blocking: failure in audit logging should not crash the main transaction
        return null;
    }
}

module.exports = {
    logAudit
};
