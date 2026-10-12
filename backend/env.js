require('dotenv').config();

// Fail fast: a missing/empty secret must stop the process, never fall back to a default.
function requireEnv(name) {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
        throw new Error(`Missing required environment variable: ${name} (see backend/.env.example)`);
    }
    return value;
}

module.exports = { requireEnv };
