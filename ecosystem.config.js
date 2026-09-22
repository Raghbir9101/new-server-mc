// pm2 config for the Minecraft server runner.
//   pm2 start ecosystem.config.js
//   pm2 logs MC-NEW        # view output
//   pm2 restart MC-NEW     # restart (picks up new code)
//   pm2 save               # persist across reboots (also run: pm2 startup)
module.exports = {
  apps: [
    {
      name: 'MC-NEW',
      script: 'server-runner.js',
      cwd: __dirname,
      // Give our graceful shutdown time to run `stop` and the final commit before pm2 kills us.
      kill_timeout: 35000,
      // Don't hammer-restart on a hard failure (e.g. no network for the JDK download).
      min_uptime: 20000,
      max_restarts: 5,
      restart_delay: 5000,
      autorestart: true,
      env: {
        // --- Java ---
        // AUTO_INSTALL_JAVA: 'true',      // default; downloads a local Temurin 25 JDK if system Java is too old
        // JAVA_BIN: '/path/to/java',      // set to skip auto-install and use a specific JDK
        XMX: '4G',
        XMS: '2G',

        // --- Web panel (public, no auth — as requested) ---
        PANEL_HOST: '0.0.0.0',
        PANEL_PORT: '8080',
        PANEL_ALLOW_NO_AUTH: 'true',
        // PANEL_TOKEN: 'change-me',       // set this (and drop PANEL_ALLOW_NO_AUTH) to require a token

        // --- Backups ---
        COMMIT_INTERVAL: '60',
        // Paste a GitHub token (Fine-grained: Contents = Read and write on this repo) to enable auto-push.
        // Leave unset to keep commits local only.
        // GITHUB_TOKEN: 'github_pat_xxxxxxxx',
        // AUTO_PUSH: 'false',             // set to keep commits local (no GitHub push)
      },
    },
  ],
};
