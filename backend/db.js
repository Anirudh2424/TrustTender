const { requireEnv } = require('./env');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_CONFIG = {
    host: requireEnv('DB_HOST'),
    port: parseInt(requireEnv('DB_PORT'), 10),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
};

const DB_NAME = requireEnv('DB_NAME');

let pool = null;

async function initDB() {
    // 1. Create database if it doesn't exist
    const rootConn = await mysql.createConnection(DB_CONFIG);
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
    await rootConn.end();

    // 2. Initialize connection pool
    pool = mysql.createPool({
        ...DB_CONFIG,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        decimalNumbers: true
    });

    console.log(`[Database] Connected to MySQL: ${DB_NAME}`);

    // 3. Create tables
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            userId VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            role ENUM('issuer', 'bidder', 'auditor') NOT NULL,
            walletId VARCHAR(255),
            orgName VARCHAR(50) DEFAULT 'Org1',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tenders (
            tenderId VARCHAR(100) PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            budget DECIMAL(15, 2) NOT NULL,
            deadline BIGINT NOT NULL,
            createdBy VARCHAR(100) NOT NULL,
            status VARCHAR(50) DEFAULT 'OPEN',
            awardedTo VARCHAR(100) DEFAULT NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bids (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenderId VARCHAR(100) NOT NULL,
            contractorId VARCHAR(100) NOT NULL,
            bidAmount DECIMAL(15, 2) NOT NULL,
            hash VARCHAR(128) NOT NULL,
            salt VARCHAR(255) DEFAULT NULL,
            status ENUM('SUBMITTED', 'PENDING_ANCHOR', 'REVEALED', 'WINNER', 'OUTBID') DEFAULT 'SUBMITTED',
            polygonTxHash VARCHAR(128) NULL,
            polygonBlock BIGINT NULL,
            submittedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            revealedAt TIMESTAMP NULL,
            UNIQUE KEY unique_tender_contractor (tenderId, contractorId),
            CONSTRAINT fk_bid_tender FOREIGN KEY (tenderId) REFERENCES tenders(tenderId) ON DELETE CASCADE
        ) ENGINE=InnoDB;
    `);

    // Ensure polygon columns exist if table was previously created
    try {
        await pool.query('ALTER TABLE bids ADD COLUMN polygonTxHash VARCHAR(66) NULL;');
    } catch(e) {}
    try {
        await pool.query('ALTER TABLE bids ADD COLUMN polygonBlock BIGINT NULL;');
    } catch(e) {}
    // Allow bids whose Polygon anchoring failed to be stored without a tx hash (idempotent)
    await pool.query(
        "ALTER TABLE bids MODIFY COLUMN status ENUM('SUBMITTED', 'PENDING_ANCHOR', 'REVEALED', 'WINNER', 'OUTBID') DEFAULT 'SUBMITTED'"
    );

    await pool.query(`
        CREATE TABLE IF NOT EXISTS milestones (
            milestoneId VARCHAR(100) PRIMARY KEY,
            tenderId VARCHAR(100) NOT NULL,
            description VARCHAR(255) NOT NULL,
            amount DECIMAL(15, 2) NOT NULL,
            status ENUM('PENDING', 'VERIFIED', 'PAID') DEFAULT 'PENDING',
            verifiedBy VARCHAR(100) DEFAULT NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            verifiedAt TIMESTAMP NULL,
            paidAt TIMESTAMP NULL,
            CONSTRAINT fk_ms_tender FOREIGN KEY (tenderId) REFERENCES tenders(tenderId) ON DELETE CASCADE
        ) ENGINE=InnoDB;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            txId VARCHAR(64) NOT NULL,
            action VARCHAR(100) NOT NULL,
            performedBy VARCHAR(100) NOT NULL,
            ledgerRef VARCHAR(66) NOT NULL,
            status VARCHAR(50) DEFAULT 'Verified',
            details JSON NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB;
    `);

    // Migration: audit_logs.txHash held simulated hashes; rename to ledgerRef and drop the 0x look-alike format
    const [oldCol] = await pool.query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'txHash'",
        [DB_NAME]
    );
    if (oldCol.length > 0) {
        await pool.query('ALTER TABLE audit_logs CHANGE COLUMN txHash ledgerRef VARCHAR(66) NOT NULL');
        await pool.query("UPDATE audit_logs SET ledgerRef = CONCAT('LR-', SUBSTRING(ledgerRef, 3, 40)) WHERE ledgerRef LIKE '0x%'");
    }

    // 4. Seed/Reset Indian Tenders & Users
    await resetAndSeedIndianTenders();
}

async function resetAndSeedIndianTenders() {
    // 1. Ensure users exist
    const [users] = await pool.query('SELECT COUNT(*) as count FROM users');
    if (users[0].count === 0) {
        console.log('[Database] Seeding standard demo users...');
        const hashedPassword = await bcrypt.hash('password123', 10);

        const defaultUsers = [
            ['issuer1', hashedPassword, 'issuer', '0x4427b3112a912e56cf98811d', 'Org1'],
            ['contractor1', hashedPassword, 'bidder', '0x12b8491c33f25c7e909a8821', 'Org2'],
            ['contractor2', hashedPassword, 'bidder', '0x77c2890df910e11899cd4432', 'Org2'],
            ['auditor1', hashedPassword, 'auditor', '0x98d411ae44b821437612ee49', 'Org1'],
        ];

        for (const user of defaultUsers) {
            await pool.query(
                `INSERT INTO users (userId, password, role, walletId, orgName) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE role = VALUES(role)`,
                user
            );
        }
    }

    // 2. Clear old obsolete test tenders if any exist
    await pool.query(`DELETE FROM tenders WHERE tenderId LIKE 'T-100%' OR tenderId LIKE 'T-TEST%' OR tenderId LIKE 'T-69%'`);

    // 3. Check if new Indian tenders exist; if not, seed them
    const [existingTenders] = await pool.query("SELECT COUNT(*) as count FROM tenders WHERE tenderId = 'T-NHAI-2026'");
    if (existingTenders[0].count === 0) {
        console.log('[Database] Seeding fresh Indian Public E-Tenders in INR (₹)...');
        const now = Date.now();
        const futureDeadline1 = now + 14 * 24 * 60 * 60 * 1000;
        const futureDeadline2 = now + 21 * 24 * 60 * 60 * 1000;
        const futureDeadline3 = now + 30 * 24 * 60 * 60 * 1000;
        const pastDeadline = now - 3 * 24 * 60 * 60 * 1000;

        // Tender 1: NHAI Smart Highway Toll (₹45 Crore) - OPEN
        await pool.query(
            `INSERT INTO tenders (tenderId, title, budget, deadline, createdBy, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['T-NHAI-2026', 'NHAI Expressway Smart Toll & AI Surveillance', 450000000.00, futureDeadline1, 'NHAI_HQ', 'OPEN']
        );

        // Tender 2: Mumbai Metro Line 4 (₹28.5 Crore) - AWARDED to contractor1
        await pool.query(
            `INSERT INTO tenders (tenderId, title, budget, deadline, createdBy, status, awardedTo) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['T-METRO-04', 'Mumbai Metro Line 4 Automated Signaling Network', 285000000.00, pastDeadline, 'MMRDA_Transit', 'AWARDED', 'contractor1']
        );

        // Milestones for Mumbai Metro Line 4 (₹28.5 Cr split into 3 phases: 9.5 Cr each)
        await pool.query(
            `INSERT INTO milestones (milestoneId, tenderId, description, amount, status, verifiedBy, paidAt) VALUES 
             ('T-METRO-04-M1', 'T-METRO-04', 'Phase 1: Fiber Optic Backbone & Cable Laying', 95000000.00, 'PAID', 'auditor1', NOW()),
             ('T-METRO-04-M2', 'T-METRO-04', 'Phase 2: CBTC Signaling & Control Towers', 95000000.00, 'VERIFIED', 'auditor1', NULL),
             ('T-METRO-04-M3', 'T-METRO-04', 'Phase 3: Integration & Safety Certification', 95000000.00, 'PENDING', NULL, NULL)
             ON DUPLICATE KEY UPDATE description = VALUES(description)`
        );

        // Tender 3: PM-KUSUM Solar Microgrid (₹12 Crore) - OPEN
        await pool.query(
            `INSERT INTO tenders (tenderId, title, budget, deadline, createdBy, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['T-SOLAR-09', 'PM-KUSUM Rural Solar Microgrid Installation (150 MW)', 120000000.00, futureDeadline2, 'Ministry_Renewable_Energy', 'OPEN']
        );

        // Tender 4: Digital Health Registry (₹6.5 Crore) - OPEN
        await pool.query(
            `INSERT INTO tenders (tenderId, title, budget, deadline, createdBy, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['T-DIGI-55', 'Digital Health Registry & Decentralized EHR System', 65000000.00, futureDeadline3, 'National_Health_Authority', 'OPEN']
        );

        // Seed initial Polygon audit logs
        const initialLogs = [
            ['TX-9101', 'Tender Creation', 'NHAI_HQ', 'LR-9101' + crypto.randomBytes(14).toString('hex'), 'Verified', JSON.stringify({ tenderId: 'T-NHAI-2026', budget: '₹45 Crore' })],
            ['TX-9102', 'Tender Creation', 'MMRDA_Transit', 'LR-9102' + crypto.randomBytes(14).toString('hex'), 'Verified', JSON.stringify({ tenderId: 'T-METRO-04', budget: '₹28.5 Crore' })],
            ['TX-9103', 'Polygon Bid Sealed', 'contractor1', 'LR-9103' + crypto.randomBytes(14).toString('hex'), 'Verified', JSON.stringify({ tenderId: 'T-METRO-04', network: 'Polygon Amoy' })],
            ['TX-9104', 'Winner Selection', 'MMRDA_Transit', 'LR-9104' + crypto.randomBytes(14).toString('hex'), 'Verified', JSON.stringify({ tenderId: 'T-METRO-04', winner: 'contractor1' })],
            ['TX-9105', 'Milestone Verified', 'auditor1', 'LR-9105' + crypto.randomBytes(14).toString('hex'), 'Verified', JSON.stringify({ milestoneId: 'T-METRO-04-M1', status: 'VERIFIED' })],
            ['TX-9106', 'Payment Released', 'MMRDA_Transit', 'LR-9106' + crypto.randomBytes(14).toString('hex'), 'Verified', JSON.stringify({ milestoneId: 'T-METRO-04-M1', amount: '₹9.5 Crore' })],
        ];

        for (const log of initialLogs) {
            await pool.query(
                `INSERT INTO audit_logs (txId, action, performedBy, ledgerRef, status, details) VALUES (?, ?, ?, ?, ?, ?)`,
                log
            );
        }

        console.log('[Database] Indian Public E-Tenders & Polygon audit records seeded successfully.');
    }
}

function getPool() {
    if (!pool) {
        throw new Error('Database not initialized. Call initDB() first.');
    }
    return pool;
}

module.exports = {
    initDB,
    getPool
};
