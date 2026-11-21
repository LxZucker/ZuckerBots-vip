import { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, makeWASocket, fetchLatestBaileysVersion, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast } from 'baileys';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import pino from 'pino';
import fs from 'fs/promises';
import path, { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import axios from 'axios';
import util from 'util';
import PerformanceOptimizer from './utils/performanceOptimizer.js';
import { loadMsgBotOn } from './utils/database.js';
import { buildUserId } from './utils/helpers.js';
import { panel } from './zucker-panel.js';
import { recoverInterruptedUpdate } from './utils/autoUpdater.js';

// Se o processo anterior foi interrompido durante a troca de arquivos,
// restaura a versão anterior antes de iniciar o WhatsApp.
await recoverInterruptedUpdate(process.cwd());
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modules = await import('./funcs/exports.js');
const {
    canvas
} = modules.default;


class MessageQueue {
    constructor(maxWorkers = 4, batchSize = 10, messagesPerBatch = 2) {
        this.queue = [];
        this.maxWorkers = maxWorkers;
        this.batchSize = batchSize;
        this.messagesPerBatch = messagesPerBatch;
        this.activeWorkers = 0;
        this.isProcessing = false;
        this.processingInterval = null;
        this.errorHandler = null;
        this.stats = {
            totalProcessed: 0,
            totalErrors: 0,
            currentQueueLength: 0,
            startTime: Date.now(),
            batchesProcessed: 0,
            avgBatchTime: 0
        };
        this.idCounter = 0; 
    }

    setErrorHandler(handler) {
        this.errorHandler = handler;
    }

    async add(message, processor) {
        return new Promise((resolve, reject) => {
            const item = {
                message,
                processor,
                resolve,
                reject,
                timestamp: Date.now(),
                id: `msg_${++this.idCounter}_${Date.now()}`
            };

            // Comandos com prefixo entram antes das mensagens comuns que ainda
            // aguardam na fila. O processamento já em andamento não é interrompido.
            let msg = message?.message || {};
            while (msg?.ephemeralMessage?.message || msg?.viewOnceMessage?.message || msg?.viewOnceMessageV2?.message) {
                msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message;
            }
            const contentType = Object.keys(msg).find(key => key !== 'messageContextInfo');
            const content = contentType ? msg[contentType] : {};
            const text = String(
                msg.conversation ||
                msg.extendedTextMessage?.text ||
                content?.caption ||
                msg.buttonsResponseMessage?.selectedButtonId ||
                msg.templateButtonReplyMessage?.selectedId ||
                msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
                ''
            ).trimStart();
            const prefix = String(panel.commandPrefix || '#');
            const isCommand = text.startsWith(prefix);

            if (isCommand) this.queue.unshift(item);
            else this.queue.push(item);

            this.stats.currentQueueLength = this.queue.length;

            if (!this.isProcessing) {
                this.startProcessing();
            }
        });
    }

    startProcessing() {
        if (this.isProcessing) return;

        this.isProcessing = true;

        this.processQueue();
    }

    stopProcessing() {
        this.isProcessing = false;
    }

    resume() {
        if (!this.isProcessing) {
            console.log('[MessageQueue] Retomando processamento');
            this.startProcessing();
        }
    }

    async processQueue() {
                while (this.isProcessing && this.queue.length > 0) {

            const availableBatches = Math.min(
                this.batchSize,
                Math.ceil(this.queue.length / this.messagesPerBatch)
            );

            if (availableBatches === 0) break;


            const batches = [];
            for (let i = 0; i < availableBatches && this.queue.length > 0; i++) {
                const batchItems = [];
                for (let j = 0; j < this.messagesPerBatch && this.queue.length > 0; j++) {
                    const item = this.queue.shift();
                    if (item) batchItems.push(item);
                }
                if (batchItems.length > 0) {
                    batches.push(batchItems);
                }
            }

            this.stats.currentQueueLength = this.queue.length;


            const batchStartTime = Date.now();
            await Promise.allSettled(
                batches.map(batch => this.processBatch(batch))
            );

            const batchDuration = Date.now() - batchStartTime;
            this.stats.batchesProcessed++;
            this.stats.avgBatchTime =
                (this.stats.avgBatchTime * (this.stats.batchesProcessed - 1) + batchDuration) /
                this.stats.batchesProcessed;
        }

        if (this.queue.length === 0) {
            this.stopProcessing();
        }
    }

    async processBatch(batchItems) {

        const batchPromises = batchItems.map(item => this.processItem(item));

        const results = await Promise.allSettled(batchPromises);


        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                this.stats.totalProcessed++;
            } else {
                this.stats.totalErrors++;
            }
        });
    }

    async processItem(item) {
        const { message, processor, resolve } = item;

        try {
            const result = await processor(message);
            resolve(result);
            return result;
        } catch (error) {
                         await this.handleProcessingError(item, error);

        }
    }

    async handleProcessingError(item, error) {
        this.stats.totalErrors++;

        console.error(`❌ Queue processing error for message ${item.id}:`, error.message);

        if (this.errorHandler) {
            try {
                await this.errorHandler(item, error);
            } catch (handlerError) {
                console.error('❌ Error handler failed:', handlerError.message);
            }
        }


        item.reject(error);
    }

    getStatus() {
        const uptime = Date.now() - this.stats.startTime;
        return {
            queueLength: this.queue.length,
            activeWorkers: this.activeWorkers,
            maxWorkers: this.maxWorkers,
            batchSize: this.batchSize,
            messagesPerBatch: this.messagesPerBatch,
            isProcessing: this.isProcessing,
            totalProcessed: this.stats.totalProcessed,
            totalErrors: this.stats.totalErrors,
            currentQueueLength: this.stats.currentQueueLength,
            batchesProcessed: this.stats.batchesProcessed,
            avgBatchTime: Math.round(this.stats.avgBatchTime),
            uptime: uptime,
            uptimeFormatted: this.formatUptime(uptime),
            throughput: this.stats.totalProcessed > 0 ?
                (this.stats.totalProcessed / (uptime / 1000)).toFixed(2) : 0,
            errorRate: this.stats.totalProcessed > 0 ?
                ((this.stats.totalErrors / this.stats.totalProcessed) * 100).toFixed(2) : 0
        };
    }

    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    clear() {

        this.queue.forEach(item => {
            if (item.reject) {
                item.reject(new Error('Queue cleared'));
            }
        });
        this.queue = [];
        this.stats.currentQueueLength = 0;
        this.stopProcessing();
    }

    async shutdown() {
        console.log('🛑 Finalizando MessageQueue...');
        this.stopProcessing();


        const shutdownTimeout = 10000;
        const startTime = Date.now();

        while (this.activeWorkers > 0 && (Date.now() - startTime) < shutdownTimeout) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (this.activeWorkers > 0) {
            console.warn(`⚠️ ${this.activeWorkers} workers ainda ativos após timeout de shutdown`);
        }

        this.clear();
        console.log('✅ MessageQueue finalizado');
    }
}

const messageQueue = new MessageQueue(8, 10, 2); 

const configPath = path.join(__dirname, "config.json");
let config;
let DEBUG_MODE = false; 



global.CAPTCHA_LOCK = global.CAPTCHA_LOCK || new Set();


try {
    const configContent = readFileSync(configPath, "utf8");
    config = JSON.parse(configContent);


    if (!config.prefixo || !config.nomebot || !config.numerodono) {
        throw new Error('Configuração inválida: campos obrigatórios ausentes (prefixo, nomebot, numerodono)');
    }


  DEBUG_MODE = config.debug === true || process.env.NAZUNA_DEBUG === '1';
    if (DEBUG_MODE) {
    }
} catch (err) {
    console.error(`❌ Erro ao carregar configuração: ${err.message}`);
    process.exit(1);
}

const indexModule = (await import('./index.js')).default ?? (await import('./index.js'));

const performanceOptimizer = new PerformanceOptimizer();

const {
    prefixo,
    nomebot,
    nomedono
} = config;

let numerodono = String(config.numerodono).replace(/\D/g, '');

// Mantém no painel o número e o LID do Dono usados pelo reconhecimento de comandos.
panel.ownerNumber = numerodono;
panel.ownerLid = typeof config.lidowner === 'string' ? config.lidowner : null;

const logger = pino({
    level: 'silent'
});

const AUTH_DIR = path.join(__dirname, '..', 'database', 'qr-code');
const AUTH_BACKUP_DIR = path.join(__dirname, '..', 'database', 'qr-code-backup');
const AUTH_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
let authBackupInterval = null;
let authBackupRunning = false;
const DATABASE_DIR = path.join(__dirname, '..', 'database');
const GLOBAL_BLACKLIST_PATH = path.join(__dirname, '..', 'database', 'dono', 'globalBlacklist.json');

 let _globalBlacklistCache = null;
let _globalBlacklistCacheTime = 0;
const GLOBAL_BLACKLIST_TTL_MS = 60_000;

let msgRetryCounterCache;
let messagesCache;

async function initializeOptimizedCaches(ZuckerBotSock) {
    try {
        await performanceOptimizer.initialize();
msgRetryCounterCache = {
            get: (key) => performanceOptimizer.cacheGet('msgRetry', key),
            set: (key, value, ttl) => performanceOptimizer.cacheSet('msgRetry', key, value, ttl),
            del: (key) => performanceOptimizer.modules.cacheManager?.del('msgRetry', key)
        };

        messagesCache = new Map();

    } catch (error) {
        console.error('❌ Erro ao inicializar sistema de otimização:', error.message);

        msgRetryCounterCache = new NodeCache({
            stdTTL: 5 * 60,
            useClones: false
        });
        messagesCache = new Map();

    }
}
const codeMode = true; // ZuckerBot usa exclusivamente pareamento por código do painel.


let cacheCleanupInterval = null;
let healthStatusInterval = null;
const setupMessagesCacheCleanup = () => {
    if (cacheCleanupInterval) clearInterval(cacheCleanupInterval);

    cacheCleanupInterval = setInterval(() => {
        if (!messagesCache || messagesCache.size <= 3000) return;

        const keysToDelete = Math.floor(messagesCache.size * 0.4); 
        const keys = Array.from(messagesCache.keys()).slice(0, keysToDelete);
        keys.forEach(key => messagesCache.delete(key));

        console.log(`🧹 Cache limpo: ${keysToDelete} mensagens removidas (total: ${messagesCache.size})`);
    }, 300000); // A cada 5 minutos
};


const startCacheCleanup = () => {
    setupMessagesCacheCleanup();
};


async function clearAuthDir(dirToRemove = AUTH_DIR) {

    try {
        const normalized = path.resolve(dirToRemove);


        const rootPath = path.parse(normalized).root;
        if (normalized === rootPath) {
            console.error(`❌ Abortando limpeza: caminho inválido (${normalized})`);
            return;
        }

        const normalizedParts = normalized.split(path.sep).filter(Boolean);
        const looksLikeAuthDir = normalizedParts.includes('qr-code') || normalizedParts.includes('auth');
        if (!looksLikeAuthDir) {
            console.error(`❌ Abortando limpeza: caminho não parece diretório de auth/qr-code (${normalized})`);
            return;
        }

        if (typeof fs.rm === 'function') {
            await fs.rm(normalized, { recursive: true, force: true });
        } else if (typeof fs.rmdir === 'function') {

            await fs.rmdir(normalized, { recursive: true }).catch(() => { });
        } else {
            throw new Error('API de remoção de diretório não disponível (fs.rm/fs.rmdir)');
        }

        console.log(`🗑️ Pasta de autenticação (${normalized}) excluída com sucesso.`);
    } catch (err) {
        console.error(`❌ Erro ao excluir pasta de autenticação (${dirToRemove}): ${err.message}`);
    }
}


// Backup local da sessão do WhatsApp. O diretório temporário é concluído
// antes de substituir o backup anterior, preservando a última cópia válida.
async function createAuthBackup(reason = 'periódico') {
    if (authBackupRunning) return false;
    authBackupRunning = true;
    const tempDir = `${AUTH_BACKUP_DIR}.tmp-${process.pid}`;
    const previousDir = `${AUTH_BACKUP_DIR}.previous-${process.pid}`;

    try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        const creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
        const authFiles = await fs.readdir(AUTH_DIR);
        if (!creds || creds.registered !== true || authFiles.length < 2) {
            throw new Error('A sessão ainda não está completa/autenticada para backup.');
        }

        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.cp(AUTH_DIR, tempDir, { recursive: true, errorOnExist: true });
        // Confere a cópia antes de promovê-la a backup oficial.
        JSON.parse(await fs.readFile(path.join(tempDir, 'creds.json'), 'utf8'));

        await fs.rm(previousDir, { recursive: true, force: true });
        let hadPrevious = false;
        try {
            await fs.rename(AUTH_BACKUP_DIR, previousDir);
            hadPrevious = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        try {
            await fs.rename(tempDir, AUTH_BACKUP_DIR);
        } catch (error) {
            if (hadPrevious) {
                await fs.rename(previousDir, AUTH_BACKUP_DIR).catch(() => {});
            }
            throw error;
        }

        await fs.rm(previousDir, { recursive: true, force: true });
        console.log(`💾 Backup da sessão WhatsApp atualizado (${reason}).`);
        return true;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`⚠️ Não foi possível atualizar o backup da sessão: ${error.message}`);
        }
        return false;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        authBackupRunning = false;
    }
}

async function restoreAuthBackupIfNeeded() {
    let currentSessionValid = false;
    try {
        const creds = JSON.parse(await fs.readFile(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
        const authFiles = await fs.readdir(AUTH_DIR);
        currentSessionValid = Boolean(creds?.registered === true && authFiles.length >= 2);
    } catch {}

    if (currentSessionValid) return false;

    try {
        const backupCredsPath = path.join(AUTH_BACKUP_DIR, 'creds.json');
        const backupCreds = JSON.parse(await fs.readFile(backupCredsPath, 'utf8'));
        const backupFiles = await fs.readdir(AUTH_BACKUP_DIR);
        if (!backupCreds || backupCreds.registered !== true || backupFiles.length < 2) return false;

        const restoreTemp = `${AUTH_DIR}.restore-${process.pid}`;
        await fs.rm(restoreTemp, { recursive: true, force: true });
        await fs.cp(AUTH_BACKUP_DIR, restoreTemp, { recursive: true });
        JSON.parse(await fs.readFile(path.join(restoreTemp, 'creds.json'), 'utf8'));
        await fs.rm(AUTH_DIR, { recursive: true, force: true });
        await fs.rename(restoreTemp, AUTH_DIR);
        console.log('♻️ Sessão restaurada do último backup automático.');
        return true;
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`⚠ Não foi possível restaurar o backup da sessão: ${error.message}`);
        return false;
    }
}

async function clearAuthBackup() {
    await fs.rm(AUTH_BACKUP_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.rm(`${AUTH_BACKUP_DIR}.tmp-${process.pid}`, { recursive: true, force: true }).catch(() => {});
}

// Remove apenas diretórios temporários órfãos de backups de autenticação.
// Nunca toca no backup oficial nem nos backups de versão do atualizador.
async function cleanStaleAuthBackupArtifacts() {
    const entries = await fs.readdir(DATABASE_DIR, { withFileTypes: true }).catch(() => []);
    const prefixes = ['qr-code-backup.tmp-', 'qr-code-backup.previous-'];
    for (const entry of entries) {
        if (!entry.isDirectory() || !prefixes.some(prefix => entry.name.startsWith(prefix))) continue;
        const target = path.join(DATABASE_DIR, entry.name);
        try {
            const stat = await fs.stat(target);
            // Só remove pastas com mais de 10 minutos, evitando interferir em cópia ativa.
            if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                await fs.rm(target, { recursive: true, force: true });
                console.log(`[ZuckerBots] Pasta temporária antiga removida: ${entry.name}`);
            }
        } catch (error) {
            console.warn(`[ZuckerBots] Não foi possível limpar ${entry.name}: ${error.message}`);
        }
    }
}


async function loadGlobalBlacklist() {

    const now = Date.now();
    if (_globalBlacklistCache !== null && (now - _globalBlacklistCacheTime) < GLOBAL_BLACKLIST_TTL_MS) {
        return _globalBlacklistCache;
    }
    try {
        const data = await fs.readFile(GLOBAL_BLACKLIST_PATH, 'utf-8');
        _globalBlacklistCache = JSON.parse(data).users || {};
        _globalBlacklistCacheTime = now;
        return _globalBlacklistCache;
    } catch (e) {
        console.error(`❌ Erro ao ler blacklist global: ${e.message}`);

        return _globalBlacklistCache ?? {};
    }
}

function formatMessageText(template, replacements) {
    let text = template;
    for (const [key, value] of Object.entries(replacements)) {
        text = text.replaceAll(key, value);
    }
    return text;
}


const isValidJid = (str) => /^\d+@s\.whatsapp\.net$/.test(str);
const isValidLid = (str) => /^[a-zA-Z0-9_]+@lid$/.test(str);
const isValidUserId = (str) => isValidJid(str) || isValidLid(str);

function isValidParticipant(participant) {

    if (typeof participant === 'string') {
        if (participant.trim().length === 0) return false;
        return participant;
    }


    if (participant && typeof participant === 'object' && participant.hasOwnProperty('id')) {
        const id = participant.id;
        if (id === null || id === undefined || id === '') return false;
        if (typeof id === 'string' && id.trim().length === 0) return false;
        if (id === 0) return false;

        return id;
    }

    return false;
}

function collectJidsFromJson(obj, jidsSet = new Set()) {
    if (Array.isArray(obj)) {
        obj.forEach(item => collectJidsFromJson(item, jidsSet));
    } else if (obj && typeof obj === 'object') {
        Object.values(obj).forEach(value => collectJidsFromJson(value, jidsSet));
    } else if (typeof obj === 'string' && isValidJid(obj)) {
        jidsSet.add(obj);
    }
    return jidsSet;
}

function replaceJidsInJson(obj, jidToLidMap, orphanJidsSet, replacementsCount = { count: 0 }, removalsCount = { count: 0 }) {
    if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
            const newItem = replaceJidsInJson(item, jidToLidMap, orphanJidsSet, replacementsCount, removalsCount);
            if (newItem !== item) obj[index] = newItem;
        });
    } else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        Object.keys(obj).forEach(key => {
            const value = obj[key];
            if (typeof value === 'string' && isValidJid(value)) {
                if (jidToLidMap.has(value)) {
                    obj[key] = jidToLidMap.get(value);
                    replacementsCount.count++;
                } else if (orphanJidsSet.has(value)) {
                    delete obj[key];
                    removalsCount.count++;
                }
            } else {
                const newValue = replaceJidsInJson(value, jidToLidMap, orphanJidsSet, replacementsCount, removalsCount);
                if (newValue !== value) obj[key] = newValue;
            }
        });
    } else if (typeof obj === 'string' && isValidJid(obj)) {
        if (jidToLidMap.has(obj)) {
            replacementsCount.count++;
            return jidToLidMap.get(obj);
        } else if (orphanJidsSet.has(obj)) {
            removalsCount.count++;
            return null;
        }
    }
    return obj;
}

async function scanForJids(directory) {
    const uniqueJids = new Set();
    const affectedFiles = new Map();
    const jidFiles = new Map();

  const scanFileContent = async (filePath) => {
    try {
        const content = await fs.readFile(filePath, 'utf-8');

        let jsonObj;

        try {
            jsonObj = JSON.parse(content);
        } catch {
            // Ignora arquivos internos que não são JSON válido.
            return;
        }

        const fileJids = collectJidsFromJson(jsonObj);

        if (fileJids.size > 0) {
            affectedFiles.set(filePath, Array.from(fileJids));
            fileJids.forEach(jid => uniqueJids.add(jid));
        }

    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`Erro ao ler ${filePath}: ${error.message}`);
        }
    }
};

    const checkAndScanFilename = async (fullPath) => {
        try {
            const basename = path.basename(fullPath, '.json');
            const filenameMatch = basename.match(/(\d+@s\.whatsapp\.net)/);
            if (filenameMatch) {
                const jidFromName = filenameMatch[1];
                if (isValidJid(jidFromName)) {
                    uniqueJids.add(jidFromName);
                    jidFiles.set(jidFromName, fullPath);
                }
            }
            await scanFileContent(fullPath);
        } catch (err) {
            console.error(`Erro ao processar ${fullPath}: ${err.message}`);
        }
    };

     
const scanDir = async (dirPath) => {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
                const protectedDirs = [
                    'qr-code',
                    'auth',
                    'auth_info',
                    'auth-info'
                ];

                if (protectedDirs.includes(entry.name.toLowerCase())) {
                    continue;
                }

                await scanDir(fullPath);
            } else if (entry.name.endsWith('.json')) {
                await checkAndScanFilename(fullPath);
            }
        }
    } catch (err) {
        console.error(`Erro ao escanear diretório ${dirPath}: ${err.message}`);
    }
};


    await scanDir(directory);

    try {
        await scanFileContent(configPath);
        const configBasename = path.basename(configPath, '.json');
        const filenameMatch = configBasename.match(/(\d+@s\.whatsapp\.net)/);
        if (filenameMatch) {
            const jidFromName = filenameMatch[1];
            if (isValidJid(jidFromName)) {
                uniqueJids.add(jidFromName);
                jidFiles.set(jidFromName, configPath);
            }
        }
    } catch (err) {
        console.error(`Erro ao escanear config.json: ${err.message}`);
    }

    return {
        uniqueJids: Array.from(uniqueJids),
        affectedFiles: Array.from(affectedFiles.entries()),
        jidFiles: Array.from(jidFiles.entries())
    };
}

async function replaceJidsInContent(affectedFiles, jidToLidMap, orphanJidsSet) {
    let totalReplacements = 0;
    let totalRemovals = 0;
    const updatedFiles = [];

    for (const [filePath, jids] of affectedFiles) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            let jsonObj = JSON.parse(content);
            const replacementsCount = { count: 0 };
            const removalsCount = { count: 0 };
            replaceJidsInJson(jsonObj, jidToLidMap, orphanJidsSet, replacementsCount, removalsCount);
            if (replacementsCount.count > 0 || removalsCount.count > 0) {
                const updatedContent = JSON.stringify(jsonObj, null, 2);
                await fs.writeFile(filePath, updatedContent, 'utf-8');
                totalReplacements += replacementsCount.count;
                totalRemovals += removalsCount.count;
                updatedFiles.push(path.basename(filePath));
            }
        } catch (err) {
            console.error(`Erro ao substituir em ${filePath}: ${err.message}`);
        }
    }

    return { totalReplacements, totalRemovals, updatedFiles };
}

async function handleJidFiles(jidFiles, jidToLidMap, orphanJidsSet) {
    let totalReplacements = 0;
    let totalRemovals = 0;
    const updatedFiles = [];
    const renamedFiles = [];
    const deletedFiles = [];

    for (const [jid, oldPath] of jidFiles) {
        if (orphanJidsSet.has(jid)) {
            try {
                await fs.unlink(oldPath);
                deletedFiles.push(path.basename(oldPath));
                totalRemovals++;
                continue;
            } catch (err) {
                console.error(`Erro ao excluir arquivo órfão ${oldPath}: ${err.message}`);
            }
        }

        const lid = jidToLidMap.get(jid);
        if (!lid) {
            continue;
        }

        try {
            const content = await fs.readFile(oldPath, 'utf-8');
            let jsonObj = JSON.parse(content);
            const replacementsCount = { count: 0 };
            const removalsCount = { count: 0 };
            replaceJidsInJson(jsonObj, jidToLidMap, orphanJidsSet, replacementsCount, removalsCount);
            totalReplacements += replacementsCount.count;
            totalRemovals += removalsCount.count;

            const dir = path.dirname(oldPath);
            const newPath = join(dir, `${lid}.json`);

            try {
                await fs.access(newPath);
                continue;
            } catch { }

            const updatedContent = JSON.stringify(jsonObj, null, 2);
            await fs.writeFile(newPath, updatedContent, 'utf-8');
            await fs.unlink(oldPath);

            updatedFiles.push(path.basename(newPath));
            renamedFiles.push({ old: path.basename(oldPath), new: path.basename(newPath) });

        } catch (err) {
            console.error(`Erro ao processar renomeação de ${oldPath}: ${err.message}`);
        }
    }

    return { totalReplacements, totalRemovals, updatedFiles, renamedFiles, deletedFiles };
}

async function fetchLidWithRetry(ZuckerBotSock, jid, maxRetries = 3) {
    if (!jid || !isValidJid(jid)) {
        console.warn(`⚠️ JID inválido fornecido: ${jid}`);
        return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await ZuckerBotSock.onWhatsApp(jid);
            if (result && result[0] && result[0].lid) {
                return { jid, lid: result[0].lid };
            }
            return null;
        } catch (err) {
            if (attempt === maxRetries) {
                console.warn(`⚠️ Falha ao buscar LID para ${jid} após ${maxRetries} tentativas`);
            }
        }
        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
    }
    return null;
}

async function fetchLidsInBatches(ZuckerBotSock, uniqueJids, batchSize = 5) {
    const lidResults = [];
    const jidToLidMap = new Map();
    let successfulFetches = 0;

    for (let i = 0; i < uniqueJids.length; i += batchSize) {
        const batch = uniqueJids.slice(i, i + batchSize);

        const batchPromises = batch.map(jid => fetchLidWithRetry(ZuckerBotSock, jid));
        const batchResults = await Promise.allSettled(batchPromises);

        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                const { jid, lid } = result.value;
                lidResults.push({ jid, lid });
                jidToLidMap.set(jid, lid);
                successfulFetches++;
            }
        });

        if (i + batchSize < uniqueJids.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    return { lidResults, jidToLidMap, successfulFetches };
}

async function updateOwnerLid(ZuckerBotSock) {
    const ownerJid = `${numerodono}@s.whatsapp.net`;
    try {
        const result = await fetchLidWithRetry(ZuckerBotSock, ownerJid);
        if (result?.lid) {
            config.lidowner = result.lid;
            panel.ownerLid = result.lid;
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        }
    } catch (err) {
        console.error(`❌ Erro ao atualizar LID do dono: ${err.message}`);
    }
}

// Aplica alterações do número do dono recebidas pelo painel sem reiniciar o bot.
panel.ownerNumberChangeHandler = async (nextOwnerNumber) => {
    const normalizedNumber = String(nextOwnerNumber || '').replace(/\D/g, '');

    if (!/^\d{10,15}$/.test(normalizedNumber)) {
        throw new Error('O painel enviou um número de dono inválido.');
    }

    if (normalizedNumber === numerodono) return;

    const previousNumber = numerodono;
    const previousLid = config.lidowner;

    config.numerodono = normalizedNumber;
    delete config.lidowner;
    panel.ownerLid = null;

    try {
        // Persiste primeiro para que o novo número sobreviva a reinicializações.
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        numerodono = normalizedNumber;

        if (panel.socket?.user) {
            await updateOwnerLid(panel.socket);
        }

        console.log(`[ZuckerBots] Número do dono atualizado: ${normalizedNumber}`);
    } catch (error) {
        // Mantém o estado anterior se a gravação local falhar.
        numerodono = previousNumber;
        config.numerodono = previousNumber;
        if (previousLid) config.lidowner = previousLid;
        else delete config.lidowner;
        panel.ownerLid = previousLid || null;
        throw error;
    }
};

async function performMigration(ZuckerBotSock) {
    let scanResult;
    try {
        scanResult = await scanForJids(DATABASE_DIR);
    } catch (err) {
        console.error(`Erro crítico no scan: ${err.message}`);
        return;
    }

    const { uniqueJids, affectedFiles, jidFiles } = scanResult;

    if (uniqueJids.length === 0) {
        return;
    }

    const { jidToLidMap, successfulFetches } = await fetchLidsInBatches(ZuckerBotSock, uniqueJids);
    const orphanJidsSet = new Set(uniqueJids.filter(jid => !jidToLidMap.has(jid)));

    if (jidToLidMap.size === 0) {
        return;
    }

    let totalReplacements = 0;
    let totalRemovals = 0;
    const allUpdatedFiles = [];

    try {
        const renameResult = await handleJidFiles(jidFiles, jidToLidMap, orphanJidsSet);
        totalReplacements += renameResult.totalReplacements;
        totalRemovals += renameResult.totalRemovals;
        allUpdatedFiles.push(...renameResult.updatedFiles);

        const filteredAffected = affectedFiles.filter(([filePath]) => !jidFiles.some(([, jidPath]) => jidPath === filePath));
        const contentResult = await replaceJidsInContent(filteredAffected, jidToLidMap, orphanJidsSet);
        totalReplacements += contentResult.totalReplacements;
        totalRemovals += contentResult.totalRemovals;
        allUpdatedFiles.push(...contentResult.updatedFiles);
    } catch (processErr) {
        console.error(`Erro no processamento de substituições: ${processErr.message}`);
        return;
    }

}


let reconnectAttempts = 0;
let isReconnecting = false; 
let reconnectTimer = null; 
let forbidden403Attempts = 0; 
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_403_ATTEMPTS = 3; 
const RECONNECT_DELAY_BASE = 5000; 

let ownerMsgTimer = null;
let subBotInitTimer = null;

let _cachedWAVersion = null;

async function getWAVersion() {
    if (_cachedWAVersion) return _cachedWAVersion;
    const { version } = await fetchLatestBaileysVersion();
    _cachedWAVersion = version;
    return version;
}

async function createBotSocket(authDir) {
    try {
        await cleanStaleAuthBackupArtifacts();
        await fs.mkdir(authDir, { recursive: true });
        await restoreAuthBackupIfNeeded();
        const {
            state,
            saveCreds,
            signalRepository
        } = await useMultiFileAuthState(authDir, makeCacheableSignalKeyStore);


        const version = await getWAVersion();
        console.log(`📱 Usando versão do WhatsApp: ${version.join('.')}`);

        const ZuckerBotSock = makeWASocket({
            version,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 120000,
            retryRequestDelayMs: 5000,
            qrTimeout: 180000,
            keepAliveIntervalMs: 30_000,
                 defaultQueryTimeoutMs: 60_000,
            maxMsgRetryCount: 5,
            shouldIgnoreJid: (jid) =>
                isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid),
            shouldSyncHistoryMessage: () => false,
            msgRetryCounterCache,
            auth: state,
            signalRepository,
            logger
        });

        // O pareamento por número agora é solicitado pelo painel ZuckerBots.
        panel.startRuntime(ZuckerBotSock, authDir);

        ZuckerBotSock.ev.on('creds.update', saveCreds);

        if (authBackupInterval) clearInterval(authBackupInterval);
        authBackupInterval = setInterval(() => {
            createAuthBackup('intervalo de 5 minutos').catch(() => {});
        }, AUTH_BACKUP_INTERVAL_MS);
        authBackupInterval.unref?.();
        // Gera a primeira cópia logo após a sessão autenticada estar disponível.
        createAuthBackup('inicialização').catch(() => {});

      let messagesListenerAttached = false;

        const queueErrorHandler = async (item, error) => {
            console.error(`❌ Critical error processing message ${item.id}:`, error);

            if (error.message.includes('ENOSPC') || error.message.includes('ENOMEM')) {
                console.error('🚨 Critical system error detected, triggering emergency cleanup...');
                try {
                    await performanceOptimizer.emergencyCleanup();
                } catch (cleanupErr) {
                    console.error('❌ Emergency cleanup failed:', cleanupErr.message);
                }
            }

            console.error({
                messageId: item.id,
                errorType: error.constructor.name,
                errorMessage: error.message,
                stack: error.stack,
                messageTimestamp: item.timestamp,
                queueStatus: messageQueue.getStatus()
            });
        };

        messageQueue.setErrorHandler(queueErrorHandler);

        const processMessage = async (info) => {

    if (!info || !info.message || !info.key?.remoteJid) {
        return;
    }


    if (messagesCache && info.key?.id && info.key?.remoteJid) {
        const cacheKey = `${info.key.remoteJid}_${info.key.id}`;
        messagesCache.set(cacheKey, info);
    }

    if (typeof indexModule === 'function') {

        await indexModule(ZuckerBotSock, info, null, messagesCache);
    } else {
    }
};

        
const attachMessagesListener = () => {
    if (messagesListenerAttached) return;

    messagesListenerAttached = true;

    ZuckerBotSock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || !Array.isArray(m.messages)) return;

        // Recebe mensagens novas e mensagens adicionadas à conversa.
        if (m.type !== 'notify' && m.type !== 'append') return;

        try {
            const now = Math.floor(Date.now() / 1000);

            const incomingMessages = m.messages.filter(info => {
                if (!info?.message || !info.key?.remoteJid) return false;

                const jid = info.key.remoteJid;

                // Ignora status, transmissões e canais.
                if (
                    isJidBroadcast(jid) ||
                    isJidStatusBroadcast(jid) ||
                    isJidNewsletter(jid)
                ) return false;

                // Evita processar mensagens antigas recebidas em append.
                if (m.type === 'append') {
                    const rawTimestamp = info.messageTimestamp;

                    const timestamp =
                        typeof rawTimestamp?.toNumber === 'function'
                            ? rawTimestamp.toNumber()
                            : Number(rawTimestamp);

                    if (!Number.isFinite(timestamp)) return false;

                    if (Math.abs(now - timestamp) > 120) return false;
                }

                return true;
            });

            if (incomingMessages.length === 0) return;


            const promises = incomingMessages.map(info => {
                const cacheKey = info.key.id
                    ? `${info.key.remoteJid}_${info.key.id}`
                    : null;

                // Evita processar a mesma mensagem duas vezes.
                if (cacheKey && messagesCache?.has(cacheKey)) {
                    return Promise.resolve();
                }

                // Não marque como processada antes de entrar na fila.
                // processMessage grava no cache quando começa a execução;
                // gravar aqui fazia a própria mensagem ser descartada como duplicada.
                return messageQueue.add(info, processMessage).catch(err => {
                    console.error(
                        `❌ Erro ao processar mensagem ${info.key?.id}:`,
                        err.message
                    );
                });
            });

            await Promise.allSettled(promises);

        } catch (err) {
            console.error(
                '❌ Erro no recebimento de mensagens:',
                err.message
            );

            if (
                err.message.includes('ENOSPC') ||
                err.message.includes('ENOMEM')
            ) {
                try {
                    await performanceOptimizer.emergencyCleanup();
                } catch (cleanupErr) {
                    console.error(
                        '❌ Falha na limpeza:',
                        cleanupErr.message
                    );
                }
            }
        }
    });
};

        ZuckerBotSock.ev.on('connection.update', async (update) => {
            const {
                connection,
                lastDisconnect,
            } = update;
            if (connection === 'open') {
                panel.setWhatsAppConnected(true);
                if (healthStatusInterval) clearInterval(healthStatusInterval);
                const printHealthStatus = () => {
                    console.log(`💚 [ZuckerBots] Sistema operacional — WhatsApp conectado e bot funcionando | ${new Date().toLocaleString('pt-BR')}`);
                };
                printHealthStatus();
                healthStatusInterval = setInterval(printHealthStatus, 60_000);
            }
            if (connection === 'close') {
                panel.setWhatsAppConnected(false);
                if (healthStatusInterval) {
                    clearInterval(healthStatusInterval);
                    healthStatusInterval = null;
                }
            }
            if (connection === 'open') {
                                 try {
                 
                reconnectAttempts = 0;
                forbidden403Attempts = 0;
                console.log(`🔄 Conexão aberta. Inicializando sistema de otimização...`);

                    await initializeOptimizedCaches(ZuckerBotSock);

                    await updateOwnerLid(ZuckerBotSock);

                     setTimeout(() => {
                        performMigration(ZuckerBotSock).catch(err => {
                            console.error('❌ Erro na migração (não-bloqueante):', err.message);
                        });
                    }, 10_000);

                    attachMessagesListener();
                    startCacheCleanup(); 
                    try {
                        const msgBotOnConfig = loadMsgBotOn();

                        if (msgBotOnConfig.enabled) {
                            if (ownerMsgTimer) clearTimeout(ownerMsgTimer);
                            ownerMsgTimer = setTimeout(async () => {
                                ownerMsgTimer = null;
                                try {
                                    const ownerJid = buildUserId(numerodono, config);
                                    await ZuckerBotSock.sendMessage(ownerJid, {
                                        text: msgBotOnConfig.message
                                    });
                                    console.log('✅ Mensagem de inicialização enviada para o dono');
                                } catch (sendError) {
                                    console.error('❌ Erro ao enviar mensagem de inicialização:', sendError.message);
                                }
                            }, 3000);
                        } else {
                            console.log('ℹ️ Mensagem de inicialização desativada');
                        }
                    } catch (msgError) {
                        console.error('❌ Erro ao processar mensagem de inicialização:', msgError.message);
                    }


                    try {
                        const subBotManagerModule = await import('./utils/subBotManager.js');
                        const subBotManager = subBotManagerModule.default ?? subBotManagerModule;
                        console.log('🤖 Verificando sub-bots cadastrados...');

                        if (subBotInitTimer) clearTimeout(subBotInitTimer);
                        subBotInitTimer = setTimeout(async () => {
                            subBotInitTimer = null;
                            await subBotManager.initializeAllSubBots();
                        }, 5000);
                    } catch (error) {
                        console.error('❌ Erro ao inicializar sub-bots:', error.message);
                    }

                    console.log(`✅ Bot ${nomebot} iniciado com sucesso! Prefixo: ${prefixo} | Dono: ${nomedono}`);
                    console.log(`📊 Configuração: ${messageQueue.batchSize} lotes de ${messageQueue.messagesPerBatch} mensagens (${messageQueue.batchSize * messageQueue.messagesPerBatch} msgs paralelas)`);
                } catch (initErr) {

                    console.error('❌ Erro crítico na inicialização pós-conexão:', initErr.message);
                    setTimeout(() => startNazu(), 5000);
                }
            }
            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const reasonMessage = {
                    [DisconnectReason.loggedOut]: 'Deslogado do WhatsApp',
                    401: 'Sessão expirada',
                    403: 'Acesso proibido (Forbidden)',
                    [DisconnectReason.connectionClosed]: 'Conexão fechada',
                    [DisconnectReason.connectionLost]: 'Conexão perdida',
                    [DisconnectReason.connectionReplaced]: 'Conexão substituída',
                    [DisconnectReason.timedOut]: 'Tempo de conexão esgotado',
                    [DisconnectReason.badSession]: 'Sessão inválida',
                    [DisconnectReason.restartRequired]: 'Reinício necessário',
                }[reason] || 'Motivo desconhecido';

                console.log(`❌ Conexão fechada. Código: ${reason} | Motivo: ${reasonMessage}`);


                if (cacheCleanupInterval) {
                    clearInterval(cacheCleanupInterval);
                    cacheCleanupInterval = null;
                }



                if (ownerMsgTimer) { clearTimeout(ownerMsgTimer); ownerMsgTimer = null; }
                if (subBotInitTimer) { clearTimeout(subBotInitTimer); subBotInitTimer = null; }


                if (reason === 403) {
                    forbidden403Attempts++;
                    console.log(`⚠️ Erro 403 detectado. Tentativa ${forbidden403Attempts}/${MAX_403_ATTEMPTS}`);

                    if (forbidden403Attempts >= MAX_403_ATTEMPTS) {
                        console.log('❌ Máximo de tentativas para erro 403 atingido. Apagando QR code e parando...');
                        await clearAuthDir(authDir);
                        await clearAuthBackup();
                        console.log('🗑️ Autenticação removida. Reinicie o bot para gerar um novo QR code.');
                        process.exit(1);
                    }


                    console.log('🔄 Tentando reconectar em 5 segundos...');
                    if (reconnectTimer) {
                        clearTimeout(reconnectTimer);
                    }
                    reconnectTimer = setTimeout(() => {
                        startNazu();
                    }, 5000);
                    return;
                }


                forbidden403Attempts = 0;

                if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut) {
                    await clearAuthDir(authDir);
                    await clearAuthBackup();
                    console.log('🔄 Nova autenticação será necessária na próxima inicialização.');
                }


                if (reason === DisconnectReason.connectionReplaced) {
                    console.log('⚠️ Conexão substituída por outra instância. Não reconectando para evitar conflito.');
                    return;
                }


                let reconnectDelay = 5000;
                if (reason === DisconnectReason.timedOut) {
                    reconnectDelay = 3000; 
                } else if (reason === DisconnectReason.connectionLost) {
                    reconnectDelay = 2000; 
                } else if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession) {
                    reconnectDelay = 10000; 
                }

                console.log(`🔄 Aguardando ${reconnectDelay / 1000} segundos antes de reconectar...`);


                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                }

                reconnectTimer = setTimeout(() => {
                    reconnectAttempts = 0; 
                    forbidden403Attempts = 0; 
                    startNazu();
                }, reconnectDelay);
            }
        });
        return ZuckerBotSock;
    } catch (err) {
        console.error(`❌ Erro ao criar socket do bot: ${err.message}`);
        throw err;
    }
}

async function startNazu() {

    if (isReconnecting) {
        console.log('⚠️ Reconexão já em andamento, ignorando chamada duplicada...');
        return;
    }

    isReconnecting = true;

    try {
        console.log('🚀 Iniciando ZuckerBot...');

        await panel.ensureActivated();
        await createBotSocket(AUTH_DIR);

    } catch (err) {
        reconnectAttempts++;
        console.error(`❌ Erro ao iniciar o bot (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}): ${err.message}`);


        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error(`❌ Máximo de tentativas de reconexão alcançado (${MAX_RECONNECT_ATTEMPTS}). Parando...`);
            process.exit(1);
        }

        if (err.message.includes('ENOSPC') || err.message.includes('ENOMEM')) {
            console.log('🧹 Tentando limpeza de emergência...');
            try {
                await performanceOptimizer.emergencyCleanup();
                console.log('✅ Limpeza de emergência concluída');
            } catch (cleanupErr) {
                console.error('❌ Falha na limpeza de emergência:', cleanupErr.message);
            }
        }


        const delay = Math.min(RECONNECT_DELAY_BASE * Math.pow(1.5, reconnectAttempts - 1), 60000);
        console.log(`🔄 Aguardando ${Math.round(delay / 1000)} segundos antes de tentar novamente...`);


        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
        }

        reconnectTimer = setTimeout(() => {
            startNazu();
        }, delay);
    } finally {

        isReconnecting = false;
    }
}

let shutdownStarted = false;
async function gracefulShutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const signalName = signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT';
    console.log(`📡 ${signalName} recebido, parando bot graciosamente...`);

    if (authBackupInterval) {
        clearInterval(authBackupInterval);
        authBackupInterval = null;
    }

    if (healthStatusInterval) {
        clearInterval(healthStatusInterval);
        healthStatusInterval = null;
    }


    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    isReconnecting = false;

    let shutdownTimeout;


    shutdownTimeout = setTimeout(() => {
        console.error('⚠️ Timeout de shutdown, forçando saída...');
        process.exit(1);
    }, 15000);

    try {
        // Não trava o encerramento caso uma cópia de autenticação esteja em andamento.
        try {
            await Promise.race([
                createAuthBackup('desligamento controlado'),
                new Promise(resolve => setTimeout(resolve, 5000))
            ]);
        } catch (backupError) {
            console.warn(`⚠️ Backup no desligamento não concluído: ${backupError.message}`);
        }

        try {
            const subBotManagerModule = await import('./utils/subBotManager.js');
            const subBotManager = subBotManagerModule.default ?? subBotManagerModule;
            await subBotManager.disconnectAllSubBots();
            console.log('✅ Sub-bots desconectados');
        } catch (error) {
            console.error('❌ Erro ao desconectar sub-bots:', error.message);
        }


        if (cacheCleanupInterval) {
            clearInterval(cacheCleanupInterval);
            cacheCleanupInterval = null;
        }


        await messageQueue.shutdown();
        console.log('✅ MessageQueue finalizado');


        await performanceOptimizer.shutdown();
        console.log('✅ Performance optimizer finalizado');

        clearTimeout(shutdownTimeout);
        console.log('✅ Desligamento concluído');
        process.exit(0);
    } catch (error) {
        console.error('❌ Erro durante desligamento:', error.message);
        clearTimeout(shutdownTimeout);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', async (error) => {
    const errorName = error?.name || 'Error';
    console.error(`ZUCKER_FATAL_ERROR:${errorName}`);

    if (error?.message?.includes('ENOSPC') || error?.message?.includes('ENOMEM')) {
        try {
            await performanceOptimizer.emergencyCleanup();
        } catch {
            // A falha de limpeza não deve impedir a tentativa de reinicialização.
        }
    }

    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Promise rejeitada sem tratamento:', reason);

});

export { messageQueue };

startNazu();
