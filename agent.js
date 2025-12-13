require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;
const axios = require('axios');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const WHISPER_API_KEY = process.env.WHISPER_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const OpenAI = require('openai');
const openai = new OpenAI({
    apiKey: WHISPER_API_KEY,
});

const app = express();
app.use(express.json());

const fs = require('fs');
const path = require('path');

const sessionPath = path.join(__dirname, 'auth_info_baileys');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json')));
const citiesText = fs.readFileSync(path.join(__dirname, 'cities.txt'), 'utf-8');

// CHECK_NUMBER rule is to check all inquiries against a number
const customRules = ['i1', 'i2', 's1', '???'];
const ADMINS_NUMBERS = ['923344778077', '923367674817', '923004013334', '923076929940']; // without @s.whatsapp.net

let sock;
let isConnected = false;

const PORT = process.env.PORT || 3000;
const SERVER_BASE_SECURE_URL = process.env.SERVER_BASE_URL;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL;
const DEN_API_KEY = "denapi4568";

const CLIENTS = {}


// Create WhatsApp connection
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    return new Promise((resolve, reject) => {
        sock = makeWASocket({
            auth: state,
            // printQRInTerminal: true,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('🔐 QR Generated', qr);
                resolve({ status: 'qr', data: qr });
            }

            if (connection === 'open') {
                isConnected = true;
                console.log('✅ WhatsApp connected');
                resolve({ status: 'connected' });
            }

            if (connection === 'close') {
                let reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                if(shouldReconnect) {
                    startSock();
                }else {
                    deleteSession();
                }
                // if (reason === DisconnectReason.badSession) {
                //     console.log(
                //     `Bad Session File, Going to logout and delete session and scan again.`
                //     );
                //     sock.logout();
                //     deleteSession();
                //     return;
                // } else if (reason === DisconnectReason.connectionClosed) {
                //     console.log("Connection closed, reconnecting....");
                //     startSock();
                // } else if (reason === DisconnectReason.connectionLost) {
                //     console.log("Connection lost from server, reconnecting...");
                //     startSock();
                // } else if (reason === DisconnectReason.connectionReplaced) {
                //     console.log(
                //         "Connection replaced, another new session opened, please close the current session first"
                //     );
                //     sock.logout();
                //     deleteSession();
                //     return;
                // } else if (reason === DisconnectReason.loggedOut) {
                //     console.log(
                //         `Device closed, please delete session and scan again.`
                //     );
                //     // sock.logout();
                //     deleteSession();
                //     return;
                // } else if (reason === DisconnectReason.restartRequired) {
                //     console.log("Restart required, restarting...");
                //     startSock();
                // } else if (reason === DisconnectReason.timedOut) {
                //     console.log("Connection timed out, reconnecting...");
                //     startSock();
                // } else {
                //     deleteSession();
                //     sock.end(
                //     `Unknown disconnection reason: ${reason}|${lastDisconnect.error}`
                //     );
                // }
            }
        });

        // incoming message handler
        sock.ev.on('messages.upsert', async (m) => {
            let clientFirstMessage = false;
            if (m.type !== 'notify') return;
            const msg = m.messages[0];


            // ⏱️ Filter out old messages (e.g., older than 60 seconds)
            const now = Date.now();
            const messageTimestamp = msg.messageTimestamp * 1000; // convert to ms
            if ((now - messageTimestamp) > 60 * 1000) {
                console.log('⏳ Ignored old message:', new Date(messageTimestamp));
                return;
            }

            const sender = msg.key.remoteJid;
            // check sender is in CLIENTS as key or not
            // if not then add it and set value to 1
            // if yes and the value is 0 then return ignore because agent mode is off this client
            processedSender = sender.replace('@s.whatsapp.net', '')

            if(!(processedSender in CLIENTS)) {
                if(!ADMINS_NUMBERS.includes(processedSender)) {
                    CLIENTS[processedSender] = 1;
                    clientFirstMessage = true;
                }
            } else {
                if(CLIENTS[processedSender] === 0) {
                    return;
                }
            }


            const messageType = Object.keys(msg.message)[0];

            let text = '';
            
            if (messageType === 'conversation') {
                text = msg.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                text = msg.message.extendedTextMessage.text;
            }

            // checking custom rules //
            const textParts = text.split(' ');
            const textFirstValue = textParts[0].trim().toLowerCase();

            if(ADMINS_NUMBERS.includes(processedSender)) {
                // check if first word is 1 or 0 then set state
                if (textFirstValue === '1') {
                    CLIENTS[textParts[1].trim().toLowerCase()] = 1; // set state to active
                } else if (textFirstValue === '0') {
                    CLIENTS[textParts[1].trim().toLowerCase()] = 0; // set state to inactive
                }
            }

            const messageContent = msg.message;
            const audioMsg = messageContent?.audioMessage || messageContent?.message?.audioMessage;
            if(audioMsg) {
                // 1) download media stream (Baileys helper)
                const stream = await downloadContentFromMessage(audioMsg, 'audio'); // returns async iterable
                const oggPath = path.join(__dirname, `wa-${msg.key.id}.ogg`);
                await streamToFile(stream, oggPath);

                // 2) convert to WAV (16k mono) for best STT compatibility
                const wavPath = path.join(__dirname, `wa-${msg.key.id}.wav`);
                await new Promise((resolve, reject) => {
                    // ffmpeg -i input.ogg -ar 16000 -ac 1 output.wav
                    const ff = spawn('ffmpeg', ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', wavPath]);
                    ff.stderr.on('data', d => {/* optionally log */});
                    ff.on('exit', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
                });

                // 3) call OpenAI / Whisper transcription (example)
                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(wavPath),
                    model: 'whisper-1'
                });
            
                // 4) reply with the transcript (or store it)
                text = transcription.text;
            }

            const thread = await createThread();
            const threadId = thread.id;

            // get actuall message logic
            const message = text;
            await addMessage(threadId, message);

            const run = await runAssistant(threadId);
            const result = await checkingStatus(threadId, run.id);

            if (result.success) {
                const messages = result.data;
                const assistantReply =
                (Array.isArray(messages) && messages[0] && String(messages[0]).trim()) ||
                'ٹھیک ہے، میں آپ کی مدد کے لیے موجود ہوں۔';
                try {
                    const oggBuffer = await ttsToWhatsAppVoice(assistantReply);
                
                    await sock.sendMessage(sender, {
                        audio: oggBuffer,
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,          // show as voice note
                    });
                } catch (e) {
                    console.error('TTS/Send voice failed, falling back to text:', e);
                    await sock.sendMessage(sender, { text: assistantReply });
                }
            } else {
                console.error('Error checking status:', result.data);
            }

            

            // check is this first message comming from FB ads click to WhatsApp
            if (text === 'Hello! Can I get more info on this?' && false) { // disabled for now
                await sock.readMessages([msg.key]);
                await sock.sendPresenceUpdate('composing', sender); // send typing indicator
                const firstImageUrl  = 'https://staging.denontek.com.pk/public/images/10600.jpeg';
                const secondImageUrl = 'https://staging.denontek.com.pk/public/images/13200.jpeg';
                const thirdImageUrl  = 'https://staging.denontek.com.pk/public/images/14200.jpeg';
              
                // fetch in parallel
                const [firstImageBuffer, secondImageBuffer, thirdImageBuffer] =
                  await Promise.all([
                    fetchImageBuffer(firstImageUrl, firstImageUrl.replace(/^https:\/\//i, 'http://')),
                    fetchImageBuffer(secondImageUrl, secondImageUrl.replace(/^https:\/\//i, 'http://')),
                    fetchImageBuffer(thirdImageUrl, thirdImageUrl.replace(/^https:\/\//i, 'http://')),
                  ]);
              
                // if any failed, exit silently
                if (!firstImageBuffer || !secondImageBuffer || !thirdImageBuffer) {
                    await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                    return;
                }
              
                // try sending; if any send fails, stop silently
                try {
                  await sock.sendMessage(sender, {
                    image: firstImageBuffer,
                    mimetype: 'image/jpeg',
                    caption: 'Rs 10600/-',
                  });
                  await sock.sendMessage(sender, {
                    image: secondImageBuffer,
                    mimetype: 'image/jpeg',
                    caption: 'Rs 13200/-',
                  });
                  await sock.sendMessage(sender, {
                    image: thirdImageBuffer,
                    mimetype: 'image/jpeg',
                    caption: 'Rs 14200/-',
                  });
                  await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                } catch {
                    await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                    return;
                }
            }




            // Ignore system messages and messages sent by yourself
            if (!msg.message || msg.key.fromMe) return;

            console.log('📩 From:', sender);
            console.log('💬 Text:', text);

        });
    });
}

// helper: save stream -> buffer/file
async function streamToFile(stream, filePath) {
    const write = fs.createWriteStream(filePath);
    for await (const chunk of stream) write.write(chunk);
    write.end();
    await new Promise(r => write.on('close', r));
}

async function createThread() {
    const thread = await openai.beta.threads.create();
    return thread;
}

async function addMessage(threadId, message) {
    console.log('Adding a new message to thread: ' + threadId);
    const response = await openai.beta.threads.messages.create(
        threadId,
        {
            role: "user",
            content: message
        },
        instructions= "You are a helpful assistant that responds in Urdu. Please answer in short sentences. at the end we need to create a voice note response so please use simple language and choose those words that are easily convertable to speech."
    );
    return response;
}

async function runAssistant(threadId) {
    console.log('Running assistant for thread: ' + threadId)
    const response = await openai.beta.threads.runs.create(
        threadId,
        { 
          assistant_id: ASSISTANT_ID,
          tools: [{type: "file_search"}],
          tool_resources: {
            file_search: {
              vector_store_ids: ['vs_67f6e283ec2081919013a6f8871472d3']
            }
          }
          // Make sure to not overwrite the original instruction, unless you want to
        }
      );

    // console.log(response)

    return response;
}

async function checkingStatus(threadId, runId) {
    try {
        let retries = 20; // max retry attempts
        let delay = 2000; // wait 2 seconds between retries

        while (retries > 0) {
            const response = await openai.beta.threads.runs.retrieve(threadId, runId);
            if (response.status === 'completed') {
                const messagesList = await openai.beta.threads.messages.list(threadId);
                let messages = [];

                messagesList.body.data.forEach(message => {
                    // console role and message
                    // console.log('Role:', message.role);
                    // console.log('Message:', message.content);
                    if (message.role === "assistant") {
                        const textParts = message.content.filter(c => c.type === 'text');
                        textParts.forEach(part => messages.push(part.text.value));
                    }
                });

                return { success: true, data: messages };
            } else if (response.status === 'failed') {
                return { success: false, data: { error: 'Run failed' } };
            }

            // Wait before checking again
            await new Promise(resolve => setTimeout(resolve, delay));
            retries--;
        }

        return { success: false, data: { error: 'Timeout waiting for run to complete' } };

    } catch (err) {
        return { success: false, data: err };
    }
}

async function ttsToWhatsAppVoice(
    text,
    {
      voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
      opusBitrate = '32k',                 // WhatsApp-friendly
      modelId = 'eleven_multilingual_v2',  // good for Urdu/Punjabi
    } = {}
  ) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  
    // 1) Try to get OGG/Opus directly (best case: no conversion)
    try {
      const res = await axios.post(
        url,
        { text, model_id: modelId },
        {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/ogg', // ask for ogg/opus
          },
          responseType: 'arraybuffer',
          timeout: 60000,
        }
      );
  
      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const buf = Buffer.from(res.data);
  
      if (contentType.includes('ogg')) {
        // Great—already OGG/Opus
        return buf;
      }
  
      // If not OGG, fall through to MP3->OGG conversion
      await new Promise((_, reject) =>
        reject(new Error(`Unexpected content-type: ${contentType}`))
      );
    } catch (_) {
      // 2) Fallback: request MP3 and convert with ffmpeg → OGG/Opus
      const res = await axios.post(
        url,
        { text, model_id: modelId },
        {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 60000,
        }
      );
  
      const mp3Buf = Buffer.from(res.data);
      const tmp = path.join(__dirname, `tts-${Date.now()}`);
      const mp3Path = `${tmp}.mp3`;
      const oggPath = `${tmp}.ogg`;
  
      await fs.promises.writeFile(mp3Path, mp3Buf);
  
      await new Promise((resolve, reject) => {
        execFile(
          'ffmpeg',
          ['-y', '-i', mp3Path, '-c:a', 'libopus', '-b:a', opusBitrate, oggPath],
          (err) => (err ? reject(err) : resolve())
        );
      });
  
      const oggBuf = await fs.promises.readFile(oggPath);
      fs.promises.unlink(mp3Path).catch(() => {});
      fs.promises.unlink(oggPath).catch(() => {});
      return oggBuf;
    }
}
  

function deleteSession() {
    isConnected = false;
    sock = null;
    // remove session 
    const sessionDir = path.join(__dirname, 'auth_info_baileys');
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

app.get('/', (req, res) => {
    return res.send('<h2>✅ Server is running.</h2>');
});

app.get('/status', (req, res) => {
    if (sock && isConnected && sock.user) {
        return res.json({
            status: 'connected',
            user: sock.user,
        });
    }

    return res.json({
        status: 'disconnected',
    });
});

app.post('/send-custom', async (req, res) => {
    // check headers for x-api-key
    const apiKey = req.headers['x-den-api-key'];
    if (apiKey !== "denapi4568") {
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const { number, type } = req.body;

    if(!type) {
        return res.json({ success: false, message: 'Missing type' });
    }

    // currently we are going to handle marketing type only
    if(type !== 'marketing') {
        return res.json({ success: false, message: 'Invalid type' });
    }

    if (!isConnected || !sock) {
        return res.json({ success: false, message: 'WhatsApp is not connected' });
    }

    if (!number) {
        return res.json({ success: false, message: 'Missing number' });
    }

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

    try {
        if(type === 'marketing') {
            // send image with caption
            const caption =
                    "🔔 *DenonTek – Automatic School Bell System* 🔔\n\n" +
                    "Introducing our **WiFi-enabled bell controller** made for schools in Pakistan. 🇵🇰\n\n" +
                    "✅ 100+ Alarms | ✅ Morning & Evening Shifts\n" +
                    "✅ Accurate Timing | ✅ 1-Year Warranty\n" +
                    "✅ Plug & Play\n\n" +
                    "📍 *Apna city name bhejein aur janen aap ke sheher mein kon kon se schools yeh system use kar rahay hain.*\n\n" +
                    "📲 WhatsApp for orders: 03344778077\n\n" +
                    "Reply *STOP* to unsubscribe.";
            await sock.sendMessage(jid, {
                image: { url: 'http://denontek.com.pk/image/catalog/new_logo_2.jpg' },
                caption
            });

            return res.json({ success: true, message: 'Message sent' });
        }

        return res.json({ success: false, message: 'Unhandled type' });
    } catch (err) {
        console.error('❌ Send error:', err);
        return res.json({ success: false, message: err.message });
    }

})



// Start session and return QR
app.get('/start-session', async (req, res) => {
    if (isConnected && sock?.user) {
        return res.send('<h2>✅ WhatsApp is already connected.</h2>');
    }

    try {
        const result = await startSock();

        if (result.status === 'connected') {
            return res.send('<h2>✅ WhatsApp is already connected.</h2>');
        }

        if (result.status === 'qr') {
            const html = `
            <html>
                <head>
                    <title>Scan WhatsApp QR</title>
                    <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
                </head>
                <body style="text-align:center; font-family:sans-serif;">
                    <h2>📱 Scan this QR Code</h2>
                    <canvas id="qrcanvas"></canvas>

                    <script>
                        const qrString = ${JSON.stringify(result.data)};
                        QRCode.toCanvas(document.getElementById('qrcanvas'), qrString, function (error) {
                            if (error) console.error('QR error:', error);
                            console.log('✅ QR rendered!');
                        });
                    </script>
                </body>
            </html>
        `;
        return res.send(html);
        }

        res.send('<h2>⏳ Waiting for QR Code...</h2>');
    } catch (err) {
        console.error('❌ Error initializing:', err);
        res.status(500).send(`<h2>❌ Error: ${err.message}</h2>`);
    }
});

app.post('/webhook', async(req, res) => {
    console.log('🔔 Webhook received');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    const { trackingNumber, orderReferenceNumber, statusUpdateDatetime, orderStatus } = req.body;

    // check if the orderStatus is in the list of statuses
    if(!['PostEx WareHouse', 'Out For Delivery', 'Attempted', 'Delivered'].includes(orderStatus)) {
        res.status(200).send('Webhook received');
    }

    if(orderStatus.includes('En-Route to {14} warehouse')) {
        res.status(200).send('Webhook received');
    }


    let numberToSend = '923344778077';
    let needToSendFarhan = false;

    // check if orderReferenceNumber starts with F-03xxxxxxxxxx
    if(orderReferenceNumber.startsWith('F-')) {
        needToSendFarhan = true;
        
        // split the orderReferenceNumber with -
        numberToSend = orderReferenceNumber.split('-')[1];
    }

    // check if the orderReferenceNumber is phone number if yes then replace start 0 with 92
    if (orderReferenceNumber.startsWith('0') && orderReferenceNumber.length == 11) {
        numberToSend = orderReferenceNumber.replace('0', '92');
    }

    //  remove spaces
    numberToSend = numberToSend.replace(/\s/g, '');

    numberToSend = numberToSend + '@s.whatsapp.net';

    // Subtract 5 hours from datetime
    const date = new Date(statusUpdateDatetime);
    date.setHours(date.getHours() - 5);

    // Status map
    const commonDesc = "Your parcel is heading towards your city.";
    const commonIcon = "🚛";

    const statusMessages = {
    "Attempted":            { icon: "⚠️", desc: "Delivery attempt failed or the courier tried to contact you." },
    "Delivered":            { icon: "✅", desc: "Your parcel has been delivered successfully." },
    "Delivery En-Route":    { icon: "🚚", desc: "Courier is on the way to deliver your parcel." },
    "In Stock":             { icon: "📦", desc: "Your parcel is at the courier's facility." },
    "Transferred":          { icon: commonIcon, desc: commonDesc },
    "PostEx WareHouse":     { icon: commonIcon, desc: commonDesc },
    "En-Route to {14} warehouse": { icon: commonIcon, desc: commonDesc },
    "Under Verification":   { icon: "⚠️", desc: "Delivery attempt failed or under verification." },
    "Unbooked":             { icon: "🕒", desc: "Your parcel has been booked. Awaiting further updates." }
    };

    const { icon = "📦", desc = "Your parcel status is being updated." } = statusMessages[orderStatus] || {};

    const message = `${icon} Parcel Tracking Update

    🧾 Order Ref: ${orderReferenceNumber}
    🔢 Tracking Number: ${trackingNumber}
    📅 Last Updated: ${date.toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}
    🚚 Current Status: ${icon} ${orderStatus}

    ℹ️ ${desc}

    Thank you for your patience and for shopping with us!`;
    await sock.sendMessage(numberToSend, { text: message });
    
    // send this tracking details to Farhan as well.
    if(needToSendFarhan) {
        await sock.sendMessage('923367674817@s.whatsapp.net', { text: message });
    }

    // You can add your own logic here (e.g., verify signature, store data)

    res.status(200).send('Webhook received');
});


// Send message
app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected || !sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Missing number or message' });
    }

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: number, message });
    } catch (err) {
        console.error('❌ Send error:', err);
        res.status(500).json({ error: err.message });
    }
});

function sleep(time = 2000) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function makeServerPostApiCall(payload = {}, enpoint = '') {
    try {
        // API endpoint (start with https)
        let url = `${SERVER_BASE_SECURE_URL}/${enpoint}`;
        console.log("🌐 Making API call to:", url);

        // Ignore SSL errors (expired/self-signed certs)
        const httpsAgent = new https.Agent({  
            rejectUnauthorized: false  
        });

        const response = await axios.post(url, payload, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "x-den-api-key": DEN_API_KEY
            },
            httpsAgent
        });

        console.log("✅ API response:", response.data);

    } catch (error) {
        console.error("❌ API error:", error.message);

        // fallback: if HTTPS fails, try HTTP
        try {
            const fallbackUrl = `${SERVER_BASE_URL}/${enpoint}`;
            console.log("ℹ️ Attempting fallback to HTTP:", fallbackUrl);
            const response = await axios.post(fallbackUrl, payload, {
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

async function makeServerGetApiCall(endpoint = '') {
    try {
        // API endpoint (start with https)
        let url = `${SERVER_BASE_SECURE_URL}/${endpoint}`;
        console.log("🌐 Making API call to:", url);

        // Ignore SSL errors (expired/self-signed certs)
        const httpsAgent = new https.Agent({  
            rejectUnauthorized: false  
        });

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

        // fallback: if HTTPS fails, try HTTP
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
    // 1) Try HTTPS, ignoring bad certs
    try {
      const res = await axios.get(secureUrl, {
        responseType: 'arraybuffer',
        headers: { Accept: 'image/*' },
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: (s) => s >= 200 && s < 300,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),          // <-- critical difference
      });
      return Buffer.from(res.data);
    } catch (_) {
      // 2) Fallback to HTTP
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
      } catch (_) {
        return null; // stay silent on failure
      }
    }
};


if (fs.existsSync(sessionPath)) {
    console.log('🔍 Existing WhatsApp session found. Attempting to reconnect...');
    startSock().catch((err) => {
        console.error('❌ Failed to auto-start WhatsApp:', err);
    });
} else {
    console.log('ℹ️ No previous session found. Waiting for QR request...');
}

app.listen(PORT, () => {
    console.log('🚀 Server running at http://localhost:'+PORT);
});