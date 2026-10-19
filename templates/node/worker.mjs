import { performTask } from './hooks.mjs';
let config = {}; let workerId; let busy = false; let tasks = 0;
const controller = new AbortController();
let previous = process.cpuUsage(); let previousTime = performance.now();
process.on('message', message => {
  if (message.type === 'config') { config = message.config; workerId = message.workerId; }
});
process.on('disconnect', () => { controller.abort(); process.exit(0); });
process.on('SIGTERM', () => { controller.abort(); process.exit(0); });
setInterval(async () => {
  if (busy || !workerId) return;
  busy = true;
  try { if (await performTask({ config, signal: controller.signal, workerId })) { tasks++; process.send?.({ type: 'task' }); } }
  catch { process.send?.({ type: 'error' }); }
  finally { busy = false; }
}, 1000);
setInterval(() => {
  const current = process.cpuUsage(); const now = performance.now();
  const cpu = ((current.user - previous.user) + (current.system - previous.system)) / ((now - previousTime) * 1000) * 100;
  previous = current; previousTime = now;
  process.send?.({ type: 'telemetry', cpu: Math.max(0, cpu), memory: process.memoryUsage().rss / 1048576, tasks });
}, 2000);
