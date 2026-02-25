require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;
const axios = require('axios');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

const fs = require('fs');
const path = require('path');

const sessionPath = path.join(__dirname, 'auth_info_baileys');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json')));
const citiesText = fs.readFileSync(path.join(__dirname, 'cities.txt'), 'utf-8');

// CHECK_NUMBER rule is to check all inquiries against a number
const customRules = ['i1', 'i2', 's1', 'c1', 'c2', 'c3', '???']; // c1 means start campaign this is for Farahan only
const ADMINS_NUMBERS = ['923344778077', '923367674817', '923004013334', '923076929940', '923176063820']; // without @s.whatsapp.net

let sock;
let isConnected = false;

const PORT = process.env.PORT || 3000;
const SERVER_BASE_SECURE_URL = "https://staging.denontek.com.pk";
const SERVER_BASE_URL = "http://staging.denontek.com.pk";
const DEN_API_KEY = "denapi4568";

let campaignStartedAt = '';
let campaignSuccessNumbers = [];
let campaignFailureNumbers = [];
let campaignSuccessCount = 0;
let campaignFailureCount = 0;
let campaignStatus = 'not_started';

// Create WhatsApp connection
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const version = [2, 3000, 1033893291];
    return new Promise((resolve, reject) => {
        sock = makeWASocket({
            version,
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
                    const payload = new URLSearchParams();
                    payload.append("agent_number", sender.replace('@s.whatsapp.net', ''));
                    payload.append("type", "CHECK_NUMBER");
                    payload.append("data", [textParts[1]]);
                    const endpoint = 'den-inquiry/api-send-message';
                    await makeServerPostApiCall(payload, endpoint);
                }

                if(textFirstValue === 'i1') {
                    const payload = new URLSearchParams();
                    payload.append("agent_number", sender.replace('@s.whatsapp.net', ''));
                    payload.append("type", "TODAY_INQUIRIES");
                    // payload.append("data", []); // Adding an empty array for consistency
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

                // this section is for Farhan only right now
                if(textFirstValue === 'c1') {
                    if(campaignStatus === 'in_progress') {
                        await sock.sendMessage(sender, { text: '❌ A campaign is already in progress. Please wait until it is completed.' });
                        await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                        return;
                    }

                    let senderNumber = sender.replace('@s.whatsapp.net', '');

                    if(!ADMINS_NUMBERS.includes(senderNumber)) {
                        await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                        await sock.sendMessage(sender, { text: '❌ You are not authorized to start campaign.' });
                        return;
                    }

                    await sock.sendMessage(sender, { text: '🚀 Campaign start request received. Please wait it will start in few minutes.' });
                    const endpoint = 'den-campaigns/start';
                    await makeServerGetApiCall(endpoint);
                    await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                    return;
                }

                if(textFirstValue === 'c2') {
                    if(campaignStatus === 'not_started') {
                        await sock.sendMessage(sender, { text: '❌ No Campaign is running at the moment.' });
                        await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                        return;
                    }

                    // prepare and send a message about total numbers in current campaign and when it started and how many are successful and failed
                    const endedAt = Date.now();
                    const durationMs = endedAt - campaignStartedAt;
                    const durationHuman = humanizeDuration(durationMs); // e.g., "1 hour 5 minutes"
                    let message = `*Campaign Status*\n\n` +
                                  `Status: ${campaignStatus}\n` +
                                  `Started At: ${new Date(campaignStartedAt).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}\n` +
                                  `Duration: ${durationHuman}\n` +
                                  `Successful: ${campaignSuccessCount}\n` +
                                  `Failed: ${campaignFailureCount}\n\n` +
                                  `You will receive a summary once the campaign is completed.`;

                    await sock.sendMessage(sender, { text: message });
                    await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                    return;
                }

                if(textFirstValue === 'c3') {
                    if(campaignStatus !== 'in_progress') {
                        await sock.sendMessage(sender, { text: '❌ No Campaign is running at the moment.' });
                        await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
                        return;
                    }
                    
                    campaignStatus = 'not_started'; // this will stop the campaign after current number is processed
                    await sock.sendMessage(sender, { text: '🛑 Campaign stop request received. The campaign will stop shortly.' });
                    return;
                }

                await sock.sendPresenceUpdate('paused', sender); // stop typing indicator
            }

            // check is this first message comming from FB ads click to WhatsApp
            if (['What are your delivery options?', 'Hello! Can I get more info on this?', 'Can you check the price of a product?', 'Price?'].includes(text)) {
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

app.post('/start-campaign', async (req, res) => {
    const apiKey = req.headers['x-den-api-key'];
    if (apiKey !== "denapi4568") {
        return res.json({ success: false, message: 'Forbidden' });
    }

    const { phone_numbers } = req.body;

    if(!phone_numbers || !Array.isArray(phone_numbers) || phone_numbers.length === 0) {
        return res.json({ success: false, message: 'Invalid phone_numbers' });
    }

    if (!isConnected || !sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected' });
    }

    // send message to admins that campaign is started
    let message = `🚀 *Campaign Started*\n\n` +
                    `Total Numbers: ${phone_numbers.length}\n` +
                    `Start Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}\n\n` +
                    `You will receive a summary once the campaign is completed.`;
        
    await sock.sendMessage(`923008620417@s.whatsapp.net`, { text: message });   
    await sock.sendMessage(`923004013334@s.whatsapp.net`, { text: message });   
    await sock.sendMessage(`923076929940@s.whatsapp.net`, { text: message });
    await sock.sendMessage(`923367674817@s.whatsapp.net`, { text: message });
    
    await manageCampaign(phone_numbers);
    return res.json({ success: true, message: 'Campaign started' });


})

async function manageCampaign(phone_numbers = []) {

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
        

        // reset campaign variables
        resetCampaignVariables();

        campaignStartedAt = Date.now();
        campaignStatus = 'in_progress';

        for(let i = 0; i < phone_numbers.length; i++) {
            if(campaignStatus !== 'in_progress') {
                console.log('🛑 Campaign stopped by admin request.');
                break;
            }
            
            const participant = phone_numbers[i];
            try {
                
                await sock.sendMessage(participant, {caption: message, image: imageBuffer});

                // dynamic wait 20 to 50 seconds
                const waitTime = Math.floor(Math.random() * 30) + 20;
                console.log('==Waiting:', waitTime);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                campaignSuccessCount++;
                campaignSuccessNumbers.push(participant);
            } catch (error) {
                campaignFailureCount++;
                campaignFailureNumbers.push(participant);
                continue;
            }
        }
    } catch (err) {
        await sock.sendMessage(`923008620417@s.whatsapp.net`, { text: "**ERROR TYPE: Campaing Error**\n\n"+err.message });   
        await sock.sendMessage(`923004013334@s.whatsapp.net`, { text: "**ERROR TYPE: Campaing Error**\n\n"+err.message });   
        await sock.sendMessage(`923076929940@s.whatsapp.net`, { text: "**ERROR TYPE: Campaing Error**\n\n"+err.message });   
        console.error('❌ Send error:', err);
    }

    const endedAt = Date.now();
    const durationMs = endedAt - campaignStartedAt;
    const durationHuman = humanizeDuration(durationMs); // e.g., "1 hour 5 minutes"

    // write a summary message to send admins
    let summaryMessage = `*Campaign Summary*\n\n` +
        `Total Numbers: ${phone_numbers.length}\n` +
        `Successful: ${campaignSuccessCount}\n` +
        `Failed: ${campaignFailureCount}\n` +
        `Duration: ${durationHuman}\n\n`;
    
    await sock.sendMessage(`923008620417@s.whatsapp.net`, { text: summaryMessage });   
    await sock.sendMessage(`923004013334@s.whatsapp.net`, { text: summaryMessage });   
    await sock.sendMessage(`923076929940@s.whatsapp.net`, { text: summaryMessage });
    await sock.sendMessage(`923367674817@s.whatsapp.net`, { text: summaryMessage });

    const payload = new URLSearchParams();
    // add success and failure array to payload
    payload.append("success_numbers", JSON.stringify(campaignSuccessNumbers));
    payload.append("failure_numbers", JSON.stringify(campaignFailureNumbers));
    payload.append("success_count", campaignSuccessCount);
    payload.append("failure_count", campaignFailureCount);
    // payload.append("data", []); // Adding an empty array for consistency
    const endpoint = 'den-campaigns/mark-completed';
    await makeServerPostApiCall(payload, endpoint);
    resetCampaignVariables();
}

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
  
    // keep only the most significant units (e.g., "1 hour 5 minutes")
    const top = parts.slice(0, maxUnits);
    return top.length === 1 ? top[0] : `${top.slice(0, -1).join(' ')} ${top.length > 1 ? '' : ''}${top.length > 1 ? top.slice(-1) : ''}`.trim() || top.join(' ');
  }

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

function resetCampaignVariables() {
    campaignStartedAt = '';
    campaignSuccessNumbers = [];
    campaignFailureNumbers = [];
    campaignSuccessCount = 0;
    campaignFailureCount = 0;
    campaignStatus = 'not_started';
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