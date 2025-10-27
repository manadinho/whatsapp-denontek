require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, downloadContentFromMessage, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, extractMessageContent, getContentType } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;
const axios = require('axios');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { logMessage, drainAll, flushLogsFor, cleanTempDrainDirs } = require('./conv-logger');
const WHISPER_API_KEY = process.env.WHISPER_API_KEY;
const OpenAI = require('openai');
const openai = new OpenAI({
    apiKey: WHISPER_API_KEY,
});

const app = express();
app.use(express.json());

const fs = require('fs');
const path = require('path');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json')));
const citiesText = fs.readFileSync(path.join(__dirname, 'cities.txt'), 'utf-8');

// === multi-session config ===
const SESSION_IDS = ['farhan', 'amber', 'rubaisha'];          // your two accounts
const SESSION_PREFIX = 'auth_info_baileys';  // base name; real folder is `${SESSION_PREFIX}_${sid}`
const DEFAULT_SID = 'farhan';                   // legacy endpoints map to this

// CHECK_NUMBER rule is to check all inquiries against a number
const customRules = ['i1', 'i2', 's1', 'c1', 'c2', 'c3', '???']; // c1 = start campaign (Farhan only)
const ADMINS_NUMBERS = ['923344778077', '923367674817', '923004013334', '923076929940', '923176063820']; // w/o @s.whatsapp.net
const AGENTS_NUMBERS = ['923143637459', '923008620417']; // w/o @s.whatsapp.net
const AGENTS_NUMBERS_WITH_SESSIONS_IDS = {
    'farhan': '923176063820',
    'amber': '923008620417',
    'rubaisha': '923143637459',
}

const PORT = process.env.PORT || 3000;
// const SERVER_BASE_SECURE_URL = "http://192.168.1.14:8000";
const SERVER_BASE_SECURE_URL = "https://staging.denontek.com.pk";
const SERVER_BASE_URL = "http://staging.denontek.com.pk";
const DEN_API_KEY = "denapi4568";
const LOCAL_AI_URL = "https://d5051ef50a23.ngrok-free.app";


// ==== per-session containers ====
/**
 * Sessions = {
 *   [sid]: {
 *     sock, isConnected, user, saveCreds, lastQR,
 *     ctx: { campaignStartedAt, campaignSuccessNumbers, campaignFailureNumbers, campaignSuccessCount, campaignFailureCount, campaignStatus }
 *   }
 * }
 */
const Sessions = {};

function makeCampaignCtx() {
  return {
    campaignStartedAt: '',
    campaignSuccessNumbers: [],
    campaignFailureNumbers: [],
    campaignSuccessCount: 0,
    campaignFailureCount: 0,
    campaignStatus: 'not_started',
  };
}

function makeFollowupCtx() {
    return {
        // SEPARATE: Follow-up context (completely independent)
        followUpStartedAt: '',
        followUpSuccessNumbers: [],
        followUpFailureNumbers: [],
        followUpSuccessCount: 0,
        followUpFailureCount: 0,
        followUpStatus: 'not_started',
    }
}

function getSes(sid) {
  if (!sid || !Sessions[sid]) throw new Error(`Unknown session: ${sid}`);
  return Sessions[sid];
}

function resetCampaignVariablesFor(sid) {
  const ses = getSes(sid);
  ses.ctx = makeCampaignCtx();
}

function resetFollowupVariablesFor(sid) {
  const ses = getSes(sid);
  ses.ctx = makeFollowupCtx();
}

// ===== WhatsApp connection per session =====
async function startSockFor(sid) {
  const authFolder = `${SESSION_PREFIX}_${sid}`;
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const version = [2, 3000, 1027934701];

  const sock = makeWASocket({
    version,
    auth: state,
    // printQRInTerminal: true,
  });

  Sessions[sid] = Sessions[sid] || {};
  const ses = Sessions[sid];
  ses.sock = sock;
  ses.isConnected = false;
  ses.saveCreds = saveCreds;
  ses.ctx = ses.ctx || makeCampaignCtx();

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ses.lastQR = qr;
      console.log(`[${sid}] 🔐 QR generated`);
    }

    if (connection === 'open') {
      ses.isConnected = true;
      ses.user = sock.user;
      console.log(`[${sid}] ✅ WhatsApp connected as`, sock.user);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== 401;
      ses.isConnected = false;
      console.log(`[${sid}] ⚠️ Disconnected code=${code}, reconnect=${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => startSockFor(sid).catch(()=>{}), 2000);
      } else {
        deleteSessionFor(sid);
      }
    }
  });

  // === INCOMING MESSAGE HANDLER (your logic, session-scoped) ===
  sock.ev.on('messages.upsert', async (m) => {
    try {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        const isOutgoing = !!msg.key.fromMe;

        // filter old messages (> 60s)
        const now = Date.now();
        const messageTimestamp = (msg.messageTimestamp || 0) * 1000;
        if ((now - messageTimestamp) > 60 * 1000) {
            console.log(`[${sid}] ⏳ Ignored old message:`, new Date(messageTimestamp));
            return;
        }

        const sender = msg.key.remoteJid || '';
        // const messageType = Object.keys(msg.message)[0];
        const content = extractMessageContent(msg.message || {}) || {};
        const messageType = getContentType(content) || 'unknown';
        // 🚫 ignore groups & newsletters & broadcast/status
        if (
            isJidGroup(sender) ||
            isJidBroadcast(sender) ||
            isJidStatusBroadcast(sender) ||
            (typeof isJidNewsletter === 'function' && isJidNewsletter(sender)) ||
            /@g\.us$/.test(sender) ||
            /@newsletter$/.test(sender) ||
            sender === 'status@broadcast'
        ) {
            return;
        }

        let text = '';
        if (messageType === 'conversation') {
            text = msg.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            text = msg.message.extendedTextMessage.text;
        }

        // if message is campaign message, ignore it
        if (isUnsubscribeFooter(text)) return;

        // ===== custom rules =====
        const textParts = (text || '').split(' ');
        const textFirstValue = (textParts[0] || '').trim().toLowerCase();

        if (customRules.includes(textFirstValue)) {
            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            if (textFirstValue === '???') {
                const helpText = `*Available Commands:*\n\n` +
                    `1. *i1* - Get today's inquiries submitted by you.\n` +
                    `   _Example:_ TODAY_INQUIRIES\n\n` +
                    `2. *i2 <NUMBER>* - Check inquiries against a specific number.\n` +
                    `   _Example:_ CHECK_NUMBER\\n03001234567\n\n` +
                    `3. *???* - Display this help message.\n\n` +
                    `*Note:* Please ensure to use the exact command format as shown above.`;
                await sock.sendMessage(sender, { text: helpText });
            }

            if (textFirstValue === 'i2') {
                console.log(`[${sid}] 📞 CHECK_NUMBER rule triggered`, textParts[1]);
                const payload = new URLSearchParams();
                payload.append("agent_number", sender.replace('@s.whatsapp.net', ''));
                payload.append("type", "CHECK_NUMBER");
                payload.append("data", [textParts[1]]);
                const endpoint = 'den-inquiry/api-send-message';
                await makeServerPostApiCall(payload, endpoint);
            }

            if (textFirstValue === 'i1') {
                const payload = new URLSearchParams();
                payload.append("agent_number", sender.replace('@s.whatsapp.net', ''));
                payload.append("type", "TODAY_INQUIRIES");
                const endpoint = 'den-inquiry/api-send-message';
                await makeServerPostApiCall(payload, endpoint);
            }

            if (textFirstValue === 's1') {
                let senderNumber = sender.replace('@s.whatsapp.net', '');
                if (ADMINS_NUMBERS.includes(senderNumber)) {
                    const endpoint = 'den-inquiry/daily-sale-statistics';
                    await makeServerGetApiCall(endpoint);
                }
            }

            // start campaign (Farhan only)
            if (textFirstValue === 'c1') {
                if (ses.ctx.campaignStatus === 'in_progress') {
                    await sock.sendMessage(sender, { text: '❌ A campaign is already in progress. Please wait until it is completed.' });
                    await sock.sendPresenceUpdate('paused', sender);
                    return;
                }

                let senderNumber = sender.replace('@s.whatsapp.net', '');
                if (!ADMINS_NUMBERS.includes(senderNumber) && !AGENTS_NUMBERS.includes(senderNumber)) {
                    await sock.sendPresenceUpdate('paused', sender);
                    await sock.sendMessage(sender, { text: '❌ You are not authorized to start campaign.' });
                    return;
                }

                await sock.sendMessage(sender, { text: '🚀 Campaign start request received. Please wait it will start in few minutes.' });
                const endpoint = 'den-campaigns/start?agent_number=' + senderNumber;
                await makeServerGetApiCall(endpoint);
                await sock.sendPresenceUpdate('paused', sender);
                return;
            }

            // campaign status
            if (textFirstValue === 'c2') {
                if (ses.ctx.campaignStatus === 'not_started') {
                    await sock.sendMessage(sender, { text: '❌ No Campaign is running at the moment.' });
                    await sock.sendPresenceUpdate('paused', sender);
                    return;
                }

                const endedAt = Date.now();
                const durationMs = endedAt - ses.ctx.campaignStartedAt;
                const durationHuman = humanizeDuration(durationMs);
                let message = `*Campaign Status* [${sid}]\n\n` +
                    `Status: ${ses.ctx.campaignStatus}\n` +
                    `Started At: ${new Date(ses.ctx.campaignStartedAt).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}\n` +
                    `Duration: ${durationHuman}\n` +
                    `Successful: ${ses.ctx.campaignSuccessCount}\n` +
                    `Failed: ${ses.ctx.campaignFailureCount}\n\n` +
                    `You will receive a summary once the campaign is completed.`;

                await sock.sendMessage(sender, { text: message });
                await sock.sendPresenceUpdate('paused', sender);
                return;
            }

            // campaign stop
            if (textFirstValue === 'c3') {
                if (ses.ctx.campaignStatus !== 'in_progress') {
                    await sock.sendMessage(sender, { text: '❌ No Campaign is running at the moment.' });
                    await sock.sendPresenceUpdate('paused', sender);
                    return;
                }
                ses.ctx.campaignStatus = 'not_started';
                await sock.sendMessage(sender, { text: '🛑 Campaign stop request received. The campaign will stop shortly.' });
                return;
            }

            await sock.sendPresenceUpdate('paused', sender);
        }

        // FB ads greeting special case
        // if (text === 'Hello! Can I get more info on this?' && !isOutgoing) {
        //     await sock.readMessages([msg.key]);
        //     await sock.sendPresenceUpdate('composing', sender);
        //     const firstImageUrl  = 'https://staging.denontek.com.pk/public/images/10600.jpeg';
        //     const secondImageUrl = 'https://staging.denontek.com.pk/public/images/13200.jpeg';
        //     const thirdImageUrl  = 'https://staging.denontek.com.pk/public/images/14200.jpeg';

        //     const [b1, b2, b3] = await Promise.all([
        //     fetchImageBuffer(firstImageUrl, firstImageUrl.replace(/^https:\/\//i, 'http://')),
        //     fetchImageBuffer(secondImageUrl, secondImageUrl.replace(/^https:\/\//i, 'http://')),
        //     fetchImageBuffer(thirdImageUrl, thirdImageUrl.replace(/^https:\/\//i, 'http://')),
        //     ]);

        //     if (!b1 || !b2 || !b3) { await sock.sendPresenceUpdate('paused', sender); return; }

        //     try {
        //     await sock.sendMessage(sender, { image: b1, mimetype: 'image/jpeg', caption: 'Rs 10600/-' });
        //     await sock.sendMessage(sender, { image: b2, mimetype: 'image/jpeg', caption: 'Rs 13200/-' });
        //     await sock.sendMessage(sender, { image: b3, mimetype: 'image/jpeg', caption: 'Rs 14200/-' });
        //     await sock.sendPresenceUpdate('paused', sender);
        //     } catch {
        //     await sock.sendPresenceUpdate('paused', sender);
        //     return;
        //     }
        // }

        // Matched rules
        const matchedRule = rules.find(rule =>
            rule.RuleStatus === true &&
            rule.Operand === '=' &&
            rule.RuleKeyword === text
        );

        if (matchedRule && !isOutgoing) {
            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);
            await sleep(3000);
            await sock.sendPresenceUpdate('paused', sender);

            await sock.sendMessage(sender, { text: matchedRule.RuleMessage });
        }

        // Cities list
        if ((text || '').toLowerCase() === "cities list") {
            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);
            await sleep(3000);
            await sock.sendPresenceUpdate('paused', sender);
            await sock.sendMessage(sender, { text: `📍 *List of Cities:*\n\n${citiesText.trim()}` });
        }

        const messageContent = msg.message;
        const audioMsg = messageContent?.audioMessage || messageContent?.message?.audioMessage;
        if(audioMsg) {
            try {
                // 1) download media stream (Baileys helper)
                const stream = await downloadContentFromMessage(audioMsg, 'audio'); // returns async iterable
                const oggPath = path.join(__dirname, `wa-${msg.key.id}.ogg`);
                await streamToFile(stream, oggPath);

                // 2) convert to WAV (16k mono) for best STT compatibility
                // build a File for OpenAI directly from the OGG (no ffmpeg needed)
                const oggBuf = await fs.promises.readFile(oggPath);
                const fileForOpenAI = await OpenAI.toFile(oggBuf, `wa-${msg.key.id}.ogg`, { type: 'audio/ogg' });

                // 3) call OpenAI / Whisper transcription (example)
                const transcription = await openai.audio.transcriptions.create({
                    file: fileForOpenAI,
                    model: 'whisper-1',
                    translate: true,
                    language: 'ur',
                });
            
                // 4) reply with the transcript (or store it)
                text = transcription.text;

                // cleanup temp files
                if (fs.existsSync(oggPath)) {
                    fs.unlinkSync(oggPath);
                }
                console.log(`[${sid}] 📝 Transcribed audio message:`, text);

                // make api call to convert urdu text to roman english
                const romanText = await convertUrduToRoman(text);
                if (romanText) {
                    text = romanText;
                }
            } catch (err) {
                // send error message to admins
                await sock.sendMessage(`923004013334@s.whatsapp.net`, { text: `**ERROR TYPE: Audio file transcript error [${sid}]**\n\n${err.message}` });
                await sock.sendMessage(`923076929940@s.whatsapp.net`, { text: `**ERROR TYPE: Audio file transcript error [${sid}]**\n\n${err.message}` });
            }
        }

        if (text && !isOutgoing) {
            logMessage(sid, 'in', sender, text, (msg.messageTimestamp || 0) * 1000);
        }

        if (text && isOutgoing) {
            logMessage(sid, 'out', sender, text, (msg.messageTimestamp || 0) * 1000);
        }

    } catch (e) {
      console.error(`[${sid}] upsert handler error`, e.message);
      console.error(e);
    }
  });

  return { status: ses.isConnected ? 'connected' : (ses.lastQR ? 'qr' : 'starting') };
}

function convertUrduToRoman(text) {
    let data = JSON.stringify({
        "model": "deepseek-v3.1:671b-cloud",
        "messages": [
            {
            "role": "system",
            "content": "You are a bilingual Urdu–English expert. When the user sends Urdu text, OUTPUT ONLY Roman Urdu (Urdu written in English letters). Do NOT add translations, explanations, parentheses, or extra text."
            },
            {
            "role": "user",
            "content": `${text}`
            }
        ],
        "stream": false,
        "options": {
            "temperature": 0.2,
            "num_predict": 300
        }
    });

    return new Promise((resolve, reject) => {
        let config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: LOCAL_AI_URL+'/api/chat',
            headers: { 
                'Content-Type': 'application/json'
            },
            data : data
        };

        axios.request(config)
        .then((response) => {
            console.log('==== response from ai',response.data);
            if(response.data && response.data.message && response.data.message.content) {
                return resolve(response.data.message.content);
            }

            resolve(false);
            
        })
        .catch((error) => {
            resolve(false);
        });
    });
}

function deleteSessionFor(sid) {
  try {
    const ses = Sessions[sid];
    if (ses?.sock) {
      try { ses.sock.logout?.(); } catch {}
    }
    const authFolder = `${SESSION_PREFIX}_${sid}`;
    fs.rmSync(authFolder, { recursive: true, force: true });
  } catch {}
  delete Sessions[sid];
}

// ======= helpers (unchanged) =======
function humanizeDuration(ms, { maxUnits = 2 } = {}) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;

  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);  seconds %= 60;

  const parts = [];
  const push = (v, label) => v > 0 && parts.push(`${v} ${label}${v === 1 ? '' : 's'}`);

  push(days, 'day');
  push(hours, 'hour');
  push(minutes, 'minute');
  push(seconds, 'second');

  if (parts.length === 0) return '0 seconds';

  const top = parts.slice(0, maxUnits);
  return top.length === 1 ? top[0] : `${top.slice(0, -1).join(' ')} ${top.slice(-1)}`.replace(',', '').trim();
}

/**
 * Save an async iterable stream to a file
 * @param {AsyncIterable<Buffer>} stream
 * @param {string} filePath
 */
async function streamToFile(stream, filePath) {
    const write = fs.createWriteStream(filePath);
    for await (const chunk of stream) write.write(chunk);
    write.end();
    await new Promise(r => write.on('close', r));
}

function sleep(time = 2000) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

async function makeServerPostApiCall(payload = {}, enpoint = '') {
  try {
    let url = `${SERVER_BASE_SECURE_URL}/${enpoint}`;
    console.log("🌐 Making API call to:", url);

    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-den-api-key": DEN_API_KEY,
        'company-id': '1'
      },
      httpsAgent
    });

    console.log("✅ API response:", response.data);
    return response.data;

  } catch (error) {
    console.error("❌ API error:", error.message);

    try {
      const fallbackUrl = `${SERVER_BASE_URL}/${enpoint}`;
      console.log("ℹ️ Attempting fallback to HTTP:", fallbackUrl);
      const response = await axios.post(fallbackUrl, payload, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-den-api-key": DEN_API_KEY,
          'company-id': '1'
        }
      });

      console.log("✅ Fallback (HTTP) response:", response.data);
      return response.data;

    } catch (fallbackError) {
      console.error("❌ Fallback HTTP error:", fallbackError.message);
    }
  }
}

async function makeServerGetApiCall(endpoint = '') {
  try {
    let url = `${SERVER_BASE_SECURE_URL}/${endpoint}`;
    console.log("🌐 Making API call to:", url);

    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-den-api-key": DEN_API_KEY
      },
      httpsAgent
    });

    console.log("✅ API response:", response.data);

  } catch (error) {
    console.error("❌ API error:", error.message);

    try {
      const fallbackUrl = `${SERVER_BASE_URL}/${endpoint}`;
      console.log("ℹ️ Attempting fallback to HTTP:", fallbackUrl);
      const response = await axios.get(fallbackUrl, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-den-api-key": DEN_API_KEY
        }
      });

      console.log("✅ Fallback (HTTP) response:", response.data);

    } catch (fallbackError) {
      console.error("❌ Fallback HTTP error:", fallbackError.message);
    }
  }
}

const fetchImageBuffer = async (secureUrl, url) => {
  try {
    const res = await axios.get(secureUrl, {
      responseType: 'arraybuffer',
      headers: { Accept: 'image/*' },
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 300,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    return Buffer.from(res.data);
  } catch (_) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { Accept: 'image/*' },
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: (s) => s >= 200 && s < 300,
        httpAgent: new http.Agent({ keepAlive: true }),
      });
      return Buffer.from(res.data);
    } catch (_e) {
      return null;
    }
  }
};

// ===== CAMPAIGN (session-scoped) =====
async function manageCampaignFor(sid, phone_numbers = []) {
  const ses = getSes(sid);
  const sock = ses.sock;

  try {
    const firstImageUrl  = 'https://staging.denontek.com.pk/public/images/campaign.jpeg';
    const imageBuffer = await fetchImageBuffer(firstImageUrl, firstImageUrl.replace(/^https:\/\//i, 'http://'));

    const message = "📢 *DENONTEK Automatic School Bell System*\n\n" +
      "✅ No Wi-Fi, No Internet Required\n" +
      "✅ Built-in Hotspot — connect directly with your mobile\n" +
      "✅ Simple & secure connection\n" +
      "✅ Best for Schools, Colleges & Madaris\n" +
      "✅ Easy setup with warranty support\n\n" +
      "📍 *Apna city name bhejein aur janen aap ke sheher mein kon kon se schools yeh system use kar rahay hain.*\n\n" +
      "📲 WhatsApp for orders: 03176063820\n\n" +
      "Reply *STOP* to unsubscribe.";

    resetCampaignVariablesFor(sid);
    ses.ctx.campaignStartedAt = Date.now();
    ses.ctx.campaignStatus = 'in_progress';

    for (let i = 0; i < phone_numbers.length; i++) {
      if (ses.ctx.campaignStatus !== 'in_progress') {
        console.log(`[${sid}] 🛑 Campaign stopped by admin request.`);
        break;
      }

      let participant = phone_numbers[i];
      try {
        if (!participant.includes('@s.whatsapp.net')) {
            participant = participant + '@s.whatsapp.net';
        }
        await sock.sendMessage(participant, { caption: message, image: imageBuffer });

        // dynamic wait 20–50 seconds
        const waitTime = Math.floor(Math.random() * 30) + 20;
        console.log(`[${sid}] ==Waiting:`, waitTime);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

        ses.ctx.campaignSuccessCount++;
        ses.ctx.campaignSuccessNumbers.push(participant);
      } catch (error) {
        ses.ctx.campaignFailureCount++;
        ses.ctx.campaignFailureNumbers.push(participant);
        continue;
      }
    }
  } catch (err) {
    await ses.sock.sendMessage(`923008620417@s.whatsapp.net`, { text: `**ERROR TYPE: Campaing Error [${sid}]**\n\n${err.message}` });
    await ses.sock.sendMessage(`923004013334@s.whatsapp.net`, { text: `**ERROR TYPE: Campaing Error [${sid}]**\n\n${err.message}` });
    await ses.sock.sendMessage(`923076929940@s.whatsapp.net`, { text: `**ERROR TYPE: Campaing Error [${sid}]**\n\n${err.message}` });
    console.error(`[${sid}] ❌ Send error:`, err);
  }

  const endedAt = Date.now();
  const durationMs = endedAt - ses.ctx.campaignStartedAt;
  const durationHuman = humanizeDuration(durationMs);

  let summaryMessage = `*Campaign Summary* [${sid}]\n\n` +
    `Total Numbers: ${ses.ctx.campaignSuccessNumbers.length + ses.ctx.campaignFailureNumbers.length}\n` +
    `Successful: ${ses.ctx.campaignSuccessCount}\n` +
    `Failed: ${ses.ctx.campaignFailureCount}\n` +
    `Duration: ${durationHuman}\n\n`;

  await ses.sock.sendMessage(`923008620417@s.whatsapp.net`, { text: summaryMessage });
  await ses.sock.sendMessage(`923004013334@s.whatsapp.net`, { text: summaryMessage });
  await ses.sock.sendMessage(`923076929940@s.whatsapp.net`, { text: summaryMessage });
  await ses.sock.sendMessage(`923367674817@s.whatsapp.net`, { text: summaryMessage });

  const payload = new URLSearchParams();
  payload.append("success_numbers", JSON.stringify(ses.ctx.campaignSuccessNumbers));
  payload.append("failure_numbers", JSON.stringify(ses.ctx.campaignFailureNumbers));
  payload.append("success_count", ses.ctx.campaignSuccessCount);
  payload.append("failure_count", ses.ctx.campaignFailureCount);
  const endpoint = 'den-campaigns/mark-completed?agent_name=' + sid;
  await makeServerPostApiCall(payload, endpoint);

  resetCampaignVariablesFor(sid);
}

// ===== Followup (session-scoped) =====
async function manageFollowupFor(sid, phone_numbers = []) {
  const ses = getSes(sid);
  const sock = ses.sock;

  try {
    const firstImageUrl  = 'https://staging.denontek.com.pk/public/images/reminder.jpeg';
    const imageBuffer = await fetchImageBuffer(firstImageUrl, firstImageUrl.replace(/^https:\/\//i, 'http://'));

    const message = `السلام علیکم،
امید ہے آپ خیریت سے ہوں گے۔ پہلے آپ سے Denontek کے آٹومیٹک اسکول بیل سسٹم کے بارے میں بات ہوئی تھی۔ ہم آپ سے دوبارہ رابطہ اس لیے کر رہے ہیں تاکہ معلوم ہو سکے کہ کیا آپ اس سسٹم کی تنصیب پر غور کر رہے ہیں؟
اگر آپ کو کسی بھی قسم کی معلومات، رہنمائی یا مدد درکار ہو تو براہِ کرم ہمیں ضرور آگاہ کریں — ہماری ٹیم ہر وقت آپ کی خدمت کے لیے دستیاب ہے۔
شکریہ،
Team Denontek`;

    resetFollowupVariablesFor(sid);
    ses.ctx.followUpStartedAt = Date.now();
    ses.ctx.followUpStatus = 'in_progress';

    for (let i = 0; i < phone_numbers.length; i++) {
      if (ses.ctx.followUpStatus !== 'in_progress') {
        console.log(`[${sid}] 🛑 Follow stopped by admin request.`);
        break;
      }

      let participant = phone_numbers[i];
      try {
        // check if particcipant has .whatsapp.net
        if (!participant.includes('@s.whatsapp.net')) {
            participant = participant + '@s.whatsapp.net';
        }
        await sock.sendMessage(participant, { caption: message, image: imageBuffer });

        // dynamic wait 20–50 seconds
        const waitTime = Math.floor(Math.random() * 30) + 20;
        console.log(`[${sid}] ==Waiting:`, waitTime);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

        ses.ctx.followUpSuccessCount++;
        ses.ctx.followUpSuccessNumbers.push(participant);
      } catch (error) {
        ses.ctx.followUpFailureCount++;
        ses.ctx.followUpFailureNumbers.push(participant);
        continue;
      }
    }
  } catch (err) {
    await ses.sock.sendMessage(`923008620417@s.whatsapp.net`, { text: `**ERROR TYPE: Campaing Error [${sid}]**\n\n${err.message}` });
    await ses.sock.sendMessage(`923004013334@s.whatsapp.net`, { text: `**ERROR TYPE: Campaing Error [${sid}]**\n\n${err.message}` });
    await ses.sock.sendMessage(`923076929940@s.whatsapp.net`, { text: `**ERROR TYPE: Campaing Error [${sid}]**\n\n${err.message}` });
    console.error(`[${sid}] ❌ Send error:`, err);
  }

  const endedAt = Date.now();
  const durationMs = endedAt - ses.ctx.campaignStartedAt;
  const durationHuman = humanizeDuration(durationMs);

  let summaryMessage = `*Followup Summary* [${sid}]\n\n` +
    `Total Numbers: ${ses.ctx.followUpSuccessNumbers.length + ses.ctx.followUpFailureNumbers.length}\n` +
    `Successful: ${ses.ctx.followUpSuccessCount}\n` +
    `Failed: ${ses.ctx.followUpFailureCount}\n` +
    `Duration: ${durationHuman}\n\n`;

    const agentNumber = AGENTS_NUMBERS_WITH_SESSIONS_IDS[sid];
    if (agentNumber) {
        await ses.sock.sendMessage(`${agentNumber}@s.whatsapp.net`, { text: summaryMessage });
    }

  await ses.sock.sendMessage(`923008620417@s.whatsapp.net`, { text: summaryMessage });
  await ses.sock.sendMessage(`923004013334@s.whatsapp.net`, { text: summaryMessage });
  await ses.sock.sendMessage(`923076929940@s.whatsapp.net`, { text: summaryMessage });
  await ses.sock.sendMessage(`923367674817@s.whatsapp.net`, { text: summaryMessage });

  resetFollowupVariablesFor(sid);
}

const UNSUB_RE = /reply\s*\*?stop\*?\s*to\s*unsubscribe\.?$/i;
function normalize(s) {
  return String(s).trim().replace(/\s+/g, " ");
}
function isUnsubscribeFooter(text) {
  return UNSUB_RE.test(normalize(text));
}

// ===== routes =====
app.get('/', (req, res) => {
  return res.send('<h2>✅ Server is running.</h2>');
});

// --- Session-aware endpoints ---
app.get('/:sid/start-session', async (req, res) => {
  const sid = req.params.sid;
  if (!SESSION_IDS.includes(sid)) return res.status(404).send('Unknown session');

  try {
    if (!Sessions[sid]?.isConnected) {
      await startSockFor(sid);
    }
    const ses = Sessions[sid];
    if (ses?.isConnected && ses?.sock?.user) {
      return res.send(`<h2>✅ [${sid}] WhatsApp is already connected.</h2>`);
    }
    const qr = ses?.lastQR;
    const html = `
      <html>
        <head>
          <title>Scan WhatsApp QR [${sid}]</title>
          <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
        </head>
        <body style="text-align:center; font-family:sans-serif;">
          <h2>📱 Scan this QR Code [${sid}]</h2>
          <canvas id="qrcanvas"></canvas>
          <script>
            const qrString = ${JSON.stringify(qr || 'Waiting...')};
            if (qrString && qrString !== 'Waiting...') {
              QRCode.toCanvas(document.getElementById('qrcanvas'), qrString, function (error) {
                if (error) console.error('QR error:', error);
              });
            } else {
              document.body.insertAdjacentHTML('beforeend','<p>⏳ Waiting for QR...</p>');
            }
          </script>
        </body>
      </html>`;
    return res.send(html);
  } catch (err) {
    console.error(`[${sid}] start-session error`, err);
    return res.status(500).send(`<h2>❌ Error: ${err.message}</h2>`);
  }
});

app.get('/:sid/status', (req, res) => {
  const sid = req.params.sid;
  const ses = Sessions[sid];
  if (!ses) return res.json({ status: 'not_initialized', sid });
  if (ses.isConnected && ses.sock) {
    return res.json({ status: 'connected', user: ses.user, sid });
  }
  return res.json({ status: 'disconnected', sid, lastQR: ses.lastQR || null });
});

app.post('/:sid/send', async (req, res) => {
  const sid = req.params.sid;
  try {
    const ses = getSes(sid);
    if (!ses.isConnected || !ses.sock) return res.status(400).json({ error: 'WhatsApp is not connected' });
    
    const { number, message, imageUrl } = req.body;
    
    if (!number) return res.status(400).json({ error: 'Missing number' });
    
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

    // If imageUrl is provided, send image message
    if (imageUrl) {
      let imageBuffer;
      
      // Try HTTPS first, then HTTP fallback
      try {
        imageBuffer = await fetchImageBuffer(imageUrl, imageUrl.replace(/^https:\/\//i, 'http://'));
      } catch (error) {
        console.error(`[${sid}] ❌ Failed to fetch image:`, error.message);
        return res.status(400).json({ error: 'Failed to fetch image from URL' });
      }

      if (!imageBuffer) {
        return res.status(400).json({ error: 'Could not retrieve image from URL' });
      }

      await ses.sock.sendMessage(jid, {
        image: imageBuffer,
        caption: message || '',
        mimetype: 'image/jpeg' // You might want to detect this dynamically
      });
      
      return res.json({ 
        success: true, 
        sid, 
        to: number, 
        type: 'image',
        caption: message || '',
        imageUrl: imageUrl 
      });
    }
    
    // Otherwise send text message
    if (!message) return res.status(400).json({ error: 'Missing message for text message' });
    
    await ses.sock.sendMessage(jid, { text: message });
    return res.json({ success: true, sid, to: number, type: 'text', message });
    
  } catch (err) {
    console.error(`[${sid}] send error`, err);
    return res.status(500).json({ error: err.message });
  }
});


app.post('/:sid/send-custom', async (req, res) => {
  const sid = req.params.sid;
  const apiKey = req.headers['x-den-api-key'];
  if (apiKey !== DEN_API_KEY) return res.status(403).json({ success: false, message: 'Forbidden' });

  try {
    const ses = getSes(sid);
    if (!ses.isConnected || !ses.sock) return res.json({ success: false, message: 'WhatsApp is not connected' });

    const { number, type } = req.body;
    if (!type) return res.json({ success: false, message: 'Missing type' });
    if (type !== 'marketing') return res.json({ success: false, message: 'Invalid type' });
    if (!number) return res.json({ success: false, message: 'Missing number' });

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
    const caption =
      "🔔 *DenonTek – Automatic School Bell System* 🔔\n\n" +
      "Introducing our **WiFi-enabled bell controller** made for schools in Pakistan. 🇵🇰\n\n" +
      "✅ 100+ Alarms | ✅ Morning & Evening Shifts\n" +
      "✅ Accurate Timing | ✅ 1-Year Warranty\n" +
      "✅ Plug & Play\n\n" +
      "📍 *Apna city name bhejein aur janen aap ke sheher mein kon kon se schools yeh system use kar rahay hain.*\n\n" +
      "📲 WhatsApp for orders: 03344778077\n\n" +
      "Reply *STOP* to unsubscribe.";

    await ses.sock.sendMessage(jid, {
      image: { url: 'http://denontek.com.pk/image/catalog/new_logo_2.jpg' },
      caption
    });

    return res.json({ success: true, sid, message: 'Message sent' });
  } catch (err) {
    console.error(`[${sid}] ❌ Send error:`, err);
    return res.json({ success: false, message: err.message });
  }
});

app.post('/:sid/start-campaign', async (req, res) => {
  const sid = req.params.sid;
  const apiKey = req.headers['x-den-api-key'];
  if (apiKey !== DEN_API_KEY) return res.json({ success: false, message: 'Forbidden' });

  const { phone_numbers } = req.body;
  if (!phone_numbers || !Array.isArray(phone_numbers) || phone_numbers.length === 0) {
    return res.json({ success: false, message: 'Invalid phone_numbers' });
  }

  try {
    const ses = getSes(sid);
    if (!ses.isConnected || !ses.sock) return res.status(400).json({ error: 'WhatsApp is not connected' });

    let message = `🚀 *Campaign Started* [${sid}]\n\n` +
      `Total Numbers: ${phone_numbers.length}\n` +
      `Start Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}\n\n` +
      `You will receive a summary once the campaign is completed.`;
    
    const agentNumber = AGENTS_NUMBERS_WITH_SESSIONS_IDS[sid];
    if (agentNumber) {
      await ses.sock.sendMessage(`${agentNumber}@s.whatsapp.net`, { text: message });
    }

    await ses.sock.sendMessage(`923008620417@s.whatsapp.net`, { text: message });
    await ses.sock.sendMessage(`923004013334@s.whatsapp.net`, { text: message });
    await ses.sock.sendMessage(`923076929940@s.whatsapp.net`, { text: message });
    await ses.sock.sendMessage(`923367674817@s.whatsapp.net`, { text: message });

    manageCampaignFor(sid, phone_numbers).catch(()=>{});
    return res.json({ success: true, sid, message: 'Campaign started' });
  } catch (err) {
    console.error(`[${sid}] start-campaign error`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/:sid/start-followup', async (req, res) => {
  const sid = req.params.sid;
  const apiKey = req.headers['x-den-api-key'];
  if (apiKey !== DEN_API_KEY) return res.json({ success: false, message: 'Forbidden' });

  const { phone_numbers } = req.body;
  if (!phone_numbers || !Array.isArray(phone_numbers) || phone_numbers.length === 0) {
    return res.json({ success: false, message: 'Invalid phone_numbers' });
  }

  try {
    const ses = getSes(sid);
    if (!ses.isConnected || !ses.sock) return res.status(400).json({ error: 'WhatsApp is not connected' });

    let message = `🚀 *Followup Started* [${sid}]\n\n` +
      `Total Numbers: ${phone_numbers.length}\n` +
      `Start Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}\n\n` +
      `You will receive a summary once the followup is completed.`;
    
    const agentNumber = AGENTS_NUMBERS_WITH_SESSIONS_IDS[sid];
    if (agentNumber) {
      await ses.sock.sendMessage(`${agentNumber}@s.whatsapp.net`, { text: message });
    }

    await ses.sock.sendMessage(`923008620417@s.whatsapp.net`, { text: message });
    await ses.sock.sendMessage(`923004013334@s.whatsapp.net`, { text: message });
    await ses.sock.sendMessage(`923076929940@s.whatsapp.net`, { text: message });
    await ses.sock.sendMessage(`923367674817@s.whatsapp.net`, { text: message });

    manageFollowupFor(sid, phone_numbers).catch(()=>{});
    return res.json({ success: true, sid, message: 'Followup started' });
  } catch (err) {
    console.error(`[${sid}] start-followup error`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// === Backward compatibility endpoints (map to DEFAULT_SID = farhan) ===
app.get('/start-session', (req, res) => res.redirect(`/${DEFAULT_SID}/start-session`));

app.get('/status', (req, res) => {
  const ses = Sessions[DEFAULT_SID];
  if (ses?.isConnected && ses?.sock?.user) {
    return res.json({ status: 'connected', user: ses.user, sid: DEFAULT_SID });
  }
  return res.json({ status: ses ? 'disconnected' : 'not_initialized', sid: DEFAULT_SID, lastQR: ses?.lastQR || null });
});

app.post('/send', async (req, res) => {
  const sid = DEFAULT_SID;
  try {
    const ses = getSes(sid);
    if (!ses.isConnected || !ses.sock) return res.status(400).json({ error: 'WhatsApp is not connected' });
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Missing number or message' });
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
    await ses.sock.sendMessage(jid, { text: message });
    return res.json({ success: true, sid, to: number, message });
  } catch (err) {
    console.error(`[${sid}] send error`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/send-custom', async (req, res) => {
  req.params.sid = DEFAULT_SID;
  return app._router.handle(req, res, 'post', `/${DEFAULT_SID}/send-custom`);
});

app.post('/start-campaign', async (req, res) => {
  req.params.sid = DEFAULT_SID;
  return app._router.handle(req, res, 'post', `/${DEFAULT_SID}/start-campaign`);
});

// Export & Flush all conversations of all agents
app.get('/export-conversations', async (req, res) => {
  try {
    // const apiKey = req.headers['x-den-api-key'];
    // if (apiKey !== DEN_API_KEY) {
    //   return res.status(403).json({ success: false, message: 'Forbidden' });
    // }

    // Agents come from your config
    const agents = SESSION_IDS; // e.g., ['farhan','amber','rubaisha']

    // Atomically drain all -> returns aggregated data + counts
    const { payload, totals } = drainAll(agents);

    const _payload = new URLSearchParams();
    // create request payload agents, totals, data
    _payload.append('agents', JSON.stringify(agents));
    _payload.append('totals', JSON.stringify(totals));
    _payload.append('data', JSON.stringify(payload));

    const endpoint = 'den-inquiry/api-receive-exported-conversations';
    const response = await makeServerPostApiCall(_payload, endpoint);
    // command to clear console log
    console.clear();

    // if server response is success true then delete local logs
    if (response && response.success) {
      cleanTempDrainDirs();
    }

    return res.json({
      success: true,
      message: 'Conversations exported successfully',
    });
  } catch (e) {
    console.error('export-conversations error:', e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// ===== Boot: try to auto-start both sessions if auth folders exist =====
(async () => {
  for (const sid of SESSION_IDS) {
    const authDir = `${SESSION_PREFIX}_${sid}`;
    if (fs.existsSync(path.join(__dirname, authDir))) {
      console.log(`[${sid}] 🔍 Existing session found. Attempting to reconnect...`);
      startSockFor(sid).catch(err => console.error(`[${sid}] ❌ Auto-start failed`, err));
    } else {
      console.log(`[${sid}] ℹ️ No previous session found. Open /${sid}/start-session to scan QR.`);
    }
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running at http://localhost:' + PORT);
});
