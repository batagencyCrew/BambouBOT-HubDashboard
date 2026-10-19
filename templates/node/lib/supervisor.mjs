import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJSON, writeJSON } from './storage.mjs';

export class Supervisor {
  constructor(dir, report = () => {}) { this.dir = dir; this.report = report; this.children = new Map(); this.running = false; this.config = { number_of_workers: 0 }; this.queue = Promise.resolve(); }
  exclusive(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async init() {
    this.state = await readJSON(path.join(this.dir, 'workers.json'), { slots: [] });
    this.commands = await readJSON(path.join(this.dir, 'commands.json'), {});
  }
  async configure(config) {
    this.config = config;
    while (this.state.slots.length < config.number_of_workers) this.state.slots.push({ id: randomUUID(), tasks: 0 });
    await this.save();
    await this.reconcile();
    for (const [workerId, child] of this.children) child.process.send({ type: 'config', config, workerId });
  }
  save() { return writeJSON(path.join(this.dir, 'workers.json'), this.state); }
  async reconcile() {
    const wanted = new Set(this.running ? this.state.slots.slice(0, this.config.number_of_workers).map(s => s.id) : []);
    for (const [id, child] of this.children) if (!wanted.has(id)) await this.stopChild(id, child);
    for (const slot of this.state.slots) if (wanted.has(slot.id) && !this.children.has(slot.id)) this.spawn(slot);
  }
  spawn(slot) {
    // Do not leak the hub token to automation hooks or child processes.
    const env = { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV || 'production' };
    const child = fork(new URL('../worker.mjs', import.meta.url), [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const record = { process: child, cpu: 0, memory: 0, error: false };
    this.children.set(slot.id, record);
    child.on('error', () => { record.error = true; this.report(slot.id); });
    child.on('exit', () => {
      if (!record.stopping) this.report(slot.id);
      if (this.children.get(slot.id) === record) this.children.delete(slot.id);
    });
    child.on('message', message => {
      if (message.type === 'task') { slot.tasks++; this.exclusive(() => this.save()).catch(() => this.report(slot.id)); }
      if (message.type === 'error') { record.error = true; this.report(slot.id); }
      if (message.type === 'telemetry') { record.cpu = Number.isFinite(message.cpu) ? message.cpu : 0; record.memory = Number.isFinite(message.memory) ? message.memory : 0; }
    });
    child.send({ type: 'config', config: this.config, workerId: slot.id });
  }
  async stopChild(id, child) {
    child.stopping = true;
    await new Promise(resolve => {
      if (child.process.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.process.kill('SIGKILL'), 3000);
      child.process.once('exit', () => { clearTimeout(timer); resolve(); });
      child.process.kill('SIGTERM');
    });
    this.children.delete(id);
  }
  async action(action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unsupported lifecycle action');
    if (action === 'stop' || action === 'restart') { this.running = false; await this.reconcile(); }
    if (action === 'start' || action === 'restart') { this.running = true; await this.reconcile(); }
  }
  async command(command, refresh, ack) {
    if (!Object.hasOwn(this.commands, command.id)) {
      if (!['start', 'stop', 'restart'].includes(command.action)) this.commands[command.id] = { status: 'failed', message: 'Unsupported lifecycle action' };
      else {
        if (command.action !== 'stop') await this.configure(await refresh());
        await this.action(command.action);
        this.commands[command.id] = { status: 'completed' };
      }
    }
    await writeJSON(path.join(this.dir, 'commands.json'), this.commands);
    // Durable result before ack. Failed/lost acknowledgements are retried, not actions.
    await ack(command.id, this.commands[command.id]);
  }
  snapshot() {
    return this.state.slots.slice(0, this.config.number_of_workers).map((slot, index) => {
      const child = this.children.get(slot.id);
      return { id: slot.id, name: `worker-${index + 1}`, status: child ? (child.error ? 'error' : 'idle') : 'stopped', cpu_percent: child?.cpu || 0, memory_mb: child?.memory || 0, tasks_completed: slot.tasks };
    });
  }
}
