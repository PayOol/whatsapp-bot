const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ============================================================
// 🧠 SYSTÈME DE COMPORTEMENT HUMAIN
// Tous les délais, variations et patterns imitent un humain réel
// ============================================================

const HumanBehavior = {
    // Distribution gaussienne pour des délais plus naturels
    // Un humain ne réagit jamais avec des délais uniformes
    gaussianRandom(mean, stddev) {
        let u1 = Math.random();
        let u2 = Math.random();
        let z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return Math.max(0, Math.round(mean + z * stddev));
    },

    // Délai de lecture : temps qu'un humain met à LIRE un message
    // Basé sur la longueur du message (~200ms par mot + base)
    readingDelay(messageLength) {
        const words = Math.max(1, Math.ceil(messageLength / 5));
        const baseTime = this.gaussianRandom(300, 100);  // 300ms base
        const perWord = this.gaussianRandom(80, 30);      // ~80ms/mot
        return Math.min(baseTime + words * perWord, 3000); // max 3s
    },

    // Délai de réflexion : temps entre lecture et début d'action
    thinkingDelay() {
        return this.gaussianRandom(500, 200); // ~0.5s ± 0.2s
    },

    // Durée de frappe simulée : basée sur la longueur du message à envoyer
    // Un humain tape ~40-60 caractères/minute sur téléphone
    typingDuration(messageLength) {
        const charsPerSecond = this.gaussianRandom(8, 2); // 6-10 chars/s (plus rapide)
        const base = this.gaussianRandom(400, 150);
        const typing = (messageLength / Math.max(1, charsPerSecond)) * 1000;
        // Plafonnement réduit
        return Math.min(base + typing, 5000);
    },

    // Délai avant de supprimer un message (un admin ne supprime pas
    // instantanément, il lit d'abord, puis décide)
    deletionDelay() {
        return this.gaussianRandom(2000, 1000); // ~2s ± 1s
    },

    // Délai entre deux actions consécutives dans un même groupe
    interActionDelay() {
        return this.gaussianRandom(1500, 500); // ~1.5s ± 0.5s
    },

    // Délai entre le traitement de deux groupes différents
    interGroupDelay() {
        return this.gaussianRandom(4000, 1500); // ~4s ± 1.5s
    },

    // Délai avant de rejeter un appel (un humain voit la notification,
    // prend son téléphone, regarde qui appelle, puis rejette)
    callRejectDelay() {
        return this.gaussianRandom(1500, 500); // ~1.5s ± 0.5s
    },

    // Délai après rejet d'appel avant d'envoyer un message
    postCallMessageDelay() {
        return this.gaussianRandom(2000, 800); // ~2s ± 0.8s
    },

    // Délai avant de bloquer quelqu'un (hésitation humaine)
    blockDelay() {
        return this.gaussianRandom(5000, 2000); // ~5s ± 2s
    },

    // Multiplicateur de nuit (entre 23h et 7h, les humains sont plus lents)
    getNightMultiplier() {
        const hour = new Date().getHours();
        if (hour >= 23 || hour < 3) return 3.0;   // Très lent la nuit
        if (hour >= 3 && hour < 7) return 2.5;     // Lent tôt le matin
        if (hour >= 7 && hour < 9) return 1.3;     // Légèrement lent le matin
        if (hour >= 12 && hour < 14) return 1.2;   // Pause déjeuner
        if (hour >= 21 && hour < 23) return 1.5;   // Soirée
        return 1.0;                                 // Normal
    },

    // Appliquer le multiplicateur de nuit à un délai
    applyNightMode(delay) {
        return Math.round(delay * this.getNightMultiplier());
    },

    // Chance de "micro-pause" : parfois un humain est distrait
    // 10% de chance d'ajouter 5-15s de pause
    maybeAddDistraction(delay) {
        if (Math.random() < 0.10) {
            const distraction = this.gaussianRandom(8000, 4000);
            return delay + distraction;
        }
        return delay;
    },

    // Délai complet et réaliste pour une action
    async naturalDelay(baseDelay) {
        let delay = baseDelay;
        delay = this.applyNightMode(delay);
        delay = this.maybeAddDistraction(delay);
        delay = Math.max(500, delay); // Minimum 500ms
        await new Promise(resolve => setTimeout(resolve, delay));
    }
};

// ============================================================
// 🎭 POOL DE MESSAGES VARIABLES
// Un humain ne dit jamais exactement la même chose
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

    // Choisir un message aléatoire dans un pool
    pick(pool, ...args) {
        const index = Math.floor(Math.random() * pool.length);
        return typeof pool[index] === 'function' ? pool[index](...args) : pool[index];
    }
};

// ============================================================
// ⏱️ RATE LIMITER GLOBAL
// Empêche le bot de faire trop d'actions trop vite
// ============================================================

class RateLimiter {
    constructor() {
        this.actions = [];       // timestamps des actions récentes
        this.maxPerMinute = 8;   // max 8 actions/minute (humain réaliste)
        this.maxPerHour = 120;   // max 120 actions/heure
    }

    canAct() {
        const now = Date.now();
        // Nettoyer les anciennes actions
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
            addLog(`⏳ Rate limiter : pause de ${Math.round(waitTime/1000)}s`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

const rateLimiter = new RateLimiter();

// ============================================================
// 📨 ENVOI DE MESSAGE HUMANISÉ
// Simule lecture → réflexion → frappe → envoi
// ============================================================

async function sendMessageHumanized(chat, text, options = {}, triggerMessageLength = 0) {
    try {
        // 1. Rate limiting
        await rateLimiter.waitUntilAllowed();

        // 2. Simuler la lecture du message déclencheur
        if (triggerMessageLength > 0) {
            const readDelay = HumanBehavior.readingDelay(triggerMessageLength);
            await HumanBehavior.naturalDelay(readDelay);
        }

        // 3. Temps de réflexion
        await HumanBehavior.naturalDelay(HumanBehavior.thinkingDelay());

        // 4. Simuler la frappe (typing indicator)
        try {
            await chat.sendStateTyping();
        } catch (e) {
            // Pas grave si ça échoue
        }

        // 5. Attendre le temps de frappe réaliste
        const typingTime = HumanBehavior.typingDuration(text.length);
        await HumanBehavior.naturalDelay(typingTime);

        // 6. Arrêter l'indicateur de frappe
        try {
            await chat.clearState();
        } catch (e) {}

        // 7. Micro-pause avant envoi (comme un humain qui relit)
        if (Math.random() < 0.3) {
            await HumanBehavior.naturalDelay(
                HumanBehavior.gaussianRandom(800, 400)
            );
        }

        // 8. Envoyer le message
        const sent = await chat.sendMessage(text, options);
        rateLimiter.recordAction();
        return sent;

    } catch (error) {
        addLog(`❌ Erreur envoi humanisé: ${error.message}`);
        throw error;
    }
}

// ============================================================
// 🗑️ SUPPRESSION HUMANISÉE
// Un admin lit le message, hésite, puis supprime
// ============================================================

async function deleteMessageHumanized(message) {
    try {
        await rateLimiter.waitUntilAllowed();

        // Délai de réflexion avant suppression
        const delay = HumanBehavior.deletionDelay();
        await HumanBehavior.naturalDelay(delay);

        await message.delete(true);
        rateLimiter.recordAction();
        return true;
    } catch (error) {
        addLog(`❌ Erreur suppression humanisée: ${error.message}`);
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
    // ✅ NOUVEAU : Options anti-appels
    CALL_REJECT_ENABLED: true,
    CALL_SPAM_THRESHOLD: 4,       // Nombre d'appels avant blocage
    CALL_SPAM_WINDOW_MIN: 10,     // Fenêtre en minutes
    CALL_BLOCK_DURATION_MIN: 30,  // Durée de blocage en minutes
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
// ✅ SYSTÈME ANTI-SPAM APPELS (AMÉLIORÉ)
// ============================================================

let callSpamTracker = {};
let blockedUsers = {};
let unblockTimers = {}; // ✅ Suivi des timers de déblocage

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

// ✅ Restaurer les timers de déblocage au démarrage
function restoreUnblockTimers() {
    const now = Date.now();
    for (const userId in blockedUsers) {
        const entry = blockedUsers[userId];
        if (!entry.autoUnblock) continue;
        
        const elapsed = now - entry.blockedAt;
        const blockDuration = CONFIG.CALL_BLOCK_DURATION_MIN * 60 * 1000;
        const remaining = blockDuration - elapsed;
        
        if (remaining <= 0) {
            // Devrait déjà être débloqué
            scheduleUnblock(userId, 5000);
        } else {
            scheduleUnblock(userId, remaining);
        }
    }
}

function scheduleUnblock(userId, delay) {
    // Annuler le timer précédent si existant
    if (unblockTimers[userId]) clearTimeout(unblockTimers[userId]);
    
    unblockTimers[userId] = setTimeout(async () => {
        if (blockedUsers[userId] && blockedUsers[userId].autoUnblock) {
            try {
                const contact = await client.getContactById(userId);
                
                // ✅ Délai humain avant déblocage
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

let GROUP_EXCEPTIONS = { excludedGroups: [], excludedPatterns: [] };
let USER_EXCEPTIONS = { excludedUsers: [], excludedAdmins: true };

let STATS = { totalDeleted: 0, totalWarnings: 0, totalBanned: 0, totalCallsRejected: 0, adminGroups: 0 };
let LOGS = [];

function addLog(message) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}`;
    LOGS.push(logMessage);
    if (LOGS.length > 100) LOGS.shift();
    try { fs.writeFileSync(LOGS_FILE, JSON.stringify(LOGS, null, 2)); } catch (e) {}
    console.log(message);
}

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
        if (fs.existsSync(LOGS_FILE)) LOGS = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    } catch (error) {}
}

function loadGroupExceptions() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            GROUP_EXCEPTIONS = { 
                excludedGroups: loaded.excludedGroups || [], 
                excludedPatterns: loaded.excludedPatterns || [] 
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

function isUserExcluded(userId, participants = []) {
    if (USER_EXCEPTIONS.excludedUsers.includes(userId)) return true;
    if (USER_EXCEPTIONS.excludedAdmins) {
        const p = participants.find(p => p.id._serialized === userId);
        if (p && p.isAdmin) return true;
    }
    return false;
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
// 🔍 DÉTECTION DE LIENS (inchangée — déjà robuste)
// ============================================================

const VALID_TLDS = [
    'com','net','org','fr','io','me','co','dev','info','biz','edu','gov',
    'xyz','site','online','store','shop','app','tech','club','live','pro',
    'link','click','top','work','world','news','tv','cc','ly','gl','gg',
    'am','fm','be','it','de','uk','eu','ru','cn','jp','br','in','au',
    'ca','es','nl','se','no','fi','dk','at','ch','pt','pl','cz','gr',
    'ie','za','ng','ke','gh','ci','cm','bf','ml','sn','tg','bj','ne',
    'gn','mg','cd','cg','ga','td','rw','ug','tz','mz','zw','eg','ma',
    'dz','tn','sa','ae','qa','kw','pk','af','bd','th','vn','my','sg',
    'id','ph','kr','hk','tw','nz','mx','ar','cl','pe','ve','do','cu',
    'pr','ht','cr','pa'
];

const FALSE_POSITIVE_WORDS = [
    'ok.merci','ok.ok','non.non','oui.oui','mr.','mme.','dr.',
    'etc.','ex.','vs.','inc.','ltd.','sr.','jr.','st.'
];

const WHITELISTED_DOMAINS = [
    'gmail.com','yahoo.com','yahoo.fr','hotmail.com','hotmail.fr',
    'outlook.com','outlook.fr','live.com','live.fr','icloud.com',
    'aol.com','protonmail.com','mail.com','whatsapp.com',
    'facebook.com','instagram.com','twitter.com','youtube.com',
    'google.com','tiktok.com','orange.fr','free.fr','sfr.fr'
];

const EMAIL_CONTEXT_WORDS = [
    'email','e-mail','mail','adresse','address','contact',
    'contacter','joindre','écrire','ecrire','envoie','envoi',
    'envoyé','envoyer','sur','chez','mon','ma','mes','ton','ta'
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

// Nettoyer les fichiers de verrouillage Chromium AVANT de créer le client
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

    // ✅ Simuler l'ouverture du chat (un humain scrolle)
    try { await chat.sendSeen(); } catch (e) {}
    await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(2000, 1000));

    const messages = await chat.fetchMessages({ limit });
    let deleted = 0, scanned = 0, warned = 0;

    // ✅ Ne pas traiter tous les messages d'un coup
    // Un humain ne peut pas vérifier 100 messages instantanément
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

        // ✅ Délai inter-action humanisé avec accélération limitée
        if (actionCount > 0) {
            await HumanBehavior.naturalDelay(HumanBehavior.interActionDelay());
        }
        actionCount++;

        // ✅ Pause plus longue tous les 5 messages (fatigue humaine)
        if (actionCount > 0 && actionCount % 5 === 0) {
            const fatiguePause = HumanBehavior.gaussianRandom(8000, 4000);
            addLog(`😴 Pause fatigue: ${Math.round(fatiguePause/1000)}s`);
            await HumanBehavior.naturalDelay(fatiguePause);
        }

        try {
            markAsProcessed(msgId);

            const contact = await message.getContact();
            const mention = `@${contact.number}`;
            const currentWarnings = getWarningCount(chat.id._serialized, authorId);

            if (currentWarnings >= CONFIG.MAX_WARNINGS) {
                // Déjà au max → bannir
                try {
                    const banMsg = MessagePool.pick(
                        MessagePool.bans, mention, CONFIG.MAX_WARNINGS
                    );
                    await sendMessageHumanized(chat, banMsg, {
                        mentions: [contact.id._serialized]
                    }, message.body.length);

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
                        }, message.body.length);

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
                        }, message.body.length);
                    } catch (warnError) {
                        console.error('Erreur avertissement:', warnError);
                    }
                }
            }

            // ✅ Supprimer APRÈS l'avertissement (ordre humain)
            if (await deleteMessageHumanized(message)) {
                deleted++;
                STATS.totalDeleted++;
                addLog(`🗑️ Ancien message supprimé dans ${chat.name}`);
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

    // ✅ Mélanger l'ordre des groupes (un humain ne fait pas toujours
    // la même chose dans le même ordre)
    const shuffled = groups.sort(() => Math.random() - 0.5);

    for (const group of shuffled) {
        const result = await scanOldMessages(group, CONFIG.SCAN_LIMIT);
        totalDeleted += result.deleted;
        totalScanned += result.scanned;
        totalWarned += result.warned || 0;

        // ✅ Délai inter-groupe humanisé
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

    // ✅ Restaurer les timers de déblocage
    restoreUnblockTimers();

    // ✅ Gérer la présence en ligne de façon naturelle
    startPresenceManager();

    if (CONFIG.AUTO_SCAN_ENABLED) {
        // ✅ Attendre un peu avant le premier scan (comme un humain
        // qui vient de se connecter et regarde ses messages d'abord)
        const startupDelay = HumanBehavior.gaussianRandom(15000, 8000);
        addLog(`⏳ Premier scan dans ${Math.round(startupDelay/1000)}s...`);
        await new Promise(r => setTimeout(r, startupDelay));
        await scanAllGroups();
    }

    // ✅ Intervalle de scan avec jitter (pas exactement toutes les Xh)
    scheduleNextScan();
});

function scheduleNextScan() {
    const baseMs = CONFIG.AUTO_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;
    // ✅ Ajouter ±20% de jitter pour ne pas être régulier
    const jitter = HumanBehavior.gaussianRandom(0, baseMs * 0.2);
    const nextScanMs = baseMs + jitter;

    addLog(`⏰ Prochain scan dans ${Math.round(nextScanMs/3600000*10)/10}h`);

    setTimeout(async () => {
        if (CONFIG.AUTO_SCAN_ENABLED && isConnected) {
            addLog(`⏰ Scan automatique programmé...`);
            await scanAllGroups();
        }
        scheduleNextScan(); // Re-programmer avec nouveau jitter
    }, nextScanMs);
}

// ============================================================
// 👤 GESTIONNAIRE DE PRÉSENCE
// Simule les cycles online/offline d'un humain réel
// ============================================================

function startPresenceManager() {
    async function togglePresence() {
        try {
            const hour = new Date().getHours();
            // La nuit : rester offline plus longtemps
            if (hour >= 1 && hour < 7) {
                await client.sendPresenceUnavailable();
                // Rester offline 30-90 min
                const offlineTime = HumanBehavior.gaussianRandom(3600000, 1800000);
                setTimeout(togglePresence, offlineTime);
                return;
            }

            // Cycle normal : online 5-20 min, offline 2-10 min
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

    // Premier cycle après un délai aléatoire
    setTimeout(togglePresence, HumanBehavior.gaussianRandom(30000, 15000));
}

// ============================================================
// 📩 HANDLER MESSAGE (TEMPS RÉEL)
// ============================================================

client.on('message', async (message) => {
    try {
        if (message.fromMe) return;
        const chat = await message.getChat();
        if (!chat.isGroup) return;
        if (isGroupExcluded(chat)) return;

        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        const messageBody = message.body.trim().toLowerCase();
        const senderId = message.author || message.from;
        const senderP = participants.find(p => p.id._serialized === senderId);

        // ✅ Commandes admin
        if (messageBody === '!scan') {
            if (senderP?.isAdmin) {
                // ✅ Simuler lecture + frappe même pour les commandes
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

        if (messageBody === '!scanall') {
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

        // ✅ Vérification lien
        if (!containsLink(message)) return;

        const msgId = message.id._serialized || message.id.id;
        if (isAlreadyProcessed(msgId)) return;
        markAsProcessed(msgId);

        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) return;
        if (isUserExcluded(authorId, participants)) return;

        // ✅ Marquer le chat comme "lu" (comportement humain)
        try { await chat.sendSeen(); } catch (e) {}

        const contact = await message.getContact();
        const mention = `@${contact.number}`;
        const warningCount = addWarning(chat.id._serialized, authorId);
        const remaining = CONFIG.MAX_WARNINGS - warningCount;
        STATS.totalWarnings++;

        if (warningCount >= CONFIG.MAX_WARNINGS) {
            try {
                const banMsg = MessagePool.pick(
                    MessagePool.bans, mention, CONFIG.MAX_WARNINGS
                );
                await sendMessageHumanized(chat, banMsg, {
                    mentions: [contact.id._serialized],
                    quotedMessageId: message.id._serialized
                }, message.body.length);

                // ✅ Délai humain avant le ban
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
                    { mentions: [contact.id._serialized], quotedMessageId: message.id._serialized },
                    10
                );
            }
        } else {
            const warnMsg = MessagePool.pick(
                MessagePool.warnings, mention, warningCount,
                CONFIG.MAX_WARNINGS, remaining
            );
            await sendMessageHumanized(chat, warnMsg, {
                mentions: [contact.id._serialized],
                quotedMessageId: message.id._serialized
            }, message.body.length);
            addLog(`⚠️ Avertissement ${warningCount}/${CONFIG.MAX_WARNINGS} pour ${authorId}`);
        }

        // ✅ Suppression APRÈS l'avertissement (comme un humain ferait)
        if (await deleteMessageHumanized(message)) {
            STATS.totalDeleted++;
            addLog(`🗑️ Message supprimé de ${authorId}`);
        }
    } catch (error) {
        console.error('Erreur traitement message:', error);
    }
});

// ============================================================
// 👋 HANDLER BIENVENUE
// ============================================================

client.on('group_join', async (notification) => {
    try {
        if (!CONFIG.WELCOME_ENABLED) return;

        const chat = await notification.getChat();
        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botP = participants.find(p => p.id._serialized === botId);
        if (!botP || !botP.isAdmin) return;

        let newMemberId = notification.recipient;
        if (notification.id?.participant) newMemberId = notification.id.participant;

        let contact;
        try { contact = await client.getContactById(newMemberId); } catch (e) { return; }

        // ✅ Attendre un moment avant d'envoyer le bienvenue
        // (un humain ne réagit pas à la milliseconde)
        await HumanBehavior.naturalDelay(
            HumanBehavior.gaussianRandom(5000, 3000)
        );

        const mention = `@${contact.number}`;
        const welcomeMessage = CONFIG.WELCOME_MESSAGE
            .replace(/{mention}/g, mention)
            .replace(/{group}/g, chat.name)
            .replace(/{maxWarnings}/g, CONFIG.MAX_WARNINGS);

        await sendMessageHumanized(chat, welcomeMessage, {
            mentions: [contact.id._serialized]
        }, 0);

        addLog(`👋 Bienvenue envoyé à ${contact.number} dans ${chat.name}`);
    } catch (error) {
        addLog(`❌ Erreur bienvenue: ${error.message}`);
    }
});

// ============================================================
// 📞 HANDLER APPELS — ENTIÈREMENT HUMANISÉ
// ============================================================

client.on('call', async (call) => {
    try {
        if (!CONFIG.CALL_REJECT_ENABLED) return;

        const callerId = call.from;
        addLog(`📞 Appel entrant de ${callerId}`);

        // ✅ Vérifier si déjà bloqué (avec vérification réelle WhatsApp)
        if (blockedUsers[callerId]) {
            try {
                const contact = await client.getContactById(callerId);
                // Vérifier si VRAIMENT bloqué dans WhatsApp
                if (contact.isBlocked) {
                    addLog(`⛔ ${callerId} déjà bloqué`);
                    // Rejeter quand même après un délai (le téléphone sonne)
                    await HumanBehavior.naturalDelay(HumanBehavior.callRejectDelay());
                    try { await call.reject(); } catch (e) {}
                    return;
                } else {
                    // Débloqué manuellement → nettoyer nos données
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

        // ✅ DÉLAI HUMAIN : le téléphone sonne, on le prend, on regarde
        const rejectDelay = HumanBehavior.callRejectDelay();
        addLog(`📱 Sonnerie pendant ${Math.round(rejectDelay/1000)}s...`);
        await HumanBehavior.naturalDelay(rejectDelay);

        // ✅ Rejeter l'appel
        try {
            await call.reject();
            addLog(`🚫 Appel rejeté: ${callerId}`);
            STATS.totalCallsRejected++;
            rateLimiter.recordAction();
        } catch (rejectError) {
            addLog(`⚠️ Erreur rejet appel: ${rejectError.message}`);
        }

        // ✅ Tracker l'appel
        const callCount = addCall(callerId);
        addLog(`📊 ${callerId}: ${callCount}/${CONFIG.CALL_SPAM_THRESHOLD} appels`);

        // ✅ SPAM DÉTECTÉ → BLOQUER
        if (callCount >= CONFIG.CALL_SPAM_THRESHOLD) {
            addLog(`🚫 SPAM: ${callerId} — ${callCount} appels → BLOCAGE`);

            // ✅ Envoyer un message AVANT de bloquer
            try {
                const postCallDelay = HumanBehavior.postCallMessageDelay();
                await HumanBehavior.naturalDelay(postCallDelay);

                const chat = await client.getChatById(callerId);
                const blockMsg = MessagePool.pick(MessagePool.callBlocked);
                await sendMessageHumanized(chat, blockMsg, {}, 0);
            } catch (msgError) {
                addLog(`⚠️ Message pré-blocage échoué: ${msgError.message}`);
            }

            // ✅ Délai humain avant de bloquer (hésitation)
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

                // ✅ Programmer le déblocage
                const blockDuration = CONFIG.CALL_BLOCK_DURATION_MIN * 60 * 1000;
                scheduleUnblock(callerId, blockDuration);

            } catch (blockError) {
                addLog(`❌ Erreur blocage: ${blockError.message}`);
            }
            return;
        }

        // ✅ PAS ENCORE SPAM → Message d'avertissement
        // Attendre un délai réaliste (humain qui décide d'écrire un message)
        const msgDelay = HumanBehavior.postCallMessageDelay();
        addLog(`⏳ Message dans ${Math.round(msgDelay/1000)}s...`);
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

app.get('/api/logs', (req, res) => res.json(LOGS));

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
        }));
    } catch (error) { res.status(500).json([]); }
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

app.get('/api/users/exceptions', (req, res) => res.json(USER_EXCEPTIONS));
app.post('/api/users/exceptions', (req, res) => {
    try {
        const { userId } = req.body;
        if (userId && !USER_EXCEPTIONS.excludedUsers.includes(userId)) {
            USER_EXCEPTIONS.excludedUsers.push(userId);
            saveUserExceptions();
        }
        res.json({ success: true, exceptions: USER_EXCEPTIONS });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.delete('/api/users/exceptions', (req, res) => {
    try {
        const { userId } = req.body;
        USER_EXCEPTIONS.excludedUsers = USER_EXCEPTIONS.excludedUsers.filter(id => id !== userId);
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

        // Annuler le timer auto
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

// ✅ API supplémentaire : statut du rate limiter
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

console.log('🚀 Démarrage du bot WhatsApp...');
console.log('🧠 Mode comportement humain activé');
console.log('   ├─ Délais gaussiens (non uniformes)');
console.log('   ├─ Simulation de frappe (typing indicator)');
console.log('   ├─ Rate limiter (8 actions/min, 120/h)');
console.log('   ├─ Mode nuit (ralentissement 23h-7h)');
console.log('   ├─ Gestion de présence (online/offline)');
console.log('   ├─ Messages variables (pool aléatoire)');
console.log('   ├─ Micro-pauses aléatoires (10% chance)');
console.log('   └─ Jitter sur les intervalles de scan\n');

client.initialize();