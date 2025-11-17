// index.js
// Node 18+ (type: "module" in package.json)
import makeWASocket, {
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason
  } from "baileys";
  
  import pino from "pino";
  import readline from "readline-sync";
  import fs from "fs";
  import path from "path";
  
  import { applyShield } from "./security/shield.js";
  import { sanitizeMessage } from "./security/sanitizer.js";
  import { antiSpamCheck } from "./security/antispam.js";
  import { secureMessageHandler } from "./handlers/messages.js";
  
  // Configuration
  const LOG = pino({ level: process.env.LOG_LEVEL || "info" });
  const AUTH_DIR = "./auth";
  const PLUGINS_DIR = "./plugins";
  const PAIRING_PROMPT = true;
  const AUTO_INVITE_LINK = process.env.AUTO_INVITE_LINK || "https://chat.whatsapp.com/TON_LIEN_OU_CHAINE"; // change le lien
  const RECONNECT_DELAY = 2500; // ms
  
  let sock = null;
  let isRestarting = false;
  
  function loadPlugins() {
    const plugins = new Map();
    try {
      if (!fs.existsSync(PLUGINS_DIR)) return plugins;
      const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith(".js"));
      for (const file of files) {
        try {
          const full = path.join(process.cwd(), PLUGINS_DIR, file);
          const mod = awaitImport(full);
          if (mod && typeof mod.default === "function") {
            plugins.set(file, mod.default);
            LOG.info({ plugin: file }, "Plugin chargé");
          }
        } catch (e) {
          LOG.warn({ file, err: String(e) }, "Erreur chargement plugin");
        }
      }
    } catch (e) {
      LOG.error({ err: String(e) }, "Erreur loadPlugins");
    }
    return plugins;
  }
  
  
  function awaitImport(pathToFile) {
    return import(pathToFile);
  }
  
  // Start bot
  async function startBot() {
    try {
      LOG.info("Démarrage du bot...");
      LOG.info(`Utilisation du répertoire d'auth: ${AUTH_DIR}`);
      LOG.info(`Auto-invite link: ${AUTO_INVITE_LINK}`);
      LOG.info(`installation des dépendance...`);
      LOG.clear();
  
      
      let formattedNumber = null;
      if (PAIRING_PROMPT) {
        const raw = readline.question("Entre ton numéro WhatsApp (ex: 24177000000) : ").trim();
        if (!raw) throw new Error("Numéro requis pour générer le Pair Code.");
        // nettoie + 
        formattedNumber = raw.replace(/^(\+|00)/, "");
        LOG.info({ number: formattedNumber }, "Numéro saisi");
      }
  
      // Auth state
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();
  
      // create socket
      sock = makeWASocket({
        version,
        logger: LOG,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, LOG)
        },
        getMessage: async key => {
          // placeholder safe for Baileys when asked for message content
          return { key, message: null };
        }
      });
  
      // Si non enregistré, demander Pair Code
      if (!state.creds?.registered && formattedNumber) {
        try {
          LOG.info("Génération du Pair Code...");
          const code = await sock.requestPairingCode(formattedNumber);
          console.log("\n======= PAIR CODE =======\n");
          console.log(code);
          console.log("\n=========================\n");
          LOG.info("Pair code généré. Entre ce code dans WhatsApp pour lier le device.");
        } catch (e) {
          LOG.error({ err: String(e) }, "Erreur requestPairingCode");
        }
      }
  
      const plugins = await loadPlugins();

      sock.ev.on("messages.upsert", async (m) => {
        try {
          if (!m || !m.messages || !m.messages.length) return;
          const msg = m.messages[0];
  
         
          if (!msg?.message) return;
  
          // shield: bloque crashers et malformés
          const blocked = applyShield(msg);
          if (blocked) {
            LOG.warn({ id: msg.key?.id, jid: msg.key?.remoteJid }, "Message bloqué par SHIELD");
            return;
          }
  
          // sanitize
          const safeMsg = sanitizeMessage(msg);
  
          // anti-spam/flood
          if (antiSpamCheck(safeMsg)) {
            LOG.warn({ jid: msg.key?.remoteJid }, "Message bloqué par ANTI-SPAM");
            await sock.sendMessage(msg.key.remoteJid, {
              text: "⚠️ *ANTI SPAM ACTIF* Merci de ralentir un peu."
            });
            return;
          }
  
          
          const remote = String(msg.key.remoteJid || "");
          if (remote === "status@broadcast") {
            
            try {
              LOG.info("Statut reçu (status@broadcast) — traitement sécurisé");
            
            } catch (e) {
              LOG.warn({ err: String(e) }, "Erreur traitement status — ignoré");
            }
            return;
          }
  
          
          try {
            await secureMessageHandler(sock, safeMsg);
          } catch (e) {
            LOG.error({ err: String(e) }, "Erreur secureMessageHandler");
          }
  
        } catch (err) {
          LOG.error({ err: String(err) }, "Erreur messages.upsert globale");
        }
      });
  
      
      sock.ev.on("presence.update", (p) => {
        LOG.debug({ presence: p }, "presence.update");
      });
  
      
      sock.ev.on("connection.update", (update) => {
        try {
          const { connection, lastDisconnect } = update;
          LOG.info({ connection }, "connection.update");
          if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            LOG.warn({ reason: lastDisconnect?.error?.toString?.() }, "Déconnecté");
            if (shouldReconnect && !isRestarting) {
              isRestarting = true;
              LOG.info("Reconnexion dans %sms...", RECONNECT_DELAY);
              setTimeout(async () => {
                try {
                  isRestarting = false;
                  await startBot();
                } catch (e) {
                  LOG.error({ err: String(e) }, "Reconnexion échouée");
                }
              }, RECONNECT_DELAY);
            } else {
              LOG.info("Session déconnectée (logged out) — il faut relier manuellement.");
            }
          } else if (connection === "open") {
            LOG.info("🟢 Bot connecté (open).");
          }
        } catch (e) {
          LOG.error({ err: String(e) }, "Erreur connection.update");
        }
      });
  
      
      sock.ev.on("creds.update", saveCreds);
  
      const seenFile = "./.seen_jids.json";
      let seen = {};
      try {
        if (fs.existsSync(seenFile)) seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      } catch (e) { seen = {}; }
  
      sock.ev.on("messages.upsert", async (m) => {
        try {
          if (!m || !m.messages || !m.messages.length) return;
          const msg = m.messages[0];
          if (!msg?.message) return;
          const jid = msg.key.remoteJid;
          if (!jid || jid.endsWith("@g.us")) return;
          if (jid === "status@broadcast") return;
          if (!seen[jid]) {
            seen[jid] = Date.now();
            fs.writeFileSync(seenFile, JSON.stringify(seen, null, 2));
            try {
              await sock.sendMessage(jid, {
                text: `Bonjour ! Merci pour ton message. Rejoins ma chaîne / groupe :\n${AUTO_INVITE_LINK}`
              });
              LOG.info({ jid }, "Auto-invite envoyé");
            } catch (e) {
              LOG.warn({ jid, err: String(e) }, "Impossible d'envoyer auto-invite");
            }
          }
        } catch (e) {
          LOG.warn({ err: String(e) }, "Erreur auto-invite listener");
        }
      });
  
    } catch (e) {
      LOG.error({ err: String(e) }, "Erreur startBot globale");
      // tenter redémarrer doucement
      setTimeout(() => startBot(), RECONNECT_DELAY);
    }
  }
  
  // lance
  startBot();  