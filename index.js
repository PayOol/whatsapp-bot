const { Client, LocalAuth, Buttons, List, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { ensureOgImage, captureLandingPage, isOgImageValid, OUTPUT_PATH } = require('./og-screenshot');

// ============================================================
// 📁 FICHIERS DE STOCKAGE
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');

// Configuration globale pour le mode Beta
const BETA_MODE_FILE = path.join(DATA_DIR, 'beta_mode.json');
let betaMode = false;

// Charger le mode Beta depuis le fichier
function loadBetaMode() {
    try {
        if (fs.existsSync(BETA_MODE_FILE)) {
            const data = JSON.parse(fs.readFileSync(BETA_MODE_FILE, 'utf8'));
            betaMode = !!data.enabled;
        }
    } catch (e) {
        console.error('Erreur chargement beta mode:', e);
        betaMode = false;
    }
}

// Sauvegarder le mode Beta dans le fichier
function saveBetaMode() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(BETA_MODE_FILE, JSON.stringify({ enabled: betaMode }, null, 2));
    } catch (e) {
        console.error('Erreur sauvegarde beta mode:', e);
    }
}

// Charger le mode Beta au démarrage
loadBetaMode();

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
        (remaining) =>
            `📵 Je ne réponds pas aux appels. Écrivez-moi un message.\n⏳ Plus que ${remaining} tentative(s) avant un blocage de 30 min.`,
        (remaining) =>
            `🔇 Appel refusé automatiquement. Contactez-moi par écrit.\n⚠️ ${remaining} essai(s) restant(s) avant blocage.`,
        (remaining) =>
            `❌ Les appels ne sont pas pris en charge ici.\n📩 Envoyez un message. ${remaining} appel(s) avant blocage temporaire.`,
        (remaining) =>
            `🚫 Appel rejeté. Merci d'utiliser les messages.\n🔒 Encore ${remaining} appel(s) et votre contact sera bloqué 30 min.`,
        (remaining) =>
            `📞❌ Les appels sont désactivés. Préférez un message texte svp.\n⚠️ ${remaining} tentative(s) restante(s) avant suspension temporaire.`,
    ],

    callBlocked: [
        `🔒 Vous avez été bloqué(e) pendant 30 minutes suite à des appels répétés. Merci de patienter.`,
        `⛔ Blocage temporaire de 30 minutes pour spam d'appels. Envoyez un message après.`,
        `🚫 Trop d'appels. Vous êtes bloqué(e) pour 30 minutes.`,
        `📵 Votre contact a été temporairement bloqué (30 min) à cause d'appels répétés. Revenez plus tard.`,
        `🔇 Blocage automatique activé pour 30 minutes. Raison : appels en excès.`,
        `⏳ Suite à vos appels répétés, vous êtes bloqué(e) pendant 30 minutes. Envoyez un message ensuite.`,
        `🚫 Appels excessifs détectés. Blocage temporaire de 30 min en cours. Merci de patienter.`,
        `⛔ Vous avez dépassé la limite d'appels autorisée. Contact bloqué pour 30 minutes.`,
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
            addLog(`[WAIT] Rate limiter : pause de ${Math.round(waitTime / 1000)}s`);
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

        const typingTime = HumanBehavior.typingDuration(typeof text === 'string' ? text.length : (options.caption?.length || 20));
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
            sessionData.addLog(`[X] Erreur envoi humanise: ${error.message}`);
        } else {
            addLog(`[X] Erreur envoi humanise: ${error.message}`);
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

        // ⚠️ Multi-session : récupérer le client de la session du message
        // (la variable globale `client` peut être null ou pointer vers une autre session)
        const msgClient = message.client || client;
        if (!msgClient || !msgClient.pupPage) {
            addLog(`[X] deleteMessageHumanized: client/pupPage indisponible pour ${msgId}`);
            return false;
        }

        // ──────────────────────────────────────────────
        // DIAGNOSTIC (une seule fois au 1er appel)
        // Trouve les VRAIES méthodes de suppression
        // ──────────────────────────────────────────────
        if (!global.__deleteMethodsDiag) {
            global.__deleteMethodsDiag = true;
            try {
                const diag = await msgClient.pupPage.evaluate(() => {
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

                addLog(`DIAGNOSTIC SUPPRESSION`);
                addLog(`Store: ${JSON.stringify(diag.store)}`);
                addLog(`Chat proto: ${JSON.stringify(diag.chat)}`);
                addLog(`Msg proto: ${JSON.stringify(diag.msg)}`);
                addLog(`WWebJS: ${JSON.stringify(diag.wwebjs)}`);
                addLog(`==========================================`);
            } catch (e) {
                addLog(`Diagnostic echoue: ${e.message}`);
            }
        }

        // Helper : vérifier si le message est réellement supprimé
        const isMessageRevoked = async () => {
            try {
                const status = await msgClient.pupPage.evaluate((id) => {
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
            addLog(`T1: message.delete(true)...`);
            await message.delete(true);
            await new Promise(r => setTimeout(r, 2000));

            if (await isMessageRevoked()) {
                addLog(`[OK] Supprime pour TOUS via message.delete(true)`);
                rateLimiter.recordAction();
                return true;
            }
            addLog(`[!] T1: message.delete(true) execute mais message toujours la`);
        } catch (e) {
            addLog(`[!] T1 erreur: ${e.message}`);
        }

        // ══════════════════════════════════════════════
        // TENTATIVE 2 : Evaluate direct avec TOUTES
        // les signatures connues + vérification
        // ══════════════════════════════════════════════
        try {
            addLog(`T2: evaluate multi-methodes...`);

            const result = await msgClient.pupPage.evaluate(async (id) => {
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

            addLog(`T2 resultat: ${JSON.stringify(result)}`);

            if (result.status === 'OK') {
                addLog(`[OK] Supprime pour TOUS via ${result.method}`);
                rateLimiter.recordAction();
                return true;
            }

            if (result.log) {
                for (const entry of result.log) {
                    addLog(`   |- ${entry.name}: ${entry.ok ? 'appele' : 'erreur'} -> ${entry.revoked ? 'REVOQUE [OK]' : entry.err || 'pas revoque'}`);
                }
            }
        } catch (e) {
            addLog(`[!] T2 erreur: ${e.message}`);
        }

        // ══════════════════════════════════════════════
        // TENTATIVE 3 : Re-fetch message + delete
        // ══════════════════════════════════════════════
        try {
            addLog(`T3: re-fetch + delete...`);
            const chat = await message.getChat();
            const messages = await chat.fetchMessages({ limit: 50 });
            const target = messages.find(m => m.id._serialized === msgId);

            if (target) {
                await target.delete(true);
                await new Promise(r => setTimeout(r, 2000));

                if (await isMessageRevoked()) {
                    addLog(`[OK] Supprime pour TOUS via re-fetch + delete`);
                    rateLimiter.recordAction();
                    return true;
                }
                addLog(`[!] T3: re-fetch delete execute mais message toujours la`);
            } else {
                addLog(`[!] T3: message non trouve dans les 50 derniers`);
            }
        } catch (e) {
            addLog(`[!] T3 erreur: ${e.message}`);
        }

        // ══════════════════════════════════════════════
        // TENTATIVE 4 : Protocole brut via sendRevoke
        // ══════════════════════════════════════════════
        try {
            addLog(`T4: protocole brut...`);

            const result4 = await msgClient.pupPage.evaluate(async (id) => {
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

            addLog(`T4 resultat: ${JSON.stringify(result4)}`);

            if (result4.revoked) {
                addLog(`[OK] Supprime pour TOUS via protocole brut`);
                rateLimiter.recordAction();
                return true;
            }
        } catch (e) {
            addLog(`[!] T4 erreur: ${e.message}`);
        }

        addLog(`[X] ECHEC TOTAL: message ${msgId} NON supprime pour les autres`);
        return false;

    } catch (error) {
        addLog(`[X] Erreur suppression: ${error.message}`);
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
    DELETE_STATUS_MENTIONS: true, // Supprimer automatiquement les notifications de statut dans les groupes
    WELCOME_MESSAGE: `👋 Bienvenue {mention} dans *{group}* !

📜 *Règles importantes:*
• Les liens ne sont pas autorisés dans ce groupe
• Tout lien partagé sera automatiquement supprimé
• Après {maxWarnings} avertissements, vous serez banni du groupe

Merci de respecter ces règles. Bonne discussion ! 🎉`
};

// ============================================================
// 🔐 SYSTÈME D'AUTHENTIFICATION
// ============================================================

const AUTH_USERS_FILE = path.join(DATA_DIR, 'users_auth.json');
const AUTH_ADMIN_FILE = path.join(DATA_DIR, 'admin_auth.json');
const AUTH_SESSIONS_FILE = path.join(DATA_DIR, 'user_sessions.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'suggestions.json');
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
const SUBSCRIPTION_SETTINGS_FILE = path.join(DATA_DIR, 'subscription_settings.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_EXPIRY_HOURS = 24;

// ============================================================
// 💰 SYSTÈME D'ABONNEMENT (LeekPay)
// ============================================================

const DEFAULT_SUBSCRIPTION_SETTINGS = {
    enabled: false,
    apiKey: '',
    amount: 5000,
    currency: 'XOF',
    durationDays: 30,
    description: 'Abonnement PayOol Bot',
    trialEnabled: false,
    trialDurationDays: 0,
    siteUrl: '',
    detectedSiteUrl: ''
};

let subscriptionSettings = { ...DEFAULT_SUBSCRIPTION_SETTINGS };
let subscriptions = {};

function loadSubscriptionSettings() {
    try {
        if (fs.existsSync(SUBSCRIPTION_SETTINGS_FILE)) {
            subscriptionSettings = { ...DEFAULT_SUBSCRIPTION_SETTINGS, ...JSON.parse(fs.readFileSync(SUBSCRIPTION_SETTINGS_FILE, 'utf8')) };
        }
    } catch (e) {
        console.error('Erreur chargement paramètres abonnement:', e);
    }
}

function saveSubscriptionSettings() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SUBSCRIPTION_SETTINGS_FILE, JSON.stringify(subscriptionSettings, null, 2));
    } catch (e) {
        console.error('Erreur sauvegarde paramètres abonnement:', e);
    }
}

function loadSubscriptions() {
    try {
        if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
            subscriptions = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Erreur chargement abonnements:', e);
    }
}

function saveSubscriptions() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
    } catch (e) {
        console.error('Erreur sauvegarde abonnements:', e);
    }
}

function getUserSubscription(username) {
    return subscriptions[username] || null;
}

function isSubscriptionActive(username) {
    if (!subscriptionSettings.enabled) return true;
    
    const sub = subscriptions[username];
    if (!sub) return false;
    
    if (sub.status === 'active' && sub.expiresAt > Date.now()) return true;
    
    if (sub.status === 'active' && sub.expiresAt <= Date.now()) {
        sub.status = 'expired';
        saveSubscriptions();
    }
    
    return false;
}

function activateSubscription(username, paymentId, amount, currency) {
    const now = Date.now();
    const durationMs = subscriptionSettings.durationDays * 24 * 60 * 60 * 1000;
    
    const existing = subscriptions[username];
    let expiresAt;
    
    if (existing && existing.status === 'active' && existing.expiresAt > now) {
        expiresAt = existing.expiresAt + durationMs;
    } else {
        expiresAt = now + durationMs;
    }
    
    subscriptions[username] = {
        status: 'active',
        paymentId,
        amount,
        currency,
        activatedAt: now,
        expiresAt,
        history: [
            ...(existing?.history || []),
            { paymentId, amount, currency, date: now }
        ]
    };
    
    saveSubscriptions();
    addLog(`[SUB] Abonnement activé pour ${username} (paiement: ${paymentId}, expire: ${new Date(expiresAt).toLocaleDateString()})`);
    return subscriptions[username];
}


// Suivi des étapes de notification par session: 0=rien, 1=notifié, 2=averti, 3=déconnecté
const subWarningState = {};
// Suivi des rappels d'expiration envoyés (éviter de spammer)
const expiryReminderSent = {};

async function checkSubscriptions() {
    if (!subscriptionSettings.enabled) return { notified: 0, warned: 0, disconnected: 0, skipped: 0, errors: 0, reminders: 0 };
    
    let notified = 0, warned = 0, disconnected = 0, skipped = 0, errors = 0, reminders = 0;
    
    const allSessions = Object.entries(sessionManager?.sessionsList || {});
    
    for (const [sessionId, sessionInfo] of allSessions) {
        const owner = sessionInfo.ownerUsername;
        if (!owner) continue;
        
        // Skip admins
        const user = authManager.users[owner];
        if (user && user.isAdmin) { skipped++; continue; }
        if (authManager.admin && authManager.admin.username === owner) { skipped++; continue; }
        
        // Si l'utilisateur a un abonnement actif, vérifier si bientôt expiré
        if (isSubscriptionActive(owner)) {
            if (subWarningState[sessionId]) delete subWarningState[sessionId];
            
            const sub = getUserSubscription(owner);
            if (sub && sub.expiresAt) {
                const daysLeft = Math.ceil((sub.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
                if (daysLeft <= 5 && daysLeft > 0 && !expiryReminderSent[sessionId]) {
                    const session = sessionManager.sessions.get(sessionId);
                    const phoneNumber = sessionInfo.phoneNumber || (session && session.client && session.client.info?.wid?.user);
                    // Garde : session doit être prête (ready event émis + WWebJS injecté)
                    const isReady = session && session.client && session.client.pupPage && session.data?.status === 'connected' && session.client.info;
                    if (isReady && phoneNumber) {
                        const botNumber = phoneNumber.includes('@') ? phoneNumber : phoneNumber + '@c.us';
                        const pushName = sessionInfo.pushName || owner;
                        const price = new Intl.NumberFormat('fr-FR').format(subscriptionSettings.amount);
                        const rawUrl = subscriptionSettings.siteUrl || subscriptionSettings.detectedSiteUrl || '';
                        const baseUrl = rawUrl.replace(/\/+$/, '').replace(/\/dashboard$/, '');
                        const dashboardUrl = baseUrl ? baseUrl + '/dashboard' : '';
                        const message = `⏰ *Rappel d'expiration — PayOol™ Bot*\n\n` +
                            `Bonjour @${pushName} ! Votre abonnement expire dans *${daysLeft} jour${daysLeft > 1 ? 's' : ''}*.\n\n` +
                            `Renouvelez dès maintenant pour éviter toute interruption de service.\n\n` +
                            `💰 *Tarif :* ${price} ${subscriptionSettings.currency}\n` +
                            `📅 *Durée :* ${subscriptionSettings.durationDays} jours\n\n` +
                            (dashboardUrl ? `👉 *Renouveler :* ${dashboardUrl}\n\n` : '') +
                            `Merci de votre fidélité ! 🙏`;
                        try {
                            await session.client.sendMessage(botNumber, message);
                            expiryReminderSent[sessionId] = Date.now();
                            reminders++;
                            addLog(`[SUB] Rappel expiration envoyé à ${owner} (${daysLeft}j restants)`);
                        } catch (e) { errors++; addLog(`[SUB] Erreur rappel expiration ${owner}: ${e.message}`); }
                    }
                }
            }
            
            skipped++;
            continue;
        }
        
        const session = sessionManager.sessions.get(sessionId);
        if (!session || !session.client) { skipped++; continue; }

        // Garde : ne tenter l'envoi que si la session est réellement prête
        // (WWebJS injecté, ready émis) — évite "undefined.getChat" au démarrage
        if (!session.client.pupPage || !session.client.info || session.data?.status !== 'connected') {
            skipped++; continue;
        }

        const phoneNumber = sessionInfo.phoneNumber || session.client.info?.wid?.user;
        if (!phoneNumber) { skipped++; continue; }
        const botNumber = phoneNumber.includes('@') ? phoneNumber : phoneNumber + '@c.us';
        
        const price = new Intl.NumberFormat('fr-FR').format(subscriptionSettings.amount);
        const rawUrl = subscriptionSettings.siteUrl || subscriptionSettings.detectedSiteUrl || '';
        const baseUrl = rawUrl.replace(/\/+$/, '').replace(/\/dashboard$/, '');
        const dashboardUrl = baseUrl ? baseUrl + '/dashboard' : '';
        
        const state = subWarningState[sessionId] || 0;
        
        if (state === 0) {
            // Étape 1: Première notification
            const pushName = sessionInfo.pushName || owner;
            const message = `🔔 *Rappel — PayOol™ Bot*\n\n` +
                `Bonjour @${pushName} ! Votre abonnement a expiré.\n\n` +
                `Pour continuer à bénéficier de toutes les fonctionnalités du bot (modération, anti-spam, menus interactifs, etc.), veuillez renouveler votre abonnement.\n\n` +
                `💰 *Tarif :* ${price} ${subscriptionSettings.currency}\n` +
                `📅 *Durée :* ${subscriptionSettings.durationDays} jours\n\n` +
                (dashboardUrl ? `👉 *Payer maintenant :* ${dashboardUrl}\n\n` : '') +
                `Merci de votre confiance ! 🙏`;
            try {
                await session.client.sendMessage(botNumber, message);
                subWarningState[sessionId] = 1;
                notified++;
                addLog(`[SUB] Notification envoyée à ${owner} (étape 1/3)`);
            } catch (e) { errors++; addLog(`[SUB] Erreur notification ${owner}: ${e.message}`); }
            
        } else if (state === 1) {
            // Étape 2: Avertissement final (5 min après)
            const message = `⚠️ *Dernier avertissement — PayOol™ Bot*\n\n` +
                `Votre abonnement n'a toujours pas été renouvelé.\n\n` +
                `🚨 *Votre session sera déconnectée dans 5 minutes* si le paiement n'est pas effectué.\n\n` +
                `Vous ne pourrez plus profiter des fonctionnalités du bot (modération, anti-spam, menus interactifs, etc.).\n\n` +
                `💰 *Tarif :* ${price} ${subscriptionSettings.currency}\n` +
                (dashboardUrl ? `👉 *Payer maintenant :* ${dashboardUrl}\n\n` : '') +
                `⏳ Il vous reste *5 minutes*.`;
            try {
                await session.client.sendMessage(botNumber, message);
                subWarningState[sessionId] = 2;
                warned++;
                addLog(`[SUB] Avertissement final envoyé à ${owner} (étape 2/3)`);
            } catch (e) { errors++; addLog(`[SUB] Erreur avertissement ${owner}: ${e.message}`); }
            
        } else if (state === 2) {
            // Étape 3: Déconnexion (5 min après l'avertissement)
            try {
                await session.client.sendMessage(botNumber, `❌ *Session déconnectée — PayOol™ Bot*\n\nVotre session a été déconnectée car votre abonnement n'a pas été renouvelé.\n\n` +
                    (dashboardUrl ? `Pour réactiver, rendez-vous sur : ${dashboardUrl}` : 'Rendez-vous sur votre tableau de bord pour réactiver.'));
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (e) {}
            
            try {
                await sessionManager.stopSession(sessionId);
                subWarningState[sessionId] = 3;
                disconnected++;
                addLog(`[SUB] Session ${sessionId} (${owner}) déconnectée — abonnement expiré (étape 3/3)`);
            } catch (e) { errors++; addLog(`[SUB] Erreur déconnexion ${sessionId}: ${e.message}`); }
        }
    }
    
    return { notified, warned, disconnected, skipped, errors, reminders };
}

loadSubscriptionSettings();
loadSubscriptions();

// ============================================================
// 📢 GESTIONNAIRE D'ANNONCES
// ============================================================

class AnnouncementsManager {
    constructor() {
        this.announcements = [];
        this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(ANNOUNCEMENTS_FILE)) {
                this.announcements = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Erreur chargement annonces:', e);
            this.announcements = [];
        }
    }
    
    save() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(this.announcements, null, 2));
        } catch (e) {
            console.error('Erreur sauvegarde annonces:', e);
        }
    }
    
    createAnnouncement(username, data) {
        const announcement = {
            id: crypto.randomBytes(8).toString('hex'),
            username,
            title: data.title || 'Sans titre',
            content: data.content || '',
            rawContent: data.rawContent || data.content,
            groups: data.groups || [],
            linkPreview: data.linkPreview !== false,
            image: data.image || null,
            sendAsHd: !!data.sendAsHd,
            status: 'draft', // draft, scheduled, publishing, published, failed
            createdAt: Date.now(),
            scheduledAt: data.scheduledAt || null,
            publishedAt: null,
            publishedGroups: [],
            failedGroups: []
        };
        this.announcements.push(announcement);
        this.save();
        addLog(`[ANNONCE] Nouvelle annonce créée: ${announcement.id} par ${username}`);
        return announcement;
    }
    
    getAnnouncement(id) {
        return this.announcements.find(a => a.id === id);
    }
    
    getAllAnnouncements(username = null, isAdmin = false) {
        let filtered = this.announcements;
        if (!isAdmin && username) {
            filtered = this.announcements.filter(a => a.username === username);
        }
        return filtered.sort((a, b) => b.createdAt - a.createdAt);
    }
    
    updateAnnouncement(id, data, username, isAdmin) {
        const announcement = this.announcements.find(a => a.id === id);
        if (!announcement) return null;
        
        // Vérifier les droits
        if (!isAdmin && announcement.username !== username) return null;
        
        // Ne pas modifier si en cours de publication
        if (announcement.status === 'publishing') return null;
        
        if (data.title !== undefined) announcement.title = data.title;
        if (data.content !== undefined) announcement.content = data.content;
        if (data.rawContent !== undefined) announcement.rawContent = data.rawContent;
        if (data.groups !== undefined) announcement.groups = data.groups;
        if (data.linkPreview !== undefined) announcement.linkPreview = data.linkPreview;
        if (data.image !== undefined) announcement.image = data.image;
        if (data.sendAsHd !== undefined) announcement.sendAsHd = !!data.sendAsHd;
        if (data.scheduledAt !== undefined) announcement.scheduledAt = data.scheduledAt;
        
        this.save();
        addLog(`[ANNONCE] Annonce mise à jour: ${id}`);
        return announcement;
    }
    
    deleteAnnouncement(id, username, isAdmin) {
        const index = this.announcements.findIndex(a => a.id === id);
        if (index === -1) return false;
        
        const announcement = this.announcements[index];
        
        // Vérifier les droits
        if (!isAdmin && announcement.username !== username) return false;
        
        // Ne pas supprimer si en cours de publication
        if (announcement.status === 'publishing') return false;
        
        this.announcements.splice(index, 1);
        this.save();
        addLog(`[ANNONCE] Annonce supprimée: ${id}`);
        return true;
    }
    
    markPublishing(id) {
        const announcement = this.announcements.find(a => a.id === id);
        if (announcement) {
            announcement.status = 'publishing';
            this.save();
        }
    }
    
    markPublished(id, publishedGroups, failedGroups = []) {
        const announcement = this.announcements.find(a => a.id === id);
        if (announcement) {
            announcement.status = failedGroups.length > 0 && failedGroups.length === publishedGroups.length ? 'failed' : 'published';
            announcement.publishedAt = Date.now();
            announcement.publishedGroups = publishedGroups;
            announcement.failedGroups = failedGroups;
            this.save();
        }
    }
    
    getStats() {
        return {
            total: this.announcements.length,
            drafts: this.announcements.filter(a => a.status === 'draft').length,
            published: this.announcements.filter(a => a.status === 'published').length,
            scheduled: this.announcements.filter(a => a.status === 'scheduled').length
        };
    }
}

const announcementsManager = new AnnouncementsManager();

// ============================================================
// 📝 FORMATAGE WHATSAPP
// ============================================================

function formatWhatsAppMessage(rawContent) {
    // Convertir le contenu brut en format WhatsApp
    // Le rawContent peut contenir des marqueurs de formatage
    let formatted = rawContent;
    
    // Les marqueurs sont préservés tels quels pour WhatsApp:
    // *texte* = gras
    // _texte_ = italique
    // ~texte~ = barré
    // ```texte``` = monospace
    // Les puces sont converties en format WhatsApp
    
    return formatted;
}

// ============================================================
// 🚀 PUBLICATION D'ANNONCES HUMANISÉE
// ============================================================

async function publishAnnouncement(sessionId, announcement) {
    const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    
    if (!sessionClient || !sessionClient.info) {
        throw new Error('Session non connectée');
    }
    
    const publishedGroups = [];
    const failedGroups = [];
    
    // Marquer comme en cours de publication
    announcementsManager.markPublishing(announcement.id);
    
    const content = announcement.content;
    const groups = announcement.groups;
    const linkPreview = announcement.linkPreview;
    
    addLog(`[ANNONCE] Début publication ${announcement.id} dans ${groups.length} groupe(s)`);
    
    for (const groupId of groups) {
        try {
            const chat = await sessionClient.getChatById(groupId);
            
            if (!chat || !chat.isGroup) {
                failedGroups.push({ id: groupId, reason: 'Groupe non trouvé' });
                continue;
            }
            
            // Vérifier que le bot est admin dans ce groupe
            const botParticipant = chat.participants?.find(p => p.id._serialized === sessionClient.info.wid._serialized);
            if (!botParticipant?.isAdmin) {
                failedGroups.push({ id: groupId, reason: 'Bot non admin' });
                continue;
            }
            
            // Délai humanisé entre les groupes
            if (publishedGroups.length > 0) {
                const interGroupDelay = HumanBehavior.interGroupDelay();
                if (sessionData) sessionData.addLog(`[ANNONCE] Pause ${Math.round(interGroupDelay/1000)}s avant prochain groupe`);
                else addLog(`[ANNONCE] Pause ${Math.round(interGroupDelay/1000)}s avant prochain groupe`);
                await HumanBehavior.naturalDelay(interGroupDelay);
            }
            
            // Envoyer le message avec comportement humanisé
            if (announcement.image) {
                // Envoyer comme image avec caption
                try {
                    const base64Data = announcement.image.replace(/^data:image\/\w+;base64,/, '');
                    const mimeMatch = announcement.image.match(/^data:(image\/\w+);base64,/);
                    const mimetype = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                    const media = new MessageMedia(mimetype, base64Data, 'announcement.jpg');
                    const mediaOptions = { caption: content };
                    if (!linkPreview) mediaOptions.linkPreview = false;
                    if (announcement.sendAsHd) mediaOptions.sendMediaAsHd = true;
                    await sendMessageHumanized(chat, media, mediaOptions, 0, sessionData);
                } catch (imgErr) {
                    // Fallback: envoyer le texte seul si l'image échoue
                    if (sessionData) sessionData.addLog(`[ANNONCE] Erreur image pour ${chat.name}: ${imgErr.message}, envoi texte seul`);
                    else addLog(`[ANNONCE] Erreur image pour ${chat.name}: ${imgErr.message}, envoi texte seul`);
                    const options = {};
                    if (!linkPreview) options.linkPreview = false;
                    await sendMessageHumanized(chat, content, options, 0, sessionData);
                }
            } else {
                const options = {};
                if (!linkPreview) {
                    options.linkPreview = false;
                }
                await sendMessageHumanized(chat, content, options, 0, sessionData);
            }
            
            publishedGroups.push(groupId);
            if (sessionData) sessionData.addLog(`[ANNONCE] Publié dans: ${chat.name}`);
            else addLog(`[ANNONCE] Publié dans: ${chat.name}`);
            
        } catch (error) {
            failedGroups.push({ id: groupId, reason: error.message });
            if (sessionData) sessionData.addLog(`[ANNONCE] Erreur ${groupId}: ${error.message}`);
            else addLog(`[ANNONCE] Erreur ${groupId}: ${error.message}`);
        }
    }
    
    // Marquer comme publié
    announcementsManager.markPublished(announcement.id, publishedGroups, failedGroups);
    
    return {
        success: publishedGroups.length > 0,
        publishedCount: publishedGroups.length,
        failedCount: failedGroups.length,
        publishedGroups,
        failedGroups
    };
}

// ============================================================
// 💡 GESTIONNAIRE DE SUGGESTIONS
// ============================================================

class SuggestionsManager {
    constructor() {
        this.suggestions = [];
        this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(SUGGESTIONS_FILE)) {
                this.suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Erreur chargement suggestions:', e);
            this.suggestions = [];
        }
    }
    
    save() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify(this.suggestions, null, 2));
        } catch (e) {
            console.error('Erreur sauvegarde suggestions:', e);
        }
    }
    
    addSuggestion(username, type, text) {
        const suggestion = {
            id: crypto.randomBytes(8).toString('hex'),
            username,
            type, // suggestion, feature, bug, other
            text,
            createdAt: Date.now(),
            read: false
        };
        this.suggestions.push(suggestion);
        this.save();
        return suggestion;
    }
    
    getAllSuggestions() {
        return this.suggestions.sort((a, b) => b.createdAt - a.createdAt);
    }
    
    deleteSuggestion(id) {
        const index = this.suggestions.findIndex(s => s.id === id);
        if (index !== -1) {
            this.suggestions.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
    
    getSuggestionsCount() {
        return this.suggestions.length;
    }
}

const suggestionsManager = new SuggestionsManager();

class AuthManager {
    constructor() {
        this.users = {};
        this.admin = null; // Admin séparé
        this.sessions = {};
        this.loadAdmin();
        this.loadUsers();
        this.loadSessions();
        this.cleanExpiredSessions();
        this.createDefaultAdmin();
    }
    
    // === ADMIN ===
    loadAdmin() {
        try {
            if (fs.existsSync(AUTH_ADMIN_FILE)) {
                const data = JSON.parse(fs.readFileSync(AUTH_ADMIN_FILE, 'utf8'));
                this.admin = data;
            }
        } catch (e) {
            console.error('Erreur chargement admin:', e);
            this.admin = null;
        }
    }
    
    saveAdmin() {
        try {
            fs.writeFileSync(AUTH_ADMIN_FILE, JSON.stringify(this.admin, null, 2));
        } catch (e) {
            console.error('Erreur sauvegarde admin:', e);
        }
    }
    
    // === DEFAULT ADMIN ===
    createDefaultAdmin() {
        if (!this.admin) {
            const hashedPassword = this.hashPassword('123');
            this.admin = {
                username: 'BotAdmin',
                password: hashedPassword,
                createdAt: Date.now(),
                lastLogin: null,
                mustChangePassword: true
            };
            this.saveAdmin();
            console.log('[AUTH] Admin par défaut créé: BotAdmin (mot de passe: 123)');
        }
    }
    
    authenticateAdmin(username, password) {
        if (!this.admin || this.admin.username !== username) {
            return { success: false, message: 'Identifiants admin incorrects' };
        }
        
        if (!this.verifyPassword(password, this.admin.password)) {
            return { success: false, message: 'Identifiants admin incorrects' };
        }
        
        const token = this.generateToken();
        const expiresAt = Date.now() + (TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
        this.sessions[token] = { username, isAdmin: true, createdAt: Date.now(), expiresAt };
        this.admin.lastLogin = Date.now();
        this.saveAdmin();
        this.saveSessions();
        
        return { 
            success: true, 
            token, 
            expiresAt, 
            username, 
            isAdmin: true, 
            mustChangePassword: this.admin.mustChangePassword || false 
        };
    }
    
    changeAdminPassword(newPassword) {
        if (!this.admin) return { success: false, message: 'Admin non trouvé' };
        this.admin.password = this.hashPassword(newPassword);
        this.admin.mustChangePassword = false;
        this.saveAdmin();
        return { success: true, message: 'Mot de passe admin modifié' };
    }
    
    // === USERS ===
    loadUsers() {
        try {
            if (fs.existsSync(AUTH_USERS_FILE)) {
                this.users = JSON.parse(fs.readFileSync(AUTH_USERS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Erreur chargement utilisateurs:', e);
            this.users = {};
        }
    }
    
    saveUsers() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(AUTH_USERS_FILE, JSON.stringify(this.users, null, 2));
        } catch (e) {
            console.error('Erreur sauvegarde utilisateurs:', e);
        }
    }
    
    hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
        return `${salt}:${hash}`;
    }
    
    verifyPassword(password, storedHash) {
        const [salt, hash] = storedHash.split(':');
        const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
        return hash === verifyHash;
    }
    
    generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }
    
    // === USER MANAGEMENT ===
    createUser(username, password, isAdmin = false, securityQuestion = null, securityAnswer = null) {
        if (this.users[username]) {
            return { success: false, message: 'Cet utilisateur existe déjà' };
        }
        
        if (!username || username.length < 3) {
            return { success: false, message: 'Le nom d\'utilisateur doit contenir au moins 3 caractères' };
        }
        
        if (!password || password.length < 6) {
            return { success: false, message: 'Le mot de passe doit contenir au moins 6 caractères' };
        }
        
        const hashedPassword = this.hashPassword(password);
        this.users[username] = {
            username,
            password: hashedPassword,
            isAdmin,
            createdAt: Date.now(),
            lastLogin: null,
            securityQuestion: securityQuestion || null,
            securityAnswer: securityAnswer ? this.hashPassword(securityAnswer.toLowerCase()) : null
        };
        this.saveUsers();
        
        addLog(`[AUTH] Nouvel utilisateur créé: ${username}`);
        return { success: true, message: 'Compte créé avec succès' };
    }
    
    authenticateUser(username, password) {
        const user = this.users[username];
        if (!user) {
            return { success: false, message: 'Nom d\'utilisateur ou mot de passe incorrect' };
        }
        
        if (!this.verifyPassword(password, user.password)) {
            return { success: false, message: 'Nom d\'utilisateur ou mot de passe incorrect' };
        }
        
        // Create session
        const token = this.generateToken();
        const expiresAt = Date.now() + (TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
        
        this.sessions[token] = {
            username,
            createdAt: Date.now(),
            expiresAt
        };
        
        user.lastLogin = Date.now();
        this.saveUsers();
        this.saveSessions();
        
        addLog(`[AUTH] Connexion réussie: ${username}`);
        return { 
            success: true, 
            token, 
            expiresAt, 
            username, 
            isAdmin: user.isAdmin,
            mustChangePassword: user.mustChangePassword || false
        };
    }
    
    logoutUser(token) {
        if (this.sessions[token]) {
            const username = this.sessions[token].username;
            delete this.sessions[token];
            this.saveSessions();
            addLog(`[AUTH] Déconnexion: ${username}`);
            return { success: true };
        }
        return { success: false, message: 'Session non trouvée' };
    }
    
    validateToken(token) {
        const session = this.sessions[token];
        if (!session) {
            return { valid: false, message: 'Token invalide' };
        }
        
        if (Date.now() > session.expiresAt) {
            delete this.sessions[token];
            this.saveSessions();
            return { valid: false, message: 'Session expirée' };
        }
        
        // Vérifier si c'est l'admin
        if (session.isAdmin && this.admin && session.username === this.admin.username) {
            return { 
                valid: true, 
                username: session.username, 
                isAdmin: true 
            };
        }
        
        // Vérifier si c'est un utilisateur normal
        const user = this.users[session.username];
        if (!user) {
            return { valid: false, message: 'Utilisateur non trouvé' };
        }
        
        return { 
            valid: true, 
            username: session.username, 
            isAdmin: user.isAdmin || false 
        };
    }
    
    // === SESSIONS ===
    loadSessions() {
        try {
            if (fs.existsSync(AUTH_SESSIONS_FILE)) {
                this.sessions = JSON.parse(fs.readFileSync(AUTH_SESSIONS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Erreur chargement sessions:', e);
            this.sessions = {};
        }
    }
    
    saveSessions() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(AUTH_SESSIONS_FILE, JSON.stringify(this.sessions, null, 2));
        } catch (e) {
            console.error('Erreur sauvegarde sessions:', e);
        }
    }
    
    cleanExpiredSessions() {
        const now = Date.now();
        let cleaned = 0;
        for (const token in this.sessions) {
            if (this.sessions[token].expiresAt < now) {
                delete this.sessions[token];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.saveSessions();
            console.log(`${cleaned} sessions expirées nettoyées`);
        }
    }
    
    // === ADMIN ===
    getAllUsers() {
        return Object.values(this.users).map(u => ({
            username: u.username,
            isAdmin: u.isAdmin,
            createdAt: u.createdAt,
            lastLogin: u.lastLogin
        }));
    }
    
    deleteUser(username) {
        if (!this.users[username]) {
            return { success: false, message: 'Utilisateur non trouvé' };
        }
        
        // Supprimer toutes les sessions d'authentification de cet utilisateur
        for (const token in this.sessions) {
            if (this.sessions[token].username === username) {
                delete this.sessions[token];
            }
        }
        
        // Supprimer les sessions WhatsApp de l'utilisateur
        if (typeof sessionManager !== 'undefined') {
            sessionManager.cleanupUserSessions(username);
        }
        
        delete this.users[username];
        this.saveUsers();
        this.saveSessions();
        
        addLog(`[AUTH] Utilisateur supprimé: ${username}`);
        return { success: true, message: 'Utilisateur supprimé' };
    }
    
    changePassword(username, newPassword) {
        if (!this.users[username]) {
            return { success: false, message: 'Utilisateur non trouvé' };
        }
        
        if (!newPassword || newPassword.length < 6) {
            return { success: false, message: 'Le mot de passe doit contenir au moins 6 caractères' };
        }
        
        this.users[username].password = this.hashPassword(newPassword);
        this.users[username].mustChangePassword = false; // Enlever le flag
        this.saveUsers();
        
        addLog(`[AUTH] Mot de passe changé: ${username}`);
        return { success: true, message: 'Mot de passe modifié' };
    }
    
    // === SECURITY QUESTION RECOVERY ===
    getSecurityQuestion(username) {
        const user = this.users[username];
        if (!user) {
            return { success: false, message: 'Utilisateur non trouvé' };
        }
        
        if (!user.securityQuestion) {
            return { success: false, message: 'Aucune question de sécurité configurée pour ce compte' };
        }
        
        return { success: true, question: user.securityQuestion };
    }
    
    verifySecurityAnswer(username, answer) {
        const user = this.users[username];
        if (!user) {
            return { success: false, message: 'Utilisateur non trouvé' };
        }
        
        if (!user.securityAnswer) {
            return { success: false, message: 'Aucune question de sécurité configurée pour ce compte' };
        }
        
        if (!this.verifyPassword(answer.toLowerCase(), user.securityAnswer)) {
            return { success: false, message: 'Réponse incorrecte' };
        }
        
        // Générer un token de récupération temporaire
        const recoveryToken = this.generateToken();
        this.sessions[recoveryToken] = {
            username,
            createdAt: Date.now(),
            expiresAt: Date.now() + (15 * 60 * 1000), // 15 minutes
            isRecovery: true
        };
        this.saveSessions();
        
        return { success: true, recoveryToken };
    }
    
    resetPasswordWithToken(recoveryToken, newPassword) {
        const session = this.sessions[recoveryToken];
        if (!session || !session.isRecovery) {
            return { success: false, message: 'Token de récupération invalide' };
        }
        
        if (Date.now() > session.expiresAt) {
            delete this.sessions[recoveryToken];
            this.saveSessions();
            return { success: false, message: 'Token de récupération expiré' };
        }
        
        if (!newPassword || newPassword.length < 6) {
            return { success: false, message: 'Le mot de passe doit contenir au moins 6 caractères' };
        }
        
        const username = session.username;
        this.users[username].password = this.hashPassword(newPassword);
        
        // Supprimer le token de récupération et toutes les autres sessions de cet utilisateur
        delete this.sessions[recoveryToken];
        for (const token in this.sessions) {
            if (this.sessions[token].username === username) {
                delete this.sessions[token];
            }
        }
        
        this.saveUsers();
        this.saveSessions();
        
        addLog(`[AUTH] Mot de passe réinitialisé via question de sécurité: ${username}`);
        return { success: true, message: 'Mot de passe réinitialisé avec succès' };
    }
    
    setAdmin(username, isAdmin) {
        if (!this.users[username]) {
            return { success: false, message: 'Utilisateur non trouvé' };
        }
        
        this.users[username].isAdmin = isAdmin;
        this.saveUsers();
        
        addLog(`[AUTH] Admin status changé pour ${username}: ${isAdmin}`);
        return { success: true, message: `Droits admin ${isAdmin ? 'accordés' : 'retirés'}` };
    }
    
    userCount() {
        return Object.keys(this.users).length;
    }
}

const authManager = new AuthManager();

// Middleware d'authentification
function requireAuth(req, res, next) {
    const token = req.cookies.authToken;
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Authentification requise', requireAuth: true });
    }
    
    const validation = authManager.validateToken(token);
    if (!validation.valid) {
        return res.status(401).json({ success: false, message: validation.message, requireAuth: true });
    }
    
    req.user = { username: validation.username, isAdmin: validation.isAdmin };
    next();
}

// Middleware optionnel - ajoute user si connecté mais ne bloque pas
function optionalAuth(req, res, next) {
    const token = req.cookies.authToken;
    
    if (token) {
        const validation = authManager.validateToken(token);
        if (validation.valid) {
            req.user = { username: validation.username, isAdmin: validation.isAdmin };
        }
    }
    next();
}

// Middleware admin uniquement
function requireAdmin(req, res, next) {
    const token = req.cookies.authToken;
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Authentification requise', requireAuth: true });
    }
    
    const validation = authManager.validateToken(token);
    if (!validation.valid) {
        return res.status(401).json({ success: false, message: validation.message, requireAuth: true });
    }
    
    if (!validation.isAdmin) {
        return res.status(403).json({ success: false, message: 'Accès admin requis' });
    }
    
    req.user = { username: validation.username, isAdmin: true };
    next();
}

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
        this.callHistory = [];

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
            // Matcher par numéro de téléphone car WhatsApp utilise différents formats d'ID (@lid, @c.us)
            const p = participants.find(part => {
                const partNumber = part.id._serialized?.split('@')[0];
                return partNumber === userNumber || part.id._serialized === userId;
            });
            if (p && (p.isAdmin || p.isSuperAdmin)) return true;
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
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24h
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

    // === CALL HISTORY ===
    loadCallHistory() {
        const file = path.join(this.sessionDir, 'call_history.json');
        try {
            if (fs.existsSync(file)) this.callHistory = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {}
    }

    saveCallHistory() {
        const file = path.join(this.sessionDir, 'call_history.json');
        try {
            if (this.callHistory.length > 500) this.callHistory = this.callHistory.slice(-500);
            fs.writeFileSync(file, JSON.stringify(this.callHistory, null, 2));
        } catch (e) {}
    }

    addCallToHistory(callerId, callerNumber, isVideo, action) {
        this.callHistory.push({ callerId, callerNumber, isVideo, action, timestamp: Date.now() });
        this.saveCallHistory();
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
        this.loadCallHistory();
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
            console.log(`${processedMessages.size} messages deja traites charges`);
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

function createMenu(config, sessionData = null) {
    const menuId = config.id || `menu_${Date.now()}`;
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
    menus[menuId] = {
        id: menuId,
        title: config.title || 'Menu',
        description: config.description || '',
        trigger: config.trigger || null,
        type: config.type || 'buttons',
        buttons: config.buttons || [],
        listSections: config.listSections || [],
        image: config.image || null,
        groupId: config.groupId || null,
        enabled: config.enabled !== false
    };
    if (sessionData) sessionData.saveMenus(); else saveMenus();
    return menus[menuId];
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

async function sendInteractiveMenu(chat, menuId, sessionData = null, quotedMsg = null) {
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
    const sessions = sessionData ? sessionData.menuSessions : menuSessions;
    const menu = menus[menuId];
    if (!menu || !menu.enabled) return null;

    try {
        await rateLimiter.waitUntilAllowed();

        const title = menu.title;
        const description = menu.description || '';

        let menuText = '';
        let sessionItems = null;

        if (menu.type === 'buttons' && menu.buttons.length > 0) {
            menuText = `📋 *${title}*\n\n`;
            if (description) menuText += `${description}\n\n`;
            menu.buttons.slice(0, 10).forEach((btn, i) => {
                menuText += `${i + 1}️⃣ ${btn.text}\n`;
            });
            menuText += `\n_Répondez avec le numéro de votre choix_`;
            sessionItems = { buttons: menu.buttons };
        } else if (menu.type === 'list' && menu.listSections.length > 0) {
            menuText = `📋 *${title}*\n\n`;
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
            menuText += `\n_Répondez avec le numéro de votre choix_`;
            sessionItems = { rows: allRows };
        } else {
            menuText = description || title;
        }

        if (sessionItems) {
            const sessKey = `${chat.id._serialized}_${Date.now()}`;
            sessions[sessKey] = { menuId, ...sessionItems, createdAt: Date.now(), expiresAt: Date.now() + 3600000 };
            if (sessionData) sessionData.saveMenus(); else saveMenus();
        }

        const sendOpts = quotedMsg ? { quotedMessageId: quotedMsg.id._serialized } : {};

        if (menu.image) {
            const base64Data = menu.image.replace(/^data:image\/\w+;base64,/, '');
            const mimeMatch = menu.image.match(/^data:(image\/\w+);base64,/);
            const mimetype = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            const media = new MessageMedia(mimetype, base64Data, 'menu.jpg');
            const sent = await sendMessageHumanized(chat, media, { caption: menuText, ...sendOpts });
            return sent;
        } else {
            const sent = await sendMessageHumanized(chat, menuText, sendOpts);
            return sent;
        }
    } catch (error) {
        addLog(`[X] Erreur envoi menu ${menuId}: ${error.message}`);
        console.error('Erreur menu:', error);
        return null;
    }
}

async function handleMenuResponse(message, responseId, sessionData = null) {
    const chat = await message.getChat();
    const senderId = message.author || message.from;
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;

    for (const menuId in menus) {
        const menu = menus[menuId];
        if (!menu.enabled) continue;

        if (menu.groupId && chat.id._serialized !== menu.groupId) continue;

        const quoteOpts = { quotedMessageId: message.id._serialized };
        if (menu.type === 'buttons') {
            const button = menu.buttons.find(b => b.id === responseId);
            if (button) {
                if (button.action) {
                    return await executeMenuAction(chat, senderId, button.action, menu, sessionData, message);
                }
                if (button.nextMenu) {
                    return await sendInteractiveMenu(chat, button.nextMenu, sessionData, message);
                }
                if (button.response) {
                    return await sendMessageHumanized(chat, button.response, quoteOpts, message.body?.length || 0, sessionData);
                }
            }
        }

        if (menu.type === 'list') {
            for (const section of menu.listSections) {
                const row = section.rows.find(r => r.id === responseId);
                if (row) {
                    if (row.action) {
                        return await executeMenuAction(chat, senderId, row.action, menu, sessionData, message);
                    }
                    if (row.nextMenu) {
                        return await sendInteractiveMenu(chat, row.nextMenu, sessionData, message);
                    }
                    if (row.response) {
                        return await sendMessageHumanized(chat, row.response, quoteOpts, message.body?.length || 0, sessionData);
                    }
                }
            }
        }
    }

    return null;
}

async function executeMenuAction(chat, userId, action, menu, sessionData = null, quotedMsg = null) {
    const quoteOpts = quotedMsg ? { quotedMessageId: quotedMsg.id._serialized } : {};
    switch (action.type) {
        case 'message':
            return await sendMessageHumanized(chat, action.content, quoteOpts, 0, sessionData);

        case 'link':
            if (action.whitelist) {
                addLog(`[OK] Lien autorise via menu: ${action.whitelist}`);
                return await sendMessageHumanized(chat,
                    `✅ Voici le lien autorisé: ${action.whitelist}`, quoteOpts, 0);
            }
            break;

        case 'contact':
            if (action.contactId) {
                try {
                    const contact = await client.getContactById(action.contactId);
                    return await sendMessageHumanized(chat,
                        `👤 Contact demandé: @${contact.number}`,
                        { mentions: [contact.id._serialized], ...quoteOpts }, 0);
                } catch (e) {
                    return await sendMessageHumanized(chat, '❌ Contact non disponible', quoteOpts, 0);
                }
            }
            break;

        case 'submenu':
            const subMenus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
            if (action.menuId && subMenus[action.menuId]) {
                return await sendInteractiveMenu(chat, action.menuId, sessionData, quotedMsg);
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
                    addLog(`[WEBHOOK] Webhook appele: ${action.webhook}`);
                } catch (e) {
                    addLog(`[X] Erreur webhook: ${e.message}`);
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
                addLog(`[UNBLOCK] ${userId} debloque automatiquement`);
            } catch (error) {
                addLog(`[X] Erreur deblocage auto ${userId}: ${error.message}`);
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

const LOG_RETENTION_HOURS = 24;

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
    const cutoff = Date.now() - (LOG_RETENTION_HOURS * 60 * 60 * 1000);
    const before = LOGS.length;
    LOGS = LOGS.filter(log => {
        const ts = typeof log === 'object' && log.timestamp ? new Date(log.timestamp).getTime() : Date.now();
        return ts > cutoff;
    });
    if (LOGS.length < before) {
        console.log(`Nettoyage logs: ${before - LOGS.length} entrees supprimees (>${LOG_RETENTION_HOURS}h)`);
    }
}

function clearAllLogs() {
    LOGS = [];
    try { fs.writeFileSync(LOGS_FILE, JSON.stringify(LOGS, null, 2)); } catch (e) {}
    // Vider aussi les logs des sessions
    for (const [sessionId, sessionData] of sessionDataManagers) {
        sessionData.logs = [];
        sessionData.saveLogs();
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
        // Matcher par numéro de téléphone car WhatsApp utilise différents formats d'ID (@lid, @c.us)
        const p = participants.find(part => {
            const partNumber = part.id._serialized?.split('@')[0];
            return partNumber === userNumber || part.id._serialized === userId;
        });
        if (p && (p.isAdmin || p.isSuperAdmin)) return true;
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
    let warnings = loadWarnings();
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
            addLog(`[LINK] Lien standard detecte: "${text.substring(0, 80)}"`);
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
        addLog(`[LINK] Domaine detecte: "${text.substring(0, 80)}": ${valid.join(', ')}`);
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
    
    // Nettoyer les sessions orphelines (sans propriétaire existant)
    cleanupOrphanSessions() {
        const orphanSessions = [];
        
        for (const [sessionId, session] of Object.entries(this.sessionsList)) {
            const owner = session.ownerUsername;
            // Si la session a un propriétaire mais qu'il n'existe plus
            if (owner && !authManager.users[owner]) {
                orphanSessions.push(sessionId);
            }
        }
        
        if (orphanSessions.length > 0) {
            console.log(`[CLEANUP] ${orphanSessions.length} session(s) orpheline(s) trouvée(s)`);
            for (const sessionId of orphanSessions) {
                this.deleteSession(sessionId);
                console.log(`[CLEANUP] Session orpheline supprimée: ${sessionId}`);
            }
        }
        
        return orphanSessions.length;
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

    createSession(sessionId = null, name = 'Default', ownerUsername = null) {
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
            pushName: null,
            ownerUsername: ownerUsername // Associer à un utilisateur
        };

        this.sessionsList[id] = sessionData;
        this.saveSessionsList();

        const client = this.initClient(id);
        this.sessions.set(id, { client, data: sessionData });

        return sessionData;
    }

    // Vérifier si l'utilisateur peut démarrer une session
    canUserStartSession(username) {
        const user = authManager.users[username];
        if (!user) return { allowed: false, reason: 'Utilisateur non trouvé' };
        
        if (subscriptionSettings.enabled && !user.isAdmin && !isSubscriptionActive(username)) {
            return { allowed: false, reason: 'SUBSCRIPTION_REQUIRED', requireSubscription: true };
        }
        
        return { allowed: true, user };
    }

    // Obtenir les sessions d'un utilisateur
    getUserSessions(username) {
        return Object.values(this.sessionsList).filter(s => s.ownerUsername === username);
    }

    // Vérifier et nettoyer les sessions d'un utilisateur supprimé
    cleanupUserSessions(username) {
        const sessionsToRemove = [];
        for (const [id, session] of Object.entries(this.sessionsList)) {
            if (session.ownerUsername === username) {
                sessionsToRemove.push(id);
            }
        }
        
        for (const id of sessionsToRemove) {
            this.deleteSession(id);
            addLog(`[SESSION] Session ${id} supprimée (utilisateur ${username} supprimé)`);
        }
        
        return sessionsToRemove.length;
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
                timeout: 180000,
                protocolTimeout: 600000,
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
        let qrTimeout = null;
        const QR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

        client.on('qr', (qr) => {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.currentQR = qr;
                session.data.status = 'qr';
                this.sessionsList[sessionId].status = 'qr';
                this.saveSessionsList();
            }
            addLog(`[${sessionId}] QR code genere`);
            console.log(`\n[${sessionId}] Scannez ce QR code avec WhatsApp:\n`);
            qrcode.generate(qr, { small: true });

            // Démarrer/redémarrer le timer de 5 min au premier QR
            if (!qrTimeout) {
                qrTimeout = setTimeout(async () => {
                    const sess = this.sessions.get(sessionId);
                    if (sess && sess.data.status !== 'connected') {
                        addLog(`[TIMEOUT] [${sessionId}] QR non scanné après 5 min — suppression automatique`);
                        await this.deleteSession(sessionId);
                    }
                }, QR_TIMEOUT_MS);
            }
        });

        client.on('ready', async () => {
            // Annuler le timer QR si la session se connecte
            if (qrTimeout) { clearTimeout(qrTimeout); qrTimeout = null; }

            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.status = 'connected';
                session.data.currentQR = null;
                session.data.phoneNumber = client.info?.wid?.user || null;
                session.data.pushName = client.info?.pushname || null;
                this.sessionsList[sessionId].status = 'connected';
                this.sessionsList[sessionId].phoneNumber = session.data.phoneNumber;
                this.sessionsList[sessionId].pushName = session.data.pushName;
                
                // Activer automatiquement si aucune session n'est active globalement
                // OU si l'activeSessionId actuel n'appartient pas au même propriétaire
                const ownerOfActive = this.activeSessionId
                    ? this.sessionsList[this.activeSessionId]?.ownerUsername
                    : null;
                const ownerOfThis = this.sessionsList[sessionId]?.ownerUsername;
                if (!this.activeSessionId || (ownerOfThis && ownerOfActive !== ownerOfThis && ownerOfActive === null)) {
                    this.activeSessionId = sessionId;
                    addLog(`[TARGET] Session active: ${sessionId}`);
                }
                
                this.saveSessionsList();
            }
            addLog(`[OK] [${sessionId}] Bot connecte et pret!`);
            
            // Toutes les sessions démarrent leurs processus
            restoreUnblockTimers(sessionId);
            startPresenceManager(sessionId);
            const sessionData = getSessionData(sessionId);
            if (sessionData.config.AUTO_SCAN_ENABLED) {
                // Délai plus généreux pour laisser WhatsApp Web finir la synchro initiale des chats
                // (sinon getChats() peut dépasser protocolTimeout sur les gros comptes)
                const startupDelay = HumanBehavior.gaussianRandom(45000, 15000);
                addLog(`[TIMER] [${sessionId}] Premier scan dans ${Math.round(startupDelay / 1000)}s...`);
                // Capture référence client pour pouvoir détecter un restart pendant l'attente
                const scheduledFor = client;
                await new Promise(r => setTimeout(r, startupDelay));
                // Si la session a été arrêtée/redémarrée pendant l'attente, le client en mémoire
                // sera différent de celui qui a programmé ce scan → on abandonne silencieusement
                const currentSession = this.sessions.get(sessionId);
                if (!currentSession || currentSession.client !== scheduledFor) {
                    addLog(`[TIMER] [${sessionId}] Scan initial annulé (session redémarrée)`);
                } else {
                    try {
                        await scanAllGroups(sessionId);
                    } catch (scanError) {
                        addLog(`[X] [${sessionId}] Erreur scan initial: ${scanError.message}`);
                    }
                }
            }
            scheduleNextScan(sessionId);
        });

        client.on('auth_failure', (msg) => {
            if (qrTimeout) { clearTimeout(qrTimeout); qrTimeout = null; }
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.status = 'auth_failure';
                this.sessionsList[sessionId].status = 'auth_failure';
                this.saveSessionsList();
            }
            addLog(`[X] [${sessionId}] Echec auth: ${msg}`);
        });

        client.on('disconnected', (reason) => {
            if (qrTimeout) { clearTimeout(qrTimeout); qrTimeout = null; }
            const session = this.sessions.get(sessionId);
            if (session) {
                session.data.status = 'disconnected';
                this.sessionsList[sessionId].status = 'disconnected';
                this.saveSessionsList();
            }
            addLog(`[DECO] [${sessionId}] Deconnecte: ${reason}`);

            if (reason !== 'LOGOUT') {
                addLog(`[RECONNECT] [${sessionId}] Reconnexion auto dans 10s...`);
                setTimeout(() => {
                    try {
                        client.initialize();
                        addLog(`[RECONNECT] [${sessionId}] Reinitialisation lancee`);
                    } catch (e) {
                        addLog(`[RECONNECT] [${sessionId}] Erreur reinit: ${e.message}`);
                    }
                }, 10000);
            }
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
        let session = this.sessions.get(sessionId);

        // Si la session n'existe pas en mémoire mais existe sur disque → la créer
        if (!session && this.sessionsList[sessionId]) {
            const client = this.initClient(sessionId);
            if (!client) return false;
            this.sessions.set(sessionId, { client, data: { ...this.sessionsList[sessionId] } });
            session = this.sessions.get(sessionId);
        }

        if (!session) return false;

        // Si le client a été détruit (après stopSession), il faut en créer un nouveau
        // `pupBrowser` est null quand destroy() a été appelé avec succès
        const isDestroyed = !session.client || !session.client.pupBrowser;
        if (isDestroyed) {
            addLog(`[START] [${sessionId}] Recréation du client (précédent détruit)`);
            const newClient = this.initClient(sessionId);
            if (!newClient) return false;
            session.client = newClient;
        }

        try {
            session.client.initialize();
            session.data.status = 'pending';
            if (this.sessionsList[sessionId]) {
                this.sessionsList[sessionId].status = 'pending';
                this.saveSessionsList();
            }
            addLog(`[START] [${sessionId}] Session demarree`);
            return true;
        } catch (e) {
            addLog(`[X] [${sessionId}] Erreur startSession: ${e.message}`);
            return false;
        }
    }

    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.client) {
            try {
                await session.client.destroy();
                session.data.status = 'stopped';
                this.sessionsList[sessionId].status = 'stopped';
                this.saveSessionsList();
                addLog(`[STOP] [${sessionId}] Session arretee`);
                return true;
            } catch (e) {
                addLog(`[X] [${sessionId}] Erreur arret: ${e.message}`);
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
            addLog(`[!] [${sessionId}] Erreur suppression dossier auth: ${e.message}`);
        }
        
        // Delete session data folder
        const sessionDataPath = path.join(DATA_DIR, 'sessions', sessionId);
        try {
            if (fs.existsSync(sessionDataPath)) {
                fs.rmSync(sessionDataPath, { recursive: true, force: true });
            }
        } catch (e) {
            addLog(`[!] [${sessionId}] Erreur suppression dossier data: ${e.message}`);
        }
        
        // Remove from sessionDataManagers map
        sessionDataManagers.delete(sessionId);

        this.sessions.delete(sessionId);
        delete this.sessionsList[sessionId];
        
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
        }
        
        this.saveSessionsList();
        addLog(`[SUPPR] [${sessionId}] Session supprimee`);
        return true;
    }

    getEffectiveSessionId(username, isAdmin, requestedId = null) {
        if (requestedId) {
            if (!isAdmin) {
                const s = this.sessionsList[requestedId];
                if (!s || s.ownerUsername !== username) return null;
            }
            return requestedId;
        }
        if (isAdmin) return this.activeSessionId;
        if (this.activeSessionId) {
            const active = this.sessionsList[this.activeSessionId];
            if (active && active.ownerUsername === username) return this.activeSessionId;
        }
        const userSessions = Object.values(this.sessionsList)
            .filter(s => s.ownerUsername === username);
        return userSessions.find(s => s.status === 'connected')?.id
            || userSessions[0]?.id
            || null;
    }

    setActiveSession(sessionId) {
        if (this.sessionsList[sessionId]) {
            this.activeSessionId = sessionId;
            this.saveSessionsList();
            addLog(`[TARGET] Session active: ${sessionId}`);
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
        const orphanSessions = [];
        for (const sessionId in this.sessionsList) {
            const sessionData = this.sessionsList[sessionId];
            
            // Supprimer les sessions sans propriétaire valide
            if (!sessionData.ownerUsername) {
                orphanSessions.push(sessionId);
                continue;
            }
            
            // Vérifier que le propriétaire existe
            if (!authManager.users[sessionData.ownerUsername]) {
                orphanSessions.push(sessionId);
                continue;
            }
            
            if (!this.sessions.has(sessionId)) {
                const client = this.initClient(sessionId);
                if (client) {
                    this.sessions.set(sessionId, { 
                        client, 
                        data: { ...sessionData }
                    });
                }
            }
        }
        
        // Supprimer les sessions orphelines
        for (const sessionId of orphanSessions) {
            addLog(`[CLEANUP] Session orpheline supprimée: ${sessionId}`);
            delete this.sessionsList[sessionId];
            // Supprimer le dossier d'authentification
            try {
                const authPath = path.join(__dirname, '.wwebjs_auth', sessionId);
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
            } catch (e) {}
        }
        
        if (orphanSessions.length > 0) {
            if (this.activeSessionId && orphanSessions.includes(this.activeSessionId)) {
                this.activeSessionId = null;
            }
            this.saveSessionsList();
            console.log(`${orphanSessions.length} session(s) orpheline(s) supprimée(s)`);
        }

        // Set active session or first one
        if (!this.activeSessionId && Object.keys(this.sessionsList).length > 0) {
            this.activeSessionId = Object.keys(this.sessionsList)[0];
            this.saveSessionsList();
        }

        // Start all valid sessions
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
        if (sessionData) sessionData.addLog(`[!] Client non disponible pour le scan`);
        else addLog(`[!] Client non disponible pour le scan`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }
    
    const log = (msg) => sessionData ? sessionData.addLog(msg) : addLog(msg);
    
    if (sessionData && sessionData.isGroupExcluded(chat)) {
        log(`[EXCL] Groupe ${chat.name} exclu`);
        return { deleted: 0, scanned: 0, warned: 0 };
    } else if (!sessionData && isGroupExcluded(chat)) {
        log(`[EXCL] Groupe ${chat.name} exclu`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    log(`[SCAN] Scan de ${chat.name}...`);

    const botId = sessionClient.info.wid._serialized;
    const participants = chat.participants || [];
    const botP = participants.find(p => p.id._serialized === botId);

    if (!botP || !botP.isAdmin) {
        log(`[!] Pas admin dans ${chat.name}`);
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
        
        // ✅ Autoriser directement les admins du groupe (détection dynamique)
        const authorP = participants.find(p => p.id._serialized === authorId);
        if (authorP?.isAdmin || authorP?.isSuperAdmin) continue;
        
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
            const mention = `@${contact.id.user}`;
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
            log(`[!] Erreur traitement: ${error.message}`);
        }
    }

    log(`[OK] Scan ${chat.name}: ${scanned} scans, ${deleted} supprimes, ${warned} avertis`);
    if (sessionData) sessionData.saveStats();
    return { deleted, scanned, warned };
}

async function scanAllGroups(sessionId = null) {
    // Récupérer le client de la session
    const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : client;
    if (!sessionClient || !sessionClient.info) {
        addLog(`[!] [${sessionId}] Client non disponible pour le scan`);
        return { totalDeleted: 0, totalScanned: 0, totalWarned: 0 };
    }
    
    addLog('[SCAN] ========== SCAN AUTOMATIQUE ==========');
    const chats = await sessionClient.getChats();
    const botId = sessionClient.info.wid._serialized;
    
    // Filtrer uniquement les groupes où le bot est admin
    const groups = chats.filter(c => {
        if (!c.isGroup) return false;
        const botParticipant = c.participants?.find(p => p.id._serialized === botId);
        return botParticipant?.isAdmin; // Bot doit être admin
    });
    
    addLog(`[STATS] ${groups.length} groupes administres detectes`);

    let totalDeleted = 0, totalScanned = 0, totalWarned = 0;

    const shuffled = groups.sort(() => Math.random() - 0.5);

    const sdScan = getSessionData(sessionId);
    for (const group of shuffled) {
        const result = await scanOldMessages(group, sdScan.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT, sessionId);
        totalDeleted += result.deleted;
        totalScanned += result.scanned;
        totalWarned += result.warned || 0;

        await HumanBehavior.naturalDelay(HumanBehavior.interGroupDelay());
    }

    addLog('[OK] ========== FIN DU SCAN ==========');
    addLog(`Total: ${totalScanned} scans, ${totalDeleted} supprimes, ${totalWarned} avertis`);
    return { totalDeleted, totalScanned, totalWarned };
}

// ============================================================
// ⏰ PLANIFICATION DES SCANS (par session)
// ============================================================

const scanTimers = new Map();

function scheduleNextScan(sessionId) {
    const sdTimer = getSessionData(sessionId);
    const nextScanMs = (sdTimer.config.AUTO_SCAN_INTERVAL_HOURS || CONFIG.AUTO_SCAN_INTERVAL_HOURS) * 60 * 60 * 1000;

    addLog(`[TIMER] [${sessionId}] Prochain scan dans ${sdTimer.config.AUTO_SCAN_INTERVAL_HOURS || CONFIG.AUTO_SCAN_INTERVAL_HOURS}h`);

    // Clear existing timer for this session
    if (scanTimers.has(sessionId)) {
        clearTimeout(scanTimers.get(sessionId));
    }

    const timer = setTimeout(async () => {
        const session = sessionManager.sessions.get(sessionId);
        const sdTimerInner = getSessionData(sessionId);
        if (sdTimerInner.config.AUTO_SCAN_ENABLED && session && session.data.status === 'connected') {
            addLog(`[TIMER] [${sessionId}] Scan automatique programme...`);
            try {
                await scanAllGroups(sessionId);
            } catch (scanError) {
                addLog(`[X] [${sessionId}] Erreur scan programme: ${scanError.message}`);
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
                sessionData.addLog(`Menu reponse: ${responseId} de ${senderId}`);
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
                    sessionData.addLog(`Menu reponse textuel: ${selectedNumber} (${selectedItem.text || selectedItem.title}) de ${senderId}`);

                    const quoteOpts = { quotedMessageId: message.id._serialized };
                    if (selectedItem.response) {
                        await sendMessageHumanized(chat, selectedItem.response, quoteOpts, messageText.length, sessionData);
                    } else if (selectedItem.nextMenu) {
                        await sendInteractiveMenu(chat, selectedItem.nextMenu, sessionData, message);
                    } else {
                        await sendMessageHumanized(chat, `[OK] Vous avez selectionne: ${selectedItem.text || selectedItem.title}`, quoteOpts, messageText.length, sessionData);
                    }
                    return;
                } else if (items.length > 0) {
                    await sendMessageHumanized(chat, `⚠️ Option invalide. Veuillez choisir un numéro entre *1* et *${items.length}*.`, { quotedMessageId: message.id._serialized }, messageText.length, sessionData);
                    return;
                }
            }
        }

        // ✅ Réponse textuelle à un menu (l'utilisateur tape le texte de l'option au lieu du numéro)
        if (!numberMatch && messageText.length >= 2) {
            const normalizeText = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            const inputNorm = normalizeText(messageText);

            let latestSession = null;
            for (const sessId in sessionData.menuSessions) {
                const session = sessionData.menuSessions[sessId];
                if (session.expiresAt < Date.now()) {
                    delete sessionData.menuSessions[sessId];
                    continue;
                }
                if (sessId.startsWith(chat.id._serialized)) {
                    if (!latestSession || session.createdAt > latestSession.createdAt) {
                        latestSession = session;
                    }
                }
            }

            if (latestSession) {
                const items = latestSession.buttons || latestSession.rows || [];
                let bestMatch = null;
                let bestScore = 0;

                for (let i = 0; i < items.length; i++) {
                    const itemLabel = items[i].text || items[i].title || '';
                    const itemNorm = normalizeText(itemLabel);
                    if (!itemNorm) continue;

                    // Match exact
                    if (inputNorm === itemNorm) {
                        bestMatch = i;
                        bestScore = 100;
                        break;
                    }
                    // L'un contient l'autre
                    if (inputNorm.includes(itemNorm) || itemNorm.includes(inputNorm)) {
                        const score = Math.min(inputNorm.length, itemNorm.length) / Math.max(inputNorm.length, itemNorm.length) * 90;
                        if (score > bestScore) { bestScore = score; bestMatch = i; }
                    }
                    // Mots en commun (au moins 50% des mots de l'option)
                    if (bestScore < 50) {
                        const inputWords = inputNorm.split(/\s+/).filter(w => w.length > 2);
                        const itemWords = itemNorm.split(/\s+/).filter(w => w.length > 2);
                        if (itemWords.length > 0) {
                            const matched = itemWords.filter(iw => inputWords.some(uw => uw === iw || uw.includes(iw) || iw.includes(uw)));
                            const score = (matched.length / itemWords.length) * 70;
                            if (score > bestScore) { bestScore = score; bestMatch = i; }
                        }
                    }
                }

                if (bestMatch !== null && bestScore >= 50) {
                    const selectedItem = items[bestMatch];
                    sessionData.addLog(`Menu reponse texte: "${messageText}" -> ${bestMatch + 1} (${selectedItem.text || selectedItem.title}) [score:${bestScore.toFixed(0)}] de ${senderId}`);

                    const quoteOpts = { quotedMessageId: message.id._serialized };
                    if (selectedItem.response) {
                        await sendMessageHumanized(chat, selectedItem.response, quoteOpts, messageText.length, sessionData);
                    } else if (selectedItem.nextMenu) {
                        await sendInteractiveMenu(chat, selectedItem.nextMenu, sessionData, message);
                    } else {
                        await sendMessageHumanized(chat, `✅ Vous avez sélectionné: ${selectedItem.text || selectedItem.title}`, quoteOpts, messageText.length, sessionData);
                    }
                    return;
                }
            }
        }

        // ✅ Vérifier si le message déclenche un menu (texte uniquement, pas images/médias)
        if (message.type !== 'chat') { /* skip menu trigger for non-text messages */ }
        else {
        const normalizeApostrophes = s => s.replace(/[\u2018\u2019\u201A\u201B\u0060\u00B4]/g, "'");
        const triggerText = normalizeApostrophes(message.body.trim().toLowerCase());
        const cleanPunct = s => normalizeApostrophes(s).replace(/[^\wàâäéèêëïîôùûüç\s'-]/gi, '').replace(/\s+/g, ' ').trim();
        const cleanMsg = cleanPunct(triggerText);
        const messageWords = cleanMsg.split(/\s+/).filter(w => w.length > 2);
        sessionData.addLog(`[DEBUG-TRIGGER] msg="${cleanMsg}" | words=[${messageWords.join(', ')}]`);
        for (const menuId in sessionData.interactiveMenus) {
            const menu = sessionData.interactiveMenus[menuId];
            if (!menu.enabled || !menu.trigger) continue;
            if (menu.groupId && chat.id._serialized !== menu.groupId) continue;
            const triggers = menu.trigger.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
            const matched = triggers.find(t => {
                const cleanT = cleanPunct(t);
                // 1. Match exact (sans ponctuation) : le message EST le trigger ou le contient
                if (cleanMsg === cleanT) return true;
                if (cleanMsg.includes(cleanT) && cleanT.length >= 4) return true;
                if (cleanT.includes(cleanMsg) && cleanMsg.length >= 4) return true;
                // 2. Trigger court (1-2 mots) : chaque mot doit être trouvé dans le message
                const tWords = cleanT.split(/\s+/).filter(w => w.length > 2);
                if (tWords.length <= 2) {
                    return tWords.every(tw => messageWords.some(mw => mw === tw));
                }
                // 3. Trigger long (phrase) : au moins 3 mots-clés significatifs en commun
                const keyWords = tWords.filter(w => w.length > 3);
                if (keyWords.length === 0) return false;
                const found = keyWords.filter(kw => messageWords.some(mw => mw === kw));
                return found.length >= 3 || (found.length >= 2 && found.length >= Math.ceil(keyWords.length * 0.5));
            });
            if (matched) {
                sessionData.addLog(`Menu declenche: ${menuId} par ${senderId} (mot-cle: ${matched})`);
                await sendInteractiveMenu(chat, menuId, sessionData, message);
                return;
            }
        }
        }

        // ✅ Seul le traitement des groupes continue
        if (!chat.isGroup) return;

        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        const senderNumber = senderId.split('@')[0];
        const senderP = participants.find(p => p.id._serialized === senderId || p.id._serialized?.split('@')[0] === senderNumber);

        // ✅ Suppression automatique des notifications de statut (status mentions)
        // Quand un utilisateur identifie un groupe dans son statut WhatsApp, une notification est envoyée dans le groupe
        // NOTE: s'applique MÊME aux groupes exclus — c'est une fonctionnalité indépendante de la modération
        if (sessionData.config.DELETE_STATUS_MENTIONS) {
            const d = message._data || {};
            // Détection d'un message qui cite un statut (status@broadcast)
            const quotedFromStatus = (
                d.quotedParticipant === 'status@broadcast' ||
                d.quotedStanzaID && (d.quotedRemoteJid === 'status@broadcast' || (d.quotedMsg && d.quotedMsg.remoteJid === 'status@broadcast')) ||
                (d.quotedMsg && (d.quotedMsg.from === 'status@broadcast' || d.quotedMsg.remoteJid === 'status@broadcast'))
            );
            const isStatusMention = quotedFromStatus ||
                                    message.type === 'status_mention' ||
                                    message.type === 'status' ||
                                    d.type === 'status_mention' ||
                                    d.isStatusMention === true ||
                                    (message.body && (
                                        message.body.includes('a ajouté ce groupe à son statut') ||
                                        message.body.includes('Ce groupe a été mentionné') ||
                                        message.body.includes('mentioned this group in their status') ||
                                        message.body.includes('This group was mentioned')
                                    ));

            if (isStatusMention) {
                const msgId = message.id._serialized || message.id.id;
                if (!sessionData.isAlreadyProcessed(msgId)) {
                    sessionData.markAsProcessed(msgId);
                    sessionData.addLog(`[STATUS] Notification de statut détectée de ${senderId} dans ${chat.name} (type=${message.type}, quoted=${d.quotedParticipant || d.quotedRemoteJid || 'none'})`);

                    const wasDeleted = await deleteMessageHumanized(message);
                    if (wasDeleted) {
                        sessionData.stats.totalDeleted++;
                        sessionData.addLog(`[STATUS] Notification de statut supprimée dans ${chat.name}`);
                    } else {
                        sessionData.addLog(`[STATUS] Échec suppression notification statut dans ${chat.name}`);
                    }
                }
                return; // Ne pas continuer le traitement normal
            }
        }

        // Exclusion des groupes APRÈS le check status mention
        if (sessionData.isGroupExcluded(chat)) return;

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
                    addLog(`[DIAG] [${sessionId}] Diagnostic envoye dans ${chat.name}`);
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
        
        // ✅ Autoriser directement les admins du groupe (détection dynamique)
        const authorContact = await message.getContact();
        const authorNumber = authorContact?.number || authorId.split('@')[0];
        const authorCusId = authorContact?.id?._serialized;
        
        // Vérifier admin par toutes les méthodes possibles
        if (senderP?.isAdmin || senderP?.isSuperAdmin) return;
        
        const isAdmin = participants.some(p => {
            if (!(p.isAdmin || p.isSuperAdmin)) return false;
            const pId = p.id._serialized;
            const pNum = p.id.user || pId?.split('@')[0];
            return pId === authorId || pId === authorCusId || pNum === authorNumber;
        });
        if (isAdmin) {
            sessionData.addLog(`[ADMIN] ${authorNumber} est admin, lien ignoré`);
            return;
        }
        
        // Vérifier les autres exceptions (utilisateurs whitelisted)
        if (sessionData.isUserExcluded(authorNumber, participants)) return;

        // ✅ Marquer comme lu
        try { await chat.sendSeen(); } catch (e) {}

        const contact = await message.getContact();
        const mention = `@${contact.id.user}`;
        const warningCount = sessionData.addWarning(chat.id._serialized, authorId);
        const remaining = sessionData.config.MAX_WARNINGS - warningCount;
        sessionData.stats.totalWarnings++;

        // ══════════════════════════════════════════════════════
        // ÉTAPE 1 : SUPPRIMER D'ABORD (contenu nuisible)
        // ══════════════════════════════════════════════════════
        const messageBodyLength = message.body?.length || 0;
        try { await message.react('🚫'); } catch (e) {}
        const wasDeleted = await deleteMessageHumanized(message);
        if (wasDeleted) {
            sessionData.stats.totalDeleted++;
            sessionData.addLog(`[SUPPR] Message supprime de ${authorId} dans ${chat.name}`);
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
                sessionData.addLog(`[BAN] ${authorId} banni de ${chat.name}`);
            } catch (banError) {
                sessionData.addLog(`[X] Erreur ban: ${banError.message}`);
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
            sessionData.addLog(`[!] Avertissement ${warningCount}/${sessionData.config.MAX_WARNINGS} pour ${authorId} dans ${chat.name}`);
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
            sessionData.addLog(`[MUTE] Bienvenue desactivee pour ${chat.name}`);
            return;
        }

        let newMemberId = notification.recipient;
        if (notification.id?.participant) newMemberId = notification.id.participant;

        let contact;
        try { contact = await client.getContactById(newMemberId); } catch (e) { return; }

        await HumanBehavior.naturalDelay(
            HumanBehavior.gaussianRandom(5000, 3000)
        );

        const mention = `@${contact.id.user}`;

        const isExcluded = sessionData.isGroupExcluded(chat);

        const welcomeMessage = (isExcluded ? WELCOME_MESSAGE_EXCLUDED : sessionData.config.WELCOME_MESSAGE)
            .replace(/{mention}/g, mention)
            .replace(/{group}/g, chat.name)
            .replace(/{maxWarnings}/g, sessionData.config.MAX_WARNINGS);

        let profilePicUrl = null;
        try { profilePicUrl = await client.getProfilePicUrl(newMemberId); } catch (e) {}

        if (profilePicUrl) {
            try {
                const media = await MessageMedia.fromUrl(profilePicUrl, { unsafeMime: true });
                await rateLimiter.waitUntilAllowed();
                await chat.sendMessage(media, { caption: welcomeMessage, mentions: [contact.id._serialized] });
                rateLimiter.recordAction();
            } catch (e) {
                await sendMessageHumanized(chat, welcomeMessage, { mentions: [contact.id._serialized] }, 0, sessionData);
            }
        } else {
            await sendMessageHumanized(chat, welcomeMessage, { mentions: [contact.id._serialized] }, 0, sessionData);
        }

        sessionData.addLog(`[BIENVENUE] Bienvenue envoye a ${contact.number} dans ${chat.name}${isExcluded ? ' (groupe exclu)' : ''}`);
    } catch (error) {
        sessionData.addLog(`[X] Erreur bienvenue: ${error.message}`);
    }
}

// ============================================================
// 📞 HANDLER APPELS
// ============================================================

const callProcessingLock = new Map(); // { callerId: boolean } par session

async function handleCall(client, call, sessionId) {
    const sessionData = getSessionData(sessionId);
    
    try {
        if (!sessionData.config.CALL_REJECT_ENABLED) return;

        const callerId = call.from;
        sessionData.addLog(`[CALL] Appel entrant de ${callerId}`);

        // Verrou anti-concurrence : si un appel de ce numéro est déjà en cours de traitement,
        // on rejette immédiatement sans enregistrer ni envoyer de message
        const lockKey = `${sessionId}_${callerId}`;
        if (callProcessingLock.get(lockKey)) {
            try { await call.reject(); } catch (e) {}
            sessionData.addLog(`[CALL] Appel ${callerId} rejete (traitement concurrent en cours)`);
            return;
        }
        callProcessingLock.set(lockKey, true);

        let callerNumber = callerId.split('@')[0];
        try {
            const contact = await client.getContactById(callerId);
            if (contact && contact.number) {
                callerNumber = contact.number;
                sessionData.addLog(`Numero associe: ${callerNumber}`);
            }
        } catch (e) {}

        // Vérifier si l'utilisateur est exempté
        const userException = sessionData.userExceptions.excludedUsers.find(u => {
            const exceptionId = typeof u === 'object' ? u.id : u;
            const exceptionNumber = exceptionId.split('@')[0];
            return exceptionId === callerId || exceptionNumber === callerNumber || exceptionId === callerNumber;
        });
        
        if (userException && (typeof userException === 'object' ? userException.callException : false)) {
            sessionData.addLog(`[OK] ${callerNumber} exempté du rejet d'appels - appel ignoré`);
            return;
        }

        if (sessionData.blockedUsers[callerId]) {
            try {
                const contact = await client.getContactById(callerId);
                if (contact.isBlocked) {
                    sessionData.addLog(`[BLOCK] ${callerId} deja bloque`);
                    try { await call.reject(); } catch (e) {} // Rejet immédiat, sans délai
                    return;
                } else {
                    sessionData.addLog(`[UNBLOCK] ${callerId} debloque manuellement, mise a jour`);
                    delete sessionData.blockedUsers[callerId];
                    delete sessionData.callSpamTracker[callerId];
                    if (sessionData.unblockTimers[callerId]) {
                        clearTimeout(sessionData.unblockTimers[callerId]);
                        delete sessionData.unblockTimers[callerId];
                    }
                    sessionData.saveCallSpamData();
                }
            } catch (e) {
                sessionData.addLog(`[!] Erreur verification blocage: ${e.message}`);
            }
        }

        try {
            await call.reject();
            sessionData.addLog(`[REJECT] Appel rejete: ${callerId}`);
            sessionData.stats.totalCallsRejected++;
            rateLimiter.recordAction();
        } catch (rejectError) {
            sessionData.addLog(`[!] Erreur rejet appel: ${rejectError.message}`);
        }

        sessionData.addCallToHistory(callerId, callerNumber, call.isVideo || false, 'rejected');

        // Ajouter l'appel au tracker
        const now = Date.now();
        const windowMs = (sessionData.config.CALL_SPAM_WINDOW_MIN || 30) * 60 * 1000;
        if (!sessionData.callSpamTracker[callerId]) sessionData.callSpamTracker[callerId] = [];
        sessionData.callSpamTracker[callerId] = sessionData.callSpamTracker[callerId].filter(ts => now - ts < windowMs);
        sessionData.callSpamTracker[callerId].push(now);
        const callCount = sessionData.callSpamTracker[callerId].length;
        sessionData.saveCallSpamData();
        
        sessionData.addLog(`[STATS] ${callerId}: ${callCount}/${sessionData.config.CALL_SPAM_THRESHOLD} appels`);

        if (callCount >= sessionData.config.CALL_SPAM_THRESHOLD) {
            sessionData.addLog(`[SPAM] SPAM: ${callerId} - ${callCount} appels -> BLOCAGE`);

            try {
                const postCallDelay = HumanBehavior.postCallMessageDelay();
                await HumanBehavior.naturalDelay(postCallDelay);

                const chat = await client.getChatById(callerId);
                const blockMsg = MessagePool.pick(MessagePool.callBlocked);
                await sendMessageHumanized(chat, blockMsg, {}, 0, sessionData);
            } catch (msgError) {
                sessionData.addLog(`[!] Message pre-blocage echoue: ${msgError.message}`);
            }

            await HumanBehavior.naturalDelay(HumanBehavior.blockDelay());

            // Marquer en interne AVANT le contact.block() pour éviter les appels répétés
            // même si l'API WhatsApp échoue
            sessionData.blockedUsers[callerId] = {
                blockedAt: Date.now(),
                autoUnblock: true,
                callCount: callCount
            };
            sessionData.saveCallSpamData();
            sessionData.addLog(`[LOCK] ${callerId} marque bloque en interne`);

            try {
                const contact = await client.getContactById(callerId);
                if (!contact.isBlocked) {
                    await contact.block();
                    rateLimiter.recordAction();
                    sessionData.addLog(`[LOCK] ${callerId} bloque sur WhatsApp`);
                } else {
                    sessionData.addLog(`[LOCK] ${callerId} deja bloque sur WhatsApp`);
                }

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
                            sessionData.addLog(`[UNBLOCK] ${callerId} debloque automatiquement`);
                        } catch (error) {
                            sessionData.addLog(`[X] Erreur deblocage auto ${callerId}: ${error.message}`);
                        }
                    }
                }, blockDuration);

            } catch (blockError) {
                // blockedUsers est déjà marqué — l'utilisateur sera bloqué en interne
                // même si l'API WhatsApp a échoué
                sessionData.addLog(`[X] Erreur blocage WhatsApp (blocage interne actif): ${blockError.message}`);
            }
            sessionData.saveStats();
            return;
        }

        const msgDelay = HumanBehavior.postCallMessageDelay();
        sessionData.addLog(`[TIMER] Message dans ${Math.round(msgDelay / 1000)}s...`);
        await HumanBehavior.naturalDelay(msgDelay);

        try {
            const chat = await client.getChatById(callerId);
            const remaining = sessionData.config.CALL_SPAM_THRESHOLD - callCount;
            const rejectMsg = MessagePool.pick(
                MessagePool.callRejections, remaining
            );
            await sendMessageHumanized(chat, rejectMsg, {}, 0, sessionData);
            sessionData.addLog(`[MSG] Message envoye a ${callerId}`);
        } catch (msgError) {
            sessionData.addLog(`[X] Erreur message post-appel: ${msgError.message}`);
        }

    } catch (error) {
        const sessionData = getSessionData(sessionId);
        sessionData.addLog(`[X] Erreur handler appel: ${error.message}`);
    } finally {
        const lockKey = `${sessionId}_${call.from}`;
        callProcessingLock.delete(lockKey);
    }
}

// ============================================================
// 🌐 SERVEUR WEB EXPRESS
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Auto-détection de l'URL du site
app.use((req, res, next) => {
    if (!subscriptionSettings.detectedSiteUrl && req.headers.host) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        subscriptionSettings.detectedSiteUrl = `${protocol}://${req.headers.host}`;
        saveSubscriptionSettings();
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Helper pour obtenir l'URL de base
function getBaseUrl(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}`;
}

// Route principale - Landing page avec injection dynamique de l'URL
app.get('/', (req, res) => {
    const baseUrl = getBaseUrl(req);
    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'landing.html'), 'utf8');
    
    // Remplacer les placeholders {{BASE_URL}} par l'URL réelle
    html = html.replace(/\{\{BASE_URL\}\}/g, baseUrl);
    
    res.send(html);
});

// Route pour la page de connexion/inscription utilisateur
app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user-login.html'));
});

// Route pour la page de login admin
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Route pour le panneau d'administration (admin uniquement)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Route pour le dashboard utilisateur (users normaux)
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ API AUTHENTICATION ============

// Vérifier si c'est le premier lancement (pas d'utilisateurs)
app.get('/api/auth/setup-status', (req, res) => {
    const userCount = authManager.userCount();
    res.json({
        needsSetup: userCount === 0,
        userCount
    });
});

// Inscription publique - ouverte à tous les utilisateurs
app.post('/api/auth/register', (req, res) => {
    let { username, password, securityQuestion, securityAnswer } = req.body;
    
    // Normaliser le username avec @
    if (username && !username.startsWith('@')) {
        username = '@' + username;
    }
    
    if (!username || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nom d\'utilisateur et mot de passe requis' 
        });
    }
    
    if (username.length < 4) {
        return res.status(400).json({ 
            success: false, 
            message: 'Le nom d\'utilisateur doit contenir au moins 3 caractères après @' 
        });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ 
            success: false, 
            message: 'Le mot de passe doit contenir au moins 6 caractères' 
        });
    }
    
    if (!securityQuestion || !securityAnswer) {
        return res.status(400).json({ 
            success: false, 
            message: 'Question et réponse de sécurité requises' 
        });
    }
    
    // Les utilisateurs créés via /api/auth/register sont des utilisateurs normaux (pas admin)
    const result = authManager.createUser(username, password, false, securityQuestion, securityAnswer);
    
    if (result.success) {
        // Auto-login après inscription
        const loginResult = authManager.authenticateUser(username, password);
        if (loginResult.success) {
            // Définir le cookie HTTP-only
            res.cookie('authToken', loginResult.token, {
                httpOnly: true,
                secure: false, // false pour développement local (HTTP)
                sameSite: 'lax', // plus permissif pour développement
                maxAge: 24 * 60 * 60 * 1000 // 24 heures
            });
            res.json({ 
                success: true, 
                username: loginResult.username, 
                isAdmin: loginResult.isAdmin 
            });
        } else {
            res.status(400).json(loginResult);
        }
    } else {
        res.status(400).json(result);
    }
});

// Connexion utilisateur
app.post('/api/auth/login', (req, res) => {
    let { username, password } = req.body;
    
    // Normaliser le username avec @
    if (username && !username.startsWith('@')) {
        username = '@' + username;
    }
    
    if (!username || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nom d\'utilisateur et mot de passe requis' 
        });
    }
    
    // Vérifier si c'est l'admin (non autorisé via cette route)
    if (authManager.admin && username === authManager.admin.username) {
        return res.status(403).json({ 
            success: false, 
            message: 'Les administrateurs doivent utiliser /admin/login' 
        });
    }
    
    const result = authManager.authenticateUser(username, password);
    
    if (result.success) {
        res.cookie('authToken', result.token, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000
        });
        res.json({ 
            success: true, 
            username: result.username, 
            isAdmin: false,
            mustChangePassword: result.mustChangePassword || false
        });
    } else {
        res.status(401).json(result);
    }
});

// Connexion admin (route dédiée)
app.post('/api/auth/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nom d\'utilisateur et mot de passe requis' 
        });
    }
    
    const result = authManager.authenticateAdmin(username, password);
    
    if (result.success) {
        res.cookie('authToken', result.token, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000
        });
        res.json({ 
            success: true, 
            username: result.username, 
            isAdmin: true,
            mustChangePassword: result.mustChangePassword
        });
    } else {
        res.status(401).json(result);
    }
});

// Déconnexion
app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies.authToken;
    
    if (token) {
        authManager.logoutUser(token);
    }
    
    // Effacer le cookie
    res.clearCookie('authToken', {
        httpOnly: true,
        sameSite: 'lax'
    });
    
    res.json({ success: true, message: 'Déconnecté' });
});

// Vérifier le token actuel
app.get('/api/auth/verify', (req, res) => {
    const token = req.cookies.authToken;
    
    if (!token) {
        return res.status(401).json({ 
            valid: false, 
            message: 'Aucun token fourni',
            requireAuth: true 
        });
    }
    
    const validation = authManager.validateToken(token);
    
    if (validation.valid) {
        res.json({ 
            success: true, 
            user: {
                username: validation.username,
                isAdmin: validation.isAdmin 
            }
        });
    } else {
        res.status(401).json({ 
            valid: false, 
            message: validation.message,
            requireAuth: true 
        });
    }
});

// === MODE BETA ===

// Obtenir le statut du mode Beta (public)
app.get('/api/beta-status', (req, res) => {
    res.json({ betaMode: betaMode });
});

// Modifier le mode Beta (admin uniquement)
app.post('/api/admin/beta-mode', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const { enabled } = req.body;
    betaMode = !!enabled;
    saveBetaMode();
    res.json({ success: true, betaMode: betaMode });
});

// === RÉCUPÉRATION PAR QUESTION DE SÉCURITÉ ===

// Obtenir la question de sécurité d'un utilisateur
app.post('/api/auth/recovery/question', (req, res) => {
    let { username } = req.body;
    
    // Normaliser le username avec @
    if (username && !username.startsWith('@')) {
        username = '@' + username;
    }
    
    if (!username) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nom d\'utilisateur requis' 
        });
    }
    
    const result = authManager.getSecurityQuestion(username);
    
    if (result.success) {
        res.json({ success: true, question: result.question });
    } else {
        res.status(400).json(result);
    }
});

// Vérifier la réponse de sécurité
app.post('/api/auth/recovery/verify', (req, res) => {
    let { username, answer } = req.body;
    
    // Normaliser le username avec @
    if (username && !username.startsWith('@')) {
        username = '@' + username;
    }
    
    if (!username || !answer) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nom d\'utilisateur et réponse requis' 
        });
    }
    
    const result = authManager.verifySecurityAnswer(username, answer);
    
    if (result.success) {
        // Définir un cookie de récupération temporaire
        res.cookie('recoveryToken', result.recoveryToken, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 15 * 60 * 1000 // 15 minutes
        });
        res.json({ success: true, message: 'Réponse correcte' });
    } else {
        res.status(400).json(result);
    }
});

// Réinitialiser le mot de passe avec le token de récupération
app.post('/api/auth/recovery/reset', (req, res) => {
    const { newPassword } = req.body;
    const recoveryToken = req.cookies.recoveryToken;
    
    if (!recoveryToken) {
        return res.status(400).json({ 
            success: false, 
            message: 'Session de récupération invalide' 
        });
    }
    
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ 
            success: false, 
            message: 'Le mot de passe doit contenir au moins 6 caractères' 
        });
    }
    
    const result = authManager.resetPasswordWithToken(recoveryToken, newPassword);
    
    if (result.success) {
        // Effacer le cookie de récupération
        res.clearCookie('recoveryToken', {
            httpOnly: true,
            sameSite: 'lax'
        });
        res.json({ success: true, message: result.message });
    } else {
        res.status(400).json(result);
    }
});

// === GESTION DES UTILISATEURS (Admin uniquement) ===

// Lister les utilisateurs
app.get('/api/auth/users', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    res.json({ success: true, users: authManager.getAllUsers() });
});

// Détails d'un utilisateur spécifique
app.get('/api/auth/users/:username', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    const username = req.params.username;
    const user = authManager.users[username];
    
    if (!user) {
        return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    
    // Récupérer les sessions de l'utilisateur
    const userSessions = sessionManager.getUserSessions(username);
    
    // Récupérer les statistiques de chaque session
    const sessionsWithStats = userSessions.map(function(session) {
        const sessionData = sessionDataManagers.get(session.id);
        return Object.assign({}, session, {
            stats: sessionData ? sessionData.stats : { totalDeleted: 0, totalWarnings: 0, totalBanned: 0, totalCallsRejected: 0 }
        });
    });
    
    // Calculer les totaux
    const totalStats = sessionsWithStats.reduce(function(acc, s) {
        return {
            totalDeleted: acc.totalDeleted + (s.stats && s.stats.totalDeleted || 0),
            totalWarnings: acc.totalWarnings + (s.stats && s.stats.totalWarnings || 0),
            totalBanned: acc.totalBanned + (s.stats && s.stats.totalBanned || 0),
            totalCallsRejected: acc.totalCallsRejected + (s.stats && s.stats.totalCallsRejected || 0)
        };
    }, { totalDeleted: 0, totalWarnings: 0, totalBanned: 0, totalCallsRejected: 0 });
    
    res.json({
        success: true,
        user: {
            username: user.username,
            isAdmin: user.isAdmin,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin,
            mustChangePassword: user.mustChangePassword || false,
            hasSecurityQuestion: !!user.securityQuestion
        },
        sessions: sessionsWithStats,
        stats: totalStats
    });
});

// Créer un utilisateur (admin uniquement)
app.post('/api/auth/users', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    const { username, password, isAdmin } = req.body;
    const result = authManager.createUser(username, password, isAdmin || false);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Supprimer un utilisateur (admin uniquement)
app.delete('/api/auth/users/:username', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    // Empêcher de se supprimer soi-même
    if (req.params.username === req.user.username) {
        return res.status(400).json({ 
            success: false, 
            message: 'Vous ne pouvez pas supprimer votre propre compte' 
        });
    }
    
    const result = authManager.deleteUser(req.params.username);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(404).json(result);
    }
});

// Changer le mot de passe admin
app.put('/api/auth/admin/password', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    const result = authManager.changeAdminPassword(req.body.password);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Changer le mot de passe d'un utilisateur (utilisateur uniquement)
app.put('/api/auth/users/:username/password', requireAuth, (req, res) => {
    const targetUsername = req.params.username;
    
    // L'admin ne peut pas utiliser cette route
    if (req.user.isAdmin) {
        return res.status(400).json({ 
            success: false, 
            message: 'L\'admin doit utiliser /api/auth/admin/password' 
        });
    }
    
    // L'utilisateur ne peut changer que son propre mot de passe
    if (targetUsername !== req.user.username) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès non autorisé' 
        });
    }
    
    const result = authManager.changePassword(targetUsername, req.body.password);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Modifier les droits admin (admin uniquement)
app.put('/api/auth/users/:username/admin', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    const result = authManager.setAdmin(req.params.username, req.body.isAdmin);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(404).json(result);
    }
});

// ============ API SUGGESTIONS ============

// Envoyer une suggestion (tous les utilisateurs connectés)
app.post('/api/suggestions', requireAuth, (req, res) => {
    const { type, text } = req.body;
    const username = req.user.username;
    
    if (!text || !text.trim()) {
        return res.status(400).json({ 
            success: false, 
            message: 'Le commentaire ne peut pas être vide' 
        });
    }
    
    if (text.length > 2000) {
        return res.status(400).json({ 
            success: false, 
            message: 'Le commentaire est trop long (max 2000 caractères)' 
        });
    }
    
    const suggestion = suggestionsManager.addSuggestion(username, type || 'other', text.trim());
    addLog(`[SUGGESTION] Nouveau commentaire de ${username}: ${type}`);
    
    res.json({ 
        success: true, 
        message: 'Commentaire envoyé avec succès',
        suggestion: {
            id: suggestion.id,
            type: suggestion.type,
            createdAt: suggestion.createdAt
        }
    });
});

// Lister les suggestions (admin uniquement)
app.get('/api/suggestions', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    const suggestions = suggestionsManager.getAllSuggestions();
    res.json({ 
        success: true, 
        suggestions: suggestions.map(s => ({
            id: s.id,
            username: s.username,
            type: s.type,
            text: s.text,
            createdAt: s.createdAt,
            read: s.read
        }))
    });
});

// Supprimer une suggestion (admin uniquement)
app.delete('/api/suggestions/:id', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ 
            success: false, 
            message: 'Accès réservé aux administrateurs' 
        });
    }
    
    const deleted = suggestionsManager.deleteSuggestion(req.params.id);
    
    if (deleted) {
        addLog(`[SUGGESTION] Supprimée: ${req.params.id}`);
        res.json({ success: true, message: 'Suggestion supprimée' });
    } else {
        res.status(404).json({ success: false, message: 'Suggestion non trouvée' });
    }
});

// ============ API ABONNEMENTS ============

// Obtenir les paramètres d'abonnement publics (clé API, montant, etc.)
app.get('/api/subscription/settings', (req, res) => {
    res.json({
        success: true,
        enabled: subscriptionSettings.enabled,
        amount: subscriptionSettings.amount,
        currency: subscriptionSettings.currency,
        durationDays: subscriptionSettings.durationDays,
        description: subscriptionSettings.description,
        apiKey: subscriptionSettings.apiKey
    });
});

// Obtenir le statut d'abonnement de l'utilisateur connecté
app.get('/api/subscription/status', requireAuth, (req, res) => {
    const username = req.user.username;
    const sub = getUserSubscription(username);
    const active = isSubscriptionActive(username);
    
    res.json({
        success: true,
        enabled: subscriptionSettings.enabled,
        subscription: sub ? {
            status: active ? 'active' : (sub.status || 'expired'),
            expiresAt: sub.expiresAt,
            activatedAt: sub.activatedAt,
            daysRemaining: active ? Math.ceil((sub.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)) : 0
        } : null,
        isActive: active,
        isAdmin: req.user.isAdmin
    });
});

// Confirmer un paiement réussi et activer l'abonnement
app.post('/api/subscription/confirm', requireAuth, (req, res) => {
    const { paymentId, amount, currency } = req.body;
    const username = req.user.username;
    
    if (!paymentId) {
        return res.status(400).json({ success: false, message: 'ID de paiement requis' });
    }
    
    if (!subscriptionSettings.enabled) {
        return res.json({ success: true, message: 'Abonnement non requis' });
    }
    
    const sub = activateSubscription(username, paymentId, amount || subscriptionSettings.amount, currency || subscriptionSettings.currency);
    
    res.json({
        success: true,
        message: 'Abonnement activé avec succès',
        subscription: {
            status: sub.status,
            expiresAt: sub.expiresAt,
            daysRemaining: Math.ceil((sub.expiresAt - Date.now()) / (24 * 60 * 60 * 1000))
        }
    });
});

// Admin: obtenir les paramètres complets d'abonnement
app.get('/api/admin/subscription/settings', requireAdmin, (req, res) => {
    res.json({
        success: true,
        settings: subscriptionSettings
    });
});

// Admin: modifier les paramètres d'abonnement
app.post('/api/admin/subscription/settings', requireAdmin, (req, res) => {
    const { enabled, apiKey, amount, currency, durationDays, description, trialEnabled, trialDurationDays } = req.body;
    
    if (enabled !== undefined) subscriptionSettings.enabled = !!enabled;
    if (apiKey !== undefined) subscriptionSettings.apiKey = apiKey;
    if (amount !== undefined) subscriptionSettings.amount = parseInt(amount) || 5000;
    if (currency !== undefined) subscriptionSettings.currency = currency;
    if (durationDays !== undefined) subscriptionSettings.durationDays = parseInt(durationDays) || 30;
    if (description !== undefined) subscriptionSettings.description = description;
    if (trialEnabled !== undefined) subscriptionSettings.trialEnabled = !!trialEnabled;
    if (trialDurationDays !== undefined) subscriptionSettings.trialDurationDays = parseInt(trialDurationDays) || 0;
    if (req.body.siteUrl !== undefined) subscriptionSettings.siteUrl = req.body.siteUrl;
    
    saveSubscriptionSettings();
    addLog(`[SUB] Paramètres d'abonnement mis à jour par ${req.user.username}`);
    
    // Si le système vient d'être activé, envoyer les notifications automatiquement
    if (enabled === true) {
        checkSubscriptions().then(result => {
            addLog(`[SUB] Notifications auto: ${result.notified} notifiés, ${result.warned} avertis, ${result.disconnected} déconnectés`);
        }).catch(e => {
            addLog(`[SUB] Erreur notifications auto: ${e.message}`);
        });
    }
    
    res.json({ success: true, settings: subscriptionSettings });
});

// Admin: envoyer manuellement les notifications d'abonnement
app.post('/api/admin/subscription/notify', requireAdmin, async (req, res) => {
    // Reset les états et redémarrer les sessions déconnectées
    let restarted = 0;
    for (const [sessionId, state] of Object.entries(subWarningState)) {
        if (state >= 2) {
            // Redémarrer la session si elle était déconnectée
            try {
                sessionManager.startSession(sessionId);
                restarted++;
                addLog(`[SUB] Session ${sessionId} redémarrée par ${req.user.username}`);
            } catch (e) {
                addLog(`[SUB] Erreur redémarrage ${sessionId}: ${e.message}`);
            }
        }
        delete subWarningState[sessionId];
    }
    
    // Attendre que les sessions se reconnectent
    if (restarted > 0) {
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
    
    // Lancer l'étape 1 sur toutes les sessions sans abonnement
    const result = await checkSubscriptions();
    addLog(`[SUB] Notifications manuelles par ${req.user.username}: ${restarted} redémarrées, ${result.notified} notifiés`);
    
    res.json({ success: true, restarted, ...result });
});

// Admin: lister tous les abonnements
app.get('/api/admin/subscriptions', requireAdmin, (req, res) => {
    const allSubs = Object.entries(subscriptions).map(([username, sub]) => ({
        username,
        ...sub,
        isActive: isSubscriptionActive(username),
        daysRemaining: sub.expiresAt > Date.now() ? Math.ceil((sub.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)) : 0
    }));
    
    res.json({ success: true, subscriptions: allSubs });
});

// Admin: activer/prolonger manuellement un abonnement
app.post('/api/admin/subscriptions/:username', requireAdmin, (req, res) => {
    const { username } = req.params;
    const { durationDays } = req.body;
    
    const user = authManager.users[username];
    if (!user) {
        return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    
    const days = parseInt(durationDays) || subscriptionSettings.durationDays;
    const now = Date.now();
    const durationMs = days * 24 * 60 * 60 * 1000;
    const existing = subscriptions[username];
    let expiresAt;
    
    if (existing && existing.status === 'active' && existing.expiresAt > now) {
        expiresAt = existing.expiresAt + durationMs;
    } else {
        expiresAt = now + durationMs;
    }
    
    subscriptions[username] = {
        status: 'active',
        paymentId: 'admin_manual',
        amount: 0,
        currency: subscriptionSettings.currency,
        activatedAt: now,
        expiresAt,
        history: [
            ...(existing?.history || []),
            { paymentId: 'admin_manual', amount: 0, currency: subscriptionSettings.currency, date: now, grantedBy: req.user.username }
        ]
    };
    
    saveSubscriptions();
    addLog(`[SUB] Abonnement accordé manuellement à ${username} par ${req.user.username} (${days} jours)`);
    
    res.json({ success: true, message: `Abonnement activé pour ${days} jours` });
});

// Admin: révoquer un abonnement
app.delete('/api/admin/subscriptions/:username', requireAdmin, (req, res) => {
    const { username } = req.params;
    
    if (subscriptions[username]) {
        subscriptions[username].status = 'revoked';
        subscriptions[username].expiresAt = Date.now();
        saveSubscriptions();
        addLog(`[SUB] Abonnement révoqué pour ${username} par ${req.user.username}`);
    }
    
    res.json({ success: true, message: 'Abonnement révoqué' });
});

// ============ API SESSIONS (protégées) ============

app.get('/api/sessions', requireAuth, (req, res) => {
    const allSessions = sessionManager.getAllSessionsStatus();
    // Filtrer les sessions: admin voit tout, utilisateur normal voit seulement ses sessions
    const sessions = req.user.isAdmin 
        ? allSessions 
        : allSessions.filter(s => s.ownerUsername === req.user.username);
    const effectiveActiveId = req.user.isAdmin
        ? sessionManager.activeSessionId
        : sessionManager.getEffectiveSessionId(req.user.username, false, null);
    res.json({
        sessions,
        activeSessionId: effectiveActiveId
    });
});

app.post('/api/sessions', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        const username = req.user.username;
        
        // Vérifier que l'utilisateur existe toujours
        const check = sessionManager.canUserStartSession(username);
        if (!check.allowed) {
            return res.status(403).json({ success: false, message: check.reason, requireSubscription: check.requireSubscription || false });
        }
        
        const sessionData = sessionManager.createSession(null, name || 'New Session', username);
        sessionManager.startSession(sessionData.id);
        addLog(`[NEW] Nouvelle session créée: ${sessionData.id} par ${username}`);
        res.json({ success: true, session: sessionData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/sessions/:id', requireAuth, (req, res) => {
    const session = sessionManager.sessionsList[req.params.id];
    if (!session) return res.status(404).json({ success: false, message: 'Session non trouvée' });
    if (!req.user.isAdmin && session.ownerUsername !== req.user.username) {
        return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }
    const status = sessionManager.getSessionStatus(req.params.id);
    res.json(status);
});

app.post('/api/sessions/:id/activate', requireAuth, (req, res) => {
    const session = sessionManager.sessionsList[req.params.id];
    if (!session) return res.status(404).json({ success: false, message: 'Session non trouvée' });
    if (!req.user.isAdmin && session.ownerUsername !== req.user.username) {
        return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }
    const success = sessionManager.setActiveSession(req.params.id);
    if (success) {
        res.json({ success: true, message: 'Session activée' });
    } else {
        res.status(500).json({ success: false, message: 'Erreur activation' });
    }
});

// Démarrer manuellement une session
app.post('/api/sessions/:id/start', requireAuth, (req, res) => {
    const sessionId = req.params.id;
    const session = sessionManager.sessionsList[sessionId];
    
    if (!session) {
        return res.status(404).json({ success: false, message: 'Session non trouvée' });
    }
    
    // Vérifier les droits: admin ou propriétaire
    const isOwner = session.ownerUsername === req.user.username;
    const isAdmin = req.user.isAdmin;
    
    if (!isOwner && !isAdmin) {
        return res.status(403).json({ success: false, message: 'Vous n\'êtes pas autorisé à démarrer cette session' });
    }
    
    // Vérifier l'abonnement pour les utilisateurs non-admin
    if (!isAdmin && subscriptionSettings.enabled && !isSubscriptionActive(req.user.username)) {
        return res.status(403).json({ success: false, message: 'SUBSCRIPTION_REQUIRED', requireSubscription: true });
    }
    
    const success = sessionManager.startSession(sessionId);
    if (success) {
        res.json({ success: true, message: 'Session démarrée' });
    } else {
        res.status(500).json({ success: false, message: 'Erreur lors du démarrage' });
    }
});

app.post('/api/sessions/:id/stop', requireAuth, async (req, res) => {
    const session = sessionManager.sessionsList[req.params.id];
    if (!session) return res.status(404).json({ success: false, message: 'Session non trouvée' });
    if (!req.user.isAdmin && session.ownerUsername !== req.user.username) {
        return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }
    const success = await sessionManager.stopSession(req.params.id);
    if (success) {
        res.json({ success: true, message: 'Session arrêtée' });
    } else {
        res.status(500).json({ success: false, message: 'Erreur arrêt session' });
    }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
    const session = sessionManager.sessionsList[req.params.id];
    if (!session) return res.status(404).json({ success: false, message: 'Session non trouvée' });
    if (!req.user.isAdmin && session.ownerUsername !== req.user.username) {
        return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }
    const success = await sessionManager.deleteSession(req.params.id);
    if (success) {
        res.json({ success: true, message: 'Session supprimée' });
    } else {
        res.status(500).json({ success: false, message: 'Erreur suppression session' });
    }
});

app.get('/api/status', requireAuth, (req, res) => {
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

app.get('/api/config', requireAuth, (req, res) => {
    // Utiliser la config de la session active ou la config globale
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
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
        CALL_BLOCK_DURATION_MIN: config.CALL_BLOCK_DURATION_MIN,
        DELETE_STATUS_MENTIONS: config.DELETE_STATUS_MENTIONS
    });
});

app.post('/api/config', requireAuth, (req, res) => {
    try {
        // Utiliser la config de la session active ou la config globale
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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
        if (nc.DELETE_STATUS_MENTIONS !== undefined) config.DELETE_STATUS_MENTIONS = nc.DELETE_STATUS_MENTIONS === true || nc.DELETE_STATUS_MENTIONS === 'true';
        
        if (sessionData) {
            sessionData.saveConfig();
            sessionData.addLog('[CONFIG] Configuration mise a jour');
        } else {
            saveConfig();
            addLog('[CONFIG] Configuration mise a jour');
        }
        res.json({ success: true, message: 'Configuration enregistrée', sessionId: sessionId || 'global' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
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
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.stats : STATS) }); 
    }
});

app.get('/api/logs', requireAuth, (req, res) => {
    const username = req.user.username;
    const isAdmin = req.user.isAdmin;
    
    // Les admins voient les logs globaux (du plus récent au plus ancien) avec le propriétaire
    if (isAdmin) {
        const formattedLogs = LOGS.map(log => {
            let logStr = typeof log === 'string' ? log : `[${log.display}] ${log.message}`;
            
            // Extraire l'ID de session du log et ajouter le propriétaire
            const sessionMatch = logStr.match(/\[([a-z0-9_]+)\]/);
            if (sessionMatch) {
                const sessionId = sessionMatch[1];
                const sessionInfo = sessionManager.sessionsList[sessionId];
                if (sessionInfo && sessionInfo.ownerUsername) {
                    // Remplacer l'ID de session par le nom du propriétaire
                    logStr = logStr.replace(`[${sessionId}]`, `[${sessionInfo.ownerUsername}]`);
                }
            }
            return logStr;
        }).reverse();
        return res.json({ sessionId: 'global', logs: formattedLogs });
    }
    
    // Les utilisateurs normaux voient seulement les logs de leurs sessions
    const userSessions = sessionManager.getUserSessions(username);
    const allLogs = [];
    
    for (const session of userSessions) {
        const sessionData = sessionDataManagers.get(session.id);
        if (sessionData && sessionData.logs) {
            for (const log of sessionData.logs) {
                if (typeof log === 'string') {
                    allLogs.push(`[${session.id}] ${log}`);
                } else {
                    allLogs.push(`[${log.display}] [${session.id}] ${log.message}`);
                }
            }
        }
    }
    
    // Trier par timestamp (plus récent en premier)
    allLogs.reverse();
    
    res.json({ sessionId: 'user', logs: allLogs.slice(0, 200) });
});

// Vider les logs (admin uniquement)
app.post('/api/logs/clear', requireAuth, (req, res) => {
    if (!req.user.isAdmin) {
        return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    
    clearAllLogs();
    res.json({ success: true, message: 'Logs vidés' });
});

app.get('/api/stats/groups', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
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

app.get('/api/stats/deleted', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const deletedLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('supprimé') || msg.includes('Supprimé');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalDeleted, recent: deletedLogs.slice(-20).reverse() });
});

app.get('/api/stats/warnings', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const warningLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('avertissement') || msg.includes('Avertissement');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalWarnings, recent: warningLogs.slice(-20).reverse() });
});

app.get('/api/stats/banned', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const bannedLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('banni') || msg.includes('Banni') || msg.includes('bloqué');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalBanned, recent: bannedLogs.slice(-20).reverse() });
});

app.get('/api/stats/calls', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const logs = sessionData ? sessionData.logs : LOGS;
    const stats = sessionData ? sessionData.stats : STATS;
    
    const callLogs = logs.filter(l => {
        const msg = typeof l === 'object' ? l.message : l;
        return msg.includes('Appel') || msg.includes('appel') || msg.includes('rejeté');
    }).map(l => typeof l === 'object' ? `[${l.display}] ${l.message}` : l);
    res.json({ sessionId: sessionId || 'global', total: stats.totalCallsRejected, recent: callLogs.slice(-20).reverse() });
});

app.get('/api/calls/history', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const history = sessionData ? (sessionData.callHistory || []) : [];
    res.json({ sessionId: sessionId || 'global', total: history.length, history: history.slice(-50).reverse() });
});

// ============ API ACTIVITY CHART ============

app.get('/api/stats/activity', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
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
            const logDate = typeof log === 'object' ? log.timestamp.substring(0, 10) : log.substring(1, 11);
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

app.post('/api/scan', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });
        
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog('[SCAN] Scan manuel via interface');
        else addLog('[SCAN] Scan manuel via interface');
        
        const result = await scanAllGroups(sessionId);
        res.json({ success: true, sessionId: sessionId || 'global', ...result });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/warnings', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (sessionData) {
            sessionData.warnings = {};
            sessionData.saveWarnings();
            sessionData.addLog('[SUPPR] Avertissements effaces');
        } else {
            fs.writeFileSync(WARNINGS_FILE, JSON.stringify({}));
            addLog('[SUPPR] Avertissements effaces');
        }
        res.json({ success: true, sessionId: sessionId || 'global' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/groups', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
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

app.get('/api/groups/all', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        if (!activeClient) {
            if (sessionData) sessionData.addLog('[!] /api/groups/all: Aucune session active');
            else addLog('[!] /api/groups/all: Aucune session active');
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
        
        if (sessionData) sessionData.addLog(`[GROUPS] /api/groups/all: ${groups.length} groupes trouves`);
        else addLog(`[GROUPS] /api/groups/all: ${groups.length} groupes trouves`);
        res.json(groups);
    } catch (error) {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog(`[X] Erreur /api/groups/all: ${error.message}`);
        else addLog(`[X] Erreur /api/groups/all: ${error.message}`);
        res.status(500).json([]);
    }
});

app.post('/api/groups/leave', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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
        
        if (sessionData) sessionData.addLog(`[LEAVE] Bot a quitte le groupe: ${groupName}`);
        else addLog(`[LEAVE] Bot a quitte le groupe: ${groupName}`);
        res.json({ success: true, message: 'Groupe quitté' });
    } catch (error) {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog(`[X] Erreur quitter groupe: ${error.message}`);
        else addLog(`[X] Erreur quitter groupe: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/groups/delete', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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
        if (sessionData) sessionData.addLog(`[SUPPR] Groupe supprime (bot etait admin): ${chat.name}`);
        else addLog(`[SUPPR] Groupe supprime (bot etait admin): ${chat.name}`);
        res.json({ success: true, message: 'Groupe quitté (suppression complète non supportée par l\'API)' });
    } catch (error) {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog(`[X] Erreur suppression groupe: ${error.message}`);
        else addLog(`[X] Erreur suppression groupe: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/groups/exceptions', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS) });
});

app.post('/api/groups/exceptions', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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

app.delete('/api/groups/exceptions', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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

app.post('/api/groups/welcome', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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

app.get('/api/users/exceptions', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.userExceptions : USER_EXCEPTIONS) });
});

app.post('/api/users/exceptions', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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

app.delete('/api/users/exceptions', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.userExceptions : USER_EXCEPTIONS;
        
        const { userId } = req.body;
        exceptions.excludedUsers = exceptions.excludedUsers.filter(u => u.id !== userId);
        
        if (sessionData) sessionData.saveUserExceptions();
        else saveUserExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/users/exceptions/admins', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.userExceptions : USER_EXCEPTIONS;
        
        exceptions.excludedAdmins = req.body.excludedAdmins;
        
        if (sessionData) sessionData.saveUserExceptions();
        else saveUserExceptions();
        res.json({ success: true, sessionId: sessionId || 'global', exceptions });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============ API BLOCAGE APPELS ============

app.get('/api/blocked', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', blockedUsers: sessionData ? sessionData.blockedUsers : blockedUsers });
});

app.post('/api/blocked/unblock', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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
            sessionData.addLog(`[UNBLOCK] ${userId} debloque manuellement`);
        } else {
            saveCallSpamData();
            addLog(`[UNBLOCK] ${userId} debloque manuellement`);
        }
        res.json({ success: true, sessionId: sessionId || 'global', message: 'Débloqué' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/ratelimit', requireAuth, (req, res) => {
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

app.get('/api/menus', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', menus: sessionData ? sessionData.interactiveMenus : interactiveMenus });
});

app.get('/api/menus/:id', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
    
    const menu = menus[req.params.id];
    if (!menu) return res.status(404).json({ success: false, message: 'Menu non trouvé' });
    res.json({ sessionId: sessionId || 'global', menu });
});

app.post('/api/menus', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        
        const menu = createMenu(req.body, sessionData);
        if (sessionData) sessionData.addLog(`[MENU] Menu cree: ${menu.id}`);
        else addLog(`[MENU] Menu cree: ${menu.id}`);
        res.json({ success: true, sessionId: sessionId || 'global', menu });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/menus/:id', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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
            sessionData.addLog(`[EDIT] Menu mis a jour: ${menuId}`);
        } else {
            saveMenus();
            addLog(`[EDIT] Menu mis a jour: ${menuId}`);
        }
        res.json({ success: true, sessionId: sessionId || 'global', menu: menus[menuId] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/menus/:id', requireAuth, (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
        
        const menuId = req.params.id;
        if (!menus[menuId]) {
            return res.status(404).json({ success: false, message: 'Menu non trouvé' });
        }

        delete menus[menuId];
        
        if (sessionData) {
            sessionData.saveMenus();
            sessionData.addLog(`[SUPPR] Menu supprime: ${menuId}`);
        } else {
            saveMenus();
            addLog(`[SUPPR] Menu supprime: ${menuId}`);
        }
        res.json({ success: true, sessionId: sessionId || 'global' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/menus/:id/test', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
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
        if (sessionData) sessionData.addLog(`[TEST] Menu teste: ${menuId} dans ${targetChat.name}`);
        else addLog(`[TEST] Menu teste: ${menuId} dans ${targetChat.name}`);
        res.json({ success: true, sessionId: sessionId || 'global', groupName: targetChat.name });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============ API ANNONCES ============

// Liste des annonces
app.get('/api/announcements', requireAuth, (req, res) => {
    const announcements = announcementsManager.getAllAnnouncements(req.user.username, req.user.isAdmin);
    res.json({ 
        success: true, 
        announcements: announcements.map(a => ({
            id: a.id,
            title: a.title,
            content: a.content.substring(0, 100) + (a.content.length > 100 ? '...' : ''),
            groups: a.groups,
            status: a.status,
            hasImage: !!a.image,
            createdAt: a.createdAt,
            publishedAt: a.publishedAt,
            publishedGroupsCount: a.publishedGroups?.length || 0,
            username: a.username
        }))
    });
});

// Obtenir les groupes où le bot est admin (pour la sélection lors de la création d'annonce)
// IMPORTANT: Cette route doit être AVANT /api/announcements/:id
app.get('/api/announcements/groups', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
        const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        
        if (!sessionClient || !sessionClient.info) {
            return res.json({ success: true, groups: [], message: 'Session non connectée' });
        }
        
        const chats = await sessionClient.getChats();
        const botId = sessionClient.info.wid._serialized;
        const allGroups = chats.filter(c => c.isGroup);
        const adminGroups = [];
        
        for (const chat of allGroups) {
            const botParticipant = chat.participants?.find(p => p.id._serialized === botId);
            const isAdmin = botParticipant?.isAdmin || botParticipant?.isSuperAdmin || false;
            if (isAdmin) {
                adminGroups.push({
                    id: chat.id._serialized,
                    name: chat.name,
                    participants: chat.participants?.length || 0
                });
            }
        }
        
        res.json({ success: true, groups: adminGroups, total: adminGroups.length });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Statistiques des annonces (AVANT :id pour ne pas être capturé par le paramètre)
app.get('/api/announcements/stats', requireAuth, (req, res) => {
    const stats = announcementsManager.getStats();
    res.json({ success: true, stats });
});

// Détails d'une annonce
app.get('/api/announcements/:id', requireAuth, (req, res) => {
    const announcement = announcementsManager.getAnnouncement(req.params.id);
    if (!announcement) {
        return res.status(404).json({ success: false, message: 'Annonce non trouvée' });
    }
    
    // Vérifier les droits
    if (!req.user.isAdmin && announcement.username !== req.user.username) {
        return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }
    
    const { image: _img, ...announcementWithoutImage } = announcement;
    res.json({ success: true, announcement: { ...announcementWithoutImage, hasImage: !!_img } });
});

// Créer une annonce
app.post('/api/announcements', requireAuth, (req, res) => {
    try {
        const { title, content, rawContent, groups, linkPreview, image, sendAsHd, scheduledAt } = req.body;
        
        if (!content || content.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Le contenu est requis' });
        }
        
        const announcement = announcementsManager.createAnnouncement(req.user.username, {
            title,
            content,
            rawContent,
            groups: groups || [],
            linkPreview,
            image: image || null,
            sendAsHd: !!sendAsHd,
            scheduledAt
        });
        
        const { image: _img, ...announcementWithoutImage } = announcement;
        res.json({ success: true, announcement: { ...announcementWithoutImage, hasImage: !!_img } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Modifier une annonce
app.put('/api/announcements/:id', requireAuth, (req, res) => {
    try {
        const announcement = announcementsManager.updateAnnouncement(
            req.params.id, 
            req.body, 
            req.user.username, 
            req.user.isAdmin
        );
        
        if (!announcement) {
            return res.status(404).json({ success: false, message: 'Annonce non trouvée ou non modifiable' });
        }
        
        const { image: _img, ...announcementWithoutImage } = announcement;
        res.json({ success: true, announcement: { ...announcementWithoutImage, hasImage: !!_img } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Supprimer une annonce
app.delete('/api/announcements/:id', requireAuth, (req, res) => {
    try {
        const deleted = announcementsManager.deleteAnnouncement(
            req.params.id, 
            req.user.username, 
            req.user.isAdmin
        );
        
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Annonce non trouvée ou non supprimable' });
        }
        
        res.json({ success: true, message: 'Annonce supprimée' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Publier une annonce
app.post('/api/announcements/:id/publish', requireAuth, async (req, res) => {
    try {
        const announcement = announcementsManager.getAnnouncement(req.params.id);
        
        if (!announcement) {
            return res.status(404).json({ success: false, message: 'Annonce non trouvée' });
        }
        
        // Vérifier les droits
        if (!req.user.isAdmin && announcement.username !== req.user.username) {
            return res.status(403).json({ success: false, message: 'Accès non autorisé' });
        }
        
        // Vérifier que l'annonce a des groupes cibles
        if (!announcement.groups || announcement.groups.length === 0) {
            return res.status(400).json({ success: false, message: 'Aucun groupe sélectionné' });
        }
        
        // Vérifier qu'une session est active
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body?.sessionId);
        const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        
        if (!sessionClient || !sessionClient.info) {
            return res.status(400).json({ success: false, message: 'Aucune session WhatsApp connectée' });
        }
        
        // Lancer la publication en arrière-plan
        publishAnnouncement(sessionId, announcement).then(result => {
            addLog(`[ANNONCE] Publication terminée: ${result.publishedCount}/${announcement.groups.length} groupes`);
        }).catch(error => {
            addLog(`[ANNONCE] Erreur publication: ${error.message}`);
        });
        
        res.json({ 
            success: true, 
            message: 'Publication en cours', 
            groupsCount: announcement.groups.length 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// (Route /api/announcements/stats déplacée avant :id)

// Route pour récupérer les métadonnées d'un lien (Open Graph)
app.get('/api/link-preview', requireAuth, async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ success: false, message: 'URL requise' });
    }
    
    try {
        const https = require('https');
        const http = require('http');
        
        const client = url.startsWith('https') ? https : http;
        
        const request = client.get(url, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsAppBot/1.0)' } }, (response) => {
            let data = '';
            
            // Suivre les redirections
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return res.json({ success: true, redirect: response.headers.location });
            }
            
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const preview = {
                        title: '',
                        description: '',
                        image: '',
                        siteName: ''
                    };
                    
                    // Extraire le titre Open Graph
                    const ogTitle = data.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
                    if (ogTitle) preview.title = ogTitle[1];
                    
                    // Sinon, prendre le titre de la page
                    if (!preview.title) {
                        const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
                        if (titleMatch) preview.title = titleMatch[1].trim();
                    }
                    
                    // Extraire la description
                    const ogDesc = data.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
                    if (ogDesc) preview.description = ogDesc[1];
                    
                    if (!preview.description) {
                        const metaDesc = data.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
                        if (metaDesc) preview.description = metaDesc[1];
                    }
                    
                    // Extraire l'image
                    const ogImage = data.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
                    if (ogImage) preview.image = ogImage[1];
                    
                    // Extraire le nom du site
                    const ogSite = data.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
                    if (ogSite) preview.siteName = ogSite[1];
                    
                    // Nettoyer les entités HTML
                    const cleanEntities = (str) => {
                        if (!str) return str;
                        return str
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'")
                            .replace(/&nbsp;/g, ' ');
                    };
                    
                    preview.title = cleanEntities(preview.title);
                    preview.description = cleanEntities(preview.description);
                    preview.siteName = cleanEntities(preview.siteName);
                    
                    res.json({ success: true, preview });
                } catch (e) {
                    res.json({ success: false, message: 'Erreur parsing' });
                }
            });
        });
        
        request.on('error', (e) => {
            res.json({ success: false, message: e.message });
        });
        
        request.on('timeout', () => {
            request.destroy();
            res.json({ success: false, message: 'Timeout' });
        });
        
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Dupliquer une annonce
app.post('/api/announcements/:id/duplicate', requireAuth, (req, res) => {
    try {
        const original = announcementsManager.getAnnouncement(req.params.id);
        
        if (!original) {
            return res.status(404).json({ success: false, message: 'Annonce non trouvée' });
        }
        
        const duplicate = announcementsManager.createAnnouncement(req.user.username, {
            title: `${original.title} (copie)`,
            content: original.content,
            rawContent: original.rawContent,
            groups: original.groups,
            linkPreview: original.linkPreview,
            image: original.image,
            sendAsHd: original.sendAsHd
        });
        
        const { image: _dupImg, ...dupWithoutImage } = duplicate;
        res.json({ success: true, announcement: { ...dupWithoutImage, hasImage: !!_dupImg } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============ API OG IMAGE (SEO) ============

// Servir l'image OG
app.get('/og-image.png', (req, res) => {
    if (fs.existsSync(OUTPUT_PATH)) {
        res.sendFile(OUTPUT_PATH);
    } else {
        res.status(404).send('Image non générée');
    }
});

// Rafraîchir l'image OG (admin uniquement)
app.post('/api/admin/og-image/refresh', requireAdmin, async (req, res) => {
    try {
        const url = req.body.url || `http://localhost:${PORT}/landing.html`;
        await captureLandingPage(url);
        res.json({ 
            success: true, 
            message: 'Image OG générée avec succès',
            path: '/og-image.png'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Erreur lors de la génération: ' + error.message 
        });
    }
});

// Statut de l'image OG
app.get('/api/og-image/status', (req, res) => {
    const exists = fs.existsSync(OUTPUT_PATH);
    let stats = null;
    if (exists) {
        stats = fs.statSync(OUTPUT_PATH);
    }
    res.json({
        exists,
        valid: isOgImageValid(24),
        path: exists ? '/og-image.png' : null,
        size: stats ? stats.size : 0,
        lastModified: stats ? stats.mtimeMs : null
    });
});

app.listen(PORT, () => console.log(`Interface web: http://localhost:${PORT}`));

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

console.log('Demarrage du bot WhatsApp...');
console.log('Mode comportement humain active');
console.log('   ├─ Délais gaussiens (non uniformes)');
console.log('   ├─ Simulation de frappe (typing indicator)');
console.log('   ├─ Rate limiter (8 actions/min, 120/h)');
console.log('   ├─ Mode nuit (ralentissement 23h-7h)');
console.log('   ├─ Gestion de présence (online/offline)');
console.log('   ├─ Messages variables (pool aléatoire)');
console.log('   ├─ Micro-pauses aléatoires (10% chance)');
console.log('   └─ Multi-sessions activé');

// Ne pas créer de session par défaut - les sessions doivent être créées par des utilisateurs authentifiés

// Nettoyer les sessions orphelines (dont le propriétaire n'existe plus)
sessionManager.cleanupOrphanSessions();

// Initialiser toutes les sessions existantes
sessionManager.initializeAllSessions();

// Générer l'image OG si nécessaire (après le démarrage du serveur)
setTimeout(async () => {
    try {
        if (!fs.existsSync(OUTPUT_PATH)) {
            console.log('📸 Génération de l\'image OG pour SEO...');
            await captureLandingPage(`http://localhost:${PORT}/landing.html`);
        }
    } catch (e) {
        console.log('⚠️ Impossible de générer l\'image OG:', e.message);
    }
}, 3000);

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

// Vérification périodique des abonnements (toutes les 5 minutes)
const SUB_CHECK_INTERVAL = 5 * 60 * 1000;
setInterval(async () => {
    if (subscriptionSettings.enabled) {
        const result = await checkSubscriptions();
        if (result.notified > 0 || result.warned > 0 || result.disconnected > 0) {
            addLog(`[SUB] Vérification auto: ${result.notified} notifiés, ${result.warned} avertis, ${result.disconnected} déconnectés`);
        }
    }
}, SUB_CHECK_INTERVAL);

// Vérification initiale au démarrage (délai pour laisser les sessions se connecter)
setTimeout(async () => {
    if (subscriptionSettings.enabled) {
        addLog('[SUB] Vérification initiale des abonnements...');
        const result = await checkSubscriptions();
        addLog(`[SUB] Initial: ${result.notified} notifiés, ${result.warned} avertis, ${result.disconnected} déconnectés`);
    }
}, 30000);
console.log('   |- Jitter sur les intervalles de scan');
console.log('   |- Suppression V3 avec VERIFICATION post-delete');
console.log('');
console.log('Commandes admin dans les groupes:');
console.log('   ├─ !scan        → Scanner le groupe actuel');
console.log('   ├─ !scanall     → Scanner tous les groupes');
console.log('   ├─ !diagdelete  → Diagnostic des méthodes de suppression');
console.log('   └─ !testdelete  → Tester la suppression sur un message du bot\n');