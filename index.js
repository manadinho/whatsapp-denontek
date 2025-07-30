const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;


const app = express();
app.use(express.json());

const fs = require('fs');
const path = require('path');

const sessionPath = path.join(__dirname, 'auth_info_baileys');

let sock;
let isConnected = false;

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
            // nothing
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


if (fs.existsSync(sessionPath)) {
    console.log('🔍 Existing WhatsApp session found. Attempting to reconnect...');
    startSock().catch((err) => {
        console.error('❌ Failed to auto-start WhatsApp:', err);
    });
} else {
    console.log('ℹ️ No previous session found. Waiting for QR request...');
}

app.listen(3100, () => {
    console.log('🚀 Server running at http://localhost:3100');
});