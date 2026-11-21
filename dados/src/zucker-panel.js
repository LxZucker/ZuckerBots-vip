
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installUpdatePackage } from './utils/autoUpdater.js';

const API_URL = (process.env.ZUCKERBOTS_API_URL || 'https://zuckerbots-api.duckdns.org:40592').replace(/\/$/, '');
const DEVICE_FILE = path.join(process.cwd(), 'zuckerbots-device.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CUSTOM_COMMANDS_FILE = path.resolve(
  __dirname,
  '../database/dono/customCommands.json'
);

const CUSTOM_COMMAND_SLOTS_FILE = path.resolve(
  __dirname,
  '../database/dono/customCommandSlots.json'
);

const CUSTOM_COMMAND_MEDIA_DIR = path.resolve(
  __dirname,
  '../database/dono/customCommandMedia'
);

const GP_COMMANDS_FILE = path.resolve(
  __dirname,
  '../database/dono/customCommandsGP.json'
);

const GP_SLOTS_FILE = path.resolve(
  __dirname,
  '../database/dono/customCommandSlotsGP.json'
);

const GP_MEDIA_DIR = path.resolve(
  __dirname,
  '../database/dono/customCommandMediaGP'
);

const MODE_SETTINGS_FILE = path.resolve(
  __dirname,
  '../database/dono/panelModeSettings.json'
);
const DIVULGACAO_SETTINGS_FILE = path.resolve(
  __dirname,
  '../database/dono/divulgacao.json'
);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class ZuckerPanel {
  constructor() {
    this.credentials = null;
    this.messageQueue = [];
    this.heartbeatTimer = null;
    this.pairingTimer = null;
    this.commandTimer = null;
    this.updateTimer = null;
    this.updateBusy = false;
    this.updateRetryAfter = 0;
    this.socket = null;
    this.authDir = null;
    this.pairingBusy = false;
    this.commandBusy = false;
    this.unlinkInProgress = false;
    this.unlinkRequested = false;
    this.whatsappConnected = false;
    this.commandPrefix = '#';
    this.ownerNumber = null;
    this.ownerNumberChangeHandler = null;
    this.settingsRevision = null;
    this.botPvEnabled = true;
    this.botGpEnabled = false;
    this.pvUnknownMessage = '';
    this.gpUnknownMessage = '';
    this.pvOwnerCooldown = 1;
    this.pvUserCooldown = 1;
    this.gpOwnerCooldown = 1;
    this.gpUserCooldown = 1;
    this.gpAllGroups = true;
    this.gpSelectedGroups = [];
    this.groupsSyncAt = 0;
    this.autoReplyEnabled = false;
    this.autoReplyMessage = '';
    this.autoReplyCooldownMinutes = 60;
    this.autoReplyExcludedNumbers = [];
    // O agente inicia bloqueado até receber confirmação recente do servidor.
    this.accessBlocked = true;
    this.accessReason = 'Aguardando validação do painel.';
    this.accessCheckedAt = 0;
this.divulgacaoEnabled = false;
this.divulgacaoConfig = { sections: [] };
this.divulgacaoCommands = [];
this.divulgacaoUpdatedAt = null;
  }

  async request(endpoint, body, token = null) {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body || {})
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Falha HTTP ${response.status} em ${endpoint}`);
    }

    return data;
  }

  applyAccessState(result) {
    if (!result || typeof result.accessBlocked !== 'boolean') {
      this.accessCheckedAt = 0;
      this.accessBlocked = true;
      this.accessReason = 'O servidor não confirmou o estado de acesso.';
      this.messageQueue = [];
      return;
    }

    this.accessCheckedAt = Date.now();
    this.accessBlocked = result.accessBlocked;
    this.accessReason = result.suspended
      ? `Conta suspensa: ${result.reason || 'motivo não informado'}`
      : result.validityExpired
        ? 'Validade da conta expirada.'
        : '';

    if (this.accessBlocked) {
      this.messageQueue = [];
      console.warn(`[ZuckerBots] Funcionalidades bloqueadas: ${this.accessReason}`);
    }
  }

  canRunFeatures() {
    const validationIsFresh = this.accessCheckedAt > 0 &&
      Date.now() - this.accessCheckedAt <= 90000;
    return validationIsFresh && !this.accessBlocked;
  }

  invalidateAccessAfterNetworkFailure() {
    if (!this.accessCheckedAt || Date.now() - this.accessCheckedAt > 90000) {
      this.accessBlocked = true;
      this.accessReason = 'Não foi possível validar o acesso recentemente.';
      this.messageQueue = [];
    }
  }

  async reportUpdate(version, status, message) {
    if (!this.credentials) return;
    try {
      await this.request(
        '/api/agent/update-report',
        {
          deviceId: this.credentials.deviceId,
          version,
          status,
          message: String(message || '').slice(0, 1400)
        },
        this.credentials.agentToken
      );
    } catch (error) {
      console.error(`[ZuckerBots] Não foi possível registrar o relatório da atualização: ${error.message}`);
    }
  }

  async reportDivulgacaoRun(run) {
    if (!this.credentials?.deviceId || !this.credentials?.agentToken) return false;

    try {
      await this.request(
        '/api/agent/command-poll',
        {
          deviceId: this.credentials.deviceId,
          action: 'divulgacao-log',
          runId: String(run?.runId || ''),
          sectionId: String(run?.sectionId || ''),
          startedAt: String(run?.startedAt || ''),
          endedAt: String(run?.endedAt || ''),
          status: ['running', 'success', 'error'].includes(run?.status) ? run.status : 'error',
          sentCount: Number(run?.sentCount) || 0,
          failedCount: Number(run?.failedCount) || 0,
          errorReason: String(run?.errorReason || '').slice(0, 3000)
        },
        this.credentials.agentToken
      );
      return true;
    } catch (error) {
      console.error(`[ZuckerBots] Não foi possível enviar o log de divulgação: ${error.message}`);
      return false;
    }
  }

  async loadCredentials() {
    try {
      this.credentials = JSON.parse(
        await fs.readFile(DEVICE_FILE, 'utf8')
      );

      if (!this.credentials.deviceId || !this.credentials.agentToken) {
        this.credentials = null;
      }
    } catch {
      this.credentials = null;
    }

    return this.credentials;
  }

  async saveCredentials(credentials) {
    this.credentials = credentials;

    await fs.writeFile(
      DEVICE_FILE,
      JSON.stringify(credentials, null, 2),
      { mode: 0o600 }
    );
  }

  async ensureActivated() {
    await this.loadCredentials();

    if (this.credentials) {
      console.log('[ZuckerBots] Dispositivo local encontrado. Validando conexão com o painel...');

      try {
        const accessResult = await this.request(
          '/api/agent/heartbeat',
          { deviceId: this.credentials.deviceId, messages: [] },
          this.credentials.agentToken
        );
        this.applyAccessState(accessResult);

        console.log('[ZuckerBots] Dispositivo reconhecido pelo painel.');
        return;
      } catch (error) {
        if (!/401|não autorizado|não autorizad/i.test(error.message)) {
          console.log(`[ZuckerBots] Painel indisponível no momento: ${error.message}`);
          throw error;
        }

        console.log('[ZuckerBots] Vínculo antigo não é mais válido. Será necessário ativar novamente.');

        this.credentials = null;
        await fs.rm(DEVICE_FILE, { force: true });
      }
    }

    const activationCode = String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, '0');

    const activation = await this.request(
      '/api/agent/activation-start',
      { activationCode }
    );

    if (!activation.activationSecret) {
      throw new Error('O painel não retornou o segredo de ativação.');
    }

    console.log('');
    console.log('========================================');
    console.log('        ZUCKERBOTS - ATIVAÇÃO');
    console.log('========================================');
    console.log(`Código: ${activationCode}`);
    console.log('Digite este código na área de ativação do site.');
    console.log('Validade: 3 minutos. Uso único.');
    console.log('========================================');

    const expiresAt = Date.parse(activation.expiresAt || '') || (Date.now() + 180000);

    while (Date.now() < expiresAt) {
      const status = await this.request(
        '/api/agent/activation-status',
        { activationSecret: activation.activationSecret }
      );

      if (status.activated && status.deviceId && status.agentToken) {
        await this.saveCredentials({
          deviceId: status.deviceId,
          agentToken: status.agentToken
        });

        await this.request(
          '/api/agent/activation-ack',
          { activationSecret: activation.activationSecret }
        );

        console.log('[ZuckerBots] BOT VINCULADO COM SUCESSO!');
        return;
      }

      await sleep(2000);
    }

    throw new Error('O código de ativação expirou. Reinicie o bot para gerar outro.');
  }

  async saveCustomCommands(commands) {
    if (!Array.isArray(commands)) {
      throw new Error('A lista de comandos recebida não é válida.');
    }

    await fs.mkdir(path.dirname(CUSTOM_COMMANDS_FILE), {
      recursive: true
    });

    const temporaryFile = `${CUSTOM_COMMANDS_FILE}.tmp`;

    await fs.writeFile(
      temporaryFile,
      JSON.stringify(commands, null, 2),
      'utf8'
    );

    await fs.rename(temporaryFile, CUSTOM_COMMANDS_FILE);
  }

  async saveJsonFile(file, value) {
    await fs.mkdir(path.dirname(file), {
      recursive: true
    });

    const temp = `${file}.tmp`;

    await fs.writeFile(
      temp,
      JSON.stringify(value, null, 2),
      'utf8'
    );

    await fs.rename(temp, file);
  }

  // Sincroniza somente quando chega uma revisão nova.
  async syncSettings(settingsSync) {
    if (!settingsSync || !settingsSync.revision) return;

    // Ignora revisões que já foram sincronizadas.
    if (this.settingsRevision === settingsSync.revision) return;

    console.log('[ZuckerBots] Nova atualização recebida!');
    console.log(
      '[ZuckerBots] Comandos PV:',
      settingsSync.customFunctions?.length ?? 0
    );
    console.log(
      '[ZuckerBots] Comandos GP:',
      settingsSync.customFunctionsGP?.length ?? 0
    );

    if (Array.isArray(settingsSync.customFunctions)) {
      await this.saveCustomCommands(settingsSync.customFunctions);
    }

    if (Array.isArray(settingsSync.customFunctionsGP)) {
      await this.saveJsonFile(
        GP_COMMANDS_FILE,
        settingsSync.customFunctionsGP
      );
    }

    const modeSettings = {
      botPvEnabled: settingsSync.botPvEnabled !== false,
      botGpEnabled: settingsSync.botGpEnabled === true,
      pvUnknownMessage: String(settingsSync.pvUnknownMessage || ''),
      gpUnknownMessage: String(settingsSync.gpUnknownMessage || ''),
      pvOwnerCooldown: settingsSync.pvOwnerCooldown,
      pvUserCooldown: settingsSync.pvUserCooldown,
      gpOwnerCooldown: settingsSync.gpOwnerCooldown,
      gpUserCooldown: settingsSync.gpUserCooldown,
      gpAllGroups: settingsSync.gpAllGroups !== false,
      gpSelectedGroups: Array.isArray(settingsSync.gpSelectedGroups)
        ? settingsSync.gpSelectedGroups
        : [],
      autoReplyEnabled: settingsSync.autoReplyEnabled === true,
      autoReplyMessage: String(settingsSync.autoReplyMessage || '').slice(0, 4000),
      autoReplyCooldownMinutes: Math.max(
        1,
        Math.min(43200, Math.floor(Number(settingsSync.autoReplyCooldownMinutes) || 60))
      ),
      autoReplyExcludedNumbers: [...new Set(
        (Array.isArray(settingsSync.autoReplyExcludedNumbers) ? settingsSync.autoReplyExcludedNumbers : [])
          .map(value => String(value).replace(/\D/g, ''))
          .filter(value => /^\d{10,15}$/.test(value))
      )].slice(0, 200)
    };

    const ack = await this.request(
      '/api/agent/command-complete',
      {
        deviceId: this.credentials.deviceId,
        action: 'settings-sync',
        revision: settingsSync.revision
      },
      this.credentials.agentToken
    );

    if (ack.settingsSynced === false || ack.retry === true) {
      throw new Error(
        'As configurações mudaram durante a sincronização. Tentarei novamente.'
      );
    }

    await this.saveJsonFile(MODE_SETTINGS_FILE, modeSettings);

// Configurações independentes da divulgação.
const divulgacaoSettings = {
  divulgacaoEnabled: settingsSync.divulgacaoEnabled === true,

  divulgacaoConfig:
    settingsSync.divulgacaoConfig &&
    typeof settingsSync.divulgacaoConfig === 'object'
      ? settingsSync.divulgacaoConfig
      : { sections: [] },

  divulgacaoCommands: Array.isArray(settingsSync.divulgacaoCommands)
    ? settingsSync.divulgacaoCommands
    : [],

  divulgacaoUpdatedAt: settingsSync.divulgacaoUpdatedAt || null
};

await this.saveJsonFile(
  DIVULGACAO_SETTINGS_FILE,
  divulgacaoSettings
);

Object.assign(this, modeSettings, divulgacaoSettings);

    this.settingsRevision = settingsSync.revision;

    console.log(
      `[ZuckerBots] Configurações sincronizadas: PV ${modeSettings.botPvEnabled ? 'ON' : 'OFF'} / GP ${modeSettings.botGpEnabled ? 'ON' : 'OFF'}.`
    );
  }

  async syncGroups() {
    if (
      !this.credentials ||
      !this.socket ||
      Date.now() - this.groupsSyncAt < 60000
    ) {
      return;
    }

    this.groupsSyncAt = Date.now();

    try {
      const participating = await this.socket.groupFetchAllParticipating();

      const groups = Object.values(participating || {})
        .map(group => ({
          id: String(group.id || ''),
          subject: String(group.subject || 'Grupo sem nome')
        }))
        .filter(group => group.id.endsWith('@g.us'));

      await this.request(
        '/api/agent/command-complete',
        {
          deviceId: this.credentials.deviceId,
          action: 'groups-sync',
          groups
        },
        this.credentials.agentToken
      );

    } catch (error) {
      console.error(
        `[ZuckerBots] Não foi possível atualizar a lista de grupos: ${error.message}`
      );
    }
  }

  async clearLocalSavedContent() {
    // Apaga os textos e registros salvos pelo GUARDAR.
    await fs.rm(CUSTOM_COMMAND_SLOTS_FILE, {
      force: true
    });

    // Apaga as fotos, vídeos e demais mídias do GUARDAR.
    await fs.rm(CUSTOM_COMMAND_MEDIA_DIR, {
      recursive: true,
      force: true
    });

    await fs.rm(GP_SLOTS_FILE, { force: true });

    await fs.rm(GP_MEDIA_DIR, {
      recursive: true,
      force: true
    });

    // Ao desvincular, remove a sessão e seus backups locais, inclusive sobras
    // temporárias. Não toca nos backups de versão .zucker-update-backup-*.
    const databaseDir = path.resolve(__dirname, '../database');
    await fs.rm(path.join(databaseDir, 'qr-code'), { recursive: true, force: true });
    await fs.rm(path.join(databaseDir, 'qr-code-backup'), { recursive: true, force: true });
    const databaseEntries = await fs.readdir(databaseDir, { withFileTypes: true }).catch(() => []);
    for (const entry of databaseEntries) {
      if (entry.isDirectory() && /^(qr-code|qr-code-backup)\.(tmp|previous|restore)-\d+$/.test(entry.name)) {
        await fs.rm(path.join(databaseDir, entry.name), { recursive: true, force: true });
      }
    }

    console.log('[ZuckerBots] Conteúdos e credenciais locais da conta anterior apagados.');
  }

  extractMessage(info) {
    const msg = info?.message || {};

    const type = Object.keys(msg).find(
      key => key !== 'messageContextInfo'
    ) || 'unknown';

    const content = msg[type] || {};

    let text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      content.caption ||
      '';

    if (!text && type !== 'unknown') {
      text = `[${type.replace('Message', '')}]`;
    }

    const timestamp = Number(info.messageTimestamp || 0);

    return {
      remoteJid: String(info.key?.remoteJid || ''),
      messageId: String(info.key?.id || ''),
      participantJid: info.key?.participant || null,
      fromMe: Boolean(info.key?.fromMe),
      messageType: type,
      messageText: String(text).slice(0, 4000),
      messageTimestamp: timestamp
        ? new Date(timestamp * 1000).toISOString()
        : new Date().toISOString()
    };
  }

  queueIncomingMessage(info) {
    if (
      !this.canRunFeatures() ||
      !this.credentials ||
      !info?.key?.id ||
      !info?.key?.remoteJid
    ) {
      return;
    }

    this.messageQueue.push(this.extractMessage(info));

    if (this.messageQueue.length > 100) {
      this.messageQueue.splice(
        0,
        this.messageQueue.length - 100
      );
    }
  }

  setWhatsAppConnected(connected) {
    const next = Boolean(connected);

    if (this.whatsappConnected === next) return;

    this.whatsappConnected = next;

    console.log(
      `[ZuckerBots] WhatsApp ${next ? 'conectado' : 'desconectado'}.`
    );

    this.heartbeat();
  }

  async heartbeat() {
    if (!this.credentials || this.unlinkInProgress || this.unlinkRequested) return;

    if (!this.canRunFeatures()) this.messageQueue = [];
    const batch = this.canRunFeatures() ? this.messageQueue.splice(0, 20) : [];

    try {
      const result = await this.request(
        '/api/agent/heartbeat',
        {
          deviceId: this.credentials.deviceId,
          whatsappConnected: this.whatsappConnected,
          messages: batch
        },
        this.credentials.agentToken
      );
      this.applyAccessState(result);

      if (result.unlinkPending) {
        if (!this.unlinkRequested) {
          console.log('[ZuckerBots] Desvinculação solicitada pelo painel. Bloqueando novos pareamentos.');
        }
        this.unlinkRequested = true;
        if (this.pairingTimer) clearInterval(this.pairingTimer);
        this.pairingTimer = null;
      }
    } catch (error) {
      if (batch.length && this.canRunFeatures()) {
        this.messageQueue.unshift(...batch);
      }
      this.invalidateAccessAfterNetworkFailure();
      console.error(
        `[ZuckerBots] Falha na comunicação com o painel: ${error.message}`
      );
    }
  }

  async checkForUpdates() {
    if (
      !this.credentials ||
      this.updateBusy ||
      this.unlinkInProgress ||
      this.commandBusy ||
      this.pairingBusy ||
      Date.now() < this.updateRetryAfter
    ) {
      return;
    }

    this.updateBusy = true;
    let attemptedVersion = null;

    try {
      const packageData = JSON.parse(
        await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')
      );

      const result = await this.request(
        '/api/agent/command-poll',
        {
          deviceId: this.credentials.deviceId,
          action: 'check-update',
          currentVersion: String(packageData.version || '0.0.0')
        },
        this.credentials.agentToken
      );

      if (!result.updateAvailable || !result.release) return;
      attemptedVersion = String(result.release.version || '');

      console.log('');
      console.log('========================================');
      console.log('[ZuckerBots] NOVA VERSÃO DISPONÍVEL!');
      console.log(`[ZuckerBots] Atual: ${packageData.version}`);
      console.log(`[ZuckerBots] Nova: ${result.release.version}`);
      if (result.release.releaseNotes) {
        console.log(`[ZuckerBots] Novidades: ${result.release.releaseNotes}`);
      }
      console.log('[ZuckerBots] Iniciando atualização automática...');
      console.log('========================================');

      const installed = await installUpdatePackage(result.release);
      if (!installed?.success) throw new Error('O instalador não confirmou a atualização.');

      await this.reportUpdate(attemptedVersion, 'success', 'Atualização instalada; reinicialização solicitada.');

      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.pairingTimer) clearInterval(this.pairingTimer);
      if (this.commandTimer) clearInterval(this.commandTimer);
      if (this.updateTimer) clearInterval(this.updateTimer);
      this.heartbeatTimer = null;
      this.pairingTimer = null;
      this.commandTimer = null;
      this.updateTimer = null;

      console.log('[ZuckerBots] Atualização concluída. Reiniciando para carregar a nova versão...');
      await new Promise(resolve => setTimeout(resolve, 1200));
      process.exit(installed.restartExitCode || 75);
    } catch (error) {
      this.updateRetryAfter = Date.now() + 5 * 60 * 1000;
      if (attemptedVersion && /^\d+\.\d+\.\d+$/.test(attemptedVersion)) {
        await this.reportUpdate(attemptedVersion, 'failed', error.message);
      }
      console.error(`[ZuckerBots] Atualização automática não concluída: ${error.message}`);
      console.error('[ZuckerBots] O bot continuará funcionando e tentará novamente em 5 minutos.');
    } finally {
      this.updateBusy = false;
    }
  }

  startRuntime(socket, authDir) {
    this.socket = socket;
    this.authDir = authDir;

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(
        () => this.heartbeat(),
        30000
      );

      this.heartbeat();
    }

    if (!this.pairingTimer) {
      this.pairingTimer = setInterval(
        () => this.pollPairing(),
        3000
      );
    }

    if (!this.commandTimer) {
      this.commandTimer = setInterval(
        () => this.pollCommands(),
        4000
      );
    }

    if (!this.updateTimer) {
      this.updateTimer = setInterval(
        () => this.checkForUpdates(),
        60000
      );

      this.checkForUpdates();
    }
  }

  async pollPairing() {
    if (
      !this.credentials ||
      !this.socket ||
      this.unlinkRequested ||
      this.unlinkInProgress ||
      this.updateBusy ||
      this.pairingBusy ||
      this.socket.authState?.creds?.registered
    ) {
      return;
    }

    if (!this.socket.ws?.isOpen) return;

    this.pairingBusy = true;
    let pairingStage = 'consultando solicitação no painel';

    try {
      const request = await this.request(
        '/api/agent/pairing-poll',
        { deviceId: this.credentials.deviceId },
        this.credentials.agentToken
      );

      if (!request.hasRequest) return;

      const phone = String(request.phone || '').replace(/\D/g, '');

      if (!/^\d{10,15}$/.test(phone)) {
        throw new Error('Número recebido do painel é inválido.');
      }

      if (!this.socket.ws?.isOpen) {
        throw new Error('O WebSocket do WhatsApp não está aberto.');
      }

      pairingStage = 'solicitando código ao WhatsApp';
      const rawCode = await this.socket.requestPairingCode(phone);

      const pairingCode =
        rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

      if (!pairingCode) {
        throw new Error('O WhatsApp não retornou um código de pareamento.');
      }

      pairingStage = 'enviando código ao painel';
      await this.request(
        '/api/agent/pairing-result',
        {
          deviceId: this.credentials.deviceId,
          requestId: request.requestId,
          pairingCode
        },
        this.credentials.agentToken
      );

      console.log('[ZuckerBots] Código de pareamento enviado ao painel.');

    } catch (error) {
      const causeCode = error?.cause?.code ? ` (${error.cause.code})` : '';
      const causeMessage = error?.cause?.message ? ` — ${error.cause.message}` : '';
      console.error(
        `[ZuckerBots] Falha ao ${pairingStage}: ${error.message}${causeCode}${causeMessage}`
      );

    } finally {
      this.pairingBusy = false;
    }
  }

  async logCommand(command, status) {
    if (!this.credentials) return;

    try {
      await this.request(
        '/api/agent/command-poll',
        {
          deviceId: this.credentials.deviceId,
          action: 'log',
          command,
          status
        },
        this.credentials.agentToken
      );

    } catch (error) {
      console.error(
        `[ZuckerBots] Falha ao registrar comando: ${error.message}`
      );
    }
  }

  async pollCommands() {
    if (!this.credentials || this.commandBusy || this.updateBusy || this.unlinkInProgress) return;

    this.commandBusy = true;

    try {
      const result = await this.request(
        '/api/agent/command-poll',
        { deviceId: this.credentials.deviceId },
        this.credentials.agentToken
      );
      this.applyAccessState(result);

      // A desvinculação deve ser processada mesmo se a conta estiver bloqueada.
      // O comando de unlink é uma operação de limpeza, não uma funcionalidade do bot.
      if (result.hasCommand && result.command === 'unlink') {
        this.unlinkRequested = true;
      } else if (result.accessBlocked === true || !this.canRunFeatures()) {
        return;
      }

      // A desvinculação tem prioridade sobre sincronização de configurações/grupos.
      if (result.hasCommand && result.command === 'unlink') {
        this.unlinkInProgress = true;
        this.unlinkRequested = true;
        console.log('[ZuckerBots] Desvinculando este dispositivo...');

        // Interrompe os pedidos periódicos para não gerar fetch failed durante o desligamento.
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.pairingTimer) clearInterval(this.pairingTimer);
        this.heartbeatTimer = null;
        this.pairingTimer = null;
        this.messageQueue = [];

        try {
          await this.socket?.logout();
        } catch (error) {
          console.log(`[ZuckerBots] WhatsApp já estava desconectado: ${error.message}`);
        }

        // Não reutiliza o socket antigo depois de apagar a sessão.
        this.socket = null;
        this.whatsappConnected = false;

        if (this.authDir) {
          await fs.rm(this.authDir, { recursive: true, force: true });
        }

        // Logs locais são descartáveis; os dados do GUARDAR só são apagados
        // depois que o servidor confirmar a desvinculação.
        const logsDir = path.join(process.cwd(), 'dados', 'logs');
        const logEntries = await fs.readdir(logsDir).catch(() => []);
        for (const entry of logEntries) {
          await fs.rm(path.join(logsDir, entry), { recursive: true, force: true });
        }

        // Tenta concluir no servidor. Se a internet cair, o timer de comandos
        // continua ativo e tentará novamente sem reativar heartbeat/pairing.
        await this.request(
          '/api/agent/command-complete',
          { deviceId: this.credentials.deviceId, commandId: result.commandId },
          this.credentials.agentToken
        );

        await this.clearLocalSavedContent();
        await fs.rm(DEVICE_FILE, { force: true });
        if (this.commandTimer) clearInterval(this.commandTimer);
        this.commandTimer = null;

        this.unlinkRequested = false;
        console.log('[ZuckerBots] Desvinculação confirmada pelo painel. Dados locais apagados. Encerrando...');
        process.exit(0);
        return;
      }


      if (
        typeof result.prefix === 'string' &&
        result.prefix.length > 0 &&
        result.prefix.length <= 3 &&
        !/\s/.test(result.prefix)
      ) {
        this.commandPrefix = result.prefix;
      }

      if (result.ownerNumber !== undefined && result.ownerNumber !== null) {
        const nextOwnerNumber = String(result.ownerNumber).replace(/\D/g, '');

        if (/^\d{10,15}$/.test(nextOwnerNumber) && nextOwnerNumber !== this.ownerNumber) {
          // Só confirma a sincronização depois que connect.js persistir a alteração.
          if (typeof this.ownerNumberChangeHandler === 'function') {
            await this.ownerNumberChangeHandler(nextOwnerNumber, this.ownerNumber);
          }

          this.ownerNumber = nextOwnerNumber;
          console.log('[ZuckerBots] Número do dono sincronizado com o painel.');
        }
      }

      if (result.settingsSync) {
        await this.syncSettings(result.settingsSync);
      }

      if (result.modeSettings && !result.settingsSync) {
        Object.assign(this, result.modeSettings);
      }


      // Não sincroniza grupos durante uma solicitação de desvinculação.
      if (this.socket?.user) {
        await this.syncGroups();
      }

    } catch (error) {
      this.invalidateAccessAfterNetworkFailure();
      if (this.unlinkInProgress) {
        console.error(`[ZuckerBots] Não foi possível confirmar a desvinculação: ${error.message}. O pareamento continuará bloqueado; nova tentativa em alguns segundos.`);
        // Libera apenas o polling do comando para tentar concluir no servidor novamente.
        // unlinkRequested permanece true para impedir qualquer novo pedido de código.
        this.unlinkInProgress = false;
      } else {
        console.error(
          `[ZuckerBots] Erro ao verificar comandos do painel: ${error.message}`
        );
      }

    } finally {
      this.commandBusy = false;
    }
  }
}

export const panel = new ZuckerPanel();
export default panel;
