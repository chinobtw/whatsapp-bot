const fs = require('fs');

function getPhone(jid) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isAdmin(groupMetadata, jid) {
    const cleanJid = jid.includes(':') ? jid.split(':')[0] + '@lid' : jid;
    for (const p of groupMetadata.participants) {
        if (p.id === cleanJid) return p.admin === 'admin' || p.admin === 'superadmin';
    }
    return false;
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fmt(n) {
    return '$' + Number(n).toLocaleString('es-AR');
}

function saveJSON(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj));
}

const _saveTimers = {};
function saveJSONDebounced(file, obj, delay = 1000) {
    clearTimeout(_saveTimers[file]);
    _saveTimers[file] = setTimeout(() => {
        fs.writeFile(file, JSON.stringify(obj), err => {
            if (err) console.error(`[SAVE] ${file}:`, err.message);
            delete _saveTimers[file];
        });
    }, delay);
}

const _metaCache = new Map();
async function getGroupMeta(sock, chatId, force = false) {
    if (!force) {
        const c = _metaCache.get(chatId);
        if (c && Date.now() - c.ts < 300_000) return c.data;
    }
    const meta = await sock.groupMetadata(chatId);
    _metaCache.set(chatId, { data: meta, ts: Date.now() });
    return meta;
}

function invalidateGroupMeta(chatId) {
    _metaCache.delete(chatId);
}

module.exports = { getPhone, isAdmin, rand, fmt, saveJSON, saveJSONDebounced, getGroupMeta, invalidateGroupMeta };
