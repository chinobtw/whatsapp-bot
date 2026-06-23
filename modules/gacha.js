const axios = require('axios');
const { data, FILES, DEFAULT_RW_CD, DEFAULT_CLAIM_CD } = require('../config');
const { saveJSON, fmt } = require('./utils');

const activeRolls = {};

async function fetchPinterestImage(query) {
    try {
        const { exec } = require('child_process');
        const COOKIE_FILE = require('../config').COOKIE_FILE;
        const searchUrl = `https://ar.pinterest.com/search/pins/?q=${encodeURIComponent(query + ' anime')}`;
        const rawOutput = await new Promise((resolve) => {
            exec(`gallery-dl -j --range 1-10 --cookies "${COOKIE_FILE}" "${searchUrl}"`,
                { timeout: 20000, maxBuffer: 5 * 1024 * 1024 },
                (err, stdout) => resolve(err ? '' : stdout)
            );
        });
        if (!rawOutput) return null;
        const items = JSON.parse(rawOutput);
        const pins = items.filter(i => i[0] === 3).map(i => i[2]?.images?.orig?.url || i[1]).filter(Boolean);
        return pins[0] || null;
    } catch (e) { return null; }
}

function getTier() {
    const r = Math.random();
    if (r < 0.15) return { pageMin: 1,  pageMax: 5,  value: 20000 };
    if (r < 0.45) return { pageMin: 6,  pageMax: 25, value: 15000 };
    return           { pageMin: 26, pageMax: 50, value: Math.floor(Math.random() * 7001) + 3000 };
}

async function rollWaifu(sock, chatId, senderJid) {
    const now = Date.now();
    const rwCd = data.gachaCooldowns[chatId]?.rw || DEFAULT_RW_CD;
    const lastRoll = data.gachaCooldowns[`${chatId}:${senderJid}:lastRoll`] || 0;
    const rollDiff = rwCd - (now - lastRoll);
    if (rollDiff > 0) {
        const mins = Math.floor(rollDiff / 60000);
        const secs = Math.floor((rollDiff % 60000) / 1000);
        return sock.sendMessage(chatId, { text: `⏳ Esperá ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`} para usar #rw de nuevo.` });
    }

    await sock.sendMessage(chatId, { text: '🎲 Rolleando personaje...' });

    const claimedInChat = new Set(data.claimedChars[chatId] || []);
    const tier = getTier();

    try {
        let char = null;
        let intentos = 0;

        while (!char && intentos < 5) {
            intentos++;
            const page = Math.floor(Math.random() * (tier.pageMax - tier.pageMin + 1)) + tier.pageMin;
            const graphqlQuery = `
            query ($page: Int) {
                Page(page: $page, perPage: 5) {
                    characters(sort: FAVOURITES_DESC) {
                        id
                        name { full }
                        image { large }
                        gender
                        media(perPage: 1) { nodes { title { romaji english } } }
                        siteUrl
                    }
                }
            }`;
            const { data: res } = await axios.post('https://graphql.anilist.co', { query: graphqlQuery, variables: { page } }, { timeout: 15000 });
            const chars = res.data.Page.characters || [];
            const disponibles = chars.filter(c => !claimedInChat.has(String(c.id)));
            if (disponibles.length > 0) char = disponibles[Math.floor(Math.random() * disponibles.length)];
        }

        if (!char) return sock.sendMessage(chatId, { text: '❌ No se pudo obtener un personaje disponible. Intentá de nuevo.' });

        const nombre = char.name.full;
        const genero = char.gender || 'Desconocido';
        const anime = char.media.nodes[0]?.title.english || char.media.nodes[0]?.title.romaji || 'Desconocido';
        const url = char.siteUrl;

        let imagen = await fetchPinterestImage(`${nombre} ${anime}`);
        if (!imagen) imagen = char.image.large;

        activeRolls[chatId] = {
            char: { id: char.id, nombre, imagen, genero, anime, url, value: tier.value },
            timestamp: now,
            rollerJid: senderJid, // Guardamos quién lo rolleó
            claimedBy: null, 
            claimedName: null
        };
        data.gachaCooldowns[`${chatId}:${senderJid}:lastRoll`] = now;
        saveJSON(FILES.GACHA_CD, data.gachaCooldowns);

        // Aumentado a 120s
        setTimeout(() => {
            if (activeRolls[chatId] && !activeRolls[chatId].claimedBy && activeRolls[chatId].timestamp === now) {
                delete activeRolls[chatId];
                sock.sendMessage(chatId, { text: `⌛ ¡*${nombre}* expiró sin ser reclamado!` });
            }
        }, 120000);

        await sock.sendMessage(chatId, {
            image: { url: imagen },
            caption: `✨ *${nombre}*\n\n⚧ Género: ${genero}\n📺 Anime: ${anime}\n💎 Valor: ${fmt(tier.value)}\n\n_Tenés exclusividad por 60s para usar #c. A los 120s expira._`
        });

    } catch (err) {
        console.error('RW error:', err.message);
        sock.sendMessage(chatId, { text: '❌ Error obteniendo personaje.' });
    }
}

async function claimWaifu(sock, chatId, senderJid, pushName) {
    const now = Date.now();
    const roll = activeRolls[chatId];

    if (!roll) return sock.sendMessage(chatId, { text: '❌ No hay ningún personaje activo para reclamar.' });
    if (roll.claimedBy) return sock.sendMessage(chatId, { text: `❌ *${roll.char.nombre}* ya fue reclamado por ${roll.claimedName}.` });
    
    const diff = now - roll.timestamp;
    
    // Si pasaron menos de 60s, solo el que lo pidió puede reclamarlo
    if (diff < 60000 && senderJid !== roll.rollerJid) {
        const faltan = Math.ceil((60000 - diff) / 1000);
        return sock.sendMessage(chatId, { text: `🛡️ Personaje protegido, esperá ${faltan} segundos para robarlo.` });
    }

    if (diff > 120000) {
        delete activeRolls[chatId];
        return sock.sendMessage(chatId, { text: `⌛ *${roll.char.nombre}* expiró. Hacé #rw para un nuevo personaje.` });
    }

    const claimCd = data.gachaCooldowns[chatId]?.claim || DEFAULT_CLAIM_CD;
    const lastClaim = data.gachaCooldowns[`${chatId}:${senderJid}:lastClaim`] || 0;
    const claimDiff = claimCd - (now - lastClaim);
    if (claimDiff > 0) {
        const mins = Math.floor(claimDiff / 60000);
        const secs = Math.floor((claimDiff % 60000) / 1000);
        return sock.sendMessage(chatId, { text: `⏳ Esperá ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`} para reclamar de nuevo.` });
    }

    roll.claimedBy = senderJid;
    roll.claimedName = pushName;

    const haremKey = `${chatId}:${senderJid}`;
    if (!data.harem[haremKey]) data.harem[haremKey] = [];

    const yaEnHarem = data.harem[haremKey].some(c => String(c.id) === String(roll.char.id));
    if (!yaEnHarem) {
        data.harem[haremKey].push({ ...roll.char, claimedAt: new Date().toLocaleDateString('es-AR'), claimedName: pushName });
        saveJSON(FILES.HAREM, data.harem);
    }

    if (!data.claimedChars[chatId]) data.claimedChars[chatId] = [];
    if (!data.claimedChars[chatId].includes(String(roll.char.id))) {
        data.claimedChars[chatId].push(String(roll.char.id));
        saveJSON(FILES.CLAIMED_CHARS, data.claimedChars);
    }

    data.gachaCooldowns[`${chatId}:${senderJid}:lastClaim`] = now;
    saveJSON(FILES.GACHA_CD, data.gachaCooldowns);
    delete activeRolls[chatId];

    const claimTemplate = data.claimMessages[chatId] || '💖 ¡*$char* ahora forma parte del harem de $user!';
    await sock.sendMessage(chatId, {
        text: claimTemplate.replace(/\$char/g, roll.char.nombre).replace(/\$user/g, pushName),
        mentions: [senderJid]
    });
}

async function showHarem(sock, chatId, senderJid, pushName, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const jid       = targetJid || senderJid;
    const nombre    = targetJid ? `@${targetJid.split('@')[0]}` : pushName;

    const userHarem = data.harem[`${chatId}:${jid}`] || [];
    if (!userHarem.length) return sock.sendMessage(chatId, {
        text: targetJid ? `💔 ${nombre} no tiene personajes en este grupo.` : '💔 Tu harem está vacío. Usá #rw para conseguir personajes.',
        mentions: targetJid ? [targetJid] : []
    }, { quoted: msg });

    const lista = userHarem.map((c, i) => `${i + 1}. *${c.nombre}* (${fmt(c.value || 10000)}) — ${c.anime}`).join('\n');
    await sock.sendMessage(chatId, {
        text: `💖 *Harem de ${nombre}*\n\n${lista}`,
        mentions: targetJid ? [targetJid] : [senderJid]
    }, { quoted: msg });
}

async function setClaimMsg(sock, chatId, senderJid, text, groupMetadata, isAdmin) {
    if (!isAdmin(groupMetadata, senderJid)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' });
    const mensaje = text.replace('#setclaim', '').trim();
    if (!mensaje) return sock.sendMessage(chatId, { text: 'Usá: #setclaim $char ha sido raptado por $user\nVariables: $char = personaje, $user = nombre' });
    data.claimMessages[chatId] = mensaje;
    saveJSON(FILES.CLAIM_MSGS, data.claimMessages);
    return sock.sendMessage(chatId, { text: '✅ Mensaje de claim guardado.' });
}

async function setCooldown(sock, chatId, text) {
    const parts = text.split(' ');
    const tipo = parts[1]?.toLowerCase();
    const cantidad = parseInt(parts[2]);
    const unidad = parts[3]?.toLowerCase();
    if (!['rw', 'claim'].includes(tipo) || isNaN(cantidad) || !['m', 's'].includes(unidad)) {
        return sock.sendMessage(chatId, { text: 'Usá: #setcooldown rw 15 M o #setcooldown claim 30 M' });
    }
    const ms = unidad === 'm' ? cantidad * 60000 : cantidad * 1000;
    if (!data.gachaCooldowns[chatId]) data.gachaCooldowns[chatId] = {};
    data.gachaCooldowns[chatId][tipo] = ms;
    saveJSON(FILES.GACHA_CD, data.gachaCooldowns);
    return sock.sendMessage(chatId, { text: `✅ Cooldown de #${tipo} establecido en ${cantidad}${unidad.toUpperCase()}.` });
}

const pendingTrades = new Map();

async function handleTrade(sock, chatId, senderJid, senderNum, pushName, rawText, msg) {
    const input = rawText.replace(/^#trade\s*/i, '').trim();
    const parts = input.split(/\s*[|\/]\s*/);
    if (parts.length !== 2) return sock.sendMessage(chatId, { text: '❌ Usá: #trade [tu personaje] | [personaje que querés]' }, { quoted: msg });

    const myCharName  = parts[0].trim();
    const hisCharName = parts[1].trim();
    if (!myCharName || !hisCharName) return sock.sendMessage(chatId, { text: '❌ Especificá ambos personajes.' }, { quoted: msg });

    // Verificar que sender tiene myChar
    const myHarem = data.harem[`${chatId}:${senderJid}`] || [];
    const myChar  = myHarem.find(c => c.nombre.toLowerCase() === myCharName.toLowerCase());
    if (!myChar) return sock.sendMessage(chatId, { text: `❌ No tenés a *${myCharName}* en tu harem.` }, { quoted: msg });

    // Buscar quién tiene hisChar en el grupo
    let targetJid = null, hisChar = null;
    for (const [key, harem] of Object.entries(data.harem)) {
        if (!key.startsWith(chatId + ':')) continue;
        const found = harem.find(c => c.nombre.toLowerCase() === hisCharName.toLowerCase());
        if (found) {
            targetJid = key.split(':').slice(1).join(':');
            hisChar = found;
            break;
        }
    }

    if (!targetJid || !hisChar) return sock.sendMessage(chatId, { text: `❌ Nadie en este grupo tiene a *${hisCharName}*.` }, { quoted: msg });
    if (targetJid === senderJid) return sock.sendMessage(chatId, { text: '❌ Ese personaje ya es tuyo.' }, { quoted: msg });

    const targetNum = targetJid.split('@')[0].replace(/\D/g, '');
    const tradeKey  = `${chatId}:${targetJid}`;
    const tradeInfo = { senderJid, senderNum, pushName, targetJid, myChar, hisChar, expiry: Date.now() + 60000 };
    pendingTrades.set(tradeKey, tradeInfo);

    setTimeout(() => {
        if (pendingTrades.get(tradeKey)?.expiry === tradeInfo.expiry) {
            pendingTrades.delete(tradeKey);
            sock.sendMessage(chatId, { text: `⏰ El trade de *${myChar.nombre}* por *${hisChar.nombre}* expiró.` });
        }
    }, 60000);

    await sock.sendMessage(chatId, {
        text: `🔄 @${targetNum}, ¡@${senderNum} te propuso un intercambio!\n> Personaje a dar: *${hisChar.nombre}*\n> Personaje a recibir: *${myChar.nombre}*\n\n_Respondé a este mensaje con *#aceptar* para aceptar. Vence en 60 segundos._`,
        mentions: [targetJid, `${senderNum}@s.whatsapp.net`]
    }, { quoted: msg });
}

async function handleAceptarTrade(sock, chatId, senderJid, msg) {
    const tradeKey = `${chatId}:${senderJid}`;
    const trade = pendingTrades.get(tradeKey);
    if (!trade) return false;
    if (Date.now() > trade.expiry) {
        pendingTrades.delete(tradeKey);
        await sock.sendMessage(chatId, { text: '❌ El trade expiró.' }, { quoted: msg });
        return true;
    }
    pendingTrades.delete(tradeKey);

    const senderHaremKey = `${chatId}:${trade.senderJid}`;
    const targetHaremKey = `${chatId}:${senderJid}`;

    data.harem[senderHaremKey] = (data.harem[senderHaremKey] || []).filter(c => String(c.id) !== String(trade.myChar.id));
    data.harem[senderHaremKey].push({ ...trade.hisChar, claimedAt: new Date().toLocaleDateString('es-AR'), claimedName: trade.pushName });

    data.harem[targetHaremKey] = (data.harem[targetHaremKey] || []).filter(c => String(c.id) !== String(trade.hisChar.id));
    data.harem[targetHaremKey].push({ ...trade.myChar, claimedAt: new Date().toLocaleDateString('es-AR') });

    saveJSON(FILES.HAREM, data.harem);

    await sock.sendMessage(chatId, {
        text: `✅ *¡Trade completado!*\n\n@${trade.senderNum} recibió: *${trade.hisChar.nombre}*\n@${senderJid.split('@')[0]} recibió: *${trade.myChar.nombre}*`,
        mentions: [trade.senderJid, senderJid]
    }, { quoted: msg });
    return true;
}

async function handleRegalar(sock, chatId, senderJid, senderNum, pushName, rawText, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!targetJid) return sock.sendMessage(chatId, { text: '❌ Usá: #regalar [personaje] @usuario' }, { quoted: msg });
    if (targetJid === senderJid) return sock.sendMessage(chatId, { text: '❌ No podés regalarte a vos mismo.' }, { quoted: msg });

    const charName = rawText.replace(/^#regalar\s*/i, '').replace(/@\d+/g, '').trim();
    if (!charName) return sock.sendMessage(chatId, { text: '❌ Especificá el personaje a regalar.' }, { quoted: msg });

    const myHaremKey = `${chatId}:${senderJid}`;
    const myHarem    = data.harem[myHaremKey] || [];
    const charIdx    = myHarem.findIndex(c => c.nombre.toLowerCase() === charName.toLowerCase());
    if (charIdx === -1) return sock.sendMessage(chatId, { text: `❌ No tenés a *${charName}* en tu harem.` }, { quoted: msg });

    const char = myHarem[charIdx];
    data.harem[myHaremKey].splice(charIdx, 1);

    const targetHaremKey = `${chatId}:${targetJid}`;
    if (!data.harem[targetHaremKey]) data.harem[targetHaremKey] = [];
    data.harem[targetHaremKey].push({ ...char, claimedAt: new Date().toLocaleDateString('es-AR'), claimedName: pushName });

    saveJSON(FILES.HAREM, data.harem);

    await sock.sendMessage(chatId, {
        text: `🎁 *${pushName}* le regaló a *${char.nombre}* a @${targetJid.split('@')[0]}!`,
        mentions: [targetJid]
    }, { quoted: msg });
}

module.exports = { rollWaifu, claimWaifu, showHarem, setClaimMsg, setCooldown, handleAceptarTrade, handleTrade, handleRegalar };
