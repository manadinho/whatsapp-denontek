// imran.js
const axios = require('axios');
const financeGroupJid = '120363422059822749@g.us';
const fs = require('fs');
const path = require('path');
const SERVER_BASE_SECURE_URL = "https://staging.denontek.com.pk";
const SERVER_BASE_URL = "http://staging.denontek.com.pk";
const DEN_API_KEY = "denapi4568";
const AI_URL = "http://165.22.243.143/ai/api/chat";
let _SOCK;


/**
 * Handle all incoming messages for session "imran".
 * This function is called BEFORE any shared logic in messages.upsert,
 * and if it runs, the parent handler returns early.
 *
 * @param {object} deps
 * @param {object} deps.ses      - Sessions[sid] object
 * @param {object} deps.sock     - Baileys socket for this sid
 * @param {string} deps.sid      - should be "imran"
 * @param {object} deps.msg      - full incoming Baileys message
 * @param {string} deps.sender   - remoteJid ("923xx@s.whatsapp.net")
 * @param {boolean} deps.isOutgoing
 * @param {string} deps.text     - extracted text (may be "")
 * @param {string} deps.messageType
 * @param {number} deps.messageTimestampMs
 */
 
async function imranHandler({
    ses,
    sock,
    sid,
    msg,
    sender,
    isOutgoing,
    text,
    messageType,
    messageTimestampMs,
}) {
    try {
        _SOCK = sock;

        if(sender === financeGroupJid && isOutgoing) { //  MY-FINANCE GROUP to manage cashbook
            // Example: you can do whatever you want here
            // Read + reply
            await sock.readMessages([msg.key]);

            createTransactionCall(text, sock);
        }

        // TODO: your custom logic (rules, AI replies, CRM sync, etc.)
        // e.g.
        // if (!isOutgoing && text?.toLowerCase() === 'ping') {
        //     await sock.sendMessage(sender, { text: 'pong from imran route' });
        // }

    } catch (err) {
        console.error(`[${sid}] [IMRAN HANDLER ERROR]`, err);
        // optional: alert admins
        try {
            await sock.sendMessage(`923004013334@s.whatsapp.net`, { text: `**IMRAN HANDLER ERROR** ${err.message}` });
        } catch (_) {}
    }
}

function createTransactionCall(text, sock) {
    let data = JSON.stringify({
        "model": "deepseek-v3.1:671b-cloud",
        "messages": [
            {
                "role": "system",
                "content": "You are an assistant for a financial application. Below are the available API routes and their expected payloads:\n\n" +
                "1. POST /finance/transaction\n" +
                "   Payload: {\n" +
                "     \"amount\": number,\n" +
                "     \"categoryName\": string,\n" +
                "     \"type\": \"debit\" | \"credit\",\n" +
                "     \"note\": string\n" +
                "   }\n\n" +
                "2. POST /finance/transaction/delete\n" +
                "   Payload: {\n" +
                "     \"id\": number\n" +
                "   }\n\n" +
                "3. POST /finance/transaction/edit\n" +
                "   Payload: {\n" +
                "     \"id\": number // required\n" +
                "     \"amount\": number, // optional\n" +
                "     \"type\": \"debit\" | \"credit\", // optional\n" +
                "     \"note\": string // optional\n" +
                "   }\n\n" +
                "4. POST /finance/transactions // list all transactions\n" +
                "   Payload: {\n" +
                "     \"skip\": number, // optional\n" +
                "     \"take\": number, // optional\n" +
                "   }\n\n" +
                "4. POST /finance/transaction/summary // summary of all transactions\n" +
                "   Payload: {\n" +
                "     \"start\": string, // optional\n" +
                "     \"end\": string, // optional\n" +
                "   }\n\n" +
                "Your job is to:\n" +
                "- Read the input text below (user’s transcribed voice input).\n" +
                "- Determine if it matches one of the two routes above.\n" +
                "- If yes, respond with a JSON object in the following format:\n" +
                "  {\n" +
                "    \"endpoint\": \"/finance/transaction\",\n" +
                "    \"payload\": {\n" +
                "      \"amount\": 1000,\n" +
                "      \"categoryName\": \"Grocery\",\n" +
                "      \"type\": \"debit\",\n" +
                "      \"note\": \"groceries from Imtiaz store\"\n" +
                "    }\n" +
                "  }\n\n" +
                "OR\n\n" +
                "  {\n" +
                "    \"endpoint\": \"/finance/category\",\n" +
                "    \"payload\": {\n" +
                "      \"name\": \"Fuel\"\n" +
                "    }\n" +
                "  }\n\n" +
                "- The value of `type` in /finance/transaction must be **either \"debit\" or \"credit\" only**.\n" +
                "- If the input is unclear or does not clearly map to a route or valid payload, respond only with this sentence:\n" +
                "  \"Unable to determine the endpoint or prepare the payload from the given input.\""
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

    let config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: AI_URL,
            headers: { 
                'Content-Type': 'application/json'
            },
            auth: {
                username: 'imran_israr',
                password: 'Manadinho786#' // MOVE TO ENV
            },
            data : data
        };

        axios.request(config)
        .then(async (response) => {
            const aiReply = response.data?.message?.content?.trim();

            // Check for fallback message
            if (aiReply === "Unable to determine the endpoint or prepare the payload from the given input.") {
                sock.sendMessage(financeGroupJid, { text: aiReply });
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(aiReply);
                console.log('=======parsed', parsed)
            } catch (err) {
                console.error("❌ Invalid JSON from AI:", err);
                sock.sendMessage(financeGroupJid, { text: "❌ Invalid JSON from AI:" });
                return;
            }

            if (!parsed.endpoint || !parsed.payload) {
                console.error("❌ AI response missing required fields.");
                sock.sendMessage(financeGroupJid, { text: "❌ AI response missing required fields." });
                return;
            }

            try{
                const apiRes = await axios.post(`${SERVER_BASE_SECURE_URL}${parsed.endpoint}`, {...parsed.payload, userId: 1}, {
                    headers: {
                        "Content-Type": "application/json",
                        "x-den-api-key": DEN_API_KEY,
                    }  
                });

                const message = formatTransactionMessageSimple(parsed.endpoint, apiRes.data);
                if(['/finance/transactions'].includes(parsed.endpoint)) {
                        // send as text file
                        sendTextFile(message, 'transactions.txt');
                        return;
                }


                _SOCK.sendMessage(financeGroupJid, { text: message });
            } catch(apiErr) {
                // fallback: try non-secure call
                try{
                    const apiRes = await axios.post(`${SERVER_BASE_URL}${parsed.endpoint}`, {...parsed.payload, userId: 3334}, {
                        headers: {
                            "Content-Type": "application/json",
                            "x-den-api-key": DEN_API_KEY,
                        }  
                    });

                    const message = formatTransactionMessageSimple(parsed.endpoint, apiRes.data);
                    if(['/finance/transactions'].includes(parsed.endpoint)) {
                            // send as text file
                            sendTextFile(sock, message, 'transactions.txt');
                            return;
                        }

                    _SOCK.sendMessage(financeGroupJid, { text: message });
                    
                } catch(e){
                    console.error("❌ API Call Failed:", apiErr.response?.data || apiErr.message);
                    sock.sendMessage(financeGroupJid, { text: `❌ API Call Failed: ${apiErr.response?.data?.message || apiErr.message}` });
                }
            }

            // Make actual API call to the determined endpoint
            // axios.post(`http://localhost:3300${parsed.endpoint}`, {...parsed.payload, userId: 3334})
            //     .then(apiRes => {
            //         const message = formatTransactionMessageSimple(parsed.endpoint, apiRes.data);
            //         // add those routes here which need text file
            //         if(['/api/transactions'].includes(parsed.endpoint)) {
            //             // send as text file
            //             sendTextFile(sock, message, 'transactions.txt');
            //             return;
            //         }

            //         sock.sendMessage(financeGroupJid, { text: message });
            //     })
            //     .catch(apiErr => {
            //         console.error("❌ API Call Failed:", apiErr.response?.data || apiErr.message);
            //     });
        })
        .catch((error) => {
            console.error("❌ AI request failed:", error.message);
        });
}


function formatTransactionMessageSimple(endpoint, apiRes) {
    const data = apiRes.data;
    // Simple date formatting
    const dateObj = new Date(data.created_at);
    const formattedDate = `${dateObj.getDate()} ${dateObj.toLocaleString('en', { month: 'long' })} ${dateObj.getFullYear()}`;
    if(endpoint == '/finance/transaction') {
        return `
                💳 *Transaction Successful!*

                ✅ *Type:* ${data.type.toUpperCase()}
                💰 *Amount:* Rs. ${data.amount.toLocaleString('en-IN')}
                📅 *Date:* ${formattedDate}
                📝 *Note:* ${data.note}
                🆔 *Transaction ID:* ${data.id}

                ${apiRes.message} 👍
            `.trim();
    } else if(endpoint == '/finance/transaction/delete') {
        return `
        🗑️ *Transaction Deleted!*
        `.trim();
    } else if(endpoint == '/finance/transaction/edit') {
        if(apiRes.success) {
            return `
            💳 *Transaction updated Successful!*

            ✅ *Type:* ${data.type.toUpperCase()}
            💰 *Amount:* Rs. ${data.amount.toLocaleString('en-IN')}
            📅 *Date:* ${formattedDate}
            📝 *Note:* ${data.note}
            🆔 *Transaction ID:* ${data.id}

            ${apiRes.message} 👍
                `.trim();
        } else {
            return data.message || "✏️ *Transaction Update Failed!*";
        }
    } else if(endpoint == '/finance/transactions') {
        return formatTransactionsForWhatsApp(apiRes);
    } else if(endpoint == '/finance/transaction/summary') {
        // data i will apiRes->data-> total_transactions, total_credit_amount, total_debit_amount, net_balance
        const netBalance = data.total_credit_amount - data.total_debit_amount;
        return `
        📊 *Transaction Summary*

        🧾 *Transactions:* ${data.total_transactions}
        💵 *Credit:* Rs. ${data.total_credit_amount.toLocaleString('en-IN')}
        💸 *Debit:* Rs. ${data.total_debit_amount.toLocaleString('en-IN')}
        💰 *Net Balance:* ${netBalance >= 0 ? '+' : '' }Rs. ${netBalance.toLocaleString('en-IN')}
        `.trim();
    }
}

function sendTextFile(text, fileName = 'transactions.txt') {
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, text);

    return _SOCK.sendMessage(financeGroupJid, {
        document: fs.readFileSync(filePath),
        fileName,
        mimetype: 'text/plain'
    });
}

function formatTransactionsForWhatsApp(apiResponse) {
  const rows = apiResponse.data || [];

  // helper: add commas to number
  function formatAmount(n) {
    return Number(n).toLocaleString('en-PK'); // "270,000"
  }

  // helper: convert ISO UTC -> Asia/Karachi (UTC+5) and format "DD Mon YYYY HH:mm"
  function formatPkTime(isoString) {
    const utcDate = new Date(isoString); // this is in UTC

    // manually add +5h for PKT
    const pkMillis = utcDate.getTime() + (5 * 60 * 60 * 1000);
    const pkDate = new Date(pkMillis);

    const dd = String(pkDate.getUTCDate()).padStart(2, '0');

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const mon = months[pkDate.getUTCMonth()];
    const yyyy = pkDate.getUTCFullYear();

    const hh = String(pkDate.getUTCHours()).padStart(2, '0');
    const mm = String(pkDate.getUTCMinutes()).padStart(2, '0');

    return `${dd} ${mon} ${yyyy} ${hh}:${mm}`;
  }

  // calculate totals
  let totalCredit = 0;
  let totalDebit = 0;

  rows.forEach(t => {
    if (t.type === 'credit') {
      totalCredit += Number(t.amount || 0);
    } else if (t.type === 'debit') {
      totalDebit += Number(t.amount || 0);
    }
  });

  const net = totalCredit - totalDebit;

  // column widths we'll enforce
  const COL_ID = 4;
  const COL_TYPE = 6;
  const COL_AMOUNT = 8;
  const COL_NOTE = 27;
  const COL_TIME = 17;

  function pad(str, len) {
    str = String(str);
    if (str.length > len) {
      return str.slice(0, len); // hard cut if too long
    }
    return str + ' '.repeat(len - str.length);
  }

  // header lines
  let out = '';
  out += `Recent Transactions\n`;
  out += `(skip: ${apiResponse.meta?.skip ?? 0}, showing ${apiResponse.meta?.returned ?? rows.length} of ${apiResponse.meta?.total ?? rows.length})\n\n`;

  out += `+----+--------+----------+-----------------------------+------------------+\n`;
  out += `| ${pad('ID', COL_ID)} | ${pad('Type', COL_TYPE)} | ${pad('Amount', COL_AMOUNT)} | ${pad('Note', COL_NOTE)} | ${pad('Date/Time (PKT)', COL_TIME)} |\n`;
  out += `+----+--------+----------+-----------------------------+------------------+\n`;

  // body rows
  rows.forEach(t => {
    const line = [
      `| ${pad(t.id, COL_ID)} `,
      `| ${pad(t.type, COL_TYPE)} `,
      `| ${pad(formatAmount(t.amount), COL_AMOUNT)} `,
      `| ${pad(t.note || '', COL_NOTE)} `,
      `| ${pad(formatPkTime(t.createdAt), COL_TIME)} |`
    ].join('');
    out += line + `\n`;
  });

  out += `+----+--------+----------+-----------------------------+------------------+\n\n`;

  out += `Total credit: ${formatAmount(totalCredit)}\n`;
  out += `Total debit: ${formatAmount(totalDebit)}\n`;
  out += `Net balance: ${net >= 0 ? '+' : ''}${formatAmount(net)}\n`;

  return out;
}


module.exports = {
    imranHandler,
};
