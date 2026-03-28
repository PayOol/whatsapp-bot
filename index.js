const { Client, LocalAuth, Buttons, List } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');

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

async function sendMessageHumanized(chat, text, options = {}, triggerMessageLength = 0) {
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
        addLog(`❌ Erreur envoi humanisé: ${error.message}`);
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

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
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
            '--disable-gpu',
            '--user-data-dir=/app/.wwebjs_auth'
        ]
    }
});

let currentQR = null;
let isConnected = false;

client.on('qr', (qr) => {
    currentQR = qr;
    isConnected = false;
    console.log('\n📱 Scannez ce QR code avec WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

// ============================================================
// 🔍 SCAN HUMANISÉ
// ============================================================

async function scanOldMessages(chat, limit = 100) {
    if (isGroupExcluded(chat)) {
        addLog(`🚫 Groupe ${chat.name} exclu`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    addLog(`🔍 Scan de ${chat.name}...`);

    const botId = client.info.wid._serialized;
    const participants = chat.participants || [];
    const botP = participants.find(p => p.id._serialized === botId);

    if (!botP || !botP.isAdmin) {
        addLog(`⚠️ Pas admin dans ${chat.name}`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    try { await chat.sendSeen(); } catch (e) {}
    await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(2000, 1000));

    const messages = await chat.fetchMessages({ limit });
    let deleted = 0, scanned = 0, warned = 0;

    let actionCount = 0;

    for (const message of messages) {
        if (message.fromMe) continue;
        scanned++;

        const msgId = message.id._serialized || message.id.id;
        if (isAlreadyProcessed(msgId)) continue;
        if (!containsLink(message)) continue;

        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) continue;
        if (isUserExcluded(authorId, participants)) continue;

        if (actionCount > 0) {
            await HumanBehavior.naturalDelay(HumanBehavior.interActionDelay());
        }
        actionCount++;

        if (actionCount > 0 && actionCount % 5 === 0) {
            const fatiguePause = HumanBehavior.gaussianRandom(8000, 4000);
            addLog(`😴 Pause fatigue: ${Math.round(fatiguePause / 1000)}s`);
            await HumanBehavior.naturalDelay(fatiguePause);
        }

        try {
            markAsProcessed(msgId);

            const contact = await message.getContact();
            const mention = `@${contact.number}`;
            const currentWarnings = getWarningCount(chat.id._serialized, authorId);

            // ══════ ÉTAPE 1 : SUPPRIMER D'ABORD ══════
            if (await deleteMessageHumanized(message)) {
                deleted++;
                STATS.totalDeleted++;
                addLog(`🗑️ Ancien message supprimé dans ${chat.name}`);
            }

            // ══════ ÉTAPE 2 : AVERTIR / BANNIR ENSUITE ══════
            if (currentWarnings >= CONFIG.MAX_WARNINGS) {
                try {
                    const banMsg = MessagePool.pick(
                        MessagePool.bans, mention, CONFIG.MAX_WARNINGS
                    );
                    await sendMessageHumanized(chat, banMsg, {
                        mentions: [contact.id._serialized]
                    }, message.body?.length || 0);

                    await HumanBehavior.naturalDelay(
                        HumanBehavior.gaussianRandom(2000, 800)
                    );
                    await chat.removeParticipants([authorId]);
                    rateLimiter.recordAction();

                    resetWarnings(chat.id._serialized, authorId);
                    STATS.totalBanned++;
                    addLog(`🚫 ${authorId} banni de ${chat.name}`);
                } catch (banError) {
                    addLog(`❌ Erreur ban: ${banError.message}`);
                }
            } else {
                const warningCount = addWarning(chat.id._serialized, authorId);
                warned++;
                STATS.totalWarnings++;

                if (warningCount >= CONFIG.MAX_WARNINGS) {
                    try {
                        const banMsg = MessagePool.pick(
                            MessagePool.bans, mention, CONFIG.MAX_WARNINGS
                        );
                        await sendMessageHumanized(chat, banMsg, {
                            mentions: [contact.id._serialized]
                        }, message.body?.length || 0);

                        await HumanBehavior.naturalDelay(
                            HumanBehavior.gaussianRandom(2000, 800)
                        );
                        await chat.removeParticipants([authorId]);
                        rateLimiter.recordAction();

                        resetWarnings(chat.id._serialized, authorId);
                        STATS.totalBanned++;
                        addLog(`🚫 ${authorId} banni de ${chat.name}`);
                    } catch (banError) {
                        addLog(`❌ Erreur ban: ${banError.message}`);
                    }
                } else {
                    const remaining = CONFIG.MAX_WARNINGS - warningCount;
                    const warnMsg = MessagePool.pick(
                        MessagePool.warnings, mention, warningCount,
                        CONFIG.MAX_WARNINGS, remaining
                    );
                    try {
                        await sendMessageHumanized(chat, warnMsg, {
                            mentions: [contact.id._serialized]
                        }, message.body?.length || 0);
                    } catch (warnError) {
                        console.error('Erreur avertissement:', warnError);
                    }
                }
            }
        } catch (error) {
            addLog(`⚠️ Erreur traitement: ${error.message}`);
        }
    }

    addLog(`✅ Scan ${chat.name}: ${scanned} scannés, ${deleted} supprimés, ${warned} avertis`);
    return { deleted, scanned, warned };
}

async function scanAllGroups() {
    addLog('🔍 ========== SCAN AUTOMATIQUE ==========');
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    addLog(`📊 ${groups.length} groupes détectés`);

    let totalDeleted = 0, totalScanned = 0, totalWarned = 0;

    const shuffled = groups.sort(() => Math.random() - 0.5);

    for (const group of shuffled) {
        const result = await scanOldMessages(group, CONFIG.SCAN_LIMIT);
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
// ✅ HANDLER READY
// ============================================================

client.on('ready', async () => {
    isConnected = true;
    currentQR = null;
    addLog('✅ Bot connecté et prêt!');
    addLog(`⚙️ Mode humain activé (délais gaussiens, typing, rate limit)`);
    addLog(`🗑️ Suppression V3 avec vérification post-delete`);

    restoreUnblockTimers();
    startPresenceManager();

    if (CONFIG.AUTO_SCAN_ENABLED) {
        const startupDelay = HumanBehavior.gaussianRandom(15000, 8000);
        addLog(`⏳ Premier scan dans ${Math.round(startupDelay / 1000)}s...`);
        await new Promise(r => setTimeout(r, startupDelay));
        try {
            await scanAllGroups();
        } catch (scanError) {
            addLog(`❌ Erreur scan initial: ${scanError.message}`);
        }
    }

    scheduleNextScan();
});

function scheduleNextScan() {
    const baseMs = CONFIG.AUTO_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;
    const jitter = HumanBehavior.gaussianRandom(0, baseMs * 0.2);
    const nextScanMs = baseMs + jitter;

    addLog(`⏰ Prochain scan dans ${Math.round(nextScanMs / 3600000 * 10) / 10}h`);

    setTimeout(async () => {
        if (CONFIG.AUTO_SCAN_ENABLED && isConnected) {
            addLog(`⏰ Scan automatique programmé...`);
            try {
                await scanAllGroups();
            } catch (scanError) {
                addLog(`❌ Erreur scan programmé: ${scanError.message}`);
            }
        }
        scheduleNextScan();
    }, nextScanMs);
}

// ============================================================
// 👤 GESTIONNAIRE DE PRÉSENCE
// ============================================================

function startPresenceManager() {
    async function togglePresence() {
        try {
            const hour = new Date().getHours();
            if (hour >= 1 && hour < 7) {
                await client.sendPresenceUnavailable();
                const offlineTime = HumanBehavior.gaussianRandom(3600000, 1800000);
                setTimeout(togglePresence, offlineTime);
                return;
            }

            await client.sendPresenceAvailable();
            const onlineTime = HumanBehavior.gaussianRandom(720000, 420000);

            setTimeout(async () => {
                try {
                    await client.sendPresenceUnavailable();
                    const offlineTime = HumanBehavior.gaussianRandom(360000, 240000);
                    setTimeout(togglePresence, offlineTime);
                } catch (e) {
                    setTimeout(togglePresence, 300000);
                }
            }, onlineTime);
        } catch (e) {
            setTimeout(togglePresence, 600000);
        }
    }

    setTimeout(togglePresence, HumanBehavior.gaussianRandom(30000, 15000));
}

// ============================================================
// 📩 HANDLER MESSAGE (TEMPS RÉEL)
// ============================================================

client.on('message', async (message) => {
    try {
        if (message.fromMe) return;
        const chat = await message.getChat();
        const senderId = message.author || message.from;

        // ✅ Réponse à un menu interactif (boutons natifs)
        if (message.type === 'buttons_response' || message.type === 'list_response') {
            const responseId = message.selectedButtonId || message.selectedRowId;
            if (responseId) {
                addLog(`📱 Réponse menu: ${responseId} de ${senderId}`);
                await handleMenuResponse(message, responseId);
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

            for (const sessionId in menuSessions) {
                const session = menuSessions[sessionId];

                if (session.expiresAt < Date.now()) {
                    delete menuSessions[sessionId];
                    continue;
                }

                if (sessionId.startsWith(chat.id._serialized)) {
                    if (!latestSession || session.createdAt > latestSession.createdAt) {
                        latestSession = session;
                        latestSessionId = sessionId;
                    }
                }
            }

            if (latestSession) {
                const items = latestSession.buttons || latestSession.rows || [];
                if (selectedNumber >= 1 && selectedNumber <= items.length) {
                    const selectedItem = items[selectedNumber - 1];
                    addLog(`📱 Réponse menu textuel: ${selectedNumber} (${selectedItem.text || selectedItem.title}) de ${senderId}`);

                    if (selectedItem.response) {
                        await sendMessageHumanized(chat, selectedItem.response, {}, messageText.length);
                    } else if (selectedItem.nextMenu) {
                        await sendInteractiveMenu(chat, selectedItem.nextMenu);
                    } else {
                        await sendMessageHumanized(chat, `✅ Vous avez sélectionné: ${selectedItem.text || selectedItem.title}`, {}, messageText.length);
                    }
                    return;
                }
            }
        }

        // ✅ Vérifier si le message déclenche un menu
        const triggerText = message.body.trim().toLowerCase();
        for (const menuId in interactiveMenus) {
            const menu = interactiveMenus[menuId];
            if (!menu.enabled || !menu.trigger) continue;
            if (menu.groupId && chat.id._serialized !== menu.groupId) continue;

            if (triggerText === menu.trigger.toLowerCase()) {
                addLog(`📱 Menu déclenché: ${menuId} par ${senderId}`);
                await sendInteractiveMenu(chat, menuId);
                return;
            }
        }

        // ✅ Seul le traitement des groupes continue
        if (!chat.isGroup) return;
        if (isGroupExcluded(chat)) return;

        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        const senderP = participants.find(p => p.id._serialized === senderId);

        // ✅ Commande !scan
        if (messageText === '!scan') {
            if (senderP?.isAdmin) {
                await sendMessageHumanized(chat, '🔍 Scan en cours...', {}, message.body.length);
                const result = await scanOldMessages(chat, CONFIG.SCAN_LIMIT);
                await sendMessageHumanized(
                    chat,
                    `✅ Scan terminé: ${result.scanned} scannés, ${result.deleted} supprimés.`,
                    {}, 20
                );
            }
            return;
        }

        // ✅ Commande !scanall
        if (messageText === '!scanall') {
            if (senderP?.isAdmin) {
                await sendMessageHumanized(chat, '🔍 Scan global en cours...', {}, message.body.length);
                const result = await scanAllGroups();
                await sendMessageHumanized(
                    chat,
                    `✅ Scan global terminé: ${result.totalScanned} scannés, ${result.totalDeleted} supprimés.`,
                    {}, 25
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
                    addLog(`🔬 Diagnostic envoyé dans ${chat.name}`);
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
        if (isAlreadyProcessed(msgId)) return;
        markAsProcessed(msgId);

        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) return;
        if (isUserExcluded(authorId, participants)) return;

        // ✅ Marquer comme lu
        try { await chat.sendSeen(); } catch (e) {}

        const contact = await message.getContact();
        const mention = `@${contact.number}`;
        const warningCount = addWarning(chat.id._serialized, authorId);
        const remaining = CONFIG.MAX_WARNINGS - warningCount;
        STATS.totalWarnings++;

        // ══════════════════════════════════════════════════════
        // ÉTAPE 1 : SUPPRIMER D'ABORD (contenu nuisible)
        // ══════════════════════════════════════════════════════
        const messageBodyLength = message.body?.length || 0;
        const wasDeleted = await deleteMessageHumanized(message);
        if (wasDeleted) {
            STATS.totalDeleted++;
            addLog(`🗑️ Message supprimé de ${authorId} dans ${chat.name}`);
        }

        // ══════════════════════════════════════════════════════
        // ÉTAPE 2 : AVERTIR OU BANNIR ENSUITE
        // ══════════════════════════════════════════════════════
        if (warningCount >= CONFIG.MAX_WARNINGS) {
            try {
                const banMsg = MessagePool.pick(
                    MessagePool.bans, mention, CONFIG.MAX_WARNINGS
                );
                await sendMessageHumanized(chat, banMsg, {
                    mentions: [contact.id._serialized]
                }, messageBodyLength);

                await HumanBehavior.naturalDelay(
                    HumanBehavior.gaussianRandom(2500, 1000)
                );
                await chat.removeParticipants([authorId]);
                rateLimiter.recordAction();

                resetWarnings(chat.id._serialized, authorId);
                STATS.totalBanned++;
                addLog(`🚫 ${authorId} banni de ${chat.name}`);
            } catch (banError) {
                addLog(`❌ Erreur ban: ${banError.message}`);
                await sendMessageHumanized(chat,
                    `⚠️ ${mention} a atteint la limite mais je n'ai pas pu le bannir.`,
                    { mentions: [contact.id._serialized] },
                    10
                );
            }
        } else {
            const warnMsg = MessagePool.pick(
                MessagePool.warnings, mention, warningCount,
                CONFIG.MAX_WARNINGS, remaining
            );
            await sendMessageHumanized(chat, warnMsg, {
                mentions: [contact.id._serialized]
            }, messageBodyLength);
            addLog(`⚠️ Avertissement ${warningCount}/${CONFIG.MAX_WARNINGS} pour ${authorId} dans ${chat.name}`);
        }
    } catch (error) {
        console.error('Erreur traitement message:', error);
    }
});

// ============================================================
// 👋 HANDLER BIENVENUE
// ============================================================

const WELCOME_MESSAGE_EXCLUDED = `👋 Bienvenue {mention} dans *{group}* !

🎉 Content de te voir parmi nous !

N'hésite pas à participer et à partager.

Bonne discussion ! 🙌`;

client.on('group_join', async (notification) => {
    try {
        if (!CONFIG.WELCOME_ENABLED) return;

        const chat = await notification.getChat();
        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        if (GROUP_EXCEPTIONS.excludedWelcome.includes(chat.id._serialized)) {
            addLog(`🔇 Bienvenue désactivé pour ${chat.name}`);
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

        const isExcluded = isGroupExcluded(chat);

        const welcomeMessage = (isExcluded ? WELCOME_MESSAGE_EXCLUDED : CONFIG.WELCOME_MESSAGE)
            .replace(/{mention}/g, mention)
            .replace(/{group}/g, chat.name)
            .replace(/{maxWarnings}/g, CONFIG.MAX_WARNINGS);

        await sendMessageHumanized(chat, welcomeMessage, {
            mentions: [contact.id._serialized]
        }, 0);

        addLog(`👋 Bienvenue envoyé à ${contact.number} dans ${chat.name}${isExcluded ? ' (groupe exclu)' : ''}`);
    } catch (error) {
        addLog(`❌ Erreur bienvenue: ${error.message}`);
    }
});

// ============================================================
// 📞 HANDLER APPELS
// ============================================================

client.on('call', async (call) => {
    try {
        if (!CONFIG.CALL_REJECT_ENABLED) return;

        const callerId = call.from;
        addLog(`📞 Appel entrant de ${callerId}`);

        let callerNumber = callerId.split('@')[0];
        try {
            const contact = await client.getContactById(callerId);
            if (contact && contact.number) {
                callerNumber = contact.number;
                addLog(`📱 Numéro associé: ${callerNumber}`);
            }
        } catch (e) {}

        if (isUserExcludedFromCalls(callerId, callerNumber)) {
            addLog(`✅ ${callerNumber} exempté du rejet d'appels - appel ignoré`);
            return;
        }

        if (blockedUsers[callerId]) {
            try {
                const contact = await client.getContactById(callerId);
                if (contact.isBlocked) {
                    addLog(`⛔ ${callerId} déjà bloqué`);
                    await HumanBehavior.naturalDelay(HumanBehavior.callRejectDelay());
                    try { await call.reject(); } catch (e) {}
                    return;
                } else {
                    addLog(`🔓 ${callerId} débloqué manuellement, mise à jour`);
                    delete blockedUsers[callerId];
                    delete callSpamTracker[callerId];
                    if (unblockTimers[callerId]) {
                        clearTimeout(unblockTimers[callerId]);
                        delete unblockTimers[callerId];
                    }
                    saveCallSpamData();
                }
            } catch (e) {
                addLog(`⚠️ Erreur vérification blocage: ${e.message}`);
            }
        }

        try {
            await call.reject();
            addLog(`🚫 Appel rejeté: ${callerId}`);
            STATS.totalCallsRejected++;
            rateLimiter.recordAction();
        } catch (rejectError) {
            addLog(`⚠️ Erreur rejet appel: ${rejectError.message}`);
        }

        const callCount = addCall(callerId);
        addLog(`📊 ${callerId}: ${callCount}/${CONFIG.CALL_SPAM_THRESHOLD} appels`);

        if (callCount >= CONFIG.CALL_SPAM_THRESHOLD) {
            addLog(`🚫 SPAM: ${callerId} — ${callCount} appels → BLOCAGE`);

            try {
                const postCallDelay = HumanBehavior.postCallMessageDelay();
                await HumanBehavior.naturalDelay(postCallDelay);

                const chat = await client.getChatById(callerId);
                const blockMsg = MessagePool.pick(MessagePool.callBlocked);
                await sendMessageHumanized(chat, blockMsg, {}, 0);
            } catch (msgError) {
                addLog(`⚠️ Message pré-blocage échoué: ${msgError.message}`);
            }

            await HumanBehavior.naturalDelay(HumanBehavior.blockDelay());

            try {
                const contact = await client.getContactById(callerId);
                await contact.block();
                rateLimiter.recordAction();

                blockedUsers[callerId] = {
                    blockedAt: Date.now(),
                    autoUnblock: true,
                    callCount: callCount
                };
                saveCallSpamData();
                addLog(`🔒 ${callerId} bloqué pour spam d'appels`);

                const blockDuration = CONFIG.CALL_BLOCK_DURATION_MIN * 60 * 1000;
                scheduleUnblock(callerId, blockDuration);

            } catch (blockError) {
                addLog(`❌ Erreur blocage: ${blockError.message}`);
            }
            return;
        }

        const msgDelay = HumanBehavior.postCallMessageDelay();
        addLog(`⏳ Message dans ${Math.round(msgDelay / 1000)}s...`);
        await HumanBehavior.naturalDelay(msgDelay);

        try {
            const chat = await client.getChatById(callerId);
            const remaining = CONFIG.CALL_SPAM_THRESHOLD - callCount;
            const rejectMsg = MessagePool.pick(
                MessagePool.callRejections, remaining
            );
            await sendMessageHumanized(chat, rejectMsg, {}, 0);
            addLog(`💬 Message envoyé à ${callerId}`);
        } catch (msgError) {
            addLog(`❌ Erreur message post-appel: ${msgError.message}`);
        }

    } catch (error) {
        addLog(`❌ Erreur handler appel: ${error.message}`);
    }
});

// ============================================================
// 🔌 ÉVÉNEMENTS CONNEXION
// ============================================================

client.on('auth_failure', (msg) => addLog(`❌ Échec auth: ${msg}`));
client.on('disconnected', (reason) => {
    isConnected = false;
    addLog(`🔌 Déconnecté: ${reason}`);
});

// ============================================================
// 🌐 SERVEUR WEB EXPRESS
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => res.json({ connected: isConnected, qr: currentQR }));

app.get('/api/config', (req, res) => res.json({
    MAX_WARNINGS: CONFIG.MAX_WARNINGS,
    WARNING_EXPIRY_HOURS: CONFIG.WARNING_EXPIRY_HOURS,
    SCAN_LIMIT: CONFIG.SCAN_LIMIT,
    AUTO_SCAN_INTERVAL_HOURS: CONFIG.AUTO_SCAN_INTERVAL_HOURS,
    DELAY_BETWEEN_ACTIONS_MIN: CONFIG.DELAY_BETWEEN_ACTIONS_MIN,
    DELAY_BETWEEN_ACTIONS_MAX: CONFIG.DELAY_BETWEEN_ACTIONS_MAX,
    WELCOME_MESSAGE: CONFIG.WELCOME_MESSAGE,
    WELCOME_ENABLED: CONFIG.WELCOME_ENABLED,
    AUTO_SCAN_ENABLED: CONFIG.AUTO_SCAN_ENABLED,
    CALL_REJECT_ENABLED: CONFIG.CALL_REJECT_ENABLED,
    CALL_SPAM_THRESHOLD: CONFIG.CALL_SPAM_THRESHOLD,
    CALL_SPAM_WINDOW_MIN: CONFIG.CALL_SPAM_WINDOW_MIN,
    CALL_BLOCK_DURATION_MIN: CONFIG.CALL_BLOCK_DURATION_MIN
}));

app.post('/api/config', (req, res) => {
    try {
        const nc = req.body;
        if (nc.MAX_WARNINGS !== undefined) CONFIG.MAX_WARNINGS = parseInt(nc.MAX_WARNINGS);
        if (nc.WARNING_EXPIRY_HOURS !== undefined) CONFIG.WARNING_EXPIRY_HOURS = parseInt(nc.WARNING_EXPIRY_HOURS);
        if (nc.SCAN_LIMIT !== undefined) CONFIG.SCAN_LIMIT = parseInt(nc.SCAN_LIMIT);
        if (nc.AUTO_SCAN_INTERVAL_HOURS !== undefined) CONFIG.AUTO_SCAN_INTERVAL_HOURS = parseInt(nc.AUTO_SCAN_INTERVAL_HOURS);
        if (nc.DELAY_BETWEEN_ACTIONS_MIN !== undefined) CONFIG.DELAY_BETWEEN_ACTIONS_MIN = parseInt(nc.DELAY_BETWEEN_ACTIONS_MIN);
        if (nc.DELAY_BETWEEN_ACTIONS_MAX !== undefined) CONFIG.DELAY_BETWEEN_ACTIONS_MAX = parseInt(nc.DELAY_BETWEEN_ACTIONS_MAX);
        if (nc.WELCOME_MESSAGE !== undefined) CONFIG.WELCOME_MESSAGE = nc.WELCOME_MESSAGE;
        if (nc.WELCOME_ENABLED !== undefined) CONFIG.WELCOME_ENABLED = nc.WELCOME_ENABLED;
        if (nc.AUTO_SCAN_ENABLED !== undefined) CONFIG.AUTO_SCAN_ENABLED = nc.AUTO_SCAN_ENABLED;
        if (nc.CALL_REJECT_ENABLED !== undefined) CONFIG.CALL_REJECT_ENABLED = nc.CALL_REJECT_ENABLED;
        if (nc.CALL_SPAM_THRESHOLD !== undefined) CONFIG.CALL_SPAM_THRESHOLD = parseInt(nc.CALL_SPAM_THRESHOLD);
        if (nc.CALL_SPAM_WINDOW_MIN !== undefined) CONFIG.CALL_SPAM_WINDOW_MIN = parseInt(nc.CALL_SPAM_WINDOW_MIN);
        if (nc.CALL_BLOCK_DURATION_MIN !== undefined) CONFIG.CALL_BLOCK_DURATION_MIN = parseInt(nc.CALL_BLOCK_DURATION_MIN);
        saveConfig();
        addLog('⚙️ Configuration mise à jour');
        res.json({ success: true, message: 'Configuration enregistrée' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        if (isConnected) {
            const chats = await client.getChats();
            let adminCount = 0;
            for (const g of chats.filter(c => c.isGroup)) {
                const bp = g.participants?.find(p => p.id._serialized === client.info.wid._serialized);
                if (bp?.isAdmin) adminCount++;
            }
            STATS.adminGroups = adminCount;
        }
        res.json(STATS);
    } catch (error) { res.json(STATS); }
});

app.get('/api/logs', (req, res) => {
    const formattedLogs = LOGS.map(log => {
        if (typeof log === 'string') return log;
        return `[${log.display}] ${log.message}`;
    });
    res.json(formattedLogs);
});

app.get('/api/stats/groups', async (req, res) => {
    try {
        if (!isConnected) return res.json({ groups: [] });
        const chats = await client.getChats();
        const groups = [];
        for (const g of chats.filter(c => c.isGroup)) {
            const bp = g.participants?.find(p => p.id._serialized === client.info.wid._serialized);
            if (bp?.isAdmin) {
                groups.push({
                    name: g.name,
                    id: g.id._serialized,
                    participants: g.participants?.length || 0
                });
            }
        }
        res.json({ groups, total: groups.length });
    } catch (error) { res.json({ groups: [], total: 0 }); }
});

app.get('/api/stats/deleted', (req, res) => {
    const deletedLogs = LOGS.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('supprimé') || msg.includes('Supprimé');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ total: STATS.totalDeleted, recent: deletedLogs.slice(-20).reverse() });
});

app.get('/api/stats/warnings', (req, res) => {
    const warningLogs = LOGS.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('avertissement') || msg.includes('Avertissement');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ total: STATS.totalWarnings, recent: warningLogs.slice(-20).reverse() });
});

app.get('/api/stats/banned', (req, res) => {
    const bannedLogs = LOGS.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('banni') || msg.includes('Banni') || msg.includes('bloqué');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ total: STATS.totalBanned, recent: bannedLogs.slice(-20).reverse() });
});

app.get('/api/stats/calls', (req, res) => {
    const callLogs = LOGS.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('Appel') || msg.includes('appel') || msg.includes('rejeté');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ total: STATS.totalCallsRejected, recent: callLogs.slice(-20).reverse() });
});

app.post('/api/scan', async (req, res) => {
    try {
        if (!isConnected) return res.status(400).json({ success: false, message: 'Bot non connecté' });
        addLog('🔍 Scan manuel via interface');
        const result = await scanAllGroups();
        res.json({ success: true, ...result });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/warnings', (req, res) => {
    try {
        fs.writeFileSync(WARNINGS_FILE, JSON.stringify({}));
        addLog('🗑️ Avertissements effacés');
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/groups', async (req, res) => {
    try {
        if (!isConnected) return res.json([]);
        const chats = await client.getChats();
        res.json(chats.filter(c => c.isGroup).map(g => {
            const bp = g.participants?.find(p => p.id._serialized === client.info.wid._serialized);
            return {
                id: g.id._serialized, name: g.name,
                participants: g.participants?.length || 0,
                isAdmin: bp?.isAdmin || false,
                isExcluded: GROUP_EXCEPTIONS.excludedGroups.includes(g.id._serialized)
            };
        }).filter(g => g.isAdmin));
    } catch (error) { res.status(500).json([]); }
});

app.get('/api/groups/all', async (req, res) => {
    try {
        if (!isConnected) {
            addLog('⚠️ /api/groups/all: Bot non connecté');
            return res.json([]);
        }
        const chats = await client.getChats();
        const botId = client.info.wid._serialized;
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
        
        addLog(`📋 /api/groups/all: ${groups.length} groupes trouvés`);
        res.json(groups);
    } catch (error) {
        addLog(`❌ Erreur /api/groups/all: ${error.message}`);
        res.status(500).json([]);
    }
});

app.post('/api/groups/leave', async (req, res) => {
    try {
        if (!isConnected) return res.status(400).json({ success: false, message: 'Bot non connecté' });
        const { groupId } = req.body;
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        const chat = await client.getChatById(groupId);
        if (!chat || !chat.isGroup) return res.status(404).json({ success: false, message: 'Groupe non trouvé' });

        const groupName = chat.name;
        await chat.leave();
        
        // Supprimer le chat de la liste locale pour forcer le rafraîchissement
        try {
            await chat.delete();
        } catch (e) {
            // Ignore si non supporté
        }
        
        addLog(`🚪 Bot a quitté le groupe: ${groupName}`);
        res.json({ success: true, message: 'Groupe quitté' });
    } catch (error) {
        addLog(`❌ Erreur quitter groupe: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/groups/delete', async (req, res) => {
    try {
        if (!isConnected) return res.status(400).json({ success: false, message: 'Bot non connecté' });
        const { groupId } = req.body;
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        const chat = await client.getChatById(groupId);
        if (!chat || !chat.isGroup) return res.status(404).json({ success: false, message: 'Groupe non trouvé' });

        const botParticipant = chat.participants?.find(p => p.id._serialized === client.info.wid._serialized);
        if (!botParticipant?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Le bot doit être admin pour supprimer ce groupe' });
        }

        // Pour supprimer un groupe, il faut d'abord retirer tous les membres puis le supprimer
        // Malheureusement wweb.js ne supporte pas la suppression directe de groupe
        // On peut seulement le quitter
        await chat.leave();
        addLog(`🗑️ Groupe supprimé (bot était admin): ${chat.name}`);
        res.json({ success: true, message: 'Groupe quitté (suppression complète non supportée par l\'API)' });
    } catch (error) {
        addLog(`❌ Erreur suppression groupe: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/groups/exceptions', (req, res) => res.json(GROUP_EXCEPTIONS));
app.post('/api/groups/exceptions', (req, res) => {
    try {
        const { groupId, pattern } = req.body;
        if (groupId && !GROUP_EXCEPTIONS.excludedGroups.includes(groupId)) GROUP_EXCEPTIONS.excludedGroups.push(groupId);
        if (pattern && !GROUP_EXCEPTIONS.excludedPatterns.includes(pattern)) GROUP_EXCEPTIONS.excludedPatterns.push(pattern);
        saveGroupExceptions();
        res.json({ success: true, exceptions: GROUP_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/groups/exceptions', (req, res) => {
    try {
        const { groupId, pattern } = req.body;
        if (groupId) GROUP_EXCEPTIONS.excludedGroups = GROUP_EXCEPTIONS.excludedGroups.filter(id => id !== groupId);
        if (pattern) GROUP_EXCEPTIONS.excludedPatterns = GROUP_EXCEPTIONS.excludedPatterns.filter(p => p !== pattern);
        saveGroupExceptions();
        res.json({ success: true, exceptions: GROUP_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/groups/welcome', (req, res) => {
    try {
        const { groupId, enabled } = req.body;
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        if (enabled === false) {
            if (!GROUP_EXCEPTIONS.excludedWelcome.includes(groupId)) {
                GROUP_EXCEPTIONS.excludedWelcome.push(groupId);
            }
        } else {
            GROUP_EXCEPTIONS.excludedWelcome = GROUP_EXCEPTIONS.excludedWelcome.filter(id => id !== groupId);
        }

        saveGroupExceptions();
        res.json({ success: true, exceptions: GROUP_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/users/exceptions', (req, res) => res.json(USER_EXCEPTIONS));

app.post('/api/users/exceptions', (req, res) => {
    try {
        const { userId, linkException, callException } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'userId requis' });

        let userEntry = USER_EXCEPTIONS.excludedUsers.find(u => u.id === userId);

        if (userEntry) {
            if (linkException !== undefined) userEntry.linkException = linkException;
            if (callException !== undefined) userEntry.callException = callException;
        } else {
            USER_EXCEPTIONS.excludedUsers.push({
                id: userId,
                linkException: linkException === true,
                callException: callException === true
            });
        }

        saveUserExceptions();
        res.json({ success: true, exceptions: USER_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/users/exceptions', (req, res) => {
    try {
        const { userId } = req.body;
        USER_EXCEPTIONS.excludedUsers = USER_EXCEPTIONS.excludedUsers.filter(u => u.id !== userId);
        saveUserExceptions();
        res.json({ success: true, exceptions: USER_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/users/exceptions/admins', (req, res) => {
    try {
        USER_EXCEPTIONS.excludedAdmins = req.body.excludedAdmins;
        saveUserExceptions();
        res.json({ success: true, exceptions: USER_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ API BLOCAGE APPELS ============

app.get('/api/blocked', (req, res) => res.json(blockedUsers));

app.post('/api/blocked/unblock', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!blockedUsers[userId]) return res.status(404).json({ success: false, message: 'Non bloqué' });

        const contact = await client.getContactById(userId);
        await contact.unblock();

        if (unblockTimers[userId]) {
            clearTimeout(unblockTimers[userId]);
            delete unblockTimers[userId];
        }

        delete blockedUsers[userId];
        delete callSpamTracker[userId];
        saveCallSpamData();

        addLog(`🔓 ${userId} débloqué manuellement`);
        res.json({ success: true, message: 'Débloqué' });
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
    res.json(interactiveMenus);
});

app.get('/api/menus/:id', (req, res) => {
    const menu = interactiveMenus[req.params.id];
    if (!menu) return res.status(404).json({ success: false, message: 'Menu non trouvé' });
    res.json(menu);
});

app.post('/api/menus', (req, res) => {
    try {
        const menu = createMenu(req.body);
        addLog(`📱 Menu créé: ${menu.id}`);
        res.json({ success: true, menu });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/menus/:id', (req, res) => {
    try {
        const menuId = req.params.id;
        if (!interactiveMenus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        interactiveMenus[menuId] = {
            ...interactiveMenus[menuId],
            ...req.body,
            id: menuId
        };
        saveMenus();
        addLog(`📝 Menu mis à jour: ${menuId}`);
        res.json({ success: true, menu: interactiveMenus[menuId] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/menus/:id', (req, res) => {
    try {
        const menuId = req.params.id;
        if (!interactiveMenus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        delete interactiveMenus[menuId];
        saveMenus();
        addLog(`🗑️ Menu supprimé: ${menuId}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/menus/:id/test', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ success: false, message: 'Bot non connecté' });
        }

        const menuId = req.params.id;
        const { groupId } = req.body;

        if (!interactiveMenus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        const chats = await client.getChats();
        let targetChat;

        if (groupId) {
            targetChat = chats.find(c => c.id._serialized === groupId);
        } else {
            targetChat = chats.find(c => {
                if (!c.isGroup) return false;
                const bp = c.participants?.find(p => p.id._serialized === client.info.wid._serialized);
                return bp?.isAdmin;
            });
        }

        if (!targetChat) {
            return res.status(400).json({ success: false, message: 'Aucun groupe disponible' });
        }

        await sendInteractiveMenu(targetChat, menuId);
        addLog(`🧪 Menu testé: ${menuId} dans ${targetChat.name}`);
        res.json({ success: true, groupName: targetChat.name });
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
console.log('   ├─ Jitter sur les intervalles de scan');
console.log('   └─ 🗑️ Suppression V3 avec VÉRIFICATION post-delete');
console.log('');
console.log('📋 Commandes admin dans les groupes:');
console.log('   ├─ !scan        → Scanner le groupe actuel');
console.log('   ├─ !scanall     → Scanner tous les groupes');
console.log('   ├─ !diagdelete  → Diagnostic des méthodes de suppression');
console.log('   └─ !testdelete  → Tester la suppression sur un message du bot\n');

client.initialize();