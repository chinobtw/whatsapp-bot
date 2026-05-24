const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const axios = require('axios');
const fs = require('fs');

const PHONE_NUMBER = '5493329471408';
const MEMORY_FILE = 'memory.json';
const PAUSED_FILE = './paused_chats.json';
const MASTER_NUMBERS = ['5493329471408', '255095958704187'];
const MAX_MESSAGES = 20;
const lastReplyTime = {};
const COOLDOWN_MS = 3000;

const { exec } = require('child_process');
const path = require('path');

// Carga chats pausados
let pausedChats = {};
if (fs.existsSync(PAUSED_FILE)) {
    try {
        pausedChats = JSON.parse(fs.readFileSync(PAUSED_FILE, 'utf8'));
    } catch (e) {
        pausedChats = {};
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, console),
        },
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false,
        retryRequestDelayMs: 5000,
        markOnlineOnConnect: false,
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n================================');
                console.log('Tu código de vinculación:', code);
                console.log('================================\n');
            } catch (e) {
                console.log('Error generando código:', e.message);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log('Conexión cerrada. Código:', statusCode);
            if (statusCode!== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('Bot conectado y listo!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    async function expandirLinkCorto(url) {
        try {
            const res = await axios.get(url, {
                maxRedirects: 5,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            return res.request.res.responseUrl || url;
        } catch (e) {
            return url;
        }
    }

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const chatId = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderNum = sender.split('@')[0];
        const isGroup = chatId.endsWith('@g.us');

        if (pausedChats[chatId]) return;

        // Comandos del maestro
        if (text.trim().toLowerCase() === '#stop' && MASTER_NUMBERS.includes(senderNum)) {
            pausedChats[chatId] = true;
            fs.writeFileSync(PAUSED_FILE, JSON.stringify(pausedChats));
            await sock.sendMessage(chatId, { text: '⏸️ Bot pausado en este chat.' });
            return;
        }

        if (text.trim().toLowerCase() === '#go' && MASTER_NUMBERS.includes(senderNum)) {
            delete pausedChats[chatId];
            fs.writeFileSync(PAUSED_FILE, JSON.stringify(pausedChats));
            await sock.sendMessage(chatId, { text: '▶️ Bot reactivado.' });
            return;
        }

        // Comando #kick
        if (text.toLowerCase().startsWith('#kick') && isGroup) {
            const groupMeta = await sock.groupMetadata(chatId);
            const isAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;

            if (!isAdmin) {
                await sock.sendMessage(chatId, { text: '❌ Solo los admins pueden usar este comando.' });
                return;
            }

            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length === 0) {
                await sock.sendMessage(chatId, { text: 'Usá: #kick @usuario' });
                return;
            }

            try {
                await sock.groupParticipantsUpdate(chatId, mentioned, 'remove');
                await sock.sendMessage(chatId, { text: `✅ Usuario expulsado.` });
            } catch (e) {
                await sock.sendMessage(chatId, { text: '❌ No puedo ejecutar *"#kick"* si no soy admin.' });
            }
            return;
        }

        // Comando #tt
        if (text.toLowerCase().startsWith('#tt ')) {
            const urlCorta = text.split(' ')[1];
            const url = await expandirLinkCorto(urlCorta);

            if (!url ||!url.includes('tiktok.com')) {
                await sock.sendMessage(chatId, {
                    text: '❌ Mandá un link válido de TikTok.\nEjemplo: #tt https://vm.tiktok.com/xxx'
                });
                return;
            }

            await sock.sendMessage(chatId, { text: '⬇️ Descargando contenido, bancame...' });
            const tmpFile = path.join(__dirname, `tiktok_${Date.now()}.mp4`);
            const comando = `yt-dlp -f best --no-playlist -o "${tmpFile}" "${url}"`;

            try {
                await new Promise((resolve, reject) => {
                    exec(comando, { timeout: 60000 }, (error, stdout, stderr) => {
                        if (error) reject(new Error(stderr || error.message));
                        else resolve();
                    });
                });

                const infoCmd = `yt-dlp --print "%(uploader)s|||%(title)s|||%(like_count)s|||%(view_count)s|||%(comment_count)s" --no-download "${url}"`;
                const info = await new Promise((resolve) => {
                    exec(infoCmd, { timeout: 20000 }, (error, stdout) => {
                        resolve(stdout?.trim() || '');
                    });
                });

                const [autor, titulo, likes, vistas, comentarios] = info.split('|||');

                const caption = `-----------------------------------\n` +
                    `¡Descargando contenido!\n\n` +
                    `> Creador: *${autor || 'Desconocido'}*\n` +
                    `> Link: *${url}*\n` +
                    `> Descripción: *${titulo || 'Sin descripción'}*\n\n` +
                    `> Likes: *${likes || 0}* comentarios: *${comentarios || 0}* vistas: *${vistas || 0}*`;

                await sock.sendMessage(chatId, {
                    video: { url: tmpFile },
                    caption: caption
                });

            } catch (e) {
                console.log('Error #tt (yt-dlp):', e.message);
                await sock.sendMessage(chatId, {
                    text: '❌ No se pudo descargar. El video puede ser privado, estar caído o tener restricción regional.'
                });
            } finally {
                fs.unlink(tmpFile, () => {});
            }
            return;
        }

        const getPhone = (id) => id.split(':')[0].split('@')[0];

        // Comando #close
        if (text.toLowerCase() === '#close') {
            if (!isGroup) return sock.sendMessage(chatId, { text: '❌ Esto solo funciona en grupos.' });

            const metadata = await sock.groupMetadata(chatId);
            const senderPhone = getPhone(sender);
            const participant = metadata.participants.find(p => getPhone(p.id) === senderPhone);
            if (!participant?.admin) return sock.sendMessage(chatId, { text: '❌ Solo admins pueden usar esto.' });

            const botPhone = getPhone(sock.user.id);
            const botLid = sock.user.lid? getPhone(sock.user.lid) : null;
            const botParticipant = metadata.participants.find(p => {
                const pPhone = getPhone(p.id);
                return pPhone === botPhone || (botLid && pPhone === botLid);
            });

            if (!botParticipant?.admin) return sock.sendMessage(chatId, { text: '❌ Necesito ser admin para cerrar el grupo.' });

            await sock.groupSettingUpdate(chatId, 'announcement');
            return sock.sendMessage(chatId, { text: '🔒 Grupo cerrado. Solo admins pueden escribir.' });
        }

        // Comando #open
        if (text.toLowerCase() === '#open') {
            if (!isGroup) return sock.sendMessage(chatId, { text: '❌ Esto solo funciona en grupos.' });

            const metadata = await sock.groupMetadata(chatId);
            const senderPhone = getPhone(sender);
            const participant = metadata.participants.find(p => getPhone(p.id) === senderPhone);
            if (!participant?.admin) return sock.sendMessage(chatId, { text: '❌ Solo admins pueden usar esto.' });

            const botPhone = getPhone(sock.user.id);
            const botLid = sock.user.lid? getPhone(sock.user.lid) : null;
            const botParticipant = metadata.participants.find(p => {
                const pPhone = getPhone(p.id);
                return pPhone === botPhone || (botLid && pPhone === botLid);
            });

            if (!botParticipant?.admin) return sock.sendMessage(chatId, { text: '❌ Necesito ser admin para abrir el grupo.' });

            await sock.groupSettingUpdate(chatId, 'not_announcement');
            return sock.sendMessage(chatId, { text: '🔓 Grupo abierto. Todos pueden escribir.' });
        }

        // Comando #s sticker
        if (text.toLowerCase() === '#s') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const messageType = Object.keys(msg.message || {})[0];

            let mediaMsg = null;
            if (messageType === 'imageMessage') {
                mediaMsg = msg;
            } else if (quoted?.imageMessage) {
                mediaMsg = { message: quoted };
            } else {
                return sock.sendMessage(chatId, { text: '❌ Mandá una imagen con #s o respondé a una imagen con #s' });
            }

            try {
                const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, {
                    logger: console,
                    reuploadRequest: sock.updateMediaMessage
                });

                const tmpIn = `/sdcard/tmp_${Date.now()}.jpg`;
                const tmpOut = `/sdcard/sticker_${Date.now()}.webp`;

                fs.writeFileSync(tmpIn, buffer);

                await new Promise((resolve, reject) => {
                    exec(`ffmpeg -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" -c:v libwebp -q:v 80 "${tmpOut}" -y`,
                        (error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                });

                const stickerBuffer = fs.readFileSync(tmpOut);
                await sock.sendMessage(chatId, {
                    sticker: stickerBuffer,
                    stickerMetadata: { packname: 'Bot', author: 'DEV by Vand4lw' }
                });

                fs.unlinkSync(tmpIn);
                fs.unlinkSync(tmpOut);

            } catch (err) {
                console.log(err);
                return sock.sendMessage(chatId, { text: '❌ No pude hacer el sticker. Probá con otra imagen.' });
            }
            return;
        }

        // promote & demote
        function isAdmin(groupMetadata, jid) {
            const normJid = jid.split(':')[0] + '@s.whatsapp.net';
            const normLid = jid.includes('@lid')? jid : null;

            for (const p of groupMetadata.participants) {
                const pJid = p.phoneNumber || p.id.split(':')[0] + '@s.whatsapp.net';
                const pLid = p.id.includes('@lid')? p.id : null;

                if (pJid === normJid || pLid === normLid || p.id === jid) {
                    return p.admin === 'admin' || p.admin === 'superadmin';
                }
            }
            return false;
        }

        if (text.startsWith('#promote') || text.startsWith('#demote')) {
            if (!chatId.endsWith('@g.us')) return sock.sendMessage(chatId, { text: '❌ Solo en grupos' });

            const groupMetadata = await sock.groupMetadata(chatId);
            const botJid = sock.user.id;
            const senderJid = sender;

            const botIsAdmin = isAdmin(groupMetadata, botJid);
            const senderIsAdmin = isAdmin(groupMetadata, senderJid);

            if (!botIsAdmin) return sock.sendMessage(chatId, { text: '❌ Necesito ser admin' });
            if (!senderIsAdmin) return sock.sendMessage(chatId, { text: '❌ Solo admins' });

            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned?.[0]) return sock.sendMessage(chatId, { text: '❌ Menciona a alguien' });

            try {
                await sock.groupParticipantsUpdate(chatId, mentioned, text.startsWith('#promote')? 'promote' : 'demote');
                await sock.sendMessage(chatId, { text: '✅ Hecho' });
            } catch (e) {
                await sock.sendMessage(chatId, { text: '❌ Error: ' + e.message });
            }
            return;
        }

        // #mp3
        if (text.startsWith('#mp3')) {
            const query = text.replace('#mp3', '').trim();
            if (!query) return sock.sendMessage(chatId, { text: '❌ Pon el nombre de la canción. Ej: #mp3 despacito' });

            await sock.sendMessage(chatId, { text: '🔍 Buscando...' });

            try {
                const safeQuery = query.replace(/"/g, '\\"');
                const filePath = path.join(__dirname, `temp_${Date.now()}.mp3`);
                const cookiesPath = path.join(__dirname, 'cookies.txt');

                if (!fs.existsSync(cookiesPath)) {
                    return sock.sendMessage(chatId, { text: '❌ Falta cookies.txt en la carpeta del bot' });
                }

                const info = await new Promise((resolve, reject) => {
                    exec(`yt-dlp "ytsearch1:${safeQuery}" -j --no-playlist`,
                        { timeout: 20000 },
                        (err, stdout) => err? reject(err) : resolve(JSON.parse(stdout)));
                });

                const title = info.title || 'Sin título';
                const uploader = info.uploader || 'Desconocido';
                const duration = info.duration? `${Math.floor(info.duration/60)}:${String(info.duration%60).padStart(2,'0')}` : '??';
                const thumbnail = info.thumbnail;

                await sock.sendMessage(chatId, {
                    image: { url: thumbnail },
                    caption: `ㅤ----------------\n¡Descargando!\nㅤ----------------\n\n> *${title}*\n> *Duración:* ${duration}\n> *Artista:* ${uploader}\n> *Calidad:* 128kbps mp3`
                }, { quoted: msg });

                await new Promise((resolve, reject) => {
                    const cmd = `yt-dlp "${info.webpage_url}" -f bestaudio -x --audio-format mp3 --audio-quality 5 --cookies "${cookiesPath}" --js-runtimes node --remote-components ejs:github -o "${filePath}"`;
                    exec(cmd, { timeout: 90000, maxBuffer: 1024*1024*50 },
                        (err, stdout, stderr) => {
                            if (err) {
                                console.log('YTDLP STDERR:', stderr);
                                return reject(stderr || err);
                            }
                            resolve();
                        });
                });

                if (!fs.existsSync(filePath)) throw new Error('No se creó el archivo');

                const stats = fs.statSync(filePath);
                if (stats.size > 16 * 1024 * 1024) {
                    fs.unlinkSync(filePath);
                    return sock.sendMessage(chatId, { text: `❌ Pesa ${(stats.size/1024/1024).toFixed(1)}MB. Máx 16MB` });
                }

                await sock.sendMessage(chatId, {
                    audio: { url: filePath },
                    mimetype: 'audio/mpeg',
                    fileName: `${title}.mp3`,
                    ptt: false
                }, { quoted: msg });

                fs.unlinkSync(filePath);

            } catch (e) {
                console.log('Error MP3:', e);
                await sock.sendMessage(chatId, { text: '❌ Falló la descarga. Probá con otro nombre o espera 2 min.' });
            }
            return;
        }

        // #lyrics
        if (text.startsWith('#lyrics')) {
            const query = text.replace('#lyrics', '').trim();
            if (!query) return sock.sendMessage(chatId, { text: '❌ Pon el nombre de la canción. Ej: #lyrics Bohemian Rhapsody' });

            await sock.sendMessage(chatId, { text: '🔍 Buscando letra...' });

            try {
                const [artist, title] = query.split(' - ');
                const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist || query)}/${encodeURIComponent(title || '')}`;

                const res = await fetch(url);
                const data = await res.json();

                if (!data.lyrics) {
                    return sock.sendMessage(chatId, { text: '❌ No encontré la letra para esa canción' });
                }

                let lyrics = data.lyrics.trim();
                if (lyrics.length > 4000) {
                    lyrics = lyrics.substring(0, 4000) + '\n\n...[letra recortada]';
                }

                await sock.sendMessage(chatId, {
                    text: `🎵 *${query}*\n\n${lyrics}`
                }, { quoted: msg });

            } catch (e) {
                console.log('Error Lyrics:', e);
                await sock.sendMessage(chatId, { text: '❌ Error buscando la letra. Probá con "Artista - Canción"' });
            }
            return;
        }
    });
}

startBot();
