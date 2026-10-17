// pm2 config: `pm2 start ecosystem.config.js`, later `pm2 reload gmaps-scraper` after an update.
module.exports = {
  apps: [
    {
      name: 'gmaps-scraper',
      script: 'server.js',
      env: {
        NICE: 15, // CPU priority (0-19, higher = yields to other projects sooner)
        TRUST_PROXY: 1, // behind nginx/Caddy; remove if the app is exposed directly
        // PORT: 3000,
      },
      // Restarts the app if the Node process alone passes this size. Chromium is a separate process and is not counted.
      max_memory_restart: '700M',
      kill_timeout: 10000, // give the scraper time to close Chromium on stop/restart
      autorestart: true,
    },
  ],
};
