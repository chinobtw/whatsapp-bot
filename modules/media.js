const axios = require('axios');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { data, FILES, COOKIE_FILE } = require('../config');
const { saveJSON } = require('./utils');

const execAsync = promisify(exec);

async function expandirLinkCorto(url) {
    try {
        const res = await axios.get(url, { maxRedirects: 5, headers: { 'User-Agent': 'Mozilla/5.0' } });
        return res.request.res.responseUrl || url;
    } catch (e) { return url; }
}

// ─────────────────────────────────────────────
// TIKTOK — una sola llamada a yt-dlp con --print-json
// descarga Y devuelve metadatos al mismo tiempo
// ─────────────────────────────────────────────
async function handleTT(sock, chatId, text) {
    const urlCorta = text.split(' ')[1];
    const url = await expandirLinkCorto(urlCorta);

    if (!url || !url.includes('tiktok.com')) {
        await sock.sendMessage(chatId, { text: '❌ Mandá un link válido de TikTok.\nEjemplo: #tt https://vm.tiktok.com/xxx' });
        return;
    }

    await sock.sendMessage(chatId, { text: '⬇️ Descargando contenido, bancame...' });
    const tmpFile = path.join(os.tmpdir(), `tiktok_${Date.now()}.mp4`);

    try {
        // --print-json: descarga Y imprime JSON en stdout — 1 sola llamada en vez de 2
        const { stdout } = await execAsync(
            `yt-dlp -f "best[ext=mp4]/best" --no-playlist --print-json --no-warnings -o "${tmpFile}" "${url}"`,
            { timeout: 90000, maxBuffer: 10 * 1024 * 1024 }
        );

        let info = {};
        try { info = JSON.parse(stdout.trim().split('\n')[0]); } catch (e) {}

        const autor       = info.uploader || 'Desconocido';
        const titulo      = info.title || 'Sin descripción';
        const likes       = info.like_count || 0;
        const vistas      = info.view_count || 0;
        const comentarios = info.comment_count || 0;

        const caption = `-----------------------------------\n¡Descargando contenido!\n\n> Creador: *${autor}*\n> Link: *${url}*\n> Descripción: *${titulo}*\n\n> Likes: *${likes}* comentarios: *${comentarios}* vistas: *${vistas}*`;

        await sock.sendMessage(chatId, { video: fs.readFileSync(tmpFile), caption });

    } catch (e) {
        console.log('Error #tt:', e.message);
        await sock.sendMessage(chatId, { text: '❌ No se pudo descargar. El video puede ser privado o tener restricción.' });
    } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
}

// ─────────────────────────────────────────────
// MP3 — búsqueda + descarga directa via axios
//
// Flujo optimizado:
//   1. yt-dlp -j  →  obtiene info + URL directa del stream opus
//   2. axios       →  descarga el stream directo (sin 2do yt-dlp)
//   3. ffmpeg      →  remux rápido webm→opus (sin re-encode)
//
// Si la URL es DASH/HLS (fragmentada), cae al fallback con yt-dlp
// ─────────────────────────────────────────────
async function handleMp3(sock, chatId, query, msg) {
    const tmpDir  = process.env.TMPDIR || '/data/data/com.termux/files/usr/tmp';
    const tmpFile = path.join(tmpDir, `mp3_${Date.now()}.mp4`);
    const YT_KEY  = 'AIzaSyAiHvatcVw1928xjGRJhr1zSi4RBf-VZKY';
    const SYLPHY  = 'sylphy-okf2a9E';

    try {
        await sock.sendMessage(chatId, { text: '⏳ Buscando...' }, { quoted: msg });

        const isUrl = /^https?:\/\//i.test(query);
        let videoUrl = query;

        if (!isUrl) {
            const searchRes  = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${YT_KEY}`);
            const searchJson = await searchRes.json();
            const item = searchJson.items?.[0];
            if (!item) return sock.sendMessage(chatId, { text: '❌ No encontré resultados.' }, { quoted: msg });
            videoUrl = `https://www.youtube.com/watch?v=${item.id.videoId}`;
        }

        const sylRes  = await fetch(`https://sylphyy.xyz/download/v2/ytmp4?url=${encodeURIComponent(videoUrl)}&api_key=${SYLPHY}`);
        const sylJson = await sylRes.json();
        if (!sylJson.status || !sylJson.result?.dl_url)
            return sock.sendMessage(chatId, { text: '❌ No se pudo obtener el audio.' }, { quoted: msg });

        const dlRes = await fetch(sylJson.result.dl_url, {
            headers: {
                'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
                'Referer': 'https://www.youtube.com/'
            }
        });
        const buf = Buffer.from(await dlRes.arrayBuffer());
        fs.writeFileSync(tmpFile, buf);

        if (!fs.existsSync(tmpFile)) throw new Error('Archivo no generado');

        const size = fs.statSync(tmpFile).size;
        if (size > 64 * 1024 * 1024) {
            fs.unlinkSync(tmpFile);
            return sock.sendMessage(chatId, { text: '❌ El archivo pesa más de 64MB.' }, { quoted: msg });
        }

        await sock.sendMessage(chatId, {
            audio: fs.readFileSync(tmpFile),
            mimetype: 'audio/mp4',
            ptt: false
        }, { quoted: msg });

        fs.unlinkSync(tmpFile);

    } catch (e) {
        console.error('[MP3]', e.message);
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
        await sock.sendMessage(chatId, { text: '❌ Error al descargar el audio.' }, { quoted: msg });
    }
}

// ─────────────────────────────────────────────
// LETRA — sin cambios (ya era óptimo)
// ─────────────────────────────────────────────
async function handleLyrics(sock, chatId, query, msg) {
    await sock.sendMessage(chatId, { text: '🔍 Buscando letra...' });
    try {
        const searchRes = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
        const results = searchRes.data;
        if (!results || results.length === 0) return sock.sendMessage(chatId, { text: '❌ No encontré la letra para esa canción' });
        const song = results[0];
        let lyrics = song.plainLyrics || song.syncedLyrics || '';
        if (!lyrics) return sock.sendMessage(chatId, { text: '❌ Esta canción no tiene letra disponible' });
        if (lyrics.length > 4000) lyrics = lyrics.substring(0, 4000) + '\n\n...[letra recortada]';
        await sock.sendMessage(chatId, { text: `🎵 *${song.trackName}* — ${song.artistName}\n\n${lyrics}` }, { quoted: msg });
    } catch (e) {
        console.log('Error Lyrics:', e);
        await sock.sendMessage(chatId, { text: '❌ Error buscando la letra.' });
    }
}

// ─────────────────────────────────────────────
// STICKER — sin cambios
// ─────────────────────────────────────────────
async function handleSticker(sock, chatId, msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const messageType = Object.keys(msg.message || {})[0];
    let mediaMsg = null;
    if (messageType === 'imageMessage') { mediaMsg = msg; }
    else if (quoted?.imageMessage) { mediaMsg = { message: quoted }; }
    else { return sock.sendMessage(chatId, { text: '❌ Mandá una imagen con #s o respondé a una imagen con #s' }); }
    try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage });
        const tmpIn  = path.join(os.tmpdir(), `tmp_${Date.now()}.jpg`);
        const tmpOut = path.join(os.tmpdir(), `sticker_${Date.now()}.webp`);
        fs.writeFileSync(tmpIn, buffer);
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" -c:v libwebp -q:v 80 "${tmpOut}" -y`,
                (error) => { if (error) reject(error); else resolve(); });
        });
        const stickerBuffer = fs.readFileSync(tmpOut);
        await sock.sendMessage(chatId, { sticker: stickerBuffer, stickerMetadata: { packname: 'Bot', author: 'DEV by Vand4lw' } });
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
    } catch (err) {
        console.log(err);
        return sock.sendMessage(chatId, { text: '❌ No pude hacer el sticker.' });
    }
}

// ─────────────────────────────────────────────
// PINTEREST — sin cambios
// ─────────────────────────────────────────────
async function handlePin(sock, chatId, query, type) {
    const isVideo = type === 'vid';
    const cacheKey = `${chatId}:${query}:${type}`;
    const sentIds = data.pinCache[cacheKey] || [];
    await sock.sendMessage(chatId, { text: `🔍 Buscando ${isVideo ? 'video' : 'imagen'} en Pinterest...` });
    try {
        const searchUrl = `https://ar.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
        const rawOutput = await new Promise((resolve, reject) => {
            exec(`gallery-dl -j --range 1-40 --cookies "${COOKIE_FILE}" "${searchUrl}"`,
                { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
                (err, stdout, stderr) => { if (err) return reject(new Error(stderr || err.message)); resolve(stdout); }
            );
        });
        const items = JSON.parse(rawOutput);
        const pins = items
            .filter(item => item[0] === 3)
            .map(item => ({
                url: item[2]?.images?.orig?.url || item[1],
                title: item[2].title || item[2].grid_title || item[2].description || 'Sin título',
                link: `https://pinterest.com/pin/${item[2].id}`,
                creator: item[2].pinner?.username || 'Desconocido',
                board: item[2].board?.name || 'N/A'
            }));
        if (pins.length === 0) return sock.sendMessage(chatId, { text: '❌ No encontré resultados' });
        let filtered = pins.filter(r => !sentIds.includes(r.url));
        if (filtered.length === 0) {
            data.pinCache[cacheKey] = [];
            saveJSON(FILES.PIN_CACHE, data.pinCache);
            filtered = pins;
        }
        const chosen = filtered[Math.floor(Math.random() * filtered.length)];
        const caption = `\u200c\u200c\u200d\u200c\u200c\u200d\u200c\u200c\u200d\u200c\u200c\u200d\u200c\u200c\u200dㅤ¿¡Download!? \\\\Ö// ¡Pinterest ${isVideo ? 'VID' : 'IMG'}!\nㅤ--------------------------------------------\n\nㅤ *_Title_* ㅤㅤ\n> ㅤㅤ ${chosen.title} ㅤㅤ\nㅤ *_Creator_* ㅤㅤ\n> ㅤㅤ ${chosen.creator} ㅤㅤ\nㅤ *_Tablero_* ㅤㅤ\n> ㅤㅤ ${chosen.board} ㅤㅤ\nㅤ--------------------------------------------`;
        if (isVideo) {
            const tmpDir = path.join(os.tmpdir(), `pin_tmp_${Date.now()}`);
            fs.mkdirSync(tmpDir, { recursive: true });
            let enviado = false;
            try {
                for (const pin of [chosen, ...filtered.filter(p => p.url !== chosen.url)]) {
                    fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
                    await new Promise((resolve) => { exec(`gallery-dl --cookies "${COOKIE_FILE}" -D "${tmpDir}" "${pin.link}"`, { timeout: 60000 }, () => resolve()); });
                    const files = fs.readdirSync(tmpDir);
                    const videoFile = files.find(f => ['.mp4', '.webm', '.mov'].includes(path.extname(f).toLowerCase()));
                    if (videoFile) {
                        const fullPath = path.join(tmpDir, videoFile);
                        const ext = path.extname(videoFile).toLowerCase();
                        const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
                        await sock.sendMessage(chatId, { video: fs.readFileSync(fullPath), mimetype: mimeMap[ext] || 'video/mp4', caption });
                        enviado = true;
                        break;
                    }
                }
                if (!enviado) await sock.sendMessage(chatId, { text: '❌ No encontré videos reales. Probá otra búsqueda.' });
            } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
        } else {
            await sock.sendMessage(chatId, { image: { url: chosen.url }, caption });
        }
        sentIds.push(chosen.url);
        data.pinCache[cacheKey] = sentIds;
        saveJSON(FILES.PIN_CACHE, data.pinCache);
    } catch (err) {
        console.error('Pinterest error:', err.message);
        sock.sendMessage(chatId, { text: '❌ Error buscando en Pinterest' });
    }
}

// ─────────────────────────────────────────────
// TO IMG — sin cambios
// ─────────────────────────────────────────────
async function handleToImg(sock, chatId, msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const messageType = Object.keys(msg.message || {})[0];
    let mediaMsg = null;
    let isSticker = false;
    if (messageType === 'imageMessage') { mediaMsg = msg; }
    else if (messageType === 'stickerMessage') { mediaMsg = msg; isSticker = true; }
    else if (quoted?.imageMessage) { mediaMsg = { message: quoted }; }
    else if (quoted?.stickerMessage) { mediaMsg = { message: quoted }; isSticker = true; }
    else { return sock.sendMessage(chatId, { text: '❌ Respondé a una imagen o sticker con #toimg' }, { quoted: msg }); }
    try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage });
        await sock.sendMessage(chatId, { image: buffer, mimetype: 'image/jpeg', caption: '' }, { quoted: msg });
    } catch (err) {
        console.log('Error #toimg:', err);
        return sock.sendMessage(chatId, { text: '❌ No pude convertir la imagen.' }, { quoted: msg });
    }
}
    //#ver
async function handleVer(sock, chatId, msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return sock.sendMessage(chatId, { text: '❌ Respondé a una foto o video con #ver.' }, { quoted: msg });

    const imgMsg = quoted.imageMessage;
    const vidMsg = quoted.videoMessage;
    const stickerMsg = quoted.stickerMessage;

    if (!imgMsg && !vidMsg && !stickerMsg)
        return sock.sendMessage(chatId, { text: '❌ Solo funciona con fotos, videos o stickers.' }, { quoted: msg });

    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const quotedFull = {
            key: {
                remoteJid: chatId,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: quoted
        };
        const buffer = await downloadMediaMessage(quotedFull, 'buffer', {});

        if (imgMsg || stickerMsg) {
            await sock.sendMessage(chatId, { image: buffer }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { video: buffer }, { quoted: msg });
        }
    } catch (e) {
        console.error('[VER]', e);
        await sock.sendMessage(chatId, { text: '❌ No pude descargar el archivo.' }, { quoted: msg });
    }
}

async function handleYtSearch(sock, chatId, query, msg) {
    if (!query) return sock.sendMessage(chatId, { text: '❌ Usá: #ytsearch [búsqueda]' }, { quoted: msg });
    try {
        await sock.sendMessage(chatId, { text: '🔍 Buscando...' }, { quoted: msg });
        const { stdout } = await execAsync(
            `yt-dlp "ytsearch10:${query.replace(/"/g, '')}" --print "%(title)s|||%(uploader)s|||%(webpage_url)s" --no-playlist --no-warnings --socket-timeout 10 --flat-playlist`,
            { timeout: 30000 }
        );
        const lines = stdout.trim().split('\n').filter(Boolean);
        if (!lines.length) return sock.sendMessage(chatId, { text: '❌ Sin resultados.' }, { quoted: msg });
        const text = lines.map((line, i) => {
            const [title, uploader, url] = line.split('|||');
            return `*${i + 1}. ${title}*\n> *Canal:* ${uploader}\n> ${url}`;
        }).join('\n\n');
        await sock.sendMessage(chatId, { text }, { quoted: msg });
    } catch (e) {
        console.error('[YTSEARCH]', e.message);
        await sock.sendMessage(chatId, { text: '❌ Error al buscar.' }, { quoted: msg });
    }
}

async function handleFb(sock, chatId, rawText, msg) {
    const url = rawText.replace(/^#fb\s*/i, '').trim();
    if (!url || !/^https?:\/\//i.test(url))
        return sock.sendMessage(chatId, { text: '❌ Usá: #fb [link de Facebook]' }, { quoted: msg });
    await handleGenericVideo(sock, chatId, url, msg);
}

async function handleIg(sock, chatId, rawText, msg) {
    const url = rawText.replace(/^#ig\s*/i, '').trim();
    if (!url || !/^https?:\/\//i.test(url))
        return sock.sendMessage(chatId, { text: '❌ Usá: #ig [link de Instagram]' }, { quoted: msg });
    await handleGenericVideo(sock, chatId, url, msg);
}

async function handleMp4(sock, chatId, rawText, msg) {
    const url = rawText.replace(/^#mp4\s*/i, '').trim();
    if (!url || !/^https?:\/\//i.test(url))
        return sock.sendMessage(chatId, { text: '❌ Usá: #mp4 [link]' }, { quoted: msg });
    await handleGenericVideo(sock, chatId, url, msg);
}

async function handleGenericVideo(sock, chatId, url, msg) {
    const tmpDir  = process.env.TMPDIR || '/data/data/com.termux/files/usr/tmp';
    const tmpFile = path.join(tmpDir, `vid_${Date.now()}.mp4`);
    const nodePath = process.execPath;
    try {
        await sock.sendMessage(chatId, { text: '⏳ Descargando...' }, { quoted: msg });
        await execAsync(
            `yt-dlp "${url}" \
             -f "best[ext=mp4][filesize<50M]/best[ext=mp4]/best" \
             --no-playlist --no-warnings \
             --js-runtimes "node:${nodePath}" \
             --cookies /data/data/com.termux/files/home/cookies.txt \
             -o "${tmpFile}"`,
            { timeout: 180000, maxBuffer: 20 * 1024 * 1024 }
        );
        if (!fs.existsSync(tmpFile)) throw new Error('Archivo no generado');
        const size = fs.statSync(tmpFile).size;
        if (size > 64 * 1024 * 1024) {
            fs.unlinkSync(tmpFile);
            return sock.sendMessage(chatId, { text: `❌ El video pesa más de 64MB.` }, { quoted: msg });
        }
        await sock.sendMessage(chatId, {
            video: fs.readFileSync(tmpFile),
            mimetype: 'video/mp4'
        }, { quoted: msg });
        fs.unlinkSync(tmpFile);
    } catch (e) {
        console.error('[VIDEO]', e.message);
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
        await sock.sendMessage(chatId, { text: '❌ No pude descargar el video.' }, { quoted: msg });
    }
}

async function handleManga(sock, chatId, rawText, msg) {
    const input = rawText.replace(/^#manga\s*/i, '').trim();
    if (!input) return sock.sendMessage(chatId, { text: '❌ Usá: #manga [título] [capítulo]\nEj: #manga Berserk 1\nEj: #manga Berserk 1-5' }, { quoted: msg });

    const parts = input.match(/^(.+?)\s+(\d+)(?:-(\d+))?$/);
    if (!parts) return sock.sendMessage(chatId, { text: '❌ Usá: #manga [título] [capítulo]\nEj: #manga Berserk 1' }, { quoted: msg });

    const title   = parts[1].trim();
    const chapStart = parseInt(parts[2]);
    const chapEnd   = parts[3] ? parseInt(parts[3]) : chapStart;

    if (chapEnd - chapStart > 4)
        return sock.sendMessage(chatId, { text: '❌ Máximo 5 capítulos a la vez.' }, { quoted: msg });

    const nodePath = process.execPath;
    const tmpDir   = process.env.TMPDIR || '/data/data/com.termux/files/usr/tmp';

    try {
        await sock.sendMessage(chatId, { text: `🔍 Buscando *${title}*...` }, { quoted: msg });

        // 1. Buscar manga
        const searchRes  = await fetch(`https://api.mangadex.org/manga?title=${encodeURIComponent(title)}&limit=5&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`);
        const searchJson = await searchRes.json();
        if (!searchJson.data?.length)
            return sock.sendMessage(chatId, { text: `❌ No encontré *${title}* en MangaDex.` }, { quoted: msg });

        const manga   = searchJson.data[0];
        const mangaId = manga.id;
        const mangaTitle = manga.attributes.title.en || manga.attributes.title[Object.keys(manga.attributes.title)[0]];

        await sock.sendMessage(chatId, { text: `📖 Encontrado: *${mangaTitle}*\n⏳ Descargando capítulo${chapEnd > chapStart ? 's' : ''} ${chapStart}${chapEnd > chapStart ? '-' + chapEnd : ''}...` }, { quoted: msg });

        // 2. Obtener capítulos
        const feedRes  = await fetch(`https://api.mangadex.org/manga/${mangaId}/feed?translatedLanguage[]=es&translatedLanguage[]=en&order[chapter]=asc&limit=100&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`);
        const feedJson = await feedRes.json();

        const chapters = feedJson.data?.filter(c =>
            parseFloat(c.attributes.chapter) >= chapStart &&
            parseFloat(c.attributes.chapter) <= chapEnd
        ) || [];

        if (!chapters.length)
            return sock.sendMessage(chatId, { text: `❌ No encontré el capítulo ${chapStart} de *${mangaTitle}*.` }, { quoted: msg });

        // Desduplicar por número de capítulo (preferir español)
        const chapMap = {};
        for (const c of chapters) {
            const num = c.attributes.chapter;
            const lang = c.attributes.translatedLanguage;
            if (!chapMap[num] || lang === 'es') chapMap[num] = c;
        }

        for (const chap of Object.values(chapMap)) {
            const chapNum = chap.attributes.chapter;
            const pagesRes  = await fetch(`https://api.mangadex.org/at-home/server/${chap.id}`);
            const pagesJson = await pagesRes.json();
            const baseUrl   = pagesJson.baseUrl;
            const hash      = pagesJson.chapter.hash;
            const files     = pagesJson.chapter.data;

            // Descargar imágenes
            const imgPaths = [];
            for (let i = 0; i < files.length; i++) {
                const imgUrl  = `${baseUrl}/data/${hash}/${files[i]}`;
                const imgRes  = await fetch(imgUrl);
                const buf     = Buffer.from(await imgRes.arrayBuffer());
                const imgPath = path.join(tmpDir, `manga_${Date.now()}_${i}.jpg`);
                fs.writeFileSync(imgPath, buf);
                imgPaths.push(imgPath);
            }

            // Generar PDF con Python/Pillow
            const pdfPath  = path.join(tmpDir, `manga_${mangaTitle}_${chapNum}.pdf`);
            const imgList  = imgPaths.map(p => `"${p}"`).join(' ');
            await execAsync(
                `python3 -c "
from PIL import Image
import os
imgs = [${imgPaths.map(p => `'${p}'`).join(',')}]
pages = []
for i in imgs:
    img = Image.open(i).convert('RGB')
    pages.append(img)
if pages:
    pages[0].save('${pdfPath}', save_all=True, append_images=pages[1:])
"`,
                { timeout: 60000 }
            );

            // Limpiar imágenes
            imgPaths.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });

            if (!fs.existsSync(pdfPath)) throw new Error('PDF no generado');

            const size = fs.statSync(pdfPath).size;
            if (size > 64 * 1024 * 1024) {
                fs.unlinkSync(pdfPath);
                await sock.sendMessage(chatId, { text: `❌ Cap. ${chapNum} pesa más de 64MB.` }, { quoted: msg });
                continue;
            }

            await sock.sendMessage(chatId, {
                document: fs.readFileSync(pdfPath),
                mimetype: 'application/pdf',
                fileName: `${mangaTitle} - Cap. ${chapNum}.pdf`
            }, { quoted: msg });

            fs.unlinkSync(pdfPath);
        }

    } catch (e) {
        console.error('[MANGA]', e.message);
        await sock.sendMessage(chatId, { text: '❌ Error al descargar el manga.' }, { quoted: msg });
    }
}

async function handleStickerPack(sock, chatId, rawText, msg) {
    const url = rawText.replace(/^#stickerpack\s*/i, '').trim();
    if (!url || !/sticker\.ly\/s\//i.test(url))
        return sock.sendMessage(chatId, { text: '❌ Usá: #stickerpack [link de sticker.ly]\nEj: #stickerpack https://sticker.ly/s/0EMLYD' }, { quoted: msg });

    try {
        await sock.sendMessage(chatId, { text: '⏳ Descargando pack...' }, { quoted: msg });

        const res  = await fetch(`https://sylphyy.xyz/download/stickerly?url=${encodeURIComponent(url)}&api_key=sylphy-okf2a9E`);
        const json = await res.json();
        if (!json.status || !json.result?.stickers?.length)
            return sock.sendMessage(chatId, { text: '❌ No se pudo obtener el pack.' }, { quoted: msg });

        const { name, stickers } = json.result;
        await sock.sendMessage(chatId, { text: `🗂️ *${name}*\n${stickers.length} stickers. Enviando...` }, { quoted: msg });

for (const sticker of stickers) {
    try {
        const tmpDir  = process.env.TMPDIR || '/data/data/com.termux/files/usr/tmp';
        const tmpPng  = path.join(tmpDir, `stk_${Date.now()}.png`);
        const tmpWebp = tmpPng.replace('.png', '.webp');

        const imgRes = await fetch(sticker.imageUrl);
        const buf    = Buffer.from(await imgRes.arrayBuffer());
        fs.writeFileSync(tmpPng, buf);

        await execAsync(`ffmpeg -i "${tmpPng}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:white@0" "${tmpWebp}" -y -loglevel quiet`, { timeout: 15000 });

        if (fs.existsSync(tmpWebp)) {
            await sock.sendMessage(chatId, { sticker: fs.readFileSync(tmpWebp) }, { quoted: msg });
            fs.unlinkSync(tmpWebp);
        }
        if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
        await new Promise(r => setTimeout(r, 500));
    } catch (_) {}
}
    } catch (e) {
        console.error('[STICKERPACK]', e.message);
        await sock.sendMessage(chatId, { text: '❌ Error al descargar el pack.' }, { quoted: msg });
    }
}

module.exports = { handleTT, handleMp3, handleLyrics, handleSticker, handlePin, handleToImg, handleVer, handleYtSearch, handleIg, handleFb, handleMp4, handleManga, handleStickerPack };
