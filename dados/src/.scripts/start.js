#!/usr/bin/env node

import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { recoverInterruptedUpdate } from '../utils/autoUpdater.js';

const CONFIG_PATH = path.join(process.cwd(), 'dados', 'src', 'config.json');
const NODE_MODULES_PATH = path.join(process.cwd(), 'node_modules');
const CONNECT_FILE = path.join(process.cwd(), 'dados', 'src', 'connect.js');
const RESTART_AFTER_UPDATE = 75;
const MAX_FATAL_RESTARTS = 2;
const MAX_UPDATE_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const PURPLE = '\x1b[38;5;141m';
const LILAC = '\x1b[38;5;183m';
const WHITE = '\x1b[1;97m';
const MUTED = '\x1b[38;5;245m';
const GREEN = '\x1b[38;5;114m';
const RED = '\x1b[38;5;203m';
const RESET = '\x1b[0m';
const color = (code, value) => `${code}${value}${RESET}`;
const info = (message) => console.log(color(LILAC, message));
const error = (message) => console.error(color(RED, message));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function showBanner() {
  const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  console.log('');
  console.log(color(PURPLE, `╭${line}╮`));
  console.log(color(PURPLE, '│') + color(WHITE, '                 ✦  Z U C K E R B O T S  ✦                 ') + color(PURPLE, '│'));
  console.log(color(PURPLE, '│') + color(LILAC, '          CONEXÃO WHATSAPP • PAINEL ZUCKER BOTS           ') + color(PURPLE, '│'));
  console.log(color(PURPLE, `╰${line}╯`));
  console.log(color(MUTED, '  Inicialização segura • Atualizações automáticas • Termux'));
  console.log('');
}

function startBotProcess() {
  return new Promise((resolve) => {
    info('  ◈ Iniciando o serviço ZuckerBots...');
    const child = spawn(process.execPath, ['--expose-gc', CONNECT_FILE, '--code'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1', ZUCKERBOT_CODE_MODE: '1' }
    });
    let settled = false;
    let fatalName = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const forwardOutput = (stream, chunk, isError = false) => {
      const data = (isError ? stderrBuffer : stdoutBuffer) + chunk.toString();
      const lines = data.split(/\r?\n/);
      const remainder = lines.pop();
      if (isError) stderrBuffer = remainder; else stdoutBuffer = remainder;
      for (const line of lines) {
        const marker = line.match(/ZUCKER_FATAL_ERROR:([A-Za-z0-9_$.-]+)/);
        if (marker) { fatalName = marker[1]; continue; }
        stream.write(`${line}\n`);
      }
    };
    child.stdout.on('data', chunk => forwardOutput(process.stdout, chunk));
    child.stderr.on('data', chunk => forwardOutput(process.stderr, chunk, true));
    child.once('error', err => {
      if (settled) return;
      settled = true;
      resolve({ code: 1, fatalName: err?.name || 'SpawnError' });
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      if (stdoutBuffer) forwardOutput(process.stdout, Buffer.from('\n'));
      if (stderrBuffer) forwardOutput(process.stderr, Buffer.from('\n'), true);
      resolve({ code: code ?? 1, fatalName });
    });
  });
}

async function runSupervisor() {
  let fatalRestarts = 0;
  let updateRestarts = 0;
  let restartWindowStarted = 0;
  while (true) {
    const result = await startBotProcess();
    if (result.code === 0) { process.exitCode = 0; return; }
    if (result.code === RESTART_AFTER_UPDATE) {
      const now = Date.now();
      if (!restartWindowStarted || now - restartWindowStarted > RESTART_WINDOW_MS) {
        restartWindowStarted = now; updateRestarts = 0;
      }
      updateRestarts++;
      if (updateRestarts > MAX_UPDATE_RESTARTS) {
        error('  ✖ Muitas reinicializações após atualização. Encerrando por segurança.');
        process.exitCode = 1; return;
      }
      console.log(color(GREEN, '  ✔ Atualização aplicada. Carregando a nova versão...'));
      await sleep(1500);
      continue;
    }
    fatalRestarts++;
    if (fatalRestarts > MAX_FATAL_RESTARTS) {
      error(`  ✖ Falha ao iniciar (${result.fatalName || 'ProcessExitError'}).`);
      process.exitCode = 1; return;
    }
    info(`  ↻ Falha inesperada. Nova tentativa ${fatalRestarts}/${MAX_FATAL_RESTARTS} em 3 segundos...`);
    await sleep(3000);
  }
}

async function main() {
  showBanner();
  info('  ◈ Verificando arquivos e recuperação de atualização...');
  await recoverInterruptedUpdate(process.cwd());
  if (!fsSync.existsSync(CONFIG_PATH)) { error('  ✖ Configuração não encontrada: dados/src/config.json'); error('  › Execute npm run config antes de iniciar.'); process.exit(1); }
  if (!fsSync.existsSync(NODE_MODULES_PATH)) { error('  ✖ Dependências não encontradas. Execute npm install primeiro.'); process.exit(1); }
  if (!fsSync.existsSync(CONNECT_FILE)) { error('  ✖ Arquivo de conexão não encontrado: dados/src/connect.js'); process.exit(1); }
  console.log(color(GREEN, '  ✔ Estrutura do bot verificada.'));
  info('  ◈ Preparando conexão com o WhatsApp e o painel...');
  console.log(color(MUTED, '  ────────────────────────────────────────────────────────'));
  await runSupervisor();
}

main().catch(err => {
  error(`  ✖ Erro na inicialização: ${err?.message || err?.name || 'StartupError'}`);
  process.exit(1);
});
