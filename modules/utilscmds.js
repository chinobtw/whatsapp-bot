// Calculadora segura sin deps externos
function safeCalc(expr) {
    if (!/^[\d\s\+\-\*\/\^\(\)\.\%a-z,]+$/i.test(expr)) throw new Error('inválido');
    const safe = expr
        .replace(/sqrt/gi,  'Math.sqrt')
        .replace(/abs/gi,   'Math.abs')
        .replace(/floor/gi, 'Math.floor')
        .replace(/ceil/gi,  'Math.ceil')
        .replace(/round/gi, 'Math.round')
        .replace(/log/gi,   'Math.log')
        .replace(/pi/gi,    'Math.PI')
        .replace(/\^/g,     '**');
    const result = Function('"use strict"; return (' + safe + ')')();
    if (typeof result !== 'number' || !isFinite(result)) throw new Error();
    return result;
}

async function handleCalc(sock, chatId, rawText, msg) {
    const expr = rawText.replace(/^#calc\s*/i, '').trim();
    if (!expr) return sock.sendMessage(chatId, { text: '❌ Usá: #calc [expresión]\n\n*Operadores:* + - * / ^ %\n*Funciones:* sqrt(), abs(), floor(), ceil(), round(), log()\n*Constante:* pi\n\nEj: #calc (10+5)*2\nEj: #calc sqrt(81)' }, { quoted: msg });
    try {
        const result = safeCalc(expr);
        const fmt = Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
        await sock.sendMessage(chatId, { text: `🧮 *${expr}*\n= *${fmt}*` }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Expresión inválida.\n\n*Operadores:* + - * / ^ %\n*Funciones:* sqrt(), abs(), floor(), ceil(), round(), log()\n*Constante:* pi\n\nEj: #calc sqrt(144) + 2^3' }, { quoted: msg });
    }
}

// Clima via wttr.in (sin API key)
async function handleClima(sock, chatId, rawText, msg) {
    const city = rawText.replace(/^#clima\s*/i, '').trim();
    if (!city) return sock.sendMessage(chatId, { text: '❌ Usá: #clima [ciudad], [país]\nEj: #clima Buenos Aires, Argentina' }, { quoted: msg });
    try {
        // Geocoding exacto
        const geoRes  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`, { headers: { 'User-Agent': 'WhatsAppBot/1.0' } });
        const geoJson = await geoRes.json();
        if (!geoJson.length) return sock.sendMessage(chatId, { text: '❌ No encontré esa ciudad.' }, { quoted: msg });

        const { lat, lon, display_name } = geoJson[0];
        const res  = await fetch(`https://wttr.in/${lat},${lon}?format=j1`);
        const json = await res.json();
        const cur  = json.current_condition[0];
        const desc = cur.lang_es?.[0]?.value || cur.weatherDesc[0].value;

        await sock.sendMessage(chatId, {
            text: `🌤️ *${display_name.split(',').slice(0,2).join(',')}*\n\n🌡️ Temperatura: *${cur.temp_C}°C* (sensación ${cur.FeelsLikeC}°C)\n☁️ ${desc}\n💧 Humedad: ${cur.humidity}%\n💨 Viento: ${cur.windspeedKmph} km/h`
        }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Error al obtener el clima.' }, { quoted: msg });
    }
}

// Definición via Free Dictionary API (es con fallback a en)
async function handleDefine(sock, chatId, rawText, msg) {
    const word = rawText.replace(/^#define\s*/i, '').trim().toLowerCase();
    if (!word) return sock.sendMessage(chatId, { text: '❌ Usá: #define [palabra]' }, { quoted: msg });
    try {
        const res  = await fetch(`https://es.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(word)}&prop=extracts&explaintext=1&format=json&origin=*`);
        const json = await res.json();
        const page = Object.values(json.query.pages)[0];
        if (page.missing !== undefined || !page.extract)
            return sock.sendMessage(chatId, { text: `❌ *${word}* no está en el diccionario.` }, { quoted: msg });
        // Solo sección español
        const español = page.extract.split('== Español ==')[1]?.split(/\n== [A-Z]/)[0] || page.extract;
        const clean = español
            .replace(/===.*?===/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 500);
        await sock.sendMessage(chatId, { text: `📖 *${word}*\n\n${clean}` }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Error al buscar la definición.' }, { quoted: msg });
    }
}

// QR via api.qrserver.com (sin API key)
async function handleQR(sock, chatId, rawText, msg) {
    const q = rawText.replace(/^#qr\s*/i, '').trim();
    if (!q) return sock.sendMessage(chatId, { text: '❌ Usá: #qr [texto o link]' }, { quoted: msg });
    try {
        const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(q)}`;
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        await sock.sendMessage(chatId, { image: buf, caption: `🔲 *QR generado*\n${q}` }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Error al generar el QR.' }, { quoted: msg });
    }
}

module.exports = { handleCalc, handleClima, handleDefine, handleQR };
