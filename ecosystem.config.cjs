const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'qatin-server',
      script: 'dist/server.js',
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        APP_ROOT: ROOT,
      },
      max_memory_restart: '1G',
      error_file: 'logs/pm2-server-error.log',
      out_file: 'logs/pm2-server-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'qatin-worker',
      script: 'dist/worker.js',
      cwd: ROOT,
      instances: 3,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        APP_ROOT: ROOT,
      },
      max_memory_restart: '2G',
      error_file: 'logs/pm2-worker-error.log',
      out_file: 'logs/pm2-worker-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
