require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;
const axios = require('axios');
const https = require('https');


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
const SERVER_BASE_SECURE_URL = "https://staging.denontek.com.pk";
const SERVER_BASE_URL = "http://staging.denontek.com.pk";
const DEN_API_KEY = "denapi4568";

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
            if(customRules.includes(textFirstValue)) {
                await sock.readMessages([msg.key]);
                await sock.sendPresenceUpdate('composing', sender); // send typing indicator

                if(textFirstValue === '???') {
                    const helpText = `*Available Commands:*\n\n` +
                    `1. *i1* - Get today's inquiries submitted by you.\n` +
                    `   _Example:_ TODAY_INQUIRIES\n\n` +
                    `2. *i2 <NUMBER>* - Check inquiries against a specific number.\n` +
                    `   _Example:_ CHECK_NUMBER\\n03001234567\n\n` +
                    `3. *???* - Display this help message.\n\n` +
                    `*Note:* Please ensure to use the exact command format as shown above.`;
                    await sock.sendMessage(sender, { text: helpText });
                }

                if(textFirstValue === 'i2') {
                    console.log('📞 CHECK_NUMBER rule triggered', textParts[1]);
                }

                if(textFirstValue === 'i1') {
                    const payload = new URLSearchParams();
                    payload.append("agent_number", sender.replace('@s.whatsapp.net', ''));
                    payload.append("type", "TODAY_INQUIRIES");
                    // payload.append("data", JSON.stringify({}));
                    const endpoint = 'den-inquiry/api-send-message';
                    await makeServerPostApiCall(payload, endpoint);
                }

                if(textFirstValue === 's1') {
                    let senderNumber = sender.replace('@s.whatsapp.net', '');
                    if(ADMINS_NUMBERS.includes(senderNumber)) {
                        const endpoint = 'den-inquiry/daily-sale-statistics';
                        await makeServerGetApiCall(endpoint);
                    }
                }

                await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
            }




            // Ignore system messages and messages sent by yourself
            if (!msg.message || msg.key.fromMe) return;

            console.log('📩 From:', sender);
            console.log('💬 Text:', text);

            // Look for matching rule
            const matchedRule = rules.find(rule =>
                rule.RuleStatus === true &&
                rule.Operand === '=' &&
                rule.RuleKeyword === text
            );

            if (matchedRule) {
                // mark as seen
                await sock.readMessages([msg.key]);

                console.log(`📜 Matched rule: ${matchedRule.RuleName}`);
                
                await sock.sendPresenceUpdate('composing', sender); // send typing indicator
                await sleep(3000); // simulate typing delay
                await sock.sendPresenceUpdate('paused', sender); // stop typing indicator

                await sock.sendMessage(sender, {
                    text: matchedRule.RuleMessage
                });
            }

            // special case for city names
            if(text.toLowerCase() == "cities list") {
                // mark as seen
                await sock.readMessages([msg.key]);

                await sock.sendPresenceUpdate('composing', sender); // send typing indicator
                await sleep(3000); // simulate typing delay
                await sock.sendPresenceUpdate('paused', sender); // stop typing indicator

                await sock.sendMessage(sender, {
                    text: `📍 *List of Cities:*\n\n${citiesText.trim()}`
                });
            }

            // IN FUTURE WE CAN DEFINE MULTIPLE RULES FOR LIKE ETC.
        });
    });
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