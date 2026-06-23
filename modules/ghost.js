const { exec } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'GhostTR.py');

function runGhost(args) {
    return new Promise((resolve, reject) => {
	console.log('EXEC:', `python ${SCRIPT} ${args}`);
        exec(`python ${SCRIPT} ${args}`, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err && !stdout) return reject(new Error(stderr || err.message));
            resolve(stdout.trim());
        });
    });
}

function parseLines(output, emoji, title) {
    const lines = output.split('\n').filter(Boolean);
    let text = `${emoji} *${title}*\n\n`;
    for (const line of lines) {
        const idx = line.indexOf(': ');
        if (idx === -1) { text += `${line}\n`; continue; }
        const key = line.slice(0, idx);
        const val = line.slice(idx + 2);
        text += `🔹 *${key}:* ${val}\n`;
    }
    return text.trim();
}

function parseUser(username, output) {
    const lines = output.split('\n').filter(Boolean);
    const found    = lines.filter(l => l.startsWith('FOUND:')).map(l => {
        const parts = l.replace('FOUND:', '').split(':');
        const name = parts[0];
        const url  = parts.slice(1).join(':');
        return `✅ *${name}:* ${url}`;
    });
    const notFound = lines.filter(l => l.startsWith('NOTFOUND:')).map(l => l.replace('NOTFOUND:', ''));

    let text = `👤 *Username Tracker: ${username}*\n\n`;
    text += found.length > 0
        ? `*Encontrado en ${found.length} sitios:*\n${found.join('\n')}`
        : `❌ No se encontró el usuario en ningún sitio.`;
    if (notFound.length > 0) text += `\n\n*No encontrado:* ${notFound.join(', ')}`;
    return text;
}

async function handleIP(sock, chatId, rawText, msg) {
    const ip = rawText.replace(/^#ip\s*/i, '').trim();
    if (!ip) return sock.sendMessage(chatId, { text: '❌ Usá: #ip [dirección]\nEj: #ip 8.8.8.8' }, { quoted: msg });
    await sock.sendMessage(chatId, { text: '🔍 Buscando información...' }, { quoted: msg });
    try {
        const output = await runGhost(`ip ${ip}`);
        if (output.startsWith('ERROR:')) return sock.sendMessage(chatId, { text: `❌ ${output.replace('ERROR:', '').trim()}` }, { quoted: msg });
        await sock.sendMessage(chatId, { text: parseLines(output, '🌐', 'IP Tracker') }, { quoted: msg });
    } catch (e) { await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}` }, { quoted: msg }); }
}

async function handleMiIP(sock, chatId, msg) {
    try {
        const output = await runGhost('miip');
        await sock.sendMessage(chatId, { text: `🖥️ *${output}*` }, { quoted: msg });
    } catch (e) { await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}` }, { quoted: msg }); }
}

async function handlePhone(sock, chatId, rawText, msg) {
    const num = rawText.replace(/^#phone\s*/i, '').trim();
    if (!num) return sock.sendMessage(chatId, { text: '❌ Usá: #phone [número]\nEj: #phone +5491112345678' }, { quoted: msg });
    await sock.sendMessage(chatId, { text: '🔍 Analizando número...' }, { quoted: msg });
    try {
        const output = await runGhost(`phone ${num}`);
        if (output.startsWith('ERROR:')) return sock.sendMessage(chatId, { text: `❌ ${output.replace('ERROR:', '').trim()}` }, { quoted: msg });
        await sock.sendMessage(chatId, { text: parseLines(output, '📱', 'Phone Tracker') }, { quoted: msg });
    } catch (e) { await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}` }, { quoted: msg }); }
}

async function handleUser(sock, chatId, rawText, msg) {
const username = rawText.replace(/^#user\s*/i, '').trim().replace(/^@/, '');
const usernameArg = `@${username}`;
    console.log('USER rawText:', JSON.stringify(rawText));
    if (!username) return sock.sendMessage(chatId, { text: '❌ Usá: #user [username]\nEj: #user johndoe' }, { quoted: msg });
    await sock.sendMessage(chatId, { text: `🔍 Buscando *${username}* en redes sociales...\n⏳ Puede tardar unos segundos.` }, { quoted: msg });
    try {
const output = await runGhost(`user "${usernameArg}"`);
        await sock.sendMessage(chatId, { text: parseUser(username, output) }, { quoted: msg });
    } catch (e) { await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}` }, { quoted: msg }); }
}

module.exports = { handleIP, handleMiIP, handlePhone, handleUser };
