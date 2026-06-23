const axios = require('axios');

const anilistCache = new Map();

async function sendAnimeMessage(sock, chatId, anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native;
    let desc = anime.description?.replace(/<[^>]*>/g, '').replace(/\n/g, ' ') || 'Sin sinopsis';
    if (desc.length > 400) desc = desc.slice(0, 400) + '...';
    const status = { FINISHED: 'Finalizado', RELEASING: 'En emisión', NOT_YET_RELEASED: 'Próximamente', CANCELLED: 'Cancelado' }[anime.status] || anime.status;
    await sock.sendMessage(chatId, {
        image: { url: anime.coverImage.large },
        caption: `📺 *${title}*\n\n⭐ Score: ${anime.averageScore || 'N/A'}/100\n📊 Episodios: ${anime.episodes || 'N/A'}\n📅 Estado: ${status}\n📅 Año: ${anime.seasonYear || 'N/A'}\n🎭 Géneros: ${anime.genres?.join(', ') || 'N/A'}\n\n${desc}\n\n🔗 ${anime.siteUrl}`
    });
}

async function handleAnilist(sock, chatId, query) {
    const cacheKey = query.toLowerCase().trim();
    if (anilistCache.has(cacheKey)) {
        const cached = anilistCache.get(cacheKey);
        if (Date.now() - cached.time < 600000) { await sendAnimeMessage(sock, chatId, cached.data); return; }
    }
    await sock.sendMessage(chatId, { text: `🔍 Buscando "${query}" en AniList...` });
    const graphqlQuery = `query ($search: String) { Media (search: $search, type: ANIME) { id title { romaji english native } description(asHtml: false) coverImage { large } episodes status averageScore seasonYear genres siteUrl } }`;
    try {
        const { data } = await axios.post('https://graphql.anilist.co', { query: graphqlQuery, variables: { search: query } }, { timeout: 15000 });
        const anime = data.data.Media;
        if (!anime) return sock.sendMessage(chatId, { text: '❌ No encontré ese anime' });
        anilistCache.set(cacheKey, { data: anime, time: Date.now() });
        await sendAnimeMessage(sock, chatId, anime);
    } catch (err) {
        console.error('AniList error:', err.message);
        sock.sendMessage(chatId, { text: '❌ Error buscando en AniList' });
    }
}

async function handleManga(sock, chatId, query) {
    await sock.sendMessage(chatId, { text: `🔍 Buscando manga "${query}" en AniList...` });
    const graphqlQuery = `query ($search: String) { Media (search: $search, type: MANGA) { id title { romaji english native } description(asHtml: false) coverImage { large } chapters volumes status averageScore seasonYear genres siteUrl } }`;
    try {
        const { data } = await axios.post('https://graphql.anilist.co', { query: graphqlQuery, variables: { search: query } }, { timeout: 15000 });
        const manga = data.data.Media;
        if (!manga) return sock.sendMessage(chatId, { text: '❌ No encontré ese manga' });
        const title = manga.title.english || manga.title.romaji || manga.title.native;
        let desc = manga.description?.replace(/<[^>]*>/g, '').replace(/\n/g, ' ') || 'Sin sinopsis';
        if (desc.length > 400) desc = desc.slice(0, 400) + '...';
        const status = { FINISHED: 'Finalizado', RELEASING: 'En emisión', NOT_YET_RELEASED: 'Próximamente', CANCELLED: 'Cancelado' }[manga.status] || manga.status;
        await sock.sendMessage(chatId, {
            image: { url: manga.coverImage.large },
            caption: `📚 *${title}*\n\n⭐ Score: ${manga.averageScore || 'N/A'}/100\n📖 Capítulos: ${manga.chapters || 'N/A'}\n📕 Tomos: ${manga.volumes || 'N/A'}\n📅 Estado: ${status}\n📅 Año: ${manga.seasonYear || 'N/A'}\n🎭 Géneros: ${manga.genres?.join(', ') || 'N/A'}\n\n${desc}\n\n🔗 ${manga.siteUrl}`
        });
    } catch (err) {
        console.error('AniList manga error:', err.message);
        sock.sendMessage(chatId, { text: '❌ Error buscando en AniList' });
    }
}

module.exports = { handleAnilist, handleManga };
