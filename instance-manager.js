const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const fs = require('fs');

const INSTANCES_FILE = './instances.json';
const MAX_INSTANCES  = 5;

function loadInstances() {
    try { return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8')); }
    catch (e) { return {}; }
}

function saveInstances(data) {
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(data, null, 2));
}

function getNextSlot() {
    const instances = loadInstances();
    for (let i = 2; i <= MAX_INSTANCES; i++) {
        if (!instances[`bot${i}`]) return `bot${i}`;
    }
    return null;
}

async function createInstance(phoneNumber, sock, chatId, msg) {
    const instances = loadInstances();

    const existing = Object.entries(instances).find(([, v]) => v.phone === phoneNumber);
    if (existing) {
        await sock.sendMessage(chatId, {
            text: `⚠️ Tu número ya tiene una instancia activa: *${existing[0]}*\nSi querés desconectarla usá *#unlink*.`
        }, { quoted: msg });
        return;
    }

    const botId = getNextSlot();
    if (!botId) {
        await sock.sendMessage(chatId, {
            text: `❌ Se alcanzó el límite de ${MAX_INSTANCES - 1} bots vinculados. Desconectá uno con *#unlink* para liberar un slot.`
        }, { quoted: msg });
        return;
    }

    await sock.sendMessage(chatId, {
        text: `⏳ Generando código para *${botId}*...`
    }, { quoted: msg });

    const sessionDir = `./session_${botId}`;
    const dataDir    = `./data/${botId}`;

    // Limpiar sesión previa siempre para evitar que reutilice creds viejas
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(sessionDir, { recursive: true });
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const tempSock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, console) },
            logger: require('pino')({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '22.04.4'],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: false,
        });

        tempSock.ev.on('creds.update', saveCreds);

        // Pedir el código apenas el socket abre conexión
        let codeSent = false;
        tempSock.ev.on('connection.update', async ({ connection }) => {
            if (connection === 'open' && !codeSent) {
                codeSent = true;
                try {
                    const pairingCode = await tempSock.requestPairingCode(phoneNumber);
                    const formatted = pairingCode.length === 8
                        ? `${pairingCode.slice(0,4)}-${pairingCode.slice(4)}`
                        : pairingCode;

                    instances[botId] = { phone: phoneNumber, createdAt: Date.now(), status: 'pending' };
                    saveInstances(instances);

                    await sock.sendMessage(chatId, {
                        text: `✅ *Código generado* — Instancia *${botId}*\n\n` +
                              `📱 WhatsApp → tres puntos → *Dispositivos vinculados*\n` +
                              `→ *Vincular dispositivo* → *Vincular con número*\n\n` +
                              `⏱️ Expira en 60 segundos.`
                    }, { quoted: msg });

                    await sock.sendMessage(chatId, { text: formatted });

                    setTimeout(async () => {
                        try { await tempSock.end(); } catch (_) {}
                        const pm2Cmd = `BOT_ID=${botId} PHONE_NUMBER=${phoneNumber} pm2 start bot.js --name ${botId} --no-autorestart`;
                        exec(pm2Cmd, (err) => {
                            if (err) console.log(`[instance-manager] Error PM2 ${botId}:`, err.message);
                            else {
                                const inst = loadInstances();
                                if (inst[botId]) { inst[botId].status = 'active'; saveInstances(inst); }
                                exec('pm2 save', () => {});
                            }
                        });
                    }, 2000);

                } catch (e) {
                    console.log(`[instance-manager] Error código ${botId}:`, e.message);
                    await sock.sendMessage(chatId, {
                        text: `❌ Error al generar el código: ${e.message}\nIntentá de nuevo con *#code*.`
                    }, { quoted: msg });
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                    const inst = loadInstances();
                    delete inst[botId];
                    saveInstances(inst);
                }
            }
        });

    } catch (e) {
        console.log(`[instance-manager] Error creando ${botId}:`, e.message);
        await sock.sendMessage(chatId, {
            text: `❌ Error al crear la instancia: ${e.message}\nIntentá de nuevo con *#code*.`
        }, { quoted: msg });
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        const inst = loadInstances();
        delete inst[botId];
        saveInstances(inst);
    }
}

async function removeInstance(phoneNumber, sock, chatId, msg) {
    const instances = loadInstances();
    const entry = Object.entries(instances).find(([, v]) => v.phone === phoneNumber);

    if (!entry) {
        await sock.sendMessage(chatId, {
            text: `⚠️ No tenés ninguna instancia vinculada.\nUsá *#code* para vincular una.`
        }, { quoted: msg });
        return;
    }

    const [botId] = entry;

    exec(`pm2 delete ${botId}`, () => { exec('pm2 save', () => {}); });

    try { fs.rmSync(`./session_${botId}`, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(`./data/${botId}`,    { recursive: true, force: true }); } catch (_) {}

    delete instances[botId];
    saveInstances(instances);

    await sock.sendMessage(chatId, {
        text: `✅ Instancia *${botId}* desconectada y eliminada correctamente.`
    }, { quoted: msg });
}

async function listInstances(sock, chatId, msg) {
    const instances = loadInstances();
    const keys = Object.keys(instances);

    if (keys.length === 0) {
        await sock.sendMessage(chatId, {
            text: `📋 No hay instancias secundarias activas.\nSlots disponibles: ${MAX_INSTANCES - 1}/4`
        }, { quoted: msg });
        return;
    }

    const lines = keys.map(id => {
        const { phone, status, createdAt } = instances[id];
        const fecha = new Date(createdAt).toLocaleString('es-AR');
        return `• *${id}* — \`${phone}\` — ${status} — ${fecha}`;
    });

    await sock.sendMessage(chatId, {
        text: `📋 *Instancias activas (${keys.length}/${MAX_INSTANCES - 1})*\n\n${lines.join('\n')}`
    }, { quoted: msg });
}

module.exports = { createInstance, removeInstance, listInstances };
