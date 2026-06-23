module.exports = {
  apps: [
    {
      name: 'bot1',
      script: 'bot.js',
      env: {
        BOT_ID: 'bot1',
        // PHONE_NUMBER se toma del mapa en config.js (5493329471408)
        // Si querés sobreescribirlo: PHONE_NUMBER: '549XXXXXXXXXX'
      }
    },
    {
      name: 'bot2',
      script: 'bot.js',
      env: {
        BOT_ID: 'bot2',
        PHONE_NUMBER: '549XXXXXXXXXX'  // ← reemplazá con el segundo número
      }
    },
    // Para agregar un tercer bot, copiá el bloque de arriba y cambiá bot2 por bot3
  ]
};
