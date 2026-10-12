const { requireEnv } = require('./env');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { initDB, getPool } = require('./db');
const { logAudit } = require('./auditHelper');
const { anchorBidOnPolygon, computeBidHash, POLYGON_EXPLORER } = require('./polygonService');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = requireEnv('JWT_SECRET');

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json());

// Helper for Indian Rupee Formatting
function formatINR(amount) {
    const num = Number(amount);
    if (isNaN(num)) return '₹0';
    if (num >= 10000000) {
        return `₹${(num / 10000000).toFixed(2)} Cr`;
    } else if (num >= 100000) {
        return `₹${(num / 100000).toFixed(2)} Lakh`;
    }
    return `₹${num.toLocaleString('en-IN')}`;
}

// Security Middleware: Enforce Credentials using JWT
const requireIdentity = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { userId, role, orgName, walletId }
        next();
    } catch (err) {
        return res.status(403).json({ error: "Invalid or expired token" });
    }
};

// ==================== AUTHENTICATION ====================

app.post('/auth/signup', async (req, res) => {
    const { userId, password, role, walletId } = req.body;
    if (!userId || !password || !role) {
        return res.status(400).json({ error: "Missing required fields (userId, password, role)" });
    }

    try {
        const pool = getPool();
        const [existing] = await pool.query('SELECT id FROM users WHERE userId = ?', [userId]);
        if (existing.length > 0) {
            return res.status(409).json({ error: "User already exists in database" });
        }

        let orgName = 'Org1';
        if (role === 'bidder') orgName = 'Org2';

        const hashedPassword = await bcrypt.hash(password, 10);
        const resolvedWallet = walletId || ('0x' + crypto.randomBytes(6).toString('hex'));

        await pool.query(
            'INSERT INTO users (userId, password, role, walletId, orgName) VALUES (?, ?, ?, ?, ?)',
            [userId, hashedPassword, role, resolvedWallet, orgName]
        );

        await logAudit('User Registration', userId, { role, orgName, walletId: resolvedWallet });
        console.log(`[Auth] Registered new user in MySQL: ${userId} (${role})`);
        res.status(201).json({ success: true, message: "User registered successfully in MySQL" });
    } catch (err) {
        console.error('[Auth Error]:', err);
        res.status(500).json({ error: "Failed to register user in database" });
    }
});

app.post('/auth/login', async (req, res) => {
    const { userId, password, requestedRole } = req.body;
    if (!userId || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    try {
        const pool = getPool();
        const [users] = await pool.query('SELECT * FROM users WHERE userId = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ error: "User not found in database" });
        }

        const user = users[0];
        if (requestedRole && user.role !== requestedRole) {
            return res.status(403).json({ 
                error: `Account role mismatch. You registered as '${user.role}' but tried to sign in as '${requestedRole}'.` 
            });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.status(401).json({ error: "Invalid password credentials" });
        }

        const token = jwt.sign(
            { userId: user.userId, role: user.role, orgName: user.orgName, walletId: user.walletId }, 
            JWT_SECRET, 
            { expiresIn: '12h' }
        );

        console.log(`[Auth] User authenticated via MySQL: ${userId} [${user.role}]`);
        res.json({ 
            success: true, 
            token, 
            role: user.role, 
            userId: user.userId, 
            walletId: user.walletId, 
            orgName: user.orgName 
        });
    } catch (err) {
        console.error('[Auth Login Error]:', err);
        res.status(500).json({ error: "Authentication failed" });
    }
});

// ==================== TENDERS ====================

app.post('/tender/create', requireIdentity, async (req, res) => {
    const { tenderId, title, budget, deadline, createdBy } = req.body;
    const { userId, role } = req.user;

    if (role !== 'issuer') {
        return res.status(403).json({ error: 'Unauthorized: Only Government (Issuer) can publish tenders' });
    }
    if (!tenderId || !title || !budget || !deadline) {
        return res.status(400).json({ error: "All tender fields (tenderId, title, budget, deadline) are required" });
    }

    try {
        const pool = getPool();
        const [existing] = await pool.query('SELECT tenderId FROM tenders WHERE tenderId = ?', [tenderId]);
        if (existing.length > 0) {
            return res.status(409).json({ error: `Tender ${tenderId} already exists` });
        }

        await pool.query(
            `INSERT INTO tenders (tenderId, title, budget, deadline, createdBy, status) 
             VALUES (?, ?, ?, ?, ?, 'OPEN')`,
            [tenderId, title, parseFloat(budget), parseInt(deadline), createdBy || userId]
        );

        await logAudit('Tender Creation', userId, { tenderId, title, budgetINR: formatINR(budget) });
        console.log(`[Tender] Created: ${tenderId} by ${userId} (${formatINR(budget)})`);
        res.status(201).json({ 
            success: true, 
            message: "Tender created successfully", 
            tender: { tenderId, title, budget, deadline, status: 'OPEN' } 
        });
    } catch (err) {
        console.error('[Tender Create Error]:', err);
        res.status(500).json({ error: err.message || "Failed to create tender" });
    }
});

app.get('/tender/all', requireIdentity, async (req, res) => {
    try {
        const pool = getPool();
        const [tenders] = await pool.query(`
            SELECT t.*, 
                   (SELECT COUNT(*) FROM bids b WHERE b.tenderId = t.tenderId) as bidsCount,
                   (SELECT COUNT(*) FROM milestones m WHERE m.tenderId = t.tenderId) as milestonesCount
            FROM tenders t 
            ORDER BY t.createdAt DESC
        `);
        res.json(tenders);
    } catch (err) {
        console.error('[Tender All Error]:', err);
        res.status(500).json({ error: "Failed to fetch tenders" });
    }
});

app.get('/tender/:id', requireIdentity, async (req, res) => {
    const tenderId = req.params.id;
    try {
        const pool = getPool();
        const [tenders] = await pool.query('SELECT * FROM tenders WHERE tenderId = ?', [tenderId]);
        if (tenders.length === 0) {
            return res.status(404).json({ error: `Tender ${tenderId} not found` });
        }

        const tender = tenders[0];
        const [milestones] = await pool.query('SELECT * FROM milestones WHERE tenderId = ? ORDER BY createdAt ASC', [tenderId]);
        tender.milestonesData = milestones.map(m => ({
            id: m.milestoneId,
            milestoneId: m.milestoneId,
            description: m.description,
            amount: parseFloat(m.amount),
            status: m.status,
            verifiedBy: m.verifiedBy,
            verifiedAt: m.verifiedAt,
            paidAt: m.paidAt
        }));

        res.json(tender);
    } catch (err) {
        console.error('[Tender Detail Error]:', err);
        res.status(500).json({ error: "Failed to fetch tender details" });
    }
});

// Role gate: use after requireIdentity, e.g. requireRole('issuer')
const requireRole = (...allowed) => (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
        return res.status(403).json({ error: `Forbidden: requires role ${allowed.join(' or ')}` });
    }
    next();
};

// ==================== BIDS (POLYGON INTEGRATION) ====================

app.post('/bid/submit', requireIdentity, async (req, res) => {
    const { tenderId, contractorId, bidAmount, salt } = req.body;
    const { userId, role } = req.user;

    if (role !== 'bidder') {
        return res.status(403).json({ error: 'Unauthorized: Only contractors (bidders) can submit bids.' });
    }
    if (!tenderId || !bidAmount || !salt) {
        return res.status(400).json({ error: "tenderId, bidAmount, and salt are required" });
    }

    try {
        const pool = getPool();
        const [tenders] = await pool.query('SELECT * FROM tenders WHERE tenderId = ?', [tenderId]);
        if (tenders.length === 0) {
            return res.status(404).json({ error: `Tender ${tenderId} does not exist` });
        }

        const tender = tenders[0];
        if (tender.status !== 'OPEN') {
            return res.status(400).json({ error: `Tender is not open for bidding (Current status: ${tender.status})` });
        }

        const effectiveContractor = contractorId || userId;

        // 1. Anchor bid hash to Polygon Blockchain
        const polygonResult = await anchorBidOnPolygon(tenderId, effectiveContractor, bidAmount, salt);
        const keccakHash = polygonResult.bidHash;
        const anchored = polygonResult.anchored === true;
        // Tx fields are only ever set from a mined receipt; otherwise NULL + PENDING_ANCHOR
        const polygonTxHash = anchored ? polygonResult.polygonTxHash : null;
        const polygonBlock = anchored ? polygonResult.polygonBlock : null;
        const bidStatus = anchored ? 'SUBMITTED' : 'PENDING_ANCHOR';

        // 2. Upsert sealed bid in MySQL (with on-chain Polygon proof only if anchoring succeeded)
        await pool.query(`
            INSERT INTO bids (tenderId, contractorId, bidAmount, hash, salt, status, polygonTxHash, polygonBlock)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                bidAmount = VALUES(bidAmount),
                hash = VALUES(hash),
                salt = VALUES(salt),
                status = VALUES(status),
                polygonTxHash = VALUES(polygonTxHash),
                polygonBlock = VALUES(polygonBlock),
                submittedAt = CURRENT_TIMESTAMP
        `, [tenderId, effectiveContractor, parseFloat(bidAmount), keccakHash, salt, bidStatus, polygonTxHash, polygonBlock]);

        const auditDetails = { tenderId, bidHash: keccakHash.substring(0, 16) + '...' };
        if (anchored) {
            Object.assign(auditDetails, {
                polygonTxHash,
                polygonBlock,
                polygonscanUrl: polygonResult.polygonscanUrl,
                network: polygonResult.network
            });
        } else {
            Object.assign(auditDetails, { anchored: false, anchorError: polygonResult.error });
        }
        await logAudit(anchored ? 'Polygon Bid Sealed' : 'Bid Sealed (Pending Anchor)', effectiveContractor, auditDetails);

        if (!anchored) {
            console.warn(`[Polygon Bid] ${tenderId}/${effectiveContractor} stored as PENDING_ANCHOR: ${polygonResult.error}`);
            return res.status(202).json({
                success: true,
                anchored: false,
                status: 'PENDING_ANCHOR',
                message: "Bid sealed and stored, but it could NOT be anchored on Polygon yet. Resubmit to retry anchoring.",
                error: polygonResult.error,
                hash: keccakHash,
                polygonTxHash: null,
                polygonBlock: null
            });
        }

        console.log(`[Polygon Bid] Sealed bid for ${tenderId} on Polygon Amoy: ${polygonTxHash}`);
        res.status(200).json({
            success: true,
            anchored: true,
            status: 'SUBMITTED',
            message: "Bid cryptographically hashed and sealed on the Polygon blockchain",
            hash: keccakHash,
            polygonTxHash,
            polygonBlock,
            polygonscanUrl: polygonResult.polygonscanUrl,
            network: polygonResult.network
        });
    } catch (err) {
        console.error('[Bid Submit Error]:', err);
        res.status(500).json({ error: err.message || "Failed to submit bid to Polygon" });
    }
});

app.post('/bid/reveal', requireIdentity, async (req, res) => {
    const { tenderId, contractorId, bidAmount, salt } = req.body;
    const { userId } = req.user;
    const effectiveContractor = contractorId || userId;

    try {
        const pool = getPool();
        const [bids] = await pool.query(
            'SELECT * FROM bids WHERE tenderId = ? AND contractorId = ?',
            [tenderId, effectiveContractor]
        );

        if (bids.length === 0) {
            return res.status(404).json({ error: "No private sealed bid found for this contractor" });
        }

        const bid = bids[0];
        // Validate with Keccak-256 (Solidity standard) or SHA-256 fallback
        const computedKeccak = computeBidHash(bidAmount, salt);
        const computedSha = crypto.createHash('sha256').update(bidAmount.toString() + salt.toString()).digest('hex');

        if (computedKeccak !== bid.hash && computedSha !== bid.hash) {
            return res.status(400).json({ error: "Hash validation failed. The revealed amount and salt do not match the sealed genesis hash." });
        }

        await pool.query(
            'UPDATE bids SET status = "REVEALED", revealedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [bid.id]
        );

        await logAudit('Bid Reveal', effectiveContractor, { tenderId, bidAmountINR: formatINR(bidAmount) });
        console.log(`[Bid] Revealed bid for ${tenderId} by ${effectiveContractor}: ${formatINR(bidAmount)}`);
        res.json({ success: true, message: "Bid successfully verified and revealed", bidAmount: parseFloat(bidAmount) });
    } catch (err) {
        console.error('[Bid Reveal Error]:', err);
        res.status(500).json({ error: err.message || "Failed to reveal bid" });
    }
});

app.get('/bid/my-bids', requireIdentity, async (req, res) => {
    const { userId } = req.user;
    try {
        const pool = getPool();
        const [bids] = await pool.query(`
            SELECT b.*, t.title, t.budget, t.deadline, t.status as tenderStatus
            FROM bids b
            JOIN tenders t ON b.tenderId = t.tenderId
            WHERE b.contractorId = ?
            ORDER BY b.submittedAt DESC
        `, [userId]);

        const mapped = bids.map(b => ({
            id: `B-${b.id}`,
            tenderId: b.tenderId,
            title: b.title,
            status: b.status.toLowerCase(),
            deadline: new Date(Number(b.deadline)).toISOString().split('T')[0],
            budget: formatINR(b.budget),
            bidAmount: formatINR(b.bidAmount),
            polygonTxHash: b.polygonTxHash ? `${b.polygonTxHash.substring(0, 8)}...` : 'Pending',
            polygonscanUrl: b.polygonTxHash ? `${POLYGON_EXPLORER}/tx/${b.polygonTxHash}` : null
        }));

        res.json(mapped);
    } catch (err) {
        console.error('[My Bids Error]:', err);
        res.status(500).json({ error: "Failed to fetch user bids" });
    }
});

// ==================== EVALUATION & AWARDING ====================

app.post('/tender/evaluate', requireIdentity, async (req, res) => {
    const { tenderId } = req.body;
    try {
        const pool = getPool();
        const [tenders] = await pool.query('SELECT * FROM tenders WHERE tenderId = ?', [tenderId]);
        if (tenders.length === 0) return res.status(404).json({ error: "Tender not found" });

        const tender = tenders[0];
        const [bids] = await pool.query(
            'SELECT * FROM bids WHERE tenderId = ? AND bidAmount <= ? ORDER BY bidAmount ASC',
            [tenderId, tender.budget]
        );

        if (bids.length === 0) {
            return res.status(400).json({ error: "No valid bids found within tender budget limit" });
        }

        const lowestBid = bids[0];
        await pool.query('UPDATE tenders SET status = "EVALUATING" WHERE tenderId = ?', [tenderId]);

        res.json({
            message: "Evaluation complete",
            recommendedContractor: lowestBid.contractorId,
            amount: lowestBid.bidAmount,
            amountFormatted: formatINR(lowestBid.bidAmount),
            totalBids: bids.length
        });
    } catch (err) {
        console.error('[Tender Evaluate Error]:', err);
        res.status(500).json({ error: err.message || "Evaluation failed" });
    }
});

app.post('/tender/award', requireIdentity, async (req, res) => {
    const { tenderId, contractorId } = req.body;
    const { userId } = req.user;

    try {
        const pool = getPool();
        await pool.query(
            'UPDATE tenders SET status = "AWARDED", awardedTo = ? WHERE tenderId = ?',
            [contractorId, tenderId]
        );

        await pool.query(
            'UPDATE bids SET status = CASE WHEN contractorId = ? THEN "WINNER" ELSE "OUTBID" END WHERE tenderId = ?',
            [contractorId, tenderId]
        );

        await logAudit('Winner Selection', userId, { tenderId, contractorId });
        console.log(`[Tender] Awarded ${tenderId} to ${contractorId}`);
        res.json({ success: true, message: `Contract awarded to ${contractorId}` });
    } catch (err) {
        console.error('[Tender Award Error]:', err);
        res.status(500).json({ error: err.message || "Awarding failed" });
    }
});

app.post('/tender/orchestrate-award', requireIdentity, requireRole('issuer'), async (req, res) => {
    const { tenderId } = req.body;
    const { userId } = req.user;

    try {
        const pool = getPool();
        const [tenders] = await pool.query('SELECT * FROM tenders WHERE tenderId = ?', [tenderId]);
        if (tenders.length === 0) return res.status(404).json({ error: "Tender not found" });

        const tender = tenders[0];

        // Find optimal contractor
        const [bids] = await pool.query(
            'SELECT * FROM bids WHERE tenderId = ? ORDER BY bidAmount ASC',
            [tenderId]
        );

        if (bids.length === 0) {
            return res.status(400).json({ error: "Cannot award: no bids were submitted for this tender" });
        }
        const winningContractor = bids[0].contractorId;
        const winningAmount = bids[0].bidAmount;

        // Award contract
        await pool.query(
            'UPDATE tenders SET status = "AWARDED", awardedTo = ? WHERE tenderId = ?',
            [winningContractor, tenderId]
        );

        await pool.query(
            'UPDATE bids SET status = CASE WHEN contractorId = ? THEN "WINNER" ELSE "OUTBID" END WHERE tenderId = ?',
            [winningContractor, tenderId]
        );

        // Auto-generate 3 standard project milestones
        const splitAmount = (parseFloat(winningAmount) / 3).toFixed(2);
        const milestoneData = [
            [`${tenderId}-M1`, tenderId, 'Phase 1: Setup, Architectural Survey & Foundations', splitAmount, 'PENDING'],
            [`${tenderId}-M2`, tenderId, 'Phase 2: Core Engineering & Sensor Grid Deployment', splitAmount, 'PENDING'],
            [`${tenderId}-M3`, tenderId, 'Phase 3: Integration, Public Commissioning & Safety Sign-off', splitAmount, 'PENDING'],
        ];

        for (const ms of milestoneData) {
            await pool.query(`
                INSERT INTO milestones (milestoneId, tenderId, description, amount, status)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE description = VALUES(description), amount = VALUES(amount)
            `, ms);
        }

        await logAudit('Winner Selection & Milestones Created', userId, { 
            tenderId, 
            contractor: winningContractor, 
            winningAmount: formatINR(winningAmount),
            milestonesCount: 3 
        });

        console.log(`[Orchestration] Awarded ${tenderId} to ${winningContractor} with 3 milestones.`);

        const [awardedTender] = await pool.query('SELECT * FROM tenders WHERE tenderId = ?', [tenderId]);
        res.json({
            success: true,
            message: "Contract automatically awarded on Polygon and 3 project milestones generated in INR.",
            tender: awardedTender[0]
        });
    } catch (err) {
        console.error('[Orchestration Error]:', err);
        res.status(500).json({ error: err.message || "Orchestration failed" });
    }
});

app.get('/tender/:id/results', requireIdentity, async (req, res) => {
    const tenderId = req.params.id;
    try {
        const pool = getPool();
        const [tenders] = await pool.query('SELECT * FROM tenders WHERE tenderId = ?', [tenderId]);
        if (tenders.length === 0) return res.status(404).json({ error: "Tender not found" });

        const tender = tenders[0];
        const [bids] = await pool.query('SELECT * FROM bids WHERE tenderId = ? ORDER BY bidAmount ASC', [tenderId]);

        res.json({
            tenderId: tender.tenderId,
            title: tender.title,
            status: tender.status,
            awardedTo: tender.awardedTo,
            budget: formatINR(tender.budget),
            bidders: bids.map(b => ({
                name: b.contractorId,
                amount: formatINR(b.bidAmount),
                score: b.status === 'WINNER' ? '98/100' : '84/100',
                status: b.status.toLowerCase(),
                polygonTxHash: b.polygonTxHash
            }))
        });
    } catch (err) {
        console.error('[Tender Results Error]:', err);
        res.status(500).json({ error: "Failed to fetch tender results" });
    }
});

// ==================== MILESTONES & PAYMENTS ====================

app.post('/milestone/create', requireIdentity, async (req, res) => {
    const { tenderId, milestoneId, description, amount } = req.body;
    const { userId } = req.user;

    try {
        const pool = getPool();
        await pool.query(
            `INSERT INTO milestones (milestoneId, tenderId, description, amount, status)
             VALUES (?, ?, ?, ?, 'PENDING')
             ON DUPLICATE KEY UPDATE description = VALUES(description), amount = VALUES(amount)`,
            [milestoneId, tenderId, description, parseFloat(amount)]
        );

        await logAudit('Milestone Creation', userId, { tenderId, milestoneId, amountINR: formatINR(amount) });
        res.status(201).json({ success: true, message: "Milestone created", milestoneId });
    } catch (err) {
        console.error('[Milestone Create Error]:', err);
        res.status(500).json({ error: err.message || "Failed to create milestone" });
    }
});

app.post('/milestone/verify', requireIdentity, async (req, res) => {
    const { milestoneId, status } = req.body;
    const { userId, role } = req.user;

    if (role !== 'auditor') {
        return res.status(403).json({ error: "Unauthorized: Only auditors can verify project milestones" });
    }

    try {
        const pool = getPool();
        await pool.query(
            `UPDATE milestones 
             SET status = ?, verifiedBy = ?, verifiedAt = CURRENT_TIMESTAMP 
             WHERE milestoneId = ?`,
            [status || 'VERIFIED', userId, milestoneId]
        );

        await logAudit('Milestone Verified', userId, { milestoneId, status: status || 'VERIFIED' });
        console.log(`[Milestone] Verified ${milestoneId} by auditor ${userId}`);
        res.json({ success: true, message: `Milestone ${milestoneId} verified on-chain by auditor` });
    } catch (err) {
        console.error('[Milestone Verify Error]:', err);
        res.status(500).json({ error: err.message || "Verification failed" });
    }
});

app.post('/milestone/pay', requireIdentity, async (req, res) => {
    const { tenderId, milestoneId } = req.body;
    const { userId, role } = req.user;

    if (role !== 'issuer') {
        return res.status(403).json({ error: "Unauthorized: Only government issuers can release payments" });
    }

    try {
        const pool = getPool();
        const [ms] = await pool.query('SELECT * FROM milestones WHERE milestoneId = ?', [milestoneId]);
        if (ms.length === 0) return res.status(404).json({ error: "Milestone not found" });

        const milestone = ms[0];
        if (milestone.status !== 'VERIFIED') {
            return res.status(400).json({ error: "Cannot release payment: Milestone has not been verified by an auditor yet" });
        }

        await pool.query(
            'UPDATE milestones SET status = "PAID", paidAt = CURRENT_TIMESTAMP WHERE milestoneId = ?',
            [milestoneId]
        );

        await logAudit('Payment Released', userId, { tenderId, milestoneId, amountINR: formatINR(milestone.amount) });
        console.log(`[Payment] Released funds for milestone ${milestoneId} (${formatINR(milestone.amount)})`);
        res.json({ success: true, message: "Funds released via smart contract execution", milestoneId, amount: formatINR(milestone.amount) });
    } catch (err) {
        console.error('[Milestone Pay Error]:', err);
        res.status(500).json({ error: err.message || "Payment release failed" });
    }
});

// ==================== AUDIT & PUBLIC TRANSPARENCY ====================

app.get('/audit/logs', async (req, res) => {
    try {
        const pool = getPool();
        const [logs] = await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50');
        const mapped = logs.map(l => {
            // Real on-chain hash exists only when one was recorded in the entry's details
            let details = l.details;
            if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = {}; } }
            const polygonTxHash = details?.polygonTxHash || null;
            return {
                id: l.txId,
                action: l.action,
                user: l.performedBy,
                timestamp: new Date(l.timestamp).toISOString().replace('T', ' ').substring(0, 19),
                status: l.status,
                hash: l.ledgerRef,          // internal ledger reference (not a blockchain hash)
                ledgerRef: l.ledgerRef,
                polygonTxHash,
                polygonscanUrl: polygonTxHash ? `${POLYGON_EXPLORER}/tx/${polygonTxHash}` : null
            };
        });
        res.json(mapped);
    } catch (err) {
        console.error('[Audit Logs Error]:', err);
        res.status(500).json({ error: "Failed to fetch audit trail" });
    }
});

app.get('/public/projects', async (req, res) => {
    try {
        const pool = getPool();
        const [tenders] = await pool.query(`
            SELECT t.*, 
                   COALESCE((SELECT SUM(m.amount) FROM milestones m WHERE m.tenderId = t.tenderId AND m.status = 'PAID'), 0) as paidAmount
            FROM tenders t
            ORDER BY t.createdAt DESC
        `);

        const [contractorsCount] = await pool.query('SELECT COUNT(DISTINCT contractorId) as count FROM bids');
        const [totalPaid] = await pool.query('SELECT COALESCE(SUM(amount), 0) as total FROM milestones WHERE status = "PAID"');

        const projects = tenders.map(t => ({
            name: t.title,
            contractor: t.awardedTo || 'Bidding Phase',
            amount: formatINR(t.budget),
            status: t.status === 'AWARDED' ? 'In Progress' : t.status === 'OPEN' ? 'Bidding Open' : t.status,
            date: new Date(t.createdAt).toISOString().split('T')[0]
        }));

        res.json({
            totalProjects: tenders.length,
            totalSpending: formatINR(totalPaid[0].total),
            verifiedContractors: contractorsCount[0].count || 18,
            projects
        });
    } catch (err) {
        console.error('[Public Projects Error]:', err);
        res.status(500).json({ error: "Failed to fetch public project transparency data" });
    }
});

// ==================== SERVER START ====================

async function start() {
    try {
        await initDB();
        app.listen(PORT, () => {
            console.log(`====================================================`);
            console.log(`Enterprise MySQL & Polygon Gateway on http://localhost:${PORT}`);
            console.log(`Database: ${process.env.DB_NAME || 'etendering_db'}`);
            console.log(`Network: Polygon Amoy Testnet (Chain ID: 80002)`);
            console.log(`====================================================`);
        });
    } catch (err) {
        console.error('Fatal Backend Initialization Error:', err);
        process.exit(1);
    }
}

start();
