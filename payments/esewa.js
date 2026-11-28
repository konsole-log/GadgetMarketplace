'use strict';

const crypto = require('node:crypto');

const LIVE = process.env.ESEWA_ENV === 'live';
const FORM_URL = process.env.ESEWA_FORM_URL || (LIVE
  ? 'https://epay.esewa.com.np/api/epay/main/v2/form'
  : 'https://rc-epay.esewa.com.np/api/epay/main/v2/form');
const STATUS_URL = process.env.ESEWA_STATUS_URL || (LIVE
  ? 'https://epay.esewa.com.np/api/epay/transaction/status/'
  : 'https://rc.esewa.com.np/api/epay/transaction/status/');

function config() {
  const productCode = process.env.ESEWA_PRODUCT_CODE;
  const secret = process.env.ESEWA_SECRET_KEY;
  if (!productCode || !secret) throw new Error('ESEWA_PRODUCT_CODE / ESEWA_SECRET_KEY are not set');
  return { productCode, secret };
}

function sign(fields, signedFieldNames, secret) {
  const message = signedFieldNames.split(',').map((k) => `${k}=${fields[k]}`).join(',');
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function paisaToRupees(paisa) {
  return (paisa / 100).toFixed(2).replace(/\.00$/, '');
}

function buildForm({ amountPaisa, transactionUuid, successUrl, failureUrl }) {
  const { productCode, secret } = config();
  const total = paisaToRupees(amountPaisa);
  const fields = {
    amount: total,
    tax_amount: '0',
    total_amount: total,
    transaction_uuid: transactionUuid,
    product_code: productCode,
    product_service_charge: '0',
    product_delivery_charge: '0',
    success_url: successUrl,
    failure_url: failureUrl,
    signed_field_names: 'total_amount,transaction_uuid,product_code',
  };
  fields.signature = sign(fields, fields.signed_field_names, secret);
  return { action: FORM_URL, fields };
}

function verifyCallback(base64Data) {
  const { secret } = config();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(base64Data), 'base64').toString('utf8'));
  } catch {
    throw new Error("Malformed eSewa response");
  }
  if (!payload.signed_field_names || !payload.signature) throw new Error("Unsigned eSewa response");
  const expected = Buffer.from(sign(payload, payload.signed_field_names, secret));
  const given = Buffer.from(String(payload.signature));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new Error("eSewa signature mismatch");
  }
  return payload;
}

async function checkStatus({transactionUuid, amountPaisa}){
  const {productCode} = config();
  const url = new URL(STATUS_URL);
  url.searchParams.set('product_code',productCode);
  url.searchParams.set('total_amount',paisaToRupees(amountPaisa));
  url.searchParams.set('transaction_uuid',transactionUuid);
  const res = await fetch(url, {signal: AbortSignal.timeout(15000)});
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data.status) throw new Error(`eSea status check failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

function rupeesToPaisa(value){
  return Math.round(parseFloat(String(value).replace(/,/g,''))*100);
}

module.exports = {buildForm, verifyCallback, checkStatus, rupeesToPaisa,sign};
