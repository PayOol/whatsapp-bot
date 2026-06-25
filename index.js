const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { ensureOgImage, captureLandingPage, isOgImageValid, OUTPUT_PATH } = require('./og-screenshot');

function shouldSuppressLibsignalConsoleLog(args) {
    const first = String(args?.[0] || '');
    return first === 'Closing session:' || first === 'Session already closed';
}

function installConsolePrivacyFilters() {
    if (console.__payoolPrivacyFiltersInstalled) return;
    const originalInfo = console.info.bind(console);
    const originalWarn = console.warn.bind(console);

    console.info = (...args) => {
        if (shouldSuppressLibsignalConsoleLog(args)) return;
        return originalInfo(...args);
    };

    console.warn = (...args) => {
        if (shouldSuppressLibsignalConsoleLog(args)) return;
        return originalWarn(...args);
    };

    console.__payoolPrivacyFiltersInstalled = true;
}

installConsolePrivacyFilters();

let baileysModulePromise = null;
function loadBaileys() {
    if (!baileysModulePromise) baileysModulePromise = import('baileys');
    return baileysModulePromise;
}

function makeBaileysLogger() {
    const noop = () => {};
    return {
        level: 'silent',
        fatal: noop,
        error: noop,
        warn: noop,
        info: noop,
        debug: noop,
        trace: noop,
        child: () => makeBaileysLogger()
    };
}

function getJidValue(value) {
    if (!value) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return String(value).trim();
    }
    if (typeof value !== 'object') return '';

    if (value.user && value.server) {
        return `${value.user}@${value.server}`;
    }

    const candidates = [
        value._serialized,
        value.jid,
        value.lid,
        value.phoneNumber,
        value.id,
        value.participant,
        value.remoteJid,
        value.recipient,
        value.user
    ];

    for (const candidate of candidates) {
        const jid = getJidValue(candidate);
        if (jid) return jid;
    }

    return '';
}

function normalizeJid(jid) {
    jid = getJidValue(jid);
    if (!jid) return '';
    if (jid.endsWith('@c.us')) return jid.replace('@c.us', '@s.whatsapp.net');
    if (jid.includes('@')) return jid;
    const digits = jid.replace(/\D/g, '');
    return `${digits || jid}@s.whatsapp.net`;
}

function isGroupJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us');
}

function jidNumber(jid) {
    return getJidValue(jid).split('@')[0].split(':')[0];
}

function digitsOnly(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function phoneNumbersMatch(a, b) {
    const da = digitsOnly(a);
    const db = digitsOnly(b);
    if (!da || !db) return false;
    if (da === db) return true;
    const shortest = Math.min(da.length, db.length);
    return shortest >= 7 && (da.endsWith(db) || db.endsWith(da));
}

function addUserMatchValue(set, value) {
    if (!value) return;
    const raw = String(value).trim();
    if (!raw) return;
    set.add(raw);
    set.add(raw.replace(/\s+/g, ''));
    if (raw.includes('@')) set.add(normalizeJid(raw));
    const digits = digitsOnly(raw);
    if (digits) {
        set.add(digits);
        set.add(`+${digits}`);
        set.add(`${digits}@s.whatsapp.net`);
    }
}

function buildUserMatchValues(...values) {
    const set = new Set();
    const add = (value) => {
        if (Array.isArray(value)) {
            value.forEach(add);
            return;
        }
        if (value && typeof value === 'object') {
            add(value.id);
            add(value.jid);
            add(value.lid);
            add(value.phoneNumber);
            add(value.number);
            add(value._serialized);
            add(value.aliases);
            return;
        }
        addUserMatchValue(set, value);
    };
    values.forEach(add);
    return Array.from(set);
}

function valuesMatchUser(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (String(a).trim() === String(b).trim()) return true;
    if (String(a).includes('@') && String(b).includes('@') && normalizeJid(String(a)) === normalizeJid(String(b))) return true;
    return phoneNumbersMatch(a, b);
}

function userExceptionMatches(entry, values) {
    const id = typeof entry === 'object' ? entry.id : entry;
    const aliases = typeof entry === 'object' ? (entry.aliases || []) : [];
    const entryValues = buildUserMatchValues(id, aliases);
    return entryValues.some(entryValue => values.some(value => valuesMatchUser(entryValue, value)));
}

function userExceptionEnabled(entry, type) {
    if (!type) return true;
    if (type === 'link') return typeof entry === 'object' ? entry.linkException !== false : true;
    if (type === 'call') return typeof entry === 'object' ? entry.callException === true : false;
    return true;
}

function findUserException(excludedUsers = [], values = [], type = null) {
    const candidates = buildUserMatchValues(values);
    return excludedUsers.find(entry => userExceptionMatches(entry, candidates) && userExceptionEnabled(entry, type));
}

function jidObject(jid) {
    const serialized = jid || '';
    return { _serialized: serialized, user: jidNumber(serialized) };
}

function unwrapMessageContent(message) {
    if (!message) return null;
    if (message.ephemeralMessage?.message) return unwrapMessageContent(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return unwrapMessageContent(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return unwrapMessageContent(message.viewOnceMessageV2.message);
    if (message.documentWithCaptionMessage?.message) return unwrapMessageContent(message.documentWithCaptionMessage.message);
    return message;
}

function getMessageBody(message) {
    const content = unwrapMessageContent(message?.message || message);
    if (!content) return '';
    return content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || content.documentMessage?.caption
        || content.buttonsResponseMessage?.selectedDisplayText
        || content.templateButtonReplyMessage?.selectedDisplayText
        || content.listResponseMessage?.title
        || content.interactiveResponseMessage?.body?.text
        || '';
}

function getMessageType(message) {
    const content = unwrapMessageContent(message?.message || message);
    if (!content) return 'unknown';
    const key = Object.keys(content).find(k => k !== 'messageContextInfo');
    if (key === 'conversation' || key === 'extendedTextMessage') return 'chat';
    if (key === 'buttonsResponseMessage' || key === 'templateButtonReplyMessage') return 'buttons_response';
    if (key === 'listResponseMessage' || key === 'interactiveResponseMessage') return 'list_response';
    if (key === 'imageMessage') return 'image';
    if (key === 'videoMessage') return 'video';
    if (key === 'audioMessage') return 'audio';
    if (key === 'documentMessage') return 'document';
    if (key === 'stickerMessage') return 'sticker';
    if (key === 'statusMentionMessage') return 'status_mention';
    if (key === 'statusNotificationMessage') return 'status_notification';
    if (key === 'groupStatusMentionMessage' || key === 'groupStatusMessage' || key === 'groupStatusMessageV2') return 'group_status_mention';
    return key || 'unknown';
}

const STATUS_MENTION_MESSAGE_KEYS = new Set([
    'statusMentionMessage',
    'groupStatusMentionMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
    'statusNotificationMessage',
    'statusMentions',
    'statusMentionSources',
    'statusMentionMessageInfo',
    '_statusMentionMessage',
    '_groupStatusMentionMessage',
    '_groupStatusMessage',
    '_groupStatusMessageV2',
    '_statusNotificationMessage',
    '_statusMentionMessageInfo'
]);

const STATUS_MENTION_TEXT_PATTERNS = [
    'a ajoute ce groupe a son statut',
    'a identifie ce groupe dans son statut',
    'a mentionne ce groupe dans son statut',
    'ce groupe a ete mentionne',
    'mentioned this group in their status',
    'this group was mentioned',
    'mentioned this group',
    'group was mentioned'
];

const STATUS_ATTRIBUTION_TYPE_KEYS = new Set([
    'type',
    'statusAttributionType'
]);

const PUBLIC_COMMANDS = new Set(['!help']);
const ADMIN_COMMANDS = new Set([
    '!status',
    '!scan',
    '!scanall',
    '!scanstatus',
    '!cache',
    '!groupinfo',
    '!config',
    '!excludehere',
    '!includehere',
    '!warnings',
    '!resetwarn',
    '!blocked',
    '!unblock',
    '!allowcalls',
    '!diagdelete',
    '!testdelete'
]);
const BOT_COMMANDS = new Set([...PUBLIC_COMMANDS, ...ADMIN_COMMANDS]);

function getBotCommand(message) {
    const text = getMessageBody(message).trim().toLowerCase();
    const command = text.split(/\s+/)[0];
    return BOT_COMMANDS.has(command) ? command : null;
}

function normalizeStatusMentionText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function hasStatusMentionMarker(value, depth = 0, seen = new Set()) {
    if (value === null || value === undefined || depth > 8) return false;

    if (typeof value === 'string') {
        const lower = value.toLowerCase();
        return lower.includes('statusmentionmessage')
            || lower.includes('groupstatusmentionmessage');
    }

    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.some(item => hasStatusMentionMarker(item, depth + 1, seen));
    }

    for (const [key, child] of Object.entries(value)) {
        if (STATUS_ATTRIBUTION_TYPE_KEYS.has(key) && (child === 4 || String(child) === 'STATUS_MENTION')) {
            const keys = Object.keys(value).map(k => k.toLowerCase());
            if (keys.some(k => k.includes('status') || k.includes('attribution'))) return true;
        }

        if (typeof child === 'string') {
            const keyLower = key.toLowerCase();
            const childLower = child.toLowerCase();
            if (
                childLower.includes('status@broadcast') &&
                (keyLower.includes('jid') || keyLower.includes('participant') || keyLower.includes('status') || keyLower.includes('source') || keyLower === 'from')
            ) {
                return true;
            }
        }

        if (STATUS_MENTION_MESSAGE_KEYS.has(key)) {
            if (Array.isArray(child)) {
                if (child.length > 0) return true;
            } else if (child !== null && child !== undefined) {
                return true;
            }
        }

        if (key === 'messageStubType' && (child === 210 || String(child) === 'STATUS_MENTION')) {
            return true;
        }

        if (hasStatusMentionMarker(child, depth + 1, seen)) return true;
    }

    return false;
}

function isStatusMentionNotification(message) {
    if (!message) return false;

    const messageType = getMessageType(message);
    if (messageType === 'status_mention' || messageType === 'group_status_mention' || messageType === 'status_notification' || messageType === 'status') {
        return true;
    }

    if (message.messageStubType === 210 || String(message.messageStubType) === 'STATUS_MENTION') {
        return true;
    }

    const quoted = getQuotedData(message) || {};
    if (
        quoted.quotedParticipant === 'status@broadcast' ||
        quoted.quotedRemoteJid === 'status@broadcast' ||
        quoted.quotedMsg?.from === 'status@broadcast' ||
        quoted.quotedMsg?.remoteJid === 'status@broadcast'
    ) {
        return true;
    }

    if (hasStatusMentionMarker(message)) return true;

    const body = normalizeStatusMentionText(getMessageBody(message));
    return !!body && STATUS_MENTION_TEXT_PATTERNS.some(pattern => body.includes(pattern));
}

function getSelectedResponseId(message) {
    const content = unwrapMessageContent(message?.message || message);
    return content?.buttonsResponseMessage?.selectedButtonId
        || content?.templateButtonReplyMessage?.selectedId
        || content?.listResponseMessage?.singleSelectReply?.selectedRowId
        || content?.interactiveResponseMessage?.nativeFlowResponseMessage?.name
        || null;
}

function getQuotedData(message) {
    const content = unwrapMessageContent(message?.message || message);
    const ctx = content?.extendedTextMessage?.contextInfo
        || content?.imageMessage?.contextInfo
        || content?.videoMessage?.contextInfo
        || content?.documentMessage?.contextInfo
        || content?.buttonsResponseMessage?.contextInfo
        || content?.listResponseMessage?.contextInfo
        || {};
    return {
        quotedParticipant: ctx.participant,
        quotedRemoteJid: ctx.remoteJid,
        quotedStanzaID: ctx.stanzaId,
        quotedMsg: ctx.quotedMessage
    };
}

function getMessageId(message) {
    return message?.key?.id || '';
}

function makeReplyOptions(message, options = {}) {
    const msgId = getMessageId(message);
    if (!message || !msgId) return { ...options };
    return {
        ...options,
        quotedMessage: options.quotedMessage || message,
        quotedMessageId: options.quotedMessageId || msgId
    };
}

function getMessageChatId(message) {
    return message?.key?.remoteJid || '';
}

function getMessageSender(message) {
    return message?.key?.participant
        || message?.key?.participantAlt
        || message?.key?.participantPn
        || message?.key?.participantLid
        || message?.key?.remoteJid
        || '';
}

function isMessageFromMe(message) {
    return !!message?.key?.fromMe;
}

function hydrateParticipant(participant) {
    const raw = participant && typeof participant === 'object' ? participant : {};
    const jid = normalizeJid(raw.jid || raw.id || raw.lid || raw.phoneNumber || participant);
    const phoneNumber = raw.phoneNumber ? normalizeJid(raw.phoneNumber) : (jid.endsWith('@s.whatsapp.net') ? jid : null);
    const lid = raw.lid ? normalizeJid(raw.lid) : (jid.endsWith('@lid') ? jid : null);
    return {
        ...raw,
        jid,
        lid,
        phoneNumber,
        number: jidNumber(phoneNumber || jid),
        id: jidObject(jid),
        isAdmin: raw.admin === 'admin' || raw.admin === 'superadmin' || raw.isAdmin === true,
        isSuperAdmin: raw.admin === 'superadmin' || raw.isSuperAdmin === true
    };
}

function hydrateChat(jid, data = {}) {
    const participants = (data.participants || []).map(hydrateParticipant);
    return {
        ...data,
        _raw: data,
        jid,
        id: jidObject(jid),
        isGroup: isGroupJid(jid),
        name: data.subject || data.name || data.notify || jid,
        participants
    };
}

function ensureRuntime(sock) {
    if (!sock.runtime) {
        sock.runtime = {
            chats: new Map(),
            contacts: new Map(),
            messagesByChat: new Map(),
            messagesById: new Map(),
            blocklist: new Set(),
            messageCacheSaveTimer: null,
            groupFetchPromise: null,
            groupCacheFetchedAt: 0,
            groupCacheLastError: null
        };
    }
    return sock.runtime;
}

const MESSAGE_CACHE_LIMIT_PER_CHAT = 300;
const MESSAGE_CACHE_SAVE_DELAY_MS = 1200;
const GROUP_CACHE_TTL_MS = 2 * 60 * 1000;
const GROUP_CACHE_RETRY_DELAY_MS = 15000;
const CONTACT_NAME_FIELDS = ['name', 'notify', 'verifiedName', 'verifiedBizName', 'pushName', 'shortName', 'username'];

function messageTimestampNumber(messageOrTimestamp) {
    const value = messageOrTimestamp?.messageTimestamp ?? messageOrTimestamp;
    if (!value) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') return Number(value) || 0;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low === 'number') return value.low + ((value.high || 0) * 4294967296);
    return 0;
}

function stripMessageCacheValue(value, depth = 0, seen = new Set()) {
    if (value === null || value === undefined) return value;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return undefined;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value !== 'object') return value;
    if (typeof value.toNumber === 'function' && typeof value.low === 'number') return value.toNumber();
    if (depth > 8 || seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
        return value
            .map(item => stripMessageCacheValue(item, depth + 1, seen))
            .filter(item => item !== undefined);
    }

    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (['jpegThumbnail', 'thumbnail', 'mediaKey', 'fileSha256', 'fileEncSha256'].includes(key)) continue;
        const stripped = stripMessageCacheValue(child, depth + 1, seen);
        if (stripped !== undefined) out[key] = stripped;
    }
    return out;
}

function sanitizeMessageForCache(message) {
    return stripMessageCacheValue({
        key: message.key,
        messageTimestamp: messageTimestampNumber(message),
        message: message.message,
        messageStubType: message.messageStubType,
        messageStubParameters: message.messageStubParameters,
        statusMentions: message.statusMentions,
        statusMentionSources: message.statusMentionSources,
        statusMentionMessageInfo: message.statusMentionMessageInfo,
        pushName: message.pushName,
        verifiedBizName: message.verifiedBizName
    });
}

function getMessageCacheFile(sessionId) {
    return path.join(DATA_DIR, 'sessions', sessionId, 'message_cache.json');
}

function savePersistentMessageCache(sock) {
    if (!sock?.sessionId) return;
    const rt = ensureRuntime(sock);
    const payload = { version: 1, savedAt: Date.now(), chats: {} };

    for (const [chatId, list] of rt.messagesByChat.entries()) {
        const sanitized = list
            .slice(-MESSAGE_CACHE_LIMIT_PER_CHAT)
            .map(sanitizeMessageForCache)
            .filter(message => message?.key?.remoteJid && message?.key?.id);
        if (sanitized.length) payload.chats[chatId] = sanitized;
    }

    try {
        const file = getMessageCacheFile(sock.sessionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    } catch (e) {}
}

function schedulePersistentMessageCacheSave(sock) {
    if (!sock?.sessionId) return;
    const rt = ensureRuntime(sock);
    if (rt.messageCacheSaveTimer) return;
    rt.messageCacheSaveTimer = setTimeout(() => {
        rt.messageCacheSaveTimer = null;
        savePersistentMessageCache(sock);
    }, MESSAGE_CACHE_SAVE_DELAY_MS);
    rt.messageCacheSaveTimer.unref?.();
}

function loadPersistentMessageCache(sock, sessionId) {
    try {
        const file = getMessageCacheFile(sessionId);
        if (!fs.existsSync(file)) return;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        let loaded = 0;
        for (const messages of Object.values(data.chats || {})) {
            for (const message of messages || []) {
                cacheMessage(sock, message, { persist: false });
                cacheMessageContactInfo(sock, message);
                loaded++;
            }
        }
        if (loaded) addLog('[CACHE] [' + sessionId + '] ' + loaded + ' messages restaures pour les scans');
    } catch (e) {
        addLog('[CACHE] [' + sessionId + '] Cache messages ignore: ' + e.message);
    }
}

function cacheMessage(sock, message, options = {}) {
    if (!message?.key?.remoteJid || !message?.key?.id) return;
    const rt = ensureRuntime(sock);
    const chatId = message.key.remoteJid;
    if (!rt.messagesByChat.has(chatId)) rt.messagesByChat.set(chatId, []);
    const existing = rt.messagesById.get(message.key.id);
    if (existing?.key?.remoteJid === chatId) return;
    const list = rt.messagesByChat.get(chatId);
    list.push(message);
    list.sort((a, b) => messageTimestampNumber(a) - messageTimestampNumber(b));
    if (list.length > MESSAGE_CACHE_LIMIT_PER_CHAT) list.splice(0, list.length - MESSAGE_CACHE_LIMIT_PER_CHAT);
    rt.messagesById.set(message.key.id, message);
    if (options.persist !== false) schedulePersistentMessageCacheSave(sock);
}

function getCachedMessages(sock, chatId, limit = 50) {
    return (ensureRuntime(sock).messagesByChat.get(chatId) || [])
        .slice()
        .sort((a, b) => messageTimestampNumber(a) - messageTimestampNumber(b))
        .slice(-limit);
}

function getCachedMessage(sock, messageId) {
    return ensureRuntime(sock).messagesById.get(messageId) || null;
}

function getLatestMessageKey(sock, chatId) {
    const messages = getCachedMessages(sock, chatId, 1);
    return messages[0]?.key || null;
}

function getOwnJids(sock) {
    const me = sock.user || sock.authState?.creds?.me || {};
    const aliases = buildUserMatchValues(
        me.id,
        me.lid,
        me.phoneNumber,
        sock.authState?.creds?.me?.id,
        sock.authState?.creds?.me?.lid,
        sock.authState?.creds?.me?.phoneNumber,
        sock.info?.wid?._serialized,
        sock.info?.lid,
        sock.info?.phoneNumber
    );
    const own = new Set();
    for (const alias of aliases) {
        if (String(alias).includes('@')) own.add(normalizeJid(alias));
        const digits = digitsOnly(alias);
        if (digits) {
            own.add(digits);
            own.add(`${digits}@s.whatsapp.net`);
        }
    }
    return Array.from(own).filter(Boolean);
}

function participantMatches(participant, jidOrNumber) {
    if (!participant || !jidOrNumber) return false;
    return [participant.jid, participant.id?._serialized, participant.lid, participant.phoneNumber, participant.number]
        .filter(Boolean)
        .some(value => valuesMatchUser(value, jidOrNumber));
}

function findBotParticipant(sock, participants = []) {
    const own = getOwnJids(sock);
    return participants.find(p => own.some(jid => participantMatches(p, jid)));
}

function isRateLimitError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('rate-overlimit') || message.includes('rate limit') || message.includes('too many requests');
}

function getCachedChatInfo(sock, jid, fallback = {}) {
    jid = normalizeJid(jid);
    const rt = ensureRuntime(sock);
    if (rt.chats.has(jid)) return rt.chats.get(jid);
    const chat = hydrateChat(jid, {
        id: jid,
        subject: fallback.subject,
        name: fallback.name || fallback.subject || jid,
        participants: fallback.participants || []
    });
    rt.chats.set(jid, chat);
    return chat;
}

async function getChatInfo(sock, jid, force = false) {
    jid = normalizeJid(jid);
    const rt = ensureRuntime(sock);
    if (!force && rt.chats.has(jid)) return rt.chats.get(jid);
    if (isGroupJid(jid)) {
        try {
            const metadata = await sock.groupMetadata(jid);
            const chat = hydrateChat(jid, metadata);
            rt.chats.set(jid, chat);
            return chat;
        } catch (error) {
            if (rt.chats.has(jid)) return rt.chats.get(jid);
            if (isRateLimitError(error)) return getCachedChatInfo(sock, jid);
            throw error;
        }
    }
    const chat = hydrateChat(jid, { name: jidNumber(jid) });
    rt.chats.set(jid, chat);
    return chat;
}

async function getAllChats(sock) {
    return getAllChatsWithOptions(sock);
}

async function getAllChatsWithOptions(sock, options = {}) {
    const rt = ensureRuntime(sock);
    const cachedChats = () => Array.from(rt.chats.values());
    const cachedGroups = () => cachedChats().filter(chat => chat.isGroup);
    const ttlMs = options.ttlMs ?? GROUP_CACHE_TTL_MS;
    const cacheFresh = cachedGroups().length > 0 && Date.now() - (rt.groupCacheFetchedAt || 0) < ttlMs;

    if (!options.force && cacheFresh) return cachedChats();

    if (rt.groupFetchPromise) {
        await rt.groupFetchPromise;
        return cachedChats();
    }

    if (sock.groupFetchAllParticipating) {
        const retries = options.retries ?? 0;
        const retryDelayMs = options.retryDelayMs ?? GROUP_CACHE_RETRY_DELAY_MS;
        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                rt.groupFetchPromise = (async () => {
                    const groups = await sock.groupFetchAllParticipating();
                    for (const [jid, metadata] of Object.entries(groups || {})) {
                        rt.chats.set(jid, hydrateChat(jid, metadata));
                    }
                    rt.groupCacheFetchedAt = Date.now();
                    rt.groupCacheLastError = null;
                })();

                await rt.groupFetchPromise;
                rt.groupFetchPromise = null;
                return cachedChats();
            } catch (error) {
                rt.groupFetchPromise = null;
                rt.groupCacheLastError = error;
                lastError = error;
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
            }
        }

        if (lastError && (!isRateLimitError(lastError) || cachedGroups().length === 0)) {
            throw lastError;
        }
    }

    return cachedChats();
}

async function hydrateMissingGroupParticipants(sock, groups = [], options = {}) {
    const missingGroups = groups.filter(group => group?.isGroup && (!group.participants || group.participants.length === 0));
    const maxGroups = Math.max(0, Math.min(Number(options.maxGroups || 80), missingGroups.length));
    const delayMs = Math.max(0, Number(options.delayMs ?? 700));
    let hydrated = 0;
    let rateLimited = false;

    for (const group of missingGroups.slice(0, maxGroups)) {
        try {
            const before = (ensureRuntime(sock).chats.get(group.jid)?.participants || group.participants || []).length;
            const fresh = await getChatInfo(sock, group.jid, true);
            const after = (fresh?.participants || []).length;
            if (!before && after > 0) hydrated++;
        } catch (error) {
            if (isRateLimitError(error)) {
                rateLimited = true;
                break;
            }
        }

        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return { hydrated, attempted: Math.min(maxGroups, missingGroups.length), missing: missingGroups.length, rateLimited };
}

function mergeDefinedObject(...objects) {
    const merged = {};
    for (const object of objects || []) {
        if (!object || typeof object !== 'object') continue;
        for (const [key, value] of Object.entries(object)) {
            if (value !== undefined && value !== null && value !== '') merged[key] = value;
        }
    }
    return merged;
}

function normalizeContactRecord(contact = {}) {
    const primary = normalizeJid(contact.id || contact.jid || contact.phoneNumber || contact.lid || contact.number || contact._serialized);
    if (!primary || isGroupJid(primary) || primary === 'status@broadcast') return null;

    const normalized = mergeDefinedObject(contact);
    normalized.id = primary;
    if (contact.jid) normalized.jid = normalizeJid(contact.jid);
    if (contact.lid) normalized.lid = normalizeJid(contact.lid);
    if (contact.phoneNumber) normalized.phoneNumber = normalizeJid(contact.phoneNumber);
    if (!normalized.jid && primary.endsWith('@s.whatsapp.net')) normalized.jid = primary;
    if (!normalized.lid && primary.endsWith('@lid')) normalized.lid = primary;
    if (!normalized.phoneNumber && primary.endsWith('@s.whatsapp.net')) normalized.phoneNumber = primary;
    if (!normalized.number) normalized.number = jidNumber(normalized.phoneNumber || normalized.jid || primary);
    return normalized;
}

function contactCacheKeys(contact = {}, extraAliases = []) {
    const keys = new Set();
    for (const value of buildUserMatchValues(contact, extraAliases)) {
        if (!value) continue;
        let jid = String(value).includes('@') ? normalizeJid(value) : '';
        const digits = digitsOnly(value);
        if (!jid && digits) jid = `${digits}@s.whatsapp.net`;
        if (jid && !isGroupJid(jid) && jid !== 'status@broadcast') keys.add(jid);
    }
    return Array.from(keys);
}

function mergeContactRecords(...records) {
    const merged = {};
    for (const record of records || []) {
        if (!record || typeof record !== 'object') continue;
        for (const [key, value] of Object.entries(record)) {
            if (key === 'aliases') continue;
            if (value !== undefined && value !== null && value !== '') merged[key] = value;
        }
    }
    merged.aliases = Array.from(new Set(buildUserMatchValues(records, merged)));
    return merged;
}

function cacheContactInfo(sock, contact = {}, extraAliases = []) {
    const normalized = normalizeContactRecord(contact);
    if (!normalized) return null;

    const rt = ensureRuntime(sock);
    const keys = contactCacheKeys(normalized, extraAliases);
    if (!keys.length) return normalized;

    const existing = keys.map(key => rt.contacts.get(key)).filter(Boolean);
    const merged = mergeContactRecords(...existing, normalized);
    merged.aliases = Array.from(new Set(buildUserMatchValues(merged, keys, extraAliases)));

    for (const key of keys) {
        rt.contacts.set(key, mergeContactRecords(rt.contacts.get(key), merged, { id: key }));
    }

    return merged;
}

function findCachedContactInfo(sock, ...values) {
    const rt = ensureRuntime(sock);
    const candidates = buildUserMatchValues(values);
    const directKeys = contactCacheKeys({ id: candidates[0] || values[0] || '' }, candidates);
    const matches = [];

    for (const key of directKeys) {
        const contact = rt.contacts.get(key);
        if (contact) matches.push(contact);
    }

    for (const [jid, contact] of rt.contacts.entries()) {
        const contactValues = buildUserMatchValues(jid, contact);
        if (contactValues.some(contactValue => candidates.some(candidate => valuesMatchUser(contactValue, candidate)))) {
            matches.push(contact);
        }
    }

    if (!matches.length) return null;
    return mergeContactRecords(...matches);
}

function cacheMessageContactInfo(sock, message) {
    if (!message || message.key?.fromMe) return;
    const senderId = getMessageSender(message);
    if (!senderId || isGroupJid(senderId) || senderId === 'status@broadcast') return;

    const aliases = [
        message.key?.participant,
        message.key?.participantAlt,
        message.key?.participantPn,
        message.key?.participantLid,
        message.key?.remoteJid,
        message.key?.remoteJidAlt
    ];
    cacheContactInfo(sock, {
        id: senderId,
        notify: message.pushName,
        pushName: message.pushName,
        verifiedName: message.verifiedBizName,
        verifiedBizName: message.verifiedBizName,
        username: message.key?.participantUsername || message.key?.remoteJidUsername
    }, aliases);
}

async function getContactInfo(sock, jid) {
    jid = normalizeJid(jid);
    const rt = ensureRuntime(sock);
    let data = findCachedContactInfo(sock, jid) || rt.contacts.get(jid) || {};
    let mappedPhoneNumber = data.phoneNumber ? normalizeJid(data.phoneNumber) : null;
    if (!mappedPhoneNumber && jid?.endsWith('@lid')) {
        try {
            mappedPhoneNumber = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
            if (mappedPhoneNumber) mappedPhoneNumber = normalizeJid(mappedPhoneNumber);
            if (mappedPhoneNumber) cacheLidPnMapping(sock, jid, mappedPhoneNumber);
        } catch (e) {}
    }
    if (mappedPhoneNumber) data = findCachedContactInfo(sock, jid, mappedPhoneNumber, data) || data;
    const aliases = buildUserMatchValues(jid, data, mappedPhoneNumber);
    return {
        ...data,
        phoneNumber: mappedPhoneNumber || null,
        jid,
        id: jidObject(jid),
        number: mappedPhoneNumber ? jidNumber(mappedPhoneNumber) : jidNumber(jid),
        aliases,
        isBlocked: rt.blocklist.has(jid)
    };
}

async function getProfilePictureUrlForUser(sock, ...values) {
    const candidates = [];
    const seen = new Set();
    const tried = [];

    const addCandidate = (value) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach(addCandidate);
            return;
        }
        if (typeof value === 'object') {
            addCandidate(value.jid);
            addCandidate(value.id);
            addCandidate(value.lid);
            addCandidate(value.phoneNumber);
            addCandidate(value.number);
            addCandidate(value._serialized);
            addCandidate(value.aliases);
            return;
        }
        const jid = normalizeJid(value);
        if (!jid || isGroupJid(jid) || jid === 'status@broadcast' || seen.has(jid)) return;
        seen.add(jid);
        candidates.push(jid);
    };

    const addRelatedContacts = () => {
        const rt = ensureRuntime(sock);
        const baseValues = buildUserMatchValues(candidates);
        for (const [jid, data] of rt.contacts.entries()) {
            const contactValues = buildUserMatchValues(jid, data);
            if (contactValues.some(contactValue => baseValues.some(baseValue => valuesMatchUser(contactValue, baseValue)))) {
                addCandidate(jid);
                addCandidate(data);
            }
        }
    };

    values.forEach(addCandidate);
    addRelatedContacts();

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (candidate.endsWith('@lid')) {
            try {
                const pn = await sock.signalRepository?.lidMapping?.getPNForLID(candidate);
                if (pn) {
                    const pnJid = normalizeJid(pn);
                    cacheLidPnMapping(sock, candidate, pnJid);
                    addCandidate(pnJid);
                }
            } catch (e) {}
        } else if (sock.onWhatsApp) {
            const digits = digitsOnly(candidate);
            if (digits) {
                try {
                    const matches = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
                    for (const match of matches || []) addCandidate(match?.jid);
                } catch (e) {}
            }
        }

        addRelatedContacts();

        for (const type of ['image', 'preview', null]) {
            try {
                tried.push(type ? `${candidate}:${type}` : candidate);
                const url = type ? await sock.profilePictureUrl(candidate, type) : await sock.profilePictureUrl(candidate);
                if (url) return { url, jid: candidate, type, tried };
            } catch (e) {}
        }
    }

    return { url: null, jid: null, type: null, tried };
}

function getParticipantRoleLabel(participant = {}) {
    if (participant.isSuperAdmin) return 'Super admin';
    if (participant.isAdmin) return 'Admin';
    return 'Membre';
}

async function describeGroupParticipant(sock, participant) {
    const hydrated = hydrateParticipant(participant);
    const contactCandidates = [
        hydrated.phoneNumber,
        hydrated.jid,
        hydrated.lid,
        hydrated.id?._serialized,
        hydrated.number
    ].filter(Boolean);
    let contact = findCachedContactInfo(sock, hydrated, contactCandidates) || {};

    for (const contactId of contactCandidates.filter(value => String(value).includes('@'))) {
        const info = await getContactInfo(sock, contactId).catch(() => null);
        if (info) contact = mergeContactRecords(contact, info);
    }

    const phoneJid = contact?.phoneNumber || hydrated.phoneNumber || (hydrated.jid?.endsWith('@s.whatsapp.net') ? hydrated.jid : null);
    const primaryJid = phoneJid || contact?.jid || hydrated.jid || contact?.lid || hydrated.lid;
    const number = phoneJid ? jidNumber(phoneJid) : (contact?.number || hydrated.number || jidNumber(primaryJid));
    const fallbackName = getContactDisplayName(hydrated, hydrated.username ? `@${String(hydrated.username).replace(/^@+/, '')}` : '');
    const displayName = getContactDisplayName(contact, fallbackName);

    return {
        jid: normalizeJid(primaryJid),
        lid: hydrated.lid || (hydrated.jid?.endsWith('@lid') ? hydrated.jid : null),
        phoneNumber: phoneJid || null,
        number,
        displayNumber: number ? `+${number}` : 'non disponible',
        name: displayName,
        nameAvailable: displayName !== 'Nom non disponible',
        username: contact?.username || hydrated.username || null,
        role: getParticipantRoleLabel(hydrated),
        isAdmin: hydrated.isAdmin,
        isSuperAdmin: hydrated.isSuperAdmin
    };
}

async function getGroupParticipantsDetailed(sock, groupId) {
    const chat = await getChatInfo(sock, groupId, true);
    if (!chat?.isGroup) throw new Error('Groupe non trouve');
    const participants = [];
    for (const participant of chat.participants || []) {
        participants.push(await describeGroupParticipant(sock, participant));
    }
    participants.sort((a, b) => {
        const nameCompare = String(a.name || '').localeCompare(String(b.name || ''), 'fr', { sensitivity: 'base' });
        return nameCompare || String(a.number || '').localeCompare(String(b.number || ''));
    });
    return { chat, participants };
}

function uniqueRecipients(values = []) {
    const recipients = [];
    const seen = new Set();
    for (const value of values || []) {
        const jid = normalizeJid(value);
        if (!jid || isGroupJid(jid) || jid === 'status@broadcast' || seen.has(jid)) continue;
        seen.add(jid);
        recipients.push(jid);
    }
    return recipients;
}

function parseRecipientValues(value) {
    if (Array.isArray(value)) return value.flatMap(parseRecipientValues);
    if (value && typeof value === 'object') {
        return parseRecipientValues(value.jid || value.phoneNumber || value.number || value.id || value._serialized);
    }
    return String(value || '')
        .split(/[\n,;|]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
}

function randomBetween(min, max) {
    const safeMin = Math.max(0, Math.min(min, max));
    const safeMax = Math.max(safeMin, Math.max(min, max));
    if (safeMax === safeMin) return safeMin;
    return Math.round(safeMin + Math.random() * (safeMax - safeMin));
}

function normalizeBulkMessageOptions(input = {}) {
    const minDelayMs = boundedNumber(input.minDelayMs, 15000, 3000, 600000);
    const maxDelayMs = boundedNumber(input.maxDelayMs, 45000, minDelayMs, 900000);
    const pauseEvery = boundedNumber(input.pauseEvery, 8, 0, 100);
    const pauseMinMs = boundedNumber(input.pauseMinMs, 90000, 10000, 1800000);
    const pauseMaxMs = boundedNumber(input.pauseMaxMs, 180000, pauseMinMs, 3600000);
    const maxRecipients = boundedNumber(input.maxRecipients, 200, 1, 500);
    return { minDelayMs, maxDelayMs, pauseEvery, pauseMinMs, pauseMaxMs, maxRecipients };
}

async function sendBulkWhatsAppMessages(sock, sessionData, recipients, message, options = {}) {
    const normalizedOptions = normalizeBulkMessageOptions(options);
    const targets = uniqueRecipients(recipients).slice(0, normalizedOptions.maxRecipients);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const results = [];
    let sent = 0;
    let failed = 0;

    if (!message || !String(message).trim()) throw new Error('Message requis');
    if (!targets.length) throw new Error('Aucun destinataire valide');

    const log = (text) => sessionData ? sessionData.addLog(text) : addLog(text);
    log('[BULK] Debut envoi WhatsApp: ' + targets.length + ' destinataire(s)');
    onProgress?.({ status: 'running', total: targets.length, sent, failed, processed: 0, results });

    for (let i = 0; i < targets.length; i++) {
        const recipient = targets[i];
        try {
            await sendMessageHumanized(sock, recipient, message, {}, 0, sessionData);
            sent++;
            results.push({ recipient, success: true });
            log('[BULK] Message envoye a ' + recipient + ' (' + (i + 1) + '/' + targets.length + ')');
        } catch (error) {
            failed++;
            results.push({ recipient, success: false, message: error.message });
            log('[BULK] Echec ' + recipient + ': ' + error.message);
        }
        onProgress?.({
            status: 'running',
            total: targets.length,
            sent,
            failed,
            processed: i + 1,
            latest: results[results.length - 1],
            results
        });

        const hasNext = i < targets.length - 1;
        if (!hasNext) continue;

        if (normalizedOptions.pauseEvery > 0 && (i + 1) % normalizedOptions.pauseEvery === 0) {
            const pause = randomBetween(normalizedOptions.pauseMinMs, normalizedOptions.pauseMaxMs);
            log('[BULK] Pause longue ' + Math.round(pause / 1000) + 's');
            await new Promise(resolve => setTimeout(resolve, pause));
        } else {
            const delay = randomBetween(normalizedOptions.minDelayMs, normalizedOptions.maxDelayMs);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    log('[BULK] Fin envoi WhatsApp: ' + sent + ' envoye(s), ' + failed + ' echec(s)');
    onProgress?.({ status: 'completed', total: targets.length, sent, failed, processed: targets.length, results });
    return { sent, failed, total: targets.length, options: normalizedOptions, results };
}

const backgroundJobs = new Map();
const BACKGROUND_JOB_TTL_MS = 24 * 60 * 60 * 1000;

function sanitizeBackgroundJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        type: job.type,
        label: job.label,
        sessionId: job.sessionId,
        ownerUsername: job.ownerUsername,
        status: job.status,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        failed: job.failed,
        message: job.message,
        error: job.error,
        latest: job.latest,
        results: job.results || [],
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
    };
}

function scheduleBackgroundJobCleanup(jobId) {
    const timer = setTimeout(() => backgroundJobs.delete(jobId), BACKGROUND_JOB_TTL_MS);
    timer.unref?.();
}

function startBackgroundBulkMessageJob({ sock, sessionData, sessionId, ownerUsername, recipients, message, options = {}, type = 'bulk-message', label = 'Envoi WhatsApp' }) {
    const normalizedOptions = normalizeBulkMessageOptions(options);
    const targets = uniqueRecipients(recipients).slice(0, normalizedOptions.maxRecipients);
    if (!message || !String(message).trim()) throw new Error('Message requis');
    if (!targets.length) throw new Error('Aucun destinataire valide');

    const job = {
        id: 'job_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
        type,
        label,
        sessionId: sessionId || 'global',
        ownerUsername: ownerUsername || null,
        status: 'queued',
        total: targets.length,
        processed: 0,
        sent: 0,
        failed: 0,
        message: 'En attente de demarrage',
        error: null,
        latest: null,
        results: [],
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null
    };
    backgroundJobs.set(job.id, job);

    setImmediate(async () => {
        job.status = 'running';
        job.startedAt = Date.now();
        job.message = 'Envoi en cours';
        try {
            const result = await sendBulkWhatsAppMessages(sock, sessionData, targets, message, {
                ...options,
                onProgress: progress => {
                    job.status = progress.status || job.status;
                    job.total = progress.total ?? job.total;
                    job.processed = progress.processed ?? job.processed;
                    job.sent = progress.sent ?? job.sent;
                    job.failed = progress.failed ?? job.failed;
                    job.latest = progress.latest || job.latest;
                    job.results = progress.results || job.results;
                    job.message = job.status === 'completed' ? 'Envoi termine' : 'Envoi en cours';
                }
            });
            job.status = 'completed';
            job.finishedAt = Date.now();
            job.message = 'Envoi termine';
            job.total = result.total;
            job.sent = result.sent;
            job.failed = result.failed;
            job.processed = result.total;
            job.results = result.results || [];
        } catch (error) {
            job.status = 'failed';
            job.finishedAt = Date.now();
            job.error = error.message;
            job.message = 'Envoi echoue';
            if (sessionData) sessionData.addLog('[BULK] Job ' + job.id + ' echoue: ' + error.message);
            else addLog('[BULK] Job ' + job.id + ' echoue: ' + error.message);
        } finally {
            scheduleBackgroundJobCleanup(job.id);
        }
    });

    return sanitizeBackgroundJob(job);
}

async function refreshBlocklist(sock) {
    if (!sock?.fetchBlocklist) return ensureRuntime(sock).blocklist;
    try {
        const blocklist = await sock.fetchBlocklist();
        ensureRuntime(sock).blocklist = new Set((blocklist || []).filter(Boolean).map(normalizeJid));
    } catch (e) {}
    return ensureRuntime(sock).blocklist;
}

function blocklistContainsUser(sock, values = []) {
    const candidates = buildUserMatchValues(values);
    const blocklist = ensureRuntime(sock).blocklist || new Set();
    return Array.from(blocklist).some(blockedJid =>
        candidates.some(value => valuesMatchUser(blockedJid, value))
    );
}

async function isUserBlockedOnWhatsApp(sock, values = []) {
    await refreshBlocklist(sock);
    return blocklistContainsUser(sock, values);
}

function displayPhone(numberOrJid) {
    const digits = digitsOnly(numberOrJid);
    return digits ? `+${digits}` : 'non disponible';
}

function getContactDisplayName(contact, fallback = '') {
    for (const field of CONTACT_NAME_FIELDS) {
        const value = contact?.[field];
        if (typeof value === 'string' && value.trim()) return field === 'username' ? `@${value.replace(/^@+/, '')}` : value.trim();
    }
    if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    return 'Nom non disponible';
}

async function describeMessageAuthor(sock, message, participants = []) {
    if (isMessageFromMe(message)) {
        const ownName = sock.info?.pushname || sock.user?.name || sock.user?.notify || 'Compte connecte au bot';
        return {
            name: ownName,
            phone: displayPhone(sock.info?.phoneNumber || sock.info?.wid?.user),
            role: 'Compte du bot',
            jid: getMessageSender(message)
        };
    }

    const senderId = getMessageSender(message);
    const participant = participants.find(p => participantMatches(p, senderId));
    const contact = await getContactInfo(sock, senderId).catch(() => null);
    const number = contact?.number || participant?.number || senderId;
    const role = participant?.isSuperAdmin
        ? 'Super admin du groupe'
        : participant?.isAdmin
            ? 'Admin du groupe'
            : 'Membre du groupe';

    return {
        name: getContactDisplayName(contact, participant?.name || participant?.notify),
        phone: displayPhone(number),
        role,
        jid: senderId
    };
}

function buildDeleteDiagnosticReport({ sock, chat, message, author, botP, commandAllowed }) {
    const groupRole = botP?.isSuperAdmin ? 'super admin' : (botP?.isAdmin ? 'admin' : 'non admin');
    const permission = commandAllowed ? 'Oui' : 'Non';
    return menuPanel('DIAGNOSTIC SUPPRESSION', [
        {
            title: 'Groupe',
            lines: [
                menuLine('Nom', chat.name || 'Nom non disponible'),
                menuLine('Membres', chat.participants?.length || 0)
            ]
        },
        {
            title: 'Auteur de la commande',
            lines: [
                menuLine('Nom', author.name),
                menuLine('Numero', author.phone),
                menuLine('Role', author.role)
            ]
        },
        {
            title: 'Etat du bot',
            lines: [
                menuLine('Session WhatsApp', sock?.isReady ? 'connectee' : 'non connectee'),
                menuLine('Bot admin du groupe', (botP?.isAdmin ? 'Oui' : 'Non') + ' (' + groupRole + ')'),
                menuLine('Commande autorisee', permission)
            ]
        },
        {
            title: 'Suppression',
            lines: [
                menuLine('Methode', 'suppression pour tout le monde via Baileys'),
                menuLine('Condition', 'bot admin + cle du message disponible'),
                menuLine('Message teste', 'commande !diagdelete')
            ]
        }
    ]);
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'maintenant';
    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return hours + 'h ' + minutes + 'min';
    if (minutes > 0) return minutes + 'min ' + seconds + 's';
    return seconds + 's';
}

function getCallBlockDurationMin(config = CONFIG) {
    const configured = Number(config?.CALL_BLOCK_DURATION_MIN);
    if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
    const fallback = Number(CONFIG.CALL_BLOCK_DURATION_MIN);
    return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : 30;
}

function formatCallBlockDuration(minutes) {
    const safeMinutes = getCallBlockDurationMin({ CALL_BLOCK_DURATION_MIN: minutes });
    if (safeMinutes >= 1440 && safeMinutes % 1440 === 0) {
        const days = safeMinutes / 1440;
        return days + ' jour' + (days > 1 ? 's' : '');
    }
    if (safeMinutes >= 60 && safeMinutes % 60 === 0) {
        const hours = safeMinutes / 60;
        return hours + ' heure' + (hours > 1 ? 's' : '');
    }
    if (safeMinutes > 60) {
        const hours = Math.floor(safeMinutes / 60);
        const mins = safeMinutes % 60;
        return hours + 'h ' + mins + 'min';
    }
    return safeMinutes + ' minute' + (safeMinutes > 1 ? 's' : '');
}

function formatDateTime(ts) {
    if (!ts) return 'date inconnue';
    try { return new Date(ts).toLocaleString('fr-FR'); }
    catch (e) { return 'date inconnue'; }
}

function yesNo(value) {
    return value ? 'Oui' : 'Non';
}

function getCommandArgs(message) {
    return getMessageBody(message).trim().split(/\s+/).slice(1).filter(Boolean);
}

function collectMessageValuesByKey(value, keyNames, depth = 0, seen = new Set(), found = []) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return found;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach(item => collectMessageValuesByKey(item, keyNames, depth + 1, seen, found));
        return found;
    }
    for (const [key, child] of Object.entries(value)) {
        if (keyNames.includes(key)) {
            if (Array.isArray(child)) child.forEach(v => { if (v) found.push(v); });
            else if (child) found.push(child);
        }
        collectMessageValuesByKey(child, keyNames, depth + 1, seen, found);
    }
    return found;
}

function getMentionedJids(message) {
    return Array.from(new Set(collectMessageValuesByKey(message, ['mentionedJid', 'groupMentions'])))
        .filter(value => typeof value === 'string' && value.includes('@'));
}

function findParticipantByValues(participants = [], values = []) {
    return participants.find(participant =>
        values.some(value => participantMatches(participant, value))
    ) || null;
}

function getCommandTarget(message, participants = []) {
    const args = getCommandArgs(message);
    const mentioned = getMentionedJids(message);
    const quoted = getQuotedData(message);
    const rawArg = args.join(' ').trim();
    const values = buildUserMatchValues(mentioned, quoted?.quotedParticipant, rawArg);
    const participant = findParticipantByValues(participants, values);
    const id = participant?.jid || participant?.lid || participant?.phoneNumber || mentioned[0] || quoted?.quotedParticipant || rawArg || null;
    if (!id) return null;
    return { id, values: buildUserMatchValues(id, values, participant), participant, rawArg };
}

async function describeUserId(sock, userId, participants = []) {
    const participant = findParticipantByValues(participants, buildUserMatchValues(userId));
    const contact = await getContactInfo(sock, userId).catch(() => null);
    const number = contact?.number || participant?.number || userId;
    const role = participant?.isSuperAdmin
        ? 'Super admin du groupe'
        : participant?.isAdmin
            ? 'Admin du groupe'
            : participant
                ? 'Membre du groupe'
                : 'Utilisateur';
    return {
        name: getContactDisplayName(contact, participant?.name || participant?.notify),
        phone: displayPhone(number),
        role,
        id: userId
    };
}

function findWarningKeyForTarget(sessionData, chatId, target) {
    const warnings = sessionData.warnings[chatId] || {};
    const values = buildUserMatchValues(target?.id, target?.values, target?.participant);
    return Object.keys(warnings).find(key =>
        values.some(value => valuesMatchUser(key, value)) ||
        (target?.participant && participantMatches(target.participant, key))
    ) || null;
}

function findBlockedKeyForTarget(blocked = {}, target) {
    const values = buildUserMatchValues(target?.id, target?.values, target?.participant);
    return Object.keys(blocked).find(key => values.some(value => valuesMatchUser(key, value))) || null;
}

function menuLine(label, value) {
    return label + ': ' + (value === undefined || value === null || value === '' ? 'non disponible' : value);
}

function menuCommand(command, description) {
    return '*' + command + '* - ' + description;
}

function menuPanel(title, sections = []) {
    let output = '*' + title + '*';
    for (const section of sections) {
        const lines = (section.lines || []).filter(Boolean);
        if (!lines.length) continue;
        output += '\n\n*' + section.title + '*\n' + lines.map(line => '- ' + line).join('\n');
    }
    return output;
}

function buildNoticeMessage(title, message, extraLines = []) {
    return menuPanel(title, [
        { title: 'Info', lines: [message, ...extraLines] }
    ]);
}

function buildUsageMessage(command, usage) {
    return menuPanel('UTILISATION', [
        { title: 'Commande', lines: [menuCommand(command, usage)] }
    ]);
}

function buildHelpMessage() {
    return menuPanel('PAYOOL BOT - COMMANDES', [
        {
            title: 'Public',
            lines: [
                menuCommand('!help', 'affiche cette aide')
            ]
        },
        {
            title: 'Etat et diagnostic',
            lines: [
                menuCommand('!status', 'etat rapide du bot'),
                menuCommand('!cache', 'messages connus dans ce groupe'),
                menuCommand('!groupinfo', 'infos du groupe'),
                menuCommand('!config', 'configuration active'),
                menuCommand('!diagdelete', 'diagnostic de suppression'),
                menuCommand('!testdelete', 'test de suppression')
            ]
        },
        {
            title: 'Scan et moderation',
            lines: [
                menuCommand('!scan', 'scanner ce groupe'),
                menuCommand('!scanstatus', 'supprimer seulement les notifications de statut'),
                menuCommand('!scanall', 'scanner tous les groupes admin'),
                menuCommand('!excludehere', 'exclure ce groupe'),
                menuCommand('!includehere', 'reactiver ce groupe')
            ]
        },
        {
            title: 'Utilisateurs',
            lines: [
                menuCommand('!warnings @membre', 'voir les avertissements'),
                menuCommand('!resetwarn @membre', 'effacer les avertissements'),
                menuCommand('!blocked', 'voir les numeros bloques'),
                menuCommand('!unblock numero', 'debloquer un numero'),
                menuCommand('!allowcalls numero', 'autoriser les appels')
            ]
        }
    ]);
}

function buildStatusMessage(sock, chat, sessionData, botP) {
    const cacheCount = getCachedMessages(sock, chat.jid, sessionData.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT).length;
    return menuPanel('ETAT DU BOT', [
        {
            title: 'Connexion',
            lines: [
                menuLine('Session WhatsApp', sock?.isReady ? 'connectee' : 'non connectee'),
                menuLine('Groupe', chat.name || 'Nom non disponible'),
                menuLine('Bot admin', yesNo(botP?.isAdmin)),
                menuLine('Groupe exclu', yesNo(sessionData.isGroupExcluded(chat)))
            ]
        },
        {
            title: 'Fonctions',
            lines: [
                menuLine('Scan automatique', yesNo(sessionData.config.AUTO_SCAN_ENABLED !== false)),
                menuLine('Notifications de statut', yesNo(sessionData.config.DELETE_STATUS_MENTIONS !== false)),
                menuLine('Message bienvenue', yesNo(sessionData.config.WELCOME_ENABLED !== false))
            ]
        },
        {
            title: 'Donnees',
            lines: [
                menuLine('Messages connus ici', cacheCount),
                menuLine('Utilisateurs bloques', Object.keys(sessionData.blockedUsers || {}).length)
            ]
        }
    ]);
}

function buildGroupInfoMessage(sock, chat, sessionData, botP) {
    return menuPanel('INFOS DU GROUPE', [
        {
            title: 'Groupe',
            lines: [
                menuLine('Nom', chat.name || 'Nom non disponible'),
                menuLine('Membres', chat.participants?.length || 0)
            ]
        },
        {
            title: 'Bot',
            lines: [
                menuLine('Admin', yesNo(botP?.isAdmin)),
                menuLine('Super admin', yesNo(botP?.isSuperAdmin)),
                menuLine('Messages en cache', getCachedMessages(sock, chat.jid, sessionData.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT).length)
            ]
        },
        {
            title: 'Regles',
            lines: [
                menuLine('Moderation exclue', yesNo(sessionData.isGroupExcluded(chat))),
                menuLine('Bienvenue exclue', yesNo(sessionData.groupExceptions.excludedWelcome.includes(chat.jid)))
            ]
        }
    ]);
}

function buildConfigMessage(sessionData) {
    const c = sessionData.config;
    return menuPanel('CONFIGURATION ACTIVE', [
        {
            title: 'Moderation',
            lines: [
                menuLine('Avertissements max', c.MAX_WARNINGS),
                menuLine('Expiration avertissements', c.WARNING_EXPIRY_HOURS + 'h'),
                menuLine('Limite scan', c.SCAN_LIMIT + ' messages'),
                menuLine('Notifications de statut', yesNo(c.DELETE_STATUS_MENTIONS !== false)),
                menuLine('Bienvenue', yesNo(c.WELCOME_ENABLED !== false))
            ]
        },
        {
            title: 'Scan automatique',
            lines: [
                menuLine('Actif', yesNo(c.AUTO_SCAN_ENABLED !== false)),
                menuLine('Intervalle', c.AUTO_SCAN_INTERVAL_HOURS + 'h')
            ]
        },
        {
            title: 'Delais',
            lines: [
                menuLine('Entre actions', `${c.DELAY_BETWEEN_ACTIONS_MIN}-${c.DELAY_BETWEEN_ACTIONS_MAX}ms`),
                menuLine('Entre groupes', `${c.DELAY_BETWEEN_GROUPS_MIN}-${c.DELAY_BETWEEN_GROUPS_MAX}ms`)
            ]
        },
        {
            title: 'Appels',
            lines: [
                menuLine('Rejet appels', yesNo(c.CALL_REJECT_ENABLED !== false)),
                menuLine('Seuil spam', c.CALL_SPAM_THRESHOLD),
                menuLine('Fenetre spam', c.CALL_SPAM_WINDOW_MIN + 'min'),
                menuLine('Duree blocage', c.CALL_BLOCK_DURATION_MIN + 'min')
            ]
        }
    ]);
}

function cacheLidPnMapping(sock, lid, pn) {
    if (!sock || !lid || !pn) return;
    const lidJid = normalizeJid(lid);
    const pnJid = normalizeJid(pn);
    cacheContactInfo(sock, { id: lidJid, lid: lidJid, phoneNumber: pnJid }, [pnJid]);
    cacheContactInfo(sock, { id: pnJid, jid: pnJid, lid: lidJid, phoneNumber: pnJid }, [lidJid]);
}

async function resolveUserAliases(sock, userId) {
    const aliases = new Set(buildUserMatchValues(userId));
    const digits = digitsOnly(userId);
    const jid = userId && String(userId).includes('@') ? normalizeJid(userId) : null;
    if (sock?.onWhatsApp && digits) {
        try {
            const results = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
            for (const result of results || []) {
                if (result?.jid) buildUserMatchValues(result.jid).forEach(v => aliases.add(v));
            }
        } catch (e) {}
    }
    if (sock?.signalRepository?.lidMapping) {
        try {
            if (digits) {
                const lid = await sock.signalRepository.lidMapping.getLIDForPN(`${digits}@s.whatsapp.net`);
                if (lid) buildUserMatchValues(lid).forEach(v => aliases.add(v));
            }
            if (jid?.endsWith('@lid')) {
                const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
                if (pn) buildUserMatchValues(pn).forEach(v => aliases.add(v));
            }
        } catch (e) {}
    }
    return Array.from(aliases);
}

async function findCallExceptionForValues(sock, exceptions, values) {
    const candidates = buildUserMatchValues(values);
    let entry = findUserException(exceptions.excludedUsers, candidates, 'call');
    if (entry) return entry;

    for (const candidate of exceptions.excludedUsers || []) {
        if (!userExceptionEnabled(candidate, 'call')) continue;
        const id = typeof candidate === 'object' ? candidate.id : candidate;
        const aliases = await resolveUserAliases(sock, id);
        const enriched = typeof candidate === 'object'
            ? { ...candidate, aliases: Array.from(new Set([...(candidate.aliases || []), ...aliases])) }
            : { id: candidate, aliases, linkException: true, callException: true };

        if (userExceptionMatches(enriched, candidates)) {
            if (typeof candidate === 'object') candidate.aliases = enriched.aliases;
            return candidate;
        }
    }

    return null;
}

function clearSessionCallBlockKey(sessionData, key) {
    if (!sessionData || !key) return false;
    if (sessionData.unblockTimers[key]) {
        clearTimeout(sessionData.unblockTimers[key]);
        delete sessionData.unblockTimers[key];
    }
    const existed = !!(sessionData.blockedUsers?.[key] || sessionData.callSpamTracker?.[key]);
    delete sessionData.blockedUsers[key];
    delete sessionData.callSpamTracker[key];
    return existed;
}

function findSessionCallStateKeysForValues(sessionData, values) {
    const candidates = buildUserMatchValues(values);
    return Array.from(new Set([
        ...Object.keys(sessionData?.blockedUsers || {}),
        ...Object.keys(sessionData?.callSpamTracker || {})
    ])).filter(key => candidates.some(value => valuesMatchUser(key, value)));
}

function clearSessionCallStateForValues(sessionData, values) {
    const matchedKeys = findSessionCallStateKeysForValues(sessionData, values);
    for (const key of matchedKeys) clearSessionCallBlockKey(sessionData, key);
    if (matchedKeys.length) sessionData.saveCallSpamData();
    return matchedKeys.length;
}

async function clearCallBlocksForValues(sock, sessionData, values) {
    const candidates = buildUserMatchValues(values);
    const matchedCount = clearSessionCallStateForValues(sessionData, candidates);

    const unblockJids = new Set();
    for (const value of candidates) {
        if (isGroupJid(value)) continue;
        if (String(value).includes('@') || digitsOnly(value)) unblockJids.add(normalizeJid(value));
    }

    for (const jid of unblockJids) {
        try {
            await sock?.updateBlockStatus?.(jid, 'unblock');
            if (sock) ensureRuntime(sock).blocklist.delete(jid);
        } catch (e) {}
    }

    return matchedCount;
}

function makeMediaPayload(mimetype, base64Data, filename = 'media') {
    return { mimetype, data: base64Data, filename };
}

async function mediaFromUrl(url, filename = 'media') {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telechargement media impossible (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return makeMediaPayload(response.headers.get('content-type') || 'application/octet-stream', buffer.toString('base64'), filename);
}

function toBaileysContent(content, options = {}, sock = null) {
    const mentions = (options.mentions || []).map(normalizeJid);
    const contextInfo = mentions.length ? { mentionedJid: mentions } : undefined;
    const quoted = options.quotedMessage || (options.quotedMessageId && sock ? getCachedMessage(sock, options.quotedMessageId) : undefined);
    const sendOptions = quoted ? { quoted } : {};

    if (content && content.data && content.mimetype) {
        const buffer = Buffer.from(content.data, 'base64');
        const common = { mimetype: content.mimetype };
        if (options.caption) common.caption = options.caption;
        if (mentions.length) common.mentions = mentions;
        if (content.mimetype.startsWith('image/')) return { payload: { image: buffer, ...common }, sendOptions };
        if (content.mimetype.startsWith('video/')) return { payload: { video: buffer, ...common }, sendOptions };
        if (content.mimetype.startsWith('audio/')) return { payload: { audio: buffer, ...common }, sendOptions };
        return { payload: { document: buffer, fileName: content.filename || 'document', ...common }, sendOptions };
    }

    const payload = { text: String(content ?? '') };
    if (mentions.length) payload.mentions = mentions;
    if (contextInfo) payload.contextInfo = contextInfo;
    if (options.linkPreview === false) payload.linkPreview = null;
    return { payload, sendOptions };
}

async function sendNativeMessage(sock, jid, content, options = {}) {
    const { payload, sendOptions } = toBaileysContent(content, options, sock);
    const sent = await sock.sendMessage(normalizeJid(jid), payload, sendOptions);
    if (sent) cacheMessage(sock, sent);
    return sent;
}

async function markChatRead(sock, chatId) {
    const latest = getLatestMessageKey(sock, chatId);
    if (latest) await sock.readMessages([latest]);
}

async function fetchMoreHistory(sock, chatId, limit = 50, options = {}) {
    let cached = getCachedMessages(sock, chatId, limit);
    if (!cached.length && options.anchorMessage?.key?.remoteJid === normalizeJid(chatId)) {
        cacheMessage(sock, options.anchorMessage);
        cached = getCachedMessages(sock, chatId, limit);
    }

    if (cached.length >= limit || !sock.fetchMessageHistory) {
        return cached;
    }

    let attempts = 0;
    while (cached.length < limit && attempts < 4) {
        const oldest = cached[0];
        if (!oldest?.key || !oldest.messageTimestamp) break;

        try {
            const count = Math.min(50, Math.max(1, limit - cached.length));
            await sock.fetchMessageHistory(count, oldest.key, oldest.messageTimestamp);
            await new Promise(resolve => setTimeout(resolve, 2500));
        } catch (e) {
            break;
        }

        const next = getCachedMessages(sock, chatId, limit);
        if (next.length <= cached.length) break;
        cached = next;
        attempts++;
    }

    const messages = getCachedMessages(sock, chatId, limit);

    return messages;
}

function getCallFrom(call) {
    return normalizeJid(call?.from || call?.chatId || call?.creator || call?.participant || '');
}

function isVideoCall(call) {
    return call?.isVideo === true || call?.type === 'video' || call?.callType === 'video';
}

async function rejectBaileysCall(sock, call) {
    const callerId = getCallFrom(call);
    if (!sock?.rejectCall || !call?.id || !callerId) return false;
    await sock.rejectCall(call.id, callerId);
    return true;
}

async function deleteChatLocal(sock, chatId) {
    const jid = normalizeJid(chatId);
    const latest = getCachedMessages(sock, jid, 1)[0];
    try {
        if (latest) await sock.chatModify({ delete: true, lastMessages: [latest] }, jid);
    } catch (e) {}
    ensureRuntime(sock).chats.delete(jid);
}

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

    interActionDelay(config = CONFIG) {
        const configuredMin = Number(config?.DELAY_BETWEEN_ACTIONS_MIN);
        const configuredMax = Number(config?.DELAY_BETWEEN_ACTIONS_MAX);
        const min = Number.isFinite(configuredMin) ? configuredMin : 1500;
        const max = Number.isFinite(configuredMax) ? configuredMax : 5000;
        const safeMin = Math.max(0, Math.min(min, max));
        const safeMax = Math.max(safeMin, Math.max(min, max));
        const delay = this.gaussianRandom((safeMin + safeMax) / 2, Math.max(1, (safeMax - safeMin) / 4));
        return Math.max(safeMin, Math.min(safeMax, delay));
    },

    interGroupDelay(config = CONFIG) {
        const configuredMin = Number(config?.DELAY_BETWEEN_GROUPS_MIN);
        const configuredMax = Number(config?.DELAY_BETWEEN_GROUPS_MAX);
        const min = Number.isFinite(configuredMin) ? configuredMin : 4000;
        const max = Number.isFinite(configuredMax) ? configuredMax : 15000;
        const safeMin = Math.max(0, Math.min(min, max));
        const safeMax = Math.max(safeMin, Math.max(min, max));
        const delay = this.gaussianRandom((safeMin + safeMax) / 2, Math.max(1, (safeMax - safeMin) / 4));
        return Math.max(safeMin, Math.min(safeMax, delay));
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
        (remaining, blockDurationText) =>
            `Désolé, je ne prends pas les appels. Envoyez-moi un message svp.\n⚠️ Attention : encore ${remaining} appel(s) et vous serez bloqué(e) pendant ${blockDurationText}.`,
        (remaining) =>
            `❌ Appels non acceptés. Écrivez-moi plutôt.\n🚫 ${remaining} tentative(s) restante(s) avant blocage temporaire.`,
        (remaining, blockDurationText) =>
            `📵 Je ne réponds pas aux appels. Écrivez-moi un message.\n⏳ Plus que ${remaining} tentative(s) avant un blocage de ${blockDurationText}.`,
        (remaining) =>
            `🔇 Appel refusé automatiquement. Contactez-moi par écrit.\n⚠️ ${remaining} essai(s) restant(s) avant blocage.`,
        (remaining) =>
            `❌ Les appels ne sont pas pris en charge ici.\n📩 Envoyez un message. ${remaining} appel(s) avant blocage temporaire.`,
        (remaining, blockDurationText) =>
            `🚫 Appel rejeté. Merci d'utiliser les messages.\n🔒 Encore ${remaining} appel(s) et votre contact sera bloqué pendant ${blockDurationText}.`,
        (remaining) =>
            `📞❌ Les appels sont désactivés. Préférez un message texte svp.\n⚠️ ${remaining} tentative(s) restante(s) avant suspension temporaire.`,
    ],

    callBlocked: [
        (blockDurationText) => `🔒 Vous avez été bloqué(e) pendant ${blockDurationText} suite à des appels répétés. Merci de patienter.`,
        (blockDurationText) => `⛔ Blocage temporaire de ${blockDurationText} pour spam d'appels. Envoyez un message après.`,
        (blockDurationText) => `🚫 Trop d'appels. Vous êtes bloqué(e) pour ${blockDurationText}.`,
        (blockDurationText) => `📵 Votre contact a été temporairement bloqué (${blockDurationText}) à cause d'appels répétés. Revenez plus tard.`,
        (blockDurationText) => `🔇 Blocage automatique activé pour ${blockDurationText}. Raison : appels en excès.`,
        (blockDurationText) => `⏳ Suite à vos appels répétés, vous êtes bloqué(e) pendant ${blockDurationText}. Envoyez un message ensuite.`,
        (blockDurationText) => `🚫 Appels excessifs détectés. Blocage temporaire de ${blockDurationText} en cours. Merci de patienter.`,
        (blockDurationText) => `⛔ Vous avez dépassé la limite d'appels autorisée. Contact bloqué pour ${blockDurationText}.`,
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

async function sendMessageHumanized(sock, chatId, text, options = {}, triggerMessageLength = 0, sessionData = null) {
    try {
        const immediate = options.immediate === true;
        const bypassRateLimit = immediate || options.bypassRateLimit === true;
        if (!bypassRateLimit) await rateLimiter.waitUntilAllowed();

        if (!immediate) {
            if (triggerMessageLength > 0) {
                const readDelay = HumanBehavior.readingDelay(triggerMessageLength);
                await HumanBehavior.naturalDelay(readDelay);
            }

            await HumanBehavior.naturalDelay(HumanBehavior.thinkingDelay());

            try {
                await sock.presenceSubscribe(normalizeJid(chatId)).catch(() => {});
                await sock.sendPresenceUpdate('composing', normalizeJid(chatId));
            } catch (e) {}

            const typingTime = HumanBehavior.typingDuration(typeof text === 'string' ? text.length : (options.caption?.length || 20));
            await HumanBehavior.naturalDelay(typingTime);

            try {
                await sock.sendPresenceUpdate('paused', normalizeJid(chatId));
            } catch (e) {}

            if (Math.random() < 0.3) {
                await HumanBehavior.naturalDelay(
                    HumanBehavior.gaussianRandom(800, 400)
                );
            }
        }

        const sent = await sendNativeMessage(sock, chatId, text, options);
        if (!bypassRateLimit) rateLimiter.recordAction();
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

async function deleteMessageHumanized(sock, message) {
    try {
        await rateLimiter.waitUntilAllowed();
        await HumanBehavior.naturalDelay(HumanBehavior.deletionDelay());

        const msgId = getMessageId(message);

        if (!sock || !sock.sendMessage) {
            addLog(`[X] deleteMessageHumanized: client Baileys indisponible pour ${msgId}`);
            return false;
        }

        try {
            await sock.sendMessage(getMessageChatId(message), { delete: message.key });
            rateLimiter.recordAction();
            addLog(`[OK] Demande de suppression envoyee via Baileys pour ${msgId}`);
            return true;
        } catch (e) {
            addLog(`[X] Suppression Baileys echouee pour ${msgId}: ${e.message}`);
            return false;
        }

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
    secretKey: '',
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
                    const phoneNumber = sessionInfo.phoneNumber || (session && session.client && (session.client.info?.phoneNumber || session.client.info?.wid?.user));
                    // Garde : session doit être prête (ready event émis + WWebJS injecté)
                    const isReady = session && session.client && session.client.isReady && session.data?.status === 'connected' && session.client.info;
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
                            await sendNativeMessage(session.client, botNumber, message);
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
        if (!session.client.isReady || !session.client.info || session.data?.status !== 'connected') {
            skipped++; continue;
        }

        const phoneNumber = sessionInfo.phoneNumber || session.client.info?.phoneNumber || session.client.info?.wid?.user;
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
                await sendNativeMessage(session.client, botNumber, message);
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
                await sendNativeMessage(session.client, botNumber, message);
                subWarningState[sessionId] = 2;
                warned++;
                addLog(`[SUB] Avertissement final envoyé à ${owner} (étape 2/3)`);
            } catch (e) { errors++; addLog(`[SUB] Erreur avertissement ${owner}: ${e.message}`); }
            
        } else if (state === 2) {
            // Étape 3: Déconnexion (5 min après l'avertissement)
            try {
                await sendNativeMessage(session.client, botNumber, `❌ *Session déconnectée — PayOol™ Bot*\n\nVotre session a été déconnectée car votre abonnement n'a pas été renouvelé.\n\n` +
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
            const chat = await getChatInfo(sessionClient, groupId, true);
            
            if (!chat || !chat.isGroup) {
                failedGroups.push({ id: groupId, reason: 'Groupe non trouvé' });
                continue;
            }
            
            // Vérifier que le bot est admin dans ce groupe
            const botParticipant = findBotParticipant(sessionClient, chat.participants || []);
            if (!botParticipant?.isAdmin) {
                failedGroups.push({ id: groupId, reason: 'Bot non admin' });
                continue;
            }
            
            // Délai humanisé entre les groupes
            if (publishedGroups.length > 0) {
                const interGroupDelay = HumanBehavior.interGroupDelay(sessionData?.config || CONFIG);
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
                    const media = makeMediaPayload(mimetype, base64Data, 'announcement.jpg');
                    const mediaOptions = { caption: content };
                    if (!linkPreview) mediaOptions.linkPreview = false;
                    if (announcement.sendAsHd) mediaOptions.sendMediaAsHd = true;
                    await sendMessageHumanized(sessionClient, chat.jid, media, mediaOptions, 0, sessionData);
                } catch (imgErr) {
                    // Fallback: envoyer le texte seul si l'image échoue
                    if (sessionData) sessionData.addLog(`[ANNONCE] Erreur image pour ${chat.name}: ${imgErr.message}, envoi texte seul`);
                    else addLog(`[ANNONCE] Erreur image pour ${chat.name}: ${imgErr.message}, envoi texte seul`);
                    const options = {};
                    if (!linkPreview) options.linkPreview = false;
                    await sendMessageHumanized(sessionClient, chat.jid, content, options, 0, sessionData);
                }
            } else {
                const options = {};
                if (!linkPreview) {
                    options.linkPreview = false;
                }
                await sendMessageHumanized(sessionClient, chat.jid, content, options, 0, sessionData);
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

const MENU_SESSION_TTL_MS = 60 * 60 * 1000;

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
        if (this.groupExceptions.excludedGroups.includes(chat.jid)) return true;
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
        const userException = findUserException(this.userExceptions.excludedUsers, [userId], 'link');
        if (userException) return true;

        if (this.userExceptions.excludedAdmins) {
            const p = participants.find(part => participantMatches(part, userId));
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
                cleanupMenuSessions(this.menuSessions);
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

// Fichiers globaux historiques pour la session par defaut
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
const MENU_TRIGGER_MODES = new Set(['exact', 'contains']);

function loadMenus() {
    try {
        if (fs.existsSync(MENUS_FILE)) {
            interactiveMenus = JSON.parse(fs.readFileSync(MENUS_FILE, 'utf8'));
        }
        if (fs.existsSync(MENU_SESSIONS_FILE)) {
            menuSessions = JSON.parse(fs.readFileSync(MENU_SESSIONS_FILE, 'utf8'));
            cleanupMenuSessions(menuSessions);
        }
    } catch (error) {
        console.error('Erreur chargement menus:', error);
    }
}

function normalizeMenuText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2018\u2019\u201A\u201B\u0060\u00B4]/g, "'")
        .replace(/&/g, ' et ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitMenuTriggers(trigger) {
    return String(trigger || '')
        .split(/[,;\n|]+/)
        .map(t => t.trim())
        .filter(Boolean);
}

function normalizeMenuTriggerMode(value) {
    return MENU_TRIGGER_MODES.has(value) ? value : 'exact';
}

function normalizeMenuTriggerString(trigger) {
    const unique = [];
    const seen = new Set();
    for (const raw of splitMenuTriggers(trigger)) {
        const normalized = normalizeMenuText(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(raw.trim());
    }
    return unique.join(', ');
}

function normalizeMenuItems(items = [], kind = 'button') {
    return (items || [])
        .map((item, index) => ({
            ...item,
            id: String(item.id || `${kind}_${index}`),
            text: item.text !== undefined ? String(item.text).trim() : item.text,
            title: item.title !== undefined ? String(item.title).trim() : item.title,
            response: item.response !== undefined ? String(item.response) : item.response,
            nextMenu: item.nextMenu ? String(item.nextMenu).trim() : null
        }))
        .filter(item => (item.text || item.title));
}

function normalizeMenuSections(sections = []) {
    return (sections || [])
        .map((section, sectionIndex) => ({
            ...section,
            title: String(section.title || `Section ${sectionIndex + 1}`).trim(),
            rows: normalizeMenuItems(section.rows || [], `row_${sectionIndex}`)
        }))
        .filter(section => section.rows.length > 0);
}

function normalizeMenuConfig(config = {}, previous = {}) {
    const type = config.type === 'list' ? 'list' : 'buttons';
    const trigger = normalizeMenuTriggerString(config.trigger ?? previous.trigger);
    return {
        ...previous,
        ...config,
        id: String(config.id || previous.id || `menu_${Date.now()}`),
        title: String(config.title || previous.title || 'Menu').trim(),
        description: String(config.description ?? previous.description ?? ''),
        trigger: trigger || null,
        triggerMode: normalizeMenuTriggerMode(config.triggerMode || previous.triggerMode),
        type,
        buttons: normalizeMenuItems(config.buttons || previous.buttons || [], 'btn').slice(0, 10),
        listSections: normalizeMenuSections(config.listSections || previous.listSections || []),
        image: config.image !== undefined ? config.image : (previous.image || null),
        groupId: config.groupId || previous.groupId || null,
        enabled: config.enabled !== false
    };
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
    menus[menuId] = normalizeMenuConfig({ ...config, id: menuId });
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

function getClientForSessionData(sessionData = null) {
    if (sessionData?.sessionId) {
        const managedSession = sessionManager.sessions.get(sessionData.sessionId);
        if (managedSession?.client) return managedSession.client;
    }
    return sessionManager.getActiveClient() || client;
}

async function canUseInteractiveMenusInChat(chat, sessionData = null) {
    if (!chat) return false;
    if (!chat.isGroup) return true;

    const sessionClient = getClientForSessionData(sessionData);
    const botWid = sessionClient?.info?.wid;
    if (!botWid) return false;

    let participants = chat.participants || [];
    if ((!participants || participants.length === 0) && chat?.jid) {
        try {
            const freshChat = await getChatInfo(sessionClient, chat.jid, true);
            participants = freshChat?.participants || [];
        } catch (e) {}
    }

    const botParticipant = findBotParticipant(sessionClient, participants);

    return !!(botParticipant?.isAdmin || botParticipant?.isSuperAdmin);
}

function cleanupMenuSessions(sessions = {}) {
    const now = Date.now();
    let changed = false;
    for (const sessionId of Object.keys(sessions)) {
        const session = sessions[sessionId];
        if (!session?.expiresAt || session.expiresAt < now) {
            delete sessions[sessionId];
            changed = true;
        }
    }
    return changed;
}

function makeMenuSessionKey(chatId, userId = null) {
    return `${normalizeJid(chatId)}::${userId ? normalizeJid(userId) : 'all'}`;
}

function storeMenuSession(sessions, chat, userId, menuId, sessionItems) {
    const key = makeMenuSessionKey(chat.jid, userId);
    sessions[key] = {
        key,
        chatId: chat.jid,
        userId: userId ? normalizeJid(userId) : null,
        menuId,
        buttons: sessionItems.buttons || null,
        rows: sessionItems.rows || null,
        createdAt: Date.now(),
        expiresAt: Date.now() + MENU_SESSION_TTL_MS
    };
    return sessions[key];
}

function getActiveMenuSession(sessions, chatId, userId) {
    cleanupMenuSessions(sessions);
    const normalizedChatId = normalizeJid(chatId);
    const normalizedUserId = userId ? normalizeJid(userId) : null;
    const exact = sessions[makeMenuSessionKey(normalizedChatId, normalizedUserId)];
    if (exact) return exact;
    const shared = sessions[makeMenuSessionKey(normalizedChatId, null)];
    if (shared) return shared;
    return Object.values(sessions)
        .filter(session => session.chatId === normalizedChatId && (!session.userId || !normalizedUserId || valuesMatchUser(session.userId, normalizedUserId)))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

function getMenuItemLabel(item = {}) {
    return item.text || item.title || '';
}

function getMenuItemResponse(item = {}) {
    return item.response || null;
}

function getMenuSessionItems(session) {
    if (!session) return [];
    return session.buttons || session.rows || [];
}

function findMenuSessionSelection(session, messageText) {
    const items = getMenuSessionItems(session);
    if (!items.length) return null;

    const trimmed = String(messageText || '').trim();
    if (/^\d+$/.test(trimmed)) {
        const index = parseInt(trimmed, 10) - 1;
        if (index >= 0 && index < items.length) return { item: items[index], index, method: 'number' };
        return { invalidNumber: true, itemsCount: items.length };
    }

    const normalizedInput = normalizeMenuText(trimmed);
    if (!normalizedInput) return null;

    const matches = items
        .map((item, index) => ({ item, index, label: normalizeMenuText(getMenuItemLabel(item)) }))
        .filter(candidate => candidate.label && candidate.label === normalizedInput);

    if (!matches.length) return null;
    return { item: matches[0].item, index: matches[0].index, method: 'label' };
}

function normalizedTextContainsPhrase(messageNorm, triggerNorm) {
    if (!messageNorm || !triggerNorm) return false;
    return ` ${messageNorm} `.includes(` ${triggerNorm} `);
}

function menuMatchesMessage(menu, chat, messageText) {
    if (!menu?.enabled || !menu.trigger) return null;
    if (menu.groupId && chat.jid !== menu.groupId) return null;

    const messageNorm = normalizeMenuText(messageText);
    if (!messageNorm) return null;

    const mode = normalizeMenuTriggerMode(menu.triggerMode);
    const triggers = splitMenuTriggers(menu.trigger)
        .map(raw => ({ raw, normalized: normalizeMenuText(raw) }))
        .filter(trigger => trigger.normalized);

    for (const trigger of triggers) {
        const matched = mode === 'contains'
            ? normalizedTextContainsPhrase(messageNorm, trigger.normalized)
            : messageNorm === trigger.normalized;
        if (!matched) continue;
        return {
            menu,
            rawTrigger: trigger.raw,
            normalizedTrigger: trigger.normalized,
            mode,
            score: (mode === 'exact' ? 100000 : 50000) + trigger.normalized.length
        };
    }

    return null;
}

function findTriggeredMenu(menus, chat, messageText) {
    return Object.values(menus || {})
        .map(menu => menuMatchesMessage(menu, chat, messageText))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || String(a.menu.id).localeCompare(String(b.menu.id)))[0] || null;
}

async function runMenuItem(sock, chat, senderId, selectedItem, sourceMenu, sessionData, message, messageLength = 0) {
    const quoteOpts = makeReplyOptions(message);
    if (selectedItem.action) {
        return await executeMenuAction(sock, chat, senderId, selectedItem.action, sourceMenu, sessionData, message);
    }
    if (selectedItem.nextMenu) {
        return await sendInteractiveMenu(sock, chat, selectedItem.nextMenu, sessionData, message);
    }
    const response = getMenuItemResponse(selectedItem);
    if (response) {
        return await sendMessageHumanized(sock, chat.jid, response, quoteOpts, messageLength, sessionData);
    }
    return await sendMessageHumanized(sock, chat.jid, '[OK] Vous avez selectionne: ' + getMenuItemLabel(selectedItem), quoteOpts, messageLength, sessionData);
}

async function sendInteractiveMenu(sock, chat, menuId, sessionData = null, quotedMsg = null) {
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
    const sessions = sessionData ? sessionData.menuSessions : menuSessions;
    const menu = menus[menuId];
    if (!menu || !menu.enabled) return null;

    try {
        if (!(await canUseInteractiveMenusInChat(chat, sessionData))) {
            const logMessage = `[MENU] Envoi bloque: bot non admin dans ${chat?.name || chat?.jid || 'chat inconnu'}`;
            if (sessionData) sessionData.addLog(logMessage);
            else addLog(logMessage);
            return null;
        }

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
            cleanupMenuSessions(sessions);
            const targetUserId = quotedMsg ? getMessageSender(quotedMsg) : null;
            storeMenuSession(sessions, chat, targetUserId, menuId, sessionItems);
            if (sessionData) sessionData.saveMenus(); else saveMenus();
        }

        const sendOpts = quotedMsg ? makeReplyOptions(quotedMsg) : {};

        if (menu.image) {
            const base64Data = menu.image.replace(/^data:image\/\w+;base64,/, '');
            const mimeMatch = menu.image.match(/^data:(image\/\w+);base64,/);
            const mimetype = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            const media = makeMediaPayload(mimetype, base64Data, 'menu.jpg');
            const sent = await sendMessageHumanized(sock, chat.jid, media, { caption: menuText, ...sendOpts }, 0, sessionData);
            return sent;
        } else {
            const sent = await sendMessageHumanized(sock, chat.jid, menuText, sendOpts, 0, sessionData);
            return sent;
        }
    } catch (error) {
        addLog(`[X] Erreur envoi menu ${menuId}: ${error.message}`);
        console.error('Erreur menu:', error);
        return null;
    }
}

async function handleMenuResponse(sock, message, responseId, sessionData = null) {
    const chat = await getChatInfo(sock, getMessageChatId(message));
    const senderId = getMessageSender(message);
    const menus = sessionData ? sessionData.interactiveMenus : interactiveMenus;

    if (!(await canUseInteractiveMenusInChat(chat, sessionData))) return null;

    const sessions = sessionData ? sessionData.menuSessions : menuSessions;
    const activeSession = getActiveMenuSession(sessions, chat.jid, senderId);
    if (activeSession) {
        const sourceMenu = menus[activeSession.menuId] || {};
        const selectedItem = getMenuSessionItems(activeSession).find(item => item.id === responseId);
        if (selectedItem) {
            return await runMenuItem(sock, chat, senderId, selectedItem, sourceMenu, sessionData, message, getMessageBody(message)?.length || 0);
        }
    }

    for (const menuId in menus) {
        const menu = menus[menuId];
        if (!menu.enabled) continue;

        if (menu.groupId && chat.jid !== menu.groupId) continue;

        if (menu.type === 'buttons') {
            const button = menu.buttons.find(b => b.id === responseId);
            if (button) {
                return await runMenuItem(sock, chat, senderId, button, menu, sessionData, message, getMessageBody(message)?.length || 0);
            }
        }

        if (menu.type === 'list') {
            for (const section of menu.listSections) {
                const row = section.rows.find(r => r.id === responseId);
                if (row) {
                    return await runMenuItem(sock, chat, senderId, row, menu, sessionData, message, getMessageBody(message)?.length || 0);
                }
            }
        }
    }

    return null;
}

async function executeMenuAction(sock, chat, userId, action, menu, sessionData = null, quotedMsg = null) {
    const quoteOpts = quotedMsg ? makeReplyOptions(quotedMsg) : {};
    switch (action.type) {
        case 'message':
            return await sendMessageHumanized(sock, chat.jid, action.content, quoteOpts, 0, sessionData);

        case 'link':
            if (action.whitelist) {
                addLog(`[OK] Lien autorise via menu: ${action.whitelist}`);
                return await sendMessageHumanized(sock, chat.jid,
                    `✅ Voici le lien autorisé: ${action.whitelist}`, quoteOpts, 0, sessionData);
            }
            break;

        case 'contact':
            if (action.contactId) {
                try {
                    const contact = await getContactInfo(sock, action.contactId);
                    return await sendMessageHumanized(sock, chat.jid,
                        `👤 Contact demandé: @${contact.number}`,
                        { mentions: [contact.jid], ...quoteOpts }, 0, sessionData);
                } catch (e) {
                    return await sendMessageHumanized(sock, chat.jid, '❌ Contact non disponible', quoteOpts, 0, sessionData);
                }
            }
            break;

        case 'submenu':
            const subMenus = sessionData ? sessionData.interactiveMenus : interactiveMenus;
            if (action.menuId && subMenus[action.menuId]) {
                return await sendInteractiveMenu(sock, chat, action.menuId, sessionData, quotedMsg);
            }
            break;
        case 'external':
            if (action.webhook) {
                try {
                    await fetch(action.webhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId,
                            chatId: chat.jid,
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

function scheduleSessionUnblock(sessionId, userId, delay) {
    const sessionData = getSessionData(sessionId);
    if (sessionData.unblockTimers[userId]) clearTimeout(sessionData.unblockTimers[userId]);

    sessionData.unblockTimers[userId] = setTimeout(async () => {
        if (sessionData.blockedUsers[userId] && sessionData.blockedUsers[userId].autoUnblock) {
            try {
                const activeClient = sessionManager.sessions.get(sessionId)?.client;
                if (!activeClient) throw new Error('Client non disponible');

                await HumanBehavior.naturalDelay(
                    HumanBehavior.gaussianRandom(3000, 1500)
                );

                await activeClient.updateBlockStatus(normalizeJid(userId), 'unblock');
                ensureRuntime(activeClient).blocklist.delete(normalizeJid(userId));
                delete sessionData.blockedUsers[userId];
                delete sessionData.callSpamTracker[userId];
                delete sessionData.unblockTimers[userId];
                sessionData.saveCallSpamData();
                sessionData.addLog(`[UNBLOCK] ${userId} debloque automatiquement`);
            } catch (error) {
                sessionData.addLog(`[X] Erreur deblocage auto ${userId}: ${error.message}`);
            }
        }
    }, delay);
}

function restoreUnblockTimers(sessionId = null) {
    if (sessionId) {
        const sessionData = getSessionData(sessionId);
        const now = Date.now();
        for (const userId in sessionData.blockedUsers) {
            const entry = sessionData.blockedUsers[userId];
            if (!entry.autoUnblock) continue;

            const elapsed = now - entry.blockedAt;
            const blockDuration = getCallBlockDurationMin(sessionData.config) * 60 * 1000;
            const remaining = blockDuration - elapsed;
            scheduleSessionUnblock(sessionId, userId, remaining <= 0 ? 5000 : remaining);
        }
        return;
    }

    const now = Date.now();
    for (const userId in blockedUsers) {
        const entry = blockedUsers[userId];
        if (!entry.autoUnblock) continue;

        const elapsed = now - entry.blockedAt;
        const blockDuration = getCallBlockDurationMin(CONFIG) * 60 * 1000;
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
                const activeClient = sessionManager.getActiveClient() || client;
                if (!activeClient) throw new Error('Client non disponible');

                await HumanBehavior.naturalDelay(
                    HumanBehavior.gaussianRandom(3000, 1500)
                );

                await activeClient.updateBlockStatus(normalizeJid(userId), 'unblock');
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
    if (GROUP_EXCEPTIONS.excludedGroups.includes(chat.jid)) return true;
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
    const userException = findUserException(USER_EXCEPTIONS.excludedUsers, [userId], 'link');
    if (userException) return true;

    if (USER_EXCEPTIONS.excludedAdmins) {
        const p = participants.find(part => participantMatches(part, userId));
        if (p && (p.isAdmin || p.isSuperAdmin)) return true;
    }
    return false;
}

function isUserExcludedFromCalls(userId, phoneNumber = null) {
    return !!findUserException(USER_EXCEPTIONS.excludedUsers, [userId, phoneNumber], 'call');
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
    const text = typeof message === 'string' ? message : getMessageBody(message);
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

const authPath = path.join(__dirname, '.baileys_auth');
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
        this.startPromises = new Map();
        this.reconnectTimers = new Map();
        this.initialScanTimers = new Map();
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

    cleanupOrphanSessions() {
        const orphanSessions = [];
        for (const [sessionId, session] of Object.entries(this.sessionsList)) {
            const owner = session.ownerUsername;
            if (owner && !authManager.users[owner]) orphanSessions.push(sessionId);
        }

        for (const sessionId of orphanSessions) {
            addLog('[CLEANUP] Session orpheline supprimee: ' + sessionId);
            this.deleteSession(sessionId).catch(e => addLog('[CLEANUP] Erreur suppression ' + sessionId + ': ' + e.message));
        }
        return orphanSessions.length;
    }

    async createSession(sessionId = null, name = 'Default', ownerUsername = null) {
        const id = sessionId || this.generateSessionId();
        const authPath = path.join(__dirname, '.baileys_auth', id);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const sessionData = {
            id,
            name,
            authPath,
            createdAt: Date.now(),
            status: 'pending',
            phoneNumber: null,
            pushName: null,
            ownerUsername
        };

        this.sessionsList[id] = sessionData;
        this.saveSessionsList();

        const client = await this.initClient(id);
        this.sessions.set(id, { client, data: sessionData, socketGeneration: client?._socketGeneration });
        return sessionData;
    }

    canUserStartSession(username) {
        const user = authManager.users[username];
        if (!user) return { allowed: false, reason: 'Utilisateur non trouve' };
        if (subscriptionSettings.enabled && !user.isAdmin && !isSubscriptionActive(username)) {
            return { allowed: false, reason: 'SUBSCRIPTION_REQUIRED', requireSubscription: true };
        }
        return { allowed: true, user };
    }

    getUserSessions(username) {
        return Object.values(this.sessionsList).filter(s => s.ownerUsername === username);
    }

    cleanupUserSessions(username) {
        const sessionsToRemove = [];
        for (const [id, session] of Object.entries(this.sessionsList)) {
            if (session.ownerUsername === username) sessionsToRemove.push(id);
        }
        for (const id of sessionsToRemove) {
            this.deleteSession(id).catch(e => addLog('[SESSION] Erreur suppression ' + id + ': ' + e.message));
            addLog('[SESSION] Session ' + id + ' supprimee (utilisateur ' + username + ' supprime)');
        }
        return sessionsToRemove.length;
    }

    clearReconnectTimer(sessionId) {
        const timer = this.reconnectTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.reconnectTimers.delete(sessionId);
    }

    clearInitialScanTimer(sessionId) {
        const timer = this.initialScanTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.initialScanTimers.delete(sessionId);
    }

    scheduleReconnect(sessionId, reason, delayMs = 10000) {
        if (this.reconnectTimers.has(sessionId)) return;
        addLog('[RECONNECT] [' + sessionId + '] Reconnexion auto dans ' + Math.round(delayMs / 1000) + 's...');
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(sessionId);
            this.startSession(sessionId).catch(e => addLog('[RECONNECT] [' + sessionId + '] Erreur: ' + e.message));
        }, delayMs);
        timer.unref?.();
        this.reconnectTimers.set(sessionId, timer);
    }

    isCurrentSocket(sessionId, sock) {
        const session = this.sessions.get(sessionId);
        if (!session) return true;
        if (session.client === sock) return true;
        return !!sock?._socketGeneration && session.socketGeneration === sock._socketGeneration;
    }

    async initClient(sessionId, socketGeneration = null) {
        const sessionData = this.sessionsList[sessionId];
        if (!sessionData) return null;

        const authPath = path.join(__dirname, '.baileys_auth', sessionId);
        if (sessionData.authPath !== authPath) {
            sessionData.authPath = authPath;
            this.saveSessionsList();
        }
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const baileys = await loadBaileys();
        const { state, saveCreds } = await baileys.useMultiFileAuthState(authPath);
        const makeWASocket = baileys.default || baileys.makeWASocket;
        let sock;
        sock = makeWASocket({
            auth: state,
            logger: makeBaileysLogger(),
            browser: baileys.Browsers?.ubuntu?.('PayOol Bot') || undefined,
            markOnlineOnConnect: false,
            syncFullHistory: true,
            getMessage: async (key) => getCachedMessage(sock, key.id)?.message || undefined,
            cachedGroupMetadata: async (jid) => ensureRuntime(sock).chats.get(jid)?._raw || undefined
        });

        sock.sessionId = sessionId;
        sock.info = null;
        sock.isReady = false;
        sock._destroyed = false;
        sock._socketGeneration = socketGeneration || ('sock_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'));
        ensureRuntime(sock);
        loadPersistentMessageCache(sock, sessionId);
        this.setupClientEvents(sock, sessionId, {
            saveCreds,
            DisconnectReason: baileys.DisconnectReason,
            jidNormalizedUser: baileys.jidNormalizedUser
        });
        return sock;
    }

    setupClientEvents(sock, sessionId, deps) {
        let qrTimeout = null;
        const QR_TIMEOUT_MS = 5 * 60 * 1000;
        const { saveCreds, DisconnectReason, jidNormalizedUser } = deps;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = this.sessions.get(sessionId);
            if (!this.isCurrentSocket(sessionId, sock)) return;

            if (qr) {
                if (session) {
                    session.data.currentQR = qr;
                    session.data.status = 'qr';
                    this.sessionsList[sessionId].status = 'qr';
                    this.saveSessionsList();
                }
                addLog('[' + sessionId + '] QR code genere');
                console.log('\n[' + sessionId + '] Scannez ce QR code avec WhatsApp:\n');
                qrcode.generate(qr, { small: true });
                if (!qrTimeout) {
                    qrTimeout = setTimeout(async () => {
                        const sess = this.sessions.get(sessionId);
                        if (sess && sess.data.status !== 'connected') {
                            addLog('[TIMEOUT] [' + sessionId + '] QR non scanne apres 5 min - suppression automatique');
                            await this.deleteSession(sessionId);
                        }
                    }, QR_TIMEOUT_MS);
                }
            }

            if (connection === 'open') {
                this.clearReconnectTimer(sessionId);
                if (qrTimeout) { clearTimeout(qrTimeout); qrTimeout = null; }
                const me = sock.user || sock.authState?.creds?.me || {};
                const ownJid = jidNormalizedUser ? jidNormalizedUser(me.lid || me.id) : normalizeJid(me.lid || me.id);
                const phoneJid = me.phoneNumber || (me.id ? (jidNormalizedUser ? jidNormalizedUser(me.id) : normalizeJid(me.id)) : ownJid);
                sock.info = {
                    wid: jidObject(ownJid),
                    lid: me.lid || (ownJid?.endsWith('@lid') ? ownJid : null),
                    phoneNumber: phoneJid ? jidNumber(phoneJid) : jidNumber(ownJid),
                    pushname: me.name || me.notify || me.verifiedName || null
                };
                sock.isReady = true;
                sock._destroyed = false;

                if (session) {
                    session.data.status = 'connected';
                    session.data.currentQR = null;
                    session.data.phoneNumber = sock.info.phoneNumber || sock.info.wid.user || null;
                    session.data.pushName = sock.info.pushname || null;
                    this.sessionsList[sessionId].status = 'connected';
                    this.sessionsList[sessionId].phoneNumber = session.data.phoneNumber;
                    this.sessionsList[sessionId].pushName = session.data.pushName;

                    const ownerOfActive = this.activeSessionId ? this.sessionsList[this.activeSessionId]?.ownerUsername : null;
                    const ownerOfThis = this.sessionsList[sessionId]?.ownerUsername;
                    if (!this.activeSessionId || (ownerOfThis && ownerOfActive !== ownerOfThis && ownerOfActive === null)) {
                        this.activeSessionId = sessionId;
                        addLog('[TARGET] Session active: ' + sessionId);
                    }
                    this.saveSessionsList();
                }

                await getAllChats(sock).catch(() => {});
                await sock.fetchBlocklist?.().then(list => {
                    ensureRuntime(sock).blocklist = new Set((list || []).filter(Boolean).map(normalizeJid));
                }).catch(() => {});
                if (!this.isCurrentSocket(sessionId, sock) || sock._destroyed) return;

                addLog('[OK] [' + sessionId + '] Bot connecte et pret!');
                restoreUnblockTimers(sessionId);
                startPresenceManager(sessionId);
                const sessionData = getSessionData(sessionId);
                this.clearInitialScanTimer(sessionId);
                if (sessionData.config.AUTO_SCAN_ENABLED) {
                    const startupDelay = HumanBehavior.gaussianRandom(45000, 15000);
                    addLog('[TIMER] [' + sessionId + '] Premier scan dans ' + Math.round(startupDelay / 1000) + 's...');
                    const scheduledFor = sock;
                    const initialTimer = setTimeout(async () => {
                        this.initialScanTimers.delete(sessionId);
                        const currentSession = this.sessions.get(sessionId);
                        if (!currentSession || currentSession.client !== scheduledFor || currentSession.data.status !== 'connected') {
                            addLog('[TIMER] [' + sessionId + '] Scan initial annule (session redemarree)');
                            return;
                        }
                        try { await scanAllGroups(sessionId); }
                        catch (scanError) { addLog('[X] [' + sessionId + '] Erreur scan initial: ' + scanError.message); }
                        scheduleNextScan(sessionId);
                    }, startupDelay);
                    initialTimer.unref?.();
                    this.initialScanTimers.set(sessionId, initialTimer);
                } else {
                    scheduleNextScan(sessionId);
                }
            }

            if (connection === 'close') {
                this.clearInitialScanTimer(sessionId);
                if (qrTimeout) { clearTimeout(qrTimeout); qrTimeout = null; }
                sock.isReady = false;
                sock._destroyed = true;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const restartRequired = statusCode === DisconnectReason?.restartRequired
                    || String(lastDisconnect?.error?.message || '').toLowerCase().includes('restart required');
                const reason = statusCode === DisconnectReason?.loggedOut ? 'LOGOUT' : (lastDisconnect?.error?.message || String(statusCode || 'close'));
                if (session) {
                    session.data.status = statusCode === DisconnectReason?.loggedOut
                        ? 'auth_failure'
                        : (restartRequired ? 'pending' : 'disconnected');
                    this.sessionsList[sessionId].status = session.data.status;
                    this.saveSessionsList();
                }
                if (restartRequired) addLog('[RESTART] [' + sessionId + '] Redemarrage Baileys requis apres appairage');
                else addLog('[DECO] [' + sessionId + '] Deconnecte: ' + reason);
                if (statusCode !== DisconnectReason?.loggedOut) {
                    this.scheduleReconnect(sessionId, reason, restartRequired ? 1000 : 10000);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ type, messages }) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            for (const message of messages || []) {
                cacheMessage(sock, message);
                cacheMessageContactInfo(sock, message);
                const isOwnBotCommand = isMessageFromMe(message) && !!getBotCommand(message);
                if (type === 'notify' || isOwnBotCommand) {
                    try { await handleMessage(sock, message, sessionId); }
                    catch (e) { addLog('[X] [' + sessionId + '] Erreur message: ' + e.message); }
                }
            }
        });

        sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            const rt = ensureRuntime(sock);
            for (const chat of chats || []) rt.chats.set(chat.id, hydrateChat(chat.id, chat));
            for (const contact of contacts || []) cacheContactInfo(sock, contact);
            for (const mapping of lidPnMappings || []) cacheLidPnMapping(sock, mapping.lid, mapping.pn);
            let cachedMessages = 0;
            for (const message of messages || []) {
                cacheMessage(sock, message, { persist: false });
                cacheMessageContactInfo(sock, message);
                cachedMessages++;
            }
            if (cachedMessages) schedulePersistentMessageCacheSave(sock);
        });

        sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            cacheLidPnMapping(sock, lid, pn);
        });

        sock.ev.on('chats.upsert', chats => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            const rt = ensureRuntime(sock);
            for (const chat of chats || []) rt.chats.set(chat.id, hydrateChat(chat.id, chat));
        });
        sock.ev.on('chats.update', chats => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            const rt = ensureRuntime(sock);
            for (const chat of chats || []) rt.chats.set(chat.id, hydrateChat(chat.id, { ...(rt.chats.get(chat.id)?._raw || {}), ...chat }));
        });
        sock.ev.on('contacts.upsert', contacts => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            for (const contact of contacts || []) cacheContactInfo(sock, contact);
        });
        sock.ev.on('contacts.update', contacts => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            for (const contact of contacts || []) cacheContactInfo(sock, contact);
        });
        sock.ev.on('groups.upsert', groups => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            const rt = ensureRuntime(sock);
            for (const group of groups || []) rt.chats.set(group.id, hydrateChat(group.id, group));
        });
        sock.ev.on('groups.update', groups => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            const rt = ensureRuntime(sock);
            for (const group of groups || []) rt.chats.set(group.id, hydrateChat(group.id, { ...(rt.chats.get(group.id)?._raw || {}), ...group }));
        });
        sock.ev.on('group-participants.update', async (event) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            if (!event?.id) return;
            getCachedChatInfo(sock, event.id);
            if (event.action === 'add') {
                for (const participant of event.participants || []) {
                    await handleGroupJoin(sock, { chatId: event.id, participant }, sessionId);
                }
            }
        });
        sock.ev.on('blocklist.set', ({ blocklist }) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            ensureRuntime(sock).blocklist = new Set((blocklist || []).filter(Boolean).map(normalizeJid));
        });
        sock.ev.on('blocklist.update', async ({ blocklist, type }) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            const rt = ensureRuntime(sock);
            const sessionData = getSessionData(sessionId);
            for (const jid of blocklist || []) {
                const normalizedJid = normalizeJid(jid);
                if (type === 'add') rt.blocklist.add(normalizedJid);
                if (type === 'remove') {
                    rt.blocklist.delete(normalizedJid);
                    const aliases = await resolveUserAliases(sock, normalizedJid).catch(() => []);
                    const cleared = clearSessionCallStateForValues(sessionData, buildUserMatchValues(normalizedJid, aliases));
                    if (cleared) sessionData.addLog('[UNBLOCK] ' + normalizedJid + ' debloque dans WhatsApp, etat appels nettoye (' + cleared + ')');
                }
            }
        });
        sock.ev.on('call', async (calls) => {
            if (!this.isCurrentSocket(sessionId, sock)) return;
            for (const call of calls || []) {
                const status = call.status || call.tag;
                if (!status || ['offer', 'ringing', 'call'].includes(status)) {
                    await handleCall(sock, call, sessionId);
                }
            }
        });
    }

    async startSession(sessionId) {
        if (this.startPromises.has(sessionId)) return this.startPromises.get(sessionId);

        const startPromise = (async () => {
        let session = this.sessions.get(sessionId);
        if (!session && this.sessionsList[sessionId]) {
            const client = await this.initClient(sessionId);
            if (!client) return false;
            this.sessions.set(sessionId, { client, data: { ...this.sessionsList[sessionId] }, socketGeneration: client._socketGeneration });
            session = this.sessions.get(sessionId);
        }
        if (!session) return false;
        if (session.client && !session.client._destroyed && (session.client.isReady || session.data.status === 'pending' || session.data.status === 'qr')) {
            return true;
        }
        if (!session.client || session.client._destroyed) {
            addLog('[START] [' + sessionId + '] Creation du socket Baileys');
            const socketGeneration = 'sock_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
            session.socketGeneration = socketGeneration;
            const newClient = await this.initClient(sessionId, socketGeneration);
            if (!newClient) return false;
            session.client = newClient;
            session.socketGeneration = newClient._socketGeneration;
        }
        session.data.status = 'pending';
        if (this.sessionsList[sessionId]) {
            this.sessionsList[sessionId].status = 'pending';
            this.saveSessionsList();
        }
        addLog('[START] [' + sessionId + '] Session demarree');
        return true;
        })();

        this.startPromises.set(sessionId, startPromise);
        try {
            return await startPromise;
        } finally {
            this.startPromises.delete(sessionId);
        }
    }

    async stopSession(sessionId) {
        this.clearReconnectTimer(sessionId);
        this.clearInitialScanTimer(sessionId);
        const session = this.sessions.get(sessionId);
        if (session && session.client) {
            try {
                session.client._destroyed = true;
                session.client.isReady = false;
                await session.client.end?.(undefined);
                session.client.ev?.removeAllListeners?.();
                session.data.status = 'stopped';
                if (this.sessionsList[sessionId]) this.sessionsList[sessionId].status = 'stopped';
                this.saveSessionsList();
                addLog('[STOP] [' + sessionId + '] Session arretee');
                return true;
            } catch (e) {
                addLog('[X] [' + sessionId + '] Erreur arret: ' + e.message);
                return false;
            }
        }
        return false;
    }

    async deleteSession(sessionId) {
        await this.stopSession(sessionId);
        for (const authPath of [path.join(__dirname, '.baileys_auth', sessionId), path.join(__dirname, '.wwebjs_auth', sessionId)]) {
            try { if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true }); }
            catch (e) { addLog('[!] [' + sessionId + '] Erreur suppression dossier auth: ' + e.message); }
        }
        const sessionDataPath = path.join(DATA_DIR, 'sessions', sessionId);
        try { if (fs.existsSync(sessionDataPath)) fs.rmSync(sessionDataPath, { recursive: true, force: true }); }
        catch (e) { addLog('[!] [' + sessionId + '] Erreur suppression dossier data: ' + e.message); }
        sessionDataManagers.delete(sessionId);
        this.sessions.delete(sessionId);
        delete this.sessionsList[sessionId];
        if (this.activeSessionId === sessionId) this.activeSessionId = null;
        this.saveSessionsList();
        addLog('[SUPPR] [' + sessionId + '] Session supprimee');
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
        const userSessions = Object.values(this.sessionsList).filter(s => s.ownerUsername === username);
        return userSessions.find(s => s.status === 'connected')?.id || userSessions[0]?.id || null;
    }

    setActiveSession(sessionId) {
        if (this.sessionsList[sessionId]) {
            this.activeSessionId = sessionId;
            this.saveSessionsList();
            addLog('[TARGET] Session active: ' + sessionId);
            return true;
        }
        return false;
    }

    getActiveClient() {
        if (!this.activeSessionId) return null;
        return this.sessions.get(this.activeSessionId)?.client || null;
    }

    getSessionStatus(sessionId) {
        const session = this.sessions.get(sessionId);
        const listData = this.sessionsList[sessionId];
        if (session) return { ...listData, currentQR: session.data.currentQR, status: session.data.status };
        return listData || null;
    }

    getAllSessionsStatus() {
        const result = [];
        for (const [id] of this.sessions) result.push(this.getSessionStatus(id));
        for (const id in this.sessionsList) if (!this.sessions.has(id)) result.push(this.sessionsList[id]);
        return result;
    }

    async initializeAllSessions() {
        const orphanSessions = [];
        for (const sessionId in this.sessionsList) {
            const sessionData = this.sessionsList[sessionId];
            if (!sessionData.ownerUsername || !authManager.users[sessionData.ownerUsername]) {
                orphanSessions.push(sessionId);
                continue;
            }
            if (!this.sessions.has(sessionId)) {
                const client = await this.initClient(sessionId);
                if (client) this.sessions.set(sessionId, { client, data: { ...sessionData }, socketGeneration: client._socketGeneration });
            }
        }
        for (const sessionId of orphanSessions) {
            addLog('[CLEANUP] Session orpheline supprimee: ' + sessionId);
            delete this.sessionsList[sessionId];
            for (const authPath of [path.join(__dirname, '.baileys_auth', sessionId), path.join(__dirname, '.wwebjs_auth', sessionId)]) {
                try { if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {}
            }
        }
        if (orphanSessions.length > 0) {
            if (this.activeSessionId && orphanSessions.includes(this.activeSessionId)) this.activeSessionId = null;
            this.saveSessionsList();
        }
        if (!this.activeSessionId && Object.keys(this.sessionsList).length > 0) {
            this.activeSessionId = Object.keys(this.sessionsList)[0];
            this.saveSessionsList();
        }
        for (const [sessionId] of this.sessions) {
            this.startSession(sessionId).catch(e => addLog('[START] [' + sessionId + '] Erreur: ' + e.message));
        }
    }
}

const sessionManager = new SessionManager();

// Reference rapide vers la session active Baileys
let client = null;
let currentQR = null;
let isConnected = false;

// ============================================================
// 🔍 SCAN HUMANISÉ
// ============================================================


async function scanOldMessages(chat, limit = 100, sessionId = null, options = {}) {
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : client;

    if (!sessionClient || !sessionClient.info) {
        if (sessionData) sessionData.addLog('[!] Client non disponible pour le scan');
        else addLog('[!] Client non disponible pour le scan');
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    const log = (msg) => sessionData ? sessionData.addLog(msg) : addLog(msg);
    const chatInfo = chat?.jid ? chat : await getChatInfo(sessionClient, chat?.id?._serialized || chat?.id || chat, true);
    if (!chatInfo?.isGroup) return { deleted: 0, scanned: 0, warned: 0 };
    const config = sessionData ? sessionData.config : CONFIG;
    const groupExcluded = sessionData ? sessionData.isGroupExcluded(chatInfo) : isGroupExcluded(chatInfo);

    if (groupExcluded && !config.DELETE_STATUS_MENTIONS) {
        log('[EXCL] Groupe ' + chatInfo.name + ' exclu');
        return { deleted: 0, scanned: 0, warned: 0 };
    } else if (groupExcluded) {
        log('[EXCL] Groupe ' + chatInfo.name + ' exclu: scan limite aux notifications de statut');
    }

    log('[SCAN] Scan de ' + chatInfo.name + '...');

    const participants = chatInfo.participants || [];
    const botP = findBotParticipant(sessionClient, participants);
    if (!botP || !botP.isAdmin) {
        log('[!] Pas admin dans ' + chatInfo.name);
        return { deleted: 0, scanned: 0, warned: 0 };
    }

    try { await markChatRead(sessionClient, chatInfo.jid); } catch (e) {}
    await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(2000, 1000));

    const cachedBeforeHistory = getCachedMessages(sessionClient, chatInfo.jid, limit).length;
    if (cachedBeforeHistory === 0 && options.anchorMessage) {
        log('[SCAN] Cache vide pour ' + chatInfo.name + ', utilisation de la commande comme repere historique');
    }
    const messages = await fetchMoreHistory(sessionClient, chatInfo.jid, limit, {
        anchorMessage: options.anchorMessage
    });
    if (!messages.length) {
        log('[SCAN] Aucun message disponible pour ' + chatInfo.name + ' (cache vide; le scan ne peut supprimer que les messages deja vus par le bot)');
    } else if (cachedBeforeHistory === 0 && messages.length > 0) {
        log('[SCAN] ' + messages.length + ' messages charges depuis l historique Baileys pour ' + chatInfo.name);
    }
    let deleted = 0, scanned = 0, warned = 0;
    let actionCount = 0;
    const waitBeforeScanAction = async () => {
        if (actionCount > 0) await HumanBehavior.naturalDelay(HumanBehavior.interActionDelay(config));
        actionCount++;

        if (actionCount > 0 && actionCount % 5 === 0) {
            const fatiguePause = HumanBehavior.gaussianRandom(8000, 4000);
            log('[PAUSE] Pause fatigue: ' + Math.round(fatiguePause / 1000) + 's');
            await HumanBehavior.naturalDelay(fatiguePause);
        }
    };

    for (const message of messages) {
        if (isMessageFromMe(message)) continue;
        scanned++;

        const msgId = getMessageId(message);
        if (sessionData && sessionData.isAlreadyProcessed(msgId)) continue;
        else if (!sessionData && isAlreadyProcessed(msgId)) continue;

        if (config.DELETE_STATUS_MENTIONS && isStatusMentionNotification(message)) {
            await waitBeforeScanAction();
            try {
                if (sessionData) sessionData.markAsProcessed(msgId);
                else markAsProcessed(msgId);

                const wasDeleted = await deleteMessageHumanized(sessionClient, message);
                if (wasDeleted) {
                    deleted++;
                    if (sessionData) sessionData.stats.totalDeleted++;
                    else STATS.totalDeleted++;
                    log('[STATUS] Ancienne notification de statut supprimee dans ' + chatInfo.name);
                } else {
                    log('[STATUS] Echec suppression ancienne notification de statut dans ' + chatInfo.name);
                }
            } catch (error) {
                log('[!] Erreur traitement statut: ' + error.message);
            }
            continue;
        }

        if (groupExcluded || options.statusOnly) continue;
        if (!containsLink(message)) continue;

        const authorId = getMessageSender(message);
        if (!authorId || authorId.includes('@g.us')) continue;

        const authorP = participants.find(p => participantMatches(p, authorId));
        if (authorP?.isAdmin || authorP?.isSuperAdmin) continue;

        if (sessionData && sessionData.isUserExcluded(authorId, participants)) continue;
        else if (!sessionData && isUserExcluded(authorId, participants)) continue;

        await waitBeforeScanAction();

        try {
            if (sessionData) sessionData.markAsProcessed(msgId);
            else markAsProcessed(msgId);

            const contact = await getContactInfo(sessionClient, authorId);
            const mention = '@' + contact.number;
            const currentWarnings = sessionData
                ? (sessionData.warnings[chatInfo.jid]?.[authorId]?.length || 0)
                : getWarningCount(chatInfo.jid, authorId);

            if (await deleteMessageHumanized(sessionClient, message)) {
                deleted++;
                if (sessionData) sessionData.stats.totalDeleted++;
                else STATS.totalDeleted++;
                log('[DELETE] Ancien message supprime dans ' + chatInfo.name);
            }

            const banUser = async () => {
                const banMsg = MessagePool.pick(MessagePool.bans, mention, config.MAX_WARNINGS);
                await sendMessageHumanized(sessionClient, chatInfo.jid, banMsg, makeReplyOptions(message, { mentions: [contact.jid] }), getMessageBody(message)?.length || 0, sessionData);
                await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(2000, 800));
                await sessionClient.groupParticipantsUpdate(chatInfo.jid, [normalizeJid(authorId)], 'remove');
                rateLimiter.recordAction();
                if (sessionData) {
                    sessionData.resetWarnings(chatInfo.jid, authorId);
                    sessionData.stats.totalBanned++;
                } else {
                    resetWarnings(chatInfo.jid, authorId);
                    STATS.totalBanned++;
                }
                log('[BAN] ' + authorId + ' banni de ' + chatInfo.name);
            };

            if (currentWarnings >= config.MAX_WARNINGS) {
                try { await banUser(); }
                catch (banError) { log('[X] Erreur ban: ' + banError.message); }
            } else {
                const warningCount = sessionData ? sessionData.addWarning(chatInfo.jid, authorId) : addWarning(chatInfo.jid, authorId);
                warned++;
                if (sessionData) sessionData.stats.totalWarnings++;
                else STATS.totalWarnings++;

                if (warningCount >= config.MAX_WARNINGS) {
                    try { await banUser(); }
                    catch (banError) { log('[X] Erreur ban: ' + banError.message); }
                } else {
                    const remaining = config.MAX_WARNINGS - warningCount;
                    const warnMsg = MessagePool.pick(MessagePool.warnings, mention, warningCount, config.MAX_WARNINGS, remaining);
                    try {
                        await sendMessageHumanized(sessionClient, chatInfo.jid, warnMsg, makeReplyOptions(message, { mentions: [contact.jid] }), getMessageBody(message)?.length || 0, sessionData);
                    } catch (warnError) {
                        console.error('Erreur avertissement:', warnError);
                    }
                }
            }
        } catch (error) {
            log('[!] Erreur traitement: ' + error.message);
        }
    }

    log('[OK] Scan ' + chatInfo.name + ': ' + scanned + ' scans, ' + deleted + ' supprimes, ' + warned + ' avertis');
    if (sessionData) sessionData.saveStats();
    return { deleted, scanned, warned };
}

async function scanAllGroups(sessionId = null, options = {}) {
    const sessionClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : client;
    if (!sessionClient || !sessionClient.info) {
        addLog('[!] [' + sessionId + '] Client non disponible pour le scan');
        return { totalDeleted: 0, totalScanned: 0, totalWarned: 0 };
    }

    addLog('[SCAN] ========== SCAN AUTOMATIQUE ==========');

    let chats;
    try {
        chats = await getAllChatsWithOptions(sessionClient, {
            force: true,
            retries: options.groupFetchRetries ?? 2,
            retryDelayMs: options.groupFetchRetryDelayMs ?? GROUP_CACHE_RETRY_DELAY_MS
        });
    } catch (error) {
        const reason = error?.message || 'liste des groupes indisponible';
        addLog('[SCAN] Liste des groupes indisponible (' + reason + '), scan reporte');
        if (isRateLimitError(error) && options.autoRetry !== false && !options._retriedAfterRateLimit) {
            const retryDelay = options.retryAfterRateLimitMs ?? 2 * 60 * 1000;
            addLog('[TIMER] [' + sessionId + '] Nouveau scan dans ' + Math.round(retryDelay / 1000) + 's apres limite WhatsApp');
            const retryTimer = setTimeout(() => {
                scanAllGroups(sessionId, {
                    ...options,
                    _retriedAfterRateLimit: true,
                    groupFetchRetries: 1
                }).catch(e => addLog('[SCAN] Retry annule: ' + e.message));
            }, retryDelay);
            retryTimer.unref?.();
        }
        return { totalDeleted: 0, totalScanned: 0, totalWarned: 0, deferred: true };
    }

    let allGroups = chats.filter(c => c.isGroup);
    if (!allGroups.length) {
        addLog('[SCAN] Aucun groupe charge depuis WhatsApp; scan reporte');
        return { totalDeleted: 0, totalScanned: 0, totalWarned: 0, deferred: true };
    }

    let groupsWithParticipants = allGroups.filter(g => (g.participants || []).length > 0).length;
    if (groupsWithParticipants === 0) {
        addLog('[SCAN] Participants absents dans la liste des groupes, chargement des metadonnees groupe par groupe...');
        const hydration = await hydrateMissingGroupParticipants(sessionClient, allGroups, {
            maxGroups: options.metadataHydrationLimit ?? 80,
            delayMs: options.metadataHydrationDelayMs ?? 700
        });
        allGroups = allGroups.map(group => ensureRuntime(sessionClient).chats.get(group.jid) || group);
        groupsWithParticipants = allGroups.filter(g => (g.participants || []).length > 0).length;
        addLog('[SCAN] Metadonnees groupes: ' + hydration.hydrated + '/' + hydration.attempted + ' groupe(s) avec participants apres hydratation' + (hydration.rateLimited ? ' (limite WhatsApp atteinte)' : ''));
    }

    const groups = allGroups.filter(c => {
        if (!c.isGroup) return false;
        const botParticipant = findBotParticipant(sessionClient, c.participants || []);
        return botParticipant?.isAdmin;
    });

    addLog('[STATS] ' + groups.length + ' groupes administres detectes');
    if (!groups.length) {
        addLog('[SCAN] ' + allGroups.length + ' groupe(s) vu(s), ' + groupsWithParticipants + ' avec participants. Verification admin impossible ou bot non reconnu.');
        addLog('[SCAN] Identifiants bot connus: ' + getOwnJids(sessionClient).slice(0, 6).join(', '));
        if (groupsWithParticipants === 0 && options.autoRetry !== false && !options._retriedAfterIncompleteGroups) {
            const retryDelay = options.retryAfterIncompleteGroupsMs ?? 90 * 1000;
            addLog('[TIMER] [' + sessionId + '] Nouveau scan dans ' + Math.round(retryDelay / 1000) + 's apres chargement incomplet des groupes');
            const retryTimer = setTimeout(() => {
                scanAllGroups(sessionId, {
                    ...options,
                    _retriedAfterIncompleteGroups: true,
                    groupFetchRetries: 1
                }).catch(e => addLog('[SCAN] Retry annule: ' + e.message));
            }, retryDelay);
            retryTimer.unref?.();
            return { totalDeleted: 0, totalScanned: 0, totalWarned: 0, deferred: true };
        }
    }

    let totalDeleted = 0, totalScanned = 0, totalWarned = 0;
    const shuffled = groups.sort(() => Math.random() - 0.5);
    const sdScan = getSessionData(sessionId);
    const scanConfig = sdScan?.config || CONFIG;
    const scanLimit = scanConfig.SCAN_LIMIT || CONFIG.SCAN_LIMIT;

    for (const group of shuffled) {
        const result = await scanOldMessages(group, scanLimit, sessionId, options);
        totalDeleted += result.deleted;
        totalScanned += result.scanned;
        totalWarned += result.warned || 0;
        await HumanBehavior.naturalDelay(HumanBehavior.interGroupDelay(scanConfig));
    }

    addLog('[OK] ========== FIN DU SCAN ==========');
    addLog('Total: ' + totalScanned + ' scans, ' + totalDeleted + ' supprimes, ' + totalWarned + ' avertis');
    return { totalDeleted, totalScanned, totalWarned };
}

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
                await client.sendPresenceUpdate('unavailable');
                const offlineTime = HumanBehavior.gaussianRandom(3600000, 1800000);
                const timer = setTimeout(togglePresence, offlineTime);
                presenceTimers.set(sessionId, timer);
                return;
            }

            await client.sendPresenceUpdate('available');
            const onlineTime = HumanBehavior.gaussianRandom(720000, 420000);

            const timer = setTimeout(async () => {
                try {
                    const s = sessionManager.sessions.get(sessionId);
                    if (s && s.data.status === 'connected') {
                        await s.client.sendPresenceUpdate('unavailable');
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


async function handleMessage(sock, message, sessionId) {
    const sessionData = getSessionData(sessionId);

    try {
        const messageText = getMessageBody(message).trim();
        const normalizedCommand = getBotCommand(message);
        const isBotCommand = !!normalizedCommand;
        if (isMessageFromMe(message) && !isBotCommand) return;

        let chat = await getChatInfo(sock, getMessageChatId(message));
        if (chat.isGroup && (!chat.participants || chat.participants.length === 0)) {
            chat = await getChatInfo(sock, chat.jid, true);
        }

        const senderId = getMessageSender(message);
        const menuAllowedInChat = await canUseInteractiveMenusInChat(chat, sessionData);

        if (!isBotCommand && menuAllowedInChat && (getMessageType(message) === 'buttons_response' || getMessageType(message) === 'list_response')) {
            const responseId = getSelectedResponseId(message);
            if (responseId) {
                sessionData.addLog('Menu reponse: ' + responseId + ' de ' + senderId);
                await handleMenuResponse(sock, message, responseId, sessionData);
                return;
            }
        }

        if (!isBotCommand && menuAllowedInChat && getMessageType(message) === 'chat') {
            const activeMenuSession = getActiveMenuSession(sessionData.menuSessions, chat.jid, senderId);
            const selection = findMenuSessionSelection(activeMenuSession, messageText);
            if (selection?.item) {
                const sourceMenu = sessionData.interactiveMenus[activeMenuSession.menuId] || {};
                sessionData.addLog('[MENU] Reponse ' + selection.method + ': ' + (selection.index + 1) + ' (' + getMenuItemLabel(selection.item) + ') de ' + senderId);
                await runMenuItem(sock, chat, senderId, selection.item, sourceMenu, sessionData, message, messageText.length);
                return;
            }
            if (selection?.invalidNumber) {
                await sendMessageHumanized(sock, chat.jid, 'Option invalide. Repondez avec un numero entre *1* et *' + selection.itemsCount + '*.', makeReplyOptions(message), messageText.length, sessionData);
                return;
            }

            const triggered = findTriggeredMenu(sessionData.interactiveMenus, chat, messageText);
            if (triggered) {
                sessionData.addLog('[MENU] Declenchement ' + triggered.mode + ': ' + triggered.menu.id + ' par ' + senderId + ' (mot-cle: ' + triggered.rawTrigger + ')');
                await sendInteractiveMenu(sock, chat, triggered.menu.id, sessionData, message);
                return;
            }
        }

        const commandReplyOpts = isBotCommand ? makeReplyOptions(message) : {};

        if (normalizedCommand === '!help') {
            await sendMessageHumanized(sock, chat.jid, buildHelpMessage(), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (!chat.isGroup) return;

        const participants = chat.participants || [];
        const botP = findBotParticipant(sock, participants);

        const senderP = participants.find(p => participantMatches(p, senderId));
        const groupExcluded = sessionData.isGroupExcluded(chat);
        const commandAllowed = senderP?.isAdmin || senderP?.isSuperAdmin || isMessageFromMe(message);

        if (normalizedCommand && ADMIN_COMMANDS.has(normalizedCommand) && !commandAllowed) {
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('ACCES REFUSE', 'Cette commande est reservee aux admins du groupe.', [menuCommand('!help', 'voir les commandes disponibles')]), commandReplyOpts, getMessageBody(message).length, sessionData);
            sessionData.addLog('[CMD] ' + normalizedCommand + ' ignore: expediteur non admin dans ' + chat.name);
            return;
        }

        if (sessionData.config.DELETE_STATUS_MENTIONS && botP?.isAdmin) {
            if (isStatusMentionNotification(message)) {
                const msgId = getMessageId(message);
                if (!sessionData.isAlreadyProcessed(msgId)) {
                    sessionData.markAsProcessed(msgId);
                    sessionData.addLog('[STATUS] Notification de statut detectee (' + getMessageType(message) + ') de ' + senderId + ' dans ' + chat.name);
                    const wasDeleted = await deleteMessageHumanized(sock, message);
                    if (wasDeleted) {
                        sessionData.stats.totalDeleted++;
                        sessionData.saveStats();
                        sessionData.addLog('[STATUS] Notification de statut supprimee dans ' + chat.name);
                    } else {
                        sessionData.addLog('[STATUS] Echec suppression notification statut dans ' + chat.name);
                    }
                }
                return;
            }
        }

        if (normalizedCommand === '!status') {
            await sendMessageHumanized(sock, chat.jid, buildStatusMessage(sock, chat, sessionData, botP), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!cache') {
            const limit = sessionData.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT;
            const count = getCachedMessages(sock, chat.jid, limit).length;
            await sendMessageHumanized(sock, chat.jid, menuPanel('CACHE DU GROUPE', [
                { title: 'Etat', lines: [menuLine('Messages connus ici', count), menuLine('Limite de scan', limit)] },
                { title: 'Note', lines: ['Si ce nombre vaut 0, le scan ne peut pas analyser les anciens messages.'] }
            ]), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!groupinfo') {
            await sendMessageHumanized(sock, chat.jid, buildGroupInfoMessage(sock, chat, sessionData, botP), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!config') {
            await sendMessageHumanized(sock, chat.jid, buildConfigMessage(sessionData), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!scan') {
            if (commandAllowed) {
                if (!botP?.isAdmin) {
                    await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('SCAN IMPOSSIBLE', 'Le bot doit etre admin du groupe.'), commandReplyOpts, getMessageBody(message).length, sessionData);
                    return;
                }
                await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('SCAN DU GROUPE', 'Analyse en cours...'), commandReplyOpts, getMessageBody(message).length, sessionData);
                const result = await scanOldMessages(chat, sessionData.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT, sessionId, { anchorMessage: message });
                await sendMessageHumanized(sock, chat.jid, menuPanel('SCAN TERMINE', [
                    { title: 'Resultat', lines: [menuLine('Messages analyses', result.scanned), menuLine('Messages supprimes', result.deleted), menuLine('Avertissements', result.warned || 0)] }
                ]), commandReplyOpts, 20, sessionData);
            } else {
                sessionData.addLog('[CMD] !scan ignore: expediteur non admin dans ' + chat.name);
            }
            return;
        }

        if (normalizedCommand === '!scanall') {
            if (commandAllowed) {
                if (!botP?.isAdmin) {
                    await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('SCAN GLOBAL IMPOSSIBLE', 'Le bot doit etre admin de ce groupe pour lancer la commande depuis ici.'), commandReplyOpts, getMessageBody(message).length, sessionData);
                    return;
                }
                await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('SCAN GLOBAL', 'Analyse de tous les groupes admin en cours...'), commandReplyOpts, getMessageBody(message).length, sessionData);
                const result = await scanAllGroups(sessionId);
                await sendMessageHumanized(sock, chat.jid, menuPanel('SCAN GLOBAL TERMINE', [
                    { title: 'Resultat', lines: [menuLine('Messages analyses', result.totalScanned), menuLine('Messages supprimes', result.totalDeleted), menuLine('Avertissements', result.totalWarned || 0)] }
                ]), commandReplyOpts, 25, sessionData);
            } else {
                sessionData.addLog('[CMD] !scanall ignore: expediteur non admin dans ' + chat.name);
            }
            return;
        }

        if (normalizedCommand === '!scanstatus') {
            if (!botP?.isAdmin) {
                await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('SCAN STATUT IMPOSSIBLE', 'Le bot doit etre admin du groupe.'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('SCAN STATUT', 'Recherche des notifications de statut en cours...'), commandReplyOpts, getMessageBody(message).length, sessionData);
            const result = await scanOldMessages(chat, sessionData.config.SCAN_LIMIT || CONFIG.SCAN_LIMIT, sessionId, { anchorMessage: message, statusOnly: true });
            await sendMessageHumanized(sock, chat.jid, menuPanel('SCAN STATUT TERMINE', [
                { title: 'Resultat', lines: [menuLine('Messages analyses', result.scanned), menuLine('Notifications supprimees', result.deleted)] }
            ]), commandReplyOpts, 20, sessionData);
            return;
        }

        if (normalizedCommand === '!excludehere') {
            if (!sessionData.groupExceptions.excludedGroups.includes(chat.jid)) {
                sessionData.groupExceptions.excludedGroups.push(chat.jid);
                sessionData.saveGroupExceptions();
            }
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('GROUPE EXCLU', 'La moderation est desactivee ici.', ['Les commandes admin restent disponibles.']), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!includehere') {
            sessionData.groupExceptions.excludedGroups = sessionData.groupExceptions.excludedGroups.filter(id => id !== chat.jid);
            sessionData.saveGroupExceptions();
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('GROUPE REACTIVE', 'La moderation est de nouveau active dans ce groupe.'), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!warnings') {
            const target = getCommandTarget(message, participants);
            if (!target) {
                await sendMessageHumanized(sock, chat.jid, buildUsageMessage('!warnings', '@membre ou numero'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            const warningKey = findWarningKeyForTarget(sessionData, chat.jid, target);
            const warningList = warningKey ? (sessionData.warnings[chat.jid]?.[warningKey] || []) : [];
            const user = await describeUserId(sock, warningKey || target.id, participants);
            const details = warningList.length
                ? warningList.slice(-5).map((ts, i) => (i + 1) + '. ' + formatDateTime(ts)).join('\n')
                : 'Aucun avertissement.';
            await sendMessageHumanized(sock, chat.jid, menuPanel('AVERTISSEMENTS', [
                { title: 'Utilisateur', lines: [menuLine('Nom', user.name), menuLine('Numero', user.phone), menuLine('Total', warningList.length + '/' + sessionData.config.MAX_WARNINGS)] },
                { title: 'Historique', lines: [details] }
            ]), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!resetwarn') {
            const target = getCommandTarget(message, participants);
            if (!target) {
                await sendMessageHumanized(sock, chat.jid, buildUsageMessage('!resetwarn', '@membre ou numero'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            const warningKey = findWarningKeyForTarget(sessionData, chat.jid, target);
            const user = await describeUserId(sock, warningKey || target.id, participants);
            if (warningKey) sessionData.resetWarnings(chat.jid, warningKey);
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('AVERTISSEMENTS EFFACES', user.name + ' (' + user.phone + ')'), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!blocked') {
            const entries = Object.entries(sessionData.blockedUsers || {});
            if (!entries.length) {
                await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('UTILISATEURS BLOQUES', 'Aucun utilisateur bloque par anti-spam appels.'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            const lines = [];
            for (const [userId, entry] of entries.slice(0, 10)) {
                const user = await describeUserId(sock, userId, participants);
                const durationMs = getCallBlockDurationMin(sessionData.config) * 60 * 1000;
                const remaining = entry.autoUnblock ? formatDuration(durationMs - (Date.now() - (entry.blockedAt || Date.now()))) : 'manuel';
                lines.push(user.name + ' (' + user.phone + ') - ' + (entry.callCount || 0) + ' appels - reste: ' + remaining);
            }
            const suffix = entries.length > 10 ? '\n\n+' + (entries.length - 10) + ' autres.' : '';
            await sendMessageHumanized(sock, chat.jid, menuPanel('UTILISATEURS BLOQUES', [
                { title: 'Liste', lines: lines }
            ]) + suffix, commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!unblock') {
            const target = getCommandTarget(message, participants);
            if (!target) {
                await sendMessageHumanized(sock, chat.jid, buildUsageMessage('!unblock', 'numero ou @membre'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            const blockedKey = findBlockedKeyForTarget(sessionData.blockedUsers, target);
            if (!blockedKey) {
                await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('DEBLOCAGE', 'Cet utilisateur n est pas bloque par le bot.'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            await sock.updateBlockStatus(normalizeJid(blockedKey), 'unblock');
            ensureRuntime(sock).blocklist.delete(normalizeJid(blockedKey));
            if (sessionData.unblockTimers[blockedKey]) {
                clearTimeout(sessionData.unblockTimers[blockedKey]);
                delete sessionData.unblockTimers[blockedKey];
            }
            delete sessionData.blockedUsers[blockedKey];
            delete sessionData.callSpamTracker[blockedKey];
            sessionData.saveCallSpamData();
            const user = await describeUserId(sock, blockedKey, participants);
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('UTILISATEUR DEBLOQUE', user.name + ' (' + user.phone + ')'), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!allowcalls') {
            const target = getCommandTarget(message, participants);
            if (!target) {
                await sendMessageHumanized(sock, chat.jid, buildUsageMessage('!allowcalls', 'numero ou @membre'), commandReplyOpts, getMessageBody(message).length, sessionData);
                return;
            }
            const aliases = await resolveUserAliases(sock, target.id);
            const values = buildUserMatchValues(target.id, target.values, aliases);
            let userIndex = sessionData.userExceptions.excludedUsers.findIndex(entry => userExceptionMatches(entry, values));
            let entry = userIndex >= 0 ? sessionData.userExceptions.excludedUsers[userIndex] : null;
            if (entry && typeof entry !== 'object') {
                entry = { id: entry, aliases: buildUserMatchValues(entry), linkException: true, callException: true };
                sessionData.userExceptions.excludedUsers[userIndex] = entry;
            }
            if (entry) {
                entry.callException = true;
                entry.aliases = Array.from(new Set([...(entry.aliases || []), ...aliases, ...values]));
            } else {
                entry = { id: target.id, aliases: Array.from(new Set([...aliases, ...values])), linkException: false, callException: true };
                sessionData.userExceptions.excludedUsers.push(entry);
            }
            sessionData.saveUserExceptions();
            const cleared = await clearCallBlocksForValues(sock, sessionData, values);
            const user = await describeUserId(sock, target.id, participants);
            await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('APPELS AUTORISES', user.name + ' (' + user.phone + ')', cleared ? ['Blocage retire.'] : []), commandReplyOpts, getMessageBody(message).length, sessionData);
            return;
        }

        if (normalizedCommand === '!diagdelete') {
            if (commandAllowed) {
                await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('DIAGNOSTIC', 'Verification de la suppression en cours...'), commandReplyOpts, getMessageBody(message).length, sessionData);
                const author = await describeMessageAuthor(sock, message, participants);
                const report = buildDeleteDiagnosticReport({ sock, chat, message, author, botP, commandAllowed });
                await sendMessageHumanized(sock, chat.jid, report, commandReplyOpts, 10, sessionData);
                addLog('[DIAG] [' + sessionId + '] Diagnostic Baileys envoye dans ' + chat.name);
                return;
            }
            sessionData.addLog('[CMD] !diagdelete ignore: expediteur non admin dans ' + chat.name);
            return;
        }

        if (normalizedCommand === '!testdelete') {
            if (commandAllowed) {
                const testMsg = await sendMessageHumanized(sock, chat.jid, buildNoticeMessage('TEST SUPPRESSION', 'Ce message sera supprime dans 3 secondes.'), commandReplyOpts, 5, sessionData);
                if (testMsg) {
                    await new Promise(r => setTimeout(r, 3000));
                    const deleted = await deleteMessageHumanized(sock, testMsg);
                    await sendMessageHumanized(sock, chat.jid, deleted
                        ? buildNoticeMessage('TEST SUPPRESSION', 'Suppression reussie.')
                        : buildNoticeMessage('TEST SUPPRESSION', 'Suppression echouee.', ['Consulte les logs pour le detail.']), commandReplyOpts, 5, sessionData);
                }
            } else {
                sessionData.addLog('[CMD] !testdelete ignore: expediteur non admin dans ' + chat.name);
            }
            return;
        }

        if (!botP?.isAdmin) return;

        if (groupExcluded) return;

        if (!containsLink(message)) return;

        const msgId = getMessageId(message);
        if (sessionData.isAlreadyProcessed(msgId)) return;
        sessionData.markAsProcessed(msgId);

        const authorId = getMessageSender(message);
        if (!authorId || authorId.includes('@g.us')) return;

        const contact = await getContactInfo(sock, authorId);
        const authorNumber = contact?.number || jidNumber(authorId);

        if (senderP?.isAdmin || senderP?.isSuperAdmin) return;
        const isAdmin = participants.some(p => (p.isAdmin || p.isSuperAdmin) && participantMatches(p, authorId));
        if (isAdmin) {
            sessionData.addLog('[ADMIN] ' + authorNumber + ' est admin, lien ignore');
            return;
        }

        if (sessionData.isUserExcluded(authorId, participants) || sessionData.isUserExcluded(authorNumber, participants)) return;

        try { await markChatRead(sock, chat.jid); } catch (e) {}

        const mention = '@' + contact.number;
        const warningCount = sessionData.addWarning(chat.jid, authorId);
        const remaining = sessionData.config.MAX_WARNINGS - warningCount;
        sessionData.stats.totalWarnings++;

        const messageBodyLength = getMessageBody(message)?.length || 0;
        try { await sock.sendMessage(chat.jid, { react: { text: '\uD83D\uDEAB', key: message.key } }); } catch (e) {}
        const wasDeleted = await deleteMessageHumanized(sock, message);
        if (wasDeleted) {
            sessionData.stats.totalDeleted++;
            sessionData.addLog('[SUPPR] Message supprime de ' + authorId + ' dans ' + chat.name);
        }

        if (warningCount >= sessionData.config.MAX_WARNINGS) {
            try {
                const banMsg = MessagePool.pick(MessagePool.bans, mention, sessionData.config.MAX_WARNINGS);
                await sendMessageHumanized(sock, chat.jid, banMsg, makeReplyOptions(message, { mentions: [contact.jid] }), messageBodyLength, sessionData);
                await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(2500, 1000));
                await sock.groupParticipantsUpdate(chat.jid, [normalizeJid(authorId)], 'remove');
                rateLimiter.recordAction();
                sessionData.resetWarnings(chat.jid, authorId);
                sessionData.stats.totalBanned++;
                sessionData.addLog('[BAN] ' + authorId + ' banni de ' + chat.name);
            } catch (banError) {
                sessionData.addLog('[X] Erreur ban: ' + banError.message);
                await sendMessageHumanized(sock, chat.jid, mention + ' a atteint la limite mais je n ai pas pu le bannir.', makeReplyOptions(message, { mentions: [contact.jid] }), 10, sessionData);
            }
        } else {
            const warnMsg = MessagePool.pick(MessagePool.warnings, mention, warningCount, sessionData.config.MAX_WARNINGS, remaining);
            await sendMessageHumanized(sock, chat.jid, warnMsg, makeReplyOptions(message, { mentions: [contact.jid] }), messageBodyLength, sessionData);
            sessionData.addLog('[!] Avertissement ' + warningCount + '/' + sessionData.config.MAX_WARNINGS + ' pour ' + authorId + ' dans ' + chat.name);
        }

        sessionData.saveStats();
    } catch (error) {
        console.error('[' + sessionId + '] Erreur traitement message:', error);
    }
}

// ============================================================

const WELCOME_MESSAGE_EXCLUDED = `👋 Bienvenue {mention} dans *{group}* !

🎉 Content de te voir parmi nous !

N'hésite pas à participer et à partager.

Bonne discussion ! 🙌`;


async function handleGroupJoin(sock, notification, sessionId) {
    const sessionData = getSessionData(sessionId);

    try {
        if (!sessionData.config.WELCOME_ENABLED) return;

        const chatId = normalizeJid(notification.chatId || notification.id || notification.key?.remoteJid);
        if (!chatId || !isGroupJid(chatId)) return;
        const chat = getCachedChatInfo(sock, chatId);

        if (sessionData.groupExceptions.excludedWelcome.includes(chat.jid)) {
            sessionData.addLog('[MUTE] Bienvenue desactivee pour ' + chat.name);
            return;
        }

        const newMemberId = normalizeJid(notification.participant || notification.recipient || notification.id?.participant);
        if (!newMemberId) return;
        const participants = chat.participants || [];
        let newMemberParticipant = participants.find(p => participantMatches(p, newMemberId));
        if (!newMemberParticipant) {
            newMemberParticipant = hydrateParticipant(notification.participant || newMemberId);
            if (newMemberParticipant?.jid && !participants.some(p => participantMatches(p, newMemberParticipant.jid))) {
                chat.participants = [...participants, newMemberParticipant];
                ensureRuntime(sock).chats.set(chat.jid, chat);
            }
        }
        const contactId = newMemberParticipant?.phoneNumber || newMemberParticipant?.jid || newMemberParticipant?.lid || newMemberId;
        const contact = await getContactInfo(sock, contactId);

        const mentionJids = Array.from(new Set([
            contact.jid,
            newMemberId,
            contact.phoneNumber,
            newMemberParticipant?.jid,
            newMemberParticipant?.lid,
            newMemberParticipant?.phoneNumber
        ].map(normalizeJid).filter(Boolean)));
        const mention = '@' + contact.number;
        const isExcluded = sessionData.isGroupExcluded(chat);
        const welcomeMessage = (isExcluded ? WELCOME_MESSAGE_EXCLUDED : sessionData.config.WELCOME_MESSAGE)
            .replace(/{mention}/g, mention)
            .replace(/{group}/g, chat.name)
            .replace(/{maxWarnings}/g, sessionData.config.MAX_WARNINGS);

        const profilePic = await getProfilePictureUrlForUser(sock, newMemberParticipant, contact.phoneNumber, contact.jid, newMemberId, contact.aliases);
        const profilePicUrl = profilePic.url;

        if (profilePicUrl) {
            try {
                const media = await mediaFromUrl(profilePicUrl, 'profile.jpg');
                await sendMessageHumanized(sock, chat.jid, media, { caption: welcomeMessage, mentions: mentionJids, bypassRateLimit: true }, 0, sessionData);
            } catch (e) {
                await sendMessageHumanized(sock, chat.jid, welcomeMessage, { mentions: mentionJids, bypassRateLimit: true }, 0, sessionData);
            }
        } else {
            await sendMessageHumanized(sock, chat.jid, welcomeMessage, { mentions: mentionJids, bypassRateLimit: true }, 0, sessionData);
        }

        sessionData.addLog('[BIENVENUE] Bienvenue envoye a ' + contact.number + ' dans ' + chat.name + (profilePic.jid ? ' avec photo (' + profilePic.type + ')' : ' sans photo (' + (profilePic.tried?.length || 0) + ' tentative(s))') + (isExcluded ? ' (groupe exclu)' : ''));
    } catch (error) {
        sessionData.addLog('[X] Erreur bienvenue: ' + error.message);
    }
}

// ============================================================

const callProcessingLock = new Map(); // { callerId: boolean } par session


async function handleCall(sock, call, sessionId) {
    const sessionData = getSessionData(sessionId);
    const callerId = getCallFrom(call);
    const lockKey = callerId ? sessionId + '_' + callerId : null;

    try {
        if (!sessionData.config.CALL_REJECT_ENABLED) return;
        if (!callerId) return;

        sessionData.addLog('[CALL] Appel entrant de ' + callerId);

        if (lockKey && callProcessingLock.get(lockKey)) {
            try { await rejectBaileysCall(sock, call); } catch (e) {}
            sessionData.addLog('[CALL] Appel ' + callerId + ' rejete (traitement concurrent en cours)');
            return;
        }
        if (lockKey) callProcessingLock.set(lockKey, true);

        const contact = await getContactInfo(sock, callerId);
        const callerNumber = contact.number || jidNumber(callerId);
        if (callerNumber) sessionData.addLog('Numero associe: ' + callerNumber);

        const callerAliases = await resolveUserAliases(sock, callerId);
        const callMatchValues = buildUserMatchValues(callerId, callerNumber, contact, callerAliases, call.from, call.chatId, call.creator, call.participant);
        const userException = await findCallExceptionForValues(sock, sessionData.userExceptions, callMatchValues);

        if (userException) {
            await clearCallBlocksForValues(sock, sessionData, buildUserMatchValues(callMatchValues, userException));
            sessionData.saveUserExceptions();
            sessionData.addLog('[OK] ' + callerNumber + ' exempte du rejet appels - appel ignore');
            return;
        }

        const internalBlockedKey = Object.keys(sessionData.blockedUsers || {})
            .find(key => callMatchValues.some(value => valuesMatchUser(key, value)));

        if (internalBlockedKey) {
            try {
                const stillBlocked = await isUserBlockedOnWhatsApp(sock, buildUserMatchValues(callMatchValues, internalBlockedKey));
                if (stillBlocked) {
                    sessionData.addLog('[BLOCK] ' + callerId + ' deja bloque sur WhatsApp');
                    try { await rejectBaileysCall(sock, call); } catch (e) {}
                    return;
                }
                const cleared = await clearCallBlocksForValues(sock, sessionData, buildUserMatchValues(callMatchValues, internalBlockedKey));
                sessionData.addLog('[UNBLOCK] ' + callerId + ' debloque manuellement sur WhatsApp, etat interne nettoye (' + cleared + ')');
            } catch (e) {
                sessionData.addLog('[!] Erreur verification blocage: ' + e.message);
            }
        }

        try {
            await rejectBaileysCall(sock, call);
            sessionData.addLog('[REJECT] Appel rejete: ' + callerId);
            sessionData.stats.totalCallsRejected++;
            rateLimiter.recordAction();
        } catch (rejectError) {
            sessionData.addLog('[!] Erreur rejet appel: ' + rejectError.message);
        }

        sessionData.addCallToHistory(callerId, callerNumber, isVideoCall(call), 'rejected');

        const now = Date.now();
        const callBlockDurationMin = getCallBlockDurationMin(sessionData.config);
        const callBlockDurationText = formatCallBlockDuration(callBlockDurationMin);
        const windowMs = (sessionData.config.CALL_SPAM_WINDOW_MIN || 30) * 60 * 1000;
        if (!sessionData.callSpamTracker[callerId]) sessionData.callSpamTracker[callerId] = [];
        sessionData.callSpamTracker[callerId] = sessionData.callSpamTracker[callerId].filter(ts => now - ts < windowMs);
        sessionData.callSpamTracker[callerId].push(now);
        const callCount = sessionData.callSpamTracker[callerId].length;
        sessionData.saveCallSpamData();

        sessionData.addLog('[STATS] ' + callerId + ': ' + callCount + '/' + sessionData.config.CALL_SPAM_THRESHOLD + ' appels');

        if (callCount >= sessionData.config.CALL_SPAM_THRESHOLD) {
            sessionData.addLog('[SPAM] SPAM: ' + callerId + ' - ' + callCount + ' appels -> BLOCAGE');

            try {
                await HumanBehavior.naturalDelay(HumanBehavior.postCallMessageDelay());
                const blockMsg = MessagePool.pick(MessagePool.callBlocked, callBlockDurationText);
                await sendMessageHumanized(sock, callerId, blockMsg, {}, 0, sessionData);
            } catch (msgError) {
                sessionData.addLog('[!] Message pre-blocage echoue: ' + msgError.message);
            }

            await HumanBehavior.naturalDelay(HumanBehavior.blockDelay());

            sessionData.blockedUsers[callerId] = {
                blockedAt: Date.now(),
                autoUnblock: true,
                callCount
            };
            sessionData.saveCallSpamData();
            sessionData.addLog('[LOCK] ' + callerId + ' marque bloque en interne');

            try {
                const normalizedCaller = normalizeJid(callerId);
                const alreadyBlockedOnWhatsApp = await isUserBlockedOnWhatsApp(sock, buildUserMatchValues(callMatchValues, normalizedCaller));
                if (!alreadyBlockedOnWhatsApp) {
                    await sock.updateBlockStatus(normalizedCaller, 'block');
                    ensureRuntime(sock).blocklist.add(normalizedCaller);
                    rateLimiter.recordAction();
                    sessionData.addLog('[LOCK] ' + callerId + ' bloque sur WhatsApp');
                } else {
                    sessionData.addLog('[LOCK] ' + callerId + ' deja bloque sur WhatsApp');
                }

                const blockDuration = callBlockDurationMin * 60 * 1000;
                if (sessionData.unblockTimers[callerId]) clearTimeout(sessionData.unblockTimers[callerId]);
                sessionData.unblockTimers[callerId] = setTimeout(async () => {
                    if (sessionData.blockedUsers[callerId] && sessionData.blockedUsers[callerId].autoUnblock) {
                        try {
                            await HumanBehavior.naturalDelay(HumanBehavior.gaussianRandom(3000, 1500));
                            await sock.updateBlockStatus(normalizedCaller, 'unblock');
                            ensureRuntime(sock).blocklist.delete(normalizedCaller);
                            delete sessionData.blockedUsers[callerId];
                            delete sessionData.callSpamTracker[callerId];
                            delete sessionData.unblockTimers[callerId];
                            sessionData.saveCallSpamData();
                            sessionData.addLog('[UNBLOCK] ' + callerId + ' debloque automatiquement');
                        } catch (error) {
                            sessionData.addLog('[X] Erreur deblocage auto ' + callerId + ': ' + error.message);
                        }
                    }
                }, blockDuration);
            } catch (blockError) {
                sessionData.addLog('[X] Erreur blocage WhatsApp (blocage interne actif): ' + blockError.message);
            }

            sessionData.saveStats();
            return;
        }

        const msgDelay = HumanBehavior.postCallMessageDelay();
        sessionData.addLog('[TIMER] Message dans ' + Math.round(msgDelay / 1000) + 's...');
        await HumanBehavior.naturalDelay(msgDelay);

        try {
            const remaining = sessionData.config.CALL_SPAM_THRESHOLD - callCount;
            const rejectMsg = MessagePool.pick(MessagePool.callRejections, remaining, callBlockDurationText);
            await sendMessageHumanized(sock, callerId, rejectMsg, {}, 0, sessionData);
            sessionData.addLog('[MSG] Message envoye a ' + callerId);
        } catch (msgError) {
            sessionData.addLog('[X] Erreur message post-appel: ' + msgError.message);
        }
    } catch (error) {
        const sd = getSessionData(sessionId);
        sd.addLog('[X] Erreur handler appel: ' + error.message);
    } finally {
        if (lockKey) callProcessingLock.delete(lockKey);
    }
}

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

// Créer une session de checkout LeekPay (pour redirection)
app.post('/api/subscription/create-checkout', requireAuth, async (req, res) => {
    if (!subscriptionSettings.enabled) return res.json({ success: false, message: 'Abonnement désactivé' });
    if (!subscriptionSettings.secretKey) return res.json({ success: false, message: 'Clé secrète non configurée' });

    const returnUrl = req.body.returnUrl || `${req.protocol}://${req.get('host')}/`;
    const cancelUrl = req.body.cancelUrl || `${req.protocol}://${req.get('host')}/`;
    
    try {
        const baseDescription = subscriptionSettings.description || 'Abonnement PayOol Bot';
        const finalDescription = `${baseDescription} - Utilisateur: ${req.user.username}`;
        
        const fetchResponse = await fetch('https://leekpay.fr/api/v1/checkout', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${subscriptionSettings.secretKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: subscriptionSettings.amount,
                currency: subscriptionSettings.currency,
                description: finalDescription,
                return_url: returnUrl,
                cancel_url: cancelUrl
            })
        });
        const data = await fetchResponse.json();
        
        if (data.success && data.data && data.data.payment_url) {
            res.json({ success: true, paymentUrl: data.data.payment_url, checkoutId: data.data.id });
        } else {
            res.status(400).json({ success: false, message: 'Erreur création checkout: ' + JSON.stringify(data) });
        }
    } catch(e) {
        console.error('Erreur create-checkout:', e);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

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
app.post('/api/subscription/confirm', requireAuth, async (req, res) => {
    const { paymentId, amount, currency } = req.body;
    const username = req.user.username;
    
    if (!paymentId) {
        return res.status(400).json({ success: false, message: 'ID de paiement requis' });
    }
    
    if (!subscriptionSettings.enabled) {
        return res.json({ success: true, message: 'Abonnement non requis' });
    }
    
    // Vérification auprès de LeekPay si la clé secrète est configurée
    if (subscriptionSettings.secretKey) {
        try {
            const fetchResponse = await fetch(`https://leekpay.fr/api/v1/checkout/${paymentId}`, {
                headers: {
                    'Authorization': `Bearer ${subscriptionSettings.secretKey}`
                }
            });
            const responseData = await fetchResponse.json();
            
            if (!fetchResponse.ok || !responseData.data || responseData.data.status !== 'paid') {
                return res.status(400).json({ success: false, message: 'Paiement non validé par LeekPay' });
            }
        } catch (error) {
            console.error('Erreur vérification LeekPay:', error);
            return res.status(500).json({ success: false, message: 'Erreur lors de la vérification du paiement' });
        }
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
    const { enabled, apiKey, secretKey, amount, currency, durationDays, description, trialEnabled, trialDurationDays } = req.body;
    
    if (enabled !== undefined) subscriptionSettings.enabled = !!enabled;
    if (apiKey !== undefined) subscriptionSettings.apiKey = apiKey;
    if (secretKey !== undefined) subscriptionSettings.secretKey = secretKey;
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
                await sessionManager.startSession(sessionId);
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

app.post('/api/sessions', requireAuth, async (req, res) => {
    try {
        const { name } = req.body;
        const username = req.user.username;
        
        // Vérifier que l'utilisateur existe toujours
        const check = sessionManager.canUserStartSession(username);
        if (!check.allowed) {
            return res.status(403).json({ success: false, message: check.reason, requireSubscription: check.requireSubscription || false });
        }
        
        const sessionData = await sessionManager.createSession(null, name || 'New Session', username);
        await sessionManager.startSession(sessionData.id);
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
app.post('/api/sessions/:id/start', requireAuth, async (req, res) => {
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
    
    const success = await sessionManager.startSession(sessionId);
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

function normalizeConfigNumber(value, fallback, min = null, max = null) {
    let normalized = Number.parseInt(value, 10);
    if (!Number.isFinite(normalized)) normalized = fallback;
    if (min !== null) normalized = Math.max(min, normalized);
    if (max !== null) normalized = Math.min(max, normalized);
    return normalized;
}

function normalizeConfigBoolean(value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
        if (['false', '0', 'no', 'off'].includes(lowered)) return false;
    }
    return Boolean(value);
}

app.get('/api/config', requireAuth, (req, res) => {
    // Utiliser la config de la session active ou la config globale
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    const config = sessionData ? sessionData.config : CONFIG;
    
    res.json({
        sessionId: sessionId || 'global',
        MAX_WARNINGS: normalizeConfigNumber(config.MAX_WARNINGS, 3, 1, 10),
        WARNING_EXPIRY_HOURS: normalizeConfigNumber(config.WARNING_EXPIRY_HOURS, 24, 1, 168),
        SCAN_LIMIT: normalizeConfigNumber(config.SCAN_LIMIT, 100, 1, 1000),
        AUTO_SCAN_INTERVAL_HOURS: normalizeConfigNumber(config.AUTO_SCAN_INTERVAL_HOURS, 24, 1, 168),
        DELAY_BETWEEN_ACTIONS_MIN: normalizeConfigNumber(config.DELAY_BETWEEN_ACTIONS_MIN, 2000, 0, 60000),
        DELAY_BETWEEN_ACTIONS_MAX: normalizeConfigNumber(config.DELAY_BETWEEN_ACTIONS_MAX, 5000, 0, 120000),
        DELAY_BETWEEN_GROUPS_MIN: normalizeConfigNumber(config.DELAY_BETWEEN_GROUPS_MIN, 5000, 0, 300000),
        DELAY_BETWEEN_GROUPS_MAX: normalizeConfigNumber(config.DELAY_BETWEEN_GROUPS_MAX, 15000, 0, 600000),
        WELCOME_MESSAGE: config.WELCOME_MESSAGE,
        WELCOME_ENABLED: normalizeConfigBoolean(config.WELCOME_ENABLED, true),
        AUTO_SCAN_ENABLED: normalizeConfigBoolean(config.AUTO_SCAN_ENABLED, true),
        CALL_REJECT_ENABLED: normalizeConfigBoolean(config.CALL_REJECT_ENABLED, true),
        CALL_SPAM_THRESHOLD: normalizeConfigNumber(config.CALL_SPAM_THRESHOLD, 4, 1, 50),
        CALL_SPAM_WINDOW_MIN: normalizeConfigNumber(config.CALL_SPAM_WINDOW_MIN, 10, 1, 1440),
        CALL_BLOCK_DURATION_MIN: normalizeConfigNumber(config.CALL_BLOCK_DURATION_MIN, 30, 1, 10080),
        DELETE_STATUS_MENTIONS: normalizeConfigBoolean(config.DELETE_STATUS_MENTIONS, true)
    });
});

app.post('/api/config', requireAuth, (req, res) => {
    try {
        // Utiliser la config de la session active ou la config globale
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const config = sessionData ? sessionData.config : CONFIG;
        
        const nc = req.body;
        const setNumber = (key, fallback, min, max) => {
            if (nc[key] !== undefined) {
                config[key] = normalizeConfigNumber(nc[key], normalizeConfigNumber(config[key], fallback, min, max), min, max);
            }
        };
        const setBoolean = (key, fallback) => {
            if (nc[key] !== undefined) config[key] = normalizeConfigBoolean(nc[key], fallback);
        };

        setNumber('MAX_WARNINGS', 3, 1, 10);
        setNumber('WARNING_EXPIRY_HOURS', 24, 1, 168);
        setNumber('SCAN_LIMIT', 100, 1, 1000);
        setNumber('AUTO_SCAN_INTERVAL_HOURS', 24, 1, 168);
        setNumber('DELAY_BETWEEN_ACTIONS_MIN', 2000, 0, 60000);
        setNumber('DELAY_BETWEEN_ACTIONS_MAX', 5000, 0, 120000);
        setNumber('DELAY_BETWEEN_GROUPS_MIN', 5000, 0, 300000);
        setNumber('DELAY_BETWEEN_GROUPS_MAX', 15000, 0, 600000);
        setNumber('CALL_SPAM_THRESHOLD', 4, 1, 50);
        setNumber('CALL_SPAM_WINDOW_MIN', 10, 1, 1440);
        setNumber('CALL_BLOCK_DURATION_MIN', 30, 1, 10080);

        if (config.DELAY_BETWEEN_ACTIONS_MAX < config.DELAY_BETWEEN_ACTIONS_MIN) {
            config.DELAY_BETWEEN_ACTIONS_MAX = config.DELAY_BETWEEN_ACTIONS_MIN;
        }
        if (config.DELAY_BETWEEN_GROUPS_MAX < config.DELAY_BETWEEN_GROUPS_MIN) {
            config.DELAY_BETWEEN_GROUPS_MAX = config.DELAY_BETWEEN_GROUPS_MIN;
        }

        if (nc.WELCOME_MESSAGE !== undefined) config.WELCOME_MESSAGE = String(nc.WELCOME_MESSAGE);
        setBoolean('WELCOME_ENABLED', true);
        setBoolean('AUTO_SCAN_ENABLED', true);
        setBoolean('CALL_REJECT_ENABLED', true);
        setBoolean('DELETE_STATUS_MENTIONS', true);
        
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
            const chats = await getAllChats(activeClient);
            let adminCount = 0;
            for (const g of chats.filter(c => c.isGroup)) {
                const bp = findBotParticipant(activeClient, g.participants || []);
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
        
        const chats = await getAllChatsWithOptions(activeClient, { retries: 1, retryDelayMs: 5000 });
        const groups = [];
        for (const g of chats.filter(c => c.isGroup)) {
            const bp = findBotParticipant(activeClient, g.participants || []);
            if (bp?.isAdmin) {
                groups.push({
                    name: g.name,
                    id: g.jid,
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
        const chats = await getAllChatsWithOptions(activeClient, { retries: 1, retryDelayMs: 5000 });
        const groupExceptions = sessionData ? sessionData.groupExceptions : GROUP_EXCEPTIONS;

        res.json(chats.filter(c => c.isGroup).map(g => {
            const bp = findBotParticipant(activeClient, g.participants || []);
            return {
                id: g.jid,
                name: g.name,
                participants: g.participants?.length || 0,
                isAdmin: bp?.isAdmin || false,
                isExcluded: groupExceptions.excludedGroups.includes(g.jid)
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

        const chats = await getAllChatsWithOptions(activeClient, { retries: 1, retryDelayMs: 5000 });
        const groups = [];

        for (const g of chats.filter(c => c.isGroup)) {
            const botParticipant = findBotParticipant(activeClient, g.participants || []);

            groups.push({
                id: g.jid,
                name: g.name,
                participants: g.participants?.length || 0,
                isAdmin: botParticipant?.isAdmin || false,
                isSuperAdmin: botParticipant?.isSuperAdmin || false
            });
        }

        if (sessionData) sessionData.addLog('[GROUPS] /api/groups/all: ' + groups.length + ' groupes trouves');
        else addLog('[GROUPS] /api/groups/all: ' + groups.length + ' groupes trouves');
        res.json(groups);
    } catch (error) {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (isRateLimitError(error)) {
            if (sessionData) sessionData.addLog('[GROUPS] /api/groups/all: limite WhatsApp temporaire, cache indisponible');
            else addLog('[GROUPS] /api/groups/all: limite WhatsApp temporaire, cache indisponible');
            return res.json([]);
        }
        if (sessionData) sessionData.addLog('[X] Erreur /api/groups/all: ' + error.message);
        else addLog('[X] Erreur /api/groups/all: ' + error.message);
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

        const chat = await getChatInfo(activeClient, groupId, true);
        if (!chat || !chat.isGroup) return res.status(404).json({ success: false, message: 'Groupe non trouve' });

        const groupName = chat.name;
        await activeClient.groupLeave(chat.jid);
        await deleteChatLocal(activeClient, chat.jid);

        if (sessionData) sessionData.addLog('[LEAVE] Bot a quitte le groupe: ' + groupName);
        else addLog('[LEAVE] Bot a quitte le groupe: ' + groupName);
        res.json({ success: true, message: 'Groupe quitte' });
    } catch (error) {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog('[X] Erreur quitter groupe: ' + error.message);
        else addLog('[X] Erreur quitter groupe: ' + error.message);
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

        const chat = await getChatInfo(activeClient, groupId, true);
        if (!chat || !chat.isGroup) return res.status(404).json({ success: false, message: 'Groupe non trouve' });

        const botParticipant = findBotParticipant(activeClient, chat.participants || []);
        if (!botParticipant?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Le bot doit etre admin pour supprimer ce groupe' });
        }

        await activeClient.groupLeave(chat.jid);
        await deleteChatLocal(activeClient, chat.jid);
        if (sessionData) sessionData.addLog('[SUPPR] Groupe supprime (bot etait admin): ' + chat.name);
        else addLog('[SUPPR] Groupe supprime (bot etait admin): ' + chat.name);
        res.json({ success: true, message: 'Groupe quitte (suppression complete non supportee par l API)' });
    } catch (error) {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        if (sessionData) sessionData.addLog('[X] Erreur suppression groupe: ' + error.message);
        else addLog('[X] Erreur suppression groupe: ' + error.message);
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

app.get('/api/groups/participants', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const groupId = req.query.groupId;

        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });
        if (!groupId) return res.status(400).json({ success: false, message: 'groupId requis' });

        await getAllChatsWithOptions(activeClient, { retries: 1, retryDelayMs: 5000 }).catch(() => {});
        const { chat, participants } = await getGroupParticipantsDetailed(activeClient, groupId);
        if (sessionData) sessionData.addLog('[GROUPS] Participants listes: ' + participants.length + ' dans ' + chat.name);
        else addLog('[GROUPS] Participants listes: ' + participants.length + ' dans ' + chat.name);

        res.json({
            success: true,
            sessionId: sessionId || 'global',
            group: { id: chat.jid, name: chat.name, participants: participants.length },
            participants
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
    const job = backgroundJobs.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Tache introuvable ou expiree' });
    if (job.ownerUsername && !req.user?.isAdmin && job.ownerUsername !== req.user?.username) {
        return res.status(403).json({ success: false, message: 'Acces refuse' });
    }
    res.json({ success: true, job: sanitizeBackgroundJob(job) });
});

app.post('/api/groups/message-users', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;

        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });

        const recipients = uniqueRecipients(parseRecipientValues(req.body.recipients));
        const job = startBackgroundBulkMessageJob({
            sock: activeClient,
            sessionData,
            sessionId: sessionId || 'global',
            ownerUsername: req.user?.username,
            recipients,
            message: String(req.body.message || ''),
            options: req.body,
            type: 'group-message-users',
            label: 'Message aux participants selectionnes'
        });
        res.status(202).json({ success: true, background: true, jobId: job.id, sessionId: sessionId || 'global', total: job.total, job });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/whatsapp/bulk-message', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;

        if (!activeClient) return res.status(400).json({ success: false, message: 'Aucune session active' });

        const rawRecipients = [
            ...parseRecipientValues(req.body.numbers),
            ...parseRecipientValues(req.body.recipients)
        ];
        const job = startBackgroundBulkMessageJob({
            sock: activeClient,
            sessionData,
            sessionId: sessionId || 'global',
            ownerUsername: req.user?.username,
            recipients: rawRecipients,
            message: String(req.body.message || ''),
            options: req.body,
            type: 'bulk-whatsapp-message',
            label: 'Envoi WhatsApp cible'
        });
        res.status(202).json({ success: true, background: true, jobId: job.id, sessionId: sessionId || 'global', total: job.total, job });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/users/exceptions', requireAuth, (req, res) => {
    const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.query.sessionId);
    const sessionData = sessionId ? getSessionData(sessionId) : null;
    res.json({ sessionId: sessionId || 'global', ...(sessionData ? sessionData.userExceptions : USER_EXCEPTIONS) });
});

app.post('/api/users/exceptions', requireAuth, async (req, res) => {
    try {
        const sessionId = sessionManager.getEffectiveSessionId(req.user?.username, req.user?.isAdmin, req.body.sessionId);
        const activeClient = sessionId ? sessionManager.sessions.get(sessionId)?.client : sessionManager.getActiveClient();
        const sessionData = sessionId ? getSessionData(sessionId) : null;
        const exceptions = sessionData ? sessionData.userExceptions : USER_EXCEPTIONS;
        
        const { userId, linkException, callException } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'userId requis' });

        const aliases = await resolveUserAliases(activeClient, userId);
        const userIndex = exceptions.excludedUsers.findIndex(u => userExceptionMatches(u, aliases));
        let userEntry = userIndex >= 0 ? exceptions.excludedUsers[userIndex] : null;

        if (userEntry && typeof userEntry !== 'object') {
            userEntry = {
                id: userEntry,
                aliases: buildUserMatchValues(userEntry),
                linkException: true,
                callException: false
            };
            exceptions.excludedUsers[userIndex] = userEntry;
        }

        if (userEntry) {
            if (linkException !== undefined) userEntry.linkException = linkException;
            if (callException !== undefined) userEntry.callException = callException;
            userEntry.aliases = Array.from(new Set([...(userEntry.aliases || []), ...aliases]));
        } else {
            userEntry = {
                id: userId,
                aliases,
                linkException: linkException === true,
                callException: callException === true
            };
            exceptions.excludedUsers.push(userEntry);
        }

        if (callException === true && sessionData && activeClient) {
            const cleared = await clearCallBlocksForValues(activeClient, sessionData, buildUserMatchValues(userId, aliases));
            if (cleared) sessionData.addLog('[UNBLOCK] Exception appels activee, blocage retire pour ' + userId);
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
        const values = buildUserMatchValues(userId);
        exceptions.excludedUsers = exceptions.excludedUsers.filter(u => !userExceptionMatches(u, values));
        
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
        if (!blocked[userId]) return res.status(404).json({ success: false, message: 'Non bloque' });

        await activeClient.updateBlockStatus(normalizeJid(userId), 'unblock');
        ensureRuntime(activeClient).blocklist.delete(normalizeJid(userId));

        if (timers[userId]) {
            clearTimeout(timers[userId]);
            delete timers[userId];
        }

        delete blocked[userId];
        delete tracker[userId];

        if (sessionData) {
            sessionData.saveCallSpamData();
            sessionData.addLog('[UNBLOCK] ' + userId + ' debloque manuellement');
        } else {
            saveCallSpamData();
            addLog('[UNBLOCK] ' + userId + ' debloque manuellement');
        }
        res.json({ success: true, sessionId: sessionId || 'global', message: 'Debloque' });
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

        menus[menuId] = normalizeMenuConfig({ ...menus[menuId], ...req.body, id: menuId }, menus[menuId]);
        
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
            return res.status(404).json({ success: false, message: 'Menu non trouve' });
        }

        const chats = await getAllChats(activeClient);
        let targetChat;

        if (groupId) {
            targetChat = chats.find(c => c.jid === groupId);
            if (!targetChat) targetChat = await getChatInfo(activeClient, groupId, true).catch(() => null);
        } else {
            targetChat = chats.find(c => {
                if (!c.isGroup) return false;
                const bp = findBotParticipant(activeClient, c.participants || []);
                return bp?.isAdmin || bp?.isSuperAdmin;
            });
        }

        if (!targetChat) {
            return res.status(400).json({ success: false, message: 'Aucun groupe disponible' });
        }

        if (!(await canUseInteractiveMenusInChat(targetChat, sessionData))) {
            return res.status(400).json({
                success: false,
                message: 'Le bot doit etre administrateur du groupe pour envoyer ce menu'
            });
        }

        const sent = await sendInteractiveMenu(activeClient, targetChat, menuId, sessionData);
        if (!sent) {
            return res.status(500).json({ success: false, message: 'Menu non envoye' });
        }

        if (sessionData) sessionData.addLog('[TEST] Menu teste: ' + menuId + ' dans ' + targetChat.name);
        else addLog('[TEST] Menu teste: ' + menuId + ' dans ' + targetChat.name);
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
            return res.json({ success: true, groups: [], message: 'Session non connectee' });
        }

        const chats = await getAllChats(sessionClient);
        const adminGroups = [];

        for (const chat of chats.filter(c => c.isGroup)) {
            const botParticipant = findBotParticipant(sessionClient, chat.participants || []);
            const isAdmin = botParticipant?.isAdmin || botParticipant?.isSuperAdmin || false;
            if (isAdmin) {
                adminGroups.push({
                    id: chat.jid,
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
sessionManager.initializeAllSessions().catch(e => addLog('[START] Erreur initialisation sessions: ' + e.message));

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

// Mettre a jour la reference active Baileys
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
console.log('   |- Suppression via Baileys (delete message key)');
console.log('');
console.log('Commandes WhatsApp:');
console.log('   ├─ !help        -> Aide publique');
console.log('   ├─ !status      -> Etat rapide du bot');
console.log('   ├─ !cache       -> Messages connus dans le groupe');
console.log('   ├─ !scan        -> Scanner le groupe actuel');
console.log('   ├─ !scanstatus  -> Scanner seulement les notifications de statut');
console.log('   ├─ !scanall     -> Scanner tous les groupes admin');
console.log('   ├─ !groupinfo   -> Infos du groupe');
console.log('   ├─ !config      -> Configuration active');
console.log('   ├─ !excludehere -> Exclure ce groupe');
console.log('   ├─ !includehere -> Reactiver ce groupe');
console.log('   ├─ !warnings    -> Voir les avertissements');
console.log('   ├─ !resetwarn   -> Effacer les avertissements');
console.log('   ├─ !blocked     -> Voir les numeros bloques');
console.log('   ├─ !unblock     -> Debloquer un numero');
console.log('   ├─ !allowcalls  -> Autoriser les appels');
console.log('   ├─ !diagdelete  -> Diagnostic suppression Baileys');
console.log('   └─ !testdelete  -> Tester la suppression sur un message du bot\n');
