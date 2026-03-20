const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Configuration par défaut (peut être modifiée via l'interface web)
let CONFIG = {
    MAX_WARNINGS: 3, // Nombre maximum d'avertissements avant bannissement
    WARNING_EXPIRY_HOURS: 24, // Les avertissements expirent après 24h
    SCAN_LIMIT: 100, // Nombre de messages à scanner lors d'un scan
    AUTO_SCAN_INTERVAL_HOURS: 24, // Intervalle de scan automatique (en heures)
    // Délais pour éviter le bannissement (en millisecondes)
    DELAY_BETWEEN_ACTIONS_MIN: 2000, // Délai minimum entre actions (2s)
    DELAY_BETWEEN_ACTIONS_MAX: 5000, // Délai maximum entre actions (5s)
    DELAY_BETWEEN_GROUPS_MIN: 5000, // Délai minimum entre groupes (5s)
    DELAY_BETWEEN_GROUPS_MAX: 15000, // Délai maximum entre groupes (15s)
    // Options activables
    WELCOME_ENABLED: true,
    AUTO_SCAN_ENABLED: true,
    WELCOME_MESSAGE: `👋 Bienvenue {mention} dans *{group}* !

📜 *Règles importantes:*
• Les liens ne sont pas autorisés dans ce groupe
• Tout lien partagé sera automatiquement supprimé
• Après {maxWarnings} avertissements, vous serez banni du groupe

Merci de respecter ces règles. Bonne discussion ! 🎉`
};

// Fichiers de stockage
const WARNINGS_FILE = path.join(__dirname, 'warnings.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');
const GROUPS_FILE = path.join(__dirname, 'groups.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const PROCESSED_FILE = path.join(__dirname, 'processed.json');

// ============================================================
// ✅ SYSTÈME ANTI-DOUBLON : Suivi des messages déjà traités
// Empêche le scan de re-traiter un message déjà sanctionné
// ============================================================
let processedMessages = new Set();

function loadProcessedMessages() {
    try {
        if (fs.existsSync(PROCESSED_FILE)) {
            const data = fs.readFileSync(PROCESSED_FILE, 'utf8');
            const arr = JSON.parse(data);
            arr.forEach(id => processedMessages.add(id));
            console.log(`📋 ${processedMessages.size} messages déjà traités chargés`);
        }
    } catch (error) {
        console.error('Erreur lors du chargement des messages traités:', error);
    }
}

function saveProcessedMessages() {
    try {
        // Garder seulement les 5000 derniers pour ne pas surcharger le fichier
        const arr = Array.from(processedMessages);
        if (arr.length > 5000) {
            const trimmed = arr.slice(-5000);
            processedMessages.clear();
            trimmed.forEach(id => processedMessages.add(id));
        }
        fs.writeFileSync(PROCESSED_FILE, JSON.stringify(Array.from(processedMessages)));
    } catch (error) {
        console.error('Erreur lors de la sauvegarde des messages traités:', error);
    }
}

function markAsProcessed(messageId) {
    processedMessages.add(messageId);
    saveProcessedMessages();
}

function isAlreadyProcessed(messageId) {
    return processedMessages.has(messageId);
}

// Exceptions de groupes (groupes où le bot ne doit pas agir)
let GROUP_EXCEPTIONS = {
    excludedGroups: [], // IDs des groupes exclus
    excludedPatterns: [] // Patterns de noms à exclure (ex: "Test", "Admin")
};

// Exceptions d'utilisateurs (utilisateurs que le bot ne doit pas sanctionner)
let USER_EXCEPTIONS = {
    excludedUsers: [], // IDs des utilisateurs exclus (numéros)
    excludedAdmins: true // Exclure automatiquement les admins des groupes
};

// Statistiques
let STATS = {
    totalDeleted: 0,
    totalWarnings: 0,
    totalBanned: 0,
    adminGroups: 0
};

// Logs en mémoire (derniers 100)
let LOGS = [];

// Fonction pour ajouter un log
function addLog(message) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}`;
    LOGS.push(logMessage);
    if (LOGS.length > 100) LOGS.shift();
    
    try {
        fs.writeFileSync(LOGS_FILE, JSON.stringify(LOGS, null, 2));
    } catch (e) {}
    
    console.log(message);
}

// Charger la configuration depuis le fichier
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            const savedConfig = JSON.parse(data);
            CONFIG = { ...CONFIG, ...savedConfig };
        }
    } catch (error) {
        console.error('Erreur lors du chargement de la configuration:', error);
    }
}

// Sauvegarder la configuration dans le fichier
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
    } catch (error) {
        console.error('Erreur lors de la sauvegarde de la configuration:', error);
    }
}

// Charger les logs depuis le fichier
function loadLogs() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            const data = fs.readFileSync(LOGS_FILE, 'utf8');
            LOGS = JSON.parse(data);
        }
    } catch (error) {
        console.error('Erreur lors du chargement des logs:', error);
    }
}

// Charger les exceptions de groupes depuis le fichier
function loadGroupExceptions() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = fs.readFileSync(GROUPS_FILE, 'utf8');
            GROUP_EXCEPTIONS = JSON.parse(data);
        }
    } catch (error) {
        console.error('Erreur lors du chargement des exceptions de groupes:', error);
    }
}

// Sauvegarder les exceptions de groupes dans le fichier
function saveGroupExceptions() {
    try {
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(GROUP_EXCEPTIONS, null, 2));
    } catch (error) {
        console.error('Erreur lors de la sauvegarde des exceptions de groupes:', error);
    }
}

// Vérifier si un groupe est exclu
function isGroupExcluded(chat) {
    if (GROUP_EXCEPTIONS.excludedGroups.includes(chat.id._serialized)) {
        return true;
    }
    const groupName = chat.name.toLowerCase();
    for (const pattern of GROUP_EXCEPTIONS.excludedPatterns) {
        if (groupName.includes(pattern.toLowerCase())) {
            return true;
        }
    }
    return false;
}

// Charger les exceptions d'utilisateurs depuis le fichier
function loadUserExceptions() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            USER_EXCEPTIONS = JSON.parse(data);
        }
    } catch (error) {
        console.error('Erreur lors du chargement des exceptions d\'utilisateurs:', error);
    }
}

// Sauvegarder les exceptions d'utilisateurs dans le fichier
function saveUserExceptions() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(USER_EXCEPTIONS, null, 2));
    } catch (error) {
        console.error('Erreur lors de la sauvegarde des exceptions d\'utilisateurs:', error);
    }
}

// Vérifier si un utilisateur est exclu
function isUserExcluded(userId, participants = []) {
    if (USER_EXCEPTIONS.excludedUsers.includes(userId)) {
        return true;
    }
    if (USER_EXCEPTIONS.excludedAdmins) {
        const userParticipant = participants.find(p => p.id._serialized === userId);
        if (userParticipant && userParticipant.isAdmin) {
            return true;
        }
    }
    return false;
}

// Fonction pour créer un délai aléatoire
function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

// ============ Système d'avertissements ============

function loadWarnings() {
    try {
        if (fs.existsSync(WARNINGS_FILE)) {
            const data = fs.readFileSync(WARNINGS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Erreur lors du chargement des avertissements:', error);
    }
    return {};
}

function saveWarnings(warnings) {
    try {
        fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));
    } catch (error) {
        console.error('Erreur lors de la sauvegarde des avertissements:', error);
    }
}

function cleanExpiredWarnings(warnings) {
    const now = Date.now();
    const expiryMs = CONFIG.WARNING_EXPIRY_HOURS * 60 * 60 * 1000;
    
    for (const chatId in warnings) {
        for (const userId in warnings[chatId]) {
            warnings[chatId][userId] = warnings[chatId][userId].filter(
                timestamp => now - timestamp < expiryMs
            );
            if (warnings[chatId][userId].length === 0) {
                delete warnings[chatId][userId];
            }
        }
        if (Object.keys(warnings[chatId]).length === 0) {
            delete warnings[chatId];
        }
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
    if (warnings[chatId] && warnings[chatId][userId]) {
        delete warnings[chatId][userId];
        if (Object.keys(warnings[chatId]).length === 0) {
            delete warnings[chatId];
        }
        saveWarnings(warnings);
    }
}

function getWarningCount(chatId, userId) {
    let warnings = loadWarnings();
    warnings = cleanExpiredWarnings(warnings);
    saveWarnings(warnings);
    return (warnings[chatId] && warnings[chatId][userId]) ? warnings[chatId][userId].length : 0;
}

// ===========================================================
// ✅ NOUVEAU : Listes de sécurité pour éviter les faux positifs
// ===========================================================

const VALID_TLDS = [
    'com', 'net', 'org', 'fr', 'io', 'me', 'co', 'dev', 'info', 'biz',
    'edu', 'gov', 'xyz', 'site', 'online', 'store', 'shop', 'app', 'tech',
    'club', 'live', 'pro', 'link', 'click', 'top', 'work', 'world', 'news',
    'tv', 'cc', 'ly', 'gl', 'gg', 'am', 'fm', 'be', 'it', 'de', 'uk',
    'eu', 'ru', 'cn', 'jp', 'br', 'in', 'au', 'ca', 'es', 'nl', 'se',
    'no', 'fi', 'dk', 'at', 'ch', 'pt', 'pl', 'cz', 'gr', 'ie', 'za',
    'ng', 'ke', 'gh', 'ci', 'cm', 'bf', 'ml', 'sn', 'tg', 'bj', 'ne',
    'gn', 'mg', 'cd', 'cg', 'ga', 'td', 'rw', 'ug', 'tz', 'mz', 'zw',
    'eg', 'ma', 'dz', 'tn', 'sa', 'ae', 'qa', 'kw', 'pk', 'af', 'bd',
    'th', 'vn', 'my', 'sg', 'id', 'ph', 'kr', 'hk', 'tw', 'nz', 'mx',
    'ar', 'cl', 'pe', 've', 'do', 'cu', 'pr', 'ht', 'cr', 'pa'
];

const FALSE_POSITIVE_WORDS = [
    'ok.merci', 'ok.ok', 'non.non', 'oui.oui', 'mr.', 'mme.', 'dr.',
    'etc.', 'ex.', 'vs.', 'inc.', 'ltd.', 'sr.', 'jr.', 'st.'
];

// ✅ NOUVEAU : Domaines souvent mentionnés sans intention de lien
const WHITELISTED_DOMAINS = [
    'gmail.com', 'yahoo.com', 'yahoo.fr', 'hotmail.com', 'hotmail.fr',
    'outlook.com', 'outlook.fr', 'live.com', 'live.fr', 'icloud.com',
    'aol.com', 'protonmail.com', 'mail.com', 'whatsapp.com',
    'facebook.com', 'instagram.com', 'twitter.com', 'youtube.com',
    'google.com', 'tiktok.com', 'orange.fr', 'free.fr', 'sfr.fr'
];

// ✅ NOUVEAU : Mots-clés indiquant un contexte email/contact
const EMAIL_CONTEXT_WORDS = [
    'email', 'e-mail', 'mail', 'adresse', 'address', 'contact',
    'contacter', 'joindre', 'écrire', 'ecrire', 'envoie', 'envoi',
    'envoyé', 'envoyer', 'sur', 'chez', 'mon', 'ma', 'mes', 'ton', 'ta'
];

// ===========================================================
// ✅ FONCTION DE DÉTECTION DE LIENS CORRIGÉE
// ===========================================================

function containsLink(message) {
    const text = message.body;
    
    if (!text || text.length < 5) return false;
    
    // 1. Exclure les emails standards
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;
    let textWithoutEmails = text.replace(emailPattern, ' ');
    
    if (textWithoutEmails.trim().length < 5) return false;
    
    // 2. Liens standards (fiables à 100%)
    const linkPatterns = [
        /https?:\/\/[^\s]+/gi,
        /www\.[^\s]+\.[^\s]+/gi,
        /wa\.me\/[^\s]+/gi,
        /chat\.whatsapp\.com\/[^\s]+/gi,
    ];
    
    for (const pattern of linkPatterns) {
        if (new RegExp(pattern.source, pattern.flags).test(textWithoutEmails)) {
            addLog(`🔍 Lien standard détecté dans: "${text.substring(0, 80)}"`);
            return true;
        }
    }
    
    // 3. Domaines nus avec validation stricte
    const domainPattern = /\b(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?\b/gi;
    const domainMatches = textWithoutEmails.match(domainPattern) || [];
    
    const validDomains = domainMatches.filter(match => {
        const cleanMatch = match.replace(/\/.*$/, '');
        const parts = cleanMatch.split('.');
        if (parts.length < 2) return false;
        
        const tld = parts[parts.length - 1].toLowerCase();
        if (!VALID_TLDS.includes(tld)) return false;
        
        const domainPart = parts[parts.length - 2].toLowerCase();
        if (domainPart.length < 2) return false;
        
        const lowerMatch = cleanMatch.toLowerCase();
        for (const fp of FALSE_POSITIVE_WORDS) {
            if (lowerMatch === fp || lowerMatch.startsWith(fp)) return false;
        }
        
        if (match.includes(' ') || match.includes(',')) return false;
        
        // ✅ VÉRIFICATION CONTEXTE EMAIL / CONVERSATION
        if (WHITELISTED_DOMAINS.includes(lowerMatch)) {
            const textLower = text.toLowerCase();
            const hasEmailContext = EMAIL_CONTEXT_WORDS.some(word => textLower.includes(word));
            if (hasEmailContext) {
                addLog(`✅ Domaine ${lowerMatch} ignoré (contexte email/conversation détecté)`);
                return false;
            }
        }
        
        // ✅ VÉRIFICATION PHRASE CONVERSATIONNELLE
        if (!match.includes('/')) {
            const textLower = text.toLowerCase();
            if (text.length > 60 && domainMatches.length === 1) {
                const domainIndex = textLower.indexOf(lowerMatch);
                const beforeDomain = textLower.substring(Math.max(0, domainIndex - 30), domainIndex);
                if (EMAIL_CONTEXT_WORDS.some(word => beforeDomain.includes(word))) {
                    addLog(`✅ Domaine ${lowerMatch} ignoré (mention conversationnelle)`);
                    return false;
                }
            }
        }
        
        return true;
    });
    
    if (validDomains.length > 0) {
        addLog(`🔍 Domaine détecté dans "${text.substring(0, 80)}": ${validDomains.join(', ')}`);
        return true;
    }
    
    return false;
}

// ============ Client WhatsApp ============

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let currentQR = null;
let isConnected = false;

// ✅ UN SEUL handler QR
client.on('qr', (qr) => {
    currentQR = qr;
    isConnected = false;
    console.log('\n📱 Scannez ce QR code avec WhatsApp:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n');
});

// =====================================================================
// ✅ SCAN AVEC PROTECTION ANTI-DOUBLON
// =====================================================================

async function scanOldMessages(chat, limit = 100) {
    if (isGroupExcluded(chat)) {
        addLog(`🚫 Groupe ${chat.name} exclu, scan ignoré`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }
    
    addLog(`🔍 Scan des ${limit} derniers messages dans ${chat.name}...`);
    
    const botId = client.info.wid._serialized;
    const participants = chat.participants || [];
    const botParticipant = participants.find(p => p.id._serialized === botId);
    
    if (!botParticipant || !botParticipant.isAdmin) {
        addLog(`⚠️ Je ne suis pas admin dans ${chat.name}, scan ignoré`);
        return { deleted: 0, scanned: 0, warned: 0 };
    }
    
    const messages = await chat.fetchMessages({ limit });
    let deleted = 0, scanned = 0, warned = 0;
    
    for (const message of messages) {
        if (message.fromMe) continue;
        scanned++;
        
        const msgId = message.id._serialized || message.id.id;
        if (isAlreadyProcessed(msgId)) continue;
        if (!containsLink(message)) continue;
        
        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) continue;
        if (isUserExcluded(authorId, participants)) continue;
        
        try {
            await randomDelay(CONFIG.DELAY_BETWEEN_ACTIONS_MIN, CONFIG.DELAY_BETWEEN_ACTIONS_MAX);
            markAsProcessed(msgId);
            
            const contact = await message.getContact();
            const mention = `@${contact.number}`;
            const currentWarnings = getWarningCount(chat.id._serialized, authorId);
            
            if (currentWarnings >= CONFIG.MAX_WARNINGS) {
                try {
                    await chat.sendMessage(
                        `🚫 ${mention} a été banni pour avoir partagé des liens malgré ${CONFIG.MAX_WARNINGS} avertissements.`,
                        { mentions: [contact.id._serialized] }
                    );
                    await randomDelay(1000, 2000);
                    await chat.removeParticipants([authorId]);
                    resetWarnings(chat.id._serialized, authorId);
                    STATS.totalBanned++;
                    addLog(`🚫 Utilisateur ${authorId} banni de ${chat.name}`);
                } catch (banError) {
                    addLog(`❌ Erreur bannissement: ${banError.message}`);
                }
            } else {
                const warningCount = addWarning(chat.id._serialized, authorId);
                warned++;
                STATS.totalWarnings++;
                
                if (warningCount >= CONFIG.MAX_WARNINGS) {
                    try {
                        await chat.sendMessage(
                            `🚫 ${mention} a atteint ${CONFIG.MAX_WARNINGS} avertissements pour partage de liens. Bannissement.`,
                            { mentions: [contact.id._serialized] }
                        );
                        await randomDelay(1000, 2000);
                        await chat.removeParticipants([authorId]);
                        resetWarnings(chat.id._serialized, authorId);
                        STATS.totalBanned++;
                        addLog(`🚫 Utilisateur ${authorId} banni de ${chat.name}`);
                    } catch (banError) {
                        addLog(`❌ Erreur bannissement: ${banError.message}`);
                    }
                } else {
                    const remaining = CONFIG.MAX_WARNINGS - warningCount;
                    try {
                        await chat.sendMessage(
                            `⚠️ ${mention} Les liens ne sont pas autorisés. Message supprimé. ` +
                            `Avertissement ${warningCount}/${CONFIG.MAX_WARNINGS}. ` +
                            `Il vous reste ${remaining} avertissement(s) avant d'être banni.`,
                            { mentions: [contact.id._serialized] }
                        );
                    } catch (warnError) {
                        console.error('Erreur envoi avertissement:', warnError);
                    }
                }
            }
            
            try {
                await message.delete(true);
                deleted++;
                STATS.totalDeleted++;
                addLog(`🗑️ Ancien message supprimé dans ${chat.name} de ${authorId}`);
            } catch (delErr) {
                addLog(`⚠️ Impossible de supprimer un message ancien dans ${chat.name}`);
            }
        } catch (error) {
            addLog(`⚠️ Erreur traitement message dans ${chat.name}: ${error.message}`);
        }
    }
    
    addLog(`✅ Scan terminé: ${scanned} scannés, ${deleted} supprimés, ${warned} avertissements`);
    return { deleted, scanned, warned };
}

async function scanAllGroups() {
    addLog('🔍 ========== SCAN AUTOMATIQUE ==========');
    addLog(`📅 ${new Date().toLocaleString()}`);
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    addLog(`📊 ${groups.length} groupes détectés`);
    
    let totalDeleted = 0, totalScanned = 0, totalWarned = 0;
    
    for (const group of groups) {
        const result = await scanOldMessages(group, CONFIG.SCAN_LIMIT);
        totalDeleted += result.deleted;
        totalScanned += result.scanned;
        totalWarned += result.warned || 0;
        await randomDelay(CONFIG.DELAY_BETWEEN_GROUPS_MIN, CONFIG.DELAY_BETWEEN_GROUPS_MAX);
    }
    
    addLog('✅ ========== FIN DU SCAN ==========');
    addLog(`📊 Total: ${totalScanned} scannés, ${totalDeleted} supprimés, ${totalWarned} avertissements`);
    return { totalDeleted, totalScanned, totalWarned };
}

// ✅ UN SEUL handler READY
client.on('ready', async () => {
    isConnected = true;
    currentQR = null;
    addLog('✅ Bot connecté et prêt!');
    addLog(`⚠️ Configuration: ${CONFIG.MAX_WARNINGS} avertissements max`);
    addLog(`📊 Commandes: !scan, !scanall`);
    addLog(`🔄 Scan auto toutes les ${CONFIG.AUTO_SCAN_INTERVAL_HOURS}h`);
    
    if (CONFIG.AUTO_SCAN_ENABLED) {
        addLog('🔍 Lancement du scan initial...');
        await scanAllGroups();
    }
    
    const intervalMs = CONFIG.AUTO_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;
    setInterval(async () => {
        if (CONFIG.AUTO_SCAN_ENABLED) {
            addLog(`⏰ Scan automatique programmé...`);
            await scanAllGroups();
        }
    }, intervalMs);
});

// =====================================================================
// ✅ HANDLER MESSAGE AVEC PROTECTION ANTI-DOUBLON
// =====================================================================

client.on('message', async (message) => {
    try {
        if (message.fromMe) return;
        const chat = await message.getChat();
        if (!chat.isGroup) return;
        if (isGroupExcluded(chat)) return;
        
        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botParticipant = participants.find(p => p.id._serialized === botId);
        if (!botParticipant || !botParticipant.isAdmin) return;
        
        const messageBody = message.body.trim().toLowerCase();
        const senderId = message.author || message.from;
        const senderParticipant = participants.find(p => p.id._serialized === senderId);
        
        if (messageBody === '!scan') {
            if (senderParticipant && senderParticipant.isAdmin) {
                await chat.sendMessage('🔍 Scan en cours...');
                const result = await scanOldMessages(chat, CONFIG.SCAN_LIMIT);
                await chat.sendMessage(`✅ Scan terminé: ${result.scanned} scannés, ${result.deleted} supprimés.`);
            }
            return;
        }
        
        if (messageBody === '!scanall') {
            if (senderParticipant && senderParticipant.isAdmin) {
                await chat.sendMessage('🔍 Scan global en cours...');
                const result = await scanAllGroups();
                await chat.sendMessage(`✅ Scan global terminé: ${result.totalScanned} scannés, ${result.totalDeleted} supprimés.`);
            }
            return;
        }
        
        if (!containsLink(message)) return;
        
        const msgId = message.id._serialized || message.id.id;
        if (isAlreadyProcessed(msgId)) return;
        markAsProcessed(msgId);
        
        let authorId = message.author || message.from;
        if (authorId.includes('@g.us')) return;
        if (isUserExcluded(authorId, participants)) return;
        
        const contact = await message.getContact();
        const mention = `@${contact.number}`;
        const warningCount = addWarning(chat.id._serialized, authorId);
        const remaining = CONFIG.MAX_WARNINGS - warningCount;
        STATS.totalWarnings++;
        
        if (warningCount >= CONFIG.MAX_WARNINGS) {
            try {
                await chat.sendMessage(
                    `🚫 ${mention} a été banni pour avoir partagé des liens malgré ${CONFIG.MAX_WARNINGS} avertissements.`,
                    { mentions: [contact.id._serialized], quotedMessageId: message.id._serialized }
                );
                await chat.removeParticipants([authorId]);
                resetWarnings(chat.id._serialized, authorId);
                STATS.totalBanned++;
                addLog(`🚫 Utilisateur ${authorId} banni de ${chat.name}`);
            } catch (banError) {
                addLog(`❌ Erreur bannissement: ${banError.message}`);
                await chat.sendMessage(
                    `⚠️ ${mention} a atteint la limite mais je n'ai pas pu le bannir. Vérifiez mes permissions.`,
                    { mentions: [contact.id._serialized], quotedMessageId: message.id._serialized }
                );
            }
        } else {
            await chat.sendMessage(
                `⚠️ ${mention} Les liens ne sont pas autorisés. ` +
                `Avertissement ${warningCount}/${CONFIG.MAX_WARNINGS}. ` +
                `Il vous reste ${remaining} avertissement(s) avant bannissement.`,
                { mentions: [contact.id._serialized], quotedMessageId: message.id._serialized }
            );
            addLog(`⚠️ Avertissement ${warningCount}/${CONFIG.MAX_WARNINGS} pour ${authorId}`);
        }
        
        try {
            await message.delete(true);
            STATS.totalDeleted++;
            addLog(`🗑️ Message supprimé de ${authorId}`);
        } catch (deleteError) {
            addLog(`❌ Erreur suppression: ${deleteError.message}`);
        }
    } catch (error) {
        console.error('Erreur traitement message:', error);
    }
});

client.on('group_join', async (notification) => {
    try {
        if (!CONFIG.WELCOME_ENABLED) return;
        const chat = await notification.getChat();
        const botId = client.info.wid._serialized;
        const participants = chat.participants || [];
        const botParticipant = participants.find(p => p.id._serialized === botId);
        if (!botParticipant || !botParticipant.isAdmin) return;
        
        let newMemberId = notification.recipient;
        if (notification.id && notification.id.participant) newMemberId = notification.id.participant;
        
        let contact;
        try { contact = await client.getContactById(newMemberId); } catch (e) { return; }
        
        const mention = `@${contact.number}`;
        const welcomeMessage = CONFIG.WELCOME_MESSAGE
            .replace(/{mention}/g, mention)
            .replace(/{group}/g, chat.name)
            .replace(/{maxWarnings}/g, CONFIG.MAX_WARNINGS);
        
        await chat.sendMessage(welcomeMessage, { mentions: [contact.id._serialized] });
        addLog(`👋 Bienvenue envoyé à ${contact.number} dans ${chat.name}`);
    } catch (error) {
        addLog(`❌ Erreur bienvenue: ${error.message}`);
    }
});

client.on('auth_failure', (msg) => addLog(`❌ Échec auth: ${msg}`));
client.on('disconnected', (reason) => { isConnected = false; addLog(`🔌 Déconnecté: ${reason}`); });

// ============ SERVEUR WEB EXPRESS ============

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => res.json({ connected: isConnected, qr: currentQR }));
app.get('/api/config', (req, res) => res.json({
    MAX_WARNINGS: CONFIG.MAX_WARNINGS, WARNING_EXPIRY_HOURS: CONFIG.WARNING_EXPIRY_HOURS,
    SCAN_LIMIT: CONFIG.SCAN_LIMIT, AUTO_SCAN_INTERVAL_HOURS: CONFIG.AUTO_SCAN_INTERVAL_HOURS,
    DELAY_BETWEEN_ACTIONS_MIN: CONFIG.DELAY_BETWEEN_ACTIONS_MIN,
    DELAY_BETWEEN_ACTIONS_MAX: CONFIG.DELAY_BETWEEN_ACTIONS_MAX,
    WELCOME_MESSAGE: CONFIG.WELCOME_MESSAGE, WELCOME_ENABLED: CONFIG.WELCOME_ENABLED,
    AUTO_SCAN_ENABLED: CONFIG.AUTO_SCAN_ENABLED
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
        saveConfig();
        addLog('⚙️ Configuration mise à jour');
        res.json({ success: true, message: 'Configuration enregistrée' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        if (isConnected) {
            const chats = await client.getChats();
            const groups = chats.filter(c => c.isGroup);
            let adminCount = 0;
            for (const g of groups) {
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
    try { fs.writeFileSync(WARNINGS_FILE, JSON.stringify({})); addLog('🗑️ Avertissements effacés'); res.json({ success: true }); }
    catch (error) { res.status(500).json({ success: false, message: error.message }); }
});
app.get('/api/groups', async (req, res) => {
    try {
        if (!isConnected) return res.json([]);
        const chats = await client.getChats();
        res.json(chats.filter(c => c.isGroup).map(g => {
            const bp = g.participants?.find(p => p.id._serialized === client.info.wid._serialized);
            return { id: g.id._serialized, name: g.name, participants: g.participants?.length || 0, isAdmin: bp?.isAdmin || false, isExcluded: GROUP_EXCEPTIONS.excludedGroups.includes(g.id._serialized) };
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
        if (userId && !USER_EXCEPTIONS.excludedUsers.includes(userId)) { USER_EXCEPTIONS.excludedUsers.push(userId); saveUserExceptions(); }
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

app.listen(PORT, () => console.log(`🌐 Interface web: http://localhost:${PORT}`));

// ============ DÉMARRAGE ============
loadConfig();
loadLogs();
loadGroupExceptions();
loadUserExceptions();
loadProcessedMessages(); // ✅ Chargement anti-doublon

console.log('🚀 Démarrage du bot WhatsApp...\n');
client.initialize();