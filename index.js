const { Client, LocalAuth, Buttons, List } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

// ============================================================
// 🧠 SYSTÈME DE COMPORTEMENT HUMAIN
// Tous les délais, variations et patterns imitent un humain réel
// ============================================================

const HumanBehavior = {
    gaussianRandom(mean, stddev) {
        let u1 = Math.random();
        let u2 = Math.random();
        let z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return Math.max(0, Math.round(mean + z * stddev));
    },

    readingDelay(messageLength) {
        const words = Math.max(1, Math.ceil(messageLength / 5));
        const baseTime = this.gaussianRandom(300, 100);
        const perWord = this.gaussianRandom(80, 30);
        return Math.min(baseTime + words * perWord, 3000);
    },

    thinkingDelay() {
        return this.gaussianRandom(500, 200);
    },

    typingDuration(messageLength) {
        const charsPerSecond = this.gaussianRandom(8, 2);
        const base = this.gaussianRandom(400, 150);
        const typing = (messageLength / Math.max(1, charsPerSecond)) * 1000;
        return Math.min(base + typing, 5000);
    },

    deletionDelay() {
        return this.gaussianRandom(800, 300);
    },

    interActionDelay() {
        return this.gaussianRandom(1500, 500);
    },

    interGroupDelay() {
        return this.gaussianRandom(4000, 1500);
    },

    callRejectDelay() {
        return this.gaussianRandom(1500, 500);
    },

    postCallMessageDelay() {
        return this.gaussianRandom(2000, 800);
    },

    blockDelay() {
        return this.gaussianRandom(5000, 2000);
    },

    getNightMultiplier() {
        const hour = new Date().getHours();
        if (hour >= 23 || hour < 3) return 3.0;
        if (hour >= 3 && hour < 7) return 2.5;
        if (hour >= 7 && hour < 9) return 1.3;
        if (hour >= 12 && hour < 14) return 1.2;
        if (hour >= 21 && hour < 23) return 1.5;
        return 1.0;
    },

    applyNightMode(delay) {
        return Math.round(delay * this.getNightMultiplier());
    },

    maybeAddDistraction(delay) {
        if (Math.random() < 0.10) {
            const distraction = this.gaussianRandom(8000, 4000);
            return delay + distraction;
        }
        return delay;
    },

    async naturalDelay(baseDelay) {
        let delay = baseDelay;
        delay = this.applyNightMode(delay);
        delay = this.maybeAddDistraction(delay);
        delay = Math.max(500, delay);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
};

// ============================================================
// 🎭 POOL DE MESSAGES VARIABLES
// ============================================================

const MessagePool = {
    warnings: [
        (mention, count, max, remaining) =>
            `⚠️ ${mention} Les liens ne sont pas autorisés ici. Message supprimé.\nAvertissement ${count}/${max}. Encore ${remaining} avant bannissement.`,
        (mention, count, max, remaining) =>
            `🚫 ${mention} Merci de ne pas partager de liens dans ce groupe.\n⚠️ ${count}/${max} avertissements. ${remaining} restant(s).`,
        (mention, count, max, remaining) =>
            `${mention} ❌ Les liens sont interdits. Votre message a été supprimé.\nAvertissement ${count}/${max} — il vous reste ${remaining} chance(s).`,
        (mention, count, max, remaining) =>
            `⚠️ ${mention}, les liens ne sont pas acceptés ici.\nMessage supprimé. Avertissement ${count}/${max}. Plus que ${remaining} avertissement(s).`,
        (mention, count, max, remaining) =>
            `${mention} 🔗❌ Pas de liens svp. Message retiré.\n${count}/${max} avertissements — ${remaining} restant(s) avant exclusion.`,
    ],

    bans: [
        (mention, max) =>
            `🚫 ${mention} a été exclu(e) du groupe pour avoir partagé des liens malgré ${max} avertissements.`,
        (mention, max) =>
            `❌ ${mention} est banni(e). ${max} avertissements pour partage de liens dépassés.`,
        (mention, max) =>
            `${mention} a été retiré(e) du groupe. Les ${max} avertissements pour liens ont été atteints. 🚫`,
    ],

    callRejections: [
        (remaining) =>
            `🚫 Les appels ne sont pas autorisés. Merci de me contacter par message.\n⚠️ ${remaining} appel(s) restant(s) avant blocage.`,
        (remaining) =>
            `Désolé, je ne prends pas les appels. Envoyez-moi un message svp.\n⚠️ Attention : encore ${remaining} appel(s) et vous serez bloqué(e) pendant 30 min.`,
        (remaining) =>
            `❌ Appels non acceptés. Écrivez-moi plutôt.\n🚫 ${remaining} tentative(s) restante(s) avant blocage temporaire.`,
    ],

    callBlocked: [
        `🔒 Vous avez été bloqué(e) pendant 30 minutes suite à des appels répétés. Merci de patienter.`,
        `⛔ Blocage temporaire de 30 minutes pour spam d'appels. Envoyez un message après.`,
        `🚫 Trop d'appels. Vous êtes bloqué(e) pour 30 minutes.`,
    ],

    pick(pool, ...args) {
        const index = Math.floor(Math.random() * pool.length);
        return typeof pool[index] === 'function' ? pool[index](...args) : pool[index];
    }
};

// ============================================================
// ⏱️ RATE LIMITER GLOBAL
// ============================================================

class RateLimiter {
    constructor() {
        this.actions = [];
        this.maxPerMinute = 8;
        this.maxPerHour = 120;
    }

    canAct() {
        const now = Date.now();
        this.actions = this.actions.filter(t => now - t < 3600000);
        const lastMinute = this.actions.filter(t => now - t < 60000).length;
        const lastHour = this.actions.length;
        return lastMinute < this.maxPerMinute && lastHour < this.maxPerHour;
    }

    recordAction() {
        this.actions.push(Date.now());
    }

    async waitUntilAllowed() {
        while (!this.canAct()) {
            const waitTime = HumanBehavior.gaussianRandom(5000, 2000);
            addLog(`⏳ Rate limiter : pause de ${Math.round(waitTime / 1000)}s`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

const rateLimiter = new RateLimiter();

// ============================================================
// 📨 ENVOI DE MESSAGE HUMANISÉ
// ============================================================

async function sendMessageHumanized(chat, text, options = {}, triggerMessageLength = 0, sessionData = null) {
    try {
        await rateLimiter.waitUntilAllowed();

        if (triggerMessageLength > 0) {
            const readDelay = HumanBehavior.readingDelay(triggerMessageLength);
            await HumanBehavior.naturalDelay(readDelay);
        }

        await HumanBehavior.naturalDelay(HumanBehavior.thinkingDelay());

        try {
            await chat.sendStateTyping();
        } catch (e) {}

        const typingTime = HumanBehavior.typingDuration(text.length);
        await HumanBehavior.naturalDelay(typingTime);

        try {
            await chat.clearState();
        } catch (e) {}

        if (Math.random() < 0.3) {
            await HumanBehavior.naturalDelay(
                HumanBehavior.gaussianRandom(800, 400)
            );
        }

        const sent = await chat.sendMessage(text, options);
        rateLimiter.recordAction();
        return sent;

    } catch (error) {
        if (sessionData) {
            sessionData.addLog(`❌ Erreur envoi humanisé: ${error.message}`);
        } else {
            addLog(`❌ Erreur envoi humanisé: ${error.message}`);
        }
        throw error;
    }
}

// ============================================================
// 🗑️ SUPPRESSION POUR TOUT LE MONDE (V3 — VÉRIFIÉ)
// Chaque tentative est VÉRIFIÉE avant de déclarer le succès
// ============================================================

async function deleteMessageHumanized(message) {
    try {
        await rateLimiter.waitUntilAllowed();
        await HumanBehavior.naturalDelay(HumanBehavior.deletionDelay());

        const msgId = message.id._serialized;

        // ──────────────────────────────────────────────
        // DIAGNOSTIC (une seule fois au 1er appel)
        // Trouve les VRAIES méthodes de suppression
        // ──────────────────────────────────────────────
        if (!global.__deleteMethodsDiag) {
            global.__deleteMethodsDiag = true;
            try {
                const diag = await client.pupPage.evaluate(() => {
                    const result = { store: {}, chat: [], msg: [], wwebjs: [] };

                    for (const key of Object.keys(window.Store || {})) {
                        try {
                            const mod = window.Store[key];
                            if (!mod || typeof mod !== 'object') continue;
                            const fns = [];
                            for (const p of Object.getOwnPropertyNames(mod)) {
                                try {
                                    if (typeof mod[p] === 'function' && /revoke|delete|remove/i.test(p)) {
                                        fns.push(p);
                                    }
                                } catch (e) {}
                            }
                            if (fns.length > 0) result.store[key] = fns;
                        } catch (e) {}
                    }

                    try {
                        const c = window.Store.Chat.getModelsArray()[0];
                        if (c) {
                            let proto = Object.getPrototypeOf(c);
                            while (proto && proto !== Object.prototype) {
                                for (const p of Object.getOwnPropertyNames(proto)) {
                                    try {
                                        if (typeof proto[p] === 'function' && /revoke|delete|send/i.test(p)) {
                                            result.chat.push(p);
                                        }
                                    } catch (e) {}
                                }
                                proto = Object.getPrototypeOf(proto);
                            }
                            result.chat = [...new Set(result.chat)];
                        }
                    } catch (e) {}

                    try {
                        const m = window.Store.Msg.getModelsArray()[0];
                        if (m) {
                            let proto = Object.getPrototypeOf(m);
                            while (proto && proto !== Object.prototype) {
                                for (const p of Object.getOwnPropertyNames(proto)) {
                                    try {
                                        if (typeof proto[p] === 'function' && /revoke|delete|canRevoke|canAdmin/i.test(p)) {
                                            result.msg.push(p);
                                        }
                                    } catch (e) {}
                                }
                                proto = Object.getPrototypeOf(proto);
                            }
                            result.msg = [...new Set(result.msg)];
                        }
                    } catch (e) {}

                    if (window.WWebJS) {
                        result.wwebjs = Object.keys(window.WWebJS).filter(k => /revoke|delete/i.test(k));
                    }

                    return result;
                });

                addLog(`🔬 ══════ DIAGNOSTIC SUPPRESSION ══════`);
                addLog(`🔬 Store: ${JSON.stringify(diag.store)}`);
                addLog(`🔬 Chat proto: ${JSON.stringify(diag.chat)}`);
                addLog(`🔬 Msg proto: ${JSON.stringify(diag.msg)}`);
                addLog(`🔬 WWebJS: ${JSON.stringify(diag.wwebjs)}`);
                addLog(`🔬 ═════════════════════════════════════`);
            } catch (e) {
                addLog(`⚠️ Diagnostic échoué: ${e.message}`);
            }
        }

        // Helper : vérifier si le message est réellement supprimé
        const isMessageRevoked = async () => {
            try {
                const status = await client.pupPage.evaluate((id) => {
                    const m = window.Store.Msg.get(id);
                    if (!m) return 'GONE';
                    if (m.isRevoked) return 'REVOKED';
                    if (m.type === 'revoked') return 'REVOKED';
                    if (m.body === '') return 'EMPTY';
                    return 'EXISTS';
                }, msgId);
                return status !== 'EXISTS';
            } catch (e) {
                return false;
            }
        };

        // ══════════════════════════════════════════════
        // TENTATIVE 1 : message.delete(true) — API lib
        // ══════════════════════════════════════════════
        try {
            addLog(`🗑️ T1: message.delete(true)...`);
            await message.delete(true);
            await new Promise(r => setTimeout(r, 2000));

            if (await isMessageRevoked()) {
                addLog(`✅ Supprimé pour TOUS via message.delete(true)`);
                rateLimiter.recordAction();
                return true;
            }
            addLog(`⚠️ T1: message.delete(true) exécuté mais message toujours là`);
        } catch (e) {
            addLog(`⚠️ T1 erreur: ${e.message}`);
        }

        // ══════════════════════════════════════════════
        // TENTATIVE 2 : Evaluate direct avec TOUTES
        // les signatures connues + vérification
        // ══════════════════════════════════════════════
        try {
            addLog(`🗑️ T2: evaluate multi-méthodes...`);

            const result = await client.pupPage.evaluate(async (id) => {
                const msg = window.Store.Msg.get(id);
                if (!msg) return { status: 'MSG_NOT_FOUND' };

                let chat;
                try { chat = await window.Store.Chat.find(msg.id.remote); } catch (e) {}
                if (!chat) try { chat = window.Store.Chat.get(msg.id.remote); } catch (e) {}
                if (!chat) return { status: 'CHAT_NOT_FOUND' };

                const S = window.Store;
                const log = [];

                const attempt = async (name, fn) => {
                    try {
                        await fn();
                        await new Promise(r => setTimeout(r, 1500));
                        const m = S.Msg.get(id);
                        const revoked = !m || m.isRevoked || m.type === 'revoked';
                        log.push({ name, ok: true, revoked });
                        return revoked;
                    } catch (e) {
                        log.push({ name, ok: false, err: (e.message || '').substring(0, 50) });
                        return false;
                    }
                };

                // A) Cmd.sendRevokeMsgs(chat, msgs, {type:'admin'})
                if (S.Cmd?.sendRevokeMsgs) {
                    if (await attempt('Cmd.sendRevokeMsgs(chat,admin)',
                        () => S.Cmd.sendRevokeMsgs(chat, [msg], { clearMedia: true, type: 'admin' })
                    )) return { status: 'OK', method: 'Cmd.sendRevokeMsgs(chat,admin)', log };
                }

                // B) Cmd.sendRevokeMsgs avec type par défaut
                if (S.Cmd?.sendRevokeMsgs) {
                    if (await attempt('Cmd.sendRevokeMsgs(chat,default)',
                        () => S.Cmd.sendRevokeMsgs(chat, [msg], { clearMedia: true })
                    )) return { status: 'OK', method: 'Cmd.sendRevokeMsgs(chat,default)', log };
                }

                // C) Cmd.sendRevokeMsgs avec jid
                if (S.Cmd?.sendRevokeMsgs) {
                    if (await attempt('Cmd.sendRevokeMsgs(jid)',
                        () => S.Cmd.sendRevokeMsgs(msg.id.remote, [msg], { clearMedia: true, type: 'admin' })
                    )) return { status: 'OK', method: 'Cmd.sendRevokeMsgs(jid)', log };
                }

                // D) Cmd.revokeMsgs (certaines versions renomment)
                if (S.Cmd?.revokeMsgs) {
                    if (await attempt('Cmd.revokeMsgs',
                        () => S.Cmd.revokeMsgs(chat, [msg], { clearMedia: true, type: 'admin' })
                    )) return { status: 'OK', method: 'Cmd.revokeMsgs', log };
                }

                // E) chat.sendRevokeMsgs
                if (typeof chat.sendRevokeMsgs === 'function') {
                    for (const args of [
                        [[msg], { type: 'admin' }],
                        [[msg], false],
                        [[msg]]
                    ]) {
                        if (await attempt(`chat.sendRevokeMsgs(${JSON.stringify(args[1])})`,
                            () => chat.sendRevokeMsgs(...args)
                        )) return { status: 'OK', method: 'chat.sendRevokeMsgs', log };
                    }
                }

                // F) chat.revokeMsgs
                if (typeof chat.revokeMsgs === 'function') {
                    if (await attempt('chat.revokeMsgs',
                        () => chat.revokeMsgs([msg])
                    )) return { status: 'OK', method: 'chat.revokeMsgs', log };
                }

                // G) MsgAction
                if (S.MsgAction?.sendRevokeMsgs) {
                    if (await attempt('MsgAction.sendRevokeMsgs',
                        () => S.MsgAction.sendRevokeMsgs(chat, [msg], { type: 'admin' })
                    )) return { status: 'OK', method: 'MsgAction.sendRevokeMsgs', log };
                }

                // H) SendDelete avec revoke=true
                if (S.SendDelete?.sendDeleteMsgs) {
                    if (await attempt('SendDelete.sendDeleteMsgs(revoke)',
                        () => S.SendDelete.sendDeleteMsgs(msg.id.remote, [msg], true)
                    )) return { status: 'OK', method: 'SendDelete', log };
                }

                // I) GroupUtils
                if (S.GroupUtils?.sendRevokeAdminMsgs) {
                    if (await attempt('GroupUtils.sendRevokeAdminMsgs',
                        () => S.GroupUtils.sendRevokeAdminMsgs(chat, [msg])
                    )) return { status: 'OK', method: 'GroupUtils', log };
                }

                // J) Scan dynamique
                for (const key of Object.keys(S)) {
                    if (['Cmd', 'MsgAction', 'GroupUtils', 'SendDelete'].includes(key)) continue;
                    try {
                        const mod = S[key];
                        if (!mod || typeof mod !== 'object') continue;
                        for (const prop of Object.getOwnPropertyNames(mod)) {
                            if (typeof mod[prop] !== 'function') continue;
                            if (!/revoke/i.test(prop)) continue;
                            if (await attempt(`${key}.${prop}`,
                                () => mod[prop](chat, [msg], { clearMedia: true, type: 'admin' })
                            )) return { status: 'OK', method: `${key}.${prop}`, log };
                        }
                    } catch (e) {}
                }

                return { status: 'FAILED', log };
            }, msgId);

            addLog(`🔧 T2 résultat: ${JSON.stringify(result)}`);

            if (result.status === 'OK') {
                addLog(`✅ Supprimé pour TOUS via ${result.method}`);
                rateLimiter.recordAction();
                return true;
            }

            if (result.log) {
                for (const entry of result.log) {
                    addLog(`   └─ ${entry.name}: ${entry.ok ? '✓ appelé' : '✗ erreur'} → ${entry.revoked ? 'REVOQUÉ ✅' : entry.err || 'pas revoqué'}`);
                }
            }
        } catch (e) {
            addLog(`⚠️ T2 erreur: ${e.message}`);
        }

        // ══════════════════════════════════════════════
        // TENTATIVE 3 : Re-fetch message + delete
        // ══════════════════════════════════════════════
        try {
            addLog(`🗑️ T3: re-fetch + delete...`);
            const chat = await message.getChat();
            const messages = await chat.fetchMessages({ limit: 50 });
            const target = messages.find(m => m.id._serialized === msgId);

            if (target) {
                await target.delete(true);
                await new Promise(r => setTimeout(r, 2000));

                if (await isMessageRevoked()) {
                    addLog(`✅ Supprimé pour TOUS via re-fetch + delete`);
                    rateLimiter.recordAction();
                    return true;
                }
                addLog(`⚠️ T3: re-fetch delete exécuté mais message toujours là`);
            } else {
                addLog(`⚠️ T3: message non trouvé dans les 50 derniers`);
            }
        } catch (e) {
            addLog(`⚠️ T3 erreur: ${e.message}`);
        }

        // ══════════════════════════════════════════════
        // TENTATIVE 4 : Protocole brut via sendRevoke
        // ══════════════════════════════════════════════
        try {
            addLog(`🗑️ T4: protocole brut...`);

            const result4 = await client.pupPage.evaluate(async (id) => {
                const msg = window.Store.Msg.get(id);
                if (!msg) return { methods: [], revoked: false, err: 'MSG_NOT_FOUND' };

                const chatJid = msg.id.remote;
                const methods = [];

                // Via WWebJS.sendRevokeMsgs si disponible
                if (window.WWebJS?.sendRevokeMsgs) {
                    try {
                        await window.WWebJS.sendRevokeMsgs(chatJid, [msg]);
                        methods.push('WWebJS.sendRevokeMsgs');
                    } catch (e) { methods.push('WWebJS.ERR:' + (e.message || '').substring(0, 30)); }
                }

                // Via msg.collection.revoke
                try {
                    if (msg.collection?.revokeMsgs) {
                        await msg.collection.revokeMsgs([msg]);
                        methods.push('collection.revokeMsgs');
                    }
                } catch (e) {}

                // Via Cmd.sendDeleteMsgs avec forEveryone=true
                try {
                    const chat = window.Store.Chat.get(chatJid);
                    if (window.Store.Cmd?.sendDeleteMsgs) {
                        await window.Store.Cmd.sendDeleteMsgs(chat, [msg], true);
                        methods.push('Cmd.sendDeleteMsgs(true)');
                    }
                } catch (e) {}

                // Vérif
                await new Promise(r => setTimeout(r, 1500));
                const check = window.Store.Msg.get(id);
                const revoked = !check || check.isRevoked || check.type === 'revoked';

                return { methods, revoked };
            }, msgId);

            addLog(`🔧 T4 résultat: ${JSON.stringify(result4)}`);

            if (result4.revoked) {
                addLog(`✅ Supprimé pour TOUS via protocole brut`);
                rateLimiter.recordAction();
                return true;
            }
        } catch (e) {
            addLog(`⚠️ T4 erreur: ${e.message}`);
        }

        addLog(`❌ ÉCHEC TOTAL: message ${msgId} NON supprimé pour les autres`);
        return false;

    } catch (error) {
        addLog(`❌ Erreur suppression: ${error.message}`);
        return false;
    }
}

// ============================================================
// 🔧 CONFIGURATION
// ============================================================

let CONFIG = {
    MAX_WARNINGS: 3,
    WARNING_EXPIRY_HOURS: 24,
    SCAN_LIMIT: 100,
    AUTO_SCAN_INTERVAL_HOURS: 24,
    DELAY_BETWEEN_ACTIONS_MIN: 2000,
    DELAY_BETWEEN_ACTIONS_MAX: 5000,
    DELAY_BETWEEN_GROUPS_MIN: 5000,
    DELAY_BETWEEN_GROUPS_MAX: 15000,
    WELCOME_ENABLED: true,
    AUTO_SCAN_ENABLED: true,
    CALL_REJECT_ENABLED: true,
    CALL_SPAM_THRESHOLD: 4,
    CALL_SPAM_WINDOW_MIN: 10,
    CALL_BLOCK_DURATION_MIN: 30,
    WELCOME_MESSAGE: `👋 Bienvenue {mention} dans *{group}* !

📜 *Règles importantes:*
• Les liens ne sont pas autorisés dans ce groupe
• Tout lien partagé sera automatiquement supprimé
• Après {maxWarnings} avertissements, vous serez banni du groupe

Merci de respecter ces règles. Bonne discussion ! 🎉`
};

// ============================================================
// 📁 FICHIERS DE STOCKAGE
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');

// ============================================================
// 🗂️ SESSION DATA MANAGER - Données isolées par session
// ============================================================

class SessionDataManager {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.sessionDir = path.join(DATA_DIR, 'sessions', sessionId);
        this.config = { ...CONFIG }; // Copie de la config par défaut
        this.stats = { totalDeleted: 0, totalWarnings: 0, totalBanned: 0, totalCallsRejected: 0, adminGroups: 0 };
        this.warnings = {};
        this.groupExceptions = { excludedGroups: [], excludedPatterns: [], excludedWelcome: [] };
        this.userExceptions = { excludedUsers: [], excludedAdmins: true };
        this.logs = [];
        this.processedMessages = new Set();
        this.callSpamTracker = {};
        this.blockedUsers = {};
        this.unblockTimers = {};
        this.interactiveMenus = {};
        this.menuSessions = {};
        
        this.ensureDir();
        this.loadAll();
    }
    
    ensureDir() {
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }
    }
    
    // === CONFIG ===
    loadConfig() {
        const file = path.join(this.sessionDir, 'config.json');
        try {
            if (fs.existsSync(file)) {
                this.config = { ...CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
            }
        } catch (e) {}
    }
    
    saveConfig() {
        const file = path.join(this.sessionDir, 'config.json');
        try { fs.writeFileSync(file, JSON.stringify(this.config, null, 2)); } catch (e) {}
    }
    
    // === STATS ===
    loadStats() {
        const file = path.join(this.sessionDir, 'stats.json');
        try {
            if (fs.existsSync(file)) {
                this.stats = { ...this.stats, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
            }
        } catch (e) {}
    }
    
    saveStats() {
        const file = path.join(this.sessionDir, 'stats.json');
        try { fs.writeFileSync(file, JSON.stringify(this.stats, null, 2)); } catch (e) {}
    }
    
    // === WARNINGS ===
    loadWarnings() {
        const file = path.join(this.sessionDir, 'warnings.json');
        try {
            if (fs.existsSync(file)) {
                this.warnings = JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (e) {}
    }
    
    saveWarnings() {
        const file = path.join(this.sessionDir, 'warnings.json');
        try { fs.writeFileSync(file, JSON.stringify(this.warnings, null, 2)); } catch (e) {}
    }
    
    addWarning(chatId, userId) {
        this.cleanExpiredWarnings();
        if (!this.warnings[chatId]) this.warnings[chatId] = {};
        if (!this.warnings[chatId][userId]) this.warnings[chatId][userId] = [];
        this.warnings[chatId][userId].push(Date.now());
        this.saveWarnings();
        return this.warnings[chatId][userId].length;
    }
    
    resetWarnings(chatId, userId) {
        if (this.warnings[chatId]?.[userId]) {
            delete this.warnings[chatId][userId];
            if (Object.keys(this.warnings[chatId]).length === 0) delete this.warnings[chatId];
            this.saveWarnings();
        }
    }
    
    cleanExpiredWarnings() {
        const now = Date.now();
        const expiryMs = (this.config.WARNING_EXPIRY_HOURS || 24) * 60 * 60 * 1000;
        for (const chatId in this.warnings) {
            for (const userId in this.warnings[chatId]) {
                this.warnings[chatId][userId] = this.warnings[chatId][userId].filter(ts => now - ts < expiryMs);
                if (this.warnings[chatId][userId].length === 0) delete this.warnings[chatId][userId];
            }
            if (Object.keys(this.warnings[chatId]).length === 0) delete this.warnings[chatId];
        }
    }
    
    // === GROUP EXCEPTIONS ===
    loadGroupExceptions() {
        const file = path.join(this.sessionDir, 'groups.json');
        try {
            if (fs.existsSync(file)) {
                const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
                this.groupExceptions = {
                    excludedGroups: loaded.excludedGroups || [],
                    excludedPatterns: loaded.excludedPatterns || [],
                    excludedWelcome: loaded.excludedWelcome || []
                };
            }
        } catch (e) {}
    }
    
    saveGroupExceptions() {
        const file = path.join(this.sessionDir, 'groups.json');
        try { fs.writeFileSync(file, JSON.stringify(this.groupExceptions, null, 2)); } catch (e) {}
    }
    
    isGroupExcluded(chat) {
        if (!chat || !chat.id) return false;
        if (this.groupExceptions.excludedGroups.includes(chat.id._serialized)) return true;
        if (!chat.name) return false;
        const name = chat.name.toLowerCase();
        return this.groupExceptions.excludedPatterns.some(p => name.includes(p.toLowerCase()));
    }
    
    // === USER EXCEPTIONS ===
    loadUserExceptions() {
        const file = path.join(this.sessionDir, 'users.json');
        try {
            if (fs.existsSync(file)) {
                this.userExceptions = JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (e) {}
    }
    
    saveUserExceptions() {
        const file = path.join(this.sessionDir, 'users.json');
        try { fs.writeFileSync(file, JSON.stringify(this.userExceptions, null, 2)); } catch (e) {}
    }
    
    isUserExcluded(userId, participants = []) {
        const userNumber = userId.split('@')[0];
        const userException = this.userExceptions.excludedUsers.find(u => {
            const exceptionId = typeof u === 'object' ? u.id : u;
            const exceptionNumber = exceptionId.split('@')[0];
            return exceptionId === userId || exceptionNumber === userNumber || exceptionId === userNumber;
        });
        
        if (userException) {
            const hasLinkException = typeof userException === 'object' ? userException.linkException : true;
            if (hasLinkException) return true;
        }
        
        if (this.userExceptions.excludedAdmins) {
            const p = participants.find(p => p.id._serialized === userId);
            if (p && p.isAdmin) return true;
        }
        return false;
    }
    
    // === LOGS ===
    loadLogs() {
        const file = path.join(this.sessionDir, 'logs.json');
        try {
            if (fs.existsSync(file)) {
                this.logs = JSON.parse(fs.readFileSync(file, 'utf8'));
                this.cleanOldLogs();
            }
        } catch (e) {}
    }
    
    saveLogs() {
        const file = path.join(this.sessionDir, 'logs.json');
        try { fs.writeFileSync(file, JSON.stringify(this.logs, null, 2)); } catch (e) {}
    }
    
    addLog(message) {
        const now = new Date();
        this.logs.push({
            timestamp: now.toISOString(),
            display: now.toLocaleString(),
            message: message
        });
        if (this.logs.length > 500) this.cleanOldLogs();
        this.saveLogs();
        console.log(`[${this.sessionId}] ${message}`);
    }
    
    cleanOldLogs() {
        const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
        this.logs = this.logs.filter(log => {
            const ts = typeof log === 'object' && log.timestamp ? new Date(log.timestamp).getTime() : Date.now();
            return ts > cutoff;
        });
    }
    
    // === PROCESSED MESSAGES ===
    loadProcessedMessages() {
        const file = path.join(this.sessionDir, 'processed.json');
        try {
            if (fs.existsSync(file)) {
                JSON.parse(fs.readFileSync(file, 'utf8')).forEach(id => this.processedMessages.add(id));
            }
        } catch (e) {}
    }
    
    saveProcessedMessages() {
        const file = path.join(this.sessionDir, 'processed.json');
        try {
            let arr = Array.from(this.processedMessages);
            if (arr.length > 5000) {
                arr = arr.slice(-5000);
                this.processedMessages = new Set(arr);
            }
            fs.writeFileSync(file, JSON.stringify(arr));
        } catch (e) {}
    }
    
    markAsProcessed(messageId) {
        this.processedMessages.add(messageId);
        this.saveProcessedMessages();
    }
    
    isAlreadyProcessed(messageId) {
        return this.processedMessages.has(messageId);
    }
    
    // === CALL SPAM ===
    loadCallSpamData() {
        const file1 = path.join(this.sessionDir, 'call_spam.json');
        const file2 = path.join(this.sessionDir, 'blocked_users.json');
        try {
            if (fs.existsSync(file1)) this.callSpamTracker = JSON.parse(fs.readFileSync(file1, 'utf8'));
            if (fs.existsSync(file2)) this.blockedUsers = JSON.parse(fs.readFileSync(file2, 'utf8'));
        } catch (e) {}
    }
    
    saveCallSpamData() {
        const file1 = path.join(this.sessionDir, 'call_spam.json');
        const file2 = path.join(this.sessionDir, 'blocked_users.json');
        try {
            fs.writeFileSync(file1, JSON.stringify(this.callSpamTracker, null, 2));
            fs.writeFileSync(file2, JSON.stringify(this.blockedUsers, null, 2));
        } catch (e) {}
    }
    
    // === MENUS ===
    loadMenus() {
        const file1 = path.join(this.sessionDir, 'menus.json');
        const file2 = path.join(this.sessionDir, 'menu_sessions.json');
        try {
            if (fs.existsSync(file1)) this.interactiveMenus = JSON.parse(fs.readFileSync(file1, 'utf8'));
            if (fs.existsSync(file2)) {
                this.menuSessions = JSON.parse(fs.readFileSync(file2, 'utf8'));
                const now = Date.now();
                for (const sessId in this.menuSessions) {
                    if (now - this.menuSessions[sessId].createdAt > 3600000) {
                        delete this.menuSessions[sessId];
                    }
                }
            }
        } catch (e) {}
    }
    
    saveMenus() {
        const file1 = path.join(this.sessionDir, 'menus.json');
        const file2 = path.join(this.sessionDir, 'menu_sessions.json');
        try {
            fs.writeFileSync(file1, JSON.stringify(this.interactiveMenus, null, 2));
            fs.writeFileSync(file2, JSON.stringify(this.menuSessions, null, 2));
        } catch (e) {}
    }
    
    // === LOAD ALL ===
    loadAll() {
        this.loadConfig();
        this.loadStats();
        this.loadWarnings();
        this.loadGroupExceptions();
        this.loadUserExceptions();
        this.loadLogs();
        this.loadProcessedMessages();
        this.loadCallSpamData();
        this.loadMenus();
    }
}

// Map des gestionnaires de données par session
const sessionDataManagers = new Map();

function getSessionData(sessionId) {
    if (!sessionDataManagers.has(sessionId)) {
        sessionDataManagers.set(sessionId, new SessionDataManager(sessionId));
    }
    return sessionDataManagers.get(sessionId);
}

// Fichiers legacy pour la session par défaut (rétrocompatibilité)
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');
const CALL_SPAM_FILE = path.join(DATA_DIR, 'call_spam.json');
const BLOCKED_USERS_FILE = path.join(DATA_DIR, 'blocked_users.json');
const MENUS_FILE = path.join(DATA_DIR, 'menus.json');
const MENU_SESSIONS_FILE = path.join(DATA_DIR, 'menu_sessions.json');

// ============================================================
// ✅ SYSTÈME ANTI-DOUBLON
// ============================================================

let processedMessages = new Set();

function loadProcessedMessages() {
    try {
        if (fs.existsSync(PROCESSED_FILE)) {
            const data = fs.readFileSync(PROCESSED_FILE, 'utf8');
            JSON.parse(data).forEach(id => processedMessages.add(id));
            console.log(`📋 ${processedMessages.size} messages déjà traités chargés`);
        }
    } catch (error) {
        console.error('Erreur chargement messages traités:', error);
    }
}

function saveProcessedMessages() {
    try {
        const arr = Array.from(processedMessages);
        if (arr.length > 5000) {
            const trimmed = arr.slice(-5000);
            processedMessages.clear();
            trimmed.forEach(id => processedMessages.add(id));
        }
        fs.writeFileSync(PROCESSED_FILE, JSON.stringify(Array.from(processedMessages)));
    } catch (error) {
        console.error('Erreur sauvegarde messages traités:', error);
    }
}

function markAsProcessed(messageId) {
    processedMessages.add(messageId);
    saveProcessedMessages();
}

function isAlreadyProcessed(messageId) {
    return processedMessages.has(messageId);
}

// ============================================================
// ✅ SYSTÈME ANTI-SPAM APPELS
// ============================================================

let callSpamTracker = {};
let blockedUsers = {};
let unblockTimers = {};

// ============================================================
// 📱 SYSTÈME DE MENUS INTERACTIFS
// ============================================================

let interactiveMenus = {};
let menuSessions = {};

function loadMenus() {
    try {
        if (fs.existsSync(MENUS_FILE)) {
            interactiveMenus = JSON.parse(fs.readFileSync(MENUS_FILE, 'utf8'));
        }
        if (fs.existsSync(MENU_SESSIONS_FILE)) {
            menuSessions = JSON.parse(fs.readFileSync(MENU_SESSIONS_FILE, 'utf8'));
            const now = Date.now();
            for (const sessionId in menuSessions) {
                if (now - menuSessions[sessionId].createdAt > 3600000) {
                    delete menuSessions[sessionId];
                }
            }
        }
    } catch (error) {
        console.error('Erreur chargement menus:', error);
    }
}

function saveMenus() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(MENUS_FILE, JSON.stringify(interactiveMenus, null, 2));
        fs.writeFileSync(MENU_SESSIONS_FILE, JSON.stringify(menuSessions, null, 2));
    } catch (error) {
        console.error('Erreur sauvegarde menus:', error);
    }
}

function createMenu(config) {
    const menuId = config.id || `menu_${Date.now()}`;
    interactiveMenus[menuId] = {
        id: menuId,
        title: config.title || 'Menu',
        description: config.description || '',
        trigger: config.trigger || null,
        type: config.type || 'buttons',
        buttons: config.buttons || [],
        listSections: config.listSections || [],
        groupId: config.groupId || null,
        enabled: config.enabled !== false
    };
    saveMenus();
    return interactiveMenus[menuId];
}

function generateButtons(buttons) {
    return buttons.slice(0, 3).map((btn, index) => ({
        buttonId: btn.id || `btn_${index}`,
        buttonText: { displayText: btn.text },
        type: btn.type || 1
    }));
}

function generateList(sections) {
    return {
        buttonText: 'Choisir une option',
        sections: sections.map(section => ({
            title: section.title,
            rows: section.rows.slice(0, 10).map((row, idx) => ({
                rowId: row.id || `row_${idx}`,
                title: row.title,
                description: row.description || ''
            }))
        }))
    };
}

async function sendInteractiveMenu(chat, menuId, options = {}) {
    const menu = interactiveMenus[menuId];
    if (!menu || !menu.enabled) return null;

    try {
        await rateLimiter.waitUntilAllowed();

        const title = menu.title;
        const description = menu.description || '';

        if (menu.type === 'buttons' && menu.buttons.length > 0) {
            let menuText = `📋 *${title}*\n\n`;
            if (description) menuText += `${description}\n\n`;

            menu.buttons.slice(0, 10).forEach((btn, i) => {
                menuText += `${i + 1}️⃣ ${btn.text}\n`;
            });
            menuText += `\n_Reply avec le numéro de votre choix_`;

            const sessionId = `${chat.id._serialized}_${Date.now()}`;
            menuSessions[sessionId] = {
                menuId,
                buttons: menu.buttons,
                createdAt: Date.now(),
                expiresAt: Date.now() + 3600000
            };
            saveMenus();

            const sent = await sendMessageHumanized(chat, menuText, options);
            return sent;
        } else if (menu.type === 'list' && menu.listSections.length > 0) {
            let menuText = `📋 *${title}*\n\n`;
            if (description) menuText += `${description}\n\n`;

            let optionIndex = 0;
            const allRows = [];
            menu.listSections.forEach(section => {
                menuText += `📁 *${section.title}*\n`;
                section.rows.forEach(row => {
                    optionIndex++;
                    menuText += `  ${optionIndex}️⃣ ${row.title}\n`;
                    allRows.push(row);
                });
            });
            menuText += `\n_Reply avec le numéro de votre choix_`;

            const sessionId = `${chat.id._serialized}_${Date.now()}`;
            menuSessions[sessionId] = {
                menuId,
                rows: allRows,
                createdAt: Date.now(),
                expiresAt: Date.now() + 3600000
            };
            saveMenus();

            const sent = await sendMessageHumanized(chat, menuText, options);
            return sent;
        } else {
            const body = description || title;
            const sent = await sendMessageHumanized(chat, body, options);
            return sent;
        }
    } catch (error) {
        addLog(`❌ Erreur envoi menu ${menuId}: ${error.message}`);
        console.error('Erreur menu:', error);
        return null;
    }
}

async function handleMenuResponse(message, responseId) {
    const chat = await message.getChat();
    const senderId = message.author || message.from;

    for (const menuId in interactiveMenus) {
        const menu = interactiveMenus[menuId];
        if (!menu.enabled) continue;

        if (menu.groupId && chat.id._serialized !== menu.groupId) continue;

        if (menu.type === 'buttons') {
            const button = menu.buttons.find(b => b.id === responseId);
            if (button) {
                if (button.action) {
                    return await executeMenuAction(chat, senderId, button.action, menu);
                }
                if (button.nextMenu) {
                    return await sendInteractiveMenu(chat, button.nextMenu);
                }
                if (button.response) {
                    return await sendMessageHumanized(chat, button.response, {}, message.body?.length || 0);
                }
            }
        }

        if (menu.type === 'list') {
            for (const section of menu.listSections) {
                const row = section.rows.find(r => r.id === responseId);
                if (row) {
                    if (row.action) {
                        return await executeMenuAction(chat, senderId, row.action, menu);
                    }
                    if (row.nextMenu) {
                        return await sendInteractiveMenu(chat, row.nextMenu);
                    }
                    if (row.response) {
                        return await sendMessageHumanized(chat, row.response, {}, message.body?.length || 0);
                    }
                }
            }
        }
    }

    return null;
}

async function executeMenuAction(chat, userId, action, menu) {
    switch (action.type) {
        case 'message':
            return await sendMessageHumanized(chat, action.content, {}, 0);

        case 'link':
            if (action.whitelist) {
                addLog(`✅ Lien autorisé via menu: ${action.whitelist}`);
                return await sendMessageHumanized(chat,
                    `✅ Voici le lien autorisé: ${action.whitelist}`, {}, 0);
            }
            break;

        case 'contact':
            if (action.contactId) {
                try {
                    const contact = await client.getContactById(action.contactId);
                    return await sendMessageHumanized(chat,
                        `👤 Contact demandé: @${contact.number}`,
                        { mentions: [contact.id._serialized] }, 0);
                } catch (e) {
                    return await sendMessageHumanized(chat, '❌ Contact non disponible', {}, 0);
                }
            }
            break;

        case 'submenu':
            if (action.menuId && interactiveMenus[action.menuId]) {
                return await sendInteractiveMenu(chat, action.menuId);
            }
            break;
        case 'external':
            if (action.webhook) {
                try {
                    const fetch = (await import('node-fetch')).default;
                    await fetch(action.webhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId,
                            chatId: chat.id._serialized,
                            action: action.name,
                            timestamp: Date.now()
                        })
                    });
                    addLog(`🔔 Webhook appelé: ${action.webhook}`);
                } catch (e) {
                    addLog(`❌ Erreur webhook: ${e.message}`);
                }
            }
            break;
    }
    return null;
}

function loadCallSpamData() {
    try {
        if (fs.existsSync(CALL_SPAM_FILE)) {
            callSpamTracker = JSON.parse(fs.readFileSync(CALL_SPAM_FILE, 'utf8'));
        }
        if (fs.existsSync(BLOCKED_USERS_FILE)) {
            blockedUsers = JSON.parse(fs.readFileSync(BLOCKED_USERS_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Erreur chargement données spam:', error);
    }
}

function saveCallSpamData() {
    try {
        fs.writeFileSync(CALL_SPAM_FILE, JSON.stringify(callSpamTracker, null, 2));
        fs.writeFileSync(BLOCKED_USERS_FILE, JSON.stringify(blockedUsers, null, 2));
    } catch (error) {
        console.error('Erreur sauvegarde données spam:', error);
    }
}

function cleanOldCalls(userId) {
    const now = Date.now();
    const windowMs = CONFIG.CALL_SPAM_WINDOW_MIN * 60 * 1000;
    if (callSpamTracker[userId]) {
        callSpamTracker[userId] = callSpamTracker[userId].filter(ts => now - ts < windowMs);
        if (callSpamTracker[userId].length === 0) delete callSpamTracker[userId];
    }
}

function addCall(userId) {
    cleanOldCalls(userId);
    if (!callSpamTracker[userId]) callSpamTracker[userId] = [];
    callSpamTracker[userId].push(Date.now());
    saveCallSpamData();
    return callSpamTracker[userId].length;
}

function restoreUnblockTimers() {
    const now = Date.now();
    for (const userId in blockedUsers) {
        const entry = blockedUsers[userId];
        if (!entry.autoUnblock) continue;

        const elapsed = now - entry.blockedAt;
        const blockDuration = CONFIG.CALL_BLOCK_DURATION_MIN * 60 * 1000;
        const remaining = blockDuration - elapsed;

        if (remaining <= 0) {
            scheduleUnblock(userId, 5000);
        } else {
            scheduleUnblock(userId, remaining);
        }
    }
}

function scheduleUnblock(userId, delay) {
    if (unblockTimers[userId]) clearTimeout(unblockTimers[userId]);

    unblockTimers[userId] = setTimeout(async () => {
        if (blockedUsers[userId] && blockedUsers[userId].autoUnblock) {
            try {
                const contact = await client.getContactById(userId);

                await HumanBehavior.naturalDelay(
                    HumanBehavior.gaussianRandom(3000, 1500)
                );

                await contact.unblock();
                delete blockedUsers[userId];
                delete callSpamTracker[userId];
                delete unblockTimers[userId];
                saveCallSpamData();
                addLog(`🔓 ${userId} débloqué automatiquement`);
            } catch (error) {
                addLog(`❌ Erreur déblocage auto ${userId}: ${error.message}`);
            }
        }
    }, delay);
}

// ============================================================
// 📋 EXCEPTIONS GROUPES & UTILISATEURS
// ============================================================

let GROUP_EXCEPTIONS = { excludedGroups: [], excludedPatterns: [], excludedWelcome: [] };
let USER_EXCEPTIONS = { excludedUsers: [], excludedAdmins: true };

let STATS = { totalDeleted: 0, totalWarnings: 0, totalBanned: 0, totalCallsRejected: 0, adminGroups: 0 };
let LOGS = [];

const LOG_RETENTION_DAYS = 7;

function addLog(message) {
    const now = new Date();
    const logEntry = {
        timestamp: now.toISOString(),
        display: now.toLocaleString(),
        message: message
    };
    LOGS.push(logEntry);

    if (LOGS.length > 500) cleanOldLogs();

    try { fs.writeFileSync(LOGS_FILE, JSON.stringify(LOGS, null, 2)); } catch (e) {}
    console.log(message);
}

function cleanOldLogs() {
    const cutoff = Date.now() - (LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const before = LOGS.length;
    LOGS = LOGS.filter(log => {
        const ts = typeof log === 'object' && log.timestamp ? new Date(log.timestamp).getTime() : Date.now();
        return ts > cutoff;
    });
    if (LOGS.length < before) {
        console.log(`🧹 Nettoyage logs: ${before - LOGS.length} entrées supprimées (>${LOG_RETENTION_DAYS} jours)`);
    }
}

setInterval(() => {
    cleanOldLogs();
    try { fs.writeFileSync(LOGS_FILE, JSON.stringify(LOGS, null, 2)); } catch (e) {}
}, 60 * 60 * 1000);

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            CONFIG = { ...CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (error) { console.error('Erreur chargement config:', error); }
}

function saveConfig() {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2)); }
    catch (error) { console.error('Erreur sauvegarde config:', error); }
}

function loadLogs() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            LOGS = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
            cleanOldLogs();
        }
    } catch (error) {}
}

function loadGroupExceptions() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            GROUP_EXCEPTIONS = {
                excludedGroups: loaded.excludedGroups || [],
                excludedPatterns: loaded.excludedPatterns || [],
                excludedWelcome: loaded.excludedWelcome || []
            };
        }
    } catch (error) {}
}

function saveGroupExceptions() {
    try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(GROUP_EXCEPTIONS, null, 2)); } catch (error) {}
}

function isGroupExcluded(chat) {
    if (!chat || !chat.id) return false;
    if (GROUP_EXCEPTIONS.excludedGroups.includes(chat.id._serialized)) return true;
    if (!chat.name) return false;
    const name = chat.name.toLowerCase();
    return GROUP_EXCEPTIONS.excludedPatterns.some(p => name.includes(p.toLowerCase()));
}

function loadUserExceptions() {
    try {
        if (fs.existsSync(USERS_FILE)) USER_EXCEPTIONS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (error) {}
}

function saveUserExceptions() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(USER_EXCEPTIONS, null, 2)); } catch (error) {}
}

function isUserExcludedFromLinks(userId, participants = []) {
    const userNumber = userId.split('@')[0];

    const userException = USER_EXCEPTIONS.excludedUsers.find(u => {
        const exceptionId = typeof u === 'object' ? u.id : u;
        const exceptionNumber = exceptionId.split('@')[0];
        return exceptionId === userId || exceptionNumber === userNumber || exceptionId === userNumber;
    });

    if (userException) {
        const hasLinkException = typeof userException === 'object' ? userException.linkException : true;
        if (hasLinkException) return true;
    }

    if (USER_EXCEPTIONS.excludedAdmins) {
        const p = participants.find(p => p.id._serialized === userId);
        if (p && p.isAdmin) return true;
    }
    return false;
}

function isUserExcludedFromCalls(userId, phoneNumber = null) {
    const callerNumber = userId.split('@')[0];

    const userException = USER_EXCEPTIONS.excludedUsers.find(u => {
        const exceptionId = typeof u === 'object' ? u.id : u;
        const exceptionNumber = exceptionId.split('@')[0];
        return exceptionId === userId ||
            exceptionNumber === callerNumber ||
            exceptionId === callerNumber ||
            (phoneNumber && exceptionNumber === phoneNumber) ||
            (phoneNumber && exceptionId === phoneNumber);
    });

    return userException && (typeof userException === 'object' ? userException.callException : false);
}

function isUserExcluded(userId, participants = []) {
    return isUserExcludedFromLinks(userId, participants);
}

// ============================================================
// ⚠️ SYSTÈME D'AVERTISSEMENTS
// ============================================================

function loadWarnings() {
    try {
        if (fs.existsSync(WARNINGS_FILE)) return JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
    } catch (error) {}
    return {};
}

function saveWarnings(warnings) {
    try { fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2)); } catch (error) {}
}

function cleanExpiredWarnings(warnings) {
    const now = Date.now();
    const expiryMs = CONFIG.WARNING_EXPIRY_HOURS * 60 * 60 * 1000;
    for (const chatId in warnings) {
        for (const userId in warnings[chatId]) {
            warnings[chatId][userId] = warnings[chatId][userId].filter(ts => now - ts < expiryMs);
            if (warnings[chatId][userId].length === 0) delete warnings[chatId][userId];
        }
        if (Object.keys(warnings[chatId]).length === 0) delete warnings[chatId];
    }
    return warnings;
}

function addWarning(chatId, userId) {
    let warnings = loadWarnings();
    warnings = cleanExpiredWarnings(warnings);
    if (!warnings[chatId]) warnings[chatId] = {};
    if (!warnings[chatId][userId]) warnings[chatId][userId] = [];
    warnings[chatId][userId].push(Date.now());
    saveWarnings(warnings);
    return warnings[chatId][userId].length;
}

function resetWarnings(chatId, userId) {
    let warnings = loadWarnings();
    if (warnings[chatId]?.[userId]) {
        delete warnings[chatId][userId];
        if (Object.keys(warnings[chatId]).length === 0) delete warnings[chatId];
        saveWarnings(warnings);
    }
}

function getWarningCount(chatId, userId) {
    let warnings = cleanExpiredWarnings(loadWarnings());
    saveWarnings(warnings);
    return warnings[chatId]?.[userId]?.length || 0;
}

// ============================================================
// 🔍 DÉTECTION DE LIENS
// ============================================================

const VALID_TLDS = [
    'com', 'net', 'org', 'fr', 'io', 'me', 'co', 'dev', 'info', 'biz', 'edu', 'gov',
    'xyz', 'site', 'online', 'store', 'shop', 'app', 'tech', 'club', 'live', 'pro',
    'link', 'click', 'top', 'work', 'world', 'news', 'tv', 'cc', 'ly', 'gl', 'gg',
    'am', 'fm', 'be', 'it', 'de', 'uk', 'eu', 'ru', 'cn', 'jp', 'br', 'in', 'au',
    'ca', 'es', 'nl', 'se', 'no', 'fi', 'dk', 'at', 'ch', 'pt', 'pl', 'cz', 'gr',
    'ie', 'za', 'ng', 'ke', 'gh', 'ci', 'cm', 'bf', 'ml', 'sn', 'tg', 'bj', 'ne',
    'gn', 'mg', 'cd', 'cg', 'ga', 'td', 'rw', 'ug', 'tz', 'mz', 'zw', 'eg', 'ma',
    'dz', 'tn', 'sa', 'ae', 'qa', 'kw', 'pk', 'af', 'bd', 'th', 'vn', 'my', 'sg',
    'id', 'ph', 'kr', 'hk', 'tw', 'nz', 'mx', 'ar', 'cl', 'pe', 've', 'do', 'cu',
    'pr', 'ht', 'cr', 'pa'
];

const FALSE_POSITIVE_WORDS = [
    'ok.merci', 'ok.ok', 'non.non', 'oui.oui', 'mr.', 'mme.', 'dr.',
    'etc.', 'ex.', 'vs.', 'inc.', 'ltd.', 'sr.', 'jr.', 'st.'
];

const WHITELISTED_DOMAINS = [
    'gmail.com', 'yahoo.com', 'yahoo.fr', 'hotmail.com', 'hotmail.fr',
    'outlook.com', 'outlook.fr', 'live.com', 'live.fr', 'icloud.com',
    'aol.com', 'protonmail.com', 'mail.com', 'whatsapp.com',
    'facebook.com', 'instagram.com', 'twitter.com', 'youtube.com',
    'google.com', 'tiktok.com', 'orange.fr', 'free.fr', 'sfr.fr'
];

const EMAIL_CONTEXT_WORDS = [
    'email', 'e-mail', 'mail', 'adresse', 'address', 'contact',
    'contacter', 'joindre', 'écrire', 'ecrire', 'envoie', 'envoi',
    'envoyé', 'envoyer', 'sur', 'chez', 'mon', 'ma', 'mes', 'ton', 'ta'
];

function containsLink(message) {
    const text = message.body;
    if (!text || text.length < 5) return false;

    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;
    let clean = text.replace(emailPattern, ' ');
    if (clean.trim().length < 5) return false;

    const linkPatterns = [
        /https?:\/\/[^\s]+/gi,
        /www\.[^\s]+\.[^\s]+/gi,
        /wa\.me\/[^\s]+/gi,
        /chat\.whatsapp\.com\/[^\s]+/gi,
    ];

    for (const p of linkPatterns) {
        if (new RegExp(p.source, p.flags).test(clean)) {
            addLog(`🔍 Lien standard détecté: "${text.substring(0, 80)}"`);
            return true;
        }
    }

    const domainPattern = /\b(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?\b/gi;
    const matches = clean.match(domainPattern) || [];

    const valid = matches.filter(match => {
        const c = match.replace(/\/.*$/, '');
        const parts = c.split('.');
        if (parts.length < 2) return false;
        const tld = parts[parts.length - 1].toLowerCase();
        if (!VALID_TLDS.includes(tld)) return false;
        if (parts[parts.length - 2].length < 2) return false;
        const lower = c.toLowerCase();
        if (FALSE_POSITIVE_WORDS.some(fp => lower === fp || lower.startsWith(fp))) return false;
        if (match.includes(' ') || match.includes(',')) return false;

        if (WHITELISTED_DOMAINS.includes(lower)) {
            const tl = text.toLowerCase();
            if (EMAIL_CONTEXT_WORDS.some(w => tl.includes(w))) return false;
        }

        if (!match.includes('/') && text.length > 60 && matches.length === 1) {
            const idx = text.toLowerCase().indexOf(lower);
            const before = text.toLowerCase().substring(Math.max(0, idx - 30), idx);
            if (EMAIL_CONTEXT_WORDS.some(w => before.includes(w))) return false;
        }

        return true;
    });

    if (valid.length > 0) {
        addLog(`🔍 Domaine détecté: "${text.substring(0, 80)}": ${valid.join(', ')}`);
        return true;
    }

    return false;
}

// ============================================================
// 🤖 CLIENT WHATSAPP
// ============================================================

const authPath = path.join(__dirname, '.wwebjs_auth');
try {
    const cleanLockFiles = (dir) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.name.startsWith('Singleton')) {
                try { fs.unlinkSync(fullPath); } catch (e) {}
            } else if (entry.isDirectory()) {
                cleanLockFiles(fullPath);
            }
        }
    };
    cleanLockFiles(authPath);
} catch (e) {}

// ============================================================
// 🗂️ SESSION MANAGER - GESTION MULTI-SESSIONS
// ============================================================

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.activeSessionId = null;
        this.sessionsFile = path.join(DATA_DIR, 'sessions.json');
        this.loadSessionsList();
    }

    loadSessionsList() {
        try {
            if (fs.existsSync(this.sessionsFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
                this.sessionsList = data.sessions || {};
                this.activeSessionId = data.activeSessionId || null;
            } else {
                this.sessionsList = {};
                this.activeSessionId = null;
            }
        } catch (e) {
            console.error('Erreur chargement sessions:', e);
            this.sessionsList = {};
            this.activeSessionId = null;
        }
    }

    saveSessionsList() {
        try {
            fs.writeFileSync(this.sessionsFile, JSON.stringify({
                sessions: this.sessionsList,
                activeSessionId: this.activeSessionId
            }, null, 2));
        } catch (e) {
            console.error('Erreur sauvegarde sessions:', e);
        }
    }

    generateSessionId() {
        return 'session_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    }

    createSession(sessionId = null, name = 'Default') {
        const id = sessionId || this.generateSessionId();
        const authPath = path.join(__dirname, '.wwebjs_auth', id);
        
        if (!fs.existsSync(authPath)) {
            fs.mkdirSync(authPath, { recursive: true });
        }

        const sessionData = {
            id,
            name,
            authPath,
            createdAt: Date.now(),
            status: 'pending',
            phoneNumber: null,
            pushName: null
        };

        this.sessionsList[id] = sessionData;
        this.saveSessionsList();

        const client = this.initClient(id);
        this.sessions.set(id, { client, data: sessionData });

        return sessionData;
    }

    initClient(sessionId) {
        const sessionData = this.sessionsList[sessionId];
        if (!sessionData) return null;

        const authPath = sessionData.authPath;
        
        // Clean lock files
        try {
            const cleanLockFiles = (dir) => {
                if (!fs.existsSync(dir)) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.name.startsWith('Singleton')) {
                        try { fs.unlinkSync(fullPath); } catch (e) {}
                    } else if (entry.isDirectory()) {
                        cleanLockFiles(fullPath);
                    }
                }
            };
            cleanLockFiles(authPath);
        } catch (e) {}

        const client = new Client({
            authStrategy: new LocalAuth({ dataPath: authPath }),
            puppeteer: {
                headless: true,
                timeout: 120000,
                protocolTimeout: 120000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        this.setupClientEvents(client, sessionId);
        return client;
    }

    setupClientEvents(client, sessionId) {
        client.on('qr', (qr) => {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.currentQR = qr;
                session.data.status = 'qr';
                this.sessionsList[sessionId].status = 'qr';
                this.saveSessionsList();
            }
            addLog(`📱 [${sessionId}] QR code généré`);
            console.log(`\n📱 [${sessionId}] Scannez ce QR code avec WhatsApp:\n`);
            qrcode.generate(qr, { small: true });
        });

        client.on('ready', async () => {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.status = 'connected';
                session.data.currentQR = null;
                session.data.phoneNumber = client.info?.wid?.user || null;
                session.data.pushName = client.info?.pushname || null;
                this.sessionsList[sessionId].status = 'connected';
                this.sessionsList[sessionId].phoneNumber = session.data.phoneNumber;
                this.sessionsList[sessionId].pushName = session.data.pushName;
                this.saveSessionsList();
            }
            addLog(`✅ [${sessionId}] Bot connecté et prêt!`);
            
            // Toutes les sessions démarrent leurs processus
            restoreUnblockTimers(sessionId);
            startPresenceManager(sessionId);
            if (CONFIG.AUTO_SCAN_ENABLED) {
                const startupDelay = HumanBehavior.gaussianRandom(15000, 8000);
                addLog(`⏳ [${sessionId}] Premier scan dans ${Math.round(startupDelay / 1000)}s...`);
                await new Promise(r => setTimeout(r, startupDelay));
                try {
                    await scanAllGroups(sessionId);
                } catch (scanError) {
                    addLog(`❌ [${sessionId}] Erreur scan initial: ${scanError.message}`);
                }
            }
            scheduleNextScan(sessionId);
        });

        client.on('auth_failure', (msg) => {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.status = 'auth_failure';
                this.sessionsList[sessionId].status = 'auth_failure';
                this.saveSessionsList();
            }
            addLog(`❌ [${sessionId}] Échec auth: ${msg}`);
        });

        client.on('disconnected', (reason) => {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.status = 'disconnected';
                this.sessionsList[sessionId].status = 'disconnected';
                this.saveSessionsList();
            }
            addLog(`🔌 [${sessionId}] Déconnecté: ${reason}`);
        });

        // Message handler - Toutes les sessions traitent les messages
        client.on('message', async (message) => {
            await handleMessage(client, message, sessionId);
        });

        // Group join handler - Toutes les sessions traitent
        client.on('group_join', async (notification) => {
            await handleGroupJoin(client, notification, sessionId);
        });

        // Call handler - Toutes les sessions traitent
        client.on('call', async (call) => {
            await handleCall(client, call, sessionId);
        });
    }

    startSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.client) {
            session.client.initialize();
            addLog(`🚀 [${sessionId}] Session démarrée`);
            return true;
        }
        return false;
    }

    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.client) {
            try {
                await session.client.destroy();
                session.data.status = 'stopped';
                this.sessionsList[sessionId].status = 'stopped';
                this.saveSessionsList();
                addLog(`🛑 [${sessionId}] Session arrêtée`);
                return true;
            } catch (e) {
                addLog(`❌ [${sessionId}] Erreur arrêt: ${e.message}`);
                return false;
            }
        }
        return false;
    }

    async deleteSession(sessionId) {
        await this.stopSession(sessionId);
        
        // Delete auth folder
        const authPath = path.join(__dirname, '.wwebjs_auth', sessionId);
        try {
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
        } catch (e) {
            addLog(`⚠️ [${sessionId}] Erreur suppression dossier auth: ${e.message}`);
        }

        this.sessions.delete(sessionId);
        delete this.sessionsList[sessionId];
        
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
        }
        
        this.saveSessionsList();
        addLog(`🗑️ [${sessionId}] Session supprimée`);
        return true;
    }

    setActiveSession(sessionId) {
        if (this.sessionsList[sessionId]) {
            this.activeSessionId = sessionId;
            this.saveSessionsList();
            addLog(`🎯 Session active: ${sessionId}`);
            return true;
        }
        return false;
    }

    getActiveClient() {
        if (!this.activeSessionId) return null;
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.client : null;
    }

    getSessionStatus(sessionId) {
        const session = this.sessions.get(sessionId);
        const listData = this.sessionsList[sessionId];
        if (session) {
            return {
                ...listData,
                currentQR: session.data.currentQR,
                status: session.data.status
            };
        }
        return listData || null;
    }

    getAllSessionsStatus() {
        const result = [];
        for (const [id, session] of this.sessions) {
            result.push(this.getSessionStatus(id));
        }
        // Also include sessions not yet initialized
        for (const id in this.sessionsList) {
            if (!this.sessions.has(id)) {
                result.push(this.sessionsList[id]);
            }
        }
        return result;
    }

    initializeAllSessions() {
        // Initialize all saved sessions
        for (const sessionId in this.sessionsList) {
            if (!this.sessions.has(sessionId)) {
                const client = this.initClient(sessionId);
                if (client) {
                    this.sessions.set(sessionId, { 
                        client, 
                        data: { ...this.sessionsList[sessionId] }
                    });
                }
            }
        }

        // Set active session or first one
        if (!this.activeSessionId && Object.keys(this.sessionsList).length > 0) {
            this.activeSessionId = Object.keys(this.sessionsList)[0];
            this.saveSessionsList();
        }

        // Start all sessions
        for (const [sessionId, session] of this.sessions) {
            this.startSession(sessionId);
        }
    }
}

const sessionManager = new SessionManager();

// Legacy compatibility - client variable for backward compatibility
let client = null;
let currentQR = null;
let isConnected = false;

// ============================================================
// 🔍 SCAN HUMANISÉ
// ============================================================

async function scanOldMessages(chat, limit = 100, sessionId = null) {
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    
    // Récupérer le client de la session
    const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : client;
    if (!sessionClient || !sessionClient.info) {
        if (sessionData) sessionData.addLog(`⚠️ Client non disponible pour le scan`);
        else addLog(`⚠️ Client non disponible pour le scan`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }
    
    const log = (msg) => sessionData ? sessionData.addLog(msg) : addLog(msg);
    
    if (sessionData && sessionData.isGroupExcluded(chat)) {
        log(`🚫 Groupe ${chat.name} exclu`);
        return { deleted: 0, scanned: 0, warned: 0 };
    } else if (!sessionData && isGroupExcluded(chat)) {
        log(`🚫 Groupe ${chat.name} exclu`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    log(`🔍 Scan de ${chat.name}...`);

    const botId = sessionClient.info.wid._serialized;
    const participants = chat.participants || [];
    const botP = participants.find(p => p.id._serialized === botId);

    if (!botP || !botP.isAdmin) {
        log(`⚠️ Pas admin dans ${chat.name}`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    try { await chat.sendSeen(); } catch (e) {}
    await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(2000, 1000));

    const messages = await chat.fetchMessages({ limit });
    let deleted = 0, scanned = 0, warned = 0;

    let actionCount = 0;
    const config = sessionData ? sessionData.config : CONFIG;

    for (const message of messages) {
        if (message.fromMe) continue;
        scanned++;

        const msgId = message.id._serialized || message.id.id;
        if (sessionData && sessionData.isAlreadyProcessed(msgId)) continue;
        else if (!sessionData && isAlreadyProcessed(msgId)) continue;
        if (!containsLink(message)) continue;

        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) continue;
        if (sessionData && sessionData.isUserExcluded(authorId, participants)) continue;
        else if (!sessionData && isUserExcluded(authorId, participants)) continue;

        if (actionCount > 0) {
            await HumanBehavior.naturalDelay(HumanBehavior.interActionDelay());
        }
        actionCount++;

        if (actionCount > 0 && actionCount % 5 === 0) {
            const fatiguePause = HumanBehavior.gaussianRandom(8000, 4000);
            log(`😴 Pause fatigue: ${Math.round(fatiguePause / 1000)}s`);
            await HumanBehavior.naturalDelay(fatiguePause);
        }

        try {
            if (sessionData) sessionData.markAsProcessed(msgId);
            else markAsProcessed(msgId);

            const contact = await message.getContact();
            const mention = `@${contact.number}`;
            const currentWarnings = sessionData 
                ? (sessionData.warnings[chat.id._serialized]?.[authorId]?.length || 0)
                : getWarningCount(chat.id._serialized, authorId);

            // ══════ ÉTAPE 1 : SUPPRIMER D'ABORD ══════
            if (await deleteMessageHumanized(message)) {
                deleted++;
                if (sessionData) sessionData.stats.totalDeleted++;
                else STATS.totalDeleted++;
                log(`🗑️ Ancien message supprimé dans ${chat.name}`);
            }

            // ══════ ÉTAPE 2 : AVERTIR / BANNIR ENSUITE ══════
            if (currentWarnings >= config.MAX_WARNINGS) {
                try {
                    const banMsg = MessagePool.pick(
                        MessagePool.bans, mention, config.MAX_WARNINGS
                    );
                    await sendMessageHumanized(chat, banMsg, {
                        mentions: [contact.id._serialized]
                    }, message.body?.length || 0, sessionData);

                    await HumanBehavior.naturalDelay(
                        HumanBehavior.gaussianRandom(2000, 800)
                    );
                    await chat.removeParticipants([authorId]);
                    rateLimiter.recordAction();

                    if (sessionData) {
                        sessionData.resetWarnings(chat.id._serialized, authorId);
                        sessionData.stats.totalBanned++;
                    } else {
                        resetWarnings(chat.id._serialized, authorId);
                        STATS.totalBanned++;
                    }
                    log(`🚫 ${authorId} banni de ${chat.name}`);
                } catch (banError) {
                    log(`❌ Erreur ban: ${banError.message}`);
                }
            } else {
                const warningCount = sessionData 
                    ? sessionData.addWarning(chat.id._serialized, authorId)
                    : addWarning(chat.id._serialized, authorId);
                warned++;
                if (sessionData) sessionData.stats.totalWarnings++;
                else STATS.totalWarnings++;

                if (warningCount >= config.MAX_WARNINGS) {
                    try {
                        const banMsg = MessagePool.pick(
                            MessagePool.bans, mention, config.MAX_WARNINGS
                        );
                        await sendMessageHumanized(chat, banMsg, {
                            mentions: [contact.id._serialized]
                        }, message.body?.length || 0, sessionData);

                        await HumanBehavior.naturalDelay(
                            HumanBehavior.gaussianRandom(2000, 800)
                        );
                        await chat.removeParticipants([authorId]);
                        rateLimiter.recordAction();

                        if (sessionData) {
                            sessionData.resetWarnings(chat.id._serialized, authorId);
                            sessionData.stats.totalBanned++;
                        } else {
                            resetWarnings(chat.id._serialized, authorId);
                            STATS.totalBanned++;
                        }
                        log(`🚫 ${authorId} banni de ${chat.name}`);
                    } catch (banError) {
                        log(`❌ Erreur ban: ${banError.message}`);
                    }
                } else {
                    const remaining = config.MAX_WARNINGS - warningCount;
                    const warnMsg = MessagePool.pick(
                        MessagePool.warnings, mention, warningCount,
                        config.MAX_WARNINGS, remaining
                    );
                    try {
                        await sendMessageHumanized(chat, warnMsg, {
                            mentions: [contact.id._serialized]
                        }, message.body?.length || 0, sessionData);
                    } catch (warnError) {
                        console.error('Erreur avertissement:', warnError);
                    }
                }
            }
        } catch (error) {
            log(`⚠️ Erreur traitement: ${error.message}`);
        }
    }

    log(`✅ Scan ${chat.name}: ${scanned} scannés, ${deleted} supprimés, ${warned} avertis`);
    if (sessionData) sessionData.saveStats();
    return { deleted, scanned, warned };
}

async function scanAllGroups(sessionId = null) {
    // Récupérer le client de la session
    const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : client;
    if (!sessionClient || !sessionClient.info) {
        addLog(`⚠️ [${sessionId}] Client non disponible pour le scan`);
        return { totalDeleted: 0, totalScanned: 0, totalWarned: 0 };
    }
    
    addLog('🔍 ========== SCAN AUTOMATIQUE ==========');
    const chats = await sessionClient.getChats();
    const botId = sessionClient.info.wid._serialized;
    
    // Filtrer uniquement les groupes où le bot est admin
    const groups = chats.filter(c => {
        if (!c.isGroup) return false;
        const botParticipant = c.participants?.find(p => p.id._serialized === botId);
        return botParticipant?.isAdmin; // Bot doit être admin
    });
    
    addLog(`📊 ${groups.length} groupes administrés détectés`);

    let totalDeleted = 0, totalScanned = 0, totalWarned = 0;

    const shuffled = groups.sort(() => Math.random() - 0.5);

    for (const group of shuffled) {
        const result = await scanOldMessages(group, CONFIG.SCAN_LIMIT, sessionId);
        totalDeleted += result.deleted;
        totalScanned += result.scanned;
        totalWarned += result.warned || 0;

        await HumanBehavior.naturalDelay(HumanBehavior.interGroupDelay());
    }

    addLog('✅ ========== FIN DU SCAN ==========');
    addLog(`📊 Total: ${totalScanned} scannés, ${totalDeleted} supprimés, ${totalWarned} avertis`);
    return { totalDeleted, totalScanned, totalWarned };
}

// ============================================================
// ⏰ PLANIFICATION DES SCANS (par session)
// ============================================================

const scanTimers = new Map();

function scheduleNextScan(sessionId) {
    const baseMs = CONFIG.AUTO_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;
    const jitter = HumanBehavior.gaussianRandom(0, baseMs * 0.2);
    const nextScanMs = baseMs + jitter;

    addLog(`⏰ [${sessionId}] Prochain scan dans ${Math.round(nextScanMs / 3600000 * 10) / 10}h`);

    // Clear existing timer for this session
    if (scanTimers.has(sessionId)) {
        clearTimeout(scanTimers.get(sessionId));
    }

    const timer = setTimeout(async () => {
        const session = sessionManager.sessions.get(sessionId);
        if (CONFIG.AUTO_SCAN_ENABLED && session && session.data.status === 'connected') {
            addLog(`⏰ [${sessionId}] Scan automatique programmé...`);
            try {
                await scanAllGroups(sessionId);
            } catch (scanError) {
                addLog(`❌ [${sessionId}] Erreur scan programmé: ${scanError.message}`);
            }
        }
        scheduleNextScan(sessionId);
    }, nextScanMs);
    
    scanTimers.set(sessionId, timer);
}

// ============================================================
// 👤 GESTIONNAIRE DE PRÉSENCE (par session)
// ============================================================

const presenceTimers = new Map();

function startPresenceManager(sessionId) {
    const togglePresence = async () => {
        const session = sessionManager.sessions.get(sessionId);
        if (!session || session.data.status !== 'connected') {
            // Retry later if not connected
            const retryTimer = setTimeout(togglePresence, 60000);
            presenceTimers.set(sessionId, retryTimer);
            return;
        }
        
        const client = session.client;
        try {
            const hour = new Date().getHours();
            if (hour >= 1 && hour < 7) {
                await client.sendPresenceUnavailable();
                const offlineTime = HumanBehavior.gaussianRandom(3600000, 1800000);
                const timer = setTimeout(togglePresence, offlineTime);
                presenceTimers.set(sessionId, timer);
                return;
            }

            await client.sendPresenceAvailable();
            const onlineTime = HumanBehavior.gaussianRandom(720000, 420000);

            const timer = setTimeout(async () => {
                try {
                    const s = sessionManager.sessions.get(sessionId);
                    if (s && s.data.status === 'connected') {
                        await s.client.sendPresenceUnavailable();
                        const offlineTime = HumanBehavior.gaussianRandom(360000, 240000);
                        const t = setTimeout(togglePresence, offlineTime);
                        presenceTimers.set(sessionId, t);
                    }
                } catch (e) {
                    const t = setTimeout(togglePresence, 300000);
                    presenceTimers.set(sessionId, t);
                }
            }, onlineTime);
            presenceTimers.set(sessionId, timer);
        } catch (e) {
            const timer = setTimeout(togglePresence, 600000);
            presenceTimers.set(sessionId, timer);
        }
    };

    const initialTimer = setTimeout(togglePresence, HumanBehavior.gaussianRandom(30000, 15000));
    presenceTimers.set(sessionId, initialTimer);
}

// ============================================================
// 📩 HANDLER MESSAGE (par session)
// ============================================================

async function handleMessage(client, message, sessionId) {
    const sessionData = getSessionData(sessionId);
    
    try {
        if (message.fromMe) return;
        const chat = await message.getChat();
        const senderId = message.author || message.from;

        // ✅ Réponse à un menu interactif (boutons natifs)
        if (message.type === 'buttons_response' || message.type === 'list_response') {
            const responseId = message.selectedButtonId || message.selectedRowId;
            if (responseId) {
                sessionData.addLog(`📱 Réponse menu: ${responseId} de ${senderId}`);
                await handleMenuResponse(message, responseId, sessionData);
                return;
            }
        }

        // ✅ Réponse numérotée à un menu textuel
        const messageText = message.body.trim();
        const numberMatch = messageText.match(/^(\d+)$/);
        if (numberMatch) {
            const selectedNumber = parseInt(numberMatch[1]);

            let latestSession = null;
            let latestSessionId = null;

            for (const sessId in sessionData.menuSessions) {
                const session = sessionData.menuSessions[sessId];

                if (session.expiresAt < Date.now()) {
                    delete sessionData.menuSessions[sessId];
                    continue;
                }

                if (sessId.startsWith(chat.id._serialized)) {
                    if (!latestSession || session.createdAt > latestSession.createdAt) {
                        latestSession = session;
                        latestSessionId = sessId;
                    }
                }
            }

            if (latestSession) {
                const items = latestSession.buttons || latestSession.rows || [];
                if (selectedNumber >= 1 && selectedNumber <= items.length) {
                    const selectedItem = items[selectedNumber - 1];
                    sessionData.addLog(`📱 Réponse menu textuel: ${selectedNumber} (${selectedItem.text || selectedItem.title}) de ${senderId}`);

                    if (selectedItem.response) {
                        await sendMessageHumanized(chat, selectedItem.response, {}, messageText.length, sessionData);
                    } else if (selectedItem.nextMenu) {
                        await sendInteractiveMenu(chat, selectedItem.nextMenu, sessionData);
                    } else {
                        await sendMessageHumanized(chat, `✅ Vous avez sélectionné: ${selectedItem.text || selectedItem.title}`, {}, messageText.length, sessionData);
                    }
                    return;
                }
            }
        }

        // ✅ Vérifier si le message déclenche un menu
        const triggerText = message.body.trim().toLowerCase();
        for (const menuId in sessionData.interactiveMenus) {
            const menu = sessionData.interactiveMenus[menuId];
            if (!menu.enabled || !menu.trigger) continue;
            if (menu.groupId && chat.id._serialized !== menu.groupId) continue;

            if (triggerText === menu.trigger.toLowerCase()) {
                sessionData.addLog(`📱 Menu déclenché: ${menuId} par ${senderId}`);
                await sendInteractiveMenu(chat, menuId, sessionData);
                return;
            }
        }

        // ✅ Seul le traitement des groupes continue
        if (!chat.isGroup) return;
        if (sessionData.isGroupExcluded(chat)) return;

        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        const senderP = participants.find(p => p.id._serialized === senderId);

        // ✅ Commande !scan
        if (messageText === '!scan') {
            if (senderP?.isAdmin) {
                await sendMessageHumanized(chat, '🔍 Scan en cours...', {}, message.body.length, sessionData);
                const result = await scanOldMessages(chat, sessionData.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT, sessionId);
                await sendMessageHumanized(
                    chat,
                    `✅ Scan terminé: ${result.scanned} scannés, ${result.deleted} supprimés.`,
                    {}, 20, sessionData
                );
            }
            return;
        }

        // ✅ Commande !scanall
        if (messageText === '!scanall') {
            if (senderP?.isAdmin) {
                await sendMessageHumanized(chat, '🔍 Scan global en cours...', {}, message.body.length, sessionData);
                const result = await scanAllGroups(sessionId);
                await sendMessageHumanized(
                    chat,
                    `✅ Scan global terminé: ${result.totalScanned} scannés, ${result.totalDeleted} supprimés.`,
                    {}, 25, sessionData
                );
            }
            return;
        }

        // ✅ Commande !diagdelete — diagnostic des méthodes de suppression
        if (messageText === '!diagdelete') {
            if (senderP?.isAdmin) {
                await sendMessageHumanized(chat, '🔬 Diagnostic suppression en cours...', {}, message.body.length);
                try {
                    const diag = await client.pupPage.evaluate(() => {
                        const r = { store: {}, chat: [], msg: [], cmd: [], wwebjs: [] };

                        for (const key of Object.keys(window.Store || {})) {
                            try {
                                const mod = window.Store[key];
                                if (!mod || typeof mod !== 'object') continue;
                                const fns = [];
                                for (const p of Object.getOwnPropertyNames(mod)) {
                                    try {
                                        if (typeof mod[p] === 'function' && /revoke|delete|remove/i.test(p))
                                            fns.push(p);
                                    } catch (e) {}
                                }
                                if (fns.length) r.store[key] = fns;
                            } catch (e) {}
                        }

                        try {
                            const c = window.Store.Chat.getModelsArray()[0];
                            if (c) {
                                let proto = Object.getPrototypeOf(c);
                                while (proto && proto !== Object.prototype) {
                                    for (const p of Object.getOwnPropertyNames(proto)) {
                                        try {
                                            if (typeof proto[p] === 'function' && /revoke|delete|send/i.test(p))
                                                r.chat.push(p);
                                        } catch (e) {}
                                    }
                                    proto = Object.getPrototypeOf(proto);
                                }
                                r.chat = [...new Set(r.chat)];
                            }
                        } catch (e) {}

                        try {
                            const m = window.Store.Msg.getModelsArray()[0];
                            if (m) {
                                let proto = Object.getPrototypeOf(m);
                                while (proto && proto !== Object.prototype) {
                                    for (const p of Object.getOwnPropertyNames(proto)) {
                                        try {
                                            if (typeof proto[p] === 'function' && /revoke|delete|canRevoke|canAdmin/i.test(p))
                                                r.msg.push(p);
                                        } catch (e) {}
                                    }
                                    proto = Object.getPrototypeOf(proto);
                                }
                                r.msg = [...new Set(r.msg)];
                            }
                        } catch (e) {}

                        if (window.Store.Cmd) {
                            r.cmd = Object.getOwnPropertyNames(window.Store.Cmd)
                                .filter(p => { try { return typeof window.Store.Cmd[p] === 'function'; } catch (e) { return false; } })
                                .slice(0, 40);
                        }

                        if (window.WWebJS)
                            r.wwebjs = Object.keys(window.WWebJS);

                        return r;
                    });

                    let report = `🔬 *DIAGNOSTIC SUPPRESSION*\n\n`;
                    report += `📦 *Store modules (delete/revoke):*\n`;
                    for (const [mod, fns] of Object.entries(diag.store || {})) {
                        report += `• \`${mod}\`: ${fns.join(', ')}\n`;
                    }
                    report += `\n💬 *Chat proto:*\n\`${(diag.chat || []).join(', ')}\`\n`;
                    report += `\n📩 *Msg proto:*\n\`${(diag.msg || []).join(', ')}\`\n`;
                    report += `\n🔧 *Cmd toutes méthodes:*\n\`${(diag.cmd || []).join(', ')}\`\n`;
                    report += `\n🌐 *WWebJS:*\n\`${(diag.wwebjs || []).join(', ')}\`\n`;

                    await sendMessageHumanized(chat, report, {}, 10);
                    addLog(`🔬 [${sessionId}] Diagnostic envoyé dans ${chat.name}`);
                } catch (error) {
                    await sendMessageHumanized(chat, `❌ Erreur: ${error.message}`, {}, 10);
                }
            }
            return;
        }

        // ✅ Commande !testdelete — envoie un message test puis le supprime
        if (messageText === '!testdelete') {
            if (senderP?.isAdmin) {
                const testMsg = await sendMessageHumanized(chat, '🧪 Message test — sera supprimé dans 3s...', {}, 5);
                if (testMsg) {
                    await new Promise(r => setTimeout(r, 3000));
                    const deleted = await deleteMessageHumanized(testMsg);
                    if (deleted) {
                        await sendMessageHumanized(chat, '✅ Suppression réussie !', {}, 5);
                    } else {
                        await sendMessageHumanized(chat, '❌ Suppression échouée — voir les logs', {}, 5);
                    }
                }
            }
            return;
        }

        // ✅ Vérification lien
        if (!containsLink(message)) return;

        const msgId = message.id._serialized || message.id.id;
        if (sessionData.isAlreadyProcessed(msgId)) return;
        sessionData.markAsProcessed(msgId);

        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) return;
        if (sessionData.isUserExcluded(authorId, participants)) return;

        // ✅ Marquer comme lu
        try { await chat.sendSeen(); } catch (e) {}

        const contact = await message.getContact();
        const mention = `@${contact.number}`;
        const warningCount = sessionData.addWarning(chat.id._serialized, authorId);
        const remaining = sessionData.config.MAX_WARNINGS - warningCount;
        sessionData.stats.totalWarnings++;

        // ══════════════════════════════════════════════════════
        // ÉTAPE 1 : SUPPRIMER D'ABORD (contenu nuisible)
        // ══════════════════════════════════════════════════════
        const messageBodyLength = message.body?.length || 0;
        const wasDeleted = await deleteMessageHumanized(message);
        if (wasDeleted) {
            sessionData.stats.totalDeleted++;
            sessionData.addLog(`🗑️ Message supprimé de ${authorId} dans ${chat.name}`);
        }

        // ══════════════════════════════════════════════════════
        // ÉTAPE 2 : AVERTIR OU BANNIR ENSUITE
        // ══════════════════════════════════════════════════════
        if (warningCount >= sessionData.config.MAX_WARNINGS) {
            try {
                const banMsg = MessagePool.pick(
                    MessagePool.bans, mention, sessionData.config.MAX_WARNINGS
                );
                await sendMessageHumanized(chat, banMsg, {
                    mentions: [contact.id._serialized]
                }, messageBodyLength, sessionData);

                await HumanBehavior.naturalDelay(
                    HumanBehavior.gaussianRandom(2500, 1000)
                );
                await chat.removeParticipants([authorId]);
                rateLimiter.recordAction();

                sessionData.resetWarnings(chat.id._serialized, authorId);
                sessionData.stats.totalBanned++;
                sessionData.addLog(`🚫 ${authorId} banni de ${chat.name}`);
            } catch (banError) {
                sessionData.addLog(`❌ Erreur ban: ${banError.message}`);
                await sendMessageHumanized(chat,
                    `⚠️ ${mention} a atteint la limite mais je n'ai pas pu le bannir.`,
                    { mentions: [contact.id._serialized] },
                    10, sessionData
                );
            }
        } else {
            const warnMsg = MessagePool.pick(
                MessagePool.warnings, mention, warningCount,
                sessionData.config.MAX_WARNINGS, remaining
            );
            await sendMessageHumanized(chat, warnMsg, {
                mentions: [contact.id._serialized]
            }, messageBodyLength, sessionData);
            sessionData.addLog(`⚠️ Avertissement ${warningCount}/${sessionData.config.MAX_WARNINGS} pour ${authorId} dans ${chat.name}`);
        }
        sessionData.saveStats();
    } catch (error) {
        console.error(`[${sessionId}] Erreur traitement message:`, error);
    }
}

// ============================================================
// 👋 HANDLER BIENVENUE
// ============================================================

const WELCOME_MESSAGE_EXCLUDED = `👋 Bienvenue {mention} dans *{group}* !

🎉 Content de te voir parmi nous !

N'hésite pas à participer et à partager.

Bonne discussion ! 🙌`;

async function handleGroupJoin(client, notification, sessionId) {
    const sessionData = getSessionData(sessionId);
    
    try {
        if (!sessionData.config.WELCOME_ENABLED) return;

        const chat = await notification.getChat();
        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        if (sessionData.groupExceptions.excludedWelcome.includes(chat.id._serialized)) {
            sessionData.addLog(`🔇 Bienvenue désactivé pour ${chat.name}`);
            return;
        }

        let newMemberId = notification.recipient;
        if (notification.id?.participant) newMemberId = notification.id.participant;

        let contact;
        try { contact = await client.getContactById(newMemberId); } catch (e) { return; }

        await HumanBehavior.naturalDelay(
            HumanBehavior.gaussianRandom(5000, 3000)
        );

        const mention = `@${contact.number}`;

        const isExcluded = sessionData.isGroupExcluded(chat);

        const welcomeMessage = (isExcluded ? WELCOME_MESSAGE_EXCLUDED : sessionData.config.WELCOME_MESSAGE)
            .replace(/{mention}/g, mention)
            .replace(/{group}/g, chat.name)
            .replace(/{maxWarnings}/g, sessionData.config.MAX_WARNINGS);

        await sendMessageHumanized(chat, welcomeMessage, {
            mentions: [contact.id._serialized]
        }, 0, sessionData);

        sessionData.addLog(`👋 Bienvenue envoyé à ${contact.number} dans ${chat.name}${isExcluded ? ' (groupe exclu)' : ''}`);
    } catch (error) {
        sessionData.addLog(`❌ Erreur bienvenue: ${error.message}`);
    }
}

// ============================================================
// 📞 HANDLER APPELS
// ============================================================

async function handleCall(client, call, sessionId) {
    const sessionData = getSessionData(sessionId);
    
    try {
        if (!sessionData.config.CALL_REJECT_ENABLED) return;

        const callerId = call.from;
        sessionData.addLog(`📞 Appel entrant de ${callerId}`);

        let callerNumber = callerId.split('@')[0];
        try {
            const contact = await client.getContactById(callerId);
            if (contact && contact.number) {
                callerNumber = contact.number;
                sessionData.addLog(`📱 Numéro associé: ${callerNumber}`);
            }
        } catch (e) {}

        // Vérifier si l'utilisateur est exempté
        const userException = sessionData.userExceptions.excludedUsers.find(u => {
            const exceptionId = typeof u === 'object' ? u.id : u;
            const exceptionNumber = exceptionId.split('@')[0];
            return exceptionId === callerId || exceptionNumber === callerNumber || exceptionId === callerNumber;
        });
        
        if (userException && (typeof userException === 'object' ? userException.callException : false)) {
            sessionData.addLog(`✅ ${callerNumber} exempté du rejet d'appels - appel ignoré`);
            return;
        }

        if (sessionData.blockedUsers[callerId]) {
            try {
                const contact = await client.getContactById(callerId);
                if (contact.isBlocked) {
                    sessionData.addLog(`⛔ ${callerId} déjà bloqué`);
                    await HumanBehavior.naturalDelay(HumanBehavior.callRejectDelay());
                    try { await call.reject(); } catch (e) {}
                    return;
                } else {
                    sessionData.addLog(`🔓 ${callerId} débloqué manuellement, mise à jour`);
                    delete sessionData.blockedUsers[callerId];
                    delete sessionData.callSpamTracker[callerId];
                    if (sessionData.unblockTimers[callerId]) {
                        clearTimeout(sessionData.unblockTimers[callerId]);
                        delete sessionData.unblockTimers[callerId];
                    }
                    sessionData.saveCallSpamData();
                }
            } catch (e) {
                sessionData.addLog(`⚠️ Erreur vérification blocage: ${e.message}`);
            }
        }

        try {
            await call.reject();
            sessionData.addLog(`🚫 Appel rejeté: ${callerId}`);
            sessionData.stats.totalCallsRejected++;
            rateLimiter.recordAction();
        } catch (rejectError) {
            sessionData.addLog(`⚠️ Erreur rejet appel: ${rejectError.message}`);
        }

        // Ajouter l'appel au tracker
        const now = Date.now();
        const windowMs = (sessionData.config.CALL_SPAM_WINDOW_MIN || 30) * 60 * 1000;
        if (!sessionData.callSpamTracker[callerId]) sessionData.callSpamTracker[callerId] = [];
        sessionData.callSpamTracker[callerId] = sessionData.callSpamTracker[callerId].filter(ts => now - ts < windowMs);
        sessionData.callSpamTracker[callerId].push(now);
        const callCount = sessionData.callSpamTracker[callerId].length;
        sessionData.saveCallSpamData();
        
        sessionData.addLog(`📊 ${callerId}: ${callCount}/${sessionData.config.CALL_SPAM_THRESHOLD} appels`);

        if (callCount >= sessionData.config.CALL_SPAM_THRESHOLD) {
            sessionData.addLog(`🚫 SPAM: ${callerId} — ${callCount} appels → BLOCAGE`);

            try {
                const postCallDelay = HumanBehavior.postCallMessageDelay();
                await HumanBehavior.naturalDelay(postCallDelay);

                const chat = await client.getChatById(callerId);
                const blockMsg = MessagePool.pick(MessagePool.callBlocked);
                await sendMessageHumanized(chat, blockMsg, {}, 0, sessionData);
            } catch (msgError) {
                sessionData.addLog(`⚠️ Message pré-blocage échoué: ${msgError.message}`);
            }

            await HumanBehavior.naturalDelay(HumanBehavior.blockDelay());

            try {
                const contact = await client.getContactById(callerId);
                await contact.block();
                rateLimiter.recordAction();

                sessionData.blockedUsers[callerId] = {
                    blockedAt: Date.now(),
                    autoUnblock: true,
                    callCount: callCount
                };
                sessionData.saveCallSpamData();
                sessionData.addLog(`🔒 ${callerId} bloqué pour spam d'appels`);

                // Planifier le déblocage
                const blockDuration = sessionData.config.CALL_BLOCK_DURATION_MIN * 60 * 1000;
                if (sessionData.unblockTimers[callerId]) clearTimeout(sessionData.unblockTimers[callerId]);
                sessionData.unblockTimers[callerId] = setTimeout(async () => {
                    if (sessionData.blockedUsers[callerId] && sessionData.blockedUsers[callerId].autoUnblock) {
                        try {
                            const contact = await client.getContactById(callerId);
                            await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(3000, 1500));
                            await contact.unblock();
                            delete sessionData.blockedUsers[callerId];
                            delete sessionData.callSpamTracker[callerId];
                            delete sessionData.unblockTimers[callerId];
                            sessionData.saveCallSpamData();
                            sessionData.addLog(`🔓 ${callerId} débloqué automatiquement`);
                        } catch (error) {
                            sessionData.addLog(`❌ Erreur déblocage auto ${callerId}: ${error.message}`);
                        }
                    }
                }, blockDuration);

            } catch (blockError) {
                sessionData.addLog(`❌ Erreur blocage: ${blockError.message}`);
            }
            sessionData.saveStats();
            return;
        }

        const msgDelay = HumanBehavior.postCallMessageDelay();
        sessionData.addLog(`⏳ Message dans ${Math.round(msgDelay / 1000)}s...`);
        await HumanBehavior.naturalDelay(msgDelay);

        try {
            const chat = await client.getChatById(callerId);
            const remaining = sessionData.config.CALL_SPAM_THRESHOLD - callCount;
            const rejectMsg = MessagePool.pick(
                MessagePool.callRejections, remaining
            );
            await sendMessageHumanized(chat, rejectMsg, {}, 0, sessionData);
            sessionData.addLog(`💬 Message envoyé à ${callerId}`);
        } catch (msgError) {
            sessionData.addLog(`❌ Erreur message post-appel: ${msgError.message}`);
        }

    } catch (error) {
        const sessionData = getSessionData(sessionId);
        sessionData.addLog(`❌ Erreur handler appel: ${error.message}`);
    }
}

// ============================================================
// 🌐 SERVEUR WEB EXPRESS
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ API SESSIONS ============

app.get('/api/sessions', (req, res) => {
    const sessions = sessionManager.getAllSessionsStatus();
    res.json({
        sessions,
        activeSessionId: sessionManager.activeSessionId
    });
});

app.post('/api/sessions', (req, res) => {
    try {
        const { name } = req.body;
        const sessionData = sessionManager.createSession(null, name || 'New Session');
        sessionManager.startSession(sessionData.id);
        addLog(`📱 Nouvelle session créée: ${sessionData.id}`);
        res.json({ success: true, session: sessionData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/sessions/:id', (req, res) => {
    const status = sessionManager.getSessionStatus(req.params.id);
    if (!status) return res.status(404).json({ success: false, message: 'Session non trouvée' });
    res.json(status);
});

app.post('/api/sessions/:id/activate', (req, res) => {
    const success = sessionManager.setActiveSession(req.params.id);
    if (success) {
        res.json({ success: true, message: 'Session activée' });
    } else {
        res.status(404).json({ success: false, message: 'Session non trouvée' });
    }
});

app.post('/api/sessions/:id/stop', async (req, res) => {
    const success = await sessionManager.stopSession(req.params.id);
    if (success) {
        res.json({ success: true, message: 'Session arrêtée' });
    } else {
        res.status(404).json({ success: false, message: 'Session non trouvée ou erreur' });
    }
});

app.delete('/api/sessions/:id', async (req, res) => {
    const success = await sessionManager.deleteSession(req.params.id);
    if (success) {
        res.json({ success: true, message: 'Session supprimée' });
    } else {
        res.status(404).json({ success: false, message: 'Session non trouvée ou erreur' });
    }
});

app.get('/api/status', (req, res) => {
    const activeClient = sessionManager.getActiveClient();
    const activeSession = sessionManager.activeSessionId ? sessionManager.getSessionStatus(sessionManager.activeSessionId) : null;
    
    res.json({
        connected: activeClient && activeSession?.status === 'connected',
        qr: activeSession?.currentQR || null,
        activeSessionId: sessionManager.activeSessionId,
        sessions: sessionManager.getAllSessionsStatus().map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            phoneNumber: s.phoneNumber
        }))
    });
});

app.get('/api/config', (req, res) => {
    // Utiliser la config de la session active ou la config globale
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const config = sessionData ? sessionData.config : CONFIG;
    
    res.json({
        sessionId: sessionId || 'global',
        MAX_WARNINGS: config.MAX_WARNINGS,
        WARNING_EXPIRY_HOURS: config.WARNING_EXPIRY_HOURS,
        SCAN_LIMIT: config.SCAN_LIMIT,
        AUTO_SCAN_INTERVAL_HOURS: config.AUTO_SCAN_INTERVAL_HOURS,
        DELAY_BETWEEN_ACTIONS_MIN: config.DELAY_BETWEEN_ACTIONS_MIN,
        DELAY_BETWEEN_ACTIONS_MAX: config.DELAY_BETWEEN_ACTIONS_MAX,
        WELCOME_MESSAGE: config.WELCOME_MESSAGE,
        WELCOME_ENABLED: config.WELCOME_ENABLED,
        AUTO_SCAN_ENABLED: config.AUTO_SCAN_ENABLED,
        CALL_REJECT_ENABLED: config.CALL_REJECT_ENABLED,
        CALL_SPAM_THRESHOLD: config.CALL_SPAM_THRESHOLD,
        CALL_SPAM_WINDOW_MIN: config.CALL_SPAM_WINDOW_MIN,
        CALL_BLOCK_DURATION_MIN: config.CALL_BLOCK_DURATION_MIN
    });
});

app.post('/api/config', (req, res) => {
    try {
        // Utiliser la config de la session active ou la config globale
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const config = sessionData ? sessionData.config : CONFIG;
        
        const nc = req.body;
        if (nc.MAX_WARNINGS !== undefined) config.MAX_WARNINGS = parseInt(nc.MAX_WARNINGS);
        if (nc.WARNING_EXPIRY_HOURS !== undefined) config.WARNING_EXPIRY_HOURS = parseInt(nc.WARNING_EXPIRY_HOURS);
        if (nc.SCAN_LIMIT !== undefined) config.SCAN_LIMIT = parseInt(nc.SCAN_LIMIT);
        if (nc.AUTO_SCAN_INTERVAL_HOURS !== undefined) config.AUTO_SCAN_INTERVAL_HOURS = parseInt(nc.AUTO_SCAN_INTERVAL_HOURS);
        if (nc.DELAY_BETWEEN_ACTIONS_MIN !== undefined) config.DELAY_BETWEEN_ACTIONS_MIN = parseInt(nc.DELAY_BETWEEN_ACTIONS_MIN);
        if (nc.DELAY_BETWEEN_ACTIONS_MAX !== undefined) config.DELAY_BETWEEN_ACTIONS_MAX = parseInt(nc.DELAY_BETWEEN_ACTIONS_MAX);
        if (nc.WELCOME_MESSAGE !== undefined) config.WELCOME_MESSAGE = nc.WELCOME_MESSAGE;
        if (nc.WELCOME_ENABLED !== undefined) config.WELCOME_ENABLED = nc.WELCOME_ENABLED;
        if (nc.AUTO_SCAN_ENABLED !== undefined) config.AUTO_SCAN_ENABLED = nc.AUTO_SCAN_ENABLED;
        if (nc.CALL_REJECT_ENABLED !== undefined) config.CALL_REJECT_ENABLED = nc.CALL_REJECT_ENABLED;
        if (nc.CALL_SPAM_THRESHOLD !== undefined) config.CALL_SPAM_THRESHOLD = parseInt(nc.CALL_SPAM_THRESHOLD);
        if (nc.CALL_SPAM_WINDOW_MIN !== undefined) config.CALL_SPAM_WINDOW_MIN = parseInt(nc.CALL_SPAM_WINDOW_MIN);
        if (nc.CALL_BLOCK_DURATION_MIN !== undefined) config.CALL_BLOCK_DURATION_MIN = parseInt(nc.CALL_BLOCK_DURATION_MIN);
        
        if (sessionData) {
            sessionData.saveConfig();
            sessionData.addLog('⚙️ Configuration mise à jour');
        } else {
            saveConfig();
            addLog('⚙️ Configuration mise à jour');
        }
        res.json({ success: true, message: 'Configuration enregistrée', sessionId: sessionId || 'global' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const stats = sessionData ? sessionData.stats : STATS;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        
        if (activeClient && activeClient.info) {
            const chats = await activeClient.getChats();
            let adminCount = 0;
            for (const g of chats.filter(c => c.isGroup)) {
                const bp = g.participants?.find(p => p.id._serialized === activeClient.info.wid._serialized);
                if (bp?.isAdmin) adminCount++;
            }
            stats.adminGroups = adminCount;
        }
        res.json({ sessionId: sessionId || 'global', ...stats });
    } catch (error) { 
        const sessionId = req.query.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.stats : STATS) }); 
    }
});

app.get('/api/logs', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    
    const formattedLogs = logs.map(log => {
        if (typeof log === 'string') return log;
        return `[${log.display}] ${log.message}`;
    });
    res.json({ sessionId: sessionId || 'global', logs: formattedLogs });
});

app.get('/api/stats/groups', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        if (!activeClient || !activeClient.info) return res.json({ sessionId: sessionId || 'global', groups: [] });
        
        const chats = await activeClient.getChats();
        const groups = [];
        for (const g of chats.filter(c => c.isGroup)) {
            const bp = g.participants?.find(p => p.id._serialized === activeClient.info.wid._serialized);
            if (bp?.isAdmin) {
                groups.push({
                    name: g.name,
                    id: g.id._serialized,
                    participants: g.participants?.length || 0
                });
            }
        }
        res.json({ sessionId: sessionId || 'global', groups, total: groups.length });
    } catch (error) { res.json({ groups: [], total: 0 }); }
});

app.get('/api/stats/deleted', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const deletedLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('supprimé') || msg.includes('Supprimé');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalDeleted, recent: deletedLogs.slice(-20).reverse() });
});

app.get('/api/stats/warnings', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const warningLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('avertissement') || msg.includes('Avertissement');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalWarnings, recent: warningLogs.slice(-20).reverse() });
});

app.get('/api/stats/banned', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const bannedLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('banni') || msg.includes('Banni') || msg.includes('bloqué');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalBanned, recent: bannedLogs.slice(-20).reverse() });
});

app.get('/api/stats/calls', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const callLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('Appel') || msg.includes('appel') || msg.includes('rejeté');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalCallsRejected, recent: callLogs.slice(-20).reverse() });
});

// ============ API ACTIVITY CHART ============

app.get('/api/stats/activity', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    
    // Calculer l'activité des 7 derniers jours
    const days = [];
    const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const dayName = dayNames[date.getDay()];
        
        // Compter les actions dans les logs pour ce jour
        let count = 0;
        logs.forEach(log => {
            const logDate = typeof log === 'object' ? log.display : log.substring(1, 11);
            const logStr = typeof log === 'object' ? `${log.display} ${log.message}` : log;
            if (logDate === dateStr || logStr.includes(dateStr)) {
                // Compter les actions significatives
                const msg = typeof log === 'object' ? log.message : log;
                if (msg.includes('supprimé') || msg.includes('Supprimé') ||
                    msg.includes('avertissement') || msg.includes('Avertissement') ||
                    msg.includes('banni') || msg.includes('Banni') ||
                    msg.includes('Appel') || msg.includes('rejeté') ||
                    msg.includes('Menu') || msg.includes('Scan')) {
                    count++;
                }
            }
        });
        
        days.push({ day: dayName, date: dateStr, count });
    }
    
    // Calculer le max pour normaliser
    const maxCount = Math.max(...days.map(d => d.count), 1);
    
    res.json({ 
        sessionId: sessionId || 'global',
        days,
        maxCount
    });
});

app.post('/api/scan', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });
        
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog('🔍 Scan manuel via interface');
        else addLog('🔍 Scan manuel via interface');
        
        const result = await scanAllGroups(sessionId);
        res.json({ success: true, sessionId: sessionId || 'global', ...result });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/warnings', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (sessionData) {
            sessionData.warnings = {};
            sessionData.saveWarnings();
            sessionData.addLog('🗑️ Avertissements effacés');
        } else {
            fs.writeFileSync(WARNINGS_FILE, JSON.stringify({}));
            addLog('🗑️ Avertissements effacés');
        }
        res.json({ success: true, sessionId: sessionId || 'global' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/groups', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (!activeClient) return res.json([]);
        const chats = await activeClient.getChats();
        const groupExceptions = sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS;
        
        res.json(chats.filter(c => c.isGroup).map(g => {
            const bp = g.participants?.find(p => p.id._serialized === activeClient.info.wid._serialized);
            return {
                id: g.id._serialized, name: g.name,
                participants: g.participants?.length || 0,
                isAdmin: bp?.isAdmin || false,
                isExcluded: groupExceptions.excludedGroups.includes(g.id._serialized)
            };
        }).filter(g => g.isAdmin));
    } catch (error) { res.status(500).json([]); }
});

app.get('/api/groups/all', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (!activeClient) {
            if (sessionData) sessionData.addLog('⚠️ /api/groups/all: Aucune session active');
            else addLog('⚠️ /api/groups/all: Aucune session active');
            return res.json([]);
        }
        const chats = await activeClient.getChats();
        const botId = activeClient.info.wid._serialized;
        const groups = [];
        
        for (const g of chats.filter(c => c.isGroup)) {
            // Vérifier si le bot est encore dans le groupe
            const botParticipant = g.participants?.find(p => p.id._serialized === botId);
            if (!botParticipant) continue; // Bot n'est plus dans ce groupe
            
            groups.push({
                id: g.id._serialized, name: g.name,
                participants: g.participants?.length || 0,
                isAdmin: botParticipant.isAdmin || false,
                isSuperAdmin: botParticipant.isSuperAdmin || false
            });
        }
        
        if (sessionData) sessionData.addLog(`📋 /api/groups/all: ${groups.length} groupes trouvés`);
        else addLog(`📋 /api/groups/all: ${groups.length} groupes trouvés`);
        res.json(groups);
    } catch (error) {
        const sessionId = req.query.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog(`❌ Erreur /api/groups/all: ${error.message}`);
        else addLog(`❌ Erreur /api/groups/all: ${error.message}`);
        res.status(500).json([]);
    }
});

app.post('/api/groups/leave', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });
        const { groupId } = req.body;
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        const chat = await activeClient.getChatById(groupId);
        if (!chat || !chat.isGroup) return res.status(404).json({ success: false, message: 'Groupe non trouvé' });

        const groupName = chat.name;
        await chat.leave();
        
        // Supprimer le chat de la liste locale pour forcer le rafraîchissement
        try {
            await chat.delete();
        } catch (e) {
            // Ignore si non supporté
        }
        
        if (sessionData) sessionData.addLog(`🚪 Bot a quitté le groupe: ${groupName}`);
        else addLog(`🚪 Bot a quitté le groupe: ${groupName}`);
        res.json({ success: true, message: 'Groupe quitté' });
    } catch (error) {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog(`❌ Erreur quitter groupe: ${error.message}`);
        else addLog(`❌ Erreur quitter groupe: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/groups/delete', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });
        const { groupId } = req.body;
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        const chat = await activeClient.getChatById(groupId);
        if (!chat || !chat.isGroup) return res.status(404).json({ success: false, message: 'Groupe non trouvé' });

        const botParticipant = chat.participants?.find(p => p.id._serialized === activeClient.info.wid._serialized);
        if (!botParticipant?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Le bot doit être admin pour supprimer ce groupe' });
        }

        await chat.leave();
        if (sessionData) sessionData.addLog(`🗑️ Groupe supprimé (bot était admin): ${chat.name}`);
        else addLog(`🗑️ Groupe supprimé (bot était admin): ${chat.name}`);
        res.json({ success: true, message: 'Groupe quitté (suppression complète non supportée par l\'API)' });
    } catch (error) {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog(`❌ Erreur suppression groupe: ${error.message}`);
        else addLog(`❌ Erreur suppression groupe: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/groups/exceptions', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS) });
});

app.post('/api/groups/exceptions', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS;
        
        const { groupId, pattern } = req.body;
        if (groupId && !exceptions.excludedGroups.includes(groupId)) exceptions.excludedGroups.push(groupId);
        if (pattern && !exceptions.excludedPatterns.includes(pattern)) exceptions.excludedPatterns.push(pattern);
        
        if (sessionData) sessionData.saveGroupExceptions();
        else saveGroupExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/groups/exceptions', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS;
        
        const { groupId, pattern } = req.body;
        if (groupId) exceptions.excludedGroups = exceptions.excludedGroups.filter(id => id !== groupId);
        if (pattern) exceptions.excludedPatterns = exceptions.excludedPatterns.filter(p => p !== pattern);
        
        if (sessionData) sessionData.saveGroupExceptions();
        else saveGroupExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/groups/welcome', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS;
        
        const { groupId, enabled } = req.body;
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        if (enabled === false) {
            if (!exceptions.excludedWelcome.includes(groupId)) {
                exceptions.excludedWelcome.push(groupId);
            }
        } else {
            exceptions.excludedWelcome = exceptions.excludedWelcome.filter(id => id !== groupId);
        }

        if (sessionData) sessionData.saveGroupExceptions();
        else saveGroupExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/users/exceptions', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.userExceptions : USER_EXCEPTIONS) });
});

app.post('/api/users/exceptions', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.userExceptions : USER_EXCEPTIONS;
        
        const { userId, linkException, callException } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'userId requis' });

        let userEntry = exceptions.excludedUsers.find(u => u.id === userId);

        if (userEntry) {
            if (linkException !== undefined) userEntry.linkException = linkException;
            if (callException !== undefined) userEntry.callException = callException;
        } else {
            exceptions.excludedUsers.push({
                id: userId,
                linkException: linkException === true,
                callException: callException === true
            });
        }

        if (sessionData) sessionData.saveUserExceptions();
        else saveUserExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/users/exceptions', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.userExceptions : USER_EXCEPTIONS;
        
        const { userId } = req.body;
        exceptions.excludedUsers = exceptions.excludedUsers.filter(u => u.id !== userId);
        
        if (sessionData) sessionData.saveUserExceptions();
        else saveUserExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/users/exceptions/admins', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.userExceptions : USER_EXCEPTIONS;
        
        exceptions.excludedAdmins = req.body.excludedAdmins;
        
        if (sessionData) sessionData.saveUserExceptions();
        else saveUserExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ API BLOCAGE APPELS ============

app.get('/api/blocked', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', blockedUsers: sessionData ? sessionData.blockedUsers : blockedUsers });
});

app.post('/api/blocked/unblock', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const blocked = sessionData ? sessionData.blockedUsers : blockedUsers;
        const timers = sessionData ? sessionData.unblockTimers : unblockTimers;
        const tracker = sessionData ? sessionData.callSpamTracker : callSpamTracker;
        
        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });
        const { userId } = req.body;
        if (!blocked[userId]) return res.status(404).json({ success: false, message: 'Non bloqué' });

        const contact = await activeClient.getContactById(userId);
        await contact.unblock();

        if (timers[userId]) {
            clearTimeout(timers[userId]);
            delete timers[userId];
        }

        delete blocked[userId];
        delete tracker[userId];
        
        if (sessionData) {
            sessionData.saveCallSpamData();
            sessionData.addLog(`🔓 ${userId} débloqué manuellement`);
        } else {
            saveCallSpamData();
            addLog(`🔓 ${userId} débloqué manuellement`);
        }
        res.json({ success: true, sessionId: sessionId || 'global', message: 'Débloqué' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/ratelimit', (req, res) => {
    const now = Date.now();
    const lastMinute = rateLimiter.actions.filter(t => now - t < 60000).length;
    const lastHour = rateLimiter.actions.filter(t => now - t < 3600000).length;
    res.json({
        actionsLastMinute: lastMinute,
        actionsLastHour: lastHour,
        maxPerMinute: rateLimiter.maxPerMinute,
        maxPerHour: rateLimiter.maxPerHour,
        nightMultiplier: HumanBehavior.getNightMultiplier()
    });
});

// ============ API MENUS INTERACTIFS ============

app.get('/api/menus', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', menus: sessionData ? sessionData.interactiveMenus : interactiveMenus });
});

app.get('/api/menus/:id', (req, res) => {
    const sessionId = req.query.sessionId || sessionManager.activeSessionId;
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
    
    const menu = menus[req.params.id];
    if (!menu) return res.status(404).json({ success: false, message: 'Menu non trouvé' });
    res.json({ sessionId: sessionId || 'global', menu });
});

app.post('/api/menus', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        const menu = createMenu(req.body, sessionData);
        if (sessionData) sessionData.addLog(`📱 Menu créé: ${menu.id}`);
        else addLog(`📱 Menu créé: ${menu.id}`);
        res.json({ success: true, sessionId: sessionId || 'global', menu });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/menus/:id', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
        
        const menuId = req.params.id;
        if (!menus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        menus[menuId] = {
            ...menus[menuId],
            ...req.body,
            id: menuId
        };
        
        if (sessionData) {
            sessionData.saveMenus();
            sessionData.addLog(`📝 Menu mis à jour: ${menuId}`);
        } else {
            saveMenus();
            addLog(`📝 Menu mis à jour: ${menuId}`);
        }
        res.json({ success: true, sessionId: sessionId || 'global', menu: menus[menuId] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/menus/:id', (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
        
        const menuId = req.params.id;
        if (!menus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        delete menus[menuId];
        
        if (sessionData) {
            sessionData.saveMenus();
            sessionData.addLog(`🗑️ Menu supprimé: ${menuId}`);
        } else {
            saveMenus();
            addLog(`🗑️ Menu supprimé: ${menuId}`);
        }
        res.json({ success: true, sessionId: sessionId || 'global' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/menus/:id/test', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || sessionManager.activeSessionId;
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
        
        if (!activeClient) {
            return res.status(400).json({ success: false, message: 'Aucune session active' });
        }

        const menuId = req.params.id;
        const { groupId } = req.body;

        if (!menus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        const chats = await activeClient.getChats();
        let targetChat;

        if (groupId) {
            targetChat = chats.find(c => c.id._serialized === groupId);
        } else {
            targetChat = chats.find(c => {
                if (!c.isGroup) return false;
                const bp = c.participants?.find(p => p.id._serialized === activeClient.info.wid._serialized);
                return bp?.isAdmin;
            });
        }

        if (!targetChat) {
            return res.status(400).json({ success: false, message: 'Aucun groupe disponible' });
        }

        await sendInteractiveMenu(targetChat, menuId, sessionData);
        if (sessionData) sessionData.addLog(`🧪 Menu testé: ${menuId} dans ${targetChat.name}`);
        else addLog(`🧪 Menu testé: ${menuId} dans ${targetChat.name}`);
        res.json({ success: true, sessionId: sessionId || 'global', groupName: targetChat.name });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.listen(PORT, () => console.log(`🌐 Interface web: http://localhost:${PORT}`));

// ============================================================
// 🚀 DÉMARRAGE
// ============================================================

loadConfig();
loadLogs();
loadGroupExceptions();
loadUserExceptions();
loadProcessedMessages();
loadCallSpamData();
loadMenus();

console.log('🚀 Démarrage du bot WhatsApp...');
console.log('🧠 Mode comportement humain activé');
console.log('   ├─ Délais gaussiens (non uniformes)');
console.log('   ├─ Simulation de frappe (typing indicator)');
console.log('   ├─ Rate limiter (8 actions/min, 120/h)');
console.log('   ├─ Mode nuit (ralentissement 23h-7h)');
console.log('   ├─ Gestion de présence (online/offline)');
console.log('   ├─ Messages variables (pool aléatoire)');
console.log('   ├─ Micro-pauses aléatoires (10% chance)');
console.log('   └─ Multi-sessions activé');

// Créer une session par défaut si aucune n'existe
if (Object.keys(sessionManager.sessionsList).length === 0) {
    console.log('📱 Création de la session initiale...');
    const defaultSession = sessionManager.createSession('session_default', 'Session principale');
    sessionManager.setActiveSession('session_default');
}

// Initialiser toutes les sessions
sessionManager.initializeAllSessions();

// Mettre à jour la variable client pour la compatibilité
const updateClientReference = () => {
    client = sessionManager.getActiveClient();
    if (client) {
        const activeSession = sessionManager.getSessionStatus(sessionManager.activeSessionId);
        isConnected = activeSession?.status === 'connected';
        currentQR = activeSession?.currentQR || null;
    } else {
        isConnected = false;
        currentQR = null;
    }
};

// Mettre à jour toutes les 5 secondes
setInterval(updateClientReference, 5000);
updateClientReference();
console.log('   ├─ Jitter sur les intervalles de scan');
console.log('   └─ 🗑️ Suppression V3 avec VÉRIFICATION post-delete');
console.log('');
console.log('📋 Commandes admin dans les groupes:');
console.log('   ├─ !scan        → Scanner le groupe actuel');
console.log('   ├─ !scanall     → Scanner tous les groupes');
console.log('   ├─ !diagdelete  → Diagnostic des méthodes de suppression');
console.log('   └─ !testdelete  → Tester la suppression sur un message du bot\n');