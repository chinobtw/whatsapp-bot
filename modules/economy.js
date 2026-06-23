const fs = require('fs');
const { data, FILES, ECO_CD } = require('../config');
const { rand, fmt, saveJSON, saveJSONDebounced } = require('./utils');

const CRIME_WINS = [
    { msg: 'intentaste robar un banco y te salió de diez', min: 16000, max: 20000 },
    { msg: 'hackeaste una empresa multinacional sin que te atrapen', min: 16000, max: 20000 },
    { msg: 'estafaste a un viejo con un cuento del tío', min: 16000, max: 20000 },
    { msg: 'robaste un camión de Apple en la autopista', min: 16000, max: 20000 },
    { msg: 'vendiste droga falsa y no te rompieron la cara', min: 16000, max: 20000 },
    { msg: 'ladraste de una joyería y nadie se dio cuenta', min: 16000, max: 20000 },
    { msg: 'hackeaste la cuenta bancaria de tu ex y te forraste', min: 17000, max: 20000 },
    { msg: 'te colaste al casino y te fuiste con los bolsillos llenos', min: 15000, max: 20000 },
    { msg: 'vendiste información confidencial de tu empresa', min: 16000, max: 20000 },
    { msg: 'clonaste tarjetas de crédito y nadie te agarró', min: 15000, max: 20000 },
];
const CRIME_LOSES = [
    { msg: 'intentaste robar un banco, te salió mal por boludo y te agarró la cana', min: 5000, max: 10000 },
    { msg: 'hackeaste tu propia computadora por accidente', min: 5000, max: 10000 },
    { msg: 'intentaste estafar a alguien pero te estafaron a vos', min: 5000, max: 10000 },
    { msg: 'robaste un auto y era del jefe de la policía', min: 5000, max: 10000 },
    { msg: 'intentaste vender algo robado y el comprador te denunció', min: 5000, max: 10000 },
    { msg: 'quisiste entrar a robar pero te cayó el perro encima', min: 4000, max: 9000 },
    { msg: 'intentaste estafar por internet y te pescaron al toque', min: 5000, max: 10000 },
    { msg: 'te confundiste de casa al entrar a robar y llamaron a la cana', min: 6000, max: 10000 },
    { msg: 'trataste de vender falsa mercadería y te cayó inspección', min: 5000, max: 9000 },
    { msg: 'se te cayó el celular mientras huías y te encontraron', min: 4000, max: 8000 },
];
const SLUT_MSGS = [
    'te rompieron entre todos los del grupo y pagaron bien',
    'hiciste un show privado y llovieron los billetes',
    'trabajaste toda la noche y valió la pena',
    'te contrataron para una despedida de soltero',
    'diste servicios VIP y te llenaron de propinas',
    'hiciste un live y los subs no paraban de llegar',
    'le hiciste un privado a un millonario y no fue barato',
    'tu contenido exclusivo se viralizó y llegaron los pagos',
    'te contrataron para un after de fiesta de egresados',
    'actuaste en una producción muy pero muy particular',
];
const WORK_MSGS = [
    'trabajaste de repartidor todo el día',
    'hiciste horas extra en la fábrica',
    'vendiste empanadas en el partido',
    'laburaste de cajero en el super',
    'diste clases particulares toda la tarde',
    'hiciste changas de pintura en el barrio',
    'llevaste pedidos en bici bajo la lluvia',
    'trabajaste de repositor hasta el cierre',
    'diste soporte técnico toda la tarde',
    'hiciste de mozo en un evento y te dejaron propina',
    'vendiste rifas por el barrio y cuadraste bien',
    'laburas de guardia de seguridad y todo tranquilo',
];

const JIDMAP_FILE = './jidmap.json';
let jidMap = {};
try { jidMap = JSON.parse(fs.readFileSync(JIDMAP_FILE, 'utf8')); } catch (_) {}

let _jidSaveTimer = null;
function registerJid(jid, num) {
    if (!jid || !num || jidMap[jid] === num) return;
    jidMap[jid] = num;
    if (!_jidSaveTimer) _jidSaveTimer = setTimeout(() => { fs.writeFileSync(JIDMAP_FILE, JSON.stringify(jidMap)); _jidSaveTimer = null; }, 5000);
}

function resolveNum(jid) {
    if (!jid) return '';
    if (jidMap[jid]) return jidMap[jid];
    const n = jid.split('@')[0].split(':')[0].replace(/\D/g,'');
    const found = Object.keys(data.economy).find(k => k === n || k.endsWith(n) || n.endsWith(k));
    return found || n;
}

function getEco(user) {
    if (!data.economy[user]) data.economy[user] = { wallet: 0, bank: 0 };
    return data.economy[user];
}
function saveEco() { saveJSONDebounced(FILES.ECONOMY, data.economy, 1000); }
function saveEcoNow() { saveJSON(FILES.ECONOMY, data.economy); }

function checkCd(chatId, senderNum, action) {
    const diff = ECO_CD[action] - (Date.now() - (data.ecoCooldowns[`${chatId}:${senderNum}:${action}`] || 0));
    return diff > 0 ? diff : 0;
}
function setCd(chatId, senderNum, action) {
    data.ecoCooldowns[`${chatId}:${senderNum}:${action}`] = Date.now();
    saveJSONDebounced(FILES.ECO_CD, data.ecoCooldowns, 1000);
}
function fmtCd(ms) {
    const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const lastActivity = {};

async function handleBalance(sock, chatId, senderNum, pushName, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const targetNum = targetJid ? resolveNum(targetJid) : senderNum;
    const eco = getEco(targetNum);
    const nombre = targetJid ? `@${targetNum}` : pushName;
    await sock.sendMessage(chatId, {
        text: `💰 *Balance de ${nombre}*\n\n///////////////////////\nBilletera: ${fmt(eco.wallet)}\nBanco: ${fmt(eco.bank)}\nTotal: ${fmt(eco.wallet + eco.bank)}\n///////////////////////`,
        mentions: targetJid ? [targetJid] : []
    }, { quoted: msg });
}

async function handleBaltop(sock, chatId, msg) {
    let participantNums = [];
    try {
        const meta = await sock.groupMetadata(chatId);
        participantNums = meta.participants
            .map(p => jidMap[p.id] || p.id.split('@')[0].replace(/\D/g,''))
            .filter(Boolean);
    } catch (e) {
        return sock.sendMessage(chatId, { text: '❌ Solo se puede usar en grupos.' }, { quoted: msg });
    }
    const sorted = Object.entries(data.economy)
        .filter(([key]) => participantNums.some(n => key===n || key.endsWith(n) || n.endsWith(key)))
        .map(([key, eco]) => ({ num: key, total: (eco.wallet||0)+(eco.bank||0) }))
        .filter(u => u.total > 0)
        .sort((a,b) => b.total-a.total).slice(0,10);
    if (!sorted.length) return sock.sendMessage(chatId, { text: 'Nadie de este grupo tiene plata todavía.' }, { quoted: msg });
    let text = '🏆 *TOP 10 MILLONARIOS DEL GRUPO* 🏆\n\n';
    sorted.forEach((u,i) => text += `${i+1}. @${u.num} — $${u.total.toLocaleString('es-AR')}\n`);
    await sock.sendMessage(chatId, { text, mentions: sorted.map(u => `${u.num}@s.whatsapp.net`) }, { quoted: msg });
}

async function handleDeposit(sock, chatId, senderNum, text, msg) {
    const eco = getEco(senderNum);
    const arg = text.split(' ').slice(1).join(' ').trim().toLowerCase();
    const cantidad = arg === 'all' ? eco.wallet : parseInt(arg);
    if (isNaN(cantidad) || cantidad <= 0) return sock.sendMessage(chatId, { text: '❌ Usá: #dep 5000 o #dep all' }, { quoted: msg });
    if (cantidad > eco.wallet) return sock.sendMessage(chatId, { text: `❌ Tenés ${fmt(eco.wallet)} disponible.` }, { quoted: msg });
    eco.wallet -= cantidad; eco.bank += cantidad; saveEco();
    return sock.sendMessage(chatId, { text: `🏦 Depositaste *${fmt(cantidad)}*.\nBanco: ${fmt(eco.bank)}` }, { quoted: msg });
}

async function handleWithdraw(sock, chatId, senderNum, text, msg) {
    const eco = getEco(senderNum);
    const arg = text.split(' ').slice(1).join(' ').trim().toLowerCase();
    const cantidad = arg === 'all' ? eco.bank : parseInt(arg);
    if (isNaN(cantidad) || cantidad <= 0) return sock.sendMessage(chatId, { text: '❌ Usá: #with 5000 o #with all' }, { quoted: msg });
    if (cantidad > eco.bank) return sock.sendMessage(chatId, { text: `❌ Tenés ${fmt(eco.bank)} en el banco.` }, { quoted: msg });
    eco.bank -= cantidad; eco.wallet += cantidad; saveEco();
    return sock.sendMessage(chatId, { text: `💸 Retiraste *${fmt(cantidad)}*.\nBilletera: ${fmt(eco.wallet)}` }, { quoted: msg });
}

async function handleCrime(sock, chatId, senderNum, pushName, msg) {
    const cd = checkCd(chatId, senderNum, 'crime');
    if (cd > 0) return sock.sendMessage(chatId, { text: `⏳ Esperá *${fmtCd(cd)}* para volver a usar #crime.` }, { quoted: msg });
    const eco = getEco(senderNum); setCd(chatId, senderNum, 'crime');
    if (Math.random() < 0.5) {
        const e = CRIME_WINS[Math.floor(Math.random()*CRIME_WINS.length)];
        const g = rand(e.min, e.max); eco.wallet += g; saveEco();
        return sock.sendMessage(chatId, { text: `🦹 *${pushName}*, ${e.msg} y ganaste *${fmt(g)}*!\nBilletera: ${fmt(eco.wallet)}` }, { quoted: msg });
    } else {
        const e = CRIME_LOSES[Math.floor(Math.random()*CRIME_LOSES.length)];
        const p = rand(e.min, e.max); eco.wallet = Math.max(0, eco.wallet-p); saveEco();
        return sock.sendMessage(chatId, { text: `🚨 *${pushName}*, ${e.msg} y perdiste *${fmt(p)}*.\nBilletera: ${fmt(eco.wallet)}` }, { quoted: msg });
    }
}

async function handleSlut(sock, chatId, senderNum, pushName, msg) {
    const cd = checkCd(chatId, senderNum, 'slut');
    if (cd > 0) return sock.sendMessage(chatId, { text: `⏳ Esperá *${fmtCd(cd)}* para volver a usar #slut.` }, { quoted: msg });
    const eco = getEco(senderNum); setCd(chatId, senderNum, 'slut');
    const g = rand(5000, 15000); eco.wallet += g; saveEco();
    return sock.sendMessage(chatId, { text: `💃 *${pushName}*, ${SLUT_MSGS[Math.floor(Math.random()*SLUT_MSGS.length)]} y te pagaron *${fmt(g)}*.\nBilletera: ${fmt(eco.wallet)}` }, { quoted: msg });
}

async function handleWork(sock, chatId, senderNum, pushName, msg) {
    const cd = checkCd(chatId, senderNum, 'work');
    if (cd > 0) return sock.sendMessage(chatId, { text: `⏳ Esperá *${fmtCd(cd)}* para volver a trabajar.` }, { quoted: msg });
    const eco = getEco(senderNum); setCd(chatId, senderNum, 'work');
    const g = rand(3000, 8000); eco.wallet += g; saveEco();
    return sock.sendMessage(chatId, { text: `👷 *${pushName}*, ${WORK_MSGS[Math.floor(Math.random()*WORK_MSGS.length)]} y ganaste *${fmt(g)}*.\nBilletera: ${fmt(eco.wallet)}` }, { quoted: msg });
}

async function handleRob(sock, chatId, senderNum, pushName, msg) {
    try {
        const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
            || msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!targetJid) return await sock.sendMessage(chatId, { text: '❌ Usá: #rob @usuario o respondé a su mensaje' }, { quoted: msg });
        const targetNum = resolveNum(targetJid);
        const mapped = jidMap[targetJid];
        let targetEcoKey = null;
        for (const cand of [mapped, targetNum].filter(Boolean)) {
            if (data.economy[cand]?.wallet > 0) { targetEcoKey = cand; break; }
        }
        if (!targetEcoKey) targetEcoKey = Object.keys(data.economy).find(k => k !== senderNum && k.length > 4 && (k.endsWith(targetNum)||targetNum.endsWith(k)) && data.economy[k].wallet > 0);
        if (!targetEcoKey || !data.economy[targetEcoKey]?.wallet) return await sock.sendMessage(chatId, { text: '❌ Esa persona no tiene plata en la billetera.' }, { quoted: msg });
        if (targetEcoKey === senderNum) return await sock.sendMessage(chatId, { text: '❌ No podés robarte a vos mismo.' }, { quoted: msg });
        const cd = checkCd(chatId, senderNum, 'rob');
        if (cd > 0) return await sock.sendMessage(chatId, { text: `⏳ Esperá *${fmtCd(cd)}* para robar de nuevo.` }, { quoted: msg });
        const cantidad = data.economy[targetEcoKey].wallet;
        data.economy[targetEcoKey].wallet -= cantidad;
        getEco(senderNum).wallet += cantidad;
        saveEco(); setCd(chatId, senderNum, 'rob');
        await sock.sendMessage(chatId, { text: `🥷 ¡*${pushName}* le robó *${fmt(cantidad)}* a @${targetEcoKey}!`, mentions: [`${targetEcoKey}@s.whatsapp.net`] }, { quoted: msg });
    } catch (e) { console.error('[ROB]', e); await sock.sendMessage(chatId, { text: '❌ Error al procesar el comando.' }, { quoted: msg }); }
}

async function handlePay(sock, chatId, senderNum, pushName, text, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!targetJid) return sock.sendMessage(chatId, { text: '❌ Usá: #pay <cantidad> @usuario' }, { quoted: msg });
    const cantidad = parseInt(text.trim().split(/\s+/)[1]);
    if (isNaN(cantidad) || cantidad <= 0) return sock.sendMessage(chatId, { text: '❌ Usá: #pay <cantidad> @usuario' }, { quoted: msg });
    const targetNum = resolveNum(targetJid);
    const targetKey = data.economy[targetNum] !== undefined ? targetNum : Object.keys(data.economy).find(k => jidMap[targetJid]===k) || targetNum;
    if (targetKey === senderNum) return sock.sendMessage(chatId, { text: '❌ No podés pagarte a vos mismo.' }, { quoted: msg });
    const senderEco = getEco(senderNum);
    if (senderEco.wallet < cantidad) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Tenés ${fmt(senderEco.wallet)}.` }, { quoted: msg });
    senderEco.wallet -= cantidad; getEco(targetKey).wallet += cantidad; saveEco();
    return sock.sendMessage(chatId, { text: `💸 *${pushName}* transfirió *${fmt(cantidad)}* a @${targetKey}.\nTu saldo: ${fmt(senderEco.wallet)}`, mentions: [`${targetKey}@s.whatsapp.net`] }, { quoted: msg });
}

async function handleDaily(sock, chatId, senderNum, pushName, msg) {
    const eco = getEco(senderNum);
    const now = Date.now(), DAY = 86400000, diff = now - (eco.lastDaily||0);
    if (diff < DAY) { const rem = DAY-diff; return sock.sendMessage(chatId, { text: `⏳ Podés reclamar tu daily en *${Math.floor(rem/3600000)}h ${Math.floor((rem%3600000)/60000)}m*.` }, { quoted: msg }); }
    if (diff >= DAY*2) eco.dailyStreak = 0;
    eco.dailyStreak = (eco.dailyStreak||0)+1;
    const reward = 50000 + (eco.dailyStreak-1)*5000;
    eco.wallet += reward; eco.lastDaily = now; saveEco();
    return sock.sendMessage(chatId, { text: `📅 *${pushName}*, reclamaste tu daily!\n💰 Ganaste: *${fmt(reward)}*\n🔥 Racha: *${eco.dailyStreak} día${eco.dailyStreak>1?'s':''}*\nBilletera: ${fmt(eco.wallet)}` }, { quoted: msg });
}

async function handleClear(sock, chatId, senderNum, rawText, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!targetJid) return sock.sendMessage(chatId, { text: 'Usá: #clear @usuario\n#clear economia @usuario\n#clear harem @usuario' }, { quoted: msg });

    const arg = rawText.replace(/^#clear\s*/i, '').replace(/@\d+/g, '').trim().toLowerCase();
    const targetNum = resolveNum(targetJid);
    const msgs = [];

    const clearEco   = !arg || arg === 'economia' || arg === 'economía';
    const clearHarem = !arg || arg === 'harem';

    if (clearEco) {
        data.economy[targetNum] = { wallet: 0, bank: 0 };
        saveEcoNow();
        msgs.push('economía');
    }
    if (clearHarem) {
        data.harem[`${chatId}:${targetJid}`] = [];
        saveJSON(FILES.HAREM, data.harem);
        msgs.push('harem');
    }
    if (!clearEco && !clearHarem)
        return sock.sendMessage(chatId, { text: '❌ Opción inválida. Usá: economia, harem, o ninguna para ambas.' }, { quoted: msg });

    return sock.sendMessage(chatId, {
        text: `🗑️ ${msgs.join(' y ')} de @${targetNum} reseteado.`,
        mentions: [targetJid]
    }, { quoted: msg });
}

async function handleClearAll(sock, chatId, msg) {
    for (const k of Object.keys(data.economy)) data.economy[k] = { wallet: 0, bank: 0 };
    saveEcoNow();
    for (const k of Object.keys(data.harem)) { if (k.startsWith(chatId)) data.harem[k] = []; }
    saveJSON(FILES.HAREM, data.harem);
    return sock.sendMessage(chatId, { text: '🗑️ Toda la economía y harems borrados.' }, { quoted: msg });
}

const pushNameMap = {};
function registerPushName(jid, name) {
    if (jid && name) pushNameMap[jid] = name;
}
function getPushName(jid) {
    if (!jid) return jid?.split('@')[0] || '';
    return pushNameMap[jid] || jid.split('@')[0].replace(/\D/g,'');
}

async function handleGift(sock, chatId, senderNum, rawText, msg) {
const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
    || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!targetJid) return sock.sendMessage(chatId, { text: '❌ Usá: #gift <cantidad> @usuario' }, { quoted: msg });
    const cantidad = parseInt(rawText.trim().split(/\s+/)[1]);
    if (isNaN(cantidad) || cantidad <= 0) return sock.sendMessage(chatId, { text: '❌ Especificá una cantidad válida.' }, { quoted: msg });
    const targetNum = resolveNum(targetJid);
    const targetEco = getEco(targetNum);
    targetEco.wallet += cantidad;
    saveEco();
    await sock.sendMessage(chatId, {
text: `🎁 Le regalaste *${fmt(cantidad)}* a @${targetJid.split('@')[0]}.`,
        mentions: [targetJid]
    }, { quoted: msg });
}

async function handleRest(sock, chatId, senderNum, rawText, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
    || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!targetJid) return sock.sendMessage(chatId, { text: '❌ Usá: #rest <cantidad> @usuario' }, { quoted: msg });
    const cantidad = parseInt(rawText.trim().split(/\s+/)[1]);
    if (isNaN(cantidad) || cantidad <= 0) return sock.sendMessage(chatId, { text: '❌ Especificá una cantidad válida.' }, { quoted: msg });
    const targetNum = resolveNum(targetJid);
    const targetEco = getEco(targetNum);
    targetEco.wallet = Math.max(0, targetEco.wallet - cantidad);
    targetEco.bank   = Math.max(0, targetEco.bank   - Math.max(0, cantidad - targetEco.wallet));
    saveEco();
    await sock.sendMessage(chatId, {
text: `💸 Le restaste *${fmt(cantidad)}* a @${targetJid.split('@')[0]}.`,
        mentions: [targetJid]
    }, { quoted: msg });
}

module.exports = {
    handleBalance, handleBaltop, handleDeposit, handleWithdraw,
    handleCrime, handleSlut, handleWork, handleRob, handlePay, handleDaily,
    handleClear, handleClearAll,
    getEco, saveEco, checkCd, setCd, fmtCd, resolveNum, jidMap, lastActivity, registerJid, registerPushName, getPushName, handleGift, handleRest
};
