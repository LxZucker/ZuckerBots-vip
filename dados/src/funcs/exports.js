
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Caminho compatível com ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Importa módulos sem interromper o bot caso algum arquivo opcional
 * não exista ou apresente erro.
 */
async function safeImport(modulePath) {
    try {
        return await import(modulePath);
    } catch (error) {
        console.error(
            `[EXPORTS] Falha ao carregar ${modulePath}: ${error.message}`
        );
        return {};
    }
}

/**
 * Carrega arquivos JSON de forma síncrona.
 */
function loadJsonSync(filePath) {
    try {
        const fullPath = path.resolve(__dirname, filePath);
        const data = fs.readFileSync(fullPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error(
            `[ERRO] Falha ao carregar JSON ${filePath}: ${error.message}`
        );
        return undefined;
    }
}

let modulesPromise;

async function loadModules() {
    if (modulesPromise) return modulesPromise;

    modulesPromise = (async () => {
        const modules = {};

        // ==========================================
        // DOWNLOADS E FERRAMENTAS
        // ==========================================

        const [
            youtubeMod,
            tiktokMod,
            totextMod,
            ttsMod,
            pinterestMod,
            igdlMod,
            lyricsMod,
            spotifyMod,
            soundcloudMod,
            facebookMod,
            kwaiMod,
            logos,
            edits,
            canvas
        ] = await Promise.all([
            safeImport('./Downloads/youtube.js'),
            safeImport('./Downloads/tiktok.js'),
            safeImport('./Ferramentas/totext.js'),
            safeImport('./Ferramentas/tts.js'),
            safeImport('./Downloads/pinterest.js'),
            safeImport('./Downloads/igdl.js'),
            safeImport('./Downloads/lyrics.js'),
            safeImport('./Downloads/spotify.js'),
            safeImport('./Downloads/soundcloud.js'),
            safeImport('./Downloads/facebook.js'),
            safeImport('./Downloads/kwai.js'),
            safeImport('./Logos/index.js'),
            safeImport('./Edits/index.js'),
            safeImport('./Downloads/canvas.js')
        ]);

        modules.youtube = youtubeMod.default ?? youtubeMod;

        if (modules.youtube && typeof modules.youtube.search !== 'function') {
            console.warn('[EXPORTS] YouTube search não disponível');
            modules.youtube.search = () => {
                throw new Error('YouTube search not available');
            };
        }

        modules.tiktok = tiktokMod.default ?? tiktokMod;
        modules.totext = totextMod.default ?? totextMod;
        modules.tts = ttsMod.default ?? ttsMod;
        modules.pinterest = pinterestMod.default ?? pinterestMod;
        modules.igdl = igdlMod.default ?? igdlMod;
        modules.Lyrics = lyricsMod.default ?? lyricsMod;
        modules.spotify = spotifyMod.default ?? spotifyMod;
        modules.soundcloud = soundcloudMod.default ?? soundcloudMod;
        modules.facebook = facebookMod.default ?? facebookMod;
        modules.kwai = kwaiMod.default ?? kwaiMod;

        modules.logos = logos.default ?? logos;
        modules.edits = edits.default ?? edits;
        modules.canvas = canvas.default ?? canvas;

        // Verificações do YouTube
        if (modules.youtube) {
            const youtubeMethods = ['search', 'mp3', 'mp4'];

            youtubeMethods.forEach(method => {
                if (typeof modules.youtube[method] !== 'function') {
                    console.warn(
                        `[EXPORTS] YouTube.${method} não disponível`
                    );

                    modules.youtube[method] = () => {
                        throw new Error(
                            `YouTube ${method} function not available`
                        );
                    };
                }
            });
        }

        // ==========================================
        // UTILIDADES
        // ==========================================

        const [
            styleTextMod,
            emojiMixMod,
            tictactoeMod,
            stickerMod,
            commandStatsMod,
            relationshipsMod,
            connect4Mod,
            unoMod,
            memoriaMod,
            achievementsMod,
            giftsMod,
            reputationMod,
            qrcodeMod,
            notesMod,
            calculatorMod,
            audioEditMod,
            transmissaoMod,
            gdriveMod,
            mediafireMod,
            twitterMod,
            imagetoolsMod,
            freefireMod
        ] = await Promise.all([
            safeImport('./Utils/gerarnick.js'),
            safeImport('./Utils/emojimix.js'),
            safeImport('./Utils/tictactoe.js'),
            safeImport('./Utils/sticker.js'),
            safeImport('./Utils/commandStats.js'),
            safeImport('./Utils/relationships.js'),
            safeImport('./Utils/connect4.js'),
            safeImport('./Utils/uno.js'),
            safeImport('./Utils/memoria.js'),
            safeImport('./Utils/achievements.js'),
            safeImport('./Utils/gifts.js'),
            safeImport('./Utils/reputation.js'),
            safeImport('./Utils/qrcode.js'),
            safeImport('./Utils/notes.js'),
            safeImport('./Utils/calculator.js'),
            safeImport('./Utils/audioEdit.js'),
            safeImport('./Utils/transmissao.js'),
            safeImport('./Utils/gdrive.js'),
            safeImport('./Utils/mediafire.js'),
            safeImport('./Utils/twitter.js'),
            safeImport('./Utils/imagetools.js'),
            safeImport('./Utils/freefire.js')
        ]);

        modules.styleText = styleTextMod.default ?? styleTextMod;
        modules.emojiMix = emojiMixMod.default ?? emojiMixMod;
        modules.tictactoe = tictactoeMod.default ?? tictactoeMod;
        modules.stickerModule = stickerMod.default ?? stickerMod;
        modules.commandStats = commandStatsMod.default ?? commandStatsMod;
        modules.relationshipManager =
            relationshipsMod.default ?? relationshipsMod;

        modules.connect4 = connect4Mod.default ?? connect4Mod;
        modules.uno = unoMod.default ?? unoMod;
        modules.memoria = memoriaMod.default ?? memoriaMod;
        modules.achievements = achievementsMod.default ?? achievementsMod;
        modules.gifts = giftsMod.default ?? giftsMod;
        modules.reputation = reputationMod.default ?? reputationMod;
        modules.qrcode = qrcodeMod.default ?? qrcodeMod;
        modules.notes = notesMod.default ?? notesMod;
        modules.calculator = calculatorMod.default ?? calculatorMod;
        modules.audioEdit = audioEditMod.default ?? audioEditMod;
        modules.transmissao = transmissaoMod.default ?? transmissaoMod;

        modules.gdrive = gdriveMod.default ?? gdriveMod;
        modules.mediafire = mediafireMod.default ?? mediafireMod;
        modules.twitter = twitterMod.default ?? twitterMod;
        modules.imagetools = imagetoolsMod.default ?? imagetoolsMod;
        modules.freefire = freefireMod.default ?? freefireMod;

        // Envia stickers diretamente
        if (
            modules.stickerModule &&
            typeof modules.stickerModule.sendSticker === 'function'
        ) {
            modules.sendSticker = modules.stickerModule.sendSticker;
        } else {
            console.warn('[EXPORTS] sendSticker não disponível');

            modules.sendSticker = () => {
                throw new Error('sendSticker not available');
            };
        }

        // ==========================================
        // MÓDULOS PRIVATE
        // IA.JS E ANTIPALAVRAS.JS FORAM REMOVIDOS
        // ==========================================

        const [
            temuScammerMod,
            antitoxicMod,
            iaExpandedMod
        ] = await Promise.all([
            safeImport('./Private/temuScammer.js'),
            safeImport('./Private/antitoxic.js'),
            safeImport('./Private/iaExpanded.js')
        ]);

        modules.temuScammer =
            temuScammerMod.default ?? temuScammerMod;

        modules.antitoxic =
            antitoxicMod.default ?? antitoxicMod;

        modules.iaExpanded =
            iaExpandedMod.default ?? iaExpandedMod;

        // ==========================================
        // ARQUIVOS JSON
        // ==========================================

        const toolsJsonData = loadJsonSync('Json/tools.json');
        const vabJsonData = loadJsonSync('Json/vab.json');

        modules.toolsJson = () => toolsJsonData;
        modules.vabJson = () => vabJsonData;

        return modules;
    })();

    return modulesPromise;
}

/**
 * Acesso assíncrono aos módulos.
 */
export async function getModules() {
    return await loadModules();
}

// Carrega os módulos antes de exportar
const modules = await loadModules();

// Proxy para avisar quando algum módulo não existir
const safeModules = new Proxy(modules, {
    get(target, prop) {
        if (!(prop in target)) {
            console.warn(
                `[EXPORTS] Módulo '${String(prop)}' não encontrado`
            );
            return undefined;
        }

        const value = target[prop];

        if (typeof value === 'object' && value !== null) {
            return new Proxy(value, {
                get(obj, key) {
                    if (!(key in obj)) {
                        console.warn(
                            `[EXPORTS] Propriedade '${String(key)}' não encontrada em '${String(prop)}'`
                        );
                        return undefined;
                    }

                    return obj[key];
                }
            });
        }

        return value;
    }
});

export default safeModules;
