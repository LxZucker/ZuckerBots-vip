
import fs from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { downloadMediaMessage } from "baileys";
import { panel } from "./zucker-panel.js";
import { isExcludedWhatsAppSender } from "./utils/phoneNumbers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readBotVersion() {
  try {
    const packagePath = path.join(__dirname, "../../package.json");
    const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return String(packageData.version || "desconhecida");
  } catch (error) {
    console.error("[ZuckerBots] Não foi possível ler a versão instalada:", error.message);
    return "desconhecida";
  }
}

const BOT_VERSION = readBotVersion();

const commandsPath = path.join(__dirname, "../database/dono/customCommands.json");
const slotsPath = path.join(__dirname, "../database/dono/customCommandSlots.json");
const mediaDir = path.join(__dirname, "../database/dono/customCommandMedia");

const gpCommandsPath = path.join(__dirname, "../database/dono/customCommandsGP.json");
const gpSlotsPath = path.join(__dirname, "../database/dono/customCommandSlotsGP.json");
const gpMediaDir = path.join(__dirname, "../database/dono/customCommandMediaGP");

// Arquivos exclusivos da divulgação.
const divulgacaoSlotsPath = path.join(
  __dirname,
  "../database/dono/divulgacaoSlots.json"
);

const divulgacaoMediaDir = path.join(
  __dirname,
  "../database/dono/divulgacaoMedia"
);

// Cooldown persistente da resposta automática (um por conversa PV).
const autoReplyCooldownsPath = path.join(
  __dirname,
  "../database/dono/autoReplyCooldowns.json"
);

const cooldowns = new Map();
// Estado persistente do modo ausente.
const absentModePath = path.join(
  __dirname,
  "../database/dono/absentMode.json"
);

let absentMode = false;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Baileys mantém o estado real do WebSocket em socket.ws.isOpen.
// A propriedade socket.user, sozinha, continua preenchida mesmo após uma queda.
function isWhatsAppSocketOpen(socket) {
  return Boolean(socket?.user && socket?.ws?.isOpen === true);
}

function isConnectionClosedError(error) {
  const message = String(error?.message || error || "");
  return /connection\s+(?:closed|lost)|websocket.*(?:closed|not open)|socket.*(?:closed|not open)/i.test(message);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
// Recupera o modo ausente após reinicializações.
absentMode = readJson(absentModePath, { enabled: false }).enabled === true;

function unwrapMessage(msg) {
  let current = msg;

  while (
    current?.ephemeralMessage?.message ||
    current?.viewOnceMessage?.message ||
    current?.viewOnceMessageV2?.message
  ) {
    current =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message;
  }

  return current || {};
}

function getText(message) {
  const msg = unwrapMessage(message);

  const type = Object.keys(msg).find(
    key => key !== "messageContextInfo"
  );

  const content = type ? msg[type] : {};

  return {
    message: msg,
    text: String(
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      content?.caption ||
      msg.buttonsResponseMessage?.selectedButtonId ||
      msg.templateButtonReplyMessage?.selectedId ||
      msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
      ""
    ).trimStart()
  };
}

function getMedia(message) {
  const msg = unwrapMessage(message);

  const mediaTypes = [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "stickerMessage",
    "documentMessage"
  ];

  for (const type of mediaTypes) {
    if (msg[type]) {
      return {
        type: type.replace("Message", ""),
        content: msg[type],
        message: msg
      };
    }
  }

  return null;
}

function getExtension(media) {
  const mime = String(media.mimetype || "").toLowerCase();

  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf"
  };

  if (extensions[mime]) return extensions[mime];

  const original = path.extname(media.fileName || "");
  return original || ".bin";
}

async function saveMedia(
  message,
  from,
  messageId,
  participant,
  targetMediaDir = mediaDir
) {
  const media = getMedia(message);

  if (!media) return null;

  const messageToDownload = {
    key: {
      remoteJid: from,
      id: messageId || "quoted-media",
      participant: participant || undefined
    },
    message: media.message
  };

  const buffer = await downloadMediaMessage(
    messageToDownload,
    "buffer",
    {}
  );

  if (!buffer || buffer.length === 0) {
    throw new Error("A mídia foi baixada vazia.");
  }

  fs.mkdirSync(targetMediaDir, { recursive: true });

  const filename =
    `${Date.now()}_${Math.random().toString(36).slice(2, 9)}` +
    getExtension(media.content);

  const filePath = path.join(targetMediaDir, filename);

  fs.writeFileSync(filePath, buffer);

  return {
    kind: "media",
    mediaType: media.type,
    filename,
    mimetype: media.content.mimetype || "application/octet-stream",
    originalName: media.content.fileName || "",
    caption: media.content.caption || "",
    filePath
  };
}

async function sendStoredContent(socket, from, stored, info) {
  const sendOptions = info ? { quoted: info } : undefined;

  if (typeof stored === "string") {
    await socket.sendMessage(
      from,
      { text: stored },
      sendOptions
    );
    return;
  }

  if (!stored || stored.kind !== "media") {
    throw new Error("Espaço sem conteúdo válido; envio ignorado.");
  }

  if (!stored.filePath || !fs.existsSync(stored.filePath)) {
    throw new Error("Arquivo de mídia não encontrado; envio ignorado.");
  }

  const buffer = fs.readFileSync(stored.filePath);
  const caption = stored.caption || "";

  let content;

  switch (stored.mediaType) {
    case "image":
      content = { image: buffer, caption };
      break;

    case "video":
      content = { video: buffer, caption };
      break;

    case "audio":
      content = {
        audio: buffer,
        mimetype: stored.mimetype || "audio/mpeg",
        ptt: false
      };
      break;

    case "sticker":
      content = { sticker: buffer };
      break;

    case "document":
      content = {
        document: buffer,
        mimetype: stored.mimetype || "application/octet-stream",
        fileName: stored.originalName || stored.filename
      };
      break;

    default:
      await socket.sendMessage(from, {
        text: "Esse tipo de mídia ainda não é suportado."
      });
      return;
  }

  await socket.sendMessage(from, content, sendOptions);
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeWhatsAppJid(value) {
  const jid = String(value || "").trim().toLowerCase();
  if (!jid.includes("@")) return "";

  const [user, server] = jid.split("@");
  if (!user || !server) return "";

  // Remove o identificador de dispositivo (ex.: 5511...:27@s.whatsapp.net).
  return `${user.split(":")[0]}@${server}`;
}

function phoneNumberFromWhatsAppId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const user = raw.includes("@") ? raw.split("@")[0] : raw;
  return digits(user.split(":")[0]);
}

function isOwner(sender, info = null) {
  const owner = digits(panel.ownerNumber);
  const ownerLid = normalizeWhatsAppJid(panel.ownerLid);

  // Em grupos, o WhatsApp pode entregar o participante como LID.
  // O connect.js mantém o LID correspondente ao número atual do Dono.
  const candidates = [
    sender,
    info?.participant,
    info?.participantAlt,
    info?.senderPn,
    info?.key?.remoteJidAlt,
    info?.key?.participant,
    info?.key?.participantAlt,
    info?.key?.senderPn,
    info?.key?.participantPn,
    info?.key?.senderLid,
    info?.key?.participantLid
  ];

  return candidates.some(value => {
    const candidateJid = normalizeWhatsAppJid(value);
    if (ownerLid && candidateJid === ownerLid) return true;

    const candidateNumber = phoneNumberFromWhatsAppId(value);
    return Boolean(
      owner &&
      candidateNumber.length >= 10 &&
      candidateNumber === owner
    );
  });
}

// Processa os comandos exclusivos da divulgação.
async function processDivulgacaoCommand(socket, info, from) {
  if (!from.endsWith("@g.us")) return false;

  const { message, text } = getText(info.message);
  const prefix = panel.commandPrefix;

  if (!prefix || !text.startsWith(prefix)) return false;

  const commandText = text.slice(prefix.length).trim();
  if (!commandText) return false;

  const command = commandText.split(/\s+/)[0].toLowerCase();

  const commands = Array.isArray(panel.divulgacaoCommands)
    ? panel.divulgacaoCommands
    : [];

  const customCommand = commands.find(item => {
    const savedCommand = String(
      item.command || item.name || item.commandName || ""
    )
      .trim()
      .replace(/^#+/, "")
      .toLowerCase();

    return savedCommand === command;
  });

  if (!customCommand) return false;

  const sender = info.key.participant || info.participant || "";
  const owner = Boolean(info.key.fromMe) || isOwner(sender, info);

  if (!owner) {
    await socket.sendMessage(from, {
      text: "Somente o dono pode guardar conteúdos da divulgação."
    });
    return true;
  }

  const slot = String(
    customCommand.slot ?? customCommand.slotId ?? ""
  );

  if (!["1", "2", "3"].includes(slot)) {
    await socket.sendMessage(from, {
      text: "Esse comando está vinculado a um espaço inválido."
    });
    return true;
  }

  const args = commandText.split(/\s+/).slice(1);
  const argumentText = args.join(" ");

  const context = message?.extendedTextMessage?.contextInfo;
  const quoted = context?.quotedMessage;

  if (!quoted) {
    await socket.sendMessage(from, {
      text: "Responda à mensagem que deseja guardar usando esse comando."
    });
    return true;
  }

  const quotedText = getText(quoted).text;
  const quotedMedia = getMedia(quoted);

  const slots = readJson(divulgacaoSlotsPath, {});
  const previous = slots[slot];

  let newContent;

  if (quotedMedia) {
    newContent = await saveMedia(
      quoted,
      from,
      context?.stanzaId,
      context?.participant,
      divulgacaoMediaDir
    );

    if (!newContent) {
      throw new Error("Não foi possível salvar a mídia.");
    }

    newContent.caption =
      quotedText || argumentText || newContent.caption || "";

  } else if (quotedText || argumentText) {
    newContent = quotedText || argumentText;

  } else {
    await socket.sendMessage(from, {
      text: "Não consegui identificar texto ou mídia nessa mensagem."
    });
    return true;
  }

  // Salva o novo conteúdo antes de remover a mídia antiga.
  slots[slot] = newContent;
  writeJson(divulgacaoSlotsPath, slots);

  if (
    previous &&
    typeof previous === "object" &&
    previous.kind === "media" &&
    previous.filePath &&
    previous.filePath !== newContent?.filePath
  ) {
    try {
      fs.unlinkSync(previous.filePath);
    } catch {}
  }

  await socket.sendMessage(from, {
    text: `✅ Conteúdo guardado com sucesso no espaço ${slot}!`
  });

  console.log(`[DIVULGAÇÃO] Conteúdo salvo no espaço ${slot}.`);

  return true;
}

// ======================================================
// AGENDADOR AUTOMÁTICO DA DIVULGAÇÃO
// ======================================================

let divulgacaoSocket = null;
let divulgacaoTimer = null;
let divulgacaoRunning = false;

const divulgacaoLastRuns = new Map();

async function executarDivulgacao() {
  if (divulgacaoRunning) return;
  if (absentMode) return;
  if (!panel.canRunFeatures()) return;
  if (panel.divulgacaoEnabled !== true) return;

  // Não inicia uma execução usando um socket que já perdeu a conexão.
  const activeSocket = divulgacaoSocket;
  if (!isWhatsAppSocketOpen(activeSocket)) return;

  divulgacaoRunning = true;

  try {
    const sections = Array.isArray(panel.divulgacaoConfig?.sections)
      ? panel.divulgacaoConfig.sections
      : [];

    const slots = readJson(divulgacaoSlotsPath, {});
    const now = Date.now();
    // Um grupo só pode participar de uma sessão por ciclo do agendador.
    // Isso evita disparos duplicados quando o mesmo grupo foi marcado em sessões diferentes.
    const groupsClaimedThisCycle = new Set();

    for (let index = 0; index < sections.length; index++) {
      if (!panel.canRunFeatures()) {
        console.warn("[DIVULGAÇÃO] Execução interrompida: acesso não autorizado ou validação vencida.");
        break;
      }
      const section = sections[index];

      if (section.enabled !== true) continue;

      const intervalMinutes = Number(section.intervalMinutes);

      if (
        !Number.isFinite(intervalMinutes) ||
        intervalMinutes <= 0
      ) {
        continue;
      }

      const sectionId = String(section.id ?? index + 1);
      const intervalMs = intervalMinutes * 60 * 1000;

      if (!divulgacaoLastRuns.has(sectionId)) {
        divulgacaoLastRuns.set(sectionId, now);
        continue;
      }

      const lastRun = divulgacaoLastRuns.get(sectionId);

      if (now - lastRun < intervalMs) continue;

      const selectedSlots = Array.isArray(section.slots)
        ? [...new Set(section.slots.map(String))]
        : [];

      const selectedGroups = Array.isArray(section.groups)
        ? [...new Set(section.groups.map(String))]
        : Array.isArray(section.selectedGroups)
          ? [...new Set(section.selectedGroups.map(String))]
          : [];

      const groups = [...new Set(selectedGroups)]
        .filter(group => group.endsWith("@g.us"));

      if (!selectedSlots.length || !groups.length) continue;

      // Valida cada espaço individualmente. Um espaço vazio ou com mídia perdida
      // nunca deve gerar mensagem no grupo nem bloquear os outros espaços válidos.
      const availableSlots = [];
      const emptySlots = [];
      let repairedSlotPaths = false;

      for (const slot of selectedSlots) {
        if (!["1", "2", "3"].includes(slot)) continue;
        const stored = slots[slot];

        if (typeof stored === "string" && stored.trim()) {
          availableSlots.push(slot);
          continue;
        }

        if (stored && typeof stored === "object" && stored.kind === "media") {
          let mediaPath = typeof stored.filePath === "string" ? stored.filePath : "";
          if (!mediaPath || !fs.existsSync(mediaPath)) {
            const filename = path.basename(String(stored.filename || ""));
            const fallbackPath = filename ? path.join(divulgacaoMediaDir, filename) : "";
            if (fallbackPath && fs.existsSync(fallbackPath)) {
              stored.filePath = fallbackPath;
              mediaPath = fallbackPath;
              repairedSlotPaths = true;
            }
          }

          const supportedMedia = ["image", "video", "audio", "sticker", "document"].includes(stored.mediaType);
          if (mediaPath && fs.existsSync(mediaPath) && supportedMedia) {
            availableSlots.push(slot);
            continue;
          }
        }

        emptySlots.push(slot);
      }

      if (repairedSlotPaths) writeJson(divulgacaoSlotsPath, slots);

      if (emptySlots.length) {
        const ownerNumber = digits(panel.ownerNumber);
        const ownerJid = ownerNumber ? `${ownerNumber}@s.whatsapp.net` : normalizeWhatsAppJid(panel.ownerLid);
        const slotList = emptySlots.map(slot => `Espaço ${slot}`).join(", ");
        const alertText = [
          "⚠️ *AVISO NA SESSÃO DE DIVULGAÇÃO*",
          `Sessão: ${sectionId}`,
          `Não foi encontrado conteúdo válido em: ${slotList}.`,
          availableSlots.length
            ? `Os espaços válidos (${availableSlots.map(slot => `Espaço ${slot}`).join(", ")}) serão enviados normalmente.`
            : "Nenhum conteúdo será enviado aos grupos nesta execução.",
          "Confira e salve novamente o conteúdo dos espaços indicados."
        ].join("\n");

        if (ownerJid && isWhatsAppSocketOpen(activeSocket)) {
          try {
            await activeSocket.sendMessage(ownerJid, { text: alertText });
            console.log(`[DIVULGAÇÃO] Aviso dos espaços sem conteúdo enviado ao dono (${ownerNumber || ownerJid}).`);
          } catch (notifyError) {
            console.error(`[DIVULGAÇÃO] Falha ao enviar aviso privado ao dono (${ownerJid}):`, notifyError.message);
          }
        } else {
          console.error(`[DIVULGAÇÃO] Não foi possível avisar o dono: JID indisponível ou WhatsApp desconectado. ownerNumber=${ownerNumber || "vazio"}`);
        }
      }

      if (!availableSlots.length) {
        divulgacaoLastRuns.set(sectionId, Date.now());
        const runId = randomUUID();
        const startedAt = new Date().toISOString();
        const endedAt = new Date().toISOString();
        await panel.reportDivulgacaoRun({
          runId,
          sectionId,
          startedAt,
          endedAt,
          status: "error",
          sentCount: 0,
          failedCount: 0,
          errorReason: `Nenhum conteúdo válido nos espaços selecionados: ${emptySlots.map(slot => `Espaço ${slot}`).join(", ")}. Nenhum grupo recebeu mensagem.`
        });
        console.warn(`[DIVULGAÇÃO] Sessão ${sectionId}: nenhum espaço válido; nenhum grupo recebeu mensagem.`);
        continue;
      }

      // Marca o início do ciclo antes dos envios.
      divulgacaoLastRuns.set(sectionId, Date.now());

      // Remove grupos que já foram atendidos por outra sessão neste mesmo ciclo.
      const uniqueGroups = groups.filter(group => !groupsClaimedThisCycle.has(group));
      for (const group of uniqueGroups) groupsClaimedThisCycle.add(group);

      if (!uniqueGroups.length) {
        console.log(`[DIVULGAÇÃO] Sessão ${sectionId}: grupos já atendidos por outra sessão; evitando duplicação.`);
        continue;
      }

      console.log(
        `[DIVULGAÇÃO] Iniciando sessão ${sectionId} (${uniqueGroups.length} grupos únicos).`
      );

      // Registra cada execução sem interferir no fluxo de envio existente.
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      await panel.reportDivulgacaoRun({
        runId,
        sectionId,
        startedAt,
        status: "running",
        sentCount: 0,
        failedCount: 0,
        errorReason: ""
      });
      // Intervalo mínimo conservador entre envios em qualquer modo.
      const sendDelayMs = 5000;
      let sentCount = 0;
      let failedCount = 0;
      let interrupted = false;
      let connectionLost = false;
      let interruptionReason = "";
      const failureReasons = [];

      for (const group of uniqueGroups) {
        if (absentMode) {
          interrupted = true;
          interruptionReason = "Divulgação pausada pelo modo ausente.";
          break;
        }

        if (!panel.canRunFeatures()) {
          interrupted = true;
          interruptionReason = "Execução interrompida: validação de acesso indisponível.";
          break;
        }
        if (!isWhatsAppSocketOpen(activeSocket)) {
          interrupted = true;
          connectionLost = true;
          interruptionReason = "Conexão WhatsApp fechada; os envios restantes foram pausados.";
          break;
        }

        for (const slot of availableSlots) {
          if (absentMode) {
            interrupted = true;
            interruptionReason = "Divulgação pausada pelo modo ausente.";
            break;
          }

          if (!panel.canRunFeatures()) {
            interrupted = true;
            interruptionReason = "Execução interrompida: validação de acesso indisponível.";
            break;
          }
          if (!isWhatsAppSocketOpen(activeSocket)) {
            interrupted = true;
            connectionLost = true;
            interruptionReason = "Conexão WhatsApp fechada; os envios restantes foram pausados.";
            break;
          }

          try {
            await sendStoredContent(activeSocket, group, slots[slot]);
            sentCount++;
            await sleep(sendDelayMs);
          } catch (error) {
            failedCount++;
            const rawReason = String(error?.message || error || "Falha desconhecida").slice(0, 350);
            let groupLabel = group;
            try {
              const metadata = await activeSocket.groupMetadata(group);
              if (metadata?.subject) groupLabel = `${metadata.subject} (${group})`;
            } catch {}
            const reason = `Grupo: ${groupLabel} | Motivo: ${rawReason}`.slice(0, 500);

            // Uma conexão fechada não será recuperada repetindo sendMessage no mesmo socket.
            if (isConnectionClosedError(error) || !isWhatsAppSocketOpen(activeSocket)) {
              interrupted = true;
              connectionLost = true;
              interruptionReason = "Conexão WhatsApp fechada durante a divulgação; a fila restante foi pausada.";
              if (failureReasons.length < 10) failureReasons.push(reason);
              console.warn(`[DIVULGAÇÃO] ${interruptionReason}`);
              break;
            }

            if (failureReasons.length < 10) failureReasons.push(reason);
            console.error(
              `[DIVULGAÇÃO] Erro no grupo ${group}, slot ${slot}:`,
              reason
            );
          }
        }
        if (interrupted) break;
      }

      const endedAt = new Date().toISOString();
      const errorReason = [
        interruptionReason,
        ...failureReasons
      ].filter(Boolean).join(" | ").slice(0, 3000);
      const runStatus = failedCount > 0 || interrupted ? "error" : "success";

      console.log(`[DIVULGAÇÃO] Sessão ${sectionId}: ${sentCount} envio(s) concluído(s), ${failedCount} falha(s).`);
      if (connectionLost) {
        console.warn("[DIVULGAÇÃO] A execução foi encerrada sem novas tentativas enquanto o WhatsApp estiver desconectado.");
      }
      await panel.reportDivulgacaoRun({
        runId,
        sectionId,
        startedAt,
        endedAt,
        status: runStatus,
        sentCount,
        failedCount,
        errorReason
      });

      console.log(`[DIVULGAÇÃO] Sessão ${sectionId} finalizada.`);
    }

  } catch (error) {
    console.error(
      "[DIVULGAÇÃO] Erro no agendador:",
      error.message
    );

  } finally {
    divulgacaoRunning = false;
  }
}

function iniciarAgendadorDivulgacao(socket) {
  divulgacaoSocket = socket;

  if (divulgacaoTimer) return;

  divulgacaoTimer = setInterval(() => {
    executarDivulgacao();
  }, 5000);

  console.log("[DIVULGAÇÃO] Agendador iniciado.");
}

// ======================================================
// CONFIGURAÇÕES PV E GP
// ======================================================

function getModeConfig(mode) {
  const gp = mode === "gp";

  return {
    enabled: gp ? panel.botGpEnabled : panel.botPvEnabled,
    commandsPath: gp ? gpCommandsPath : commandsPath,
    slotsPath: gp ? gpSlotsPath : slotsPath,
    mediaDir: gp ? gpMediaDir : mediaDir,
    unknownMessage: gp ? panel.gpUnknownMessage : panel.pvUnknownMessage,
    ownerCooldown: gp ? panel.gpOwnerCooldown : panel.pvOwnerCooldown,
    userCooldown: gp ? panel.gpUserCooldown : panel.pvUserCooldown,
    allGroups: panel.gpAllGroups,
    selectedGroups: panel.gpSelectedGroups || []
  };
}

function checkCooldown(mode, sender, owner, config) {
  const seconds = Math.max(
    1,
    Math.min(
      25,
      Number(owner ? config.ownerCooldown : config.userCooldown) || 1
    )
  );

  const key = `${mode}:${digits(sender) || sender}`;
  const now = Date.now();
  const expires = cooldowns.get(key) || 0;

  if (now < expires) {
    return Math.ceil((expires - now) / 1000);
  }

  cooldowns.set(key, now + seconds * 1000);
  return 0;
}

// ======================================================
// RESPOSTA AUTOMÁTICA (SOMENTE PV)
// ======================================================

async function processAutoReplyPV(socket, info, from, text) {
  // Nunca responde a mensagens próprias, grupos ou status.
  if (info?.key?.fromMe) return false;
  if (!from || from.endsWith("@g.us") || from === "status@broadcast") {
    return false;
  }

  const receivedText = String(text || "");

  // Comandos com prefixo continuam seguindo o fluxo normal do bot.
  const prefix = String(panel.commandPrefix || "");
  if (prefix && receivedText.startsWith(prefix)) return false;

  if (panel.autoReplyEnabled !== true) return false;

  if (isExcludedWhatsAppSender([
    from,
    info?.key?.remoteJidAlt,
    info?.key?.participant,
    info?.key?.participantAlt
  ], panel.autoReplyExcludedNumbers)) {
    return false;
  }

  const response = String(panel.autoReplyMessage || "").trim();
  if (!response) return false;

  const minutes = Number(panel.autoReplyCooldownMinutes);
  const cooldownMinutes = Number.isFinite(minutes)
    ? Math.max(1, Math.min(43200, Math.floor(minutes)))
    : 60;

  const now = Date.now();
  const cooldownsByChat = readJson(autoReplyCooldownsPath, {});

  // Remove registros vencidos e limita o arquivo para evitar crescimento infinito.
  for (const [jid, expiresAt] of Object.entries(cooldownsByChat)) {
    if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= now) {
      delete cooldownsByChat[jid];
    }
  }

  const nextAllowedAt = Number(cooldownsByChat[from] || 0);

  // Usa o horário original da mensagem para descartar mensagens que chegaram
  // durante o cooldown, mesmo se o processamento delas atrasar até depois dele.
  const rawTimestamp = info?.messageTimestamp;
  const timestampSeconds = Number(
    rawTimestamp?.toString ? rawTimestamp.toString() : rawTimestamp
  );
  const receivedAt =
    Number.isFinite(timestampSeconds) && timestampSeconds > 0
      ? timestampSeconds * 1000
      : now;

  // Não guarda nem agenda mensagens recebidas durante o período de espera.
  if (receivedAt < nextAllowedAt || now < nextAllowedAt) {
    return false;
  }

  // Reserva o cooldown antes do envio para impedir respostas duplicadas
  // quando chegam várias mensagens quase ao mesmo tempo.
  cooldownsByChat[from] = now + cooldownMinutes * 60 * 1000;

  const entries = Object.entries(cooldownsByChat);
  if (entries.length > 5000) {
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));
    const limited = Object.fromEntries(entries.slice(0, 5000));
    writeJson(autoReplyCooldownsPath, limited);
  } else {
    writeJson(autoReplyCooldownsPath, cooldownsByChat);
  }

  try {
    await socket.sendMessage(from, { text: response }, { quoted: info });
    return true;
  } catch (error) {
    // Se o envio falhar, libera o contato para tentar novamente.
    delete cooldownsByChat[from];
    writeJson(autoReplyCooldownsPath, cooldownsByChat);
    console.error("[RESPOSTA AUTOMÁTICA] Erro ao enviar:", error.message);
    return false;
  }
}

// ======================================================
// RECEBIMENTO DE MENSAGENS
// ======================================================

export default async function receiveWhatsAppMessage(
  socket,
  info,
  extra,
  messagesCache
) {
  try {
    if (!info?.key?.remoteJid || !info.message) return;

    // Inicia o agendador usando a conexão atual.
    iniciarAgendadorDivulgacao(socket);

    const from = info.key.remoteJid;
    const incomingTextForAdmin = getText(info.message).text.trim();

    // Comando de versão: usa o prefixo configurado no painel e só responde ao dono.
    // Para qualquer outro remetente, encerra silenciosamente sem enviar mensagem.
    const versionPrefix = String(panel.commandPrefix || "#");
    const versionMessage = String(incomingTextForAdmin || "").trimStart();
    if (versionPrefix && versionMessage.startsWith(versionPrefix)) {
      const versionCommandText = versionMessage.slice(versionPrefix.length).trim();
      if (/^vers[aã]o(?:\\s|$)/i.test(versionCommandText)) {
        const senderForVersion = info.key.participant || info.participant || from;
        const ownerCommand = Boolean(info.key.fromMe) || isOwner(senderForVersion, info);
        if (!ownerCommand) return;

        await socket.sendMessage(from, {
          text: `🤖 ZuckerBots\\n📦 Versão atual: ${BOT_VERSION}`
        }, { quoted: info });
        return;
      }
    }

    // Desligamento total solicitado pelo dono: encerra o processo Termux
    // usando o fluxo gracioso já existente em connect.js (SIGTERM).
    if (/^\/botoff(?:\s|$)/i.test(incomingTextForAdmin)) {
      const senderForAdmin = info.key.participant || from;
      const ownerCommand = Boolean(info.key.fromMe) || isOwner(senderForAdmin, info);
      if (!ownerCommand) {
        await socket.sendMessage(from, {
          text: "⛔ Somente o dono do bot pode desligá-lo."
        });
        return;
      }

      await socket.sendMessage(from, {
        text: "🛑 Comando /botoff recebido. O ZuckerBots está encerrando o Termux com segurança. Para ligar novamente, inicie o agente manualmente."
      });
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 1200);
      return;
    }

    writeJson(absentModePath, {
    

        // COMANDOS EXCLUSIVOS DO DONO: AUSENTE E ONLINE.
    const controlPrefix = String(panel.commandPrefix || "#");
    const isPrivateChat =
      !from.endsWith("@g.us") &&
      from !== "status@broadcast";

    if (
      isPrivateChat &&
      controlPrefix &&
      incomingTextForAdmin.startsWith(controlPrefix)
    ) {
      const controlCommand = incomingTextForAdmin
        .slice(controlPrefix.length)
        .trim()
        .toLowerCase();

      if (controlCommand === "ausente" || controlCommand === "online") {

        // Somente o dono cadastrado no painel.
        if (!isOwner(from, info)) return;

        if (controlCommand === "ausente") {
          if (absentMode) {
            await socket.sendMessage(from, {
              text: "💤 O modo ausente já está ativado."
            });
            return;
          }

          absentMode = true;

          writeJson(absentModePath, {
            enabled: true,
            updatedAt: new Date().toISOString()
          });

          await socket.sendMessage(from, {
            text: "💤 *MODO AUSENTE ATIVADO!*\n\nO bot continuará conectado e recebendo mensagens, mas não executará comandos nem enviará respostas automáticas. A divulgação também foi pausada.\n\nUse o comando online para reativar."
          });

          console.log("[ZuckerBots] Modo ausente ativado pelo dono.");
          return;
        }

        if (controlCommand === "online") {
          if (!absentMode) {
            await socket.sendMessage(from, {
              text: "🐲 O bot já está online! 🐲"
            });
            return;
          }

          absentMode = false;

          writeJson(absentModePath, {
            enabled: false,
            updatedAt: new Date().toISOString()
          });

          await socket.sendMessage(from, {
            text: "🐉 *ZUCKERBOT ONLINE NOVAMENTE!*\n\nOs comandos e as respostas automáticas foram reativados. A divulgação programada também voltou a funcionar."
          });

          console.log("[ZuckerBots] Modo ausente desativado pelo dono.");
          return;
        }
      }
    }

    // No modo ausente, ignora todas as outras mensagens.
    if (absentMode) return;

    // Verifica se o bot possui acesso para executar funcionalidades.
    if (!panel.canRunFeatures()) {
      const now = Date.now();

      if (
        !globalThis.__zuckerAccessNoticeAt ||
        now - globalThis.__zuckerAccessNoticeAt > 15000
      ) {
        globalThis.__zuckerAccessNoticeAt = now;
      }

      return;
  }

    const isGroup = from.endsWith("@g.us");
    const mode = isGroup ? "gp" : "pv";
    const config = getModeConfig(mode);
    // Registra a mensagem recebida no painel.
    try {
      panel.queueIncomingMessage(info);
    } catch (error) {
      console.error("[ZuckerBots] Erro no painel:", error.message);
    }

    // Divulgação é independente da ativação do BOT GP.
    if (isGroup) {
      const handled = await processDivulgacaoCommand(
        socket,
        info,
        from
      );

      if (handled) return;
    }

    // Resposta automática é independente da ativação dos comandos PV.
    // A função filtra grupos, mensagens próprias e comandos com prefixo.
    if (!isGroup && !info.key.fromMe) {
      const incomingText = getText(info.message).text;

await processAutoReplyPV(socket, info, from, incomingText);

    }

    // Mantém o funcionamento original dos modos PV e GP.
    if (!config.enabled) {
      const now = Date.now();
      if (!globalThis.__zuckerModeNoticeAt || now - globalThis.__zuckerModeNoticeAt > 15000) {
        globalThis.__zuckerModeNoticeAt = now;
      }
      return;
    }

    if (
      isGroup &&
      !config.allGroups &&
      !config.selectedGroups.includes(from)
    ) {
      return;
    }

    const { message, text } = getText(info.message);
    const prefix = String(panel.commandPrefix || "#");
    const commandMessage = String(text || "").trimStart();

    if (!commandMessage.startsWith(prefix)) {
      return;
    }

    const commandText = commandMessage.slice(prefix.length).trim();
    if (!commandText) return;

    const args = commandText.split(/\s+/);
    const command = args.shift().toLowerCase();
    const argumentText = args.join(" ");

    console.log(
      `[COMANDOS ${mode.toUpperCase()}] Comando identificado:`,
      command
    );

    if (command === "ping" || command === "p") {
      await socket.sendMessage(
        from,
        { text: "🏓 Pong! Bot funcionando!" },
        { quoted: info }
      );

      await panel.logCommand(command, "executed");
      return;
    }

    const commands = readJson(config.commandsPath, []);
    const slots = readJson(config.slotsPath, {});

    const customCommand = commands.find(
      item =>
        String(item.command || "")
          .trim()
          .replace(/^#+/, "")
          .toLowerCase() === command
    );

    if (!customCommand) {
      if (String(config.unknownMessage || "").trim()) {
        await socket.sendMessage(
          from,
          { text: String(config.unknownMessage) },
          { quoted: info }
        );
      }
      return;
    }

    const sender = isGroup
      ? (info.key.participant || info.participant || "")
      : from;

    const owner = Boolean(info.key.fromMe) || isOwner(sender, info);

    if (
      String(customCommand.permission || "all").toLowerCase() === "owner" &&
      !owner
    ) {
      return;
    }

    const waitSeconds = checkCooldown(mode, sender, owner, config);

    if (waitSeconds > 0) {
      await socket.sendMessage(
        from,
        { text: `⏳ Aguarde ${waitSeconds}s para usar outro comando.` },
        { quoted: info }
      );
      return;
    }

    if (customCommand.type === "reply") {
      const response = String(customCommand.response || "");

      const count = Math.max(
        1,
        Math.min(100, Math.floor(Number(customCommand.repeatCount) || 1))
      );

      const interval = Math.max(
        600,
        Math.min(10000, Math.floor(Number(customCommand.intervalMs) || 1000))
      );

      for (let i = 0; i < count; i++) {
        await socket.sendMessage(
          from,
          { text: response },
          { quoted: info }
        );

        if (i < count - 1) await sleep(interval);
      }

    } else if (customCommand.type === "store") {
      const context = message?.extendedTextMessage?.contextInfo;
      const quoted = context?.quotedMessage;
      const quotedText = quoted ? getText(quoted).text : "";
      const quotedMedia = quoted ? getMedia(quoted) : null;
      const slot = customCommand.slot || command;

      if (quotedMedia) {
        const saved = await saveMedia(
          quoted,
          from,
          context?.stanzaId,
          context?.participant,
          config.mediaDir
        );

        saved.caption =
          quotedText || argumentText || saved.caption || "";

        slots[slot] = saved;
        writeJson(config.slotsPath, slots);

        await socket.sendMessage(from, {
          text: `Mídia guardada com sucesso no espaço: ${slot}`
        });

      } else if (quotedText || argumentText) {
        slots[slot] = quotedText || argumentText;
        writeJson(config.slotsPath, slots);

        await socket.sendMessage(from, {
          text: `Texto guardado no espaço: ${slot}`
        });

      } else {
        await socket.sendMessage(from, {
          text: "Responda a uma mensagem ou informe um texto para guardar."
        });
        return;
      }

    } else if (customCommand.type === "show") {
      const selected =
        customCommand.multiSlot === true &&
        Array.isArray(customCommand.slots)
          ? [...new Set(customCommand.slots.map(String).filter(Boolean))]
          : [String(customCommand.slot || command)];

      if (!selected.length) {
        await socket.sendMessage(from, {
          text: "Nenhum SLOT foi selecionado para este comando."
        });
        return;
      }

      for (const slot of selected) {
        if (!slots[slot]) {
          await socket.sendMessage(from, {
            text: `Nenhum conteúdo guardado no espaço ${slot}.`
          });
        } else {
          await sendStoredContent(socket, from, slots[slot], info);
        }
      }

    } else if (customCommand.type === "delete") {
      const slot = String(customCommand.slot || command);

      if (slots[slot]) {
        const stored = slots[slot];

        if (
          stored &&
          typeof stored === "object" &&
          stored.kind === "media" &&
          stored.filePath
        ) {
          try {
            fs.unlinkSync(stored.filePath);
          } catch {}
        }

        delete slots[slot];
        writeJson(config.slotsPath, slots);

        await socket.sendMessage(from, {
          text: `Conteúdo do espaço ${slot} apagado.`
        });

      } else {
        await socket.sendMessage(from, {
          text: "Esse espaço já está vazio."
        });
      }
    }

    await panel.logCommand(`${mode}:${command}`, "executed");

  } catch (error) {
    console.error("[COMANDOS] Erro ao executar comando:", error);
  }
}
