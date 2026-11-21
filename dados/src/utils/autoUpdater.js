import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import axios from 'axios';

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 150 * 1024 * 1024;
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const RESTART_EXIT_CODE = 75;

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);

  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error('ZIP inválido: diretório central não encontrado.');
}

function safeArchiveName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name)
  ) {
    throw new Error('O pacote contém um caminho inválido.');
  }

  const clean = name.replace(/\/+$/, '');
  const parts = clean.split('/');

  if (
    !clean ||
    parts.some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('O pacote contém tentativa de sair da pasta do bot.');
  }

  return clean;
}

function isAllowedUpdatePath(relativePath) {
  if (
    relativePath === 'package.json' ||
    relativePath === 'package-lock.json' ||
    relativePath === 'README.md' ||
    relativePath === 'zucker-update.json'
  ) {
    return true;
  }

  if (!relativePath.startsWith('dados/src/')) {
    return false;
  }

  if (
    relativePath === 'dados/src/config.json' ||
    relativePath.startsWith('dados/src/database/') ||
    relativePath.startsWith('dados/src/midias/') ||
    relativePath.startsWith('dados/src/.env')
  ) {
    return false;
  }

  return true;
}

function parseZipDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('Formato ZIP multidisco ou ZIP64 não é suportado.');
  }

  if (totalEntries > MAX_ENTRIES) {
    throw new Error('O pacote contém arquivos demais.');
  }

  if (centralOffset + centralSize > eocd) {
    throw new Error('Diretório central do ZIP está corrompido.');
  }

  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new Error('Entrada inválida no diretório central do ZIP.');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);

    const end = offset + 46 + nameLength + extraLength + commentLength;

    if (end > buffer.length) {
      throw new Error('Nome de arquivo inválido no ZIP.');
    }

    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    const isDirectory = name.endsWith('/');
    const cleanName = safeArchiveName(name);

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0xf000;

    if (fileType === 0xa000) {
      throw new Error('O pacote contém link simbólico, operação bloqueada.');
    }

    if (flags & 0x0001) {
      throw new Error('O pacote ZIP está criptografado e não pode ser instalado.');
    }

    if (![0, 8].includes(method)) {
      throw new Error('O pacote usa um método de compactação não suportado.');
    }

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      uncompressedSize > MAX_FILE_SIZE
    ) {
      throw new Error('O pacote contém arquivo grande ou formato ZIP64.');
    }

    entries.push({
      name: cleanName,
      isDirectory,
      flags,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset
    });

    offset = end;
  }

  return entries;
}

function extractEntry(buffer, entry) {
  const offset = entry.localOffset;

  if (
    offset + 30 > buffer.length ||
    buffer.readUInt32LE(offset) !== 0x04034b50
  ) {
    throw new Error(`Cabeçalho inválido para ${entry.name}.`);
  }

  const localNameLength = buffer.readUInt16LE(offset + 26);
  const localExtraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;

  if (dataEnd > buffer.length) {
    throw new Error(`Dados incompletos para ${entry.name}.`);
  }

  const compressed = buffer.subarray(dataOffset, dataEnd);

  const output = entry.method === 0
    ? Buffer.from(compressed)
    : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_SIZE });

  if (
    output.length !== entry.uncompressedSize ||
    crc32(output) !== entry.expectedCrc
  ) {
    throw new Error(`Falha na verificação de integridade de ${entry.name}.`);
  }

  return output;
}

function getProjectRelativeNames(entries) {
  const files = entries.filter(entry => !entry.isDirectory);
  if (!files.length) throw new Error('O ZIP não contém arquivos.');

  // Pacotes publicados podem conter uma pasta-raiz (ex.:
  // zuckerbot-update-10.3.3/) e um README.md solto na raiz do ZIP.
  // O README solto não deve impedir a identificação da pasta do projeto,
  // caso contrário package.json e dados/src/* ficam com um prefixo extra
  // e o instalador não encontra a raiz do bot.
  const packageEntries = files.filter(entry =>
    /(^|\/)package\.json$/i.test(entry.name)
  );

  if (packageEntries.length !== 1) {
    throw new Error('O pacote deve conter exatamente um package.json.');
  }

  const packageName = packageEntries[0].name;
  const rootPrefix = packageName.slice(0, packageName.lastIndexOf('/') + 1);

  if (rootPrefix) {
    const nestedFiles = files.filter(entry => entry.name.startsWith(rootPrefix));
    const strayFiles = files.filter(entry => !entry.name.startsWith(rootPrefix));
    const onlyHarmlessRootFiles = strayFiles.every(entry =>
      entry.name === 'README.md' || entry.name === 'LICENSE' || entry.name === 'LICENSE.md'
    );

    if (nestedFiles.length && nestedFiles.length + strayFiles.length === files.length && onlyHarmlessRootFiles) {
      return files.map(entry => ({
        entry,
        relativePath: entry.name.startsWith(rootPrefix)
          ? entry.name.slice(rootPrefix.length)
          : entry.name
      }));
    }
  }

  return files.map(entry => ({ entry, relativePath: entry.name }));
}

function compareDependencies(before, after) {
  const keys = ['dependencies', 'devDependencies', 'optionalDependencies'];
  return keys.some(key =>
    JSON.stringify(before?.[key] || {}) !== JSON.stringify(after?.[key] || {})
  );
}

function runNpmInstall(root) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env
    });

    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`npm install terminou com código ${code}.`));
    });
  });
}

async function copyFileIfExists(source, destination) {
  try {
    await fs.access(source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const TRANSACTION_FILE = '.zucker-update-transaction.json';

function resolveSafeProjectPath(root, relativePath) {
  if (!isAllowedUpdatePath(relativePath)) {
    throw new Error(`Caminho não permitido no diário de atualização: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Caminho de recuperação fora da pasta do bot.');
  }
  return resolved;
}

async function writeTransaction(root, transaction) {
  const file = path.join(root, TRANSACTION_FILE);
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(transaction, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function restoreTransaction(root, transaction) {
  if (!transaction || typeof transaction !== 'object') {
    throw new Error('Diário de atualização inválido.');
  }
  const backupName = String(transaction.backupDir || '');
  if (!/^\.zucker-update-backup-\d+$/.test(backupName)) {
    throw new Error('Nome do backup de recuperação inválido.');
  }
  if (!Array.isArray(transaction.entries) || transaction.entries.length > MAX_ENTRIES) {
    throw new Error('Lista de recuperação inválida.');
  }

  const backupRoot = path.join(path.resolve(root), backupName);
  const failures = [];
  for (const item of [...transaction.entries].reverse()) {
    try {
      const relativePath = String(item?.relativePath || '');
      const destination = resolveSafeProjectPath(root, relativePath);
      const backupPath = path.resolve(backupRoot, ...relativePath.split('/'));
      if (!backupPath.startsWith(`${backupRoot}${path.sep}`)) {
        throw new Error('Caminho de backup inválido.');
      }

      if (item.existed === true) {
        await fs.access(backupPath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(backupPath, destination);
      } else if (item.existed === false) {
        await fs.rm(destination, { force: true });
      } else {
        throw new Error('Indicador de existência inválido.');
      }
    } catch (error) {
      failures.push(`${item?.relativePath || 'arquivo desconhecido'}: ${error.message}`);
    }
  }

  if (failures.length) {
    throw new Error(`Recuperação incompleta: ${failures.join(' | ')}`);
  }

  if (transaction.dependencyChange === true) {
    await runNpmInstall(root);
  }
}

async function cleanOldBackups(root, keepBackupName) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const backups = entries.filter(entry =>
    entry.isDirectory() && /^\.zucker-update-backup-\d+$/.test(entry.name)
  );
  for (const backup of backups) {
    if (backup.name === keepBackupName) continue;
    await fs.rm(path.join(root, backup.name), { recursive: true, force: true });
  }
}

export async function recoverInterruptedUpdate(root = process.cwd()) {
  const markerPath = path.join(path.resolve(root), TRANSACTION_FILE);
  let transaction;
  try {
    transaction = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Compatibilidade com agentes antigos, cujo instalador não criava diário:
      // ao iniciar normalmente após uma atualização bem-sucedida, conserva o
      // backup mais recente (versão imediatamente anterior) e remove os demais.
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      const backups = entries
        .filter(entry => entry.isDirectory() && /^\.zucker-update-backup-\d+$/.test(entry.name))
        .sort((a, b) => Number(b.name.split('-').pop()) - Number(a.name.split('-').pop()));
      for (const backup of backups.slice(1)) {
        await fs.rm(path.join(root, backup.name), { recursive: true, force: true });
      }
      return { recovered: false, retainedBackup: backups[0]?.name || null };
    }
    throw new Error(`Não foi possível ler o diário de atualização: ${error.message}`);
  }

  console.warn('[ZuckerBots] Atualização interrompida detectada. Restaurando a versão anterior...');
  await restoreTransaction(root, transaction);
  await fs.rm(markerPath, { force: true });
  console.warn('[ZuckerBots] Recuperação da versão anterior concluída. O backup foi preservado.');
  return { recovered: true, version: transaction.version || null };
}


async function downloadUpdateArchive(downloadUrl) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 240000,
        maxContentLength: MAX_ARCHIVE_SIZE,
        maxBodyLength: MAX_ARCHIVE_SIZE,
        validateStatus: status => status >= 200 && status < 300,
        headers: { 'Accept': 'application/zip, application/octet-stream' }
      });
      return Buffer.from(response.data);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (status && status < 500 && status !== 429) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1800));
    }
  }

  const detail = lastError?.response?.status
    ? `HTTP ${lastError.response.status}`
    : (lastError?.code || lastError?.message || 'erro de rede desconhecido');
  throw new Error(`Não foi possível baixar a atualização após 3 tentativas (${detail}). Verifique a internet do Termux e tente novamente.`);
}

export async function installUpdatePackage(release) {
  const root = process.cwd();

  if (!release || typeof release !== 'object') {
    throw new Error('Dados da atualização ausentes.');
  }

  const version = String(release.version || '');
  const downloadUrl = String(release.downloadUrl || '');
  const expectedHash = String(release.sha256 || '').toLowerCase();
  const expectedSize = Number(release.packageSize);

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Versão recebida do painel é inválida.');
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(downloadUrl);
  } catch {
    throw new Error('Endereço de download inválido.');
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'khkjlodngoahevxkxswj.supabase.co'
  ) {
    throw new Error('O endereço de download não pertence ao Supabase oficial.');
  }

  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('Hash SHA-256 da atualização inválido.');
  }

  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > MAX_ARCHIVE_SIZE
  ) {
    throw new Error('Tamanho do pacote de atualização inválido.');
  }

  const currentPackagePath = path.join(root, 'package.json');
  const currentPackage = JSON.parse(
    await fs.readFile(currentPackagePath, 'utf8')
  );

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'zuckerbots-update-')
  );

  const archivePath = path.join(tempDir, 'release.zip');
  const stageDir = path.join(tempDir, 'stage');
  const backupDir = path.join(
    root,
    `.zucker-update-backup-${Date.now()}`
  );

  const backups = [];
  const transactionPath = path.join(root, TRANSACTION_FILE);
  let updateApplied = false;
  let transactionWritten = false;
  let dependencyChange = false;

  try {
    console.log(`[ZuckerBots] Baixando atualização ${version}...`);

    const archive = await downloadUpdateArchive(downloadUrl);

    if (archive.length !== expectedSize) {
      throw new Error('O tamanho do ZIP não corresponde ao publicado no ADM.');
    }

    const actualHash = crypto
      .createHash('sha256')
      .update(archive)
      .digest('hex');

    if (actualHash !== expectedHash) {
      throw new Error('SHA-256 não confere. A atualização foi cancelada.');
    }

    await fs.writeFile(archivePath, archive);

    const entries = parseZipDirectory(archive);
    const files = getProjectRelativeNames(entries);
    let totalUncompressed = 0;
    const stagedFiles = [];
    const seen = new Set();

    for (const item of files) {
      const relativePath = item.relativePath;

      if (!relativePath) continue;

      const normalized = path.posix.normalize(relativePath);

      if (
        normalized.startsWith('../') ||
        normalized === '..' ||
        normalized.startsWith('/') ||
        normalized.includes('\\')
      ) {
        throw new Error('O pacote contém caminho fora da pasta do bot.');
      }

      if (!isAllowedUpdatePath(normalized)) continue;

      if (seen.has(normalized)) {
        throw new Error(`Arquivo duplicado no pacote: ${normalized}`);
      }

      seen.add(normalized);
      totalUncompressed += item.entry.uncompressedSize;

      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error('O tamanho descompactado do pacote excede o limite.');
      }

      const contents = extractEntry(archive, item.entry);
      const stagePath = path.join(stageDir, ...normalized.split('/'));

      await fs.mkdir(path.dirname(stagePath), { recursive: true });
      await fs.writeFile(stagePath, contents);

      stagedFiles.push({
        relativePath: normalized,
        stagePath
      });
    }

    if (!stagedFiles.some(file => file.relativePath === 'package.json')) {
      throw new Error('O pacote não contém package.json na raiz.');
    }

    const stagedPackagePath = path.join(stageDir, 'package.json');
    const nextPackage = JSON.parse(
      await fs.readFile(stagedPackagePath, 'utf8')
    );

    if (nextPackage.version !== version) {
      throw new Error('A versão do package.json não corresponde à versão publicada.');
    }

    const manifestPath = path.join(stageDir, 'zucker-update.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (
        manifest.schemaVersion !== 1 ||
        manifest.version !== version ||
        manifest.entrypoint !== 'dados/src/connect.js'
      ) {
        throw new Error('Manifesto de atualização incompatível com a versão publicada.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // ZIPs antigos seguem aceitos para compatibilidade com os releases já publicados.
    }

    dependencyChange = compareDependencies(currentPackage, nextPackage);

    await fs.mkdir(backupDir, { recursive: true });

    // Faz cópias dos arquivos atuais antes de qualquer substituição.
    // O diário permite reverter mesmo se o processo ou o telefone for encerrado abruptamente.
    for (const file of stagedFiles) {
      const destination = path.join(root, ...file.relativePath.split('/'));
      const backupPath = path.join(backupDir, ...file.relativePath.split('/'));
      const existed = await copyFileIfExists(destination, backupPath);
      backups.push({
        destination,
        backupPath,
        existed,
        relativePath: file.relativePath
      });
    }

    const transaction = {
      schemaVersion: 1,
      version,
      backupDir: path.basename(backupDir),
      dependencyChange,
      createdAt: new Date().toISOString(),
      entries: backups.map(item => ({
        relativePath: item.relativePath,
        existed: item.existed
      }))
    };
    await writeTransaction(root, transaction);
    transactionWritten = true;

    for (const file of stagedFiles) {
      const destination = path.join(root, ...file.relativePath.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(file.stagePath, destination);
      updateApplied = true;
    }

    if (dependencyChange) {
      console.log('[ZuckerBots] Dependências alteradas. Instalando pacotes...');
      await runNpmInstall(root);
    }

    const installedPackage = JSON.parse(await fs.readFile(currentPackagePath, 'utf8'));
    if (installedPackage.version !== version) {
      throw new Error('Verificação final falhou: a versão instalada não corresponde ao pacote.');
    }

    // A versão está validada: remove o diário e só então descarta backups mais antigos.
    await fs.rm(transactionPath, { force: true });
    transactionWritten = false;
    try {
      await cleanOldBackups(root, path.basename(backupDir));
    } catch (cleanupError) {
      console.error(`[ZuckerBots] Atualização instalada, mas não foi possível limpar backups antigos: ${cleanupError.message}`);
    }

    console.log(`[ZuckerBots] Atualização ${version} instalada com sucesso.`);
    console.log('[ZuckerBots] Backup da versão anterior preservado.');
    console.log('[ZuckerBots] Reiniciando o processo para carregar os arquivos novos...');

    return {
      success: true,
      version,
      backupDir: path.basename(backupDir),
      restartExitCode: RESTART_EXIT_CODE
    };

  } catch (error) {
    if (transactionWritten) {
      console.error('[ZuckerBots] Falha ao aplicar atualização. Restaurando backup...');
      try {
        const transaction = JSON.parse(await fs.readFile(transactionPath, 'utf8'));
        await restoreTransaction(root, transaction);
        await fs.rm(transactionPath, { force: true });
        transactionWritten = false;
        console.error('[ZuckerBots] Versão anterior restaurada. Backup preservado para recuperação manual.');
      } catch (restoreError) {
        console.error(`[ZuckerBots] Restauração automática incompleta: ${restoreError.message}`);
        console.error('[ZuckerBots] O diário e o backup foram mantidos para nova recuperação na inicialização.');
      }
    } else if (!updateApplied) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }

    throw error;

  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default installUpdatePackage;
