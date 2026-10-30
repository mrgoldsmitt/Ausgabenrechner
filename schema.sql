-- D1 Database Schema für Ausgabenrechner v1.3
-- Unterstützt:
-- 1. Benutzerverwaltung mit optionaler E-Mail-Adresse und Passwort-Reset
-- 2. Beliebig viele benannte Szenarien pro Benutzer
-- 3. Ende-zu-Ende AES-256-GCM Verschlüsselung aller Finanzdaten in jedem Szenario

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    email TEXT COLLATE NOCASE,
    server_hash TEXT NOT NULL,
    client_salt TEXT NOT NULL,
    encrypted_vault_key TEXT,
    vault_key_iv TEXT,
    escrow_key TEXT,
    active_scenario_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Szenarien-Tabelle: Jeder Benutzer kann mehrere benannte Ausgabenszenarien anlegen
CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Passwort-Reset-Tokens / 6-stellige Codes
CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Legacy-Tabelle (für Migration älterer Versionen)
CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY,
    encrypted_payload TEXT NOT NULL,
    iv TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_scenarios_user ON scenarios(user_id);
CREATE INDEX IF NOT EXISTS idx_resets_code ON password_resets(code, email);
