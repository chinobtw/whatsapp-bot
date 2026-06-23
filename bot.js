const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const fs = require('fs');

const { data, FILES, MASTER_NUMBERS, PHONE_NUMBER } = require('./config');
const { isAdmin, saveJSON, getGroupMeta } = require('./modules/utils');
const { shieldModule, targetsGod, GOD_ERROR_MSG } = require('./modules/godmode');
const group   = shieldModule(require('./modules/group'), [
    'handleKick', 'handleMute', 'handleWarn', 'handleDelwarn', 'handleResetwarn'
]);
const gacha   = require('./modules/gacha');
const eco     = require('./modules/economy');
const games   = require('./modules/games');
const media   = require('./modules/media');
const anilist = require('./modules/anilist');
const ai      = require('./modules/ai');
const utilscmds = require('./modules/utilscmds');

const IS_PRIMARY = !process.env.BOT_ID || process.env.BOT_ID === 'bot1';
const instanceManager = IS_PRIMARY ? require('./instance-manager') : null;
const BOT_ID = process.env.BOT_ID || 'bot1';

console.log('BOT CARGADO CON MASTER:', MASTER_NUMBERS);
if (!IS_PRIMARY) console.log(`[${BOT_ID}] Instancia secundaria — #code deshabilitado`);

// ── STATS ─────────────────────────────────────────────────────────────
const STATS_FILE = './msg_stats.json';
if (!global.msgStats) {
    try { global.msgStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
    catch (e) { global.msgStats = {}; }
}
function trackMessage(chatId, senderJid) {
    const key = `${chatId}:${senderJid}`, now = Date.now();
    if (!global.msgStats[key]) global.msgStats[key] = { count: 0, lastReset: now };
    if (now - global.msgStats[key].lastReset > 2592000000) global.msgStats[key] = { count: 1, lastReset: now };
    else global.msgStats[key].count++;
    if (!global.saveStatsTimer) global.saveStatsTimer = setTimeout(() => { fs.writeFileSync(STATS_FILE, JSON.stringify(global.msgStats)); global.saveStatsTimer = null; }, 10000);
}

// ── ANTIFLOOD tracker (in-memory) ─────────────────────────────────────
const floodTracker = {};
function checkFlood(chatId, jid, limit) {
    const key = `${chatId}:${jid}`, now = Date.now();
    if (!floodTracker[key] || now - floodTracker[key].start > 10000) { floodTracker[key] = { count: 1, start: now }; return false; }
    return ++floodTracker[key].count > limit;
}

// ── TRANSLATE ─────────────────────────────────────────────────────────
async function handleTranslate(sock, chatId, rawText, msg) {
    const LANGS = ['en','es','pt','fr','de','it','ja','ko','zh','ru','ar','hi'];
    const input = rawText.replace(/^#translate\s*/i, '').trim();
    const pipeIdx = input.indexOf('|');

    if (pipeIdx === -1) return sock.sendMessage(chatId, { text: '❌ Usá: #translate [origen] [destino] | [texto]\nEj: #translate es en | Hola mundo' }, { quoted: msg });

    const langs = input.slice(0, pipeIdx).trim().toLowerCase().split(/\s+/);
    let q = input.slice(pipeIdx + 1).trim();

    if (langs.length < 2 || !LANGS.includes(langs[0]) || !LANGS.includes(langs[1]))
        return sock.sendMessage(chatId, { text: `❌ Usá dos idiomas válidos.\nEj: #translate es en | Hola mundo\nDisponibles: ${LANGS.join(', ')}` }, { quoted: msg });

    if (langs[0] === langs[1]) return sock.sendMessage(chatId, { text: '❌ El idioma origen y destino no pueden ser iguales.' }, { quoted: msg });

    if (!q) {
        const qt = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        q = qt?.conversation || qt?.extendedTextMessage?.text || '';
    }
    if (!q) return sock.sendMessage(chatId, { text: '❌ Escribí algo para traducir o respondé a un mensaje.' }, { quoted: msg });

    try {
        const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${langs[0]}|${langs[1]}`);
        const json = await res.json();
        const translated = json.responseData?.translatedText;
        if (!translated) throw new Error();
        await sock.sendMessage(chatId, { text: `🌐 *${langs[0].toUpperCase()} → ${langs[1].toUpperCase()}*\n\n${translated}` }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Error al traducir.' }, { quoted: msg });
    }
}

async function startBot() {
    const SESSION_DIR = IS_PRIMARY ? 'session' : `session_${BOT_ID}`;
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, console) },
        logger: require('pino')({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false,
        retryRequestDelayMs: 5000,
        markOnlineOnConnect: false,
        shouldIgnoreJid: jid => jid.endsWith('@broadcast') || jid.endsWith('@newsletter')
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try { const code = await sock.requestPairingCode(PHONE_NUMBER); console.log('\n=== CÓDIGO:', code, '===\n'); }
            catch (e) { console.log('Error código:', e.message); }
        }, 5000);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('Conexión cerrada. Código:', code);
            if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 3000);
        } else if (connection === 'open') { console.log('Bot conectado!'); }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── BIENVENIDA ────────────────────────────────────────────────────
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (action !== 'add' || data.pausedChats[id] || data.welcomeDisabled?.[id]) return;
        if (participants.length > 3) return; // bulk sync (ej: al dar admin), no son ingresos reales
        try {
            const meta = await getGroupMeta(sock, id);
            const desc = meta.desc ? meta.desc.toString() : '';
            for (const p of participants) {
                const jid = typeof p === 'string' ? p : p.id || p;
                const username = jid.split('@')[0];
                const text = data.welcomeMessages[id]
                    ? data.welcomeMessages[id].replace(/\$new/g, `@${username}`).replace(/\$desc/g, desc)
                    : `👋 ¡Bienvenido/a @${username} al grupo!`;
                await sock.sendMessage(id, { text, mentions: [jid] });
            }
        } catch (e) { console.log('Error welcome:', e.message); }
    });

    // ── MENSAJES ──────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

const rawJid = msg.key.remoteJid;
if (rawJid.endsWith('@newsletter')) return;

const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
const isGroup = rawJid.endsWith('@g.us');
const senderJid = msg.key.participant || msg.key.remoteJid;
const sender = msg.key.participantAlt || msg.key.participant || msg.key.remoteJidAlt || msg.key.remoteJid;
const senderNum = sender.split('@')[0].split(':')[0].replace(/\D/g,'');

const chatId = rawJid.endsWith('@lid') ? `${senderNum}@s.whatsapp.net` : rawJid;

// ── Ignorar mensajes viejos (más de 30s), excepto media/IA ──────
const EXEMPT_CMDS = ['#ia', '#ai', '#rp', '#tt', '#mp3', '#mp4', '#fb', '#ig', '#lyrics', '#s', '#toimg', '#pin', '#pinvid', '#anilist', '#manlist', '#manga', '#ytsearch', '#stickerpack', '#ver'];
const firstWord = rawText.trim().toLowerCase().split(' ')[0];
const msgTimestamp = msg.messageTimestamp * 1000;
if (Date.now() - msgTimestamp > 30000 && !EXEMPT_CMDS.includes(firstWord)) return;

        // ── Actividad ─────────────────────────────────────────────────
        if (msg.key.participant) { eco.lastActivity[msg.key.participant] = Date.now(); eco.registerJid(msg.key.participant, senderNum); }
        if (msg.key.participantAlt) eco.registerJid(msg.key.participantAlt, senderNum);
        if (senderNum) eco.lastActivity[senderNum] = Date.now();
        if (isGroup && msg.key.participant) trackMessage(chatId, msg.key.participant);
	if (msg.pushName && senderJid) eco.registerPushName(senderJid, msg.pushName);

        const textLower = rawText.trim().toLowerCase();

        // ── #stop / #go ───────────────────────────────────────────────
        if (textLower === '#stop') { data.pausedChats[chatId] = true; saveJSON(FILES.PAUSED, data.pausedChats); await sock.sendMessage(chatId, { text: '⏸️ Bot pausado.' }, { quoted: msg }); return; }
        if (textLower === '#go')   { delete data.pausedChats[chatId]; saveJSON(FILES.PAUSED, data.pausedChats); await sock.sendMessage(chatId, { text: '▶️ Bot reanudado.' }, { quoted: msg }); return; }
        if (data.pausedChats[chatId]) return;

        // ── MUTE enforcement ──────────────────────────────────────────
        if (isGroup && senderJid && data.muted?.[chatId]?.[senderJid]) {
            if (Date.now() < data.muted[chatId][senderJid]) {
                try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (_) {}
                return;
            } else { delete data.muted[chatId][senderJid]; }
        }

	// ── ANTILINK enforcement ───────────────────────────────────────
        if (isGroup && data.antilink?.[chatId] && /whatsapp\.com\/[A-Za-z0-9\/]+|wa\.me\/\d+/i.test(rawText) && !MASTER_NUMBERS.includes(senderNum)) {
            try {
                const meta = await getGroupMeta(sock, chatId);
                if (!isAdmin(meta, senderJid)) {
                    await sock.sendMessage(chatId, { delete: msg.key });
                    await sock.sendMessage(chatId, { text: `⚠️ @${senderNum} links de grupos no están permitidos.`, mentions: [senderJid] });
		if (data.autowarnDisabled?.[chatId] !== true) {
		    await group.addWarn(sock, chatId, senderJid, 'link externo');
	}
                    return;
                }
            } catch (_) {}
        }

        // ── ANTIFLOOD enforcement ─────────────────────────────────────
        if (isGroup && data.antiflood?.[chatId] && senderJid && !MASTER_NUMBERS.includes(senderNum)) {
            if (checkFlood(chatId, senderJid, data.antiflood[chatId])) {
                try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (_) {}
                return;
            }
        }

        if (!textLower.startsWith('#')) return;

        const cmd = textLower.split(' ')[0];
        const pushName = msg.pushName || senderNum;

        console.log('CMD:', cmd, '| CHAT:', chatId, '| SENDER:', senderNum);

        // ── onlyAdmin (con caché) ─────────────────────────────────────
        if (data.onlyAdminChats[chatId] && isGroup && !MASTER_NUMBERS.includes(senderNum)) {
            const meta = await getGroupMeta(sock, chatId);
            if (!isAdmin(meta, senderJid)) return;
        }

        // ── DISPATCH ──────────────────────────────────────────────────
        switch (cmd) {

case '#menu': {
	await sock.sendMessage(chatId, { text: `‌‌‍‌‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‌‍‌‌‌‌‌‍‌‌‌‍‌‌‌‌‍‌‌‌‌‌‌‍‌‌ㅤ\nㅤ\nㅤㅤㅤㅤ   ㅤ    ㅤㅤㅤㅤ  ㅤ᯽໋࣪\n\nㅤ        ㅤ᯼ㅤㅤㅤㅤٜㅤㅤㅤㅤㅤㅤㅤㅤٜㅤㅤㅤㅤ᯼ㅤㅤㅤㅤㅤㅤㅤㅤ\n\n\nㅤㅤ  ㅤㅤ      ㅤٜٜ۬ㅤ ㅤㅤ𝖳𝗁𝖾 #𝗺𝗲𝗻𝘂. ㅤㅤㅤٜٜ۬\n\n\nㅤㅤㅤᰮㅤㅤㅤ𝖫𝗂𝗌𝗍𝖺 𝖽𝖾 𝖼𝗈𝗆𝖺𝗇𝖽𝗈𝗌 𝗉𝖺𝗋𝖺 𝗍𝗎 𝗎𝗌𝗈. ㅤㅤᰮ\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘈𝘥𝘮𝘪𝘯𝘪𝘴𝘵𝘳𝘢𝘤𝘪𝘰́𝘯\n        —— [#kick]\n> 𝖤𝗑𝗉𝗎𝗅𝗌𝖺 𝖺 𝗎𝗇 𝗎𝗌𝗎𝖺𝗋𝗂𝗈\n        —— [#promote / #demote]\n> 𝖧𝖺𝖼𝖾𝗋 𝗈 𝗊𝗎𝗂𝗍𝖺𝗋 𝖺𝖽𝗆𝗂𝗇\n        —— [#close / #open]\n> 𝖢𝗂𝖾𝗋𝗋𝖺 𝗈 𝖺𝖻𝗋𝖾 𝖾𝗅 𝗀𝗋𝗎𝗉𝗈\n        —— [#onlyadmin]\n> 𝖬𝗈𝖽𝗈 𝗌𝗈𝗅𝗈 𝖺𝖽𝗆𝗂𝗇 𝗈𝗇/𝗈𝖿𝖿\n        —— [#warn / #delwarn / #resetwarn]\n> 𝖠𝖽𝗏𝖾𝗋𝗍𝖾𝗇𝖼𝗂𝖺𝗌\n        —— [#setwarnlimit]\n> 𝖫𝗂́𝗆𝗂𝗍𝖾 𝖽𝖾 𝖺𝖽𝗏𝖾𝗋𝗍𝖾𝗇𝖼𝗂𝖺𝗌\n        —— [#setwelcome / #welcome / #testwelcome]\n> 𝖬𝖾𝗇𝗌𝖺𝗃𝖾 𝖽𝖾 𝖻𝗂𝖾𝗇𝗏𝖾𝗇𝗂𝖽𝖺\n        —— [#tag]\n> 𝖤𝗍𝗂𝗊𝗎𝖾𝗍𝖺𝗋 𝖺 𝗍𝗈𝖽𝗈𝗌\n        —— [#mute / #unmute]\n> 𝖬𝗎𝗍𝖾𝖺𝗋 𝗎𝗌𝗎𝖺𝗋𝗂𝗈\n        —— [#antilink / #autowarn]\n> 𝖡𝗅𝗈𝗊𝗎𝖾𝖺𝗋 𝗅𝗂𝗇𝗄𝗌\n        —— [#antiflood]\n> 𝖫𝗂́𝗆𝗂𝗍𝖾 𝖽𝖾 𝗆𝖾𝗇𝗌𝖺𝗃𝖾𝗌\n        —— [#setrules / #rules]\n> 𝖱𝖾𝗀𝗅𝖺𝗌 𝖽𝖾𝗅 𝗀𝗋𝗎𝗉𝗈\n        —— [#report]\n> 𝖱𝖾𝗉𝗈𝗋𝗍𝖺𝗋 𝗎𝗇 𝗆𝖾𝗇𝗌𝖺𝗃𝖾\n        —— [#info]\n> 𝖨𝗇𝖿𝗈 𝖽𝖾𝗅 𝗀𝗋𝗎𝗉𝗈\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘎𝘢𝘤𝘩𝘢 𝘺 𝘏𝘢𝘳𝘦𝘮\n        —— [#rw]\n> 𝖱𝗈𝗅𝗅𝖾𝖺 𝗎𝗇 𝗉𝖾𝗋𝗌𝗈𝗇𝖺𝗃𝖾\n        —— [#c / #claim]\n> 𝖱𝖾𝖼𝗅𝖺𝗆𝖺 𝖾𝗅 𝗉𝖾𝗋𝗌𝗈𝗇𝖺𝗃𝖾 𝖺𝖼𝗍𝗂𝗏𝗈\n        —— [#harem]\n> 𝖵𝖾𝗋 𝖼𝗈𝗅𝖾𝖼𝖼𝗂𝗈́𝗇\n        —— [#trade]\n> 𝖨𝗇𝗍𝖾𝗋𝖼𝖺𝗆𝖻𝗂𝗈 𝖽𝖾 𝗉𝖾𝗋𝗌𝗈𝗇𝖺𝗃𝖾𝗌\n        —— [#regalar]\n> 𝖱𝖾𝗀𝖺𝗅𝖺𝗋 𝗎𝗇 𝗉𝖾𝗋𝗌𝗈𝗇𝖺𝗃𝖾\n        —— [#aceptar]\n> 𝖠𝖼𝖾𝗉𝗍𝖺𝗋 𝗍𝗋𝖺𝖽𝖾 𝗈 𝖽𝗎𝖾𝗅𝗈\n        —— [#setclaim / #setcooldown]\n> 𝖢𝗈𝗇𝖿𝗂𝗀𝗎𝗋𝖺𝖼𝗂𝗈́𝗇 𝖽𝖾 𝗀𝖺𝖼𝗁𝖺\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘌𝘤𝘰𝘯𝘰𝘮𝘪́𝘢\n        —— [#baltop]\n> 𝖳𝗈𝗉 𝗆𝗂𝗅𝗅𝗈𝗇𝖺𝗋𝗂𝗈𝗌\n        —— [#bal / #balance]\n> 𝖵𝖾𝗋 𝗌𝖺𝗅𝖽𝗈\n        —— [#dep / #with]\n> 𝖣𝖾𝗉𝗈𝗌𝗂𝗍𝖺𝗋 𝗈 𝗋𝖾𝗍𝗂𝗋𝖺𝗋\n        —— [#work / #crime / #slut]\n> 𝖦𝖺𝗇𝖺𝗋 𝗉𝗅𝖺𝗍𝖺\n        —— [#rob]\n> 𝖱𝗈𝖻𝖺𝗋 𝖺 𝗎𝗇 𝗎𝗌𝗎𝖺𝗋𝗂𝗈\n        —— [#pay]\n> 𝖳𝗋𝖺𝗇𝗌𝖿𝖾𝗋𝗂𝗋 𝗉𝗅𝖺𝗍𝖺\n        —— [#daily]\n> 𝖱𝖾𝖼𝗅𝖺𝗆𝗈 𝖽𝗂𝖺𝗋𝗂𝗈\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘈𝘱𝘶𝘦𝘴𝘵𝘢𝘴\n        —— [#cf]\n> 𝖢𝖺𝗋𝖺 𝗈 𝖼𝗋𝗎𝗓\n        —— [#rt]\n> 𝖱𝗎𝗅𝖾𝗍𝖺\n        —— [#blackjack]\n> 𝖨𝗇𝗂𝖼𝗂𝖺𝗋 𝗃𝗎𝖾𝗀𝗈\n        —— [#slot]\n> 𝖳𝗋𝖺𝗀𝖺𝗆𝗈𝗇𝖾𝖽𝖺𝗌\n        —— [#duelo]\n> 𝖣𝗎𝖾𝗅𝗈 𝟣𝗏𝟣\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘋𝘦𝘴𝘤𝘢𝘳𝘨𝘢𝘴\n        —— [#tt]\n> 𝖵𝗂𝖽𝖾𝗈 𝖳𝗂𝗄𝖳𝗈𝗄\n        —— [#mp3]\n> 𝖠𝗎𝖽𝗂𝗈 𝖸𝗈𝗎𝖳𝗎𝖻𝖾\n        —— [#mp4]\n> 𝖵𝗂𝖽𝖾𝗈 𝖼𝗎𝖺𝗅𝗊𝗎𝗂𝖾𝗋 𝗉𝗅𝖺𝗍𝖺𝖿𝗈𝗋𝗆𝖺\n        —— [#fb]\n> 𝖵𝗂𝖽𝖾𝗈 𝖥𝖺𝖼𝖾𝖻𝗈𝗈𝗄\n        —— [#ig]\n> 𝖵𝗂𝖽𝖾𝗈 𝖨𝗇𝗌𝗍𝖺𝗀𝗋𝖺𝗆\n        —— [#pin / #pinvid]\n> 𝖨𝗆𝖺𝗀𝖾𝗇/𝖵𝗂𝖽𝖾𝗈 𝖯𝗂𝗇𝗍𝖾𝗋𝖾𝗌𝗍\n        —— [#ytsearch]\n> 𝖡𝗎𝗌𝖼𝖺𝗋 𝖾𝗇 𝖸𝗈𝗎𝖳𝗎𝖻𝖾\n        —— [#lyrics]\n> 𝖫𝖾𝗍𝗋𝖺 𝖽𝖾 𝖼𝖺𝗇𝖼𝗂𝗈́𝗇\n        —— [#manga]\n> 𝖣𝖾𝗌𝖼𝖺𝗋𝗀𝖺𝗋 𝗆𝖺𝗇𝗀𝖺 𝖾𝗇 𝖯𝖣𝖥\n        —— [#stickerpack]\n> 𝖣𝖾𝗌𝖼𝖺𝗋𝗀𝖺𝗋 𝗉𝖺𝖼𝗄 𝖽𝖾 𝗌𝗍𝗂𝖼𝗄𝖾𝗋𝗌\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘜𝘵𝘪𝘭𝘴\n        —— [#s / #toimg / #ver]\n> 𝖲𝗍𝗂𝖼𝗄𝖾𝗋𝗌\n        —— [#ia / #ai]\n> 𝖧𝖺𝖻𝗅𝖺𝗋 𝖼𝗈𝗇 𝖨𝖠\n        —— [#rp]\n> 𝖱𝗈𝗅𝖾𝗉𝗅𝖺𝗒 𝖼𝗈𝗇 𝖨𝖠\n        —— [#anilist / #manlist]\n> 𝖨𝗇𝖿𝗈 𝖺𝗇𝗂𝗆𝖾/𝗆𝖺𝗇𝗀𝖺\n        —— [#translate]\n> 𝖳𝗋𝖺𝖽𝗎𝖼𝗂𝗋 𝗍𝖾𝗑𝗍𝗈\n        —— [#calc]\n> 𝖢𝖺𝗅𝖼𝗎𝗅𝖺𝖽𝗈𝗋𝖺\n        —— [#clima]\n> 𝖢𝗅𝗂𝗆𝖺 𝖺𝖼𝗍𝗎𝖺𝗅\n        —— [#define]\n> 𝖣𝖾𝖿𝗂𝗇𝗂𝖼𝗂𝗈́𝗇 𝖽𝖾 𝗉𝖺𝗅𝖺𝖻𝗋𝖺\n        —— [#qr]\n> 𝖦𝖾𝗇𝖾𝗋𝖺𝗋 𝖢𝖱\n        —— [#topactive / #topinactive / #count]\n> 𝖱𝖺𝗇𝗄𝗂𝗇𝗀 𝖽𝖾 𝖺𝖼𝗍𝗂𝗏𝗂𝖽𝖺𝖽\n        —— [#ping]\n> 𝖫𝖺𝗍𝖾𝗇𝖼𝗂𝖺 𝖽𝖾𝗅 𝖻𝗈𝗍\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ𝘋𝘶𝘦𝘯̃𝘰\n        —— [#reload]\n> 𝖱𝖾𝗂𝗇𝗂𝖼𝗂𝖺𝗋\n        —— [#stop / #go]\n> 𝖯𝖺𝗎𝗌𝖺𝗋/𝖱𝖾𝖺𝖼𝗍𝗂𝗏𝖺𝗋\n        —— [#gift / #rest]\n> 𝖣𝖺𝗋/𝗊𝗎𝗂𝗍𝖺𝗋 𝗉𝗅𝖺𝗍𝖺\n        —— [#clear / #clearall]\n> 𝖱𝖾𝗌𝖾𝗍𝖾𝖺𝗋 𝖾𝖼𝗈𝗇𝗈𝗆𝗂́𝖺/𝗁𝖺𝗋𝖾𝗆\n\nㅤㅤㅤ ♥︎ㅤㅤㅤㅤٜㅤㅤㅤㅤㅤㅤㅤㅤٜㅤㅤㅤㅤ♥︎\n\n\nㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ  ㅤٜ۪۪ׄ۫` }, { quoted: msg });
    break;
}

            case '#reload': {
                if (!MASTER_NUMBERS.includes(senderNum)) break;
                await sock.sendMessage(chatId, { text: '🔄 Reiniciando...' }, { quoted: msg });
                const reloadTarget = IS_PRIMARY ? 'whatsapp-bot' : BOT_ID;
                setTimeout(() => exec(`pm2 stop ${reloadTarget} && pm2 start ${reloadTarget}`), 2000);
                break;
            }

            // ── VINCULACIÓN (solo bot principal) ──────────────────────
            case '#code': {
                if (!IS_PRIMARY) { await sock.sendMessage(chatId, { text: '❌ Este comando solo está disponible en el bot principal.' }, { quoted: msg }); break; }
                if (isGroup) { await sock.sendMessage(chatId, { text: '❌ Usá este comando por privado.' }, { quoted: msg }); break; }
                await instanceManager.createInstance(senderNum, sock, chatId, msg);
                break;
            }
            case '#unlink': {
                if (!IS_PRIMARY) { await sock.sendMessage(chatId, { text: '❌ Este comando solo está disponible en el bot principal.' }, { quoted: msg }); break; }
                if (isGroup) { await sock.sendMessage(chatId, { text: '❌ Usá este comando por privado.' }, { quoted: msg }); break; }
                await instanceManager.removeInstance(senderNum, sock, chatId, msg);
                break;
            }
            case '#instances': {
                if (!IS_PRIMARY || !MASTER_NUMBERS.includes(senderNum)) break;
                await instanceManager.listInstances(sock, chatId, msg);
                break;
            }
            case '#clearcmt': if (isGroup) await group.handleClearCmt(sock, chatId, msg, senderNum); break;

            // ── GRUPO ─────────────────────────────────────────────────
            case '#onlyadmin':   if (isGroup) await group.handleOnlyAdmin(sock, chatId, msg, rawText, senderNum); break;
            case '#kick':        if (isGroup) await group.handleKick(sock, chatId, msg, senderNum); break;
	    case '#promote':     if (isGroup) await group.handlePromoteDemote(sock, chatId, msg, rawText, senderNum); break;
            case '#demote': {
                if (isGroup) {
                    if (targetsGod(msg)) { await sock.sendMessage(chatId, { text: GOD_ERROR_MSG }, { quoted: msg }); break; }
                    await group.handlePromoteDemote(sock, chatId, msg, rawText, senderNum);
                }
                break;
            }
	    case '#ver':                      await media.handleVer(sock, chatId, msg); break;
            case '#close':
            case '#open':        if (isGroup) await group.handleCloseOpen(sock, chatId, msg, rawText, senderNum); break;
	    case '#agg': if (isGroup) await group.handleAgg(sock, chatId, msg, rawText, senderNum); break;
            case '#tag':         if (isGroup) await group.handleTag(sock, chatId, msg, rawText, senderNum); break;
            case '#warn':        if (isGroup) await group.handleWarn(sock, chatId, msg, rawText, senderNum); break;
            case '#delwarn':     if (isGroup) await group.handleDelwarn(sock, chatId, msg, rawText, senderNum); break;
            case '#resetwarn':   if (isGroup) await group.handleResetwarn(sock, chatId, msg, senderNum); break;
            case '#setwarnlimit':if (isGroup) await group.handleSetwarnlimit(sock, chatId, msg, rawText, senderNum); break;
            case '#setwelcome':  if (isGroup) await group.handleSetwelcome(sock, chatId, msg, rawText, senderNum); break;
            case '#welcome':     if (isGroup) await group.handleWelcomeToggle(sock, chatId, msg, rawText, senderNum); break;
            case '#testwelcome': if (isGroup) await group.handleTestwelcome(sock, chatId, msg, senderNum); break;
            case '#topactive':   if (isGroup) await group.handleTopActive(sock, chatId, msg); break;
            case '#topinactive': if (isGroup) await group.handleTopInactive(sock, chatId, msg, rawText); break;
	    case '#count':
    if (isGroup) {
        console.log('TARGET:', msg.message?.extendedTextMessage?.contextInfo?.participant);
        console.log('STATS KEYS:', Object.keys(global.msgStats || {}).filter(k => k.startsWith(chatId)).slice(0, 5));
        await group.handleCount(sock, chatId, msg);
    }
    break;
            case '#mute':        if (isGroup) await group.handleMute(sock, chatId, msg, rawText, senderNum); break;
            case '#unmute':      if (isGroup) await group.handleUnmute(sock, chatId, msg, senderNum); break;
            case '#antilink':    if (isGroup) await group.handleAntilink(sock, chatId, msg, rawText, senderNum); break;
	    case '#autowarn':    if (isGroup) await group.handleAutowarn(sock, chatId, msg, rawText, senderNum); break;
            case '#antiflood':   if (isGroup) await group.handleAntiflood(sock, chatId, msg, rawText, senderNum); break;
            case '#setrules':    if (isGroup) await group.handleSetrules(sock, chatId, msg, rawText, senderNum); break;
            case '#rules':       if (isGroup) await group.handleRules(sock, chatId, msg); break;
            case '#report':      if (isGroup) await group.handleReport(sock, chatId, msg, rawText, senderNum); break;
            case '#info':        if (isGroup) await group.handleInfo(sock, chatId, msg); break;
	    case '#calc':                     await utilscmds.handleCalc(sock, chatId, rawText, msg); break;
            case '#clima':                    await utilscmds.handleClima(sock, chatId, rawText, msg); break;
	    case '#define':                   await utilscmds.handleDefine(sock, chatId, rawText, msg); break;
	    case '#qr':                       await utilscmds.handleQR(sock, chatId, rawText, msg); break;

            // ── GACHA ─────────────────────────────────────────────────
            case '#rw':          if (isGroup) gacha.rollWaifu(sock, chatId, msg.key.participant); break;
            case '#c':
            case '#claim':       if (isGroup) gacha.claimWaifu(sock, chatId, msg.key.participant, pushName); break;
            case '#harem':       { await gacha.showHarem(sock, chatId, msg.key.participant, pushName, msg); break; }
            case '#setclaim': {
                if (isGroup) { const meta = await getGroupMeta(sock, chatId); await gacha.setClaimMsg(sock, chatId, msg.key.participant, rawText, meta, isAdmin); }
                break;
            }
            case '#setcooldown': if (MASTER_NUMBERS.includes(senderNum)) await gacha.setCooldown(sock, chatId, rawText); break;
	    case '#regalar': if (isGroup) await gacha.handleRegalar(sock, chatId, senderJid, senderNum, pushName, rawText, msg); break;

            // ── ECONOMÍA ──────────────────────────────────────────────
            case '#baltop':   await eco.handleBaltop(sock, chatId, msg); break;
            case '#bal':
            case '#balance':  await eco.handleBalance(sock, chatId, senderNum, pushName, msg); break;
            case '#dep':
            case '#deposit':  await eco.handleDeposit(sock, chatId, senderNum, rawText, msg); break;
            case '#with':
            case '#withdraw': await eco.handleWithdraw(sock, chatId, senderNum, rawText, msg); break;
            case '#crime':    await eco.handleCrime(sock, chatId, senderNum, pushName, msg); break;
            case '#slut':     await eco.handleSlut(sock, chatId, senderNum, pushName, msg); break;
            case '#work':
            case '#w':        await eco.handleWork(sock, chatId, senderNum, pushName, msg); break;
            case '#rob':      await eco.handleRob(sock, chatId, senderNum, pushName, msg); break;
            case '#pay':      await eco.handlePay(sock, chatId, senderNum, pushName, rawText, msg); break;
            case '#daily':    await eco.handleDaily(sock, chatId, senderNum, pushName, msg); break;
            case '#clear': {
                if (!MASTER_NUMBERS.includes(senderNum)) { sock.sendMessage(chatId, { text: '❌ Solo el dueño.' }, { quoted: msg }); break; }
                await eco.handleClear(sock, chatId, senderNum, rawText, msg); break;
            }
            case '#clearall': {
                if (!MASTER_NUMBERS.includes(senderNum)) { sock.sendMessage(chatId, { text: '❌ Solo el dueño.' }, { quoted: msg }); break; }
                await eco.handleClearAll(sock, chatId, msg); break;
            }
case '#gift': {
    if (!MASTER_NUMBERS.includes(senderNum)) { sock.sendMessage(chatId, { text: '❌ Solo el dueño.' }, { quoted: msg }); break; }
    await eco.handleGift(sock, chatId, senderNum, rawText, msg); break;
}
case '#rest': {
    if (!MASTER_NUMBERS.includes(senderNum)) { sock.sendMessage(chatId, { text: '❌ Solo el dueño.' }, { quoted: msg }); break; }
    await eco.handleRest(sock, chatId, senderNum, rawText, msg); break;
}


            // ── APUESTAS ──────────────────────────────────────────────
            case '#cf':        await games.handleCF(sock, chatId, senderNum, pushName, rawText, msg); break;
            case '#rt':        await games.handleRT(sock, chatId, senderNum, pushName, rawText, msg); break;
            case '#blackjack': await games.handleBlackjack(sock, chatId, senderNum, pushName, rawText, msg); break;
            case '#apost':     await games.handleApost(sock, chatId, senderNum, msg); break;
            case '#stand':     await games.handleStand(sock, chatId, senderNum, msg); break;
            case '#slot':      await games.handleSlot(sock, chatId, senderNum, pushName, rawText, msg); break;
            case '#duelo':     await games.handleDuelo(sock, chatId, senderNum, senderJid, pushName, rawText, msg); break;
            case '#aceptar': {
	    const tradHandled = await gacha.handleAceptarTrade(sock, chatId, senderJid, msg);
	    if (!tradHandled) await games.handleAceptar(sock, chatId, senderJid, senderNum, pushName, msg);
	    break;
	    }
            case '#trade': if (isGroup) await gacha.handleTrade(sock, chatId, senderJid, senderNum, pushName, rawText, msg); break;

            // ── ANILIST ───────────────────────────────────────────────
            case '#anilist': anilist.handleAnilist(sock, chatId, rawText.replace(/#anilist/i,'').trim(), msg); break;
            case '#manlist': anilist.handleManga(sock, chatId, rawText.replace(/#manlist/i,'').trim(), msg); break;

            // ── TRANSLATE ─────────────────────────────────────────────
            case '#translate': await handleTranslate(sock, chatId, rawText, msg); break;

            // ── MEDIA & IA ────────────────────────────────────────────
	    case '#manga': await media.handleManga(sock, chatId, rawText, msg); break;
case '#ia':
case '#ai': await ai.handleGemini(sock, chatId, senderJid, rawText, msg); break;
case '#rp': await ai.handleRp(sock, chatId, senderJid, pushName, rawText, msg); break;
            case '#tt':     await media.handleTT(sock, chatId, rawText, msg); break;
            case '#mp3': {
                const q = rawText.slice(4).trim();
                if (!q) { sock.sendMessage(chatId, { text: '❌ Ej: #mp3 despacito' }, { quoted: msg }); break; }
                await media.handleMp3(sock, chatId, q, msg); break;
            }
	    case '#ytsearch': {
	    const q = rawText.slice(10).trim();
	        await media.handleYtSearch(sock, chatId, q, msg);
	    break;
	    }
            case '#lyrics': {
                const q = rawText.slice(7).trim();
                if (!q) { sock.sendMessage(chatId, { text: '❌ Ej: #lyrics Bohemian Rhapsody' }, { quoted: msg }); break; }
                await media.handleLyrics(sock, chatId, q, msg); break;
            }
            case '#s':      await media.handleSticker(sock, chatId, msg); break;
            case '#toimg':  await media.handleToImg(sock, chatId, msg); break;
            case '#pin': {
                const q = rawText.slice(4).trim();
                if (q) media.handlePin(sock, chatId, q, 'img', msg); break;
            }
            case '#pinvid': {
                const q = rawText.slice(7).trim();
                if (q) media.handlePin(sock, chatId, q, 'vid', msg); break;
            }
	    case '#fb':  await media.handleFb(sock, chatId, rawText, msg); break;
	    case '#ig':  await media.handleIg(sock, chatId, rawText, msg); break;
	    case '#mp4': await media.handleMp4(sock, chatId, rawText, msg); break;
	    case '#stickerpack': await media.handleStickerPack(sock, chatId, rawText, msg); break;

            // ── PING ──────────────────────────────────────────────────
            case '#ping':
            case '#p': {
                const start = Date.now();
                await sock.sendMessage(chatId, { text: '🏓 *Pong!*' }, { quoted: msg });
                sock.sendMessage(chatId, { text: `> ${Date.now() - start}ms` }, { quoted: msg });
                break;
            }

            case '#femboyhot':
            case '#fh': {
                await sock.sendMessage(chatId, { text: '*🔥 ¿Buscas un femboysito caliente para satisfacer tus fetiches cochinos? ¡Aquí está! 🔥*\n*¡¡¡Femboysito caliente a tu disposición!!!*\n> *Te esperan: ¡+502 3482 1492! 🍑🍆*\n> ㅤ          ㅤ ㅤ *¡+593 96 339 6698! 🍑🍆*\n> ㅤ          ㅤ ㅤ *¡+54 9 11 5501-5701! 🍑🍆*\n_(Preguntá por Abraham, Keyla y por Jazz Boun Claus. Este último se viste de conejito travieso 🔥)_' }, { quoted: msg });
                break;
            }
        }
    });
}

startBot();
