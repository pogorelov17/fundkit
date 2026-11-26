// Native flows of the `fundkit` MCP server: a verified deposit address with a verified QR, and an
// exchange A → exchange B transfer prepared from live reads on both ends and dispatched after
// exactly one human confirmation bound to the plan's fields.
//
// Every read goes through a session profile, so the session daemon still decides each call by
// the profile's role. Holds carry an exact reason and never ask the user to look anything up.

import fs from 'node:fs';
import { normalizeExchange, exchangeLabel } from '../exchanges.mjs';
import {
  dispatchClaimed,
  hashOf,
  isPlanId,
  loadPlan,
  loadResult,
  newPlanId,
  planAlias,
  savePlan,
  saveResult,
} from '../plans.mjs';
import { writeVerifiedQr } from '../qr/index.mjs';
import { codedError, nowIso } from '../util.mjs';
import { formatDecimal, isMultiple, jsonSafe, parseDecimal } from '../venues/decimal.mjs';
import { hold, nativeVenue, NATIVE_VENUES } from '../venues/index.mjs';
import { NETWORKS, normalizeNetwork } from '../venues/networks.mjs';
import { confirmationSchema, confirmationText, previewMatchesPlan } from './confirmation.mjs';

const READ_TIMEOUT_MS = 180_000;

/** A numeric override from the environment, clamped to [min, max]; `fallback` otherwise. */
function boundedEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, min), max) : fallback;
}
const PLAN_TTL_MS = boundedEnv('FUNDKIT_PLAN_TTL_MS', 10 * 60_000, 1000, 10 * 60_000);
// Below ccxt-mcp's 300 s form wait. Tests may shorten both (never lengthen).
const FORM_TIMEOUT_MS = boundedEnv('FUNDKIT_FORM_TIMEOUT_MS', 280_000, 500, 280_000);
const NOT_SENT_CODES = new Set([
  'CONFIRM_DECLINED',
  'CONFIRM_CANCELED',
  'CONFIRM_UNAVAILABLE',
  'PLAN_ALREADY_DISPATCHED',
  'PLAN_ARGS_CHANGED',
  'PLAN_EXPIRED',
  'PLAN_PROFILE_ONLY',
  'KEY_CHECK_REQUIRED',
  'TRANSFER_VALUE_CAP',
  'DAILY_VALUE_CAP',
  'TIER_DISABLED',
]);

function text(body, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError };
}

const errorText = (body) => text(body, true);

/** Parse a ccxt-mcp tool result into its envelope. */
function envelopeOf(result) {
  try {
    return JSON.parse(result?.content?.[0]?.text ?? 'null') ?? {};
  } catch {
    return {};
  }
}

function errorCode(envelope) {
  if (typeof envelope.error === 'string') return envelope.error;
  return envelope.error?.code ?? envelope.code ?? 'TOOL_ERROR';
}

/** A `read(tool, args)` bound to one profile: returns the envelope's data or throws its error. */
function readerFor(profile) {
  return async (tool, args) => {
    const response = await profile.request(
      'tools/call',
      { name: tool, arguments: args },
      { timeoutMs: READ_TIMEOUT_MS, call: { channel: 'read' } },
    );
    if (response.error) throw codedError('PROFILE_ERROR', response.error.message);
    const envelope = envelopeOf(response.result);
    if (response.result?.isError || envelope.ok !== true) {
      const message = envelope.error?.message ?? envelope.message ?? 'the read failed';
      throw codedError(errorCode(envelope), `${tool} ${args.method ?? ''}: ${message}`.trim());
    }
    return envelope.data;
  };
}

function holdBody(error, extra = {}) {
  return {
    error: error.code ?? 'READ_FAILED',
    message: error.message,
    hold: Boolean(error.hold),
    ...extra,
  };
}

function money(units) {
  return formatDecimal(units);
}

function networkFacts(network, exchange) {
  return {
    code: network.code,
    label: network.label,
    chainId: network.chainId,
    contract: network.contract,
    venueId: network.ids[exchange],
  };
}

export class NativeFlows {
  #broker;
  /** planId -> in-flight confirm */
  #inflight = new Set();

  constructor(broker) {
    this.#broker = broker;
  }

  // ------------------------------------------------------------------ shared

  #parseVenue(name, field) {
    const exchange = normalizeExchange(name);
    if (!exchange) {
      return { error: { error: 'UNKNOWN_EXCHANGE', message: `${field}: unsupported exchange ${name}` } };
    }
    const venue = nativeVenue(exchange);
    if (!venue) {
      return {
        error: {
          error: 'VENUE_NOT_NATIVE',
          message:
            `${exchangeLabel(exchange)} is not supported by this native flow yet (native: ` +
            `${Object.values(NATIVE_VENUES)
              .map((item) => item.label)
              .join(', ')}). Nothing was read.`,
        },
      };
    }
    return { exchange, venue };
  }

  async #profile(exchange, role, resume) {
    const opened = await this.#broker.openProfile({ exchange, role }, { resume });
    if (opened.error) return opened;
    return { profile: opened.profile, read: readerFor(opened.profile) };
  }

  async #keyCheck(venue, profile, read) {
    if (!profile.keyFacts) profile.keyFacts = await venue.keyCheck(read, profile.alias);
    return profile.keyFacts;
  }

  // ------------------------------------------------------------------ deposit address

  async depositAddress(args = {}) {
    const coin = String(args.coin ?? 'USDT').toUpperCase();
    if (coin !== 'USDT') return errorText({ error: 'UNSUPPORTED_COIN', message: 'only USDT is supported' });
    const parsed = this.#parseVenue(args.exchange, 'exchange');
    if (parsed.error) return errorText(parsed.error);
    const { exchange, venue } = parsed;
    const code = normalizeNetwork(args.network);
    if (!code || !venue.supportedNetworks.includes(code)) {
      return errorText({
        error: 'NETWORK_REQUIRED',
        message: `name one network: ${venue.supportedNetworks.join(', ')} (BSC means BEP20)`,
      });
    }
    const network = NETWORKS[code];
    const resume = { tool: 'fundkit_deposit_address', arguments: { exchange, coin, network: args.network } };
    const opened = await this.#profile(exchange, 'deposit-only', resume);
    if (opened.error) return errorText(opened.error);
    const { profile, read } = opened;

    let recipient;
    let keyFacts;
    try {
      keyFacts = await this.#keyCheck(venue, profile, read);
      recipient = await venue.recipient(read, profile.alias, network, keyFacts);
    } catch (error) {
      return errorText(holdBody(error, { address: null, qr: null, note: 'No address and no QR are shown.' }));
    }
    const readAt = nowIso();
    const result = {
      status: 'verified',
      exchange,
      coin,
      network: networkFacts(network, exchange),
      address: recipient.address,
      memo: recipient.memo
        ? {
            required: true,
            value: recipient.memo,
            warning:
              'A memo/tag is required. Show it conspicuously, exactly as given (leading zeros included). ' +
              'The QR carries only the address: the memo must be entered separately.',
          }
        : { required: false, value: null },
      source: {
        alias: profile.alias,
        reads: recipient.reads,
        readAt,
        lands: recipient.lands,
        keyCheck: keyFacts,
      },
      qr: null,
    };
    let image = null;
    try {
      const qr = writeVerifiedQr(recipient.address);
      if (qr.payload !== recipient.address) {
        throw codedError('QR_MISMATCH', 'QR payload differs from the address');
      }
      image = fs.readFileSync(qr.path);
      result.qr = {
        ...qr,
        carries: 'the address only',
        markdown: `![QR ${exchangeLabel(exchange)} USDT ${network.code}](${qr.path})`,
      };
    } catch (error) {
      result.qrError = { error: error.code ?? 'QR_FAILED', message: error.message };
    }
    result.show = [
      result.qr ? 'the QR image inline with qr.markdown, exactly' : 'say that no QR could be verified',
      'the address as plain copyable text in a code block, character for character',
      `the exact network: ${network.label}, ${exchangeLabel(exchange)} network ${network.ids[exchange]}`,
      recipient.memo
        ? 'the memo first and conspicuously, and that the QR does not contain it'
        : 'that no memo/tag is needed',
      'where it was read and when; never say that anything was sent',
    ];
    const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    if (image) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
    return { content, isError: false };
  }

  // ------------------------------------------------------------------ transfer: prepare

  async transferPrepare(args = {}) {
    const coin = String(args.coin ?? 'USDT').toUpperCase();
    if (coin !== 'USDT') return errorText({ error: 'UNSUPPORTED_COIN', message: 'only USDT is supported' });
    const source = this.#parseVenue(args.from, 'from');
    if (source.error) return errorText(source.error);
    const destination = this.#parseVenue(args.to, 'to');
    if (destination.error) return errorText(destination.error);
    if (source.exchange === destination.exchange) {
      return errorText({ error: 'SAME_EXCHANGE', message: 'from and to are the same exchange' });
    }
    const amount = parseDecimal(String(args.amount ?? ''));
    if (amount === null || amount <= 0n) {
      return errorText({ error: 'AMOUNT_INVALID', message: 'amount must be a positive decimal number' });
    }
    let candidates = source.venue.supportedNetworks.filter((code) =>
      destination.venue.supportedNetworks.includes(code),
    );
    if (args.network !== undefined) {
      const code = normalizeNetwork(args.network);
      if (!code || !candidates.includes(code)) {
        return errorText({
          error: 'NETWORK_UNSUPPORTED',
          message: `networks on this route: ${candidates.join(', ')}`,
        });
      }
      candidates = [code];
    }
    const resume = {
      tool: 'fundkit_transfer_prepare',
      arguments: { ...args, from: source.exchange, to: destination.exchange },
    };

    const a = await this.#profile(source.exchange, 'source', resume);
    if (a.error) return errorText(a.error);
    const b = await this.#profile(destination.exchange, 'deposit-only', resume);
    if (b.error) return errorText(b.error);

    let keyA;
    let keyB;
    try {
      keyA = await this.#keyCheck(source.venue, a.profile, a.read);
      keyB = await this.#keyCheck(destination.venue, b.profile, b.read);
    } catch (error) {
      return errorText(holdBody(error, { status: 'hold', dispatch: 'none' }));
    }
    if (!source.venue.canWithdraw(keyA)) {
      return text({
        status: 'hold',
        dispatch: 'none',
        reasons: [
          {
            code: 'SOURCE_KEY_CANNOT_WITHDRAW',
            detail: `the ${source.venue.label} key check shows no withdrawal right, so ${source.venue.label} would refuse the withdrawal`,
          },
        ],
        sourceKey: keyA,
      });
    }

    const ready = [];
    const reasons = [];
    for (const code of candidates) {
      const network = NETWORKS[code];
      try {
        ready.push(await this.#evaluate({ source, destination, a, b, keyB, network, amount }));
      } catch (error) {
        if (!error.hold && !error.code) throw error;
        reasons.push({ network: code, code: error.code, detail: error.message });
      }
    }
    if (ready.length === 0) {
      return text({
        status: 'hold',
        dispatch: 'none',
        reasons,
        note:
          'Nothing was sent and there is nothing to confirm. Tell the user each exact reason. Do not ask ' +
          'them to look up a value, open a deposit page or change a setting to get past it.',
      });
    }
    ready.sort((x, y) => (x.fee < y.fee ? -1 : x.fee > y.fee ? 1 : 0));
    const best = ready[0];
    const plan = await this.#buildPlan({ source, destination, a, b, keyA, best, amount, coin });
    if (plan.error) return errorText(plan.error);
    return text({
      status: 'ready',
      planId: plan.planId,
      expiresAt: plan.expiresAt,
      hash: plan.hash,
      plan: planForChat(plan),
      otherNetworks: reasons,
      next: {
        tool: 'fundkit_transfer_confirm',
        arguments: { planId: plan.planId },
        how:
          'Show the plan fields to the user in one message, then call fundkit_transfer_confirm right away. ' +
          'It opens one confirmation card with these exact fields; the human approves or declines there. ' +
          'Do not ask for a typed approval in the chat and do not answer the card yourself.',
      },
    });
  }

  async #evaluate({ source, destination, a, b, keyB, network, amount }) {
    const src = await source.venue.source(a.read, a.profile.alias, network);
    const recipient = await destination.venue.recipient(b.read, b.profile.alias, network, keyB);
    const dst = await destination.venue.destination(b.read, b.profile.alias, network, recipient);
    const W = amount;
    if (!jsonSafe(W)) {
      throw hold('AMOUNT_NOT_REPRESENTABLE', `${money(W)} cannot be sent unchanged as a JSON number`);
    }
    if (!isMultiple(W, src.step)) {
      throw hold(
        'AMOUNT_STEP',
        `${money(W)} is not a multiple of ${source.venue.label}'s step ${money(src.step)}`,
      );
    }
    if (W < src.min) {
      throw hold('BELOW_WITHDRAW_MIN', `${source.venue.label} minimum withdrawal is ${money(src.min)}`);
    }
    if (src.max !== null && src.max !== undefined && W > src.max) {
      throw hold(
        'ABOVE_WITHDRAW_MAX',
        `${source.venue.label} allows at most ${money(src.max)} per withdrawal now`,
      );
    }
    const f = src.fee;
    const d = parseDecimal(dst.depositFee.value);
    const onTop = src.feeModel === 'on top';
    const debit = { min: onTop ? W + f : W, max: W + f };
    const credit = { min: onTop ? W - d : W - f - d, max: W - d };
    const wallet = src.wallets.find((item) => item.free !== null && item.free >= debit.max);
    if (!wallet) {
      const available = src.wallets.map(
        (item) => `${item.wallet} ${item.free === null ? 'unreadable' : money(item.free)}`,
      );
      throw hold(
        'INSUFFICIENT_BALANCE',
        `needs ${money(debit.max)} USDT available in one ${source.venue.label} wallet; available: ${available.join(', ')}`,
      );
    }
    if (dst.depositMin === null) throw hold('DESTINATION_MINIMUM_UNDOCUMENTED', dst.depositMinReason);
    if (credit.min < dst.depositMin) {
      throw hold(
        'BELOW_DEPOSIT_MIN',
        `${destination.venue.label} credits deposits from ${money(dst.depositMin)} USDT`,
      );
    }
    return { network, src, dst, recipient, wallet, fee: f, debit, credit, readAt: nowIso() };
  }

  async #buildPlan({ source, destination, a, b, keyA, best, amount, coin }) {
    const planId = newPlanId();
    const created = Date.now();
    const expiresAtMs = created + PLAN_TTL_MS;
    const alias = planAlias(source.exchange, planId);
    const { network, src, dst, recipient, wallet } = best;
    const args = source.venue.withdrawArgs({
      alias,
      amount: Number(money(amount)),
      recipient,
      network,
      wallet,
    });
    const body = {
      planId,
      version: 1,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      from: source.exchange,
      to: destination.exchange,
      coin,
      network: {
        ...networkFacts(network, source.exchange),
        sourceId: network.ids[source.exchange],
        destinationId: network.ids[destination.exchange],
      },
      amount: money(amount),
      fee: { value: money(best.fee), asset: src.feeAsset, model: src.feeModel, fields: src.fields },
      debit: { min: money(best.debit.min), max: money(best.debit.max) },
      credit: { min: money(best.credit.min), max: money(best.credit.max) },
      sourceWallet: { wallet: wallet.wallet, available: money(wallet.free) },
      recipient: {
        address: recipient.address,
        memo: recipient.memo,
        readFrom: b.profile.alias,
        reads: recipient.reads,
        lands: recipient.lands,
        readAt: best.readAt,
      },
      destination: {
        depositMin: money(dst.depositMin),
        depositFee: dst.depositFee,
        inboundCap: dst.inboundCap,
      },
      sourceKey: keyA,
      args,
      argsHash: hashOf(args),
      cap: Number(money(amount)),
      readsFrom: { source: a.profile.alias, destination: b.profile.alias },
      exchangeMayReject:
        'fundkit sends no travel-rule or beneficiary data; where the exchange requires it for the ' +
        "account's entity, it rejects the withdrawal before sending",
      onward:
        `Any further move after the credit on ${destination.venue.label} (for example to another wallet) is a ` +
        'separate action that this confirmation does not authorize.',
    };
    const plan = { ...body, hash: hashOf(body) };
    const reply = await this.#broker.sessionRequest({
      t: 'plan-register',
      plan: {
        planId,
        exchange: source.exchange,
        argsHash: body.argsHash,
        cap: body.cap,
        expiresAt: expiresAtMs,
      },
    });
    if (reply?.t !== 'plan-registered') {
      return {
        error: {
          error: reply?.code ?? 'NO_SESSION',
          message: reply?.message ?? 'the session did not register the plan',
        },
      };
    }
    savePlan(plan);
    return plan;
  }

  // ------------------------------------------------------------------ transfer: confirm

  async transferConfirm({ planId } = {}) {
    if (!isPlanId(planId)) return errorText({ error: 'PLAN_NOT_FOUND', message: 'unknown plan id' });
    const plan = loadPlan(planId);
    if (!plan) return errorText({ error: 'PLAN_NOT_FOUND', message: 'unknown plan id' });
    if (plan.tampered) {
      return errorText({
        error: 'PLAN_TAMPERED',
        message: 'the stored plan does not match its hash; nothing was sent',
      });
    }
    const previous = loadResult(planId);
    if (previous) {
      return text({ ...previous, duplicate: true, note: 'already handled; nothing was sent again' });
    }
    if (dispatchClaimed(planId) || this.#inflight.has(planId)) {
      return text({
        planId,
        status: this.#inflight.has(planId) ? 'in-progress' : 'unknown',
        duplicate: true,
        note: 'this plan was already dispatched or is being dispatched; nothing is sent again. Reconcile read-only.',
      });
    }
    if (Date.now() >= plan.expiresAtMs) {
      return this.#finish(plan, { status: 'not-sent', reason: 'PLAN_EXPIRED' });
    }
    if (!this.#broker.hostElicitation) {
      return errorText({
        error: 'CONFIRMATION_UNAVAILABLE',
        planId,
        message:
          'This host offers no native confirmation form to MCP servers, so no transfer can be confirmed here. ' +
          'Nothing was sent.',
      });
    }
    this.#inflight.add(planId);
    try {
      return await this.#dispatch(plan);
    } finally {
      this.#inflight.delete(planId);
    }
  }

  async #dispatch(plan) {
    const venue = nativeVenue(plan.from);
    const opened = await this.#broker.openProfile({ exchange: plan.from, planId: plan.planId });
    if (opened.error) {
      return this.#finish(plan, {
        status: 'not-sent',
        reason: opened.error.error,
        detail: opened.error.message,
      });
    }
    const { profile } = opened;
    profile.plan = plan;
    profile.formOutcome = null;
    try {
      const read = readerFor(profile);
      try {
        await venue.keyCheck(read, profile.alias);
      } catch (error) {
        return this.#finish(plan, {
          status: 'not-sent',
          reason: error.code ?? 'KEY_CHECK_FAILED',
          detail: error.message,
        });
      }
      const response = await profile.request(
        'tools/call',
        { name: 'withdraw', arguments: plan.args },
        { timeoutMs: 0, call: { channel: 'plan' } },
      );
      return this.#finish(plan, classify(response, profile.formOutcome, dispatchClaimed(plan.planId)));
    } finally {
      await this.#broker.closeProfile(profile.alias, 'plan finished');
    }
  }

  #finish(plan, outcome) {
    const result = {
      planId: plan.planId,
      hash: plan.hash,
      at: nowIso(),
      ...outcome,
      sent: outcome.status === 'sent',
      onward: plan.onward,
    };
    if (outcome.status === 'not-sent') result.note = 'Nothing was sent.';
    if (outcome.status === 'rejected') {
      result.note =
        'The withdrawal failed with a definite error (not an unknown outcome), so nothing was sent. ' +
        'This plan can never be sent again; check the withdrawal history read-only if in doubt.';
    }
    if (outcome.status === 'unknown') {
      result.note =
        'The outcome is unknown. Do not retry: this plan can never be sent again. Reconcile read-only ' +
        '(withdrawal history on the source, deposit history on the destination).';
    }
    saveResult(plan.planId, result);
    return text(result, outcome.status === 'unknown');
  }

  /** Answer the plan profile's own form: re-shown to the human with the plan's fields. */
  async answerPlanForm(profile, params) {
    const plan = profile.plan;
    const decline = (why) => {
      profile.formOutcome = { answer: 'decline', why };
      return { action: 'decline' };
    };
    if (!plan) return decline('no plan');
    if (profile.formShown) return decline('a second form for one plan is never shown');
    profile.formShown = true;
    if (!previewMatchesPlan(params?.message, plan)) return decline('the money form did not match the plan');
    const remaining = plan.expiresAtMs - Date.now();
    if (remaining <= 0) return decline('the plan expired');

    const { response, cancel } = this.#broker.elicit({
      message: confirmationText(plan),
      requestedSchema: confirmationSchema(),
    });
    const timer = setTimeout(
      () => cancel('the plan expired or the form timed out'),
      Math.min(remaining, FORM_TIMEOUT_MS),
    );
    const answer = await response;
    clearTimeout(timer);
    if (answer.cancelled) return decline('no answer in time');
    if (answer.error) return decline(`the host could not show the form (${answer.error.message ?? 'error'})`);
    const { action, content } = answer.result ?? {};
    if (action !== 'accept') {
      return decline(action === 'cancel' ? 'the human cancelled' : 'the human declined');
    }
    if (content?.decision !== 'approve') return decline('the accepted form did not carry the approval');
    if (Date.now() >= plan.expiresAtMs) return decline('the approval came after the plan expired');
    profile.formOutcome = { answer: 'approve' };
    return { action: 'accept', content: { confirm: true } };
  }

  // ------------------------------------------------------------------ transfer: status

  async transferStatus({ planId } = {}) {
    const plan = isPlanId(planId) ? loadPlan(planId) : null;
    if (!plan || plan.tampered) return errorText({ error: 'PLAN_NOT_FOUND', message: 'unknown plan id' });
    return text({
      planId,
      plan: planForChat(plan),
      dispatchAttempted: dispatchClaimed(planId),
      result: loadResult(planId),
      expired: Date.now() >= plan.expiresAtMs,
    });
  }
}

/** What the agent shows the user before the confirmation card opens. */
function planForChat(plan) {
  return {
    route: `${exchangeLabel(plan.from)} (${plan.sourceWallet.wallet}) → ${exchangeLabel(plan.to)}`,
    network: `${plan.network.label}: ${exchangeLabel(plan.from)} ${plan.network.sourceId} → ${exchangeLabel(plan.to)} ${plan.network.destinationId}`,
    amount: `${plan.amount} ${plan.coin}`,
    fee: `${plan.fee.value} ${plan.fee.asset} (${plan.fee.model})`,
    debit: plan.debit.min === plan.debit.max ? plan.debit.max : `${plan.debit.min}–${plan.debit.max}`,
    credit: plan.credit.min === plan.credit.max ? plan.credit.max : `${plan.credit.min}–${plan.credit.max}`,
    available: `${plan.sourceWallet.available} ${plan.coin} in ${plan.sourceWallet.wallet}`,
    recipient: plan.recipient.address,
    memo: plan.recipient.memo ?? 'none',
    recipientSource: `read from your ${exchangeLabel(plan.to)} account (${plan.recipient.readFrom}) at ${plan.recipient.readAt}`,
    destinationMinimum: plan.destination.depositMin,
    expiresAt: plan.expiresAt,
    exchangeMayReject: plan.exchangeMayReject,
    onward: plan.onward,
  };
}

/** Turn the withdraw call's response into an outcome. */
function classify(response, formOutcome, claimed) {
  const form = formOutcome ? { form: formOutcome } : {};
  if (response.error) {
    return claimed
      ? { status: 'unknown', reason: 'PROFILE_LOST', detail: response.error.message, ...form }
      : { status: 'not-sent', reason: 'PROFILE_LOST', detail: response.error.message, ...form };
  }
  const envelope = envelopeOf(response.result);
  if (!response.result?.isError && envelope.ok === true) {
    if (envelope.data?.dryRun) return { status: 'not-sent', reason: 'DRY_RUN', ...form };
    return {
      status: 'sent',
      withdrawalId: envelope.data?.id ?? null,
      exchangeResult: envelope.data,
      ...form,
    };
  }
  const code = errorCode(envelope);
  const detail = envelope.error?.message ?? envelope.message;
  if (code === 'UNKNOWN_OUTCOME') return { status: 'unknown', reason: code, detail, ...form };
  if (NOT_SENT_CODES.has(code) || !claimed) return { status: 'not-sent', reason: code, detail, ...form };
  return { status: 'rejected', reason: code, detail, ...form };
}
