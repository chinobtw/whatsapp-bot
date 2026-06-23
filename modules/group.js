const { data, FILES, MASTER_NUMBERS } = require('../config');
const { isAdmin, saveJSON, getGroupMeta } = require('./utils');
const { getPushName } = require('./economy');

function getTarget(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        || msg.message?.extendedTextMessage?.contextInfo?.participant
        || null;
}
function senderIsAdminOrMaster(meta, jid, num) {
    if (MASTER_NUMBERS.includes(num)) return true;
    return isAdmin(meta, jid);
}

// ── MUTE ──────────────────────────────────────────────────────────────
async function handleMute(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: '❌ Usá: #mute @usuario [minutos]' }, { quoted: msg });
    const mins = parseInt(text.split(/\s+/).find(w => /^\d+$/.test(w))) || 10;
    if (!data.muted[chatId]) data.muted[chatId] = {};
    data.muted[chatId][target] = Date.now() + mins * 60000;
    saveJSON(FILES.MUTED, data.muted);
    await sock.sendMessage(chatId, {
        text: `🔇 @${target.split('@')[0]} muteado por *${mins} minuto${mins > 1 ? 's' : ''}*. Sus mensajes serán borrados.`,
        mentions: [target]
    }, { quoted: msg });
}

async function handleUnmute(sock, chatId, msg, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: '❌ Usá: #unmute @usuario' }, { quoted: msg });
    if (data.muted[chatId]) delete data.muted[chatId][target];
    saveJSON(FILES.MUTED, data.muted);
    await sock.sendMessage(chatId, { text: `🔔 @${target.split('@')[0]} desmutado.`, mentions: [target] }, { quoted: msg });
}

// ── ANTILINK ──────────────────────────────────────────────────────────
async function handleAntilink(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const arg = text.split(' ')[1]?.toLowerCase();
    if (arg === 'on') {
        data.antilink[chatId] = true;
        saveJSON(FILES.ANTILINK, data.antilink);
        return sock.sendMessage(chatId, { text: '🔗 Antilink activado. Se borrarán links de grupos.' }, { quoted: msg });
    } else if (arg === 'off') {
        delete data.antilink[chatId];
        saveJSON(FILES.ANTILINK, data.antilink);
        return sock.sendMessage(chatId, { text: '🔗 Antilink desactivado.' }, { quoted: msg });
    }
    return sock.sendMessage(chatId, { text: 'Usá: #antilink on o #antilink off' }, { quoted: msg });
}

// ── ANTIFLOOD ─────────────────────────────────────────────────────────
async function handleAntiflood(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const parts = text.split(' ');
    const arg = parts[1]?.toLowerCase();
    if (arg === 'off') {
        delete data.antiflood[chatId];
        saveJSON(FILES.ANTIFLOOD, data.antiflood);
        return sock.sendMessage(chatId, { text: '🌊 Antiflood desactivado.' }, { quoted: msg });
    }
    const limit = parseInt(arg);
    if (!limit || limit < 2 || limit > 20)
        return sock.sendMessage(chatId, { text: 'Usá: #antiflood [2-20] o #antiflood off\nEj: #antiflood 5 → borra si manda más de 5 mensajes en 10 segundos.' }, { quoted: msg });
    data.antiflood[chatId] = limit;
    saveJSON(FILES.ANTIFLOOD, data.antiflood);
    return sock.sendMessage(chatId, { text: `🌊 Antiflood activado. Límite: *${limit} mensajes* cada 10 segundos.` }, { quoted: msg });
}

// ── REGLAS ────────────────────────────────────────────────────────────
async function handleSetrules(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const rules = text.replace(/^#setrules\s*/i, '').trim();
    if (!rules) return sock.sendMessage(chatId, { text: 'Usá: #setrules [texto de las reglas]' }, { quoted: msg });
    data.rules[chatId] = rules;
    saveJSON(FILES.RULES, data.rules);
    return sock.sendMessage(chatId, { text: '📋 Reglas guardadas.' }, { quoted: msg });
}

async function handleRules(sock, chatId, msg) {
    const rules = data.rules[chatId];
    if (!rules) return sock.sendMessage(chatId, { text: '❌ No hay reglas configuradas. Usá #setrules [texto].' }, { quoted: msg });
    await sock.sendMessage(chatId, { text: `📋 *REGLAS DEL GRUPO*\n\n${rules}` }, { quoted: msg });
}

// ── REPORT ────────────────────────────────────────────────────────────
async function handleReport(sock, chatId, msg, text, senderNum) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo;
    if (!quoted?.participant) return sock.sendMessage(chatId, { text: '❌ Respondé a un mensaje para reportarlo.' }, { quoted: msg });
    const meta = await getGroupMeta(sock, chatId);
    const admins = meta.participants.filter(p => p.admin).map(p => p.id);
    const reportedNum = quoted.participant.split('@')[0];
    const reason = text.replace(/^#report\s*/i, '').trim() || 'Sin motivo';
    await sock.sendMessage(chatId, {
        text: `🚨 *REPORTE*\n📌 Reportado: @${reportedNum}\n📝 Motivo: ${reason}\n\n${admins.map(a => `@${a.split('@')[0]}`).join(' ')}`,
        mentions: [...admins, quoted.participant]
    }, { quoted: msg });
}

// ── INFO ──────────────────────────────────────────────────────────────
async function handleInfo(sock, chatId, msg) {
    try {
        const meta = await getGroupMeta(sock, chatId);
        const admins = meta.participants.filter(p => p.admin);
        const desc = meta.desc ? meta.desc.toString() : 'Sin descripción';
        const created = new Date((meta.creation || 0) * 1000).toLocaleDateString('es-AR');
        await sock.sendMessage(chatId, {
            text: `ℹ️ *INFO DEL GRUPO*\n\n📌 *Nombre:* ${meta.subject}\n👥 *Miembros:* ${meta.participants.length}\n👑 *Admins:* ${admins.map(a => `@${a.id.split('@')[0]}`).join(', ')}\n📅 *Creado:* ${created}\n\n📝 *Descripción:*\n${desc}`,
            mentions: admins.map(a => a.id)
        }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Error al obtener info del grupo.' }, { quoted: msg });
    }
}

// ── EXISTENTES ────────────────────────────────────────────────────────
async function handleTopActive(sock, chatId, msg) {
    const stats = global.msgStats || {};
    const users = Object.entries(stats)
        .filter(([k]) => k.startsWith(chatId))
        .map(([k,v]) => ({ jid: k.split(':')[1], count: v.count }))
        .sort((a,b) => b.count - a.count).slice(0,10);
    if (!users.length) return sock.sendMessage(chatId, { text: 'Todavía no hay mensajes registrados.' }, { quoted: msg });
    let text = '🔥 *TOP 10 MÁS ACTIVOS (Últimos 30 días)* 🔥\n\n';
    users.forEach((u,i) => text += `${i+1}. @${u.jid.split('@')[0]} — ${u.count} msgs\n`);
    await sock.sendMessage(chatId, { text, mentions: users.map(u => u.jid) }, { quoted: msg });
}

async function handleTopInactive(sock, chatId, msg, text) {
    try {
        const meta = await getGroupMeta(sock, chatId);
        const stats = global.msgStats || {};
        const users = meta.participants
            .map(p => ({ jid: p.id, count: (stats[`${chatId}:${p.id}`] || {count:0}).count }))
            .sort((a,b) => a.count - b.count);
        const page = parseInt(text.split(' ')[1]) || 1;
        const total = Math.ceil(users.length / 10);
        if (page < 1 || page > total) return sock.sendMessage(chatId, { text: `❌ Hay ${total} páginas en total.` }, { quoted: msg });
        const slice = users.slice((page-1)*10, page*10);
        let out = `👻 *TOP INACTIVOS — Pág ${page}/${total}* 👻\n\n`;
        slice.forEach((u,i) => out += `${(page-1)*10+i+1}. @${u.jid.split('@')[0]} — ${u.count} msgs\n`);
        if (page < total) out += `\n_Usá #topinactive ${page+1} para ver la siguiente._`;
        await sock.sendMessage(chatId, { text: out, mentions: slice.map(u => u.jid) }, { quoted: msg });
    } catch (e) { console.error('TopInactive:', e); }
}

async function handleCount(sock, chatId, msg) {
    let target = getTarget(msg) || msg.key.participant;
    if (!target) return sock.sendMessage(chatId, { text: '❌ Respondé a un mensaje o usá @usuario' }, { quoted: msg });

    const { jidMap } = require('./economy');
    const targetNum = target.split('@')[0].replace(/\D/g, '');

    // Buscar en msgStats por LID o número
    let c = 0;
    for (const key of Object.keys(global.msgStats || {})) {
        if (!key.startsWith(chatId + ':')) continue;
        const keyJid = key.split(':').slice(1).join(':'); // el JID después del chatId
        const keyNum = jidMap[keyJid] || keyJid.split('@')[0].replace(/\D/g, '');
        if (keyNum === targetNum || keyNum.endsWith(targetNum) || targetNum.endsWith(keyNum)) {
            c = global.msgStats[key]?.count || 0;
            break;
        }
    }

    // Fecha de unión
    let joinInfo = '';
    try {
        const meta = await getGroupMeta(sock, chatId);
        const participant = meta.participants.find(p => {
            const pNum = jidMap[p.id] || p.id.split('@')[0].replace(/\D/g, '');
            return pNum === targetNum || pNum.endsWith(targetNum) || targetNum.endsWith(pNum);
        });
        if (participant?.joinTime) {
            joinInfo = `\n> Fecha de unión: ${new Date(participant.joinTime * 1000).toLocaleDateString('es-AR')}`;
        }
    } catch (_) {}

    await sock.sendMessage(chatId, {
        text: `📊 @${targetNum} envió *${c}* mensajes en los últimos 30 días.${joinInfo}`,
        mentions: [target]
    }, { quoted: msg });
}

async function handleKick(sock, chatId, msg, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: 'Usá: #kick @usuario o respondé a su mensaje' }, { quoted: msg });
    try { await sock.groupParticipantsUpdate(chatId, [target], 'remove'); await sock.sendMessage(chatId, { text: '✅ Expulsado.' }, { quoted: msg }); }
    catch (e) { await sock.sendMessage(chatId, { text: '❌ No puedo expulsar si no soy admin.' }, { quoted: msg }); }
}

async function handlePromoteDemote(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId, true);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: '❌ Mencioná a alguien.' }, { quoted: msg });
    try { await sock.groupParticipantsUpdate(chatId, [target], text.startsWith('#promote') ? 'promote' : 'demote'); await sock.sendMessage(chatId, { text: '✅ Hecho.' }, { quoted: msg }); }
    catch (e) { await sock.sendMessage(chatId, { text: '❌ Error: ' + e.message }, { quoted: msg }); }
}

async function handleCloseOpen(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId, true);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    try {
        const s = text.startsWith('#close') ? 'announcement' : 'not_announcement';
        await sock.groupSettingUpdate(chatId, s);
        await sock.sendMessage(chatId, { text: s === 'announcement' ? '🔒 Grupo cerrado.' : '🔓 Grupo abierto.' }, { quoted: msg });
    } catch (e) { await sock.sendMessage(chatId, { text: '❌ Error: ' + e.message }, { quoted: msg }); }
}

async function handleOnlyAdmin(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId, true);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const arg = text.split(' ')[1]?.toLowerCase();
    if (arg === 'on')  { data.onlyAdminChats[chatId] = true;  saveJSON(FILES.ONLYADMIN, data.onlyAdminChats); return sock.sendMessage(chatId, { text: '🔒 Modo solo admin activado.' }, { quoted: msg }); }
    if (arg === 'off') { delete data.onlyAdminChats[chatId];  saveJSON(FILES.ONLYADMIN, data.onlyAdminChats); return sock.sendMessage(chatId, { text: '🔓 Modo solo admin desactivado.' }, { quoted: msg }); }
    return sock.sendMessage(chatId, { text: 'Usá: #onlyadmin on o #onlyadmin off' }, { quoted: msg });
}

async function handleTag(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    let targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const qp = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (qp && !targets.includes(qp)) targets.push(qp);
    if (!targets.length) targets = meta.participants.map(p => p.id);
    const message = text.replace(/^#tag\s*/i, '').trim();
    if (!message) {
        const qt = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || '';
        if (qt) { await sock.sendMessage(chatId, { text: qt, mentions: targets }); return; }
        return sock.sendMessage(chatId, { text: '❌ Escribí un mensaje después de #tag.' }, { quoted: msg });
    }
    await sock.sendMessage(chatId, { text: message, mentions: targets });
}

async function handleWarn(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: 'Usá: #warn @usuario motivo' }, { quoted: msg });
    const motivo = text.replace(/#warn/i,'').replace(/@\d+/g,'').trim() || 'Sin motivo';
    const key = `${chatId}:${target}`;
    if (!data.warns[key]) data.warns[key] = [];
    data.warns[key].push({ motivo, fecha: new Date().toLocaleDateString('es-AR') });
    saveJSON(FILES.WARNS, data.warns);
    const total = data.warns[key].length, limite = data.warnLimits[chatId] || 3;
    if (total >= limite) {
        data.warns[key] = []; saveJSON(FILES.WARNS, data.warns);
        try { await sock.groupParticipantsUpdate(chatId, [target], 'remove'); await sock.sendMessage(chatId, { text: `⛔ @${target.split('@')[0]} acumuló ${limite} advertencias y fue expulsado.`, mentions: [target] }, { quoted: msg }); }
        catch (e) { await sock.sendMessage(chatId, { text: '❌ No pude expulsarlo, ¿soy admin?' }, { quoted: msg }); }
    } else {
        await sock.sendMessage(chatId, { text: `⚠️ @${target.split('@')[0]} — Advertencia ${total}/${limite}\n\n${data.warns[key].map((w,i) => `${i+1}. ${w.motivo} (${w.fecha})`).join('\n')}`, mentions: [target] }, { quoted: msg });
    }
}

async function handleDelwarn(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: 'Usá: #delwarn [N] @usuario' }, { quoted: msg });
    const num = parseInt(text.replace(/#delwarn/i,'').replace(/@\d+/g,'').trim());
    const key = `${chatId}:${target}`;
    if (!data.warns[key]?.length) return sock.sendMessage(chatId, { text: '❌ Sin advertencias.' }, { quoted: msg });
    if (isNaN(num) || num < 1 || num > data.warns[key].length) return sock.sendMessage(chatId, { text: `❌ Número inválido. Tiene ${data.warns[key].length}.` }, { quoted: msg });
    const borrada = data.warns[key].splice(num-1, 1)[0];
    saveJSON(FILES.WARNS, data.warns);
    await sock.sendMessage(chatId, { text: `✅ Advertencia #${num} de @${target.split('@')[0]} eliminada.\nEra: ${borrada.motivo}`, mentions: [target] }, { quoted: msg });
}

async function handleResetwarn(sock, chatId, msg, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const target = getTarget(msg);
    if (!target) return sock.sendMessage(chatId, { text: 'Usá: #resetwarn @usuario' }, { quoted: msg });
    data.warns[`${chatId}:${target}`] = [];
    saveJSON(FILES.WARNS, data.warns);
    await sock.sendMessage(chatId, { text: `✅ Advertencias de @${target.split('@')[0]} reseteadas.`, mentions: [target] }, { quoted: msg });
}

async function handleSetwarnlimit(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const num = parseInt(text.replace(/#setwarnlimit/i,'').trim());
    if (isNaN(num) || num < 1 || num > 10) return sock.sendMessage(chatId, { text: '❌ Usá: #setwarnlimit [1-10]' }, { quoted: msg });
    data.warnLimits[chatId] = num; saveJSON(FILES.WARN_LIMITS, data.warnLimits);
    return sock.sendMessage(chatId, { text: `✅ Límite de advertencias: ${num}.` }, { quoted: msg });
}

async function handleSetwelcome(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const mensaje = text.replace(/^#setwelcome\s*/i,'').trim();
    if (!mensaje) return sock.sendMessage(chatId, { text: 'Usá: #setwelcome Hola $new! Variables: $new, $desc' }, { quoted: msg });
    data.welcomeMessages[chatId] = mensaje; saveJSON(FILES.WELCOME, data.welcomeMessages);
    return sock.sendMessage(chatId, { text: '✅ Mensaje de bienvenida guardado.' }, { quoted: msg });
}

async function handleWelcomeToggle(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const arg = text.split(' ')[1]?.toLowerCase();
    if (arg === 'off') { if (!data.welcomeDisabled) data.welcomeDisabled = {}; data.welcomeDisabled[chatId] = true; saveJSON(FILES.WELCOME_DISABLED, data.welcomeDisabled); return sock.sendMessage(chatId, { text: '🔕 Bienvenidas desactivadas.' }, { quoted: msg }); }
    if (arg === 'on')  { if (data.welcomeDisabled) delete data.welcomeDisabled[chatId]; saveJSON(FILES.WELCOME_DISABLED, data.welcomeDisabled || {}); return sock.sendMessage(chatId, { text: '🔔 Bienvenidas activadas.' }, { quoted: msg }); }
    return sock.sendMessage(chatId, { text: 'Usá: #welcome on o #welcome off' }, { quoted: msg });
}

async function handleTestwelcome(sock, chatId, msg, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const jid = msg.key.participant;
    const desc = meta.desc ? meta.desc.toString() : '';
    const mensajeFinal = data.welcomeMessages[chatId]
        ? data.welcomeMessages[chatId].replace(/\$new/g, `@${senderNum}`).replace(/\$desc/g, desc)
        : `👋 ¡Bienvenido/a @${senderNum} al grupo!`;
    await sock.sendMessage(chatId, { text: mensajeFinal, mentions: [jid] }, { quoted: msg });
}

async function addWarn(sock, chatId, targetJid, motivo) {
    const key = `${chatId}:${targetJid}`;
    if (!data.warns[key]) data.warns[key] = [];
    data.warns[key].push({ motivo, fecha: new Date().toLocaleDateString('es-AR') });
    saveJSON(FILES.WARNS, data.warns);
    const total = data.warns[key].length, limite = data.warnLimits[chatId] || 3;
    if (total >= limite) {
        data.warns[key] = []; saveJSON(FILES.WARNS, data.warns);
        try { await sock.groupParticipantsUpdate(chatId, [targetJid], 'remove'); } catch (_) {}
        await sock.sendMessage(chatId, { text: `⛔ @${targetJid.split('@')[0]} acumuló ${limite} advertencias y fue expulsado.\nMotivo: ${motivo}`, mentions: [targetJid] });
    } else {
        await sock.sendMessage(chatId, { text: `⚠️ @${targetJid.split('@')[0]} — Advertencia automática ${total}/${limite}\nMotivo: ${motivo}`, mentions: [targetJid] });
    }
}

async function handleAutowarn(sock, chatId, msg, text, senderNum) {
    const meta = await getGroupMeta(sock, chatId);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum)) return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });
    const arg = text.split(' ')[1]?.toLowerCase();
    if (['on','enable'].includes(arg)) {
        if (data.autowarnDisabled) delete data.autowarnDisabled[chatId];
        saveJSON(FILES.AUTOWARN_DISABLED, data.autowarnDisabled || {});
        return sock.sendMessage(chatId, { text: '✅ Autowarn activado.' }, { quoted: msg });
    }
    if (['off','disable'].includes(arg)) {
        if (!data.autowarnDisabled) data.autowarnDisabled = {};
        data.autowarnDisabled[chatId] = true;
        saveJSON(FILES.AUTOWARN_DISABLED, data.autowarnDisabled);
        return sock.sendMessage(chatId, { text: '🔕 Autowarn desactivado.' }, { quoted: msg });
    }
    return sock.sendMessage(chatId, { text: 'Usá: #autowarn on/off' }, { quoted: msg });
}

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

async function handleClearCmt(sock, chatId, msg, senderNum) {
    const { MASTER_NUMBERS = [] } = require('../config');

    try {
        const meta = await sock.groupMetadata(chatId);
        const sender = msg.key.participant || msg.key.remoteJid;

        const isAdmin = meta.participants.some(p => p.id === sender && p.admin);
        const isMaster = MASTER_NUMBERS.includes(sender.split('@')[0].split(':')[0]);
        if (!isAdmin && !isMaster)
            return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });

        const communityJid = meta.linkedParent;
        if (!communityJid) {
            return sock.sendMessage(chatId, { text: '❌ Este grupo no pertenece a ninguna comunidad.' }, { quoted: msg });
        }

        let allGroups;
        try {
            allGroups = await sock.groupFetchAllParticipating();
        } catch (e) {
            console.error('[ClearCmt] Error leyendo grupos:', e);
            return sock.sendMessage(chatId, { text: '❌ No pude leer los grupos. ¿El bot es admin de la comunidad entera?' }, { quoted: msg });
        }

        // Mapa: jid del participante -> Set de grupos (dentro de la comunidad) donde realmente figura
        const memberGroups = new Map();
        const addToMap = (jid, groupJid) => {
            if (!memberGroups.has(jid)) memberGroups.set(jid, new Set());
            memberGroups.get(jid).add(groupJid);
        };

        if (allGroups[communityJid]) {
            for (const p of allGroups[communityJid].participants) addToMap(p.id, communityJid);
        }
        for (const gid of Object.keys(allGroups)) {
            const g = allGroups[gid];
            if (g.linkedParent === communityJid) {
                for (const p of g.participants) addToMap(p.id, gid);
            }
        }

        const normalizeJid = (jid) => jid.split('@')[0].split(':')[0];

        const groupMembers = new Set(meta.participants.map(p => normalizeJid(p.id)));

        console.log(`[ClearCmt] Grupo: ${meta.subject} | Miembros reales: ${groupMembers.size}`);
        console.log(`[ClearCmt] Comunidad | Miembros únicos: ${memberGroups.size}`);

        const toRemove = [];
        for (const [jid, groupsSet] of memberGroups.entries()) {
            const pn = normalizeJid(jid);
            const esMaster = MASTER_NUMBERS.includes(pn);
            const estaEnGrupo = groupMembers.has(pn);

            console.log(`[ClearCmt] ${pn} | EnGrupo: ${estaEnGrupo} | Master: ${esMaster} | Presente en: ${[...groupsSet].length} grupo(s)`);

            if (!estaEnGrupo && !esMaster) {
                toRemove.push({ jid, groups: [...groupsSet] });
            }
        }

        console.log(`[ClearCmt] A borrar: ${toRemove.length} usuarios`);

        if (toRemove.length === 0) {
            return sock.sendMessage(chatId, { text: '✅ Todos los miembros de la comunidad ya están en este grupo.' }, { quoted: msg });
        }

        await sock.sendMessage(chatId, {
            text: `🔍 Encontrados *${toRemove.length}* miembros de la comunidad que no están en este grupo. Eliminando...`
        }, { quoted: msg });

        let removed = 0, failed = 0;
        for (const { jid, groups } of toRemove) {
            let okAny = false;
            for (const groupJid of groups) {
                try {
                    const res = await sock.groupParticipantsUpdate(groupJid, [jid], 'remove');
                    const ok = res.some(r => r.status === '200' || r.status === 200);
                    console.log(`[ClearCmt] Remover ${jid} de ${groupJid}: ${ok ? 'OK' : 'FALLÓ'}`);
                    if (ok) okAny = true;
                } catch (e) {
                    console.error(`[ClearCmt] Error removiendo ${jid} de ${groupJid}:`, e.message || e);
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            if (okAny) removed++; else failed++;
        }

        return sock.sendMessage(chatId, {
            text: `✅ Proceso terminado.\n👤 Eliminados: *${removed}*\n❌ Fallidos: *${failed}*`
        }, { quoted: msg });

    } catch (e) {
        console.error('[ClearCmt] Error general:', e);
        return sock.sendMessage(chatId, { text: `❌ Error inesperado: ${e.message}` }, { quoted: msg });
    }
}

async function handleAgg(sock, chatId, msg, rawText, senderNum) {
    const meta = await getGroupMeta(sock, chatId, true);
    if (!senderIsAdminOrMaster(meta, msg.key.participant, senderNum))
        return sock.sendMessage(chatId, { text: '❌ Solo admins.' }, { quoted: msg });

    const num = rawText.replace(/^#agg\s*/i, '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
    if (!num || !/^\d{8,15}$/.test(num))
        return sock.sendMessage(chatId, { text: '❌ Usá: #agg +5491122334455' }, { quoted: msg });

    const jid = `${num}@s.whatsapp.net`;

    try {
        const check = await sock.onWhatsApp(num);
        if (!check?.[0]?.exists)
            return sock.sendMessage(chatId, { text: `❌ El número +${num} no está en WhatsApp.` }, { quoted: msg });
    } catch (e) {
        console.log('[Agg] Error verificando número:', e.message);
    }

    try {
        const res = await sock.groupParticipantsUpdate(chatId, [jid], 'add');
        const result = res?.[0];

        if (result?.status === '200' || result?.status === 200) {
            return sock.sendMessage(chatId, { text: `✅ +${num} agregado al grupo.` }, { quoted: msg });
        }

// No se pudo agregar directo (privacidad). Mandamos el link de invitación por DM.
        try {
            const inviteCode = await sock.groupInviteCode(chatId);
            await sock.sendMessage(jid, { text: `Te invitaron a unirte a este grupo:\nhttps://chat.whatsapp.com/${inviteCode}\n> Esto es un bot de respuesta automática, por favor, no responder.` });
            return sock.sendMessage(chatId, { text: `📩 +${num} no permite ser agregado directo. Se le envió el link de invitación por privado.` }, { quoted: msg });
        } catch (e) {
            console.log('[Agg] Error enviando invitación:', e.message);
            return sock.sendMessage(chatId, { text: '❌ Error: hubo un error con el envío de la invitación. \n> Por favor, reintenta en 5 segundos.' }, { quoted: msg });
        }

        return sock.sendMessage(chatId, { text: '❌ Error: pide invitación o se salió recientemente' }, { quoted: msg });

    } catch (e) {
        console.log('[Agg] Error general:', e.message);
        return sock.sendMessage(chatId, { text: '❌ Error: pide invitación o se salió recientemente' }, { quoted: msg });
    }
}

module.exports = {
    handleKick, handlePromoteDemote, handleCloseOpen, handleOnlyAdmin, handleTag,
    handleWarn, handleDelwarn, handleResetwarn, handleSetwarnlimit,
    handleSetwelcome, handleWelcomeToggle, handleTestwelcome,
    handleTopActive, handleTopInactive, handleCount,
    handleMute, handleUnmute, handleAntilink, handleAntiflood,
    handleSetrules, handleRules, handleReport, handleInfo,
    addWarn, handleAutowarn, handleClearCmt, handleAgg
};
