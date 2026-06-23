const fs = require('fs');
const { MANCER_API_KEY } = require('../config');
const { OPENROUTER_API_KEY } = require('../config');
const IA_FILE = './ia_history.json';
const RP_FILE = './rp_history.json';
const RP_SAVES_FILE = './rp_saves.json';
let rpSaves = {};
try { rpSaves = JSON.parse(fs.readFileSync(RP_SAVES_FILE, 'utf8')); } catch (_) {}
function saveRpSaves() { fs.writeFileSync(RP_SAVES_FILE, JSON.stringify(rpSaves)); }

let conversationHistory = new Map();
let rpSessions = new Map();
try { conversationHistory = new Map(Object.entries(JSON.parse(fs.readFileSync(IA_FILE, 'utf8')))); } catch (_) {}
try { rpSessions = new Map(Object.entries(JSON.parse(fs.readFileSync(RP_FILE, 'utf8')))); } catch (_) {}

let _iaTimer = null, _rpTimer = null;
function saveIa() { clearTimeout(_iaTimer); _iaTimer = setTimeout(() => fs.writeFileSync(IA_FILE, JSON.stringify(Object.fromEntries(conversationHistory))), 2000); }
function saveRp() { clearTimeout(_rpTimer); _rpTimer = setTimeout(() => fs.writeFileSync(RP_FILE, JSON.stringify(Object.fromEntries(rpSessions))), 2000); }

// ─── Construye el system prompt base. Se llama al iniciar Y al reinyectar. ───
// Para Mistral (modo normal) — en español, formato con guiones
function buildSystemPromptNormal(personaje, pushName) {
    return `Eres ${personaje}. Encarnás este personaje de forma absoluta e irrompible.

REGLAS OBLIGATORIAS — NUNCA LAS ROMPAS:
1. Respondé SIEMPRE como ${personaje}. Nunca salgas del personaje.
2. PROHIBIDO hablar, actuar, pensar o narrar por ${pushName} bajo cualquier circunstancia. ${pushName} es el usuario y solo él decide sus acciones.
3. Formato de respuesta obligatorio:
   > [narración de acción en tercera persona]
   [diálogo del personaje]
   —[aclaración breve o acción rápida]—
4. Nunca cortés una respuesta a la mitad. Siempre terminá la escena con un cierre natural.
5. Respondé siempre en español. Respuestas extensas y detalladas.
6. Apegate al físico, pronombres, actitud y narrativa de ${personaje}.`;
}

// Para MythoMax (modo lemon) — en inglés, formato con comillas y asteriscos
function buildSystemPromptLemon(personaje, pushName) {
    return `You are ${personaje}, a fictional character in an immersive roleplay. You must embody this character completely and without exception.

ABSOLUTE RULES — NEVER BREAK THESE:
1. You are ONLY ${personaje}. Never break character for any reason.
2. NEVER write actions, dialogue, thoughts or decisions for ${pushName}. ${pushName} is the user and controls themselves entirely. If you write for ${pushName}, you have failed.
3. Your responses must be long, detailed and immersive. Minimum 4-5 paragraphs. Never cut a scene short.
4. Always write in Spanish, no matter what.
5. Stay true to ${personaje}'s personality, body, pronouns and narrative voice.

RESPONSE FORMAT (mandatory, always use this):
> [third-person narration of ${personaje}'s actions and surroundings]
"[${personaje}'s spoken dialogue]"
*[${personaje}'s internal thought or subtle physical reaction]*`;
}

// ─── Regla anti-usurpación que se inyecta silenciosamente antes de cada turno ───
const ANTI_USURP_RULE = {
    role: 'system',
    content: `RECORDATORIO CRÍTICO: NO escribas acciones, diálogos ni pensamientos del usuario. Solo podés responder como el personaje. Usá el formato: "> [acción]\n[diálogo]\n—[aclaración]—". Terminá siempre la escena antes de detenerte.`
};

// ─── Limpia el historial protegiendo el system prompt (índice 0) ───
// Elimina pares user+assistant del medio cuando supera MAX_MESSAGES
function pruneHistory(messages, maxMessages = 20) {
    // messages[0] siempre es el system prompt — NUNCA se toca
    // Elimina de a pares (user + assistant) desde el índice 1
    while (messages.length > maxMessages) {
        // Busca el primer par user+assistant después del system prompt
        const firstUser = messages.findIndex((m, i) => i > 0 && m.role === 'user');
        if (firstUser === -1) break;
        // Si el siguiente es assistant, elimina el par. Si no, elimina solo el user.
        const nextIsAssistant = messages[firstUser + 1]?.role === 'assistant';
        messages.splice(firstUser, nextIsAssistant ? 2 : 1);
    }
}

async function handleGemini(sock, chatId, senderJid, text, msg) {
    const query = text.replace(/#ia|#ai/i, '').trim();
    if (!query) return sock.sendMessage(chatId, { text: '❌ Escribí algo.\nEj: #ia ¿Quién ganó el mundial en 2022?' }, { quoted: msg });
    if (['olvida', 'reset'].includes(query.toLowerCase())) {
        conversationHistory.delete(`${chatId}:${senderJid}`);
        saveIa();
        return sock.sendMessage(chatId, { text: '🧹 Historial borrado.' }, { quoted: msg });
    }
    await sock.sendMessage(chatId, { text: '🤔 Pensando...' }, { quoted: msg });
    const histKey = `${chatId}:${senderJid}`;
    if (!conversationHistory.has(histKey)) conversationHistory.set(histKey, []);
    const history = conversationHistory.get(histKey);
    history.push(`Usuario: ${query}`);
    const context = history.slice(-10).join('\n');
    try {
        const res = await fetch(`https://sylphyy.xyz/ai/copilot?text=${encodeURIComponent(context)}&api_key=sylphy-okf2a9E`);
        const json = await res.json();
        if (!json.status || !json.result?.text) throw new Error('Sin respuesta');
        const reply = json.result.text;
        history.push(`Asistente: ${reply}`);
        if (history.length > 20) history.splice(0, 2);
        saveIa();
        await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
    } catch (e) {
        console.error('[IA]', e.message);
        history.pop();
        await sock.sendMessage(chatId, { text: '❌ Error al consultar la IA.' }, { quoted: msg });
    }
}

async function handleRp(sock, chatId, senderJid, pushName, text, msg) {
    const input = text.replace(/#rp/i, '').trim();
    const histKey = `${chatId}:${senderJid}`;

    // ── Selector de modos ──
    if (input === 'modo' || input === 'modos') {
        const menu = `🎭 *Seleccioná el modo de Rol*\n\n1️⃣ *Normal* (Narrativa Mistral)\n2️⃣ *Lemon 🍋* (Sin censura - OpenRouter)\n\nResponde con: *#rp 1* o *#rp 2*`;
        return sock.sendMessage(chatId, { text: menu }, { quoted: msg });
    }

    if (input === '1' || input === '2') {
        const session = rpSessions.get(histKey);
        if (!session) return sock.sendMessage(chatId, { text: '❌ Primero tenés que iniciar o crear un rol.' }, { quoted: msg });
        session.mode = input === '1' ? 'normal' : 'lemon';
        saveRp();
        const modeName = input === '1' ? 'Normal (Mistral)' : 'Lemon 🍋 (OpenRouter)';
        return sock.sendMessage(chatId, { text: `✅ Modo cambiado a: *${modeName}*\n\nYa podés seguir escribiendo tu rol.` }, { quoted: msg });
    }

    if (!input) return sock.sendMessage(chatId, { text: '❌ Usá: #rp [personaje] | [descripción o jikan] para iniciar\n#rp [mensaje] para continuar\n#rp fin para terminar' }, { quoted: msg });

    // ── Load ──
    if (/^load\s+".+"/i.test(input)) {
        const saveName = input.match(/^load\s+"(.+)"/i)?.[1];
        const save = rpSaves[senderJid]?.[saveName];
        if (!save) return sock.sendMessage(chatId, { text: `❌ No encontré un rol guardado con el nombre "${saveName}".` }, { quoted: msg });
rpSessions.set(histKey, {
    personaje,
    pushName,
    guion: null,
    sugerencia: null,
    mode: 'normal',
    messages: [{
        role: 'system',
        content: buildSystemPromptNormal(personaje, pushName) + `\n\nDescripción del personaje: ${descripcion}`
    }]
});
        // Reinyecta el system prompt actualizado al cargar (por si el personaje cambió de sesión)
        rpSessions.get(histKey).messages[0] = {
            role: 'system',
            content: buildSystemPrompt(save.personaje, pushName)
        };
        saveRp();
        await sock.sendMessage(chatId, { text: `🎭 Rol *${saveName}* cargado. Ahora hablás con *${save.personaje}*.\n\n${save.lastReply ? `*Último mensaje:*\n${save.lastReply}` : ''}` }, { quoted: msg });
        return;
    }

    // ── List ──
    if (input.toLowerCase() === 'list') {
        const saves = rpSaves[senderJid];
        if (!saves || !Object.keys(saves).length)
            return sock.sendMessage(chatId, { text: '❌ No tenés roles guardados.' }, { quoted: msg });
        const lista = Object.entries(saves)
            .map(([name, save]) => `> *${name}* — ${save.personaje}`)
            .join('\n');
        return sock.sendMessage(chatId, { text: `📂 *Tus roles guardados:*\n\n${lista}` }, { quoted: msg });
    }

    // ── Fin ──
    if (input.toLowerCase() === 'fin') {
        const session = rpSessions.get(histKey);
        if (session && rpSaves[senderJid]) {
            for (const [name, save] of Object.entries(rpSaves[senderJid])) {
                if (save.personaje === session.personaje) {
                    rpSaves[senderJid][name].messages = session.messages;
                    rpSaves[senderJid][name].lastReply = session.messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
                }
            }
            saveRpSaves();
        }
        rpSessions.delete(histKey);
        saveRp();
        return sock.sendMessage(chatId, { text: '🎭 Sesión de roleplay terminada.' }, { quoted: msg });
    }

    // ── Inicio de sesión ──
    if (!rpSessions.has(histKey)) {
        const pipeIdx = input.indexOf('|');
        if (pipeIdx === -1) {
            return sock.sendMessage(chatId, {
                text: `❌ Especificá una descripción. Podés usar:\n> — *#rp ${input} | jikan* — Busca descripción en Jikan\n> — *#rp ${input} | [descripción del personaje]* — Descripción manual`
            }, { quoted: msg });
        }
        const personaje = input.slice(0, pipeIdx).trim();
        const descArg = input.slice(pipeIdx + 1).trim();
        let descripcion = descArg;

        if (descArg.toLowerCase() === 'jikan') {
            try {
                const searchRes = await fetch(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(personaje)}&limit=1`);
                const searchJson = await searchRes.json();
                const charId = searchJson.data?.[0]?.mal_id;
                if (!charId) return sock.sendMessage(chatId, { text: `❌ No encontré a *${personaje}* en Jikan. Usá descripción manual.` }, { quoted: msg });
                const fullRes = await fetch(`https://api.jikan.moe/v4/characters/${charId}/full`);
                const fullJson = await fullRes.json();
                descripcion = fullJson.data?.about || '';
                if (!descripcion) return sock.sendMessage(chatId, { text: `❌ Jikan no tiene descripción de *${personaje}*. Usá descripción manual.` }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(chatId, { text: '❌ Error al buscar en Jikan.' }, { quoted: msg });
            }
        }

        rpSessions.set(histKey, {
            personaje,
            pushName,
            guion: null,
            sugerencia: null,
            mode: 'normal',
            messages: [{
                role: 'system',
                // ── System prompt completo con descripción del personaje ──
                content: buildSystemPrompt(personaje, pushName) + `\n\nDescripción del personaje: ${descripcion}`
            }]
        });
        saveRp();
        return sock.sendMessage(chatId, {
            text: `🎭 Ahora estás hablando con *${personaje}*.\nUsá #rp [mensaje] para interactuar.\n\n> *#rp starter* — El personaje inicia el rol\n> *#rp guión [texto]* — Establecer un guión\n> *#rp starter w guión* — Iniciar con el guión establecido\n> *#rp s [sugerencia]* — Sugerir dirección narrativa\n> *#rp s clear* — Borrar sugerencia\n> *#rp save "nombre"* — Guardar sesión\n> *#rp load "nombre"* — Cargar sesión guardada\n> *#rp modo* — Cambiar modo (Normal / Lemon)\n> *#rp fin* — Terminar la sesión`
        }, { quoted: msg });
    }

    const session = rpSessions.get(histKey);

    // ── Reinyección del system prompt en cada interacción ──
    // Garantiza que messages[0] siempre sea el system prompt correcto
// ── Reinyección del system prompt en cada interacción ──
const descripcionGuardada = session.messages[0]?.content?.includes('Descripción del personaje:')
    ? '\n\nDescripción del personaje:' + session.messages[0].content.split('Descripción del personaje:')[1]
    : '';

const buildFn = session.mode === 'lemon' ? buildSystemPromptLemon : buildSystemPromptNormal;

session.messages[0] = {
    role: 'system',
    content: buildFn(session.personaje, pushName) + descripcionGuardada
};

    // ── Save ──
    if (/^save\s+".+"/i.test(input)) {
        const saveName = input.match(/^save\s+"(.+)"/i)?.[1];
        if (!rpSaves[senderJid]) rpSaves[senderJid] = {};
        rpSaves[senderJid][saveName] = {
            personaje: session.personaje,
            guion: session.guion,
            sugerencia: session.sugerencia,
            messages: session.messages,
            lastReply: session.messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || ''
        };
        saveRpSaves();
        await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
        return;
    }

    // ── Guión ──
    if (/^guión\s+|^guion\s+/i.test(input)) {
        session.guion = input.replace(/^guión\s+|^guion\s+/i, '').trim();
        saveRp();
        return sock.sendMessage(chatId, { text: `📜 Guión guardado:\n_${session.guion}_` }, { quoted: msg });
    }

    // ── Sugerencia ──
    if (/^s\/|^sugg\/|^suggest\//i.test(input) || /^s\s/i.test(input)) {
        const sugg = input.replace(/^s\/|^sugg\/|^suggest\//i, '').replace(/^s\s/i, '').trim();
        if (sugg.toLowerCase() === 'clear' || sugg.toLowerCase() === 'off') {
            session.sugerencia = null;
            saveRp();
            return sock.sendMessage(chatId, { text: '🗑️ Sugerencia borrada.' }, { quoted: msg });
        }
        session.sugerencia = sugg;
        saveRp();
        await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
        return;
    }

    // ── Armar prompt de usuario ──
    let userPrompt;
    if (input.toLowerCase() === 'starter') {
        userPrompt = 'Iniciá el rol vos. Comenzá la escena de forma creativa según tu personalidad.';
    } else if (input.toLowerCase() === 'starter w guión' || input.toLowerCase() === 'starter w guion') {
        if (!session.guion) return sock.sendMessage(chatId, { text: '❌ No tenés guión guardado. Usá #rp guión [texto] primero.' }, { quoted: msg });
        userPrompt = `Iniciá el rol siguiendo este guión: ${session.guion}`;
    } else if (input.toLowerCase() === 'continue') {
        userPrompt = 'Continuá el rol desde donde lo dejaste, extendé la escena sin que yo haya respondido nada.';
    } else {
        userPrompt = input;
    }

    const finalPrompt = session.sugerencia
        ? `${userPrompt}\n\n[Sugerencia de dirección narrativa: ${session.sugerencia}]`
        : userPrompt;

    session.messages.push({ role: 'user', content: finalPrompt });

    // ── Prune: protege el system prompt (índice 0), elimina pares del medio ──
    pruneHistory(session.messages, 20);

    // ── Llamada a la API con ANTI_USURP_RULE inyectado silenciosamente ──
    // Se arma una copia de los mensajes solo para el request, no se guarda en session
    const messagesForApi = [
        session.messages[0],           // system prompt protegido
        ...session.messages.slice(1),  // historial
        ANTI_USURP_RULE                // recordatorio anti-usurpación antes de la respuesta
    ];

    try {
        let reply = '';

if (session.mode === 'lemon') {
    const cleanMessages = messagesForApi
        .filter(m => m.content && m.content.trim() !== '')
        .map((m, i) => {
            if (i === 0) return m; // system principal intacto
            if (m.role === 'system') return { role: 'user', content: `[INST] ${m.content} [/INST]` };
            return m;
        });

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/bot-wa',
            'X-Title': 'WhatsApp Bot'
        },
        body: JSON.stringify({
            model: 'gryphe/mythomax-l2-13b',
            messages: cleanMessages,
            max_tokens: 2000,
            temperature: 0.85,
            top_p: 0.9,
            repetition_penalty: 1.1
        })
    });
    const json = await res.json();
    if (json.error) {
        console.error('[API OPENROUTER ERROR]:', JSON.stringify(json.error));
        throw new Error(json.error.message || 'Error interno de OpenRouter.');
    }
    reply = json.choices?.[0]?.message?.content;
        } else {
            // Modo normal: Mistral
            const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer tDEI5yD9xDuhn58YSnZ9mL8JDz8apSf5', 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'mistral-small-latest', messages: messagesForApi, max_tokens: 8000 })
            });
            const json = await res.json();
            if (json.error) throw new Error(json.error.message);
            reply = json.choices?.[0]?.message?.content;
        }

        if (!reply) throw new Error('La IA no generó texto (respuesta vacía).');

        // Solo se guarda el reply real en session.messages, nunca el ANTI_USURP_RULE
        session.messages.push({ role: 'assistant', content: reply });
        saveRp();
        await sock.sendMessage(chatId, { text: `🎭 *${session.personaje}*:\n${reply}` }, { quoted: msg });

    } catch (e) {
        console.error('[RP FETCH ERROR]:', e);
        session.messages.pop(); // Remueve el user message si falló
        await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}` }, { quoted: msg });
    }
}

async function openrouterRequest(body, retries = 3) {
    const res = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'X-Title': 'WhatsApp Bot'
            },
            body: JSON.stringify(body)
        }
    );
    const json = await res.json();
    if (json.error?.code === 429 && retries > 0) {
        const wait = json.error.metadata?.retry_after_seconds || 30;
        console.log(`[429] Esperando ${wait}s. Intentos restantes: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        return openrouterRequest(body, retries - 1);
    }
    if (json.error) throw new Error(json.error.message);
    return json;
}

module.exports = { handleGemini, handleRp };
