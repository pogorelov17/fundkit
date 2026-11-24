import { apiBaseFromPath, connect, makeApi, report, send, storedSend, validateIntent } from './signflow.js';

const $ = (id) => document.getElementById(id);
const { api: apiBase } = apiBaseFromPath(location.pathname);
const api = makeApi(apiBase);
const provider = window.okxwallet || window.ethereum || null;
let intent;
let from;

function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = cls;
}

async function finish(txHash, claimToken) {
  status(`Submitted: ${txHash}. Reporting to helper…`);
  try {
    await report(api, txHash, claimToken);
    status(`Done. Transaction ${txHash} captured; the helper is now verifying it on-chain and on Bybit. You can close this page.`, 'ok');
  } catch (err) {
    status(`Transaction sent (${txHash}) but the helper could not be reached: ${err.message}. Do NOT send again — paste this hash into the chat.`, 'err');
  }
}

async function main() {
  intent = validateIntent(await api.getIntent());
  $('token').textContent = intent.token;
  $('amount').textContent = intent.display;
  $('to').textContent = intent.to;
  $('summary').hidden = false;

  if (intent.txHash) return status(`This transfer was already submitted: ${intent.txHash}. Nothing more to sign.`, 'ok');
  const mine = storedSend(intent, window.localStorage);
  if (mine) return finish(mine.txHash, mine.claimToken);
  if (intent.phase !== 'link_issued') {
    return status('Signing is already in progress in another tab or device (or this link is closed). Do NOT send from here — check OKX Wallet history and ask in the chat.', 'err');
  }
  if (!provider) {
    $('okx-link').href = intent.mobileLink;
    $('open-in-wallet').hidden = false;
    if (!/Android|iPhone|iPad/i.test(navigator.userAgent)) {
      $('qr').src = `${apiBase}/qr.svg`;
      $('qr-box').hidden = false;
    }
    return;
  }
  $('actions').hidden = false;
  $('connect').onclick = async () => {
    try {
      status('Connecting…');
      from = await connect(provider, intent);
      status(`Connected ${from}. Checking USDT balance and BNB for gas…`);
      const pc = await api.precheck(from);
      if (!pc.enoughToken) return status('Not enough USDT (BSC) in this wallet for this amount.', 'err');
      if (!pc.enoughGas) return status('Not enough BNB for gas on BNB Smart Chain.', 'err');
      status(`Connected ${from}. Balance and gas OK.`);
      $('send').disabled = false;
    } catch (err) {
      status(err.message || String(err), 'err');
    }
  };
  $('send').onclick = async () => {
    $('send').disabled = true;
    $('connect').disabled = true;
    try {
      status('Re-checking the Bybit route, then confirm the transfer in OKX Wallet…');
      const { txHash, claimToken } = await send(provider, intent, from, window.localStorage, api);
      await finish(txHash, claimToken);
    } catch (err) {
      if (err.code === 4001) {
        status('Rejected in wallet. Nothing was sent. You can try again.', 'err');
        $('send').disabled = false;
        $('connect').disabled = false;
      } else if (err.status === 409) {
        status(`${err.message}. Do NOT send from another tab or device.`, 'err');
      } else {
        status(`${err.message || String(err)}. Do NOT retry blindly: check OKX Wallet history; if a transfer is there, paste its hash into the chat.`, 'err');
      }
    }
  };
}

main().catch((err) => status(err.message || String(err), 'err'));
