/**
 * Cloudflare Pages Function - Ausgabenrechner API v1.3
 * 
 * Endpunkte:
 * - GET  /api/auth/salt?username=...       -> Liefert Client-Salt des Nutzers
 * - POST /api/auth/register               -> Registrierung mit Benutzername, optionaler E-Mail, authHash, Salt, Escrow-Key
 * - POST /api/auth/login                  -> Anmeldung mit Benutzername, authHash
 * - POST /api/auth/logout                 -> Abmeldung (Session löschen)
 * - GET  /api/auth/me                     -> Aktuellen Anmeldestatus abfragen
 * - POST /api/auth/forgot-password        -> Reset-Code für E-Mail / Benutzername anfordern
 * - POST /api/auth/verify-reset-code      -> Reset-Code prüfen
 * - POST /api/auth/reset-password         -> Neues Passwort mit Reset-Code setzen
 * - GET  /api/scenarios                   -> Liste aller Szenarien des Nutzers abrufen
 * - GET  /api/scenarios/active            -> Aktives Szenario (verschlüsselt) abrufen
 * - GET  /api/scenarios/:id               -> Bestimmtes Szenario (verschlüsselt) abrufen
 * - POST /api/scenarios                   -> Neues Szenario erstellen
 * - PUT  /api/scenarios/:id               -> Szenario-Daten speichern (verschlüsselt)
 * - PUT  /api/scenarios/:id/rename        -> Szenario umbenennen
 * - DELETE /api/scenarios/:id             -> Szenario löschen
 * - POST /api/scenarios/:id/activate      -> Szenario als aktiv markieren
 * - GET  /api/data                        -> Kompatibilität: Aktives Szenario abrufen
 * - POST /api/data                        -> Kompatibilität: Aktives Szenario speichern
 */

const SERVER_PEPPER = "ausgabenrechner-sec-pepper-v1";

// Helper: JSON Response mit CORS / Security Headers
function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers
        }
    });
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// Server Master Key für Escrow-Verschlüsselung
async function getServerSecretKey() {
    const keyData = new TextEncoder().encode(SERVER_PEPPER.padEnd(32, "0").slice(0, 32));
    return await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function serverEncryptEscrow(rawKeyHex) {
    if (!rawKeyHex) return null;
    const key = await getServerSecretKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(rawKeyHex);
    const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return `${arrayBufferToBase64(iv)}:${arrayBufferToBase64(enc)}`;
}

async function serverDecryptEscrow(escrowStr) {
    if (!escrowStr || !escrowStr.includes(":")) return null;
    try {
        const [ivB64, encB64] = escrowStr.split(":");
        const key = await getServerSecretKey();
        const iv = base64ToArrayBuffer(ivB64);
        const enc = base64ToArrayBuffer(encB64);
        const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, enc);
        return new TextDecoder().decode(dec);
    } catch (e) {
        console.error("Escrow Decryption Error:", e);
        return null;
    }
}

// Helper: SHA-256 Hash zu Hex
async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

// Server-Hash aus authHash und client_salt erzeugen
async function computeServerHash(authHash, clientSalt) {
    return await sha256Hex(`${authHash}:${clientSalt}:${SERVER_PEPPER}`);
}

// Session Token aus Cookie oder Authorization Header auslesen
function getSessionToken(request) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7).trim();
    }
    
    const cookieHeader = request.headers.get("Cookie");
    if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
    }
    return null;
}

// Nutzer anhand Session Token ermitteln
async function authenticateRequest(request, env) {
    const token = getSessionToken(request);
    if (!token) return null;

    const now = Date.now();
    const row = await env.DB.prepare(`
        SELECT u.id, u.username, u.email, u.active_scenario_id, s.expires_at 
        FROM sessions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.token = ? AND s.expires_at > ?
    `).bind(token, now).first();

    if (!row) return null;
    return { 
        id: row.id, 
        username: row.username, 
        email: row.email, 
        active_scenario_id: row.active_scenario_id, 
        token 
    };
}

// Stellt sicher, dass der Nutzer mindestens ein aktives Szenario hat
async function ensureActiveScenario(userId, env) {
    let user = await env.DB.prepare(`SELECT active_scenario_id FROM users WHERE id = ?`).bind(userId).first();
    
    // Prüfen, ob active_scenario existiert
    if (user && user.active_scenario_id) {
        const sc = await env.DB.prepare(`SELECT id FROM scenarios WHERE id = ? AND user_id = ?`)
            .bind(user.active_scenario_id, userId).first();
        if (sc) return user.active_scenario_id;
    }

    // Erstes Szenario suchen
    let firstSc = await env.DB.prepare(`SELECT id FROM scenarios WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`)
        .bind(userId).first();

    if (firstSc) {
        await env.DB.prepare(`UPDATE users SET active_scenario_id = ? WHERE id = ?`).bind(firstSc.id, userId).run();
        return firstSc.id;
    }

    // Prüfen, ob Legacy-Daten in user_data vorhanden sind
    const legacy = await env.DB.prepare(`SELECT encrypted_payload, iv FROM user_data WHERE user_id = ?`).bind(userId).first();
    const scId = crypto.randomUUID();
    const now = Date.now();
    const payload = legacy ? legacy.encrypted_payload : "";
    const iv = legacy ? legacy.iv : "";

    await env.DB.prepare(`
        INSERT INTO scenarios (id, user_id, name, encrypted_payload, iv, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(scId, userId, "Standard-Szenario", payload, iv, now, now).run();

    await env.DB.prepare(`UPDATE users SET active_scenario_id = ? WHERE id = ?`).bind(scId, userId).run();
    return scId;
}

// Main Request Handler
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // Trim trailing slash
    const method = request.method.toUpperCase();

    // CORS Preflight
    if (method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "86400"
            }
        });
    }

    if (!env.DB) {
        return jsonResponse({ 
            error: "Cloudflare D1-Datenbank nicht gebunden. Bitte 'DB' Binding in Cloudflare Pages konfigurieren." 
        }, 500);
    }

    try {
        // ==========================================
        // 1. AUTHENTIFIZIERUNG
        // ==========================================

        // --- GET /api/auth/salt?username=... ---
        if (path === "/api/auth/salt" && method === "GET") {
            const username = url.searchParams.get("username")?.trim();
            if (!username) return jsonResponse({ error: "Benutzername erforderlich." }, 400);

            const user = await env.DB.prepare(`
                SELECT client_salt FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
            `).bind(username, username).first();

            if (!user) {
                return jsonResponse({ error: "Benutzer existiert nicht." }, 404);
            }

            return jsonResponse({ salt: user.client_salt });
        }

        // --- POST /api/auth/register ---
        if (path === "/api/auth/register" && method === "POST") {
            const body = await request.json().catch(() => null);
            if (!body) return jsonResponse({ error: "Ungültiges JSON." }, 400);

            const { username, email, authHash, salt, encryptedVaultKey, vaultKeyIv, rawVaultKeyHex, initialData } = body;
            const cleanUsername = (username || "").trim();
            const cleanEmail = email ? email.trim().toLowerCase() : null;

            if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 30) {
                return jsonResponse({ error: "Benutzername muss zwischen 3 und 30 Zeichen lang sein." }, 400);
            }

            if (!/^[a-zA-Z0-9_-]+$/.test(cleanUsername)) {
                return jsonResponse({ error: "Benutzername darf nur Buchstaben, Zahlen, Bindestriche und Unterstriche enthalten." }, 400);
            }

            if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
                return jsonResponse({ error: "Ungültiges E-Mail-Format." }, 400);
            }

            if (!authHash || typeof authHash !== "string" || authHash.length !== 64) {
                return jsonResponse({ error: "Ungültiger Authentifizierungshash." }, 400);
            }

            if (!salt || typeof salt !== "string" || salt.length < 16) {
                return jsonResponse({ error: "Ungültiger Client-Salt." }, 400);
            }

            // Prüfen, ob Benutzername oder E-Mail vergeben ist
            const existingUser = await env.DB.prepare(`
                SELECT id FROM users WHERE username = ? COLLATE NOCASE
            `).bind(cleanUsername).first();

            if (existingUser) {
                return jsonResponse({ error: "Dieser Benutzername ist bereits vergeben." }, 409);
            }

            if (cleanEmail) {
                const existingEmail = await env.DB.prepare(`
                    SELECT id FROM users WHERE email = ? COLLATE NOCASE
                `).bind(cleanEmail).first();
                if (existingEmail) {
                    return jsonResponse({ error: "Diese E-Mail-Adresse wird bereits verwendet." }, 409);
                }
            }

            const userId = crypto.randomUUID();
            const serverHash = await computeServerHash(authHash, salt);
            const now = Date.now();
            const scenarioId = crypto.randomUUID();
            const escrowKey = await serverEncryptEscrow(rawVaultKeyHex);

            // Benutzer anlegen
            await env.DB.prepare(`
                INSERT INTO users (id, username, email, server_hash, client_salt, encrypted_vault_key, vault_key_iv, escrow_key, active_scenario_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(userId, cleanUsername, cleanEmail, serverHash, salt, encryptedVaultKey || null, vaultKeyIv || null, escrowKey, scenarioId, now).run();

            // Erstes Standard-Szenario anlegen
            const payload = initialData?.encrypted_payload || "";
            const iv = initialData?.iv || "";
            await env.DB.prepare(`
                INSERT INTO scenarios (id, user_id, name, encrypted_payload, iv, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(scenarioId, userId, "Standard-Szenario", payload, iv, now, now).run();

            // Session anlegen (30 Tage)
            const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
            const expiresAt = now + (30 * 24 * 60 * 60 * 1000);

            await env.DB.prepare(`
                INSERT INTO sessions (token, user_id, expires_at)
                VALUES (?, ?, ?)
            `).bind(token, userId, expiresAt).run();

            const isHttps = url.protocol === "https:";
            const cookieVal = `session=${token}; Path=/; Max-Age=2592000; SameSite=Lax${isHttps ? "; Secure" : ""}; HttpOnly`;

            return jsonResponse({
                success: true,
                user: { id: userId, username: cleanUsername, email: cleanEmail },
                token,
                active_scenario_id: scenarioId
            }, 201, { "Set-Cookie": cookieVal });
        }

        // --- POST /api/auth/login ---
        if (path === "/api/auth/login" && method === "POST") {
            const body = await request.json().catch(() => null);
            if (!body) return jsonResponse({ error: "Ungültiges JSON." }, 400);

            const { username, authHash } = body;
            const ident = (username || "").trim();

            if (!ident || !authHash) {
                return jsonResponse({ error: "Benutzername/E-Mail und Passwort erforderlich." }, 400);
            }

            const user = await env.DB.prepare(`
                SELECT id, username, email, server_hash, client_salt, encrypted_vault_key, vault_key_iv, escrow_key, active_scenario_id 
                FROM users 
                WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
            `).bind(ident, ident).first();

            if (!user) {
                return jsonResponse({ error: "Ungültiger Benutzername oder Passwort." }, 401);
            }

            const expectedHash = await computeServerHash(authHash, user.client_salt);
            if (expectedHash !== user.server_hash) {
                return jsonResponse({ error: "Ungültiger Benutzername oder Passwort." }, 401);
            }

            const now = Date.now();
            await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run();

            const activeScId = await ensureActiveScenario(user.id, env);

            const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
            const expiresAt = now + (30 * 24 * 60 * 60 * 1000);

            await env.DB.prepare(`
                INSERT INTO sessions (token, user_id, expires_at)
                VALUES (?, ?, ?)
            `).bind(token, user.id, expiresAt).run();

            const isHttps = url.protocol === "https:";
            const cookieVal = `session=${token}; Path=/; Max-Age=2592000; SameSite=Lax${isHttps ? "; Secure" : ""}; HttpOnly`;

            return jsonResponse({
                success: true,
                user: { id: user.id, username: user.username, email: user.email },
                token,
                encrypted_vault_key: user.encrypted_vault_key,
                vault_key_iv: user.vault_key_iv,
                active_scenario_id: activeScId
            }, 200, { "Set-Cookie": cookieVal });
        }

        // --- POST /api/auth/logout ---
        if (path === "/api/auth/logout" && method === "POST") {
            const token = getSessionToken(request);
            if (token) {
                await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
            }

            return jsonResponse({ success: true }, 200, {
                "Set-Cookie": "session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly"
            });
        }

        // --- GET /api/auth/me ---
        if (path === "/api/auth/me" && method === "GET") {
            const auth = await authenticateRequest(request, env);
            if (!auth) {
                return jsonResponse({ authenticated: false }, 200);
            }
            const activeScId = await ensureActiveScenario(auth.id, env);
            return jsonResponse({
                authenticated: true,
                user: { id: auth.id, username: auth.username, email: auth.email },
                active_scenario_id: activeScId
            });
        }

        // ==========================================
        // 2. PASSWORT-RESET PER E-MAIL
        // ==========================================

        // --- POST /api/auth/forgot-password ---
        if (path === "/api/auth/forgot-password" && method === "POST") {
            const body = await request.json().catch(() => null);
            const emailInput = body?.email?.trim().toLowerCase();

            if (!emailInput) {
                return jsonResponse({ error: "Bitte geben Sie Ihre E-Mail-Adresse ein." }, 400);
            }

            const user = await env.DB.prepare(`
                SELECT id, username, email FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE
            `).bind(emailInput, emailInput).first();

            // Falls Nutzer nicht existiert oder keine E-Mail hat
            if (!user || !user.email) {
                return jsonResponse({
                    success: true,
                    message: "Falls ein Konto mit dieser E-Mail existiert, wurde ein 6-stelliger Code generiert."
                });
            }

            // 6-stelligen Zahlencode generieren
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            const resetId = crypto.randomUUID();
            const now = Date.now();
            const expiresAt = now + (15 * 60 * 1000); // 15 Minuten gültig

            await env.DB.prepare(`
                INSERT INTO password_resets (id, user_id, email, code, expires_at, used, created_at)
                VALUES (?, ?, ?, ?, ?, 0, ?)
            `).bind(resetId, user.id, user.email, code, expiresAt, now).run();

            // In Cloudflare Logs vermerken
            console.log(`[PASSWORT-RESET] Code für ${user.email} (${user.username}): ${code}`);

            return jsonResponse({
                success: true,
                message: "Ein 6-stelliger Bestätigungscode wurde generiert.",
                // In Entwicklungsumgebung geben wir den Code zusätzlich direkt zurück zur sofortigen Eingabe
                debug_code: code
            });
        }

        // --- POST /api/auth/verify-reset-code ---
        if (path === "/api/auth/verify-reset-code" && method === "POST") {
            const body = await request.json().catch(() => null);
            const { email, code } = body || {};
            const cleanEmail = (email || "").trim().toLowerCase();
            const cleanCode = (code || "").trim();

            if (!cleanEmail || !cleanCode) {
                return jsonResponse({ error: "E-Mail und Code erforderlich." }, 400);
            }

            const now = Date.now();
            const reset = await env.DB.prepare(`
                SELECT r.id, r.user_id, u.client_salt, u.escrow_key, u.username 
                FROM password_resets r
                JOIN users u ON r.user_id = u.id
                WHERE r.email = ? COLLATE NOCASE AND r.code = ? AND r.used = 0 AND r.expires_at > ?
            `).bind(cleanEmail, cleanCode, now).first();

            if (!reset) {
                return jsonResponse({ error: "Ungültiger oder abgelaufener Reset-Code." }, 400);
            }

            const rawVaultKeyHex = await serverDecryptEscrow(reset.escrow_key);

            return jsonResponse({
                valid: true,
                username: reset.username,
                salt: reset.client_salt,
                raw_vault_key_hex: rawVaultKeyHex
            });
        }

        // --- POST /api/auth/reset-password ---
        if (path === "/api/auth/reset-password" && method === "POST") {
            const body = await request.json().catch(() => null);
            const { email, code, newAuthHash, newSalt, newEncryptedVaultKey, newVaultKeyIv } = body || {};
            const cleanEmail = (email || "").trim().toLowerCase();
            const cleanCode = (code || "").trim();

            if (!cleanEmail || !cleanCode || !newAuthHash || !newSalt) {
                return jsonResponse({ error: "Fehlende Angaben zur Passwortänderung." }, 400);
            }

            const now = Date.now();
            const reset = await env.DB.prepare(`
                SELECT r.id, r.user_id, u.username 
                FROM password_resets r
                JOIN users u ON r.user_id = u.id
                WHERE r.email = ? COLLATE NOCASE AND r.code = ? AND r.used = 0 AND r.expires_at > ?
            `).bind(cleanEmail, cleanCode, now).first();

            if (!reset) {
                return jsonResponse({ error: "Ungültiger oder abgelaufener Reset-Code." }, 400);
            }

            const newServerHash = await computeServerHash(newAuthHash, newSalt);

            // Passwort und neuen VaultKey-Wrap aktualisieren
            await env.DB.prepare(`
                UPDATE users 
                SET server_hash = ?, client_salt = ?, encrypted_vault_key = coalesce(?, encrypted_vault_key), vault_key_iv = coalesce(?, vault_key_iv) 
                WHERE id = ?
            `).bind(newServerHash, newSalt, newEncryptedVaultKey || null, newVaultKeyIv || null, reset.user_id).run();

            // Reset-Code entwerten & alte Sessions ungültig machen
            await env.DB.prepare(`UPDATE password_resets SET used = 1 WHERE id = ?`).bind(reset.id).run();
            await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(reset.user_id).run();

            // Neue Session anmelden
            const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
            const expiresAt = now + (30 * 24 * 60 * 60 * 1000);

            await env.DB.prepare(`
                INSERT INTO sessions (token, user_id, expires_at)
                VALUES (?, ?, ?)
            `).bind(token, reset.user_id, expiresAt).run();

            const isHttps = url.protocol === "https:";
            const cookieVal = `session=${token}; Path=/; Max-Age=2592000; SameSite=Lax${isHttps ? "; Secure" : ""}; HttpOnly`;

            return jsonResponse({
                success: true,
                message: "Passwort erfolgreich zurückgesetzt.",
                token,
                user: { id: reset.user_id, username: reset.username, email: cleanEmail }
            }, 200, { "Set-Cookie": cookieVal });
        }

        // ==========================================
        // 3. SZENARIEN-VERWALTUNG
        // ==========================================

        // --- GET /api/scenarios (Alle Szenarien auflisten) ---
        if (path === "/api/scenarios" && method === "GET") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const activeScId = await ensureActiveScenario(auth.id, env);

            const rows = await env.DB.prepare(`
                SELECT id, name, created_at, updated_at 
                FROM scenarios 
                WHERE user_id = ? 
                ORDER BY created_at ASC
            `).bind(auth.id).all();

            return jsonResponse({
                scenarios: rows.results || [],
                active_scenario_id: activeScId
            });
        }

        // --- GET /api/scenarios/active (Aktives Szenario laden) ---
        if (path === "/api/scenarios/active" && method === "GET") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const activeScId = await ensureActiveScenario(auth.id, env);
            const sc = await env.DB.prepare(`
                SELECT id, name, encrypted_payload, iv, updated_at 
                FROM scenarios 
                WHERE id = ? AND user_id = ?
            `).bind(activeScId, auth.id).first();

            return jsonResponse(sc || { id: activeScId, name: "Standard-Szenario", encrypted_payload: "", iv: "", updated_at: Date.now() });
        }

        // --- POST /api/scenarios (Neues Szenario erstellen) ---
        if (path === "/api/scenarios" && method === "POST") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const body = await request.json().catch(() => null);
            const name = (body?.name || "").trim();
            const encrypted_payload = body?.encrypted_payload || "";
            const iv = body?.iv || "";

            if (!name) return jsonResponse({ error: "Szenarioname erforderlich." }, 400);

            const scId = crypto.randomUUID();
            const now = Date.now();

            await env.DB.prepare(`
                INSERT INTO scenarios (id, user_id, name, encrypted_payload, iv, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(scId, auth.id, name, encrypted_payload, iv, now, now).run();

            // Als aktives Szenario setzen
            await env.DB.prepare(`UPDATE users SET active_scenario_id = ? WHERE id = ?`).bind(scId, auth.id).run();

            return jsonResponse({
                success: true,
                scenario: { id: scId, name, updated_at: now },
                active_scenario_id: scId
            }, 201);
        }

        // --- PUT /api/scenarios/:id (Szenariodaten speichern) ---
        const scSaveMatch = path.match(/^\/api\/scenarios\/([a-zA-Z0-9_-]+)$/);
        if (scSaveMatch && method === "PUT") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const scId = scSaveMatch[1];
            const body = await request.json().catch(() => null);
            const { encrypted_payload, iv, name } = body || {};

            if (!encrypted_payload || !iv) {
                return jsonResponse({ error: "Verschlüsselte Daten und IV erforderlich." }, 400);
            }

            const now = Date.now();
            let res;
            if (name) {
                res = await env.DB.prepare(`
                    UPDATE scenarios 
                    SET encrypted_payload = ?, iv = ?, name = ?, updated_at = ? 
                    WHERE id = ? AND user_id = ?
                `).bind(encrypted_payload, iv, name.trim(), now, scId, auth.id).run();
            } else {
                res = await env.DB.prepare(`
                    UPDATE scenarios 
                    SET encrypted_payload = ?, iv = ?, updated_at = ? 
                    WHERE id = ? AND user_id = ?
                `).bind(encrypted_payload, iv, now, scId, auth.id).run();
            }

            if (!res.meta?.changes && res.changes === 0) {
                return jsonResponse({ error: "Szenario nicht gefunden." }, 404);
            }

            return jsonResponse({ success: true, updated_at: now });
        }

        // --- PUT /api/scenarios/:id/rename (Szenario umbenennen) ---
        const scRenameMatch = path.match(/^\/api\/scenarios\/([a-zA-Z0-9_-]+)\/rename$/);
        if (scRenameMatch && method === "PUT") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const scId = scRenameMatch[1];
            const body = await request.json().catch(() => null);
            const newName = (body?.name || "").trim();

            if (!newName) return jsonResponse({ error: "Neuer Name erforderlich." }, 400);

            const now = Date.now();
            const res = await env.DB.prepare(`
                UPDATE scenarios SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?
            `).bind(newName, now, scId, auth.id).run();

            return jsonResponse({ success: true, name: newName, updated_at: now });
        }

        // --- DELETE /api/scenarios/:id (Szenario löschen) ---
        const scDeleteMatch = path.match(/^\/api\/scenarios\/([a-zA-Z0-9_-]+)$/);
        if (scDeleteMatch && method === "DELETE") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const scId = scDeleteMatch[1];

            // Prüfen, wie viele Szenarien der Nutzer hat
            const countRow = await env.DB.prepare(`SELECT count(*) as count FROM scenarios WHERE user_id = ?`).bind(auth.id).first();
            if (countRow && countRow.count <= 1) {
                return jsonResponse({ error: "Das einzige Szenario kann nicht gelöscht werden." }, 400);
            }

            await env.DB.prepare(`DELETE FROM scenarios WHERE id = ? AND user_id = ?`).bind(scId, auth.id).run();

            // Falls das gelöschte Szenario aktiv war, ein anderes aktivieren
            let newActiveId = auth.active_scenario_id;
            if (auth.active_scenario_id === scId) {
                const nextSc = await env.DB.prepare(`SELECT id FROM scenarios WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`).bind(auth.id).first();
                newActiveId = nextSc ? nextSc.id : null;
                if (newActiveId) {
                    await env.DB.prepare(`UPDATE users SET active_scenario_id = ? WHERE id = ?`).bind(newActiveId, auth.id).run();
                }
            }

            return jsonResponse({ success: true, active_scenario_id: newActiveId });
        }

        // --- POST /api/scenarios/:id/activate (Szenario aktivieren) ---
        const scActivateMatch = path.match(/^\/api\/scenarios\/([a-zA-Z0-9_-]+)\/activate$/);
        if (scActivateMatch && method === "POST") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const scId = scActivateMatch[1];
            const sc = await env.DB.prepare(`SELECT id FROM scenarios WHERE id = ? AND user_id = ?`).bind(scId, auth.id).first();
            if (!sc) return jsonResponse({ error: "Szenario nicht gefunden." }, 404);

            await env.DB.prepare(`UPDATE users SET active_scenario_id = ? WHERE id = ?`).bind(scId, auth.id).run();
            return jsonResponse({ success: true, active_scenario_id: scId });
        }

        // --- GET /api/scenarios/:id (Einzelnes Szenario laden) ---
        const scGetMatch = path.match(/^\/api\/scenarios\/([a-zA-Z0-9_-]+)$/);
        if (scGetMatch && method === "GET") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const scId = scGetMatch[1];
            const sc = await env.DB.prepare(`
                SELECT id, name, encrypted_payload, iv, updated_at 
                FROM scenarios 
                WHERE id = ? AND user_id = ?
            `).bind(scId, auth.id).first();

            if (!sc) return jsonResponse({ error: "Szenario nicht gefunden." }, 404);
            return jsonResponse(sc);
        }

        // ==========================================
        // 4. LEGACY /api/data ENDPUNKTE (Abwärtskompatibilität)
        // ==========================================
        if (path === "/api/data" && method === "GET") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const activeScId = await ensureActiveScenario(auth.id, env);
            const sc = await env.DB.prepare(`
                SELECT encrypted_payload, iv, updated_at FROM scenarios WHERE id = ?
            `).bind(activeScId).first();

            return jsonResponse({
                encrypted_payload: sc?.encrypted_payload || null,
                iv: sc?.iv || null,
                updated_at: sc?.updated_at || null
            });
        }

        if (path === "/api/data" && method === "POST") {
            const auth = await authenticateRequest(request, env);
            if (!auth) return jsonResponse({ error: "Nicht authentifiziert." }, 401);

            const body = await request.json().catch(() => null);
            if (!body?.encrypted_payload || !body?.iv) {
                return jsonResponse({ error: "Fehlende verschlüsselte Daten oder IV." }, 400);
            }

            const activeScId = await ensureActiveScenario(auth.id, env);
            const now = Date.now();

            await env.DB.prepare(`
                UPDATE scenarios 
                SET encrypted_payload = ?, iv = ?, updated_at = ? 
                WHERE id = ? AND user_id = ?
            `).bind(body.encrypted_payload, body.iv, now, activeScId, auth.id).run();

            return jsonResponse({ success: true, updated_at: now });
        }

        return jsonResponse({ error: `Endpunkt ${method} ${path} nicht gefunden.` }, 404);

    } catch (err) {
        console.error("API Error:", err);
        return jsonResponse({ error: "Interner Serverfehler: " + err.message }, 500);
    }
}
