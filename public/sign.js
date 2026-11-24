import { connect, makeApi, report, send, validateIntent } from './signflow.js';

const $ = (id) => document.getElementById(id);
const intentId = location.pathname.split('/').pop();
const api = makeApi(`/api/intent/${intentId}`);
const provider = window.okxwallet || window.ethereum || null;
let intent;
let from;

function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = cls;
}

async function finish(txHash, from) {
  status(`Submitted: ${txHash}. Reporting to helper…`);
  try {
    await report(api, txHash, from);
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

  if (intent.txHash) {
    status(`This transfer was already submitted: ${intent.txHash}. Nothing more to sign.`, 'ok');
    return;
  }
  if (!provider) {
    $('okx-link').href = intent.mobileLink;
    $('open-in-wallet').hidden = false;
    if (!/Android|iPhone|iPad/i.test(navigator.userAgent)) {
      $('qr').src = `/api/intent/${intentId}/qr.svg`;
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
    try {
      status('Confirm the transfer in OKX Wallet…');
      const { txHash } = await send(provider, intent, from, window.localStorage);
      await finish(txHash, from);
    } catch (err) {
      status(err.code === 4001 ? 'Rejected in wallet. Nothing was sent.' : err.message || String(err), 'err');
      $('send').disabled = false;
    }
  };
}

main().catch((err) => status(err.message || String(err), 'err'));
