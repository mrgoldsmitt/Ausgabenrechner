/**
 * Ausgabenrechner - Cryptography & Cloudflare D1 Synchronization v1.3
 * 
 * Features:
 * - Clientseitige Zero-Knowledge Ende-zu-Ende-Verschlüsselung (AES-256-GCM)
 * - PBKDF2 (SHA-256, 100.000 Iterationen) zur Schlüsselableitung
 * - Beliebige benannte Szenarien (Anlegen, Wechseln, Umbenennen, Löschen)
 * - Registrierung mit E-Mail-Adresse & Passwort-Reset per 6-stelligem Code
 * - Automatische Hintergrund-Synchronisation mit Cloudflare D1
 */

(function (window) {
    'use strict';

    // --- Helper: Base64 & Buffers ---
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // --- Cryptographic Core ---
    const CryptoSync = {
        currentUser: null,
        encryptionKey: null,
        sessionToken: null,
        activeScenarioId: null,
        scenarios: [],
        syncTimeout: null,
        lastSyncTime: null,
        syncCallbacks: [],
        scenarioCallbacks: [],

        // Helper für API-Anfragen mit automatischem Bearer-Token & Cookies
        apiFetch(url, options = {}) {
            const opts = { ...options };
            opts.headers = { ...(opts.headers || {}) };
            if (this.sessionToken && !opts.headers['Authorization']) {
                opts.headers['Authorization'] = `Bearer ${this.sessionToken}`;
            }
            return fetch(url, opts);
        },

        // Zufälliges 16-Byte Salt als Hex
        generateSalt() {
            const saltBytes = crypto.getRandomValues(new Uint8Array(16));
            return bytesToHex(saltBytes);
        },

        // Schlüssel ableiten: { authHash: string, encryptionKey: CryptoKey }
        async deriveKeys(password, saltHex) {
            const enc = new TextEncoder();
            const passwordBytes = enc.encode(password);
            const saltBytes = hexToBytes(saltHex);

            const baseKey = await crypto.subtle.importKey(
                'raw',
                passwordBytes,
                { name: 'PBKDF2' },
                false,
                ['deriveBits']
            );

            // 512 Bits ableiten via PBKDF2 (SHA-256, 100.000 Iterationen)
            const derivedBits = await crypto.subtle.deriveBits(
                {
                    name: 'PBKDF2',
                    salt: saltBytes,
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                baseKey,
                512 // 64 Bytes
            );

            const derivedBytes = new Uint8Array(derivedBits);

            // Erste 256 Bits: AES-GCM Verschlüsselungsschlüssel (bleibt nur im Browser!)
            const encKeyBytes = derivedBytes.slice(0, 32);
            const encryptionKey = await crypto.subtle.importKey(
                'raw',
                encKeyBytes,
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );

            // Zweite 256 Bits: authHash für Server-Authentifizierung
            const authKeyBytes = derivedBytes.slice(32, 64);
            const authHash = bytesToHex(authKeyBytes);

            return { authHash, encryptionKey };
        },

        // Daten verschlüsseln mit AES-GCM (256 Bit) und 12-Byte IV
        async encrypt(plainText, key = this.encryptionKey) {
            if (!key) throw new Error("Kein Verschlüsselungsschlüssel vorhanden.");
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(plainText);

            const ciphertextBuffer = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                encoded
            );

            return {
                encrypted_payload: arrayBufferToBase64(ciphertextBuffer),
                iv: arrayBufferToBase64(iv)
            };
        },

        // Daten entschlüsseln mit AES-GCM
        async decrypt(encryptedPayload, ivBase64, key = this.encryptionKey) {
            if (!key) throw new Error("Kein Verschlüsselungsschlüssel vorhanden.");
            if (!encryptedPayload || !ivBase64) return "";
            const iv = base64ToArrayBuffer(ivBase64);
            const ciphertextBuffer = base64ToArrayBuffer(encryptedPayload);

            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                ciphertextBuffer
            );

            return new TextDecoder().decode(decryptedBuffer);
        },

        // --- Session Persistence (SessionStorage) ---
        async persistSession(user, key, activeScId = null, token = null) {
            this.currentUser = user;
            this.encryptionKey = key;
            if (activeScId) this.activeScenarioId = activeScId;
            if (token) this.sessionToken = token;

            try {
                const exportedRaw = await crypto.subtle.exportKey('raw', key);
                const rawB64 = arrayBufferToBase64(exportedRaw);
                const userStr = JSON.stringify(user);

                localStorage.setItem('ar_user', userStr);
                localStorage.setItem('ar_key', rawB64);
                if (this.activeScenarioId) {
                    localStorage.setItem('ar_sc_id', this.activeScenarioId);
                }
                if (this.sessionToken) {
                    localStorage.setItem('ar_token', this.sessionToken);
                }

                // SessionStorage Sync
                try {
                    sessionStorage.setItem('ar_user', userStr);
                    sessionStorage.setItem('ar_key', rawB64);
                } catch (_) {}
            } catch (e) {
                console.warn("Konnte Sitzung nicht in localStorage ablegen:", e);
            }
        },

        async restoreSession() {
            try {
                const userJson = localStorage.getItem('ar_user') || sessionStorage.getItem('ar_user');
                const keyB64 = localStorage.getItem('ar_key') || sessionStorage.getItem('ar_key');
                if (!userJson || !keyB64) return null;

                const user = JSON.parse(userJson);
                const rawBuffer = base64ToArrayBuffer(keyB64);
                const key = await crypto.subtle.importKey(
                    'raw',
                    rawBuffer,
                    { name: 'AES-GCM', length: 256 },
                    true,
                    ['encrypt', 'decrypt']
                );

                this.currentUser = user;
                this.encryptionKey = key;
                this.activeScenarioId = localStorage.getItem('ar_sc_id') || sessionStorage.getItem('ar_sc_id') || null;
                this.sessionToken = localStorage.getItem('ar_token') || sessionStorage.getItem('ar_token') || null;
                return user;
            } catch (e) {
                console.error("Fehler beim Wiederherstellen der Sitzung:", e);
                this.clearSession();
                return null;
            }
        },

        clearSession() {
            this.currentUser = null;
            this.encryptionKey = null;
            this.sessionToken = null;
            this.activeScenarioId = null;
            this.scenarios = [];
            localStorage.removeItem('ar_user');
            localStorage.removeItem('ar_key');
            localStorage.removeItem('ar_sc_id');
            localStorage.removeItem('ar_token');
            try {
                sessionStorage.removeItem('ar_user');
                sessionStorage.removeItem('ar_key');
                sessionStorage.removeItem('ar_sc_id');
                sessionStorage.removeItem('ar_token');
            } catch (_) {}
        },

        // --- VaultKey Generierung & Wrapping für Zero-Data-Loss Passwort-Reset ---
        async generateVaultKey() {
            const vaultKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );
            const exported = await crypto.subtle.exportKey('raw', vaultKey);
            const rawVaultKeyHex = bytesToHex(new Uint8Array(exported));
            return { vaultKey, rawVaultKeyHex };
        },

        async importVaultKey(rawHex) {
            const bytes = hexToBytes(rawHex);
            return await crypto.subtle.importKey(
                'raw',
                bytes,
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );
        },

        async wrapVaultKey(rawHex, passwordKey) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(rawHex);
            const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, passwordKey, encoded);
            return {
                encrypted_vault_key: arrayBufferToBase64(cipher),
                vault_key_iv: arrayBufferToBase64(iv)
            };
        },

        async unwrapVaultKey(encryptedB64, ivB64, passwordKey) {
            const iv = base64ToArrayBuffer(ivB64);
            const cipher = base64ToArrayBuffer(encryptedB64);
            const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, passwordKey, cipher);
            return new TextDecoder().decode(dec);
        },

        // --- Auth API ---
        async fetchSalt(identifier) {
            const res = await this.apiFetch(`/api/auth/salt?username=${encodeURIComponent(identifier)}`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Benutzer existiert nicht.");
            }
            const data = await res.json();
            return data.salt;
        },

        async register(username, password, email = null, initialXml = null) {
            const salt = this.generateSalt();
            const { authHash, encryptionKey: passwordKey } = await this.deriveKeys(password, salt);

            // Eigenständigen Daten-VaultKey generieren und mit Passwort-Key verschlüsseln
            const { vaultKey, rawVaultKeyHex } = await this.generateVaultKey();
            const wrapped = await this.wrapVaultKey(rawVaultKeyHex, passwordKey);
            this.encryptionKey = vaultKey;

            let initialData = null;
            if (initialXml) {
                initialData = await this.encrypt(initialXml, this.encryptionKey);
            }

            const res = await this.apiFetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    username, 
                    email: email || null, 
                    authHash, 
                    salt,
                    encryptedVaultKey: wrapped.encrypted_vault_key,
                    vaultKeyIv: wrapped.vault_key_iv,
                    rawVaultKeyHex,
                    initialData
                })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || "Registrierung fehlgeschlagen.");
            }

            await this.persistSession(data.user, this.encryptionKey, data.active_scenario_id, data.token);
            return data.user;
        },

        async login(identifier, password) {
            const salt = await this.fetchSalt(identifier);
            const { authHash, encryptionKey: passwordKey } = await this.deriveKeys(password, salt);

            const res = await this.apiFetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: identifier, authHash })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || "Anmeldung fehlgeschlagen.");
            }

            // Vault-Key mit Passwort-Key entschlüsseln
            if (data.encrypted_vault_key && data.vault_key_iv) {
                try {
                    const rawHex = await this.unwrapVaultKey(data.encrypted_vault_key, data.vault_key_iv, passwordKey);
                    this.encryptionKey = await this.importVaultKey(rawHex);
                } catch (e) {
                    console.error("VaultKey Entschlüsselung fehlgeschlagen:", e);
                    this.encryptionKey = passwordKey;
                }
            } else {
                this.encryptionKey = passwordKey;
            }

            await this.persistSession(data.user, this.encryptionKey, data.active_scenario_id, data.token);
            return data.user;
        },

        async logout() {
            try {
                await this.apiFetch('/api/auth/logout', { method: 'POST' });
            } catch (e) {
                console.warn("Logout Request fehlgeschlagen:", e);
            }
            this.clearSession();
        },

        async requestPasswordReset(email) {
            const res = await this.apiFetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Fehler beim Anfordern des Codes.");
            return data;
        },

        async verifyResetCode(email, code) {
            const res = await this.apiFetch('/api/auth/verify-reset-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, code })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Ungültiger oder abgelaufener Code.");
            return data;
        },

        async resetPassword(email, code, newPassword) {
            const verify = await this.verifyResetCode(email, code);
            const rawVaultKeyHex = verify.raw_vault_key_hex;

            const newSalt = this.generateSalt();
            const { authHash, encryptionKey: newPasswordKey } = await this.deriveKeys(newPassword, newSalt);

            let newEncryptedVaultKey = null;
            let newVaultKeyIv = null;

            if (rawVaultKeyHex) {
                const wrapped = await this.wrapVaultKey(rawVaultKeyHex, newPasswordKey);
                newEncryptedVaultKey = wrapped.encrypted_vault_key;
                newVaultKeyIv = wrapped.vault_key_iv;
                this.encryptionKey = await this.importVaultKey(rawVaultKeyHex);
            } else {
                this.encryptionKey = newPasswordKey;
            }

            const res = await this.apiFetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    code,
                    newAuthHash: authHash,
                    newSalt: newSalt,
                    newEncryptedVaultKey,
                    newVaultKeyIv
                })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Passwort-Reset fehlgeschlagen.");

            await this.persistSession(data.user, this.encryptionKey, data.active_scenario_id, data.token);
            return data.user;
        },

        // --- Szenarien-Verwaltung ---
        async loadScenarios() {
            if (!this.currentUser) return [];

            const res = await this.apiFetch('/api/scenarios');
            if (!res.ok) throw new Error("Fehler beim Laden der Szenarien.");

            const data = await res.json();
            this.scenarios = data.scenarios || [];
            if (data.active_scenario_id) {
                this.activeScenarioId = data.active_scenario_id;
                localStorage.setItem('ar_sc_id', this.activeScenarioId);
            }
            this.notifyScenariosChange();
            return this.scenarios;
        },

        async loadActiveScenario() {
            if (!this.currentUser || !this.encryptionKey) return null;

            const res = await this.apiFetch('/api/scenarios/active');
            if (!res.ok) throw new Error("Fehler beim Laden des aktiven Szenarios.");

            const sc = await res.json();
            this.activeScenarioId = sc.id;
            localStorage.setItem('ar_sc_id', sc.id);

            let xmlString = "";
            if (sc.encrypted_payload && sc.iv) {
                xmlString = await this.decrypt(sc.encrypted_payload, sc.iv);
            }

            this.lastSyncTime = sc.updated_at ? new Date(sc.updated_at) : new Date();
            this.notifyStatus('synced');

            return {
                id: sc.id,
                name: sc.name,
                xmlString,
                updated_at: sc.updated_at
            };
        },

        async switchScenario(scenarioId) {
            if (!this.currentUser || !this.encryptionKey) return null;

            // Aktivieren auf Server
            const actRes = await this.apiFetch(`/api/scenarios/${encodeURIComponent(scenarioId)}/activate`, {
                method: 'POST'
            });
            if (!actRes.ok) throw new Error("Konnte Szenario nicht aktivieren.");

            // Daten des Szenarios laden
            const scRes = await this.apiFetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`);
            if (!scRes.ok) throw new Error("Konnte Szenariodaten nicht abrufen.");

            const sc = await scRes.json();
            this.activeScenarioId = sc.id;
            localStorage.setItem('ar_sc_id', sc.id);

            let xmlString = "";
            if (sc.encrypted_payload && sc.iv) {
                xmlString = await this.decrypt(sc.encrypted_payload, sc.iv);
            }

            await this.loadScenarios(); // Liste aktualisieren
            return { id: sc.id, name: sc.name, xmlString };
        },

        async createScenario(name, initialXml) {
            if (!this.currentUser || !this.encryptionKey) throw new Error("Nicht angemeldet.");

            let encrypted = { encrypted_payload: "", iv: "" };
            if (initialXml) {
                encrypted = await this.encrypt(initialXml);
            }

            const res = await this.apiFetch('/api/scenarios', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    encrypted_payload: encrypted.encrypted_payload,
                    iv: encrypted.iv
                })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Konnte Szenario nicht erstellen.");
            }

            const data = await res.json();
            this.activeScenarioId = data.active_scenario_id;
            localStorage.setItem('ar_sc_id', this.activeScenarioId);
            await this.loadScenarios();
            return data.scenario;
        },

        async renameScenario(scenarioId, newName) {
            const res = await this.apiFetch(`/api/scenarios/${encodeURIComponent(scenarioId)}/rename`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Umbenennen fehlgeschlagen.");
            }

            await this.loadScenarios();
            return true;
        },

        async deleteScenario(scenarioId) {
            const res = await this.apiFetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`, {
                method: 'DELETE'
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Löschen fehlgeschlagen.");
            }

            const data = await res.json();
            this.activeScenarioId = data.active_scenario_id;
            localStorage.setItem('ar_sc_id', this.activeScenarioId);
            await this.loadScenarios();
            return data;
        },

        async saveCloudData(xmlString) {
            if (!this.currentUser || !this.encryptionKey) return false;
            if (!this.activeScenarioId) {
                await this.loadScenarios();
            }
            if (!this.activeScenarioId) return false;

            this.notifyStatus('saving');
            try {
                const encrypted = await this.encrypt(xmlString);
                const res = await this.apiFetch(`/api/scenarios/${encodeURIComponent(this.activeScenarioId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(encrypted)
                });

                if (!res.ok) {
                    throw new Error("Speichern des Szenarios fehlgeschlagen.");
                }

                this.lastSyncTime = new Date();
                this.notifyStatus('synced');
                return true;
            } catch (err) {
                console.error("Cloud Save Fehler:", err);
                this.notifyStatus('error', err.message);
                return false;
            }
        },

        triggerAutoSync(xmlString) {
            if (!this.currentUser || !this.encryptionKey) return;
            if (this.syncTimeout) clearTimeout(this.syncTimeout);

            this.notifyStatus('pending');
            this.syncTimeout = setTimeout(() => {
                this.saveCloudData(xmlString);
            }, 800);
        },

        // Callbacks & Notifiers
        onStatusChange(fn) {
            this.syncCallbacks.push(fn);
        },

        notifyStatus(status, message = '') {
            this.syncCallbacks.forEach(fn => fn(status, this.lastSyncTime, message));
        },

        onScenariosChange(fn) {
            this.scenarioCallbacks.push(fn);
        },

        notifyScenariosChange() {
            this.scenarioCallbacks.forEach(fn => fn(this.scenarios, this.activeScenarioId));
        }
    };

    window.CryptoSync = CryptoSync;
})(window);
