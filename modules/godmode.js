// ── GODMODE ──────────────────────────────────────────────────────────
// Hace que los números en MASTER_NUMBERS (config.js) sean inmunes a los
// comandos de moderación, sin tocar la lógica interna de cada handler.
//
// shieldModule() envuelve un módulo (ej. group.js) y, solo para los
// nombres de función que le pases, intercepta la llamada ANTES de que
// corra el handler real. Si el comando apunta (mención o respuesta-cita)
// a un número Master, responde el error y corta ahí. Si no, deja pasar
// la llamada original sin tocarla.
//
// Para proteger otro módulo (ej. economy.js para #rob) más adelante:
//   const eco = shieldModule(require('./economy'), ['handleRob']);

const { MASTER_NUMBERS } = require('../config');

const GOD_ERROR_MSG = '🤖 ERROR: *Diseño intencional*\n> No puedo rebelarme contra mi creador.';

function normalizeNum(jidOrNum) {
    if (!jidOrNum) return '';
    return String(jidOrNum).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isGod(jidOrNum) {
    return MASTER_NUMBERS.includes(normalizeNum(jidOrNum));
}

// Junta los posibles "objetivos" de un comando: mencionados (@user) y citado (reply)
function getMsgTargets(msg) {
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    const targets = [];
    if (ctx?.mentionedJid?.length) targets.push(...ctx.mentionedJid);
    if (ctx?.participant) targets.push(ctx.participant);
    return targets;
}

function targetsGod(msg) {
    return getMsgTargets(msg).some(isGod);
}

// Envuelve las funciones indicadas de un módulo. Asume la firma estándar
// de los handlers de comando: (sock, chatId, msg, ...resto)
function shieldModule(moduleObj, protectedFns) {
    const shielded = { ...moduleObj };
    for (const name of protectedFns) {
        const original = moduleObj[name];
        if (typeof original !== 'function') continue;
        shielded[name] = async function (sock, chatId, msg, ...rest) {
            if (targetsGod(msg)) {
                await sock.sendMessage(chatId, { text: GOD_ERROR_MSG }, { quoted: msg });
                return;
            }
            return original(sock, chatId, msg, ...rest);
        };
    }
    return shielded;
}

module.exports = { isGod, normalizeNum, targetsGod, getMsgTargets, shieldModule, GOD_ERROR_MSG };
