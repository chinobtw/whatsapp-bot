const { getEco, saveEco, checkCd, setCd, fmtCd } = require('./economy');
const { fmt, rand } = require('./utils');

const activeBlackjack = {};
const pendingDuels = new Map();

function cardValue(card) {
    if (['J','Q','K'].includes(card)) return 10;
    if (card === 'A') return 11;
    return parseInt(card);
}
function handValue(cards) {
    let total = cards.reduce((s,c) => s + cardValue(c), 0);
    let aces = cards.filter(c => c === 'A').length;
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}
function drawCard() {
    const cards = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    return cards[Math.floor(Math.random() * cards.length)];
}

// SLOT
const SLOTS     = ['🍒','🍋','🍇','🔔','💎','7️⃣'];
const SLOT_W    = [30,25,20,15,7,3];
function spinSlot() {
    let r = Math.random() * SLOT_W.reduce((a,b) => a+b, 0);
    for (let i = 0; i < SLOTS.length; i++) { r -= SLOT_W[i]; if (r <= 0) return SLOTS[i]; }
    return SLOTS[0];
}

async function handleSlot(sock, chatId, senderNum, pushName, text, msg) {
    const bet = parseInt(text.split(' ')[1]);
    if (!bet || bet <= 0) return sock.sendMessage(chatId, { text: '❌ Usá: #slot [cantidad]\nEj: #slot 5000' }, { quoted: msg });
    const eco = getEco(senderNum);
    if (eco.wallet < bet) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Tenés ${fmt(eco.wallet)}.` }, { quoted: msg });
    const cd = checkCd(chatId, senderNum, 'slot');
    if (cd > 0) return sock.sendMessage(chatId, { text: `⏳ Esperá *${fmtCd(cd)}* para volver a usar #slot.` }, { quoted: msg });
    const reels = [spinSlot(), spinSlot(), spinSlot()];
    let mult = 0, resultMsg = '';
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
        if      (reels[0] === '7️⃣') { mult = 20; resultMsg = '🎰 *¡¡¡JACKPOT SUPREMO!!!*'; }
        else if (reels[0] === '💎')  { mult = 10; resultMsg = '💎 *¡¡JACKPOT!!*'; }
        else                          { mult = 5;  resultMsg = '🎊 *¡¡TRIPLE!!*'; }
    } else if (reels[0]===reels[1] || reels[1]===reels[2] || reels[0]===reels[2]) {
        mult = 1.5; resultMsg = '✨ *¡Par!*';
    } else {
        mult = 0; resultMsg = '❌ *Sin suerte...*';
    }
    eco.wallet -= bet;
    const won = Math.floor(bet * mult);
    eco.wallet += won;
    setCd(chatId, senderNum, 'slot');
    saveEco();
    const net = won - bet;
    await sock.sendMessage(chatId, {
        text: `🎰 *SLOT MACHINE — ${pushName}*\n\n[ ${reels.join(' | ')} ]\n\n${resultMsg}\n${mult > 0 ? `Ganaste: *${fmt(won)}* (${net >= 0 ? '+' : ''}${fmt(net)})` : `Perdiste: *${fmt(bet)}*`}\nBilletera: ${fmt(eco.wallet)}`
    }, { quoted: msg });
}

// DUELO
async function handleDuelo(sock, chatId, senderNum, senderJid, pushName, text, msg) {
    const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!targetJid) return sock.sendMessage(chatId, { text: '❌ Usá: #duelo @usuario [cantidad]' }, { quoted: msg });
    const amount = parseInt(text.split(/\s+/).find(w => /^\d+$/.test(w)));
    if (!amount || amount <= 0) return sock.sendMessage(chatId, { text: '❌ Especificá una cantidad. Ej: #duelo @usuario 5000' }, { quoted: msg });
    const eco = getEco(senderNum);
    if (eco.wallet < amount) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Tenés ${fmt(eco.wallet)}.` }, { quoted: msg });
    const targetNum = targetJid.split('@')[0].replace(/\D/g, '');
    if (targetNum === senderNum) return sock.sendMessage(chatId, { text: '❌ No podés desafiarte a vos mismo.' }, { quoted: msg });
    const duelKey = `${chatId}:${targetJid}`;
    pendingDuels.set(duelKey, { challengerJid: senderJid, challengerNum: senderNum, challengerName: pushName, amount, expiry: Date.now() + 60000 });
    setTimeout(() => { if (pendingDuels.has(duelKey)) { pendingDuels.delete(duelKey); sock.sendMessage(chatId, { text: `⏰ El duelo de @${senderNum} expiró sin respuesta.`, mentions: [senderJid] }); } }, 60000);
    await sock.sendMessage(chatId, {
        text: `⚔️ @${senderNum} desafía a @${targetNum} a un duelo por *${fmt(amount)}*!\n\nUsá *#aceptar* en los próximos 60 segundos para aceptar.`,
        mentions: [senderJid, targetJid]
    }, { quoted: msg });
}

async function handleAceptar(sock, chatId, senderJid, senderNum, pushName, msg) {
    const duelKey = `${chatId}:${senderJid}`;
    const duel = pendingDuels.get(duelKey);
    if (!duel) return sock.sendMessage(chatId, { text: '❌ No tenés ningún duelo pendiente.' }, { quoted: msg });
    if (Date.now() > duel.expiry) { pendingDuels.delete(duelKey); return sock.sendMessage(chatId, { text: '❌ El duelo expiró.' }, { quoted: msg }); }
    const targetEco = getEco(senderNum);
    if (targetEco.wallet < duel.amount) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Necesitás ${fmt(duel.amount)}.` }, { quoted: msg });
    pendingDuels.delete(duelKey);
    const challengerEco = getEco(duel.challengerNum);
    const challengerWins = Math.random() < 0.5;
    challengerEco.wallet -= duel.amount;
    targetEco.wallet     -= duel.amount;
    if (challengerWins) challengerEco.wallet += duel.amount * 2;
    else                targetEco.wallet     += duel.amount * 2;
    saveEco();
    const winnerNum = challengerWins ? duel.challengerNum : senderNum;
    const loserNum  = challengerWins ? senderNum : duel.challengerNum;
    await sock.sendMessage(chatId, {
        text: `⚔️ *¡DUELO!*\n\n@${duel.challengerNum} VS @${senderNum}\n\n🏆 *¡@${winnerNum} ganó ${fmt(duel.amount * 2)}!*\n💸 @${loserNum} perdió ${fmt(duel.amount)}.`,
        mentions: [duel.challengerJid, senderJid]
    }, { quoted: msg });
}

// CF
async function handleCF(sock, chatId, senderNum, pushName, text, msg) {
    const parts = text.split(' ');
    const eleccion = parts[1]?.toLowerCase();
    const apuesta = parseInt(parts[2]);
    if (!['cara','cruz'].includes(eleccion) || isNaN(apuesta) || apuesta <= 0)
        return sock.sendMessage(chatId, { text: 'Usá: #cf cara 1000 o #cf cruz 1000' }, { quoted: msg });
    const eco = getEco(senderNum);
    if (apuesta > eco.wallet) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Tenés ${fmt(eco.wallet)}.` }, { quoted: msg });
    const resultado = Math.random() < 0.5 ? 'cara' : 'cruz';
    const gano = resultado === eleccion;
    eco.wallet += gano ? apuesta : -apuesta;
    saveEco();
    await sock.sendMessage(chatId, { text: `🪙 ¡La moneda salió *${resultado}*! ${gano ? `Ganaste *${fmt(apuesta)}*! 🎉` : `Perdiste *${fmt(apuesta)}*. 😬`}\nSaldo: ${fmt(eco.wallet)}` }, { quoted: msg });
}

// RULETA
async function handleRT(sock, chatId, senderNum, pushName, text, msg) {
    const parts = text.split(' ');
    const color = parts[1]?.toLowerCase();
    const apuesta = parseInt(parts[2]);
    if (!['red','black','green'].includes(color) || isNaN(apuesta) || apuesta <= 0)
        return sock.sendMessage(chatId, { text: 'Usá: #rt red 1000 / #rt black 1000 / #rt green 1000\nVerde triplica, rojo y negro duplican.' }, { quoted: msg });
    const eco = getEco(senderNum);
    if (apuesta > eco.wallet) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Tenés ${fmt(eco.wallet)}.` }, { quoted: msg });
    const r = Math.random();
    const resultado = r < 0.05 ? 'green' : r < 0.525 ? 'red' : 'black';
    const colorEmoji = { red: '🔴 Rojo', black: '⚫ Negro', green: '🟢 Verde' };
    const gano = resultado === color;
    const ganancia = gano ? (resultado === 'green' ? apuesta * 2 : apuesta) : 0;
    eco.wallet += gano ? ganancia : -apuesta;
    saveEco();
    await sock.sendMessage(chatId, { text: `🎰 ¡La ruleta salió *${colorEmoji[resultado]}*! ${gano ? `Ganaste *${fmt(ganancia)}*! 🎉` : `Perdiste *${fmt(apuesta)}*. 😬`}\nSaldo: ${fmt(eco.wallet)}` }, { quoted: msg });
}

// BLACKJACK
async function handleBlackjack(sock, chatId, senderNum, pushName, text, msg) {
    const apuesta = parseInt(text.split(' ')[1]);
    if (isNaN(apuesta) || apuesta <= 0) return sock.sendMessage(chatId, { text: 'Usá: #blackjack 1000' }, { quoted: msg });
    const eco = getEco(senderNum);
    if (apuesta > eco.wallet) return sock.sendMessage(chatId, { text: `❌ No tenés suficiente. Tenés ${fmt(eco.wallet)}.` }, { quoted: msg });
    const gameKey = `${chatId}:${senderNum}`;
    if (activeBlackjack[gameKey]) return sock.sendMessage(chatId, { text: '❌ Ya tenés una partida activa. Usá #stand o #apost.' }, { quoted: msg });
    const dealerCards = [drawCard(), drawCard()];
    const playerCards = [drawCard(), drawCard()];
    activeBlackjack[gameKey] = { dealerCards, playerCards, apuesta };
    const playerTotal = handValue(playerCards);
    if (playerTotal === 21) {
        delete activeBlackjack[gameKey];
        const ganancia = Math.floor(apuesta * 1.5);
        eco.wallet += ganancia; saveEco();
        return sock.sendMessage(chatId, { text: `🃏 *Blackjack!*\nCrupier: ${dealerCards.join(', ')} (${handValue(dealerCards)})\nVos: ${playerCards.join(', ')} (21)\n\n¡BLACKJACK! Ganaste *${fmt(ganancia)}*!\nSaldo: ${fmt(eco.wallet)}` }, { quoted: msg });
    }
    await sock.sendMessage(chatId, { text: `🃏 *Blackjack — ${pushName}*\nCrupier: ${dealerCards.join(', ')} (${handValue(dealerCards)})\nVos: ${playerCards.join(', ')} (*${playerTotal}*)\n\n*#apost* para pedir carta · *#stand* para plantarte.` }, { quoted: msg });
}

async function handleApost(sock, chatId, senderNum, msg) {
    const gameKey = `${chatId}:${senderNum}`;
    const game = activeBlackjack[gameKey];
    if (!game) return sock.sendMessage(chatId, { text: '❌ No tenés ninguna partida activa.' }, { quoted: msg });
    const eco = getEco(senderNum);
    game.playerCards.push(drawCard());
    const playerTotal = handValue(game.playerCards);
    if (playerTotal > 21) {
        delete activeBlackjack[gameKey];
        eco.wallet -= game.apuesta; saveEco();
        return sock.sendMessage(chatId, { text: `🃏 ${game.playerCards.join(', ')} (*${playerTotal}*)\n\n💥 ¡Te pasaste! Perdiste *${fmt(game.apuesta)}*.\nSaldo: ${fmt(eco.wallet)}` }, { quoted: msg });
    }
    if (playerTotal === 21) {
        delete activeBlackjack[gameKey];
        eco.wallet += game.apuesta; saveEco();
        return sock.sendMessage(chatId, { text: `🃏 ${game.playerCards.join(', ')} (*21*)\n\n🎉 ¡21 exacto! Ganaste *${fmt(game.apuesta)}*.\nSaldo: ${fmt(eco.wallet)}` }, { quoted: msg });
    }
    await sock.sendMessage(chatId, { text: `🃏 ${game.playerCards.join(', ')} (*${playerTotal}*)\n\n*#apost* para otra carta · *#stand* para plantarte.` }, { quoted: msg });
}

async function handleStand(sock, chatId, senderNum, msg) {
    const gameKey = `${chatId}:${senderNum}`;
    const game = activeBlackjack[gameKey];
    if (!game) return sock.sendMessage(chatId, { text: '❌ No tenés ninguna partida activa.' }, { quoted: msg });
    const eco = getEco(senderNum);
    delete activeBlackjack[gameKey];
    const playerTotal = handValue(game.playerCards);
    while (handValue(game.dealerCards) < 17) game.dealerCards.push(drawCard());
    const dealerTotal = handValue(game.dealerCards);
    let resultado;
    if (dealerTotal > 21 || playerTotal > dealerTotal) { eco.wallet += game.apuesta; resultado = `🎉 ¡Ganaste *${fmt(game.apuesta)}*!`; }
    else if (playerTotal === dealerTotal)               { resultado = `🤝 Empate. Se te devuelve la apuesta.`; }
    else                                                { eco.wallet -= game.apuesta; resultado = `😬 Perdiste *${fmt(game.apuesta)}*.`; }
    saveEco();
    await sock.sendMessage(chatId, { text: `🃏 *Resultado*\nCrupier: ${game.dealerCards.join(', ')} (${dealerTotal})\nVos: ${game.playerCards.join(', ')} (${playerTotal})\n\n${resultado}\nSaldo: ${fmt(eco.wallet)}` }, { quoted: msg });
}

module.exports = { handleCF, handleRT, handleBlackjack, handleApost, handleStand, handleSlot, handleDuelo, handleAceptar };
